"""Dispatch a render to one of the remote GPU boxes (they run render_service.py).

Pool of box URLs from `RENDER_REMOTE_URLS` (env or project-root .env, comma-sep,
e.g. "http://HOST1:8870,http://HOST2:8870,…"). Each box renders ONE
job at a time, so we gate per-box with a local lock + the box's own 503 guard.
`render()` uploads the source + params (+ intro PNG), streams the finished mp4 into
the main box's output/, and returns the result dict — or None so the caller falls
back to a local render (box busy / down / errored). Transcription stays local; only
the heavy ffmpeg render is offloaded."""
import json
import logging
import os
import threading
from pathlib import Path
from typing import Optional

import requests

log = logging.getLogger("clipper.render_remote")


def _load_urls() -> list[str]:
    raw = os.getenv("RENDER_REMOTE_URLS", "")
    if not raw:
        envf = Path(__file__).resolve().parent.parent / ".env"
        if envf.exists():
            for line in envf.read_text(encoding="utf-8", errors="ignore").splitlines():
                line = line.strip()
                if line.startswith("RENDER_REMOTE_URLS="):
                    raw = line.split("=", 1)[1].strip().strip('"').strip("'")
                    break
    return [u.strip().rstrip("/") for u in raw.split(",") if u.strip()]


_URLS = _load_urls()
_box_locks = {u: threading.Lock() for u in _URLS}
_box_host = {}                  # url → friendly hostname (PC111…), filled on health checks
_box_job = {}                   # url → job_id currently rendering there (for cancel)


def enabled() -> bool:
    return bool(_URLS)


def box_count() -> int:
    return len(_URLS)


def _acquire_box() -> Optional[str]:
    """Grab the first free + healthy box (one in-flight job each). None if all busy/down."""
    for u in _URLS:
        if _box_locks[u].acquire(blocking=False):
            try:
                h = requests.get(f"{u}/health", timeout=4).json()
                if h.get("ok") and not h.get("busy"):
                    _box_host[u] = h.get("host") or u
                    return u
            except Exception:  # noqa: BLE001 — box down/unreachable
                pass
            _box_locks[u].release()
    return None


def _release(u: str) -> None:
    try:
        _box_locks[u].release()
    except Exception:  # noqa: BLE001
        pass


def cancel(job_id: str) -> bool:
    """If a box is currently rendering `job_id`, tell it to kill its ffmpeg.
    Returns True iff a box had this job (so the caller knows it was remote, not
    local). The render's POST then errors out and render() returns None."""
    for u, jid in list(_box_job.items()):
        if jid == job_id:
            try:
                requests.post(f"{u}/cancel", data={"job_id": job_id}, timeout=6)
            except Exception as e:  # noqa: BLE001
                log.warning("cancel on %s failed: %s", u, e)
            return True
    return False


def render(job_id: str, source_path: Path, params: dict, out_dir: Path,
           filename: str, intro_png: Optional[Path] = None,
           progress_cb=None, timeout: int = 1800) -> Optional[dict]:
    """Render on a remote box. Returns {output_path, filename, box} or None (→ local).
    While the (blocking) POST runs, a daemon thread polls the box's /progress and
    feeds the percent to progress_cb so the UI can show 'rendering… NN%'."""
    if not _URLS:
        return None
    box = _acquire_box()
    if not box:
        return None
    stop_poll = threading.Event()
    if progress_cb:
        def _poll():
            while not stop_poll.wait(2.0):
                try:
                    pr = requests.get(f"{box}/progress", params={"job_id": job_id}, timeout=4).json()
                    progress_cb(int(pr.get("pct", 0)))
                except Exception:  # noqa: BLE001
                    pass
        threading.Thread(target=_poll, daemon=True, name=f"poll-{job_id}").start()
    fhs = []
    try:
        src_fh = open(source_path, "rb")
        fhs.append(src_fh)
        files = {"source": ("source.mp4", src_fh, "video/mp4")}
        if intro_png and Path(intro_png).exists():
            ifh = open(intro_png, "rb")
            fhs.append(ifh)
            files["intro_png"] = ("intro.png", ifh, "image/png")
        data = {"job_id": job_id, "params": json.dumps(params)}
        _box_job[box] = job_id           # so cancel(job_id) can find this box
        r = requests.post(f"{box}/render", data=data, files=files, timeout=timeout, stream=True)
        if r.status_code == 503:          # box got busy between health-check and post
            return None
        r.raise_for_status()
        out = out_dir / filename
        with open(out, "wb") as f:
            for chunk in r.iter_content(1 << 20):
                if chunk:
                    f.write(chunk)
        if out.stat().st_size < 1024:     # sanity: a real mp4 is never this small
            out.unlink(missing_ok=True)
            return None
        host = _box_host.get(box, box)
        log.info("remote render done on %s → %s", host, filename)
        return {"output_path": f"/output/{filename}", "filename": filename, "box": host}
    except Exception as e:  # noqa: BLE001 — any failure → caller falls back to local
        log.warning("remote render on %s failed (%s) — falling back to local", box, e)
        return None
    finally:
        stop_poll.set()
        _box_job.pop(box, None)
        for fh in fhs:
            try:
                fh.close()
            except Exception:  # noqa: BLE001
                pass
        _release(box)
