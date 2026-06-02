# CLAUDE.md

This file is the project context for Claude Code. Read it fully before touching any file in this repo.

## Project: CLIPPER

Tool buat bikin video vertikal 9:16 (TikTok / Shorts / Reels) dari YouTube. User input URL + range waktu, draw 2 crop box di video sumber, tool auto-transcribe pakai Whisper, lalu render final video dengan caption word-by-word ala TikTok.

**Language**: Codebase pakai English. Komentar UI & dokumentasi user-facing pakai bahasa Indonesia campur English (sesuai gaya owner). Jangan terjemahin string UI yang udah ada ke full English.

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
│   └── models.py        Pydantic request/response schemas
├── frontend/
│   ├── index.html       3 panels (source/position/render), step nav
│   ├── style.css        Dark editorial theme, CSS vars in :root
│   └── app.js           Canvas drawing, aspect-locked drag, API calls
├── temp/                Source videos. Auto-deleted after render.
├── output/              Final renders. Kept.
├── config.json          Stub template (not wired up yet — see Roadmap)
├── requirements.txt
└── README.md            User-facing setup guide (Indonesian)
```

## API contract

All under `/api/`. Bodies are JSON, responses are JSON.

| Method | Path             | Request                              | Response                                     |
|--------|------------------|--------------------------------------|----------------------------------------------|
| POST   | `/api/download`  | `{url, start, end, title, description}` | `{job_id, video_path, duration, width, height}` |
| POST   | `/api/transcribe`| `{job_id}`                           | `{words: [{word, start, end}]}`              |
| POST   | `/api/render`    | `{job_id, title, box1, box2, words, caption_font, caption_size, cleanup}` | `{output_path, filename}` |
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
The video uses a **custom control bar** (play/pause/scrubber/timestamp), NOT native HTML5 `<video controls>`. The native controls don't blend with the dark editorial theme and got covered by the canvas overlay; the user asked for "selayaknya UI" — proper UI. The control bar sits *below* the source stage, so it's always reachable.

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

### No state persistence
Restarting the server loses all in-flight jobs. `temp/` survives, but the frontend forgets its `job_id`. This is intentional — single-user local tool, no need for Redis/SQLite. Don't add persistence without asking.

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
2. **Thumbnail hook** — owner deferred this. Spec when picked up: text overlay (1-3s) at start of video, big bold text, separate config from regular caption. Probably needs a new optional field on `RenderRequest`.
3. **Drag-to-move existing boxes** — currently drawing a new box replaces the old one. Should allow click-and-drag inside an existing box to reposition (keeping size).
4. **Edit transcript** — clickable word chips in step 3 that open an inline editor. Whisper makes mistakes on Indonesian; user needs to fix before render.
5. **Resize handle on boxes** — corner handles to resize an existing box (keeping aspect locked).
6. **Batch mode via config.json** — currently `config.json` is just a stub. Wire it up as a CLI mode: `python main.py --batch configs/*.json` that runs without UI.
7. ~~Smooth keyframe interpolation~~ — **DONE** (2026-05). Linear interp between keyframes via per-frame ffmpeg `crop` expressions. Smoother curves (cubic/easing) is a future option if the linear pans feel mechanical.
8. ~~Better caption fonts / styling~~ — **DONE** (2026-05). Bundled Anton (default) + Bebas Neue in `assets/fonts/`, libass pointed via `fontsdir=`, fat outline + TikTok-karaoke per-word highlight. See `ROADMAP.md` + "Caption styling" gotcha below. Remaining stretch (box bg / accent-fill / fades) is optional.
9. **Auto-segment long video → clip list (LLM)** — segmentation (which moments to clip, with start/end/title/description) is currently done manually in Gemini web and pasted in. Build it into the tool: transcribe → LLM proposes segments grounded on the transcript → emit the `config.json` job schema. Pluggable provider (Gemini paid API **or** own vLLM/Qwen endpoint like `illustrator`). Ties into batch mode (#6). Full spec in `ROADMAP.md`.

## Things NOT to do

- ❌ Don't add a frontend framework (React/Vue/Svelte). Vanilla JS is a deliberate choice.
- ❌ Don't replace `subprocess.run` ffmpeg calls with pure `ffmpeg-python` — `filter_complex` is clearer as a string.
- ❌ Don't add user auth, accounts, or multi-tenancy. Single-user local tool.
- ❌ Don't add a database. Filesystem-as-state is fine.
- ❌ Don't change aspect ratios. Owner picked 3/8 + 5/8 deliberately.
- ❌ Don't auto-translate UI strings to English.
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

- Owner is in Indonesia, communicates in mixed ID/EN. Match their register — casual, direct, no corporate speak.
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
