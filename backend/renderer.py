import json
import os
import re
import subprocess
from pathlib import Path
from typing import Callable, Optional

import pexels
import soundboard
import tts
from models import IllustrationPick, IntroConfig, KeepSegment, Keyframe, SfxPlacement, Word

TEMP_DIR = Path(__file__).resolve().parent.parent / "temp"

# Valid ffmpeg xfade transition names we expose (+ 'cut' = plain concat,
# 'crumple' = custom paper-crumple dissolve built below).
_XFADE_OK = {"fade", "fadeblack", "fadewhite", "dissolve", "slideleft", "slideright",
             "slideup", "slidedown", "circleopen", "circleclose", "zoomin",
             "wipeleft", "wiperight", "pixelize", "radial", "crumple"}

# "Crumple paper" transition — a custom xfade `expr`. Each pixel reveals B over A
# on a per-pixel threshold = blocky pseudo-noise (paper facets) + a radial term, so
# the picture caves in from the edges toward the centre like a sheet being crushed.
# Instead of a HARD flip (which pops blockily), it CROSSFADES over a soft `band` of
# progress around the threshold → smooth reveal. ld(1)=threshold, ld(2)=mix 0..1.
# P is the 0→1 transition progress.
_CRUMPLE_EXPR = (
    "st(1,"
    "mod(sin(floor(X/36)*12.9898+floor(Y/36)*78.233)*43758.5453,1)*0.5"
    "+(1-hypot(X-W/2,Y-H/2)/hypot(W/2,H/2))*0.5"
    ");"
    "st(2,clip((P*1.8-0.5-ld(1))/0.16+0.5,0,1));"
    "A*(1-ld(2))+B*ld(2)"
)

OUTPUT_DIR = Path(__file__).resolve().parent.parent / "output"
OUTPUT_DIR.mkdir(exist_ok=True)

# Bundled caption fonts (OFL, redistributable). libass is pointed here via the
# subtitles filter `fontsdir=` so burned captions use these instead of falling
# back to a generic host sans. Family names: "Anton", "Bebas Neue".
FONTS_DIR = Path(__file__).resolve().parent.parent / "assets" / "fonts"

# Caption highlight colors (TikTok karaoke): inactive words white, the word
# currently being spoken pops to the accent color.
CAPTION_FILL = "#FFFFFF"
CAPTION_HIGHLIGHT = "#E8FF3A"

OUT_W = 1080
OUT_H = 1920
TOP_H = 720      # 3/8 of 1920
BOTTOM_H = 1200  # 5/8 of 1920
OUT_FPS = 30     # constant output frame rate (see fps-normalization note in render)

ASPECT_TOP = OUT_W / TOP_H        # 1.5  (3:2)
ASPECT_BOTTOM = OUT_W / BOTTOM_H  # 0.9  (9:10)

MAX_GROUP_WORDS = 3
MAX_GROUP_CHARS = 18


# ───────────────────────── encoder detection ─────────────────────────
# Auto-detect NVENC. Filter graph still runs on CPU; only the H.264 encode
# moves to GPU. Override with env var CLIPPER_ENCODER=libx264 to force CPU.
_ENCODER_CACHE: Optional[str] = None


def _detect_encoder() -> str:
    """Return 'h264_nvenc' if NVENC is available AND functional, else 'libx264'.
    Cached after first call."""
    global _ENCODER_CACHE
    if _ENCODER_CACHE is not None:
        return _ENCODER_CACHE
    override = os.environ.get("CLIPPER_ENCODER", "").strip().lower()
    if override in {"libx264", "h264_nvenc"}:
        _ENCODER_CACHE = override
        return _ENCODER_CACHE
    try:
        listed = subprocess.run(
            ["ffmpeg", "-hide_banner", "-encoders"],
            capture_output=True, text=True, timeout=5,
        )
        if "h264_nvenc" in listed.stdout:
            # Encoder is built in. Now confirm the driver/device actually works
            # by encoding 0.1s of a synthetic black source to null.
            # NVENC has a min frame size (≥ 145×97 on most GPUs); use 320×240
            # to stay safely above all NVIDIA generations.
            probe = subprocess.run(
                ["ffmpeg", "-hide_banner", "-loglevel", "error",
                 "-f", "lavfi", "-i", "color=black:s=320x240:d=0.1",
                 "-c:v", "h264_nvenc", "-f", "null", "-"],
                capture_output=True, text=True, timeout=10,
            )
            if probe.returncode == 0:
                _ENCODER_CACHE = "h264_nvenc"
                return _ENCODER_CACHE
    except Exception:
        pass
    _ENCODER_CACHE = "libx264"
    return _ENCODER_CACHE


def _encode_args() -> list[str]:
    """Encoder-specific ffmpeg args. NVENC uses VBR with constant-quality CQ
    target (visually similar to libx264 CRF). Both write yuv420p H.264."""
    enc = _detect_encoder()
    if enc == "h264_nvenc":
        return [
            "-c:v", "h264_nvenc",
            "-preset", "p5",       # p1=fastest … p7=slowest. p5 = balanced.
            "-rc", "vbr",
            "-cq", "23",           # ~ CRF 20 visually
            "-b:v", "0",
            "-pix_fmt", "yuv420p",
        ]
    return [
        "-c:v", "libx264",
        "-preset", "medium",
        "-crf", "20",
        "-pix_fmt", "yuv420p",
    ]


def to_ass_color(hex_rgb: str) -> str:
    """#RRGGBB -> &H00BBGGRR (ASS reverses RGB and prepends alpha)."""
    s = hex_rgb.lstrip("#")
    if len(s) != 6:
        s = "FFFFFF"
    r, g, b = s[0:2], s[2:4], s[4:6]
    return f"&H00{b}{g}{r}".upper()


def _slugify(name: str) -> str:
    s = re.sub(r"[^a-zA-Z0-9_-]+", "_", name.strip()) or "clip"
    return s[:80]


def _fmt_ass_time(t: float) -> str:
    if t < 0:
        t = 0
    h = int(t // 3600)
    m = int((t % 3600) // 60)
    s = t % 60
    return f"{h:d}:{m:02d}:{s:05.2f}"


def _group_words(words: list[Word]) -> list[dict]:
    """Greedy chunk into 1-3 word groups, max 18 chars total."""
    groups: list[dict] = []
    buf: list[Word] = []
    buf_chars = 0

    def flush():
        nonlocal buf, buf_chars
        if not buf:
            return
        text = " ".join(w.word for w in buf).strip()
        groups.append({
            "text": text,
            "start": buf[0].start,
            "end": buf[-1].end,
            # per-word timing kept so _build_ass can highlight the active word
            "words": [{"text": w.word, "start": w.start, "end": w.end} for w in buf],
        })
        buf = []
        buf_chars = 0

    for w in words:
        wlen = len(w.word)
        if buf and (len(buf) >= MAX_GROUP_WORDS or buf_chars + 1 + wlen > MAX_GROUP_CHARS):
            flush()
        buf.append(w)
        buf_chars = buf_chars + (1 if buf_chars else 0) + wlen
    flush()
    return groups


def _ass_escape(s: str) -> str:
    return s.replace("\\", "\\\\").replace("{", "\\{").replace("}", "\\}")


def _build_ass(groups: list[dict], font: str, size: int, caption_y_for) -> str:
    """`caption_y_for` is either an int (single y for all groups) or a callable
    taking a group's start time and returning the y to use. Per-group y enables
    caption repositioning when the layout switches between vstack and
    single-box mode (see layout-switch overlays in render()).

    TikTok-karaoke style: each word group is emitted as one Dialogue line per
    word time-slice; in each slice every word is shown but the word currently
    being spoken is recolored to the accent + bumped slightly in scale. Whisper
    per-word timestamps (kept in group["words"]) drive the slice boundaries.
    Fat outline + shadow so it reads over any footage.
    """
    primary = to_ass_color(CAPTION_FILL)
    highlight = to_ass_color(CAPTION_HIGHLIGHT)
    outline = to_ass_color("#000000")
    back = to_ass_color("#000000")

    header = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {OUT_W}
PlayResY: {OUT_H}
ScaledBorderAndShadow: yes
WrapStyle: 2

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Caption,{font},{size},{primary},{primary},{outline},{back},1,0,0,0,100,100,0,0,1,6,3,5,40,40,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""

    resolve_y = caption_y_for if callable(caption_y_for) else (lambda _t: caption_y_for)

    lines = []
    for g in groups:
        words = g.get("words") or [{"text": g["text"], "start": g["start"], "end": g["end"]}]
        y = int(resolve_y(g["start"]))
        pos = f"{{\\pos({OUT_W // 2},{y})}}"
        n = len(words)
        for j in range(n):
            seg_start = words[j]["start"]
            seg_end = words[j + 1]["start"] if j + 1 < n else g["end"]
            if seg_end <= seg_start:
                seg_end = seg_start + 0.05
            parts = []
            for k, wk in enumerate(words):
                t = _ass_escape(wk["text"]).upper()
                if k == j:
                    # active word: accent fill + slight pop, then reset to white/100%
                    parts.append(f"{{\\1c{highlight}\\fscx112\\fscy112}}{t}{{\\1c{primary}\\fscx100\\fscy100}}")
                else:
                    parts.append(t)
            text = pos + " ".join(parts)
            lines.append(
                f"Dialogue: 0,{_fmt_ass_time(seg_start)},{_fmt_ass_time(seg_end)},Caption,,0,0,0,,{text}"
            )
    return header + "\n".join(lines) + "\n"


# ───────────────────────── keyframe → ffmpeg expression ─────────────────────────

def _fmt_num(v: float) -> str:
    """Compact numeric format for ffmpeg expressions."""
    if abs(v - round(v)) < 1e-6:
        return str(int(round(v)))
    return f"{v:.4f}"


def _build_expr(keyframes: list[dict], key: str) -> str:
    """Build a piecewise ffmpeg expression in `t` (clip time) for one of
    the keyframe attributes ('x', 'y', 'w', or 'h').

    Per-keyframe `interp` mode determines the segment to the *next* keyframe:
      - 'hold'   → value is constant (v0) until the next keyframe — box stays put.
      - 'linear' → smoothly interpolate from v0 to v1 across the segment — smooth pan.
    Before the first keyframe, use the first value. After the last, the last value.
    """
    if len(keyframes) == 1:
        return _fmt_num(keyframes[0][key])

    last_val = _fmt_num(keyframes[-1][key])
    expr = last_val
    for i in range(len(keyframes) - 2, -1, -1):
        k0 = keyframes[i]
        k1 = keyframes[i + 1]
        t0, t1 = k0["t"], k1["t"]
        v0, v1 = k0[key], k1[key]
        mode = (k0.get("interp") or "hold").lower()
        # Never linear-interp towards a gap kf — its xywh are dummies; hold instead.
        if mode == "linear" and t1 > t0 + 1e-6 and not k1.get("gap"):
            segment = (
                f"({_fmt_num(v0)}+({_fmt_num(v1)}-{_fmt_num(v0)})"
                f"*(t-{_fmt_num(t0)})/({_fmt_num(t1)}-{_fmt_num(t0)}))"
            )
        else:
            # hold (or degenerate t1==t0 / next kf is gap): value is constant across this segment
            segment = _fmt_num(v0)
        expr = f"if(lt(t,{_fmt_num(t1)}),{segment},{expr})"
    t0 = keyframes[0]["t"]
    if t0 > 0:
        expr = f"if(lt(t,{_fmt_num(t0)}),{_fmt_num(keyframes[0][key])},{expr})"
    return expr


def _shift_keyframes(kfs: list[Keyframe], start: float) -> list[Keyframe]:
    """Re-base keyframes onto a new t=0 at `start` seconds of the source.

    Drops keyframes whose t > start except for the *last* one in that prefix
    (which becomes the anchor at t=0 — its value applies from the new start
    until the next kf). Kfs after `start` get their t shifted by -start.
    No-op for start <= 0.
    """
    if start <= 0 or not kfs:
        return kfs
    ordered = sorted(kfs, key=lambda k: k.t)
    pre = [k for k in ordered if k.t <= start]
    post = [k for k in ordered if k.t > start]
    out: list[Keyframe] = []
    if pre:
        out.append(pre[-1].model_copy(update={"t": 0.0}))
    for k in post:
        out.append(k.model_copy(update={"t": k.t - start}))
    return out


def _shift_words(words: list[Word], start: float, end: Optional[float]) -> list[Word]:
    """Drop words outside [start, end] and shift remaining onto new t=0.

    A word is dropped if it ends before `start` or begins at/after `end`.
    Partially-overlapping words are clipped to the range.
    """
    if (start <= 0 or start is None) and end is None:
        return words
    start = max(0.0, start or 0.0)
    out: list[Word] = []
    for w in words:
        if end is not None and w.start >= end:
            continue
        if w.end <= start:
            continue
        new_start = max(0.0, w.start - start)
        new_end = w.end - start
        if end is not None:
            new_end = min(new_end, end - start)
        if new_end <= new_start:
            continue
        out.append(Word(word=w.word, start=new_start, end=new_end))
    return out


# ───────────────────────── soundboard SFX (audio mix) ─────────────────────────
def _shift_sfx(sfx: list[SfxPlacement], start: float, end: Optional[float]) -> list[SfxPlacement]:
    """Re-base SFX placements onto the render sub-range (so filtergraph t=0 ==
    `start`). One-shots before `start` or at/after `end` are dropped; range
    placements are clipped to the window. No-op when there's no sub-range."""
    if not sfx:
        return sfx or []
    if (not start or start <= 0) and end is None:
        return sfx
    start = max(0.0, start or 0.0)
    out: list[SfxPlacement] = []
    for s in sfx:
        if s.kind == "range":
            t0 = max(float(s.t), start)
            t1 = float(s.t_end) if s.t_end is not None else (end if end is not None else t0)
            if end is not None:
                t1 = min(t1, end)
            if t1 <= t0:
                continue
            out.append(s.model_copy(update={"t": t0 - start, "t_end": t1 - start}))
        else:
            t = float(s.t)
            if t < start or (end is not None and t >= end):
                continue
            out.append(s.model_copy(update={"t": t - start}))
    return out


def _sanitize_keep(segs, dur: float):
    """Normalize KeepSegment list → sorted, clamped, merged (a,b) tuples. Drops
    sub-frame slivers and overlaps. Empty result = no trim (keep whole clip)."""
    raw = []
    for s in segs or []:
        a = float(getattr(s, "start", 0.0))
        b = float(getattr(s, "end", 0.0))
        a = max(0.0, a)
        if dur and dur > 0:
            b = min(b, dur)
        if b - a > 0.02:
            raw.append((a, b))
    raw.sort()
    merged: list[tuple[float, float]] = []
    for a, b in raw:
        if merged and a <= merged[-1][1] + 0.001:
            merged[-1] = (merged[-1][0], max(merged[-1][1], b))
        else:
            merged.append((a, b))
    return merged


def _shift_illustrations(picks, start, end):
    """Re-base full-frame cutaway windows onto the render sub-range, dropping or
    clipping windows outside [start, end]. Mirrors illustrator's helper."""
    if not picks:
        return picks or []
    if (not start or start <= 0) and end is None:
        return picks
    start = max(0.0, start or 0.0)
    out = []
    for p in picks:
        if end is not None and p.t_start >= end:
            continue
        if p.t_end <= start:
            continue
        ns = max(0.0, p.t_start - start)
        ne = p.t_end - start
        if end is not None:
            ne = min(ne, end - start)
        if ne <= ns:
            continue
        out.append(IllustrationPick(t_start=ns, t_end=ne, url=p.url,
                                    target=getattr(p, "target", "full") or "full",
                                    fit=getattr(p, "fit", "cover") or "cover"))
    return out


def _probe_has_audio(path: Path) -> bool:
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "a",
             "-show_entries", "stream=codec_type", "-of", "csv=p=0", str(path)],
            capture_output=True, text=True)
        return "audio" in (out.stdout or "")
    except Exception:  # noqa: BLE001
        return False


def _probe_duration(path: Path) -> float:
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "csv=p=0", str(path)],
            capture_output=True, text=True, check=True)
        return float((out.stdout or "0").strip() or 0.0)
    except Exception:  # noqa: BLE001
        return 0.0


_AFMT = "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo"


def _audio_inputs_and_graph(sfx, source_has_audio, out_dur, src_audio="0:a", first_sfx_index=1):
    """Build the audio side when SFX are placed. Returns (extra_input_args,
    filter_parts, amap). Each usable SFX becomes one extra ffmpeg input.
    Returns ([], [], None) when there are no usable SFX — the caller then keeps
    the plain `-map 0:a?` behavior (zero change for normal renders).

    Mix = the clip's own audio (or silence if the source has none) + every SFX,
    each scaled by its volume and delayed to its start. `amix normalize=0` keeps
    levels as-is (the user balances via the per-placement volume); range SFX are
    trimmed to their window and looped at the demux level (-stream_loop) when
    asked. `duration=first` bounds the mix to the base track."""
    usable = []
    for s in (sfx or []):
        p = soundboard.path_for(s.sound_id)
        if p:
            usable.append((s, p))
    if not usable:
        return [], [], None

    parts: list[str] = []
    if source_has_audio:
        parts.append(f"[{src_audio}]{_AFMT}[abase]")
    else:
        parts.append(f"anullsrc=channel_layout=stereo:sample_rate=48000,"
                     f"atrim=duration={max(0.1, out_dur):.3f}[abase]")
    labels = ["abase"]

    inputs: list[str] = []
    idx = first_sfx_index
    for j, (s, p) in enumerate(usable):
        is_range = (s.kind == "range" and s.t_end is not None)
        if is_range and bool(s.loop):
            inputs += ["-stream_loop", "-1"]   # loop at the demux level
        inputs += ["-i", str(p)]
        f: list[str] = []
        if is_range:
            dur = max(0.05, float(s.t_end) - float(s.t))
            f.append(f"atrim=duration={dur:.3f}")
            f.append("asetpts=PTS-STARTPTS")
        vol = max(0.0, float(s.volume if s.volume is not None else 1.0))
        f.append(f"volume={vol:.3f}")
        f.append(_AFMT)
        delay = int(round(max(0.0, float(s.t)) * 1000))
        if delay > 0:
            f.append(f"adelay={delay}:all=1")
        parts.append(f"[{idx}:a]" + ",".join(f) + f"[sfx{j}]")
        labels.append(f"sfx{j}")
        idx += 1

    mix = "".join(f"[{lbl}]" for lbl in labels)
    parts.append(f"{mix}amix=inputs={len(labels)}:normalize=0:duration=first[aout]")
    return inputs, parts, "[aout]"


def _normalize_keyframes(keyframes: list[Keyframe]) -> list[dict]:
    """Sort by t, clamp negatives, ensure min size, normalize interp + fit + gap."""
    cleaned: list[dict] = []
    for k in sorted(keyframes, key=lambda kk: kk.t):
        cleaned.append({
            "t": max(0.0, float(k.t)),
            "x": max(0.0, float(k.x)),
            "y": max(0.0, float(k.y)),
            "w": max(2.0, float(k.w)),
            "h": max(2.0, float(k.h)),
            "interp": (getattr(k, "interp", None) or "hold").lower(),
            "fit": (getattr(k, "fit", None) or "cover").lower(),
            "gap": bool(getattr(k, "gap", False)),
        })
    return cleaned


def _segment_enable_expr(kfs: list[dict], pred) -> str:
    """Build an ffmpeg `enable=` expression matching segments where `pred(kf)`
    returns true. Each kf's segment runs from its t until the next kf's t
    (last kf extends forever via a large sentinel). Returns "0" if no match."""
    parts: list[str] = []
    for i, k in enumerate(kfs):
        if not pred(k):
            continue
        t0 = k["t"]
        t1 = kfs[i + 1]["t"] if i + 1 < len(kfs) else 1e9
        parts.append(f"between(t,{_fmt_num(t0)},{_fmt_num(t1)})")
    return "+".join(parts) if parts else "0"


def _blur_enable_expr(kfs: list[dict]) -> str:
    return _segment_enable_expr(kfs, lambda k: k["fit"] == "blur_pad" and not k["gap"])


def _blur_bg_filters(out_w: int, out_h: int) -> str:
    """Cover-fill + blur for a blur_pad background, computed on a 1/4-scale copy
    (~16× fewer pixels than blurring at full slot res) then scaled back up.

    `gblur` has no CUDA path, so a full-resolution blur is the single heaviest CPU
    filter in the whole graph (and the graph has ~15-20 of them per clip). Blurring
    a 1/4 copy then upscaling gives a visually ~identical soft background for a
    fraction of the cost — the upscale interpolation does most of the smoothing,
    so a small sigma is enough. Input = the already-cropped box; output = out_w×out_h.
    DW:DH keep the slot aspect exactly (out_w/out_h are multiples of 4 here) so the
    upscale is a straight stretch with no distortion."""
    dw, dh = max(2, out_w // 4), max(2, out_h // 4)
    return (
        f"scale={dw}:{dh}:force_original_aspect_ratio=increase,crop={dw}:{dh},"
        f"gblur=sigma=8:steps=1,scale={out_w}:{out_h},eq=brightness=-0.08"
    )


def _mask_keyframes_to_intervals(keyframes: list, intervals: list[tuple[float, float]]) -> list:
    """Return a copy of `keyframes` where every segment that does NOT overlap any
    of `intervals` is forced to a gap (cheap black).

    Used for the full-frame overlay paths (b1full/b2full): they're only DISPLAYED
    during those intervals (`overlay=enable=`), so the hidden segments don't need
    the expensive cover/blur work — turning them into gaps makes the segmented crop
    chain skip them entirely, with zero visual change. Conservative: a segment is
    kept real if it overlaps ANY interval (no splitting), so a partially-shown
    segment is never dropped."""
    if not intervals:
        return keyframes
    kfs = sorted(keyframes, key=lambda kk: kk.t)
    SENTINEL = 1e9
    out = []
    for i, k in enumerate(kfs):
        t0 = float(k.t)
        t1 = float(kfs[i + 1].t) if i + 1 < len(kfs) else SENTINEL
        shown = any(a < t1 and t0 < b for (a, b) in intervals)  # interval overlap
        if shown or bool(getattr(k, "gap", False)):
            out.append(k)
        else:
            out.append(k.model_copy(update={"gap": True}))
    return out


def _layout_switch_intervals(kfs1: list[dict], kfs2: list[dict]) -> tuple[list[tuple[float, float]], list[tuple[float, float]]]:
    """Find time intervals where ONLY one box is active (real, not gap).

    Returns (b1_only, b2_only). Each list is [(t_start, t_end), ...] of merged
    intervals. Used by render() to overlay a full-frame version of the active
    box on top of the vstacked composite during these times — so a gap in one
    box reverts the layout to single-box mode for that segment rather than
    rendering a black slot.
    """
    SENTINEL = 1e9

    def segments(kfs: list[dict]) -> list[tuple[float, float, bool]]:
        out: list[tuple[float, float, bool]] = []
        for i, k in enumerate(kfs):
            t0 = k["t"]
            t1 = kfs[i + 1]["t"] if i + 1 < len(kfs) else SENTINEL
            out.append((t0, t1, bool(k.get("gap"))))
        return out

    segs1 = segments(kfs1)
    segs2 = segments(kfs2)
    if not segs1 or not segs2:
        return [], []

    def state_at(segs: list[tuple[float, float, bool]], t: float) -> Optional[bool]:
        for t0, t1, g in segs:
            if t0 <= t < t1:
                return g
        # t < first kf.t — treat as "real" since _build_expr holds first kf value before its t
        return False

    boundaries = sorted(set(
        [s[0] for s in segs1] + [s[1] for s in segs1]
        + [s[0] for s in segs2] + [s[1] for s in segs2]
    ))

    b1_only: list[tuple[float, float]] = []
    b2_only: list[tuple[float, float]] = []
    for i in range(len(boundaries) - 1):
        t0, t1 = boundaries[i], boundaries[i + 1]
        if t1 - t0 < 1e-6:
            continue
        mid = (t0 + t1) / 2
        g1 = state_at(segs1, mid) or False
        g2 = state_at(segs2, mid) or False
        if not g1 and g2:
            b1_only.append((t0, t1))
        elif g1 and not g2:
            b2_only.append((t0, t1))

    def merge(ivs: list[tuple[float, float]]) -> list[tuple[float, float]]:
        if not ivs:
            return []
        out = [ivs[0]]
        for t0, t1 in ivs[1:]:
            if t0 <= out[-1][1] + 1e-6:
                out[-1] = (out[-1][0], t1)
            else:
                out.append((t0, t1))
        return out

    return merge(b1_only), merge(b2_only)


def _enable_from_intervals(intervals: list[tuple[float, float]]) -> str:
    if not intervals:
        return "0"
    return "+".join(f"between(t,{_fmt_num(t0)},{_fmt_num(t1)})" for t0, t1 in intervals)


def _crop_chain_segmented(input_label: str, kfs: list[dict],
                          out_w: int, out_h: int, out_label: str) -> list[str]:
    """Render a box whose SIZE changes between keyframes.

    ffmpeg's `crop` evaluates w/h ONCE at init (only x/y animate per-frame), so an
    animated-SIZE box (zoom) can't be a single expression-crop — the size would
    stay stuck at the init value. Instead we crop each segment with a LITERAL
    (constant) box and composite the segments with `overlay=enable=` switching.
    Per-keyframe fit (cover/blur_pad) and gap segments are handled here too.

    Size is stepped per segment (no smooth interpolation across a zoom — crop
    can't do per-frame w/h); position-only animation uses the expression path.
    """
    cover_filters = (
        f"scale={out_w}:{out_h}:force_original_aspect_ratio=increase,crop={out_w}:{out_h}"
    )
    n = len(kfs)
    real_idx = [i for i, k in enumerate(kfs) if not k["gap"]]
    parts: list[str] = []
    if not real_idx:  # all-gap → black slot (bounded by source length)
        k = kfs[0]
        parts.append(
            f"[{input_label}]crop={int(k['w'])}:{int(k['h'])}:{int(k['x'])}:{int(k['y'])},"
            f"{cover_filters},setsar=1,eq=brightness=-1.0:contrast=0[{out_label}]"
        )
        return parts

    # Group consecutive real kfs into RUNS of identical w/h. crop's w/h are
    # init-locked, but WITHIN a constant-size run x/y CAN animate per-frame — so
    # a run of ≥2 same-size kfs is emitted as ONE expression-crop (x/y via
    # _build_expr, which honors each kf's hold/linear interp) instead of one
    # literal crop per kf. This keeps a Phase-1 size-locked center-pan SMOOTH
    # even when the box ALSO has a differently-sized static segment (which is
    # what flips the box onto this segmented path). Size still steps BETWEEN
    # runs (crop can't do per-frame w/h). A lone kf stays a literal crop.
    def _run_len(start: int) -> int:
        wh = (round(kfs[real_idx[start]]["w"], 1), round(kfs[real_idx[start]]["h"], 1))
        length = 1
        while (start + length < len(real_idx)
               # must be ADJACENT in the original kf array (no gap kf between them,
               # or the gap's black window would get covered by the merged crop)
               and real_idx[start + length] == real_idx[start + length - 1] + 1
               and (round(kfs[real_idx[start + length]]["w"], 1),
                    round(kfs[real_idx[start + length]]["h"], 1)) == wh):
            length += 1
        return length

    runs: list[list[int]] = []   # each run = list of real_idx positions
    p = 0
    while p < len(real_idx):
        rl = _run_len(p)
        runs.append(list(range(p, p + rl)))
        p += rl

    splits = [f"{out_label}_sp{j}" for j in range(len(runs))]
    parts.append(f"[{input_label}]split={len(runs)}{''.join('[' + s + ']' for s in splits)}")

    seg_info: list[tuple[str, float, float]] = []
    for j, run in enumerate(runs):
        i0 = real_idx[run[0]]
        k = kfs[i0]
        if len(run) > 1:
            # constant-size run → animate x/y per-frame, w/h literal & constant.
            run_kfs = [kfs[real_idx[r]] for r in run]
            crop = (f"crop={int(k['w'])}:{int(k['h'])}"
                    f":x='{_build_expr(run_kfs, 'x')}':y='{_build_expr(run_kfs, 'y')}'")
        else:
            crop = f"crop={int(k['w'])}:{int(k['h'])}:{int(k['x'])}:{int(k['y'])}"
        seg = f"{out_label}_seg{j}"
        if k["fit"] == "blur_pad":
            parts.append(f"[{splits[j]}]{crop},setsar=1,split=2[{seg}a][{seg}b]")
            parts.append(f"[{seg}a]{_blur_bg_filters(out_w, out_h)}[{seg}bg]")
            parts.append(f"[{seg}b]scale={out_w}:{out_h}:force_original_aspect_ratio=decrease[{seg}fg]")
            parts.append(f"[{seg}bg][{seg}fg]overlay=(W-w)/2:(H-h)/2,setsar=1[{seg}]")
        else:
            parts.append(f"[{splits[j]}]{crop},{cover_filters},setsar=1[{seg}]")
        # First keyframe extends back to t=0 (matches _build_expr "hold before first kf").
        t0 = 0.0 if i0 == 0 else k["t"]
        last_i = real_idx[run[-1]]
        t1 = kfs[last_i + 1]["t"] if last_i + 1 < n else 1e9
        seg_info.append((seg, t0, t1))

    parts.append(f"color=c=black:s={out_w}x{out_h}:r=30[{out_label}_base]")
    cur = f"{out_label}_base"
    for idx, (seg, t0, t1) in enumerate(seg_info):
        nxt = out_label if idx == len(seg_info) - 1 else f"{out_label}_ov{idx}"
        parts.append(
            f"[{cur}][{seg}]overlay=enable='between(t,{_fmt_num(t0)},{_fmt_num(t1)})':shortest=1[{nxt}]"
        )
        cur = nxt
    return parts


def _crop_chain(input_label: str, keyframes: list[Keyframe],
                out_w: int, out_h: int, out_label: str) -> list[str]:
    """Build the filter chain(s) that turn a per-frame source crop into a
    fixed `out_w × out_h` slot output. Returns a list of filter strings —
    caller joins with `;`.

    Fit mode is per-keyframe (each kf's `fit` applies for the segment starting
    at that kf). When all kfs share the same fit, a single chain is used.
    When fits are mixed, both cover and blur_pad branches are computed and a
    final overlay with `enable=` switches between them per segment.

    `gap=True` keyframes mark empty segments — the slot renders as black for
    those segments via a final `color=black` overlay with `enable=`.

    SIZE animation gotcha: ffmpeg's crop w/h are init-locked (only x/y animate).
    So if the box changes SIZE between keyframes we route to
    `_crop_chain_segmented` (literal per-segment crops). The expression path
    below is only used for a single keyframe or for constant-SIZE multi-kf
    (where x/y still pan smoothly per-frame and the constant w/h is fine).
    """
    kfs = _normalize_keyframes(keyframes)

    # crop w/h can't animate per-frame → if the box SIZE varies across real
    # keyframes, render per-segment with literal crops instead of expressions.
    real = [k for k in kfs if not k["gap"]]
    size_varies = len(kfs) > 1 and len({(round(k["w"], 1), round(k["h"], 1)) for k in real}) > 1
    if size_varies:
        return _crop_chain_segmented(input_label, kfs, out_w, out_h, out_label)

    if len(kfs) == 1:
        k = kfs[0]
        crop = f"crop={int(k['w'])}:{int(k['h'])}:{int(k['x'])}:{int(k['y'])}"
    else:
        w_e = _build_expr(kfs, "w")
        h_e = _build_expr(kfs, "h")
        x_e = _build_expr(kfs, "x")
        y_e = _build_expr(kfs, "y")
        crop = f"crop=w='{w_e}':h='{h_e}':x='{x_e}':y='{y_e}'"

    # Distinguish gap from real segments. Fit detection ignores gap kfs.
    real_fits = {k["fit"] for k in kfs if not k["gap"]}
    has_blur = "blur_pad" in real_fits
    has_cover = "cover" in real_fits or not real_fits
    has_gap = any(k["gap"] for k in kfs)

    cover_filters = (
        f"scale={out_w}:{out_h}:force_original_aspect_ratio=increase,"
        f"crop={out_w}:{out_h}"
    )

    # Inner = where the box composite (cover/blur/mixed) terminates. If there are
    # gap segments, we overlay black on top of this with enable= → out_label.
    inner = f"{out_label}_box" if has_gap else out_label

    parts: list[str] = []

    # Single-mode fast paths for the box composite
    if not has_blur:
        parts.append(f"[{input_label}]{crop},{cover_filters},setsar=1[{inner}]")
    elif not has_cover:
        parts.append(f"[{input_label}]{crop},setsar=1,split=2[{out_label}_a][{out_label}_b]")
        parts.append(f"[{out_label}_a]{_blur_bg_filters(out_w, out_h)}[{out_label}_bg]")
        parts.append(f"[{out_label}_b]scale={out_w}:{out_h}:force_original_aspect_ratio=decrease[{out_label}_fg]")
        parts.append(f"[{out_label}_bg][{out_label}_fg]overlay=(W-w)/2:(H-h)/2[{inner}]")
    else:
        # Mixed — build cover + blur branches, switch with overlay enable=
        cov = f"{out_label}_cov"
        blr = f"{out_label}_blr"
        enable_expr = _blur_enable_expr(kfs)
        parts.append(f"[{input_label}]{crop},setsar=1,split=3[{out_label}_s1][{out_label}_s2][{out_label}_s3]")
        parts.append(f"[{out_label}_s1]{cover_filters}[{cov}]")
        parts.append(f"[{out_label}_s2]{_blur_bg_filters(out_w, out_h)}[{out_label}_bg]")
        parts.append(f"[{out_label}_s3]scale={out_w}:{out_h}:force_original_aspect_ratio=decrease[{out_label}_fg]")
        parts.append(f"[{out_label}_bg][{out_label}_fg]overlay=(W-w)/2:(H-h)/2[{blr}]")
        parts.append(f"[{cov}][{blr}]overlay=enable='{enable_expr}'[{out_label}_o]")
        parts.append(f"[{out_label}_o]setsar=1[{inner}]")

    # Gap segments → overlay solid black on top during gap times
    if has_gap:
        gap_expr = _segment_enable_expr(kfs, lambda k: k["gap"])
        # shortest=1 stops the overlay when the bounded video stream ends —
        # without it the infinite `color=` source makes output run forever.
        parts.append(f"color=c=black:s={out_w}x{out_h}:r=30[{out_label}_blk]")
        parts.append(f"[{inner}][{out_label}_blk]overlay=enable='{gap_expr}':shortest=1[{out_label}]")

    return parts


def _probe_dims(path: Path) -> tuple[int, int]:
    cmd = ["ffprobe", "-v", "error", "-select_streams", "v:0",
           "-show_entries", "stream=width,height", "-of", "json", str(path)]
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, check=True)
        s = json.loads(out.stdout).get("streams", [{}])[0]
        return int(s.get("width", 0)), int(s.get("height", 0))
    except Exception:
        return 0, 0


def _clamp_kfs(kfs: Optional[list[Keyframe]], w: int, h: int) -> Optional[list[Keyframe]]:
    """Defense-in-depth: cap every keyframe's box inside the source frame so an
    off-frame box (from a direct API/batch call) can't make ffmpeg's crop fail.
    No-op for already-in-bounds boxes."""
    if not kfs or w <= 0 or h <= 0:
        return kfs
    out: list[Keyframe] = []
    for k in kfs:
        x = min(max(0.0, float(k.x)), max(0.0, w - 2.0))
        y = min(max(0.0, float(k.y)), max(0.0, h - 2.0))
        cw = max(2.0, min(float(k.w), w - x))
        ch = max(2.0, min(float(k.h), h - y))
        out.append(k.model_copy(update={"x": x, "y": y, "w": cw, "h": ch}))
    return out


# ───────────────────────── main render ─────────────────────────

def _prepend_intro(main_path: Path, job_id: str, intro: IntroConfig) -> Path:
    """Second pass: prepend the intro card (temp/{job}_intro.png) — shown for
    `intro.duration`s with a Piper voiceover of `intro.text` — then transition
    into `main_path`. Replaces main_path in place. No-op if the image is missing."""
    intro_png = TEMP_DIR / f"{job_id}_intro.png"
    if not intro_png.exists():
        return main_path

    # Voiceover (optional, best-effort).
    voice_wav = None
    if getattr(intro, "voice", True) and (intro.text or "").strip() and tts.enabled():
        cand = TEMP_DIR / f"{job_id}_intro.wav"
        try:
            tts.synthesize(intro.text, cand, engine=getattr(intro, "engine", "gtts"))
            voice_wav = cand
        except Exception as e:  # noqa: BLE001
            print(f"[RENDER] TTS failed (intro stays silent): {e}")

    vdur = _probe_duration(voice_wav) if voice_wav else 0.0
    intro_dur = max(float(intro.duration or 4.0), (vdur + 0.4) if vdur else 0.0, 1.0)
    main_dur = _probe_duration(main_path) or 1.0
    main_has_audio = _probe_has_audio(main_path)
    trans = (intro.transition or "fade")
    if trans != "cut" and trans not in _XFADE_OK:
        trans = "fade"
    # crumple gets a longer window (more frames → smoother caving); others 0.6s.
    xf_cap = 0.9 if trans == "crumple" else 0.6
    xf = 0.0 if trans == "cut" else min(xf_cap, intro_dur * 0.5, main_dur * 0.5)

    inputs = ["-loop", "1", "-t", f"{intro_dur:.3f}", "-i", str(intro_png)]
    if voice_wav:
        inputs += ["-i", str(voice_wav)]
    inputs += ["-i", str(main_path)]
    main_idx = 2 if voice_wav else 1

    # Paper-crumple SFX layered at the transition moment — only for the crumple wipe.
    crumple_wav = FONTS_DIR.parent / "sfx" / "crumple.wav"
    use_crumple_sfx = (trans == "crumple" and crumple_wav.exists())
    crumple_idx = None
    if use_crumple_sfx:
        inputs += ["-i", str(crumple_wav)]
        crumple_idx = main_idx + 1

    af = "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo"
    p: list[str] = []
    p.append(f"[0:v]scale={OUT_W}:{OUT_H},setsar=1,fps=30,format=yuv420p[iv]")
    p.append(f"[{main_idx}:v]scale={OUT_W}:{OUT_H},setsar=1,fps=30,format=yuv420p[mv]")
    if voice_wav:
        p.append(f"[1:a]aresample=48000,apad=whole_dur={intro_dur:.3f},atrim=0:{intro_dur:.3f},{af}[ia]")
    else:
        p.append(f"anullsrc=channel_layout=stereo:sample_rate=48000,atrim=0:{intro_dur:.3f},{af}[ia]")
    if main_has_audio:
        p.append(f"[{main_idx}:a]aresample=48000,{af}[ma]")
    else:
        p.append(f"anullsrc=channel_layout=stereo:sample_rate=48000,atrim=0:{main_dur:.3f},{af}[ma]")
    if trans == "cut":
        p.append("[iv][mv]concat=n=2:v=1:a=0[v]")
        p.append("[ia][ma]concat=n=2:v=0:a=1[a]")
    else:
        off = max(0.0, intro_dur - xf)
        if trans == "crumple":
            xv = (f"[iv][mv]xfade=transition=custom:duration={xf:.3f}:"
                  f"offset={off:.3f}:expr='{_CRUMPLE_EXPR}'[v]")
        else:
            xv = f"[iv][mv]xfade=transition={trans}:duration={xf:.3f}:offset={off:.3f}[v]"
        p.append(xv)
        if use_crumple_sfx:
            off_ms = int(off * 1000)
            p.append(f"[ia][ma]acrossfade=d={xf:.3f}[axf]")
            p.append(f"[{crumple_idx}:a]adelay={off_ms}|{off_ms},volume=0.55,{af}[csfx]")
            p.append("[axf][csfx]amix=inputs=2:normalize=0:duration=first[a]")
        else:
            p.append(f"[ia][ma]acrossfade=d={xf:.3f}[a]")

    tmp_out = TEMP_DIR / f"{job_id}_final.mp4"
    cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
           *(["-hwaccel", "cuda"] if _detect_encoder() == "h264_nvenc" else []),
           *inputs, "-filter_complex", ";".join(p),
           "-map", "[v]", "-map", "[a]", *_encode_args(),
           "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", str(tmp_out)]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(f"intro pass failed:\n{proc.stderr}")
    tmp_out.replace(main_path)
    return main_path


def _run_render(cmd: list[str], progress_cb: Optional[Callable[[float], None]], total_dur: float) -> None:
    """Run the ffmpeg render. With a progress_cb, stream `-progress` so the caller
    gets a 0..1 fraction live; otherwise a plain blocking run. Raises on non-zero
    exit with the captured stderr (same contract as the old subprocess.run)."""
    if not progress_cb or not total_dur or total_dur <= 0:
        proc = subprocess.run(cmd, capture_output=True, text=True)
        if proc.returncode != 0:
            raise RuntimeError(f"ffmpeg render failed:\n{proc.stderr}")
        return
    # ffmpeg writes machine-readable progress blocks to stdout via `-progress pipe:1`.
    pcmd = cmd[:-1] + ["-progress", "pipe:1", "-nostats", cmd[-1]]
    proc = subprocess.Popen(pcmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        for line in proc.stdout:                       # blocks until each block flushes
            line = line.strip()
            # `out_time_us`/`out_time_ms` are BOTH microseconds in ffmpeg (historical
            # quirk) → /1e6 = seconds of OUTPUT produced so far.
            if line.startswith("out_time_us=") or line.startswith("out_time_ms="):
                val = line.split("=", 1)[1].strip()
                if val.isdigit():
                    try:
                        progress_cb(max(0.0, min(0.999, (int(val) / 1_000_000.0) / total_dur)))
                    except Exception:  # noqa: BLE001 — progress must never break the render
                        pass
            elif line == "progress=end":
                break
    finally:
        stderr = proc.stderr.read() if proc.stderr else ""
        proc.wait()
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg render failed:\n{stderr}")
    try:
        progress_cb(1.0)
    except Exception:  # noqa: BLE001
        pass


def render(
    job_id: str,
    source_path: Path,
    title: str,
    box1: Optional[list[Keyframe]],
    box2: Optional[list[Keyframe]],
    words: list[Word],
    caption_font: str = "Bricolage Grotesque",
    caption_size: int = 64,
    render_start: Optional[float] = None,
    render_end: Optional[float] = None,
    sfx: Optional[list[SfxPlacement]] = None,
    illustrations: Optional[list[IllustrationPick]] = None,
    keep_segments: Optional[list[KeepSegment]] = None,
    intro: Optional[IntroConfig] = None,
    progress_cb: Optional[Callable[[float], None]] = None,
) -> dict:
    if not box1 and not box2:
        raise ValueError("at least one of box1/box2 must be provided")

    # Multi-segment KEEP trim (drop the gaps). Probe duration once for clamping +
    # the SFX silent-base. When keep windows are set they OVERRIDE the single
    # render sub-range: the whole clip is composed (so crop/caption/SFX/cutaway
    # stay correct), then `select`/`aselect` drops everything outside the windows.
    src_dur = _probe_duration(source_path)
    keep = _sanitize_keep(keep_segments, src_dur)

    # Normalize sub-range. Both sides optional. Invalid range = ignored.
    rs = max(0.0, float(render_start)) if render_start is not None else 0.0
    re_ = float(render_end) if render_end is not None else None
    if re_ is not None and re_ <= rs:
        re_ = None
        rs = 0.0  # ignore — user passed nonsense
    if keep:
        rs, re_ = 0.0, None  # keep-trim handles all trimming; ignore the sub-range

    # Re-base keyframes and words to the sub-range so t=0 in filtergraph
    # aligns with rs. Done BEFORE building filter expressions.
    if rs > 0 or re_ is not None:
        if box1:
            box1 = _shift_keyframes(box1, rs)
        if box2:
            box2 = _shift_keyframes(box2, rs)
        if words:
            words = _shift_words(words, rs, re_)
        sfx = _shift_sfx(sfx, rs, re_)
        illustrations = _shift_illustrations(illustrations, rs, re_)

    # Defense-in-depth: clamp boxes inside the actual source frame (no-op for
    # valid boxes; prevents an off-frame crop from crashing ffmpeg).
    _sw, _sh = _probe_dims(source_path)
    box1 = _clamp_kfs(box1, _sw, _sh)
    box2 = _clamp_kfs(box2, _sw, _sh)

    filename = f"{_slugify(title)}_{job_id}.mp4"
    output_path = OUTPUT_DIR / filename

    # Compute layout-switch intervals upfront so captions can also reposition.
    both = bool(box1) and bool(box2)
    b1_only: list[tuple[float, float]] = []
    b2_only: list[tuple[float, float]] = []
    if both:
        b1_only, b2_only = _layout_switch_intervals(
            _normalize_keyframes(box1), _normalize_keyframes(box2)
        )
    single_intervals = b1_only + b2_only

    def _caption_y_for(t: float) -> int:
        # Single-box layout for the whole clip → center. Two-box vstack →
        # slot boundary, except when a layout-switch interval covers this
        # caption time, in which case it's effectively single-mode here too.
        if not both:
            return OUT_H // 2
        for t0, t1 in single_intervals:
            if t0 <= t < t1:
                return OUT_H // 2
        return TOP_H

    # Build ASS subtitles
    groups = _group_words(words) if words else []
    ass_text = _build_ass(groups, caption_font, caption_size, _caption_y_for)
    ass_path = source_path.parent / f"{job_id}.ass"
    ass_path.write_text(ass_text, encoding="utf-8")

    # Download ONLY the picked illustration images (deduped by URL). Each is a
    # full-frame 9:16 cutaway overlaid on the composite during its window.
    img_inputs: list[tuple[Path, IllustrationPick]] = []
    _seen: dict[str, Path] = {}
    for p in sorted(illustrations or [], key=lambda x: x.t_start):
        if not p.url:
            continue
        if p.url not in _seen:
            _seen[p.url] = pexels.download_pick(job_id, p.url)
        img_inputs.append((_seen[p.url], p))

    # Build filter_complex.
    # Single-box mode fills the entire 1080×1920 frame (full focus on that box).
    # Two-box mode uses the 3/8 + 5/8 vstack split.
    parts: list[str] = []
    if both:
        parts.extend(_crop_chain("0:v", box1, OUT_W, TOP_H, "top"))
        parts.extend(_crop_chain("0:v", box2, OUT_W, BOTTOM_H, "bot"))
        parts.append("[top][bot]vstack=inputs=2[stacked]")
        last = "stacked"

        # Per-segment layout switching: at times where only one box has real
        # content (the other is gap), overlay that box's full-frame version on
        # top of the vstacked composite. Without this, gap segments leave a
        # black slot — but the user's intent is "treat this like single-box
        # mode for this stretch". (b1_only/b2_only computed above for captions.)
        if b1_only:
            # b1full is only displayed during b1_only — mask the rest to gaps so the
            # full-res crop/blur work is skipped for segments that never show fullscreen.
            parts.extend(_crop_chain("0:v", _mask_keyframes_to_intervals(box1, b1_only), OUT_W, OUT_H, "b1full"))
            parts.append(
                f"[{last}][b1full]overlay=enable='{_enable_from_intervals(b1_only)}':shortest=1[sw1]"
            )
            last = "sw1"
        if b2_only:
            parts.extend(_crop_chain("0:v", _mask_keyframes_to_intervals(box2, b2_only), OUT_W, OUT_H, "b2full"))
            parts.append(
                f"[{last}][b2full]overlay=enable='{_enable_from_intervals(b2_only)}':shortest=1[sw2]"
            )
            last = "sw2"
    elif box1:
        parts.extend(_crop_chain("0:v", box1, OUT_W, OUT_H, "stacked"))
        last = "stacked"
    else:
        parts.extend(_crop_chain("0:v", box2, OUT_W, OUT_H, "stacked"))
        last = "stacked"

    # Full-frame illustration cutaways: overlay each picked image over the WHOLE
    # composite during its [t_start,t_end] window (the video shows through
    # before/after via eof_action=pass). Input 0 = video; images are inputs 1..N.
    for i, (_p, pick) in enumerate(img_inputs):
        in_idx = i + 1
        tgt = getattr(pick, "target", "full") or "full"
        if tgt == "box1":      # top slot
            W, H, x, y = OUT_W, TOP_H, 0, 0
        elif tgt == "box2":    # bottom slot
            W, H, x, y = OUT_W, BOTTOM_H, 0, TOP_H
        else:                  # full frame
            W, H, x, y = OUT_W, OUT_H, 0, 0
        if (getattr(pick, "fit", "cover") or "cover") == "blur":
            # contained image + blurred-cover pad filling the target rect
            parts.append(
                f"[{in_idx}:v]split=2[ia{i}][ib{i}];"
                f"[ia{i}]{_blur_bg_filters(W, H)}[ibg{i}];"
                f"[ib{i}]scale={W}:{H}:force_original_aspect_ratio=decrease,setsar=1[ifg{i}];"
                f"[ibg{i}][ifg{i}]overlay=(W-w)/2:(H-h)/2[ill{i}]"
            )
        else:                  # cover: scale-cover + crop to the target rect
            parts.append(
                f"[{in_idx}:v]scale={W}:{H}:force_original_aspect_ratio=increase,"
                f"crop={W}:{H},setsar=1[ill{i}]"
            )
        nxt = f"bil{i}"
        parts.append(
            f"[{last}][ill{i}]overlay=x={x}:y={y}:"
            f"enable='between(t,{_fmt_num(pick.t_start)},{_fmt_num(pick.t_end)})':eof_action=pass[{nxt}]"
        )
        last = nxt

    # Normalize to a constant frame rate before captions / keep-trim. The crop
    # chains mix sources at DIFFERENT rates — the segmented (size-varying) path
    # builds its slot on a `color` base at OUT_FPS, while the expression / blur
    # path follows the source rate. A two-box vstack of, say, a 30 fps top and a
    # 60 fps bottom yields a variable-frame-rate composite; the keep-trim
    # `select='between(t,…)',setpts=…` then sees inconsistent timestamps and can
    # drop EVERY video frame (audio survives → an all-black "video"). One fps
    # pass here gives a clean CFR stream for both the subtitle burn and select.
    parts.append(f"[{last}]fps={OUT_FPS}[vfps]")
    last = "vfps"

    # Subtitle path escape — Windows drive letters break filter parsing
    ass_path_escaped = str(ass_path).replace("\\", "/").replace(":", "\\:")
    fonts_escaped = str(FONTS_DIR).replace("\\", "/").replace(":", "\\:")
    if groups:
        # fontsdir → libass uses the bundled Anton/Bebas Neue instead of a
        # generic host-font fallback (which made captions look plain).
        parts.append(f"[{last}]subtitles={ass_path_escaped}:fontsdir={fonts_escaped}[outv]")
        vmap = "[outv]"
    else:
        vmap = f"[{last}]"

    # Soundboard SFX → audio mix (only when sounds are placed; otherwise the
    # plain optional source-audio mapping is kept, i.e. zero change).
    has_audio = _probe_has_audio(source_path)
    out_dur = (re_ - rs) if re_ is not None else (max(0.0, src_dur - rs) if src_dur > 0 else 0.0)
    sfx_inputs, sfx_parts, amap = _audio_inputs_and_graph(
        sfx, has_audio, out_dur, first_sfx_index=1 + len(img_inputs))
    if sfx_parts:
        parts.extend(sfx_parts)
    audio_map = amap or "0:a?"

    # Multi-segment KEEP trim — applied at the very END so all the time-based
    # composition above (crop / caption / SFX / cutaway) stays correct; then the
    # gaps are dropped and the kept windows concatenated (select/aselect re-time).
    if keep:
        kexpr = "+".join(f"between(t,{_fmt_num(a)},{_fmt_num(b)})" for a, b in keep)
        parts.append(f"{vmap}select='{kexpr}',setpts=N/FRAME_RATE/TB[vtrim]")
        vmap = "[vtrim]"
        abase = amap or ("[0:a]" if has_audio else None)
        if abase:
            parts.append(f"{abase}aselect='{kexpr}',asetpts=N/SR/TB[atrim]")
            audio_map = "[atrim]"

    filter_complex = ";".join(parts)

    # Input-side seek (-ss) + duration (-t) when a sub-range is set. With -ss
    # before -i ffmpeg resets the filter graph's `t` to 0 at the seek point,
    # which is why we pre-shift keyframes/words/sfx above to match.
    input_seek: list[str] = []
    if rs > 0:
        input_seek += ["-ss", f"{rs:.3f}"]
    if re_ is not None:
        input_seek += ["-t", f"{(re_ - rs):.3f}"]

    # NVDEC for H.264 decode when available — frames auto-download to CPU
    # memory since the filter chain still runs in software (crop with
    # expressions and boxblur have no CUDA equivalents). NVENC then re-uploads
    # for encode. Bouncing once at decode + once at encode is cheaper than
    # decoding in CPU.
    hwaccel: list[str] = []
    if _detect_encoder() == "h264_nvenc":
        hwaccel = ["-hwaccel", "cuda"]

    # Each picked image is fed ONLY for its own window (-itsoffset start + -t
    # window) at a low framerate — it's a still. Matches illustrator; ~cheap.
    # These inputs are 1..N; SFX inputs (built above with first_sfx_index=1+N)
    # come after them, so the cmd order is: source, images, sfx.
    ill_inputs: list[str] = []
    for _p, pick in img_inputs:
        win = max(0.1, float(pick.t_end) - float(pick.t_start))
        ill_inputs += ["-itsoffset", f"{float(pick.t_start):.3f}", "-loop", "1",
                       "-framerate", "2", "-t", f"{win:.3f}", "-i", str(_p)]

    cmd = [
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        # Thread hints for the filter graph (the per-frame crop expression +
        # blur are otherwise single-threaded). Counts above CPU count don't
        # hurt; ffmpeg caps internally.
        "-filter_threads", "8",
        "-filter_complex_threads", "8",
        *hwaccel,
        *input_seek,
        "-i", str(source_path),
        *ill_inputs,
        *sfx_inputs,
        "-filter_complex", filter_complex,
        "-map", vmap,
        "-map", audio_map,
        *_encode_args(),
        "-c:a", "aac", "-b:a", "192k",
        "-movflags", "+faststart",
        str(output_path),
    ]

    # Expected OUTPUT duration (for the live progress %): keep-trim sums the kept
    # windows; else the sub-range; else the whole source.
    if keep:
        out_dur = sum(max(0.0, b - a) for a, b in keep)
    elif re_ is not None:
        out_dur = max(0.1, re_ - rs)
    else:
        out_dur = max(0.1, src_dur - rs)

    _run_render(cmd, progress_cb, out_dur)

    try:
        ass_path.unlink()
    except OSError:
        pass

    # Optional intro card (thumbnail + voiceover + transition) prepended in a
    # second pass — best-effort: a failure keeps the plain render.
    if intro is not None:
        try:
            _prepend_intro(output_path, job_id, intro)
        except Exception as e:  # noqa: BLE001
            print(f"[RENDER] intro prepend failed (kept main render): {e}")

    return {
        "output_path": f"/output/{filename}",
        "filename": filename,
    }
