from typing import Optional
from pydantic import BaseModel, Field


class Keyframe(BaseModel):
    """Single position/size sample at time `t` (seconds, relative to clip start).
    `interp` controls how the value extends to the next keyframe:
      - 'hold'   (default) — value is constant until next keyframe (step / static segment)
      - 'linear' — linearly interpolate to next keyframe's value (smooth pan)
    The interp on the LAST keyframe is ignored (value just holds forever).

    `fit` controls how this keyframe's crop is fitted into the slot for the
    *segment that starts at this keyframe* (i.e. until the next keyframe's t):
      - 'cover'    (default) — scale-cover + center-crop. Excess outside slot AR is clipped.
      - 'blur_pad' — scale-contain (full crop visible) + blurred copy filling the gaps.
    Different keyframes in the same box may use different fit modes — backend
    handles the transition with overlay+enable in the filter graph.

    `gap=True` marks the segment starting at this keyframe as empty — the slot
    renders as black for the duration of this segment. Lets the user trim a box
    in the middle (click × on the bbox overlay → insert gap kf at currentTime)
    while preserving earlier keyframes. xywh are kept (usually copied from the
    previous kf) but unused during render.
    """
    t: float = 0.0
    x: float
    y: float
    w: float
    h: float
    interp: str = "hold"
    fit: str = "cover"
    gap: bool = False


class Word(BaseModel):
    word: str
    start: float
    end: float


class DownloadRequest(BaseModel):
    url: str
    start: str = "00:00:00"
    end: Optional[str] = None
    title: str = "clip"
    description: str = ""


class DownloadResponse(BaseModel):
    job_id: str
    video_path: str
    duration: float
    width: int
    height: int


class TranscribeRequest(BaseModel):
    job_id: str


class TranscribeResponse(BaseModel):
    words: list[Word]


CAPTION_FONTS = [
    "Anton",          # bundled (assets/fonts) — heavy display, TikTok default
    "Bebas Neue",     # bundled — tall condensed
    "Bricolage Grotesque",
    "JetBrains Mono",
    "Inter",
    "Arial",
    "Impact",
]


class RenderRequest(BaseModel):
    job_id: str
    title: str = "clip"
    # Each box is a list of keyframes (len >= 1). One keyframe = static.
    # Multiple keyframes = linear interpolation between them per frame.
    box1: Optional[list[Keyframe]] = None
    box2: Optional[list[Keyframe]] = None
    words: list[Word] = Field(default_factory=list)
    caption_font: str = "Anton"
    caption_size: int = 64
    cleanup: bool = False
    # Optional render sub-range (seconds from clip start). Lets the user trim
    # the already-downloaded source further without re-downloading.
    # None on either side means "open" — start defaults to 0, end to clip end.
    render_start: Optional[float] = None
    render_end: Optional[float] = None


class RenderResponse(BaseModel):
    output_path: str
    filename: str


class CleanupRequest(BaseModel):
    job_id: str


class AutoBoxRequest(BaseModel):
    """Ask the vision model to draw a box track for `prompt` over [t_start, t_end].
    `box` (1/2) is informational (which slot the user is targeting). The result is
    a list of keyframes the user can then edit in the Position step."""
    job_id: str
    prompt: str
    t_start: float = 0.0
    t_end: Optional[float] = None
    box: int = 1
    step_seconds: float = 1.5   # sample one frame every N seconds across the range
    padding: float = 0.05       # expand each detected box by this fraction per side
    smooth: bool = True         # damp frame-to-frame jitter
    lock_size: bool = True      # lock one box size across the range (pan only) — stable framing


class AutoBoxResponse(BaseModel):
    keyframes: list[Keyframe] = Field(default_factory=list)
    sampled: int = 0            # frames the vision model looked at
    detected: int = 0           # frames where the subject was found
    message: str = ""


class ThumbnailTextRequest(BaseModel):
    """Ask the text LLM for eye-catching thumbnail headline options derived from
    the video's context. The frame capture + compositing are done client-side;
    this only returns suggested wording (the user can always type their own)."""
    context: str = ""           # title + description + transcript (whatever the UI has)
    n: int = 5                  # how many options to return
    language: str = ""          # optional hint; empty = match the content language


class ThumbnailTextResponse(BaseModel):
    titles: list[str] = Field(default_factory=list)


class QueueImportRequest(BaseModel):
    """Raw text of the uploaded JSON file. Parsed server-side (tolerant of the
    Python-dict single-quote style the user pastes)."""
    content: str


class QueueJobPatch(BaseModel):
    """Edits saved back to a queue job from the editor (auto-save). All optional —
    only the provided fields are written."""
    title: Optional[str] = None
    description: Optional[str] = None
    box1: Optional[list[Keyframe]] = None
    box2: Optional[list[Keyframe]] = None
