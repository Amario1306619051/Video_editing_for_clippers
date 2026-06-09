"""Persistent batch queue + background worker.

Lets the user upload a JSON of clips and walk away: a single background worker
downloads each clip and predicts its crop boxes (from the per-box text prompts)
one job at a time, persisting progress to `queue/queue.json` so it survives a
server restart. The user then opens each job from the sidebar, fine-tunes the
boxes (auto-saved back to the job), and deletes it when done.

Import format — keyed by video URL, tolerant of Python-dict single quotes:

  { "<video_url>": [
      {"id":.., "start":.., "end":.., "title":.., "description":..,
       "bbox_1":.., "bbox_2":..},
      ...
  ], ... }

`bbox_1` / `bbox_2` are TEXT PROMPTS for the vision auto-box (e.g.
"the live streamer ..."). Box 2 is clipper-only; illustrator ignores it.

NOTE: this is the ONE place the project keeps state on disk on purpose — the
owner asked for resumable batch progress. The rest of the app stays stateless.
"""
import ast
import json
import logging
import threading
import uuid
from pathlib import Path
from typing import Optional

import autobox
import downloader
import renderer
import transcriber
import vision
from models import Keyframe, Word

log = logging.getLogger(__name__)

BASE_DIR = Path(__file__).resolve().parent.parent
QUEUE_DIR = BASE_DIR / "queue"
QUEUE_DIR.mkdir(exist_ok=True)
QUEUE_FILE = QUEUE_DIR / "queue.json"

# How many crop-box prompts a job carries. clipper = 2 (top + bottom),
# illustrator overrides this to 1 in its own copy.
NUM_BOXES = 2

# Whether the worker also runs the heavy transcribe + render phase (on demand,
# after the user has edited the boxes). clipper = True; illustrator keeps render
# manual (it needs the interactive Illustration step) and sets this False.
RENDER_IN_QUEUE = True
CAPTION_FONT = "Anton"   # batch render caption defaults (match the UI default)
CAPTION_SIZE = 64

# Statuses:
#   pending → downloading → predicting → ready          (auto, on import)
#   ready → render_queued → rendering → done            (on demand, after editing)
#   → error at any step
_TERMINAL = {"ready", "done", "error"}

_lock = threading.RLock()       # guards _jobs + the file
_jobs: list[dict] = []
_loaded = False
_worker_started = False
_wake = threading.Event()       # set to nudge the worker when new work arrives


# ───────────────────────── persistence ─────────────────────────
def _load() -> None:
    global _jobs, _loaded
    if _loaded:
        return
    if QUEUE_FILE.exists():
        try:
            _jobs = json.loads(QUEUE_FILE.read_text(encoding="utf-8")) or []
        except Exception as e:  # noqa: BLE001 — corrupt file shouldn't crash boot
            log.warning("queue file unreadable, starting empty: %s", e)
            _jobs = []
    _loaded = True


def _save() -> None:
    # Atomic-ish write so a crash mid-write can't truncate the queue.
    tmp = QUEUE_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(_jobs, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(QUEUE_FILE)


def _find(key: str) -> Optional[dict]:
    for j in _jobs:
        if j["key"] == key:
            return j
    return None


def _update(key: str, **fields) -> Optional[dict]:
    with _lock:
        j = _find(key)
        if not j:
            return None
        j.update(fields)
        _save()
        return j


# ───────────────────────── import / parse ─────────────────────────
def _parse(content: str):
    content = (content or "").strip()
    if not content:
        raise ValueError("empty input")
    try:
        return json.loads(content)
    except Exception:
        # Tolerate the Python-dict style the user pastes (single quotes, None…).
        return ast.literal_eval(content)


def _to_hhmmss(v) -> Optional[str]:
    """Accept "HH:MM:SS" strings or plain seconds (int/float) → "HH:MM:SS"."""
    if v is None or v == "":
        return None
    if isinstance(v, (int, float)):
        s = int(round(v))
        return f"{s // 3600:02d}:{(s % 3600) // 60:02d}:{s % 60:02d}"
    return str(v).strip() or None


def _to_float(v) -> Optional[float]:
    if v is None or v == "":
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _clip_to_job(url: str, clip: dict) -> dict:
    cid = str(clip.get("id") or uuid.uuid4().hex[:8])
    return {
        "key": uuid.uuid4().hex[:12],   # internal, URL-safe id used by the API
        "id": cid,                      # the user's clip id (shown in the sidebar)
        "url": url,
        "start": _to_hhmmss(clip.get("start")) or "00:00:00",
        "end": _to_hhmmss(clip.get("end")),
        "title": str(clip.get("title") or cid or "clip"),
        "description": str(clip.get("description") or ""),
        "prompt1": str(clip.get("bbox_1") or clip.get("bbox1") or ""),
        "prompt2": str(clip.get("bbox_2") or clip.get("bbox2") or ""),
        # Optional per-clip illustration segment length (illustrator only) — pre-fills
        # the Illustration step so the user just picks. Ignored by clipper.
        "segment_seconds": _to_float(clip.get("segment_seconds")
                                     or clip.get("seg_seconds") or clip.get("jeda")),
        "status": "pending",
        "message": "queued",
        "job_id": None,                 # temp/{job_id}.mp4 once downloaded
        "video_path": None,
        "width": 0, "height": 0, "duration": 0.0,
        "box1": None, "box2": None,     # predicted/edited keyframe lists
        "output_path": None, "filename": None,   # set once rendered
    }


def import_text(content: str) -> dict:
    """Parse the JSON and append new jobs (skipping ids already queued). Returns
    {added, skipped, total}. Wakes the worker so processing starts immediately."""
    _load()
    data = _parse(content)
    if not isinstance(data, dict):
        raise ValueError("top level must be an object keyed by video URL")

    added, skipped = 0, 0
    with _lock:
        existing_ids = {j["id"] for j in _jobs}
        for url, clips in data.items():
            if not isinstance(clips, list):
                clips = [clips]
            for clip in clips:
                if not isinstance(clip, dict):
                    continue
                job = _clip_to_job(str(url), clip)
                if job["id"] in existing_ids:
                    skipped += 1
                    continue
                existing_ids.add(job["id"])
                _jobs.append(job)
                added += 1
        _save()
    _wake.set()
    return {"added": added, "skipped": skipped, "total": len(_jobs)}


# ───────────────────────── queries / mutations ─────────────────────────
def list_jobs() -> list[dict]:
    """Light summary for the sidebar (no heavy keyframe arrays)."""
    _load()
    with _lock:
        out = []
        for j in _jobs:
            out.append({
                "key": j["key"], "id": j["id"], "title": j["title"],
                "status": j["status"], "message": j.get("message", ""),
                "kf1": len(j.get("box1") or []), "kf2": len(j.get("box2") or []),
                "ready": bool(j.get("job_id")),
                "output_path": j.get("output_path"), "filename": j.get("filename"),
            })
        return out


def get_job(key: str) -> Optional[dict]:
    _load()
    with _lock:
        j = _find(key)
        return dict(j) if j else None


def save_job(key: str, patch: dict) -> Optional[dict]:
    """Persist edits from the editor (title + keyframes). Only known fields."""
    allowed = {k: patch[k] for k in ("title", "box1", "box2", "description") if k in patch}
    return _update(key, **allowed)


def retry_job(key: str) -> Optional[dict]:
    """Re-queue an errored job at the right phase: if it already downloaded +
    has boxes, the failure was the render → re-render; otherwise re-download/predict."""
    with _lock:
        j = _find(key)
        if not j:
            return None
        if RENDER_IN_QUEUE and j.get("job_id") and (j.get("box1") or j.get("box2")):
            j["status"], j["message"] = "render_queued", "re-queued render"
        else:
            j["status"], j["message"] = "pending", "re-queued"
        _save()
    _wake.set()
    return dict(_find(key))


def queue_render(key: str) -> Optional[dict]:
    """Mark a downloaded job for the (background) render phase. Boxes used are
    whatever is currently saved (the frontend auto-saves edits before calling)."""
    if not RENDER_IN_QUEUE:
        return None
    j = _find(key)
    if not j or not j.get("job_id"):
        return None
    r = _update(key, status="render_queued", message="render queued")
    _wake.set()
    return r


def queue_render_all_ready() -> int:
    """Queue every edited-and-ready job for render. Returns how many were queued."""
    if not RENDER_IN_QUEUE:
        return 0
    n = 0
    with _lock:
        for j in _jobs:
            if j["status"] == "ready" and j.get("job_id"):
                j["status"], j["message"], n = "render_queued", "render queued", n + 1
        if n:
            _save()
    if n:
        _wake.set()
    return n


def delete_job(key: str, cleanup: bool = True) -> bool:
    with _lock:
        j = _find(key)
        if not j:
            return False
        _jobs.remove(j)
        _save()
    if cleanup and j.get("job_id"):
        try:
            downloader.cleanup_job(j["job_id"])
        except Exception:  # noqa: BLE001 — best-effort temp cleanup
            pass
    return True


# ───────────────────────── background worker ─────────────────────────
def _predict_box(src, prompt: str, dur: float) -> Optional[list]:
    """Auto-box keyframes for one prompt over the whole clip, or None when the
    prompt is empty / the vision endpoint is off / nothing is detected."""
    if not (prompt or "").strip() or not vision.enabled():
        return None
    out = autobox.predict_track(src, prompt, 0.0, dur, lock_size=True)
    return out.get("keyframes") or None


def _process_one(job: dict) -> None:
    key = job["key"]
    # 1) download (skip if already downloaded on a previous run)
    if not job.get("job_id"):
        _update(key, status="downloading", message="downloading clip…")
        try:
            res = downloader.download(job["url"], job.get("start") or "00:00:00",
                                      job.get("end"), job.get("title") or "clip")
        except Exception as e:  # noqa: BLE001
            log.warning("queue download failed (%s): %s", job["id"], e)
            _update(key, status="error", message=f"download failed: {e}")
            return
        _update(key, job_id=res["job_id"], video_path=res["video_path"],
                width=res["width"], height=res["height"], duration=res["duration"])
        job = _find(key) or job

    # 2) predict boxes
    _update(key, status="predicting", message="predicting boxes (AI)…")
    try:
        src = downloader.get_source_path(job["job_id"])
        dur = job.get("duration") or 0.0
        notes = []
        box1 = _predict_box(src, job.get("prompt1", ""), dur)
        if job.get("prompt1") and not box1:
            notes.append("box1: nothing detected")
        box2 = None
        if NUM_BOXES >= 2:
            box2 = _predict_box(src, job.get("prompt2", ""), dur)
            if job.get("prompt2") and not box2:
                notes.append("box2: nothing detected")
    except Exception as e:  # noqa: BLE001 — download already succeeded; boxes are best-effort
        log.warning("queue predict failed (%s): %s", job["id"], e)
        _update(key, status="ready", box1=None, box2=None,
                message=f"downloaded — box predict failed: {e} (draw manually)")
        return

    msg = "ready — open to fine-tune"
    if notes:
        msg += " · " + ", ".join(notes)
    _update(key, status="ready", box1=box1, box2=box2, message=msg)


def _render_one(job: dict) -> None:
    """Heavy phase (clipper): transcribe + render with the saved/edited boxes →
    a finished mp4 in output/. Runs in the SAME single worker thread, so only one
    render ever runs at a time (CPU/GPU-safe)."""
    key = job["key"]
    if not job.get("job_id"):
        _update(key, status="error", message="not downloaded yet — can't render")
        return
    b1 = job.get("box1") or []
    b2 = job.get("box2") or []
    if not b1 and not b2:
        _update(key, status="error", message="no boxes to render — open and draw/predict first")
        return
    try:
        src = downloader.get_source_path(job["job_id"])
    except Exception as e:  # noqa: BLE001
        _update(key, status="error", message=f"source missing: {e}")
        return

    _update(key, status="rendering", message="transcribing (Whisper)…")
    try:
        words = [Word(**w) for w in transcriber.transcribe(src)]
    except Exception as e:  # noqa: BLE001
        log.warning("queue transcribe failed (%s): %s", job["id"], e)
        _update(key, status="error", message=f"transcribe failed: {e}")
        return

    _update(key, status="rendering", message="rendering + caption…")
    try:
        kf1 = [Keyframe(**k) for k in b1] or None
        kf2 = [Keyframe(**k) for k in b2] or None
        out = renderer.render(
            job_id=job["job_id"], source_path=src, title=job.get("title") or "clip",
            box1=kf1, box2=kf2, words=words,
            caption_font=CAPTION_FONT, caption_size=CAPTION_SIZE,
        )
    except Exception as e:  # noqa: BLE001
        log.warning("queue render failed (%s): %s", job["id"], e)
        _update(key, status="error", message=f"render failed: {e}")
        return

    _update(key, status="done", output_path=out["output_path"], filename=out["filename"],
            message=f"done — {out['filename']}")


def _next_actionable():
    """First job needing work, in list order: a `pending` one to download+predict,
    or a `render_queued` one to render. Returns (job_copy, kind) or (None, None)."""
    with _lock:
        for j in _jobs:
            if j["status"] == "pending":
                return dict(j), "process"
            if j["status"] == "render_queued":
                return dict(j), "render"
    return None, None


def _reset_interrupted() -> None:
    """A job left mid-flight by a restart resumes from the start of its phase."""
    with _lock:
        changed = False
        for j in _jobs:
            if j["status"] in ("downloading", "predicting"):
                j["status"], j["message"] = "pending", "re-queued after restart"
                changed = True
            elif j["status"] == "rendering":
                j["status"], j["message"] = "render_queued", "re-queued render after restart"
                changed = True
        if changed:
            _save()


def _worker_loop() -> None:
    while True:
        job, kind = _next_actionable()
        if job is None:
            _wake.wait(timeout=5)
            _wake.clear()
            continue
        try:
            if kind == "render":
                _render_one(job)
            else:
                _process_one(job)
        except Exception as e:  # noqa: BLE001 — never let the worker thread die
            log.exception("queue worker crashed on %s: %s", job.get("id"), e)
            _update(job["key"], status="error", message=f"worker error: {e}")


def start_worker() -> None:
    """Idempotent — call once at app startup."""
    global _worker_started
    with _lock:
        if _worker_started:
            return
        _worker_started = True
        _load()
        _reset_interrupted()
    threading.Thread(target=_worker_loop, daemon=True, name="queue-worker").start()
    log.info("queue worker started (%d job(s) loaded)", len(_jobs))
