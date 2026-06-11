"""TTS — text → wav, for the intro-card voiceover. Two engines:

- "gtts" (default): the Google Translate voice (the one everyone knows from
  Google) via the gTTS package — needs internet, no local model.
- "piper": local & free; the voice model lives in clipper/voices/ (gitignored,
  ~60MB). Default = the Indonesian news-reader voice `id_ID-news_tts-medium`;
  any other `.onnx` dropped in voices/ is picked up as a fallback. Synthesis
  shells out to Piper via the SAME interpreter (`python -m piper`) so it works
  regardless of PATH/venv activation.

`synthesize` tries the requested engine and silently FALLS BACK to the other
(offline → Piper still works; no Piper voice → Google still works). `enabled()`
is true when either engine is usable.
"""
import logging
import subprocess
import sys
from pathlib import Path
from typing import Optional

log = logging.getLogger(__name__)

BASE_DIR = Path(__file__).resolve().parent.parent
VOICES_DIR = BASE_DIR / "voices"
VOICES_DIR.mkdir(exist_ok=True)
PREFERRED = "id_ID-news_tts-medium.onnx"   # Indonesian news reader


def voice_path() -> Optional[Path]:
    p = VOICES_DIR / PREFERRED
    if p.exists():
        return p
    onnx = sorted(VOICES_DIR.glob("*.onnx"))
    return onnx[0] if onnx else None


def _gtts_available() -> bool:
    try:
        import gtts  # noqa: F401
        return True
    except ImportError:
        return False


def enabled() -> bool:
    """True when any TTS engine is usable — gates the intro voiceover."""
    return voice_path() is not None or _gtts_available()


GTTS_LANG = "id"   # the content's language — Indonesian


def _synthesize_gtts(text: str, out_path: Path) -> Path:
    """Google Translate voice via gTTS (online): text → mp3 → wav (ffmpeg)."""
    from gtts import gTTS
    mp3 = Path(str(out_path) + ".gtts.mp3")
    try:
        gTTS(text=text, lang=GTTS_LANG).save(str(mp3))
        proc = subprocess.run(
            ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
             "-i", str(mp3), "-ar", "22050", "-ac", "1", str(out_path)],
            capture_output=True, text=True, timeout=60,
        )
        if proc.returncode != 0 or not Path(out_path).exists():
            raise RuntimeError(f"ffmpeg mp3→wav failed: {proc.stderr.strip()[:200]}")
        return Path(out_path)
    finally:
        try:
            mp3.unlink()
        except OSError:
            pass


def synthesize(text: str, out_path: Path, engine: str = "gtts") -> Path:
    """Render `text` to a wav at out_path. Tries `engine` ("gtts"/"piper"),
    falls back to the other one on failure. Raises only when both fail."""
    text = (text or "").strip()
    if not text:
        raise ValueError("empty text")
    order = ["gtts", "piper"] if engine != "piper" else ["piper", "gtts"]
    last_err = None
    for eng in order:
        try:
            if eng == "gtts":
                if not _gtts_available():
                    raise RuntimeError("gTTS not installed")
                return _synthesize_gtts(text, out_path)
            return _synthesize_piper(text, out_path)
        except Exception as e:  # noqa: BLE001 — try the other engine
            last_err = e
            log.warning("tts engine %s failed (%s) — trying fallback", eng, e)
    raise RuntimeError(f"all TTS engines failed: {last_err}")


def _synthesize_piper(text: str, out_path: Path) -> Path:
    """Render `text` to a wav at out_path with Piper. Raises on failure."""
    voice = voice_path()
    if voice is None:
        raise RuntimeError("no Piper voice installed (clipper/voices/*.onnx)")
    try:
        # timeout kills the piper child on expiry — no orphan process pinning a CPU
        proc = subprocess.run(
            [sys.executable, "-m", "piper", "-m", str(voice), "-f", str(out_path)],
            input=text, capture_output=True, text=True, timeout=60,
        )
    except subprocess.TimeoutExpired:
        raise RuntimeError("piper timed out (text too long?)")
    if proc.returncode != 0:
        raise RuntimeError(f"piper failed: {proc.stderr.strip()[:300]}")
    if not Path(out_path).exists():
        raise RuntimeError("piper produced no output")
    return Path(out_path)
