"""Scout / segmenter — propose the best short-clip moments from a full video.

Two inputs (both supported):
  - a pasted TRANSCRIPT (SRT, a `[12.3] text` / `MM:SS text` timestamped dump, or
    Whisper `words`), OR
  - a full video that the caller has already transcribed to `words`.

The text vLLM (the SAME Qwen3 endpoint thumbnail.py uses) reads the timestamped
transcript and returns clip moments in the batch-queue import shape:
  {start, end, title, description, bbox_1, bbox_2, context}
The user reviews/edits the result and imports it through the normal manual flow —
the segmenter just PRE-FILLS that form (so the two modes share one import path).

Self-loads the project-root .env, reasoning disabled, cold-start 504s retried —
same handling as thumbnail.py / illustrator's llm.py.
"""
import json
import logging
import os
import re
from pathlib import Path
from typing import Optional

from openai import OpenAI

log = logging.getLogger(__name__)


def _load_dotenv() -> None:
    env_path = Path(__file__).resolve().parent.parent / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


_load_dotenv()

BASE_URL = os.getenv("VLLM_BASE_URL", "https://internal-rnd.balitower.co.id/models/qwen35").strip()
MODEL = os.getenv("VLLM_MODEL", "gb10-qwen35-122b-nvfp4-4node-100k").strip()
API_KEY = os.getenv("VLLM_API_KEY", "dummy")

_client_singleton: Optional[OpenAI] = None
_NO_THINK = {"chat_template_kwargs": {"enable_thinking": False}}
_MAX_ATTEMPTS = 3
_MAX_TRANSCRIPT_CHARS = 14000   # cap the prompt (a long podcast transcript is huge)
_THINK_RE = re.compile(r"<think>.*?</think>", re.DOTALL | re.IGNORECASE)


def enabled() -> bool:
    return bool(BASE_URL and MODEL)


def _client() -> OpenAI:
    global _client_singleton
    if _client_singleton is None:
        _client_singleton = OpenAI(api_key=API_KEY, base_url=BASE_URL, timeout=120)
    return _client_singleton


# ───────────────────────── transcript → timestamped text ─────────────────────────
def _hms_to_s(h: str) -> float:
    """'00:01:23,400' or '01:23' → seconds."""
    h = h.replace(",", ".").strip()
    parts = h.split(":")
    try:
        parts = [float(p) for p in parts]
    except ValueError:
        return 0.0
    if len(parts) == 3:
        return parts[0] * 3600 + parts[1] * 60 + parts[2]
    if len(parts) == 2:
        return parts[0] * 60 + parts[1]
    return parts[0] if parts else 0.0


_SRT_TS = re.compile(r"(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})")
_LINE_TS = re.compile(r"^\s*[\[(]?(\d{1,2}:\d{2}(?::\d{2})?|\d+(?:\.\d+)?)\s*[\])]?\s*[-–:]?\s*(.*)$")


def transcript_from_words(words: list, win: float = 6.0) -> str:
    """Whisper `words` ([{word,start,end}]) → a compact `[t] text` transcript,
    one line per ~`win`-second block, so the LLM sees WHAT is said and WHEN."""
    lines, buf, t0 = [], [], None
    for w in (words or []):
        s = float(w.get("start", 0.0))
        if t0 is None:
            t0 = s
        buf.append(str(w.get("word", "")).strip())
        if s - t0 >= win:
            lines.append(f"[{t0:.1f}] " + " ".join(x for x in buf if x))
            buf, t0 = [], None
    if buf:
        lines.append(f"[{t0 or 0.0:.1f}] " + " ".join(x for x in buf if x))
    return "\n".join(lines)


def normalize_transcript(text: str) -> str:
    """Coerce a pasted transcript to the `[seconds] text` form the LLM expects.
    Accepts SRT, `MM:SS text` / `[12.3] text` lines, or plain text (no times →
    returned as-is; the LLM then can't anchor times well, so SRT/timestamps are
    strongly preferred). Best-effort, never raises."""
    text = (text or "").strip()
    if not text:
        return ""
    # SRT: blocks separated by blank lines, each with a "HH:MM:SS,mmm --> ..." line
    if _SRT_TS.search(text):
        out = []
        for block in re.split(r"\n\s*\n", text):
            m = _SRT_TS.search(block)
            if not m:
                continue
            start = _hms_to_s(m.group(1))
            body = []
            for ln in block.splitlines():
                if _SRT_TS.search(ln) or re.fullmatch(r"\s*\d+\s*", ln):
                    continue
                body.append(ln.strip())
            txt = " ".join(x for x in body if x)
            if txt:
                out.append(f"[{start:.1f}] {txt}")
        if out:
            return "\n".join(out)
    # `MM:SS text` / `[12.3] text` lines
    out = []
    for ln in text.splitlines():
        m = _LINE_TS.match(ln)
        if m and m.group(2).strip():
            out.append(f"[{_hms_to_s(m.group(1)):.1f}] {m.group(2).strip()}")
    if out:
        return "\n".join(out)
    return text   # plain text — no timestamps to extract


_SYSTEM = (
    "You are a short-form video CLIPPER's scout. You are given a TIMESTAMPED "
    "transcript of one long video (lines look like `[83.5] spoken words`). Pick the "
    "BEST self-contained moments to cut into vertical TikTok/Shorts/Reels clips.\n"
    "Return ONLY a JSON array — no prose, no markdown fences. Each item:\n"
    '{"start": <seconds>, "end": <seconds>, "title": "...", "description": "...", '
    '"bbox_1": "...", "bbox_2": "...", "context": "..."}\n'
    "RULES:\n"
    "- start/end are SECONDS (numbers) taken from the [..] timestamps. Each clip is "
    "a COMPLETE thought: ~15-75s, never overlapping, ordered by time.\n"
    "- title = punchy hook in the CONTENT's language (Indonesian transcript → "
    "Indonesian title). description = one short sentence of what happens.\n"
    "- bbox_1 / bbox_2 / context describe the 9:16 LAYOUT for the auto-boxer: "
    "bbox_1 = the MAIN on-camera person (e.g. 'the streamer / host speaking'); "
    "bbox_2 = the SECOND region (a co-host/guest, OR the content/meme/video/post "
    "being shown); context = one line naming the layout (e.g. 'reaction: streamer "
    "webcam beside the content' or 'podcast: two hosts side by side'). Keep them "
    "GENERIC and short — the boxer refines per-frame.\n"
    "- Prefer punchlines, hot takes, reveals, funny or emotional beats; skip dead "
    "air and intros."
)


def _parse_json_array(text: str) -> list:
    """Pull a JSON array out of the model reply (tolerant of fences / stray prose)."""
    text = _THINK_RE.sub("", text or "")
    text = text.replace("```json", "").replace("```", "").strip()
    try:
        v = json.loads(text)
        if isinstance(v, list):
            return v
        if isinstance(v, dict):
            for val in v.values():
                if isinstance(val, list):
                    return val
    except Exception:  # noqa: BLE001
        pass
    m = re.search(r"\[.*\]", text, re.DOTALL)
    if m:
        try:
            v = json.loads(m.group(0))
            return v if isinstance(v, list) else []
        except Exception:  # noqa: BLE001
            return []
    return []


def _chat(user: str) -> str:
    last: Optional[Exception] = None
    for attempt in range(_MAX_ATTEMPTS):
        try:
            resp = _client().chat.completions.create(
                model=MODEL,
                messages=[{"role": "system", "content": _SYSTEM},
                          {"role": "user", "content": user}],
                temperature=0.4,
                max_tokens=2200,
                extra_body=_NO_THINK,
            )
            return resp.choices[0].message.content or ""
        except Exception as e:  # noqa: BLE001
            last = e
            log.warning("segmenter LLM call failed (attempt %d/%d): %s",
                        attempt + 1, _MAX_ATTEMPTS, e)
    raise last  # type: ignore[misc]


def propose_clips(transcript: str, title: str = "", description: str = "",
                  n: int = 10, duration: float = 0.0) -> list:
    """Return up to `n` proposed clips [{id,start,end,title,description,bbox_1,
    bbox_2,context}] from a (timestamped) transcript. Raises on an LLM/parse
    failure so the caller can surface it (the UI shows the error)."""
    transcript = (transcript or "").strip()
    if not transcript:
        raise ValueError("empty transcript")
    transcript = transcript[:_MAX_TRANSCRIPT_CHARS]
    n = max(1, min(int(n or 10), 30))
    hint = ""
    if (title or "").strip():
        hint += f"VIDEO TITLE: {title.strip()}\n"
    if (description or "").strip():
        hint += f"VIDEO DESCRIPTION: {description.strip()}\n"
    if duration and duration > 0:
        hint += f"VIDEO DURATION: {duration:.0f}s (do not propose times past this)\n"
    user = (f"Propose up to {n} clip moments from this video.\n{hint}\n"
            f"TIMESTAMPED TRANSCRIPT:\n{transcript}")
    raw = _chat(user)
    items = _parse_json_array(raw)
    clips = []
    for i, it in enumerate(items):
        if not isinstance(it, dict):
            continue
        try:
            start = float(it.get("start"))
            end = float(it.get("end"))
        except (TypeError, ValueError):
            continue
        if end <= start:
            continue
        if duration and duration > 0:
            end = min(end, duration)
        clips.append({
            "id": f"seg{i + 1:02d}",
            "start": round(start, 2),
            "end": round(end, 2),
            "title": str(it.get("title") or f"Clip {i + 1}")[:120],
            "description": str(it.get("description") or "")[:300],
            "bbox_1": str(it.get("bbox_1") or "the main on-camera person speaking")[:400],
            "bbox_2": str(it.get("bbox_2") or "")[:400],
            "context": str(it.get("context") or "")[:400],
        })
        if len(clips) >= n:
            break
    clips.sort(key=lambda c: c["start"])
    return clips
