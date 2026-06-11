"""Piper TTS — text → wav, for the intro-card voiceover.

Local & free: the voice model lives in clipper/voices/ (gitignored, ~60MB).
Default = the Indonesian news-reader voice `id_ID-news_tts-medium`; any other
`.onnx` dropped in voices/ is picked up as a fallback. `enabled()` is true once
a voice model is present. Synthesis shells out to Piper via the SAME interpreter
(`python -m piper`) so it works regardless of PATH/venv activation.
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


def enabled() -> bool:
    """True when a Piper voice model is installed — gates the intro voiceover."""
    return voice_path() is not None


def synthesize(text: str, out_path: Path) -> Path:
    """Render `text` to a wav at out_path with Piper. Raises on failure."""
    text = (text or "").strip()
    if not text:
        raise ValueError("empty text")
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
