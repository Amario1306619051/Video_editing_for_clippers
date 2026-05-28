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
    caption_font: str = "Bricolage Grotesque"
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
