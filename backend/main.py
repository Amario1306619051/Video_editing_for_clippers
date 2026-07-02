import json
import sys
import uuid
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

# Allow `python backend/main.py` from project root or `python main.py` from backend/
sys.path.insert(0, str(Path(__file__).resolve().parent))

import autobox
import batchqueue as batch_queue
import diarize
import downloader
import imagesources
import pexels
import renderer
import segmenter
import soundboard
import thumbnail
import transcriber
import tts
import vision
from models import (
    DownloadRequest, DownloadResponse,
    TranscribeRequest, TranscribeResponse,
    RenderRequest, RenderResponse,
    CleanupRequest,
    AutoBoxRequest, AutoBoxResponse,
    ThumbnailTextRequest, ThumbnailTextResponse,
    QueueImportRequest, QueueJobPatch, RoomCreate, SegmentRequest,
    SoundPatch, DetectSilenceRequest,
    SearchRequest, SearchResponse,
    TtsRequest,
    Word,
)

BASE_DIR = Path(__file__).resolve().parent.parent
FRONTEND_DIR = BASE_DIR / "frontend"
TEMP_DIR = BASE_DIR / "temp"
OUTPUT_DIR = BASE_DIR / "output"
TEMP_DIR.mkdir(exist_ok=True)
OUTPUT_DIR.mkdir(exist_ok=True)

app = FastAPI(title="CLIPPER")


@app.middleware("http")
async def _no_cache_static(request: Request, call_next):
    """Make the browser always revalidate the frontend (index.html/app.js/style.css)
    so edits show up WITHOUT a manual hard-refresh. `no-cache` = use the cache only
    after revalidating via ETag/Last-Modified (StaticFiles still sends those → a 304
    when unchanged, fresh bytes when changed). API/media responses are left alone."""
    resp = await call_next(request)
    path = request.url.path
    if not path.startswith(("/api/", "/temp/", "/output/")) and \
       (path == "/" or path.endswith((".html", ".js", ".css"))):
        resp.headers["Cache-Control"] = "no-cache, must-revalidate"
    return resp


# Start the batch-queue worker: it downloads + auto-boxes queued clips one at a
# time in the background, resuming from the SQLite db queue/queue.db across restarts.
batch_queue.start_worker()


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
            caption_style=req.caption_style,
            caption_color=req.caption_color,
            caption_pos=req.caption_pos,
            caption_pos_ranges=req.caption_pos_ranges,
            text_overlays=req.text_overlays,
            stickers=req.stickers,
            render_start=req.render_start,
            render_end=req.render_end,
            sfx=req.sfx,
            illustrations=req.illustrations,
            keep_segments=req.keep_segments,
            intro=req.intro,
            grow_segments=req.grow_segments,
            zoom_segments=req.zoom_segments,
            combo_segments=req.combo_segments,
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
    # Director mode: transcribe inline (semantic context) and, if asked + available,
    # diarize for the speaker hint. Both are best-effort — a failure degrades to the
    # plain visual director / per-frame path, never a 500.
    words, turns = None, None
    if req.director:
        try:
            words = transcriber.transcribe(src)
        except Exception:  # noqa: BLE001
            words = None
        if req.diarization and diarize.enabled():
            try:
                turns = diarize.diarize_turns(src)
            except Exception:  # noqa: BLE001
                turns = None
    try:
        out = autobox.predict_track(
            src, req.prompt, req.t_start, req.t_end,
            step_seconds=req.step_seconds, padding=req.padding, smooth=req.smooth,
            lock_size=req.lock_size, head_room=req.head_room,
            # box 1 = streamer, box 2 = content — the placeholder convention;
            # only consulted in fullscreen-webcam layout segments
            role={1: "streamer", 2: "content"}.get(req.box),
            use_director=req.director, words=words, turns=turns, expect=req.expect,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    kfs = out["keyframes"]
    cap_note = (f" (range long — sampled every {out['step']}s, capped at {out['sampled']} frames)"
                if out.get("capped") else "")
    if out.get("vision_down"):
        msg = ("Vision model is down / unreachable — auto-box skipped (no box drawn). "
               "Draw the box manually, or try again once it's back up.")
    else:
        msg = (f"Detected '{req.prompt.strip()}' in {out['detected']}/{out['sampled']} frames"
               f" (every {out['step']}s).{cap_note}"
               if kfs else
               f"No '{req.prompt.strip()}' found in {out['sampled']} frames — try a different prompt or range.")
    return {"keyframes": kfs, "sampled": out["sampled"], "detected": out["detected"],
            "message": msg, "director_note": out.get("director_note", "")}


@app.post("/api/thumbnail-text", response_model=ThumbnailTextResponse)
def api_thumbnail_text(req: ThumbnailTextRequest):
    """Eye-catching thumbnail headline suggestions (text only) from the LLM. The
    frame + compositing + PNG export are all done client-side on a canvas."""
    if not thumbnail.enabled():
        raise HTTPException(status_code=400,
                            detail="text model not configured (set VLLM_BASE_URL / VLLM_MODEL in .env)")
    try:
        titles = thumbnail.generate_titles(req.context, req.n, req.language, req.tone)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    return {"titles": titles}


@app.get("/api/capabilities")
def api_capabilities():
    """Lets the frontend hide/disable features that need an optional backend
    dependency — the vision model (AI auto-box) and the text model (thumbnail
    headline ideas)."""
    return {"vision": vision.enabled(), "thumbnail": thumbnail.enabled(),
            "pexels": pexels.enabled(), "tts": tts.enabled(),
            "diarize": diarize.enabled(), "segment": segmenter.enabled(),
            "image_sources": imagesources.available()}


@app.post("/api/cleanup")
def api_cleanup(req: CleanupRequest):
    downloader.cleanup_job(req.job_id)
    return {"ok": True}


# ───────────────────────── batch queue ─────────────────────────
@app.post("/api/queue/import")
def api_queue_import(req: QueueImportRequest):
    """Upload a JSON of clips ({url: [{id,start,end,title,description,bbox_1,bbox_2}]}).
    Each clip becomes a queued job the background worker downloads + auto-boxes.
    `room_id` (optional) groups the new jobs under a room."""
    try:
        return batch_queue.import_text(req.content, room_id=req.room_id)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"could not parse JSON: {e}")


# ───────────────────────── rooms ─────────────────────────
@app.get("/api/rooms")
def api_rooms_list():
    """Streamer/project groups for the queue sidebar (id, name, job count)."""
    return {"rooms": batch_queue.list_rooms()}


@app.post("/api/rooms")
def api_rooms_create(req: RoomCreate):
    try:
        return batch_queue.create_room(req.name)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.delete("/api/rooms/{room_id}")
def api_rooms_delete(room_id: int):
    """Delete a room AND every job in it (with their downloaded videos)."""
    return batch_queue.delete_room(room_id)


@app.get("/api/queue")
def api_queue_list():
    """Sidebar summary of every job (status, kf counts) — polled by the frontend.
    `box_eta` = estimated seconds until the boxing queue drains (None until a
    sample exists)."""
    return {"jobs": batch_queue.list_jobs(), "box_eta": batch_queue.boxing_eta_seconds()}


@app.get("/api/queue/{key}")
def api_queue_get(key: str):
    """Full job (incl. predicted/edited keyframes) to load into the editor."""
    j = batch_queue.get_job(key)
    if not j:
        raise HTTPException(status_code=404, detail="job not found")
    return j


@app.post("/api/queue/{key}/save")
def api_queue_save(key: str, patch: QueueJobPatch):
    """Auto-save edits (title + keyframes) back to the job so progress survives."""
    j = batch_queue.save_job(key, patch.model_dump(exclude_none=True))
    if not j:
        raise HTTPException(status_code=404, detail="job not found")
    return {"ok": True}


@app.post("/api/queue/{key}/retry")
def api_queue_retry(key: str):
    j = batch_queue.retry_job(key)
    if not j:
        raise HTTPException(status_code=404, detail="job not found")
    return {"ok": True}


@app.post("/api/queue/{key}/skip-box")
def api_queue_skip_box(key: str):
    """Pull a job out of the AI-boxing queue → ready immediately, no boxes —
    the user draws them manually instead of waiting for the boxing stage."""
    j = batch_queue.skip_boxing(key)
    if not j:
        raise HTTPException(status_code=404,
                            detail="job is not waiting for boxing (only 'downloaded' jobs can skip)")
    return {"ok": True}


@app.post("/api/queue/stop-boxing")
def api_queue_stop_boxing():
    """Stop the whole boxing run: every job still waiting to be boxed goes to
    ready (draw-manually). In-flight jobs finish; no new ones start."""
    return {"stopped": batch_queue.stop_boxing()}


@app.post("/api/queue/stop-render")
def api_queue_stop_render():
    """Stop rendering: kill the in-flight render's ffmpeg + pull rendering/queued
    renders back to ready. Each stays editable + re-renderable with ▶."""
    return batch_queue.stop_render()


@app.post("/api/queue/{key}/stop-render")
def api_queue_stop_render_one(key: str):
    """Stop/cancel render for ONE clip: kill its ffmpeg if it's the in-flight
    render, or pull it out of the queue if it's only queued. Others keep going."""
    r = batch_queue.stop_render_one(key)
    if not r.get("ok"):
        raise HTTPException(status_code=400, detail="job is not rendering or queued for render")
    return r


@app.post("/api/queue/render-ready")
def api_queue_render_ready():
    """Queue every edited-and-ready job for the background transcribe + render."""
    n = batch_queue.queue_render_all_ready()
    return {"queued": n}


@app.post("/api/queue/{key}/render")
def api_queue_render(key: str):
    """Queue one job for the background transcribe + render (after editing its boxes)."""
    j = batch_queue.queue_render(key)
    if not j:
        raise HTTPException(status_code=400, detail="job not found or not downloaded yet")
    return {"ok": True}


@app.delete("/api/queue/{key}")
def api_queue_delete(key: str):
    batch_queue.delete_job(key)
    return {"ok": True}


# ───────────────────────── soundboard ─────────────────────────
@app.post("/api/search", response_model=SearchResponse)
def api_search(req: SearchRequest):
    """Multi-source image search for the illustration cutaways (Step Illustration):
    Pexels / Openverse / Wikimedia / Unsplash / Pixabay (per req.source)."""
    try:
        candidates = imagesources.search(req.query, source=req.source)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    return {"candidates": candidates}


@app.post("/api/tts-preview")
def api_tts_preview(req: TtsRequest):
    """Synthesize text → wav (Google or Piper engine), for previewing the intro
    voiceover. Per-request unique file (concurrent previews must not clobber
    each other), deleted right away — the small wav is the response body."""
    if not tts.enabled():
        raise HTTPException(status_code=400, detail="no TTS engine available (install gTTS or drop a Piper voice into clipper/voices/)")
    text = (req.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="empty text")
    out = TEMP_DIR / f"tts_preview_{uuid.uuid4().hex}.wav"
    try:
        tts.synthesize(text, out, engine=req.engine)
        data = out.read_bytes()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        out.unlink(missing_ok=True)
    return Response(content=data, media_type="audio/wav")


@app.post("/api/intro-image")
async def api_intro_image(request: Request, job_id: str):
    """Upload the composed thumbnail PNG (raw body) to temp/{job_id}_intro.png so
    the render can prepend it as the intro card. Cleaned with the job."""
    data = await request.body()
    if not data:
        raise HTTPException(status_code=400, detail="empty image")
    try:
        downloader.get_source_path(job_id)  # validates the job exists
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    (TEMP_DIR / f"{job_id}_intro.png").write_bytes(data)
    return {"ok": True}


@app.post("/api/ill-upload")
async def api_ill_upload(request: Request, filename: str = "image"):
    """Upload the user's OWN image (raw body, like the soundboard import) to use
    as an illustration cutaway. Saved into temp/ deduped by content hash; the
    returned /temp/ URL plugs straight into the normal cutaway flow (the
    renderer's download_pick recognizes /temp/ URLs as already-local)."""
    import hashlib
    data = await request.body()
    if not data:
        raise HTTPException(status_code=400, detail="empty image")
    if len(data) > 25 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="image too large (max 25MB)")
    ext = Path(filename).suffix.lower()
    if ext not in (".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"):
        ext = ".jpg"
    name = f"ill_up_{hashlib.sha1(data).hexdigest()[:12]}{ext}"
    (TEMP_DIR / name).write_bytes(data)
    return {"url": f"/temp/{name}", "thumb": f"/temp/{name}"}


@app.post("/api/detect-silence")
def api_detect_silence(req: DetectSilenceRequest):
    """AI trim helper: find quiet/dead-air stretches (ffmpeg silencedetect) so
    the Trim step can auto-keep only the talking parts. Returns the silent
    ranges; the frontend builds editable keep-windows from their complement."""
    try:
        src = downloader.get_source_path(req.job_id)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    import re as _re
    import subprocess as _sp
    noise = int(req.noise_db) if req.noise_db else -35
    min_d = max(0.3, float(req.min_dur or 1.0))
    proc = _sp.run(
        ["ffmpeg", "-hide_banner", "-i", str(src),
         "-af", f"silencedetect=noise={noise}dB:d={min_d}", "-f", "null", "-"],
        capture_output=True, text=True, timeout=300,
    )
    silences, start = [], None
    for line in (proc.stderr or "").splitlines():
        m = _re.search(r"silence_start:\s*([0-9.]+)", line)
        if m:
            start = float(m.group(1))
            continue
        m = _re.search(r"silence_end:\s*([0-9.]+)", line)
        if m and start is not None:
            silences.append({"start": round(start, 2), "end": round(float(m.group(1)), 2)})
            start = None
    dur = 0.0
    try:
        dur = renderer._probe_duration(src)
    except Exception:  # noqa: BLE001
        pass
    if start is not None:                       # silence ran to the end of file
        silences.append({"start": round(start, 2), "end": round(dur or start, 2)})
    return {"silences": silences, "duration": dur}


@app.get("/api/img")
def api_img(url: str):
    """Same-origin proxy for a Pexels image so the Thumbnail canvas isn't tainted
    (a cross-origin image would make canvas.toBlob throw). Pexels hosts only."""
    import requests
    from fastapi import Response
    if not (url.startswith("https://images.pexels.com/") or url.startswith("https://www.pexels.com/")):
        raise HTTPException(status_code=400, detail="only Pexels image URLs allowed")
    try:
        r = requests.get(url, timeout=20)
        r.raise_for_status()
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))
    return Response(content=r.content, media_type=r.headers.get("content-type", "image/jpeg"))


@app.get("/api/soundboard")
def api_sb_list():
    """The persistent SFX library (id, name, duration, default volume)."""
    return {"sounds": soundboard.list_sounds()}


@app.post("/api/soundboard")
async def api_sb_add(request: Request, name: str = "", filename: str = ""):
    """Import an audio file. The file bytes are the raw request body (no
    multipart dependency); `name`/`filename` come from the query string."""
    data = await request.body()
    try:
        return soundboard.add_sound(name, filename, data)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/soundboard/{sid}")
def api_sb_update(sid: str, patch: SoundPatch):
    s = soundboard.update_sound(sid, patch.model_dump(exclude_none=True))
    if not s:
        raise HTTPException(status_code=404, detail="sound not found")
    return s


@app.delete("/api/soundboard/{sid}")
def api_sb_delete(sid: str):
    soundboard.delete_sound(sid)
    return {"ok": True}


@app.get("/api/soundboard/{sid}/audio")
def api_sb_audio(sid: str):
    """Serve the audio file — used for in-browser preview playback."""
    p = soundboard.path_for(sid)
    if not p:
        raise HTTPException(status_code=404, detail="sound not found")
    return FileResponse(p, media_type=soundboard.media_type(sid))


_TEMP_MEDIA = {
    ".mp4": "video/mp4", ".png": "image/png", ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
    ".bmp": "image/bmp",
}


@app.get("/temp/{name}")
def serve_temp(name: str):
    p = TEMP_DIR / name
    if not p.exists() or not p.is_file():
        raise HTTPException(status_code=404, detail="not found")
    return FileResponse(p, media_type=_TEMP_MEDIA.get(p.suffix.lower(), "application/octet-stream"))


@app.get("/output/{name}")
def serve_output(name: str):
    p = OUTPUT_DIR / name
    if not p.exists() or not p.is_file():
        raise HTTPException(status_code=404, detail="not found")
    return FileResponse(p, media_type="video/mp4", filename=name)


@app.post("/api/segment")
def api_segment(req: SegmentRequest):
    """Scout/segmenter: propose clip moments from a video. mode='transcript' uses a
    pasted SRT/timestamped transcript (fast); mode='url' downloads + Whispers the
    whole video first (heavy). Returns the proposed clips + a ready-to-edit import
    JSON that pre-fills the manual import box."""
    if not segmenter.enabled():
        raise HTTPException(status_code=503, detail="segmenter text model not configured")
    url = (req.url or "").strip()
    duration = 0.0
    if (req.mode or "transcript").strip().lower() == "url":
        if not url:
            raise HTTPException(status_code=400, detail="url is required for URL mode")
        try:
            res = downloader.download(url, "00:00:00", None, req.title or "video")
            src = downloader.get_source_path(res["job_id"])
            words = transcriber.transcribe(src)
            transcript = segmenter.transcript_from_words(words)
            duration = float(res.get("duration") or 0)
        except Exception as e:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=f"download/transcribe failed: {e}")
    else:
        transcript = segmenter.normalize_transcript(req.transcript or "")
        if not transcript.strip():
            raise HTTPException(status_code=400,
                                detail="paste a transcript (SRT or timestamped text) first")
    try:
        clips = segmenter.propose_clips(transcript, req.title, req.description, req.n, duration)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"segmenter failed: {e}")
    if not clips:
        raise HTTPException(status_code=422,
                            detail="no clips proposed — try a longer / timestamped transcript")
    import_obj = {(url or "PASTE_THE_VIDEO_URL_HERE"): clips}
    return {"clips": clips, "count": len(clips), "url": url,
            "import_json": json.dumps(import_obj, indent=2, ensure_ascii=False)}


# Static mount MUST be last — it's a catch-all.
app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="static")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=False)
