"""Whisper STT wrapper — returns flat word-level timestamps.

Two backends, auto-selected:
  • faster-whisper (CTranslate2) — PREFERRED when installed. Runs large-v3 in int8
    on a 6 GB GPU and float16 on bigger cards, far more accurate for Indonesian +
    4-5× faster + built-in VAD. This is the accuracy upgrade.
  • openai-whisper — fallback when faster-whisper isn't installed (keeps the laptop
    working with `medium`). Byte-for-byte the old behaviour.

Env knobs (read from the project-root .env OR the process env):
  WHISPER_MODEL     model name. faster-whisper default `large-v3`; openai default
                    `medium` on GPU / `base` on CPU. (`large-v3` is fine on
                    faster-whisper at any VRAM; on openai it needs ~10 GB.)
  WHISPER_COMPUTE   faster-whisper compute_type: int8 | int8_float16 | float16 |
                    float32. Default `int8_float16` on GPU (fits 6 GB, near-fp16
                    quality), `int8` on CPU. On an 8/16 GB card set `float16` for
                    max accuracy.
  WHISPER_BACKEND   force `openai` or `faster` (default: faster if importable).
  WHISPER_LANGUAGE  language code e.g. "id"; empty = auto-detect.

On CUDA the model is loaded per call and its VRAM is RELEASED afterwards, so the
render step (NVENC, same GPU) gets the full GPU back; a CUDA OOM transparently
retries on CPU instead of failing the request.
"""
import gc
import json
import os
import subprocess
import tempfile
import urllib.request
from pathlib import Path
from typing import Optional
from urllib.parse import urlencode

import torch
import whisper


def _load_dotenv() -> None:
    """Load KEY=VALUE lines from the project-root .env into os.environ (no
    override). Self-contained so this module honors WHISPER_* regardless of
    import order or whether the project has a config.py."""
    env_path = Path(__file__).resolve().parent.parent / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        os.environ.setdefault(key.strip(), val.strip().strip('"').strip("'"))


_load_dotenv()

DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
LANGUAGE = os.getenv("WHISPER_LANGUAGE", "").strip() or None

# Optional REMOTE Whisper: when set, transcription is offloaded to a faster-whisper
# HTTP service on a GPU box (e.g. http://10.17.101.235:8899). The clip's audio is
# extracted to a small mono-16k wav locally and POSTed there. Any failure falls
# back to local transcription so the request still succeeds.
REMOTE_URL = os.getenv("WHISPER_REMOTE_URL", "").strip().rstrip("/")


def _transcribe_remote(video_path: Path, initial_prompt: Optional[str]) -> list[dict]:
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        wav = f.name
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
             "-i", str(video_path), "-ac", "1", "-ar", "16000", "-f", "wav", wav],
            check=True, capture_output=True,
        )
        q = {}
        if LANGUAGE:
            q["language"] = LANGUAGE
        if initial_prompt:
            q["initial_prompt"] = initial_prompt
        url = REMOTE_URL + "/transcribe" + (("?" + urlencode(q)) if q else "")
        with open(wav, "rb") as fh:
            body = fh.read()
        req = urllib.request.Request(
            url, data=body, method="POST",
            headers={"Content-Type": "application/octet-stream"},
        )
        with urllib.request.urlopen(req, timeout=600) as r:
            return json.load(r).get("words", [])
    finally:
        try:
            os.unlink(wav)
        except OSError:
            pass

# Backend selection: faster-whisper when importable (unless forced off).
_BACKEND = os.getenv("WHISPER_BACKEND", "").strip().lower()
try:
    from faster_whisper import WhisperModel as _FWModel  # noqa: F401
    _FASTER_AVAILABLE = True
except Exception:  # noqa: BLE001
    _FASTER_AVAILABLE = False
USE_FASTER = (_BACKEND == "faster") or (_BACKEND != "openai" and _FASTER_AVAILABLE)

# faster-whisper handles large-v3 even on 6 GB → default to it. openai stays at medium.
FASTER_MODEL = os.getenv("WHISPER_MODEL") or "large-v3"
OPENAI_MODEL = os.getenv("WHISPER_MODEL") or ("medium" if DEVICE == "cuda" else "base")
COMPUTE = os.getenv("WHISPER_COMPUTE") or ("int8_float16" if DEVICE == "cuda" else "int8")


# ───────────────────────── faster-whisper backend ─────────────────────────
def _transcribe_faster(device: str, name: str, compute: str, video_path: Path,
                       initial_prompt: Optional[str]) -> list[dict]:
    from faster_whisper import WhisperModel
    model = WhisperModel(name, device=device, compute_type=compute)
    try:
        segments, _info = model.transcribe(
            str(video_path),
            language=LANGUAGE,
            word_timestamps=True,
            vad_filter=True,                     # skip non-speech → fewer hallucinations
            condition_on_previous_text=False,    # stop repeat/hallucination loops
            initial_prompt=initial_prompt or None,
            beam_size=5,
        )
        words: list[dict] = []
        for seg in segments:                     # generator → iterating runs the decode
            for w in (seg.words or []):
                tok = (w.word or "").strip()
                if not tok:
                    continue
                words.append({"word": tok, "start": float(w.start), "end": float(w.end)})
        return words
    finally:
        del model
        if device == "cuda":
            gc.collect()
            torch.cuda.empty_cache()


# ───────────────────────── openai-whisper backend ─────────────────────────
def _transcribe_openai(device: str, name: str, video_path: Path,
                       initial_prompt: Optional[str]) -> list[dict]:
    """Load `name` on `device`, transcribe, then free the model (releasing VRAM
    on CUDA so the render step gets the whole GPU back)."""
    model = whisper.load_model(name, device=device)
    try:
        result = model.transcribe(
            str(video_path),
            word_timestamps=True,
            verbose=False,
            language=LANGUAGE,
            initial_prompt=initial_prompt or None,
            condition_on_previous_text=False,
            fp16=(device == "cuda"),
        )
    finally:
        del model
        if device == "cuda":
            gc.collect()
            torch.cuda.empty_cache()
    words: list[dict] = []
    for seg in result.get("segments", []):
        for w in seg.get("words", []) or []:
            token = (w.get("word") or "").strip()
            if not token:
                continue
            words.append({
                "word": token,
                "start": float(w.get("start", 0.0)),
                "end": float(w.get("end", 0.0)),
            })
    return words


def transcribe(video_path: Path, model_name: Optional[str] = None,
               initial_prompt: Optional[str] = None) -> list[dict]:
    """Returns a flat list of {word, start, end} dicts.

    `initial_prompt` biases the decoder toward expected vocabulary (proper nouns,
    topic terms) to cut mis-spellings.
    """
    if REMOTE_URL:
        try:
            return _transcribe_remote(video_path, initial_prompt)
        except Exception as e:  # noqa: BLE001 — remote down → fall back to local
            print(f"[TRANSCRIBE] remote whisper failed ({e}); falling back to local")

    if USE_FASTER:
        name = model_name or FASTER_MODEL
        try:
            return _transcribe_faster(DEVICE, name, COMPUTE, video_path, initial_prompt)
        except Exception as e:  # noqa: BLE001
            msg = str(e).lower()
            # GPU trouble → try faster-whisper on CPU (int8) first…
            if DEVICE == "cuda":
                gc.collect()
                torch.cuda.empty_cache()
                try:
                    return _transcribe_faster("cpu", name, "int8", video_path, initial_prompt)
                except Exception:  # noqa: BLE001
                    pass
            # …else degrade to openai-whisper so the request still succeeds.
            print(f"[TRANSCRIBE] faster-whisper failed ({e}); falling back to openai-whisper")

    name = model_name or OPENAI_MODEL
    try:
        return _transcribe_openai(DEVICE, name, video_path, initial_prompt)
    except RuntimeError as e:
        if DEVICE == "cuda" and "out of memory" in str(e).lower():
            gc.collect()
            torch.cuda.empty_cache()
            return _transcribe_openai("cpu", name, video_path, initial_prompt)
        raise
