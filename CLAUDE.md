# CLAUDE.md

This file is the project context for Claude Code. Read it fully before touching any file in this repo.

## Project: CLIPPER

A tool for making 9:16 vertical videos (TikTok / Shorts / Reels) from YouTube. The user inputs a URL + time range, draws 2 crop boxes on the source video, the tool auto-transcribes with Whisper, then renders the final video with word-by-word TikTok-style captions.

**Language**: English everywhere. The codebase, code comments, user-facing docs, AND UI strings are all in English. The project standardized on English across the board — translate any remaining Indonesian strings to English when you encounter them.

## Architecture

```
[Browser UI]  ──HTTP──>  [FastAPI backend]  ──>  [yt-dlp]
     ▲                         │                  [Whisper]
     │                         ▼                  [ffmpeg]
  Canvas overlay         temp/{job_id}.mp4   output/{title}.mp4
  + <video> preview
```

3-step linear flow, no state machine, no auth, no DB. Job state lives in `temp/` filesystem keyed by `job_id` (12-char hex uuid).

### Layout output (1080×1920, locked)

```
┌─────────────────┐  y=0
│   BOX 1 (top)   │  1080×720  (3/8 of 1920)
├─────────────────┤  y=720  ← caption sits here (when both boxes)
│                 │
│  BOX 2 (bottom) │  1080×1200 (5/8 of 1920)
│                 │
└─────────────────┘  y=1920
```

Slot dimensions (only relevant when BOTH boxes are drawn):
- Top slot: 1080×720 (3/8 of 1920)
- Bottom slot: 1080×1200 (5/8 of 1920)

**Single-box mode** — if only `box1` OR only `box2` is provided, that crop fills the **entire 1080×1920 frame** (full focus on the box). No slot split, no black pad. The owner re-confirmed this — earlier I had it padding one slot to black; that was wrong. With one box the layout is full-focus on it.

Caption goes to `y = 720` when both boxes; `y = 960` (frame center) when single box. The free-form crop gets fitted to the target slot via each keyframe's `fit` mode (cover or blur_pad) per-segment.

## Tech stack (do not swap without owner approval)

**Backend**: Python 3.10+
- `fastapi` + `uvicorn` — server
- `yt-dlp` — YouTube download
- `openai-whisper` — STT with `word_timestamps=True`
- `openai` — client for the vision-LM endpoint (AI auto-box); optional, feature-gated on `VISION_*`
- `ffmpeg-python` (imported but most ffmpeg calls are raw `subprocess.run` for filter_complex control)
- `pydantic` v2 — schemas

**Frontend**: Vanilla HTML/CSS/JS — **no framework, no build step**.
- HTML5 `<video>` for playback
- Canvas 2D for overlay (box drawing) and preview (real-time 9:16 mock-up)
- Fonts: JetBrains Mono (body) + Bricolage Grotesque (display), from Google Fonts

**External tools required on host**: `ffmpeg`, `ffprobe`, and a JavaScript runtime on PATH (`node` preferred; `deno`/`bun` also OK). The JS runtime is required by yt-dlp to solve YouTube's n-parameter challenge — without it, yt-dlp gets only storyboard images back. This bit is non-obvious: yt-dlp does NOT auto-detect runtimes; `downloader.py` enumerates installed runtimes via `shutil.which()` and passes `js_runtimes={'node': {}}` etc. into `YoutubeDL(...)`. Just having node on PATH is not enough — the runtime must be declared in opts.

The `yt-dlp-ejs` package (in requirements.txt) ships the JS challenge solver scripts. `secretstorage` is also in requirements.txt for reading Chrome cookies on Linux (encrypted with the OS keyring).

## File map

```
clipper/
├── backend/
│   ├── main.py          FastAPI app, all routes, static mount
│   ├── downloader.py    yt-dlp + ffmpeg trim → temp/{job_id}.mp4
│   ├── transcriber.py   Whisper wrapper, cached model load
│   ├── renderer.py      ffmpeg compose: crop → vstack → burn ASS subs
│   ├── vision.py        Vision-LM client: prompt → bbox (AI auto-box); self-loads .env
│   ├── autobox.py       Track predictor: sample frames over a range → keyframes
│   ├── thumbnail.py     Text-LLM client: context → eye-catching headline ideas; self-loads .env
│   ├── batchqueue.py    Persistent batch queue + background worker (JSON import → download + auto-box)
│   ├── soundboard.py    Persistent SFX library (SQLite + audio files); renderer mixes placements into the audio
│   ├── pexels.py        Pexels image search + download (for the illustration cutaways); self-loads .env
│   ├── tts.py           Piper TTS (text → wav) for the intro-card voiceover; voice model in voices/ (gitignored)
│   └── models.py        Pydantic request/response schemas
├── frontend/
│   ├── index.html       7 panels + batch-queue sidebar. Nav VISUAL order: Source→Position→Sound→Illustration→Trim→Thumbnail→Render (edits precede render; Thumbnail before Render because the intro card + its voice/transition previews live on the Thumbnail step). ⚠️ panel IDs are UNCHANGED from build order (panel-3=Render, panel-4=Thumbnail, panel-5=Sound, panel-6=Illustration, panel-7=Trim) — only the nav buttons' position + `<span>NN</span>` labels were reordered; `data-step`/`data-go` still point to the original panel numbers, so showStep()/init dispatch needs NO change. Don't "fix" the mismatch.
│   ├── style.css        Dark editorial theme, CSS vars in :root
│   └── app.js           Canvas drawing, aspect-locked drag, API calls
├── temp/                Source videos. Auto-deleted after render.
├── output/              Final renders. Kept.
├── config.json          Stub template (not wired up yet — see Roadmap)
├── requirements.txt
└── README.md            User-facing setup guide
```

## API contract

All under `/api/`. Bodies are JSON, responses are JSON.

| Method | Path             | Request                              | Response                                     |
|--------|------------------|--------------------------------------|----------------------------------------------|
| POST   | `/api/download`  | `{url, start, end, title, description}` | `{job_id, video_path, duration, width, height}` |
| POST   | `/api/transcribe`| `{job_id}`                           | `{words: [{word, start, end}]}`              |
| POST   | `/api/render`    | `{job_id, title, box1, box2, words, caption_font, caption_size, cleanup}` | `{output_path, filename}` |
| POST   | `/api/autobox`   | `{job_id, prompt, t_start, t_end, box, step_seconds}` | `{keyframes:[Keyframe], sampled, detected, message}` |
| POST   | `/api/thumbnail-text` | `{context, n, language}`        | `{titles: [str]}` (eye-catching headline ideas) |
| POST   | `/api/queue/import` | `{content}` (raw JSON text)       | `{added, skipped, total}` (queue clips for the worker) |
| GET    | `/api/queue`     | —                                    | `{jobs: [{key,id,title,status,message,kf1,kf2,ready}]}` (sidebar summary) |
| GET    | `/api/queue/{key}` | —                                  | full job (incl. `box1`/`box2` keyframes, `job_id`, dims) |
| POST   | `/api/queue/{key}/save` | `{title?, box1?, box2?, description?}` | `{ok}` (auto-save editor edits) |
| POST   | `/api/queue/{key}/render` | —                            | `{ok}` (queue this job for background transcribe + render) |
| POST   | `/api/queue/render-ready` | —                            | `{queued}` (queue ALL ready jobs for render) |
| POST   | `/api/queue/{key}/retry` | —                             | `{ok}` (re-queue an errored job at the right phase) |
| DELETE | `/api/queue/{key}` | —                                  | `{ok}` (remove job + its downloaded clip) |
| GET    | `/api/soundboard` | —                                   | `{sounds: [{id,name,ext,duration,volume}]}` (SFX library) |
| POST   | `/api/soundboard` | raw audio body, `?name=&filename=`  | `{id,name,ext,duration,volume}` (import a sound) |
| POST   | `/api/soundboard/{id}` | `{name?, volume?}`             | updated sound (rename / default volume) |
| DELETE | `/api/soundboard/{id}` | —                              | `{ok}` (delete sound + its file) |
| GET    | `/api/soundboard/{id}/audio` | —                        | the audio file (preview playback) |
| POST   | `/api/search`    | `{query}`                            | `{candidates: [{id,thumb,full,alt,photographer}]}` (Pexels image search) |
| GET    | `/api/img?url=`  | Pexels image URL                     | the image bytes (same-origin proxy so the Thumbnail canvas isn't tainted) |
| POST   | `/api/intro-image?job_id=` | raw PNG body              | `{ok}` — stores the composed thumbnail as `temp/{job}_intro.png` for the intro card |
| POST   | `/api/tts-preview` | `{text}`                           | a wav (Piper) — preview the intro voiceover before render |
| GET    | `/api/capabilities` | —                                 | `{vision, thumbnail, pexels, tts}` (auto-box / headline ideas / illustration search / Piper voice available) |

`RenderRequest` carries two optional overlay lists:
- `sfx: [{sound_id, kind('oneshot'|'range'), t, t_end?, volume, loop}]` — soundboard placements mixed into the audio (see "Soundboard / SFX").
- `illustrations: [{t_start, t_end, url, target, fit}]` — Pexels image cutaways over a window. `target` = `full` | `box1` (top slot) | `box2` (bottom slot); `fit` = `cover` | `blur` (see "Illustration cutaways").
- `keep_segments: [{start, end}]` — multi-segment KEEP trim; only these windows survive (concatenated), the rest is cut. Overrides `render_start`/`render_end` (see "Trim / multi-segment keep").
- `intro: {transition, duration, text, voice} | null` — prepend an intro card (the uploaded thumbnail + Piper voiceover) with a transition into the content (see "Intro card / voiceover").
| POST   | `/api/cleanup`   | `{job_id}`                           | `{ok: true}`                                 |
| GET    | `/temp/{name}`   | —                                    | mp4 stream (for browser preview)             |
| GET    | `/output/{name}` | —                                    | mp4 download                                 |

`box1` and `box2` are **lists of keyframes** — each `{t, x, y, w, h, interp, fit}` where `t` is seconds from clip start and `x/y/w/h` are in **source video pixel coords** (not display coords). `interp` (default `"hold"`) controls how the segment to the *next* keyframe behaves:
- **`"hold"`** — value is constant across the segment. Box stays put; frame N matches frame N-1. Use for static framing.
- **`"linear"`** — linear interpolation to the next keyframe's value. Smooth pan/zoom.

`fit` (default `"cover"`) is the slot-fitting mode for *the segment that starts at this keyframe* (same segment convention as `interp`):
- **`"cover"`** — scale-cover + center-crop. Excess outside slot AR is clipped.
- **`"blur_pad"`** — scale-contain (full crop visible) + blurred-cover copy filling the gaps. TikTok-look, no clipping.

The `interp` on the last keyframe is ignored (its value just holds forever). The `fit` on the last keyframe extends forever (until end of clip). Before the first keyframe time, the first keyframe's value is used.

The owner explicitly chose `hold` as the default — having boxes smoothly drift between every keyframe felt like "the box changes size by itself". Don't change the default to `linear` without checking.

`words` may be `[]` — that means render without caption (fast path, no Whisper). `cleanup` defaults to `false`; the frontend keeps the source around so the user can preview the render, then re-render with caption, then explicitly call `/api/cleanup` when done. Setting `cleanup: true` on `/api/render` makes it delete the source after the render — only do this if you know it's the last render for this job.

## Conventions & gotchas

### Coordinate spaces
There are **three** in play. Don't mix them up:
1. **Source pixel space** — actual video resolution (e.g. 1920×1080). Boxes are stored here. Backend works in this space.
2. **Overlay display space** — the rendered size of `<video>` in the browser (depends on viewport). Mouse events come in this space.
3. **Preview canvas space** — fixed 270×480 (1/4 of output). Used only for the right-side mock-up.

`app.js` has `overlayToSource()` and `sourceToOverlay()` — always go through these. Don't shortcut.

### Box drawing — free-form + render-area guide (WYSIWYG)
Source-crop boxes are **free-form** (any size/AR). Slots have fixed AR (3:2 top, 9:10 bottom). WYSIWYG is achieved NOT by locking the box AR, but by **showing what actually renders**:
- `drawBox` overlays a **render-area guide**: in COVER mode it dims the cropped margins + outlines (dashed white) the centered slot-AR sub-rect that survives — `coverKeepRect`, which mirrors the backend cover math and the preview `drawCover`. In BLUR_PAD mode the whole box renders (contained, blurred pad) so no guide/dimming.
- The right-side preview canvas (`drawSlot`/`drawCover`) already shows the exact cover/blur result — verified pixel-identical to the render (44.6 dB PSNR, compression only).

History: an earlier attempt LOCKED the box to the slot AR to force box==output. Owner rejected it — they want free custom sizing, and noted blur_pad already shows the full box uncropped. So the lock was reverted in favour of the render-area guide. **Don't re-introduce aspect-lock**; if box==output is wanted, the answer is BLUR_PAD (no crop) or drawing inside the guide. (`lockAspect` stays in the source, unused, for reference.)

**Bounds clamp**: `onDragEnd` clamps the box inside the source frame (size-preserving slide). Defense-in-depth: `renderer.py` `_clamp_kfs` (called in `render()` after `_probe_dims`) caps every keyframe box inside the frame — a no-op for valid boxes, but stops an off-frame box from a direct API/batch/auto-segment call from making ffmpeg's `crop` fail. Don't remove either layer.

### Drag interactions (resize / move / draw)
On mousedown, `onDragStart` hit-tests the click point against the active box (at currentTime) in this order:
1. **Corner handle** (12px overlay radius) → `mode='resize'`. Anchor the opposite corner; drag = free-form resize from this corner. Mouseup commits a kf with new x/y/w/h.
2. **Inside box (not on handle)** → `mode='move'`. Drag translates (size preserved).
3. **Outside box** → `mode='draw'`. Drag = new free-form rectangle. Click without drag (<8px) inherits size from the nearest kf and re-positions at click point.

Cursor changes per mode on hover (`nwse-resize`/`nesw-resize` on handles, `move` inside, `crosshair` outside). Corner handles are drawn only for the *active* box.

### Segment list panel
Below the box-controls is a per-box keyframe summary panel (`#kf-list`) showing each segment as a row: `[time → next-time] [WxH @ (x,y)] [HOLD/PAN→/—] [seek][toggle][delete]`. The row containing the current scrubber time gets `.current` highlight. This panel is the canonical "where is bbox X used" answer — the timeline above is the same info as dots, but this list spells out each segment's actual bbox so the user can audit it without inspecting individual kfs.

### Video controls & draw arming
The video uses a **custom control bar** (play/pause/scrubber/timestamp), NOT native HTML5 `<video controls>`. The native controls don't blend with the dark editorial theme and got covered by the canvas overlay; the user asked for a proper UI. The control bar sits *below* the source stage, so it's always reachable.

The canvas overlay is "armed" via `state.activeBox`:
- `activeBox === null` (default) → canvas has `pointer-events: none`. The video underneath is interactable for nothing in particular (custom controls below handle playback), but the user can scrub via the bar without accidentally drawing.
- `activeBox === 1` or `2` → canvas has `pointer-events: auto`, stage gets a yellow outline, drag = upsert keyframe at `currentTime` for that box.

Arming: click a Box pill, or press `1`/`2`. Disarm: click the same pill again, or `Escape`. Keyboard shortcuts on step 2: `Space` = play/pause, `←`/`→` = -1s/+1s. Don't re-add the old "Play/Draw mode toggle button" — it was redundant once the custom controls existed.

### ffmpeg filter_complex
The render pipeline is a single `filter_complex` string built in `renderer.py`. `_crop_chain` returns a list of filter strings (one per intermediate step) that the caller joins with `;`.

Two fit modes available per-keyframe:

**cover** (default) — the box gets clipped to the slot aspect:
```
[0:v] crop=W:H:X:Y, scale=OUT_W:OUT_H:force_original_aspect_ratio=increase, crop=OUT_W:OUT_H, setsar=1 [label]
```
The double-crop is intentional: `scale=...:force_original_aspect_ratio=increase` makes the crop fill (cover behavior), then the trailing `crop` removes overflow.

**blur_pad** — the full box is visible, gaps filled with a blurred copy:
```
[0:v] crop=W:H:X:Y, setsar=1, split=2 [a][b]
[a] scale=...:force_original_aspect_ratio=increase, crop=OUT_W:OUT_H, gblur=sigma=30:steps=3, eq=brightness=-0.08 [bg]
[b] scale=...:force_original_aspect_ratio=decrease [fg]
[bg][fg] overlay=(W-w)/2:(H-h)/2 [label]
```
The `eq=brightness=-0.08` is a slight darkening so the background reads as "background" not competing with the foreground. Don't remove without owner approval — they specifically asked for a TikTok-style padded look, not just a transparent gradient.

Fit mode is **per-keyframe**, not global or per-box. Each kf's `fit` applies for the segment starting at that kf (same semantics as `interp`). The frontend exposes a Cover/Blur Pad toggle button in each segment row of the Step 2 kf-list. New keyframes inherit `fit` from the nearest prior keyframe in the same box (cover if none exist yet).

### crop w/h are INIT-LOCKED — animated-SIZE boxes need per-segment crops (bug fixed 2026-06)
**Critical ffmpeg gotcha:** the `crop` filter evaluates `w`/`h` (the OUTPUT size) ONCE at init — only `x`/`y` animate per-frame. So a box whose **size changes between keyframes** (zoom) CANNOT be done with `crop=w='<expr>':h='<expr>'` — the size stays stuck at the init value (which, with `t` undefined at init, falls through the `if(lt(t,...))` chain to the LAST keyframe's value). This silently broke every zoom: the box rendered at the last keyframe's size for the whole clip. (`crop` in this ffmpeg build has no `eval=frame` option either.)

Fix: `_crop_chain` detects when w/h varies across real keyframes (`size_varies`) and routes to **`_crop_chain_segmented`** — it crops each keyframe segment with a LITERAL (constant) box, applies that kf's fit (cover/blur), and composites the segments with `overlay=enable='between(t,t0,t1)'` switching (first segment extends back to t=0; gaps stay black via the base). The expression path (`_build_expr`) is now used ONLY for a single keyframe or **constant-size** multi-kf (where x/y still pan smoothly per-frame and constant w/h is fine).

Consequence: **size is STEPPED across a zoom** (each segment shows its start-keyframe box; no smooth per-frame zoom — crop can't do per-frame w/h, and `zoompan` only does AR-locked zoom). HOLD (the default) is exactly right; LINEAR with a size change degrades to stepped. Don't revert to a single expression-crop for varying-size boxes — it's the bug. illustrator's renderer has the identical fix.

**Mixed-fit pipeline.** When a box has only one fit value across all its kfs, the chain is the simple cover or blur_pad form above. When fits are mixed, `_crop_chain` emits both branches and switches between them per segment via `overlay=enable='<expr>'`:
```
[in] crop, setsar=1, split=3 [s1][s2][s3]
[s1] cover-scale+crop                                  → [cov]
[s2] cover-scale+crop + blur + brightness              → [bg]
[s3] contain-scale                                     → [fg]
[bg][fg] overlay=center                                → [blr]
[cov][blr] overlay=enable='between(t,T1a,T1b)+between(t,T2a,T2b)+...' → [out]
```
The enable expression is one `between(t,t_start,t_end)` per blur-mode segment, summed. When the expression is non-zero ffmpeg overlays `[blr]` on top of `[cov]`; otherwise `[cov]` passes through. Transitions are hard cuts at segment boundaries — no crossfade. If owner asks for fades, the cleanest path is a `fade` filter applied to the overlay's alpha, not changing the enable scheme.

The Step 2 preview canvas mirrors this: `drawSlot()` picks `currentFit(boxNum)` per slot (which finds the kf whose segment contains `state.currentTime`), then clips to the slot and either draws cover or blurred-cover bg + contained fg.

Render produces a **single** output file per click. Filename is `<slug>_<jobid>.mp4` — re-renders overwrite. If owner wants kept variants, suggest manual rename or a "save as" affordance rather than baking suffixes for every possible combo (since per-segment fits make combo space exponential).

When both boxes exist: `[top][bot] vstack=inputs=2 [stacked]`. Always `vstack`, never `hstack`.

### ASS subtitle path escaping
The `subtitles=` filter takes a path inside a filter string. Windows paths with `:` (drive letter) break this. `renderer.py` does:
```python
ass_path_escaped = ass_path.replace("\\", "/").replace(":", "\\:")
```
Don't remove this. If subs still break on Windows, the next step is wrapping in `subtitles=filename='...'` with proper escaping per ffmpeg docs, not removing the existing escape.

### ASS color format
ASS uses `&H00BBGGRR` (alpha, then BGR — reversed from RGB). `to_ass_color()` in `renderer.py` handles conversion. If adding new color params, route through it.

### Word grouping
`_group_words()` chunks Whisper output into 1-3 word groups (max 18 chars). This is the "TikTok style" — short, snappy, fast. Don't change the default without owner approval. The function is intentionally simple (greedy); a smarter version would split on punctuation, but that's not a priority. Each group now also carries `words: [{text,start,end}]` (per-word timing) — `_build_ass` needs this for the karaoke highlight.

### Caption styling (TikTok karaoke + bundled fonts)
Captions are burned via ASS (`_build_ass`). Two deliberate choices:
- **Bundled fonts**: `assets/fonts/Anton-Regular.ttf` (default) + `BebasNeue-Regular.ttf` are OFL fonts shipped in-repo. The `subtitles=` filter gets `:fontsdir=<assets/fonts>` so libass uses them instead of a generic host fallback (the old cause of "plain-looking" captions). The Google Fonts `<link>` in `index.html` only affects the browser preview, NOT the burn — the burn uses fontsdir. Family names must match the ASS `Style:` Fontname exactly (`Anton`, `Bebas Neue`). Adding a font = drop the .ttf in `assets/fonts/`, add to `CAPTION_FONTS` (models.py) + the `<select>`, and check the family name via `fc-query --format='%{family}' file.ttf`.
- **Per-word karaoke highlight**: instead of one Dialogue per group, `_build_ass` emits one Dialogue **per word time-slice**. In each slice all the group's words show, but the currently-spoken word is recolored to `CAPTION_HIGHLIGHT` (accent `#E8FF3A`) and scaled `\fscx/\fscy 112`, then reset to `CAPTION_FILL` white / 100%. Slices are contiguous (word j spans `[word[j].start, word[j+1].start)`, last → group end). The mild scale causes a tiny center-recenter "breathing" per word — intended pop, fine for 1-3 word groups. Style line uses Outline=6, Shadow=3 (fatter than before) for punch over any footage. Colors route through `to_ass_color()`.

### Whisper model / GPU (updated 2026-06)
`transcriber.py` auto-runs on **CUDA** when `torch.cuda.is_available()`, else CPU. Defaults: **`medium` on GPU, `base` on CPU** — `base` is mediocre for Indonesian, `medium` is much better and fits a 6 GB GPU (~4.3 GB). Knobs are env-driven (read from project-root `.env` by transcriber's own `_load_dotenv()`, or the process env):
- `WHISPER_MODEL` — `tiny|base|small|medium|large-v3` (override the default).
- `WHISPER_LANGUAGE` — e.g. `id`; empty = auto-detect. **`clipper/.env` sets `id`** (owner content is Indonesian). Forcing the language avoids auto-detect misfires on intro music / mixed audio.

Other accuracy/robustness choices in `transcribe()`:
- `condition_on_previous_text=False` — stops Whisper's repeat/hallucination loops over music/silence (intended trade-off; slight cross-window coherence loss on long speech).
- `initial_prompt` param — optional vocab bias (proper nouns/topic) to cut mis-spellings.
- **No persistent model cache**: the model is loaded per call and its **VRAM is freed afterwards** (`del` + `torch.cuda.empty_cache()`), so the NVENC render step gets the whole GPU back. Cost: each transcribe reloads (~few s from the on-disk `~/.cache/whisper` model). A CUDA OOM transparently **retries on CPU**.

**GPU gotcha (the big one):** the installed `torch` build must match the NVIDIA driver's CUDA version, or `torch.cuda.is_available()` is silently `False` → Whisper runs on CPU (a bigger model is then painfully slow). Driver here supports CUDA 12.8, so torch must be a `cu12x` build. `requirements.txt` pins `torch==2.11.0+cu128` (+ the cu128 index) for exactly this reason — a plain install pulled a `cu13` build that couldn't see the GPU.

### AI auto-box (vision-LM) — `vision.py` + `autobox.py`
In Step 2 the user picks a Box, types what to track (e.g. "the speaker"), drags a single pair of timeline handles to set `[t_start, t_end]`, and hits **Generate** → `/api/autobox` samples frames across the range, asks the vision model for the subject's box on each, and returns a keyframe track that drops into the **armed box** (replacing keyframes inside the range) — fully editable afterwards (drag / resize / delete) like manual boxing.
- **Vision model = a SEPARATE OpenAI-compatible Qwen-VL endpoint** (`VISION_BASE_URL`/`VISION_MODEL`, same one browser_agent uses). Optional: if unset, `/api/capabilities` returns `{vision:false}` and the frontend disables the auto-box UI. `vision.py` self-loads `.env` (clipper has no `config.py`).
- **Coordinate convention (verified empirically): the model returns `bbox_2d=[xmin,ymin,xmax,ymax]` in 0-1000 NORMALIZED units** — NOT pixels, NOT Gemini's `[ymin,xmin,...]` order. Convert per-axis: `px = v/1000*W` (x), `v/1000*H` (y), then clamp. Aspect-independent (use native frame W/H). A single normalized formula is correct for every frame; do NOT add an absolute-px fallback.
- **Parse is regex, never `json.loads`**: output is non-deterministic even at temp 0 (```json fences, an optional `label`, sometimes a bare `[[...]]` without the key, occasionally malformed JSON). `_parse_boxes` prefers `bbox_2d`-keyed arrays, falls back to any bare 4-number array, and picks the **largest-area** box (= main subject; avoids audience/background). **Absent subject → the model returns `[]` (no hallucinated box) → no detection.** A run of absent frames (subject not in the shot) becomes a `gap` keyframe so the slot renders BLACK — the box is simply NOT drawn when the subject isn't there. A lone single miss (likely a model hiccup, subject still present) is tolerated and bridged.
- Frames are downscaled to ≤1280px before sending (normalized coords are scale-free → still converted with source W/H). Vision calls run `ThreadPoolExecutor(max_workers=4)` — the endpoint's clean-concurrency sweet spot (study: 4 great, ≤6 ok). `MAX_FRAMES=80` caps cost on long ranges (the response message says when the step was widened). Absent stretches become `gap` keyframes (empty/black slot) — `_build_keyframes` handles the present→absent→present transitions (gap on runs of ≥2 misses or absence at the range start/end; lone misses bridged), so the box appears only while the subject is actually on screen.
- **Stable size (default, `lock_size=True`)**: a two-pass step — after predicting every frame, `_reject_outliers` first DROPS detections whose area deviates >1.5×/<0.5× from the median (the model occasionally boxes the whole screen; one such box used to inflate the lock ~40% — measured on real reaction footage), then `_stabilize_size` locks ONE box size (the MEDIAN of widths/heights, switched from p85 for tightness) and only PANS the center. Kills zoom jitter; constant size also renders as a smooth expression-crop instead of stepped per-segment crops. Dropped outlier frames become misses (lone → bridged, run → gap). Toggle off (UI "Stable size") for adaptive per-frame size.
- **`{side}`/`{other_side}`/`{layout}` placeholders + LAYOUT SEGMENTS** (`predict_track`, `_detect_layout_segments`, `_classify_layout`, `_fill_placeholders`): the model boxes panels FAR better with CONCRETE structural anchors (measured 3×: stated side+split phrasing → median width 1030 & 1-kf static tracks; soft/agnostic wording → 1206–1679 wide, drifting onto the person, 10–21 kf). But not every frame is person-beside-content — the owner's exact requirement: fullscreen person → box1 only, fullscreen content (thread/meme/comment) → box2 only. So when the prompt has placeholders the clip is segmented into **FOUR classes**: `split`, `overlay`, `full` (fullscreen webcam), `fullcontent` (fullscreen content/text). (1) probe spread frames + the two EDGE frames (t0+0.3/t1−0.3 — clips often open/close fullscreen, interior probes never land there) with a **DUAL geometric probe** (`_classify_layout`): person probe first (`_SIDE_PROBE_PROMPT`; `_geom` flags: huge = w≥85% of frame OR big non-edge box with ≥45% frame area → `full`; panel = w≥34% + edge-anchored → `split` + side; big-but-mid-frame = None/inconclusive); person miss/small → content probe (`_CONTENT_PROBE_PROMPT`): content huge + person miss → `fullcontent`; small person over huge content is ambiguous (corner cam vs face inside the content) → ONE yes/no presence QA (`_CAM_PRESENT_QUESTION`) breaks the tie (overlay vs fullcontent). (2) **split-vs-overlay is a single GLOBAL majority vote** (a spurious 'overlay' probe label once poisoned a whole clip) but `full`/`fullcontent` labels stay per-probe — fullscreen segments are real mid-clip events, like SIDE switches; endpoint flake-smoothing keeps a layout-TYPE difference at the ends and only smooths side flakes. (3) boundaries refined by **RECURSIVE bisection** (`_refine_boundary`, normalized (layout, side) tuples) down to `step_seconds`: a midpoint matching NEITHER endpoint label is a state the probes never landed on (e.g. a fullscreen-content stretch between a full probe and a split probe) → recurse both halves so it becomes its own segment instead of being absorbed. (4) after detection, **boundary correction by detection feedback**: a contiguous miss-run touching a segment edge is re-detected with the neighbor's prompt — hits move the boundary to the first hit. SKIPPED when the run's own segment is synthesized full+role (all-miss by construction proves nothing — and re-asking the model for a content panel on fullscreen frames makes it hallucinate one, measured 1576×1014). Each segment gets its own filled prompt (`{layout}` → `_LAYOUT_PHRASES`; in fullscreen segments `{side}`/`{other_side}` → "screen"), its own outlier/size-lock/static-pin pass, and its first keyframe snapped to the switch time. A zero-detection segment emits an explicit gap kf (else the renderer holds the previous box across it). No placeholders → single segment, prompt untouched. Substitution is `.replace`, never `.format`. Result dict carries `segments` + first segment's `side`. `_resolve_side` (5-frame geometric vote, QA fallback) remains the fallback when every probe is inconclusive. Validated on real footage: clip with truth full 0–~2.5 / split / full 12.5–13.0→end came out 2.43 / 12.80; offline truth-clock tests put every boundary within 0.25s.
- **SHARED segmentation per clip** (`autobox.detect_layout_segments`, called once in `_process_one`): both boxes get the SAME layout timeline (`predict_track(segments=…)`, which copies it — feedback mutates). Independent per-box probing measurably disagreed (box1 called a stretch `full` while box2 called it `fullcontent` → BOTH boxes real at once → the reel shows the same frame twice, stacked). Also halves probe cost. The timeline is appended to the job message ("layout: full 0.0–7.9s · split(left) 7.9–25.5s · …") so it's visible in the sidebar.
- **`role` ("streamer"/"content") + fullscreen segments**: in `full`/`fullcontent` segments the answer is deterministic — the box whose subject fills the screen = the WHOLE frame, the other = gap — so `predict_track(role=…)` synthesizes those without model calls (asking the model anyway is what produced the garbage 1576×1014 "content panel" on fullscreen frames). batchqueue hardcodes box1=streamer/box2=content (the same convention the placeholders are built on); the interactive `/api/autobox` derives it from `req.box`. role=None (e.g. illustrator) still queries the model with the fullscreen phrase. One-box-gap flips the renderer to single-box full-focus mode (`_layout_switch_intervals`), so a fullscreen segment renders as the full frame regardless of which box carries it.
- **ADAPTIVE sampling — `step_seconds` is PRECISION, not rate** (owner: "jangan 1.5, jadiin 0.2 — pilihannya 0.2/0.8/1"): detection runs on a ~1s coarse grid (`max(step,1.0)`), then SUBDIVIDES only adjacent pairs whose state differs (hit/miss flip, center moved >2%, size changed >3%) down to `step_seconds` (default **0.2s**, own MAX_FRAMES budget). A static panel costs the same at 0.2s as at 1.5s; transitions and moving cams get dense samples. Probe bisection min_gap = the same step. UI `#ab-density` = Fast 1s / Balanced 0.8s / Precise 0.2s (default); per-clip JSON key `step` (alias `precision`), clamped 0.2–3.0, column `step_seconds` (ALTER-TABLE-migrated).
- **`merge_double_gaps` (batchqueue post-step)**: when BOTH boxes are gap at once (a fullscreen blip shorter than probe resolution — e.g. a 1.5s fullscreen comment card mid-split), the reel would render BLACK; a `classify_fullscreen_owner` probe at the blip midpoint decides which box carries the full frame there ('streamer' → box1, 'content'/inconclusive → box2 — blips are nearly always inserted content; the owner wants text/threads on bbox2). Found on real footage (clip2 t≈24, a fullscreen comment): split prompts correctly miss on the card, no probe lands on it — verified assigned to box2.
- **Whole-clip context smoothing** (`_lock_static` + interior bridge + `_dedupe_keyframes`): after size-locking, if the box center's MAD across the WHOLE range is < 2% of the frame (split-screen panels are static; the wobble is model noise), the center is PINNED at the median → a single static box. When pinned, interior detection misses (between the first and last sighting) are bridged with the static box instead of becoming black-flicker gaps — boundary misses still become gaps (the layout may genuinely differ at the clip edges, e.g. a fullscreen intro). Consecutive identical hold-kfs are then deduped, so a static panel collapses to ~1 keyframe. A genuinely moving subject never pins (MAD too big) and keeps the panning track. `detected` stays the honest model-detection count, not bridged fills.

### Thumbnail generator (Step 7) — `thumbnail.py` + the thumb-* frontend block
A 9:16 cover maker, separate from the video render. **Almost entirely client-side**: compositing + PNG export happen on a `<canvas>` in `app.js` (the `thumb` state + `drawThumbnailInto`). Backend touches: `/api/thumbnail-text` (headline ideas), `/api/search` (Pexels), `/api/img` (image proxy).
- **Multi-box background.** `thumb.layout` = `full` (1 box) or `two` (top 3/8 + bottom 5/8). `thumb.slots[]` (slot 0 = top/full, slot 1 = bottom) each have `kind` = `scene` | `ill` and `fit` = `cover` | `blur`:
  - **Scene** = a captured video frame. `captureSlot(i)` snapshots the current `#thumb-video` frame to an offscreen canvas (`slot.snap`) + records the crop rect: in `two` mode top→`boxAt(1,t)`, bottom→`boxAt(2,t)` (the Position bbox at that time; null→full frame); in `full` mode no crop. **Each slot captures from its OWN scrubbed time** (the user scrubs, hits Capture per box). `drawThumbSlot` then `coverRegion`/`containRegion`s the snap's box-rect into the slot.
  - **Illustration** = a Pexels pick per slot (own inline search). The image is loaded via **`/api/img?url=` (same-origin proxy)** so the canvas isn't tainted and `toBlob` works (a raw cross-origin Pexels image would throw on export).
- **Text model = the text vLLM** (`VLLM_*`, internal Qwen3). Headlines are in the CONTENT's language (Indonesian content → Indonesian) — deliberate; don't force English. `enable_thinking=False` + retries; gated on `/api/capabilities.thumbnail` (only the Generate-ideas button).
- **Parametric draw** (`drawThumbnailInto(ctx, W, H)`): preview canvas + the 1080×1920 export use identical code; `size` is in output px scaled by `W/OUT_W`; webfont awaited before the export `toBlob`. Slots reset per clip (`resetThumbSlots` in `doDownload`/`openQueueJob`) since `slot.snap` references the old video. Export = client-side `toBlob('image/png')` → `<a download>`, nothing written server-side. Filename `<title>_thumbnail.png`.

### Batch queue (sidebar) — `batchqueue.py` + the queue-* frontend block
Upload a JSON of clips and walk away: a single background worker downloads each clip and predicts its crop boxes from the per-box **text prompts**, one job at a time, so the user returns to ready-to-edit clips instead of waiting on predict+download live. The sidebar lists jobs by id; opening a `ready` one loads it into Step 2 (boxes pre-filled, editable), edits **auto-save** back to the job, and a job is deleted when done.
- **Import format (keyed by video URL, tolerant of Python-dict single quotes):** `{ "_context"?: str, "<url>": [ {id,start,end,title,description,bbox_1,bbox_2,context?,padding?,step?}, ... ] }`. `bbox_1`/`bbox_2` are the auto-box **prompts** (may contain the `{side}`/`{other_side}` placeholders — see the auto-box gotcha); `start`/`end` accept `"HH:MM:SS"` or plain seconds; optional `padding` (alias `pad`) is the auto-box expansion fraction per side — `0` = tight box hugging the subject, unset → the 0.05 default; optional `step` (alias `precision`) is the temporal precision in seconds (0.2/0.8/1 sensible, unset → 0.2) (all stored in the jobs table; ALTER-TABLE-migrated, same for `context`). `batchqueue._parse` tries `json.loads` then `ast.literal_eval` (handles the single-quote style the user pastes). Dedups by `id` on re-import.
- **Shared context ("system prompt"):** a top-level `"_context"` key (underscore = clearly not a URL; popped before the URL loop) or a per-clip `"context"`/`"system"` (overrides the default) is **prepended to BOTH box prompts** at predict time (`merged()` in `_process_one` — plain concatenation, so `{side}` placeholders inside it resolve normally). Lets the layout be described ONCE while `bbox_1`/`bbox_2` stay short instructions. **Keep the context to the LAYOUT only** — measured: moving the content-type enumeration (comments/tweets/etc.) into the shared context made box1 noticeably noisier; it belongs in bbox_2's own instruction. `openQueueJob` prefills the UI auto-box fields with the MERGED prompt so a manual re-Generate matches the batch run.
- **Model observation (auto-context):** before boxing, the worker lets the model "study" the clip — `_observe_clip` asks `vision.describe` on a mid-clip frame for ONE sentence about the streamer's appearance + ONE about the content type, explicitly **without position words** (sides stay the geometric `{side}` probe's job — a stated side here could contradict it). Stored once per job (`auto_context` column, reused on retry), bounded to 400 chars. The final prompt for each box is **`[observation] + [shared context] + [bbox instruction]`** (the owner's specified order), both in the batch worker and the UI prefill. Best-effort: observation failure just means a 2-layer prompt.
- **Worker** (`_worker_loop`, one daemon thread, started in `main.py`): per job → `downloading` (yt-dlp) → `predicting` (autobox over the whole clip, `lock_size=True`, box1 from prompt1 + box2 from prompt2) → `ready`. Sequential on purpose (don't hammer yt-dlp / the vision endpoint). A clip whose subject is absent yields no box (status still `ready`, note in `message`); a download failure → `error` (surfaced in the sidebar, with a ↻ retry).
- **Render phase (on demand, clipper only — `RENDER_IN_QUEUE=True`):** after editing a `ready` job's boxes, the user hits ▶ on the sidebar item (or "Render all ready") → `render_queued` → the SAME worker does `rendering` (transcribe via Whisper + `renderer.render` with the saved/edited boxes, caption defaults `Anton`/64) → `done` (output at `/output/{filename}`, downloadable from the sidebar). So the heavy GPU/CPU work is **also serialized — only one render at a time** (the owner's explicit CPU concern). `_next_actionable` interleaves download/predict and render jobs in list order; `_render_one` builds `Keyframe`/`Word` objects from the stored dicts. `retry_job` is phase-aware (has boxes+job_id → re-render; else re-download/predict). **illustrator sets `RENDER_IN_QUEUE=False`** — its render needs the interactive Illustration step, so the queue stays download+predict only and the JSON's optional `segment_seconds`/`seg_seconds`/`jeda` pre-fills the Illustration step's duration so the user just picks images.
- **⚠️ Module name:** the file is `batchqueue.py`, NOT `queue.py`. `main.py` puts `backend/` on `sys.path[0]`, so a `queue.py` there **shadows the stdlib `queue`** that urllib3/yt-dlp import → `partially initialized module 'queue'` crash on boot. Don't rename it back.
- **Persistence:** a local **SQLite** database `queue/queue.db` (NOT a JSON file — the owner asked for a real DB). Two relational tables: `jobs` (one row per clip, scalar columns) and `keyframes` (one row per crop-box keyframe — `(job_key, box, idx, t, x, y, w, h, interp, fit, gap)`, FK to `jobs(key)` `ON DELETE CASCADE`; **no JSON blob anywhere**). `sqlite3` ships with Python — no server, no new dependency. All access is serialized through a module `RLock` + short-lived connections (`_db()` context manager commits-and-closes, since `with sqlite3.connect()` only manages the transaction, not the handle); `PRAGMA foreign_keys=ON` per connection so cascade works. It survives restarts; a job left mid-`downloading`/`predicting`/`rendering` by a restart is reset to `pending`/`render_queued` and retried (`_reset_interrupted`). A pre-existing `queue/queue.json` from the old version is auto-migrated once (`_migrate_json_if_any`). `queue/` is gitignored. illustrator's copy is identical except `NUM_BOXES = 1` and `RENDER_IN_QUEUE = False` (predicts box1 only, render stays manual).

### Soundboard / SFX (Step 5) — `soundboard.py` + renderer audio mix
A persistent library of imported sound-effect files + per-clip placements mixed into the render's audio.
- **Library = `soundboard.py`** (its own SQLite db `soundboard/soundboard.db` + the audio files in `soundboard/`, gitignored). Same `_db()` plumbing as `batchqueue.py`. List / import / delete / serve survive restart. **Uploads are the RAW request body** (`await request.body()` in `main.py`) with `?name=&filename=` query params — deliberately NO `python-multipart` dependency. Allowed types gated by extension (`mp3/wav/ogg/m4a/aac/flac/opus/webm`).
- **Placement** is per-clip, NOT persisted (it rides in `RenderRequest.sfx`). Two kinds: `oneshot` (plays once at `t`) and `range` (plays over `[t, t_end]`, `loop` repeats it to fill). Each has a linear `volume`. The frontend Step 5 (`#sfx-*`, `state.sfx`) has its own `#sfx-video` scrubber to pick times; placements reset per clip (`doDownload` / `openQueueJob`).
- **Renderer audio graph** (`_audio_inputs_and_graph`, identical in both renderers): builds ONLY when `sfx` is non-empty — otherwise the plain `-map 0:a?` is untouched (zero regression for normal renders). Each SFX = one extra ffmpeg input after the source (clipper) / after the source+image inputs (illustrator: `first_sfx_index = 1 + len(img_inputs)`). Base = the clip's own audio (or `anullsrc`+`atrim` silence, bounded to the output duration, when the source has none). Each input is `volume`'d, `aformat`'d to a common 48k/stereo/fltp, range ones `atrim`'d to their window, delayed with `adelay={ms}:all=1`, then `amix=inputs=N:normalize=0:duration=first` (normalize=0 keeps levels so the user balances via volume; duration=first bounds it to the base). Looping a range uses **`-stream_loop -1` on that input** (demux level), not an `aloop` filter. SFX times are re-based to a render sub-range via `_shift_sfx` (mirrors `_shift_keyframes`/`_shift_words`).
- The batch-queue auto-render path does NOT add SFX (placements aren't stored on a job) — SFX are an interactive-render feature. Don't wire SFX into the queue without asking.

### Illustration cutaways (Step 6) — `pexels.py` + renderer overlay
Manual image cutaways from Pexels, placed on a mini-timeline (drag to move, drag the right edge to resize duration). NOT illustrator's auto bottom-slot — here the user controls each one. Each cutaway has a **`target`** (where it goes) and **`fit`**:
- `target`: `full` (whole 9:16), `box1` (top slot 1080×720), `box2` (bottom slot 1080×1200 at y=720) — "represents" that box, overlaid just over that region.
- `fit`: `cover` (scale-cover + crop) or `blur` (contained image + blurred-cover pad filling the rect).
- **Search = `pexels.py`** (ported from illustrator's `search_pexels`/`download_pick`; self-loads `.env`, reads `PEXELS_API_KEY` — the SAME key as illustrator). `/api/search {query}` → candidate URLs (streamed to the browser, nothing stored). Gated on `/api/capabilities.pexels`. **Needs `PEXELS_API_KEY` in `clipper/.env`** (copied from illustrator's).
- **Placement** is per-clip, NOT persisted — rides in `RenderRequest.illustrations` (`[{t_start,t_end,url,target,fit}]`). Frontend Step 6 (`#ill-*`, `state.ills`) has its own `#ill-video` scrubber, a draggable timeline track, per-cutaway target/fit `<select>`s, and a **live composite preview** (`#ill-preview` → `drawIllPreview`, draws the video frame + the active cutaway in its target region/fit). Reset per clip.
- **Renderer** (`render()` in `renderer.py`): only the picked images are downloaded (`pexels.download_pick`, deduped → `temp/{job}_ill_*.jpg`, cleaned by `cleanup_job`'s `{job}*` glob). Per cutaway: target → rect `(W,H,x,y)`; `cover` = `scale=increase,crop=W:H`; `blur` = `split` → blurred-cover bg + contained fg composed to `W×H`. Overlaid with `overlay=x=..:y=..:enable='between(t,t0,t1)':eof_action=pass` **before** the subtitle burn (captions stay on top). Re-based to a render sub-range via `_shift_illustrations` (which carries target/fit).
- **Input ordering is load-bearing:** inputs are `source(0)`, then illustration images `1..N`, then SFX `N+1..` — so the SFX audio graph uses `first_sfx_index = 1 + len(img_inputs)`. If you add more inputs, keep the image→sfx order and update both index bases.

### Trim / multi-segment keep (Step 7) — `keep_segments`
Cut out dead air / noisy stretches by marking the windows to **keep** (A→B, arbitrary count); everything outside is dropped and the kept parts concatenated.
- **Render-time, end-of-chain** (`renderer.render()`): the whole clip is composed first (crop / caption / SFX / cutaway all at their original times), THEN `[<vmap>]select='between(t,a1,b1)+…',setpts=N/FRAME_RATE/TB` + the matching `aselect`/`asetpts=N/SR/TB` drop the gaps and re-time. **This deliberately avoids remapping any of the time-based metadata** — composing-then-cutting keeps everything correct (the alternative, cutting the input first, would force shifting every keyframe/word/sfx/illustration). Don't "optimize" it to select on the input.
- `_sanitize_keep` clamps to the clip, drops sub-frame slivers, sorts + merges overlaps. **Empty → no trim** (whole clip). When keep windows are set they **override** the single `render_start`/`render_end` sub-range (rs/re_ forced to 0/None so nothing is double-trimmed).
- Audio base for the `aselect`: the SFX mix `[aout]` if present, else `[0:a]` when the source has audio, else nothing. Video select runs on the final `vmap` (after the caption burn).
- This removes whole TIME REGIONS (video+audio together) — it is NOT spectral denoise. If real background-hiss cleanup is ever wanted, that's a separate `afftdn`/`anlmdn` audio filter, not this.
- Frontend Step 7 (`#trim-*`, `state.keep`) marks windows on a timeline (Set A / Set B, or "+keep here"; drag to move, right edge to resize). Reset per clip. Clipper-only for now.

### Intro card / voiceover (TTS) — `tts.py` + `renderer._prepend_intro`
Prepend an intro to the render: the **thumbnail** image shown for a few seconds with a **Piper voiceover** reading the headline, then a **transition** into the content.
- **TTS = Piper, local & free** (`tts.py`). Voice model in `clipper/voices/*.onnx` (gitignored, ~60MB; default `id_ID-news_tts-medium`, an Indonesian news reader). Install: `pip install piper-tts` + `python -m piper.download_voices id_ID-news_tts-medium --data-dir clipper/voices`. Synthesis = `python -m piper -m <voice> -f out.wav` (via `sys.executable`, PATH-independent). `enabled()`/`capabilities.tts` = a voice model is present; if absent the intro is silent.
- **Two-pass render** (`_prepend_intro`, called at the end of `render()` when `intro` is set — best-effort, a failure keeps the plain render): the frontend composes the Thumbnail at 1080×1920 and uploads it (`POST /api/intro-image` → `temp/{job}_intro.png`); the pass builds the intro still (`-loop 1 -t intro_dur`) + the TTS wav (padded to `intro_dur`), and `xfade`s the video + `acrossfade`s the audio into the just-rendered main mp4, replacing it. `intro_dur = max(duration, tts_len + 0.4)`. `transition` is an xfade name (whitelist `_XFADE_OK`, fallback `fade`) or `cut` (plain `concat`, no overlap). Handles a main clip with no audio (synthesizes silence).
- **Frontend** — configured in the **Thumbnail step** (`#th-intro*`, stored in `thumb.intro = {enabled, transition, duration, voice}`), since the intro IS the thumbnail. It has **🔊 Preview voice** (`previewVoice` → `POST /api/tts-preview` → play the wav) and **🎬 Preview transition** (`playTransitionPreview` → a client-side canvas animation of thumbnail→content-frame using `drawTrans`; visual approximation, the real render is final). Voice gated on `capabilities.tts`. The **Render step** only shows a read-only note (`#rd-intro-status`, `updateRenderIntroNote`). `renderOnce` reads `thumb.intro`: if enabled it calls `prepareIntro()` (compose thumbnail → `toBlob` → `POST /api/intro-image`) and attaches `body.intro = {transition, duration, text: thumb.text||title, voice}`.
- Distinct from the deferred "in-video text-overlay hook" (text burned over the first seconds of the *content*); this is a separate intro *card* + voiceover. Clipper-only.

### State persistence — only the batch queue
The ad-hoc (single-clip) flow is still **stateless**: restarting the server loses an in-flight ad-hoc job (the frontend forgets its `job_id`). That's intentional. The **only** thing persisted to disk is the batch queue (the SQLite DB `queue/queue.db`, see above) — the owner asked for resumable batch progress. Don't broaden persistence beyond the queue (no server DB, no persisting the ad-hoc flow) without asking.

### YouTube download (yt-dlp) gotchas
Three things must line up or download silently returns only storyboard PNGs (yt-dlp logs a confusing "Requested format is not available" error):
1. **JS runtime declared in opts**: `ydl_opts['js_runtimes'] = {'node': {}}` (see `downloader.py`). Having node on PATH isn't enough — yt-dlp needs it in params.
2. **`yt-dlp-ejs` package installed** — provides the actual challenge solver script bundle. `pip show yt-dlp-ejs` should report it.
3. **Cookies** — YouTube's bot check fires on many videos. `downloader.py` auto-detects a browser profile (Chrome / Firefox / Brave / Edge / Chromium) and passes `cookiesfrombrowser=(browser,)`. Override with env var `CLIPPER_COOKIES_BROWSER=firefox`. Alternatively, drop a Netscape-format `cookies.txt` in project root (`clipper/cookies.txt`) and that takes priority. On Linux Chrome, `secretstorage` (in requirements) is needed to decrypt the cookie store via the OS keyring.

If a download fails, `downloader.download()` re-raises with a user-friendly message listing all three options. Don't replace this with a generic error.

### Static mount must be last
In `main.py`, `app.mount("/", StaticFiles(...))` is at the bottom. It's a catch-all. If you add new routes, put them **above** the mount or they'll be shadowed by the static handler.

## Roadmap (priority order)

Owner said: **test end-to-end first → fix bugs → then features**. Don't jump ahead.

Flow (post-rework): Source → Position → **Render Final (with Caption)** — single click that transcribes (Whisper, cached after first call this session) AND renders + burns caption in one go. There's also a smaller "Quick preview (no caption)" button for fast iteration on box positioning. Then **Done** (cleanup source). The owner explicitly asked for one-shot captioned output; do not re-add a separate "Add Auto Caption" button after the render.

1. **End-to-end test pass** — run a real YouTube clip through it on owner's machine. Fix whatever breaks. Likely candidates: ffmpeg subtitle path on Windows, font fallback on Linux.
2. ~~**Thumbnail generator**~~ — **DONE** (2026-06). A standalone **Thumbnail** step (panel 4): pick a frame on its own scrubber, the text LLM proposes eye-catching headlines (editable, or type your own), then export a 1080×1920 PNG. Entirely client-side canvas (frame capture + compositing + export); the only backend call is `/api/thumbnail-text`. See the "Thumbnail generator" gotcha. NOTE: this is the *cover image* tool. The originally-deferred idea of an **in-video text-overlay hook** (big bold text burned over the first 1-3s of the rendered mp4) is still open — that one needs a new optional field on `RenderRequest` + a renderer change, and is unrelated to the PNG thumbnail.
3. **Drag-to-move existing boxes** — currently drawing a new box replaces the old one. Should allow click-and-drag inside an existing box to reposition (keeping size).
4. **Edit transcript** — clickable word chips in step 3 that open an inline editor. Whisper makes mistakes on Indonesian; user needs to fix before render.
5. **Resize handle on boxes** — corner handles to resize an existing box (keeping aspect locked).
6. **Batch mode** — ✅ largely **DONE** (2026-06) via the **batch queue** (sidebar): upload a JSON keyed by video URL (`{url: [{id,start,end,title,description,bbox_1,bbox_2}]}`) → a background worker downloads + auto-boxes each clip (from the bbox prompts), persisting progress to the SQLite DB `queue/queue.db`; the user opens each ready job to fine-tune and deletes when done. See the "Batch queue" gotcha + `batchqueue.py`. (The original idea was a headless `--batch configs/*.json` CLI; the queue covers the same need with a UI + resumable progress. A CLI entry point on top of `batchqueue` is still possible if wanted. The `config.json` stub remains unused.)
7. ~~Smooth keyframe interpolation~~ — **DONE** (2026-05). Linear interp between keyframes via per-frame ffmpeg `crop` expressions. Smoother curves (cubic/easing) is a future option if the linear pans feel mechanical.
8. ~~Better caption fonts / styling~~ — **DONE** (2026-05). Bundled Anton (default) + Bebas Neue in `assets/fonts/`, libass pointed via `fontsdir=`, fat outline + TikTok-karaoke per-word highlight. See `ROADMAP.md` + "Caption styling" gotcha below. Remaining stretch (box bg / accent-fill / fades) is optional.
9. **Auto-segment long video → clip list (LLM)** — segmentation (which moments to clip, with start/end/title/description) is currently done manually in Gemini web and pasted in. Build it into the tool: transcribe → LLM proposes segments grounded on the transcript → emit the `config.json` job schema. Pluggable provider (Gemini paid API **or** own vLLM/Qwen endpoint like `illustrator`). Ties into batch mode (#6). Full spec in `ROADMAP.md`.
10. ~~Vision-LM automatic crop-box detection (AI auto-box)~~ — **DONE** (2026-06). Type a prompt + drag a range → the Qwen-VL endpoint draws a bbox track that drops into the armed box as editable keyframes. This is ROADMAP issue #1. See the "AI auto-box" gotcha + `vision.py` / `autobox.py`.

## Things NOT to do

- ❌ Don't add a frontend framework (React/Vue/Svelte). Vanilla JS is a deliberate choice.
- ❌ Don't replace `subprocess.run` ffmpeg calls with pure `ffmpeg-python` — `filter_complex` is clearer as a string.
- ❌ Don't add user auth, accounts, or multi-tenancy. Single-user local tool.
- ❌ Don't add a database. Filesystem-as-state is fine.
- ❌ Don't change aspect ratios. Owner picked 3/8 + 5/8 deliberately.
- ❌ Don't leave UI strings in Indonesian — the project is English everywhere now, so all UI text should be in English.
- ❌ Don't add emoji to UI elements unless owner explicitly asks.
- ❌ Don't `pip install` new heavy deps (PyTorch alternatives, transformers, etc.) without asking. Whisper already pulls torch.
- ❌ Don't hide ffmpeg stderr on errors — current code surfaces it in HTTPException detail. Keep that.

## Dev workflow

```bash
# Setup (once)
python -m venv venv
source venv/bin/activate   # or: venv\Scripts\activate on Windows
pip install -r requirements.txt

# Run
cd backend
python main.py
# → http://127.0.0.1:8000
```

No hot reload on frontend (intentional — vanilla). Refresh browser after edits. Backend reload: pass `--reload` to uvicorn if needed, or just Ctrl+C and restart.

### Testing changes

There's no test suite yet. To verify a change:
1. Syntax check: `python -m py_compile backend/*.py` and `node -c frontend/app.js`
2. Manual e2e: short YouTube clip (10-30s), draw 2 boxes, render, eyeball output
3. Check `output/` mp4 plays in QuickTime/VLC and is 1080×1920

When tests are eventually added, put them in `backend/tests/` using pytest. Frontend tests can wait.

## When the owner asks for changes

- The owner is based in Indonesia and communicates in English. Match their register — casual, direct, no corporate speak.
- They prefer being asked clarifying questions **before** big architectural changes, not after.
- Show small diffs, not full file rewrites, when a single function changes.
- Don't pad responses with disclaimers or "let me know if..." — they read fast.

## Quick reference: where stuff lives

| Need to change…                          | File                              |
|------------------------------------------|-----------------------------------|
| Output resolution or layout proportions  | `backend/renderer.py` constants   |
| Caption font defaults / list             | `backend/models.py` + `frontend/index.html` `<select>` |
| Caption position formula                 | `backend/renderer.py` `render()`, `caption_y` |
| Word grouping rules (chunk size, chars)  | `backend/renderer.py` `_group_words()` |
| Whisper model size / language            | `WHISPER_MODEL` / `WHISPER_LANGUAGE` env (`.env`); defaults in `backend/transcriber.py` |
| Aspect ratios for boxes                  | `frontend/app.js` `ASPECT_TOP/BOTTOM` |
| Step UI / panels                         | `frontend/index.html` + `showStep()` in `app.js` |
| Theme colors                             | `frontend/style.css` `:root` vars |
| API routes                               | `backend/main.py`                 |
| Job cleanup behavior                     | `backend/downloader.py` `cleanup_job()`, called from `main.py` `/api/render` |
