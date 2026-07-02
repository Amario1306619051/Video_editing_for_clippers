"""Remote render worker — runs on each GPU box.

Receives a render job (the source video + a JSON of render params, optionally an
intro PNG), reconstructs it locally and runs the SAME `renderer.render()` the main
clipper uses, then returns the finished mp4. One render at a time per box (NVENC +
the CPU filter graph already saturate a machine).

Run:  uvicorn render_service:app --host 0.0.0.0 --port 8870
The main clipper's render_remote.py dispatches jobs here and falls back to local
rendering if a box is busy / down / errors, so this service can be simple.
"""
import asyncio
import json
import os
import threading
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse

import renderer
from models import (CaptionPosRange, ComboSegment, GrowSegment, IllustrationPick,
                    IntroConfig, KeepSegment, Keyframe, Sticker, TextOverlay, Word, ZoomSegment)

app = FastAPI()
_busy = threading.Lock()        # serialize renders on this box (one at a time)
_active_job = None              # job_id currently rendering (for /cancel)
_progress = {}                  # job_id -> percent (0..100), polled by the dispatcher
TEMP = renderer.TEMP_DIR
TEMP.mkdir(parents=True, exist_ok=True)


@app.get("/health")
def health():
    return {"ok": True, "busy": _busy.locked(), "host": os.uname().nodename}


@app.get("/progress")
def progress(job_id: str):
    return {"pct": _progress.get(job_id, 0)}


@app.post("/cancel")
def cancel(job_id: str = Form(...)):
    """Kill the in-flight render if it's this job (the dispatcher's per-clip stop)."""
    if _active_job == job_id:
        killed = renderer.terminate_active()
        return {"killed": bool(killed)}
    return {"killed": False, "note": "not the active job"}


def _kfs(rows):
    return [Keyframe(**r) for r in rows] if rows else None


@app.post("/render")
async def render_ep(
    job_id: str = Form(...),
    params: str = Form(...),
    source: UploadFile = File(...),
    intro_png: UploadFile = File(None),
):
    # Reject immediately if already rendering — the dispatcher will try another box.
    if not _busy.acquire(blocking=False):
        raise HTTPException(status_code=503, detail="busy")
    global _active_job
    _active_job = job_id
    src_path = TEMP / f"{job_id}.mp4"
    try:
        p = json.loads(params)
        # Materialize the source video + optional intro card.
        with open(src_path, "wb") as f:
            while chunk := await source.read(1 << 20):
                f.write(chunk)
        if intro_png is not None:
            with open(TEMP / f"{job_id}_intro.png", "wb") as f:
                while chunk := await intro_png.read(1 << 20):
                    f.write(chunk)

        intro = None
        if isinstance(p.get("intro"), dict):
            intro = IntroConfig(**p["intro"])

        def _pcb(frac):
            _progress[job_id] = int(max(0.0, min(1.0, frac)) * 100)
        # renderer.render() is blocking (subprocess ffmpeg) — run it in a worker
        # thread so it never freezes the event loop (keeps /health responsive while
        # this box renders, and lets the dispatcher see the box as busy).
        out = await asyncio.to_thread(
            renderer.render,
            progress_cb=_pcb,
            job_id=job_id,
            source_path=src_path,
            title=p.get("title") or "clip",
            box1=_kfs(p.get("box1")),
            box2=_kfs(p.get("box2")),
            words=[Word(**w) for w in p.get("words", [])],
            caption_font=p.get("caption_font") or "Anton",
            caption_size=int(p.get("caption_size") or 64),
            caption_style=p.get("caption_style") or "color",
            caption_color=p.get("caption_color") or "yellow",
            caption_pos=p.get("caption_pos") or "middle",
            caption_pos_ranges=[CaptionPosRange(**r) for r in p.get("caption_pos_ranges", [])] or None,
            text_overlays=[TextOverlay(**t) for t in p.get("text_overlays", [])] or None,
            stickers=[Sticker(**s) for s in p.get("stickers", [])] or None,
            render_start=p.get("render_start"),
            render_end=p.get("render_end"),
            illustrations=[IllustrationPick(**c) for c in p.get("illustrations", [])] or None,
            keep_segments=[KeepSegment(**k) for k in p.get("keep_segments", [])] or None,
            intro=intro,
            grow_segments=[GrowSegment(**g) for g in p.get("grow_segments", [])] or None,
            zoom_segments=[ZoomSegment(**z) for z in p.get("zoom_segments", [])] or None,
            combo_segments=[ComboSegment(**c) for c in p.get("combo_segments", [])] or None,
        )
        out_file = renderer.OUTPUT_DIR / out["filename"]
        if not out_file.exists():
            raise HTTPException(status_code=500, detail="render produced no file")
        return FileResponse(str(out_file), media_type="video/mp4", filename=out["filename"])
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"render failed: {e}")
    finally:
        # Drop the source + ASS now; the output mp4 is streamed by FileResponse and
        # cleaned on the next render of the same id (or left for manual cleanup).
        try:
            src_path.unlink(missing_ok=True)
            (TEMP / f"{job_id}.ass").unlink(missing_ok=True)
            (TEMP / f"{job_id}_intro.png").unlink(missing_ok=True)
        except Exception:  # noqa: BLE001
            pass
        _active_job = None
        _progress.pop(job_id, None)
        _busy.release()
