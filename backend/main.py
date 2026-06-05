import sys
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

# Allow `python backend/main.py` from project root or `python main.py` from backend/
sys.path.insert(0, str(Path(__file__).resolve().parent))

import autobox
import downloader
import renderer
import transcriber
import vision
from models import (
    DownloadRequest, DownloadResponse,
    TranscribeRequest, TranscribeResponse,
    RenderRequest, RenderResponse,
    CleanupRequest,
    AutoBoxRequest, AutoBoxResponse,
    Word,
)

BASE_DIR = Path(__file__).resolve().parent.parent
FRONTEND_DIR = BASE_DIR / "frontend"
TEMP_DIR = BASE_DIR / "temp"
OUTPUT_DIR = BASE_DIR / "output"
TEMP_DIR.mkdir(exist_ok=True)
OUTPUT_DIR.mkdir(exist_ok=True)

app = FastAPI(title="CLIPPER")


@app.post("/api/download", response_model=DownloadResponse)
def api_download(req: DownloadRequest):
    try:
        result = downloader.download(req.url, req.start, req.end, req.title)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    return result


@app.post("/api/transcribe", response_model=TranscribeResponse)
def api_transcribe(req: TranscribeRequest):
    try:
        src = downloader.get_source_path(req.job_id)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    try:
        words = transcriber.transcribe(src)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    return {"words": words}


def _print_boxes(req: RenderRequest, src) -> None:
    """Debug: dump the bbox keyframes received for this render so the framing
    can be inspected against the preview. Shows source dims too (to spot a box
    that exceeds the frame)."""
    try:
        sw, sh = renderer._probe_dims(src)
    except Exception:
        sw = sh = 0
    print(f"\n[RENDER] job={req.job_id} title={req.title!r} source={sw}x{sh} "
          f"range=({req.render_start},{req.render_end}) caption={req.caption_font}/{req.caption_size}")
    for name, box in (("box1 (TOP 3:2)", req.box1), ("box2 (BOTTOM 9:10)", req.box2)):
        if not box:
            print(f"  {name}: (none)")
            continue
        print(f"  {name}: {len(box)} keyframe(s)")
        for k in box:
            off = ""
            if sw and sh and (k.x < 0 or k.y < 0 or k.x + k.w > sw or k.y + k.h > sh):
                off = "  <-- OFF-FRAME (will be clamped)"
            ar = (k.w / k.h) if k.h else 0
            print(f"    t={k.t:6.2f}s  x={k.x:7.1f} y={k.y:7.1f} w={k.w:7.1f} h={k.h:7.1f} "
                  f"AR={ar:.3f}  fit={k.fit:<8} interp={k.interp:<6} gap={k.gap}{off}")


@app.post("/api/render", response_model=RenderResponse)
def api_render(req: RenderRequest):
    if not req.box1 and not req.box2:
        raise HTTPException(status_code=400, detail="at least one of box1/box2 required (with >= 1 keyframe)")
    try:
        src = downloader.get_source_path(req.job_id)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    _print_boxes(req, src)
    try:
        result = renderer.render(
            job_id=req.job_id,
            source_path=src,
            title=req.title,
            box1=req.box1,
            box2=req.box2,
            words=req.words,
            caption_font=req.caption_font,
            caption_size=req.caption_size,
            render_start=req.render_start,
            render_end=req.render_end,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    if req.cleanup:
        downloader.cleanup_job(req.job_id)
    return result


@app.post("/api/autobox", response_model=AutoBoxResponse)
def api_autobox(req: AutoBoxRequest):
    """AI auto-box: sample frames over [t_start,t_end] and ask the vision model for
    the prompted subject's bounding box on each → a keyframe track the user edits."""
    if not vision.enabled():
        raise HTTPException(status_code=400,
                            detail="vision model not configured (set VISION_BASE_URL / VISION_MODEL in .env)")
    if not (req.prompt or "").strip():
        raise HTTPException(status_code=400, detail="prompt required")
    try:
        src = downloader.get_source_path(req.job_id)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    try:
        out = autobox.predict_track(
            src, req.prompt, req.t_start, req.t_end,
            step_seconds=req.step_seconds, padding=req.padding, smooth=req.smooth,
            lock_size=req.lock_size,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    kfs = out["keyframes"]
    cap_note = (f" (range long — sampled every {out['step']}s, capped at {out['sampled']} frames)"
                if out.get("capped") else "")
    msg = (f"Detected '{req.prompt.strip()}' in {out['detected']}/{out['sampled']} frames"
           f" (every {out['step']}s).{cap_note}"
           if kfs else
           f"No '{req.prompt.strip()}' found in {out['sampled']} frames — try a different prompt or range.")
    return {"keyframes": kfs, "sampled": out["sampled"], "detected": out["detected"], "message": msg}


@app.get("/api/capabilities")
def api_capabilities():
    """Lets the frontend hide/disable features that need an optional backend
    dependency — here, whether the vision model (AI auto-box) is configured."""
    return {"vision": vision.enabled()}


@app.post("/api/cleanup")
def api_cleanup(req: CleanupRequest):
    downloader.cleanup_job(req.job_id)
    return {"ok": True}


@app.get("/temp/{name}")
def serve_temp(name: str):
    p = TEMP_DIR / name
    if not p.exists() or not p.is_file():
        raise HTTPException(status_code=404, detail="not found")
    return FileResponse(p, media_type="video/mp4")


@app.get("/output/{name}")
def serve_output(name: str):
    p = OUTPUT_DIR / name
    if not p.exists() or not p.is_file():
        raise HTTPException(status_code=404, detail="not found")
    return FileResponse(p, media_type="video/mp4", filename=name)


# Static mount MUST be last — it's a catch-all.
app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="static")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=False)
