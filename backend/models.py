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

    `dynamic=True` (always implies gap=True) marks a stretch the auto-box judged
    too unstable to box — left empty on purpose and flagged in the UI so the user
    draws it by hand. To the renderer it's just a gap (black); the flag is only a
    label so it shows distinctly from a normal absence gap. (Auto-box no longer
    EMITS dynamic gaps — a moving subject now pans instead — but the field stays
    for back-compat with jobs saved before that change.)

    `moving=True` (implies gap=False, dynamic=False) marks a REAL keyframe that is
    part of a panning track for a moving subject: the box SIZE is locked and the
    CENTER follows the subject (interp='linear'). Unlike dynamic it renders a box,
    not black. The flag keeps debounce / the hold-override / the split-geometry
    snaps from flattening the pan, and drives a 'TRACKED' UI chip.
    """
    t: float = 0.0
    x: float
    y: float
    w: float
    h: float
    interp: str = "hold"
    fit: str = "cover"
    gap: bool = False
    dynamic: bool = False
    moving: bool = False


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


class Candidate(BaseModel):
    """One Pexels stock-photo option. `thumb` is shown in the UI (loaded from the
    Pexels CDN — never stored). `full` is downloaded only if picked, at render."""
    id: str
    thumb: str
    full: str
    alt: str = ""
    photographer: str = ""


class SearchRequest(BaseModel):
    query: str


class SearchResponse(BaseModel):
    candidates: list[Candidate] = Field(default_factory=list)


class IllustrationPick(BaseModel):
    """A picked image overlaid over [t_start, t_end]. `target` chooses the region
    it fills: 'full' (whole 9:16), 'box1' (top slot) or 'box2' (bottom slot) —
    "represents" that box. `fit` is 'cover' (scale-cover + crop) or 'blur'
    (contained + blurred pad). Times are clip-relative; `url` is the candidate's
    `full` URL, downloaded at render (deduped)."""
    t_start: float
    t_end: float
    url: str
    target: str = "full"   # 'full' | 'box1' (top slot) | 'box2' (bottom slot)
    fit: str = "cover"     # 'cover' | 'blur'


class IntroConfig(BaseModel):
    """An intro card prepended to the render: the thumbnail (uploaded to
    temp/{job}_intro.png via /api/intro-image) shown for `duration`s with a Piper
    voiceover reading `text`, then a `transition` into the content. `transition`
    is an ffmpeg xfade name (fade/zoomin/slideleft/…) or 'cut' (no animation).
    Present in RenderRequest = intro on; absent/None = no intro."""
    transition: str = "fade"
    duration: float = 4.0
    text: str = ""
    voice: bool = True
    engine: str = "gtts"   # "gtts" (Google voice, online) | "piper" (offline)


class TtsRequest(BaseModel):
    """Text to synthesize for the intro voiceover preview. Capped — a pasted
    transcript instead of a headline would tie Piper up for minutes."""
    text: str = Field(..., max_length=500)
    engine: str = "gtts"   # "gtts" (Google voice, online) | "piper" (offline)


class KeepSegment(BaseModel):
    """A [start, end] window to KEEP (seconds, clip time). At render, everything
    OUTSIDE all kept windows is dropped and the kept parts are concatenated —
    lets the user cut out dead air / noisy stretches by marking what to keep."""
    start: float
    end: float


class SfxPlacement(BaseModel):
    """A soundboard sound placed onto the clip.
      - kind 'oneshot' — plays once starting at `t` (seconds, clip time).
      - kind 'range'   — plays over [t, t_end]; `loop` repeats it when the sound
                         is shorter than the range. `t_end` required for range.
    `volume` is a linear multiplier (1.0 = original) to balance against the
    clip's own audio. Times are clip-relative (re-based to a render sub-range)."""
    sound_id: str
    kind: str = "oneshot"          # 'oneshot' | 'range'
    t: float = 0.0
    t_end: Optional[float] = None
    volume: float = 1.0
    loop: bool = False


class SoundPatch(BaseModel):
    """Rename / set default volume for a library sound."""
    name: Optional[str] = None
    volume: Optional[float] = None


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
    # Soundboard sound effects mixed into the audio (one-shot + range/loop).
    sfx: list[SfxPlacement] = Field(default_factory=list)
    # Full-frame illustration cutaways (Pexels images over a time window).
    illustrations: list[IllustrationPick] = Field(default_factory=list)
    # Multi-segment KEEP trim: only these windows are kept (concatenated); the
    # rest is dropped at render. Overrides render_start/render_end when set.
    keep_segments: list[KeepSegment] = Field(default_factory=list)
    # Optional intro card (thumbnail + voiceover + transition) prepended at render.
    intro: Optional[IntroConfig] = None


class RenderResponse(BaseModel):
    output_path: str
    filename: str


class CleanupRequest(BaseModel):
    job_id: str


class DetectSilenceRequest(BaseModel):
    """AI trim helper: find quiet/dead-air stretches in the clip's audio.
    `noise_db` = silence threshold in dBFS (more negative = stricter),
    `min_dur` = minimum quiet length in seconds to count."""
    job_id: str
    noise_db: int = -35
    min_dur: float = 1.0


class AutoBoxRequest(BaseModel):
    """Ask the vision model to draw a box track for `prompt` over [t_start, t_end].
    `box` (1/2) is which slot the user is targeting — it also tells fullscreen-
    webcam layout segments what the box IS (1 = streamer → whole frame, 2 =
    content → gap). The result is a list of keyframes the user can then edit in
    the Position step."""
    job_id: str
    prompt: str
    t_start: float = 0.0
    t_end: Optional[float] = None
    box: int = 1
    step_seconds: float = 0.4   # timing PRECISION — sampling is adaptive (~1s grid, denser only at changes)
    padding: float = 0.05       # expand each detected box by this fraction per side
    head_room: float = 0.10     # extra TOP-only headroom for the person box (no chin/forehead clip); ignored for content
    smooth: bool = True         # damp frame-to-frame jitter
    lock_size: bool = True      # lock one box size across the range (pan only) — stable framing
    director: bool = False      # windowed shot-director pre-pass (frames+transcript → richer segments+pan)
    diarization: bool = False   # add the dominant-speaker hint (needs pyannote + HF token)
    expect: str = ""            # desired-OUTPUT expectation prompt (guides the director)


class AutoBoxResponse(BaseModel):
    keyframes: list[Keyframe] = Field(default_factory=list)
    sampled: int = 0            # frames the vision model looked at
    detected: int = 0           # frames where the subject was found
    message: str = ""
    director_note: str = ""     # the director's segment timeline (when director=True)


class ThumbnailTextRequest(BaseModel):
    """Ask the text LLM for eye-catching thumbnail headline options derived from
    the video's context. The frame capture + compositing are done client-side;
    this only returns suggested wording (the user can always type their own)."""
    context: str = ""           # title + description + transcript (whatever the UI has)
    n: int = 5                  # how many options to return
    language: str = ""          # optional hint; empty = match the content language
    tone: str = ""              # "" default | "funny" (kocak) | "serious" | "clickbait"


class ThumbnailTextResponse(BaseModel):
    titles: list[str] = Field(default_factory=list)


class QueueImportRequest(BaseModel):
    """Raw text of the uploaded JSON file. Parsed server-side (tolerant of the
    Python-dict single-quote style the user pastes). `room_id` = the room the new
    jobs join (None = unassigned)."""
    content: str
    room_id: Optional[int] = None


class RoomCreate(BaseModel):
    name: str


class SegmentRequest(BaseModel):
    """Scout/segmenter input. `mode`='transcript' → propose clips from a pasted
    SRT / timestamped transcript (fast); `mode`='url' → download + Whisper the
    whole video first (heavy). Returns proposed clips that pre-fill the import."""
    mode: str = "transcript"
    url: str = ""
    transcript: str = ""
    title: str = ""
    description: str = ""
    n: int = 10


class QueueJobPatch(BaseModel):
    """Edits saved back to a queue job from the editor (auto-save). All optional —
    only the provided fields are written."""
    title: Optional[str] = None
    description: Optional[str] = None
    box1: Optional[list[Keyframe]] = None
    box2: Optional[list[Keyframe]] = None
    # Editable layout context + per-box prompts, so re-Generate from the UI uses
    # the same (now user-tuned) text the batch ran with.
    context: Optional[str] = None
    prompt1: Optional[str] = None
    prompt2: Optional[str] = None
    # Per-clip edits from the other steps, each a JSON string, so EVERY page
    # auto-saves: thumbnail (headline+style), sfx (Sound), illustrations
    # (Illustration cutaways), keep_segments (Trim), caption (font/size).
    thumbnail: Optional[str] = None
    sfx: Optional[str] = None
    illustrations: Optional[str] = None
    keep_segments: Optional[str] = None
    caption: Optional[str] = None
    transcript: Optional[str] = None   # edited transcript (JSON list of {word,start,end})
