# Roadmap / Notes

Planned future work. Each item is written issue-style so it can be copy-pasted into GitHub Issues.

See also the "Roadmap (priority order)" section in `CLAUDE.md` for the existing backlog.

---

## Batch queue — JSON import + background download/auto-box — DONE (2026-06)

**Status:** ✅ shipped. A persistent sidebar queue (`batchqueue.py` + queue-* frontend).

Upload a JSON keyed by video URL — `{ "<url>": [ {id,start,end,title,description,bbox_1,bbox_2}, ... ] }` — and walk away. A single background worker downloads each clip and predicts both crop boxes from the `bbox_1`/`bbox_2` **text prompts**, one job at a time, persisting to a local **SQLite** DB `queue/queue.db` (jobs + a relational keyframes table — survives restart). The sidebar lists jobs by id with live status; open a `ready` one to fine-tune the boxes (auto-saved back). Then hit ▶ (or "Render all ready") → the same worker does **transcribe + render** one at a time → `done` with a downloadable mp4 — so even the heavy GPU/CPU step never runs two at once. Delete a job when done. Covers the old `--batch config.json` idea (CLAUDE.md roadmap #6) with a UI + resumable progress. illustrator's copy stops at predict (render stays manual — needs the Illustration step; the JSON's `segment_seconds` pre-fills that step instead). See CLAUDE.md "Batch queue". **Module is `batchqueue.py`, not `queue.py`** (stdlib shadow).

---

## Vision-LM automatic crop-box detection (replace manual boxes)

**Status:** ✅ DONE 2026-06 (v1). "AI Auto-box" in Step 2: pick a Box, type what to track
(e.g. "the speaker"), drag a single pair of range handles, hit **Generate** → the Qwen-VL
endpoint (`vision.py`, `VISION_*` env, shared with browser_agent) is asked for the subject's
box on frames sampled across the range (`autobox.py`, ThreadPool×4), returning a keyframe
track (`interp='linear'`, source px) that drops into the armed box and stays fully editable.
Empirically grounded: coords are 0-1000 normalized → `px=v/1000*W,H`; regex parse (output is
non-deterministic); largest-area box = subject; **absent subject → no box** (a run of undetected frames becomes a `gap`/black-slot keyframe, so the box is only drawn while the subject is on screen).
Verified on a real clip (detected the speaker on ~8/8 frames). **Remaining (stretch):** the
two-box auto-split + on-device tracker alternative below are not done — current v1 does one
armed box per Generate via the vision LM.

**Current behavior**

In the Position step the user manually draws and keyframes the crop boxes (Box 1 top slot, Box 2 bottom slot). Each keyframe is `{t, x, y, w, h, interp, fit}` in source pixel coordinates; the user sets these by dragging on the canvas overlay. See [frontend/app.js](frontend/app.js) (canvas drag → keyframe upsert) and [backend/renderer.py](backend/renderer.py) (`_crop_chain` turns keyframes into the ffmpeg filter graph).

**Limitation**

Framing every clip by hand is the slowest part of the workflow. For talking-head / reaction content the subject of interest (a face, a speaker, on-screen text) is usually obvious and could be tracked automatically.

**Proposed**

Use a vision LM (or a lighter detector/tracker) to propose the crop boxes automatically, then let the user tweak.

- Sample frames across the clip (e.g. 1–2 fps) and run detection (face/person/salient-region, or a vision LM prompted for "where's the subject") to get a bounding box per sampled frame.
- Convert detections into the existing keyframe schema (`x/y/w/h` in source pixels, with `interp='linear'` for smooth tracking) so the rest of the render pipeline is unchanged.
- Keep it as a **suggestion**: populate the boxes, then drop the user into the current Position editor to adjust/confirm — don't auto-render blindly.
- Two-box case: heuristic or LM split (e.g. top = reaction cam, bottom = source content), or let the user assign which detected track goes to which slot.

**Open questions**

- On-device tracker (fast, cheap, e.g. a small detector + simple tracker) vs. vision LM per sampled frame (smarter, slower, costs tokens).
- Sampling rate vs. smoothness — too sparse and the box jumps; too dense and it's slow/expensive.
- How to keep the auto-keyframes editable without producing hundreds of keyframes (decimate / fit to a few keyframes).
- Respect the locked 3:2 / 9:10 slot aspects (current design intentionally keeps boxes free-form and lets ffmpeg cover-fit).

---

## Better-looking caption fonts / styling (current captions look too plain)

**Status:** DONE (2026-05) — bundled OFL fonts (Anton default + Bebas Neue) in
`assets/fonts/`, libass pointed at them via `subtitles=...:fontsdir=`, fatter
outline (6) + shadow (3), and TikTok-karaoke per-word highlight (active word
recolored to accent + slight scale pop, driven by Whisper per-word timestamps in
`_group_words`/`_build_ass`). Verified libass loads `Anton-Regular.ttf` (not a
fallback). Stretch ideas below kept for later (box bg, accent-fill option, fades).

**Current behavior**

Captions are burned via an ASS subtitle file built in [backend/renderer.py](backend/renderer.py) `_build_ass()`. The style line is fixed: white fill, black 4px outline, 2px shadow, `Alignment 5` (centered), font + size from the request (`caption_font`, `caption_size`). The font is picked from a dropdown in [frontend/index.html](frontend/index.html) backed by `CAPTION_FONTS` in [backend/models.py](backend/models.py): Bricolage Grotesque, JetBrains Mono, Inter, Arial, Impact.

**Limitation**

The output captions look very plain / generic — not the punchy TikTok-style look. Two root causes, probably both:

1. **Font not actually installed on the host.** The Google Fonts links in `index.html` only load fonts for the *browser preview*. ffmpeg/libass burns text using fonts installed on the **host OS**. So "Bricolage Grotesque" in the dropdown almost certainly isn't present for libass → it silently falls back to a default plain sans. The preview and the burned output don't match, and the burned one looks generic.
2. **Styling is minimal.** Just outline + shadow. No bold weight enforcement beyond `Bold=1`, no thick stroke, no highlight/box background, no per-word pop — the things that make TikTok/Shorts captions read as "designed".

**Proposed**

- **Bundle the fonts** in the repo (e.g. `assets/fonts/*.ttf`) and point libass at them so the burned output uses the real font, not a fallback. Either pass `fontsdir=` to the `subtitles=` filter or set `force_style` / `attachments`. Verify the chosen font name in the ASS `Style:` line matches the font's internal family name.
- **Add bolder display fonts** built for short-form video: e.g. Montserrat ExtraBold/Black, Anton, "The Bold Font", Komika — update `CAPTION_FONTS` + the dropdown to match what's bundled.
- **Richer style**: thicker outline, optional drop shadow vs. solid box background (`BorderStyle=3` for a box), accent-color fill option. Route any new colors through `to_ass_color()`.
- (Stretch) **per-word highlight / pop**: the active word colored or scaled up — needs karaoke-style `\k` tags or per-word `\t` animation in `_build_ass()`. Bigger change; keep separate from the font-fix above.

**Open questions**

- Which fonts to bundle (licensing — prefer OFL/Apache fonts that allow redistribution; Impact/Komika are not freely redistributable).
- Expose styling (outline width, box vs. shadow, accent color) as new optional fields on `RenderRequest` + UI controls, or ship one opinionated "good" preset first and add knobs later?
- Make sure the Step 2/3 preview canvas styling stays roughly in sync with the burned ASS so what-you-see ≈ what-you-get.

---

## Auto-segment a long video into clips (LLM-proposed start/end/title/description)

**Status:** planned

**Current behavior**

Picking *which* moments to clip out of a long video is done **manually, outside the tool**. The owner currently pastes the YouTube URL into Gemini (web, free tier) with a prompt like *"clip all the reaction segments"* and asks for output in this format:

```json
[
  {"start": "00:05:08", "end": "00:06:03", "description": "Reacting to the minister's opinion...", "title": "The Hard Life of Guys / Train Carriage Fix"},
  {"start": "00:06:03", "end": "00:06:48", "description": "Reacting to a comedy pickup-line video...", "title": "Worst Pickup Lines Ever"},
  ...
]
```

Then each segment is fed into clipper one at a time (or would be, via batch `config.json`). Note: this `{start, end, title, description}` shape **already matches** the per-job schema in `config.json` (see batch-mode item above) — so the manual Gemini step is effectively hand-authoring the batch config.

**Limitation**

- The segmentation lives in a separate tool (Gemini web). Copy-pasting JSON between apps is manual and breaks the one-tool flow.
- Free Gemini web has no API contract — can't automate, rate-limited, output format drifts.
- The model only sees what it knows about the video (title/description/its own knowledge), not the actual transcript — so boundaries/timestamps can be approximate.

**Proposed**

Build segmentation **into** clipper as a step before Position: input URL (+ optional instruction like "clip all the reaction segments"), get back a list of `{start, end, title, description}` segments the user can review/edit, then each becomes a clip job.

- **Feed the transcript, not just the URL.** Whisper already produces word-level timestamps (`transcriber.py`). Run it on the full source (or a downloaded long video), chunk the transcript, and ask the LLM to propose segment boundaries with real timestamps + a title + a one-line description per segment. Grounding on the transcript makes start/end accurate instead of guessed.
- **Pluggable LLM provider** (owner's words: "later we can use the paid Gemini API or use our own model"):
  - **Gemini paid API** — official `google-genai` SDK, stable JSON output (response schema / JSON mode).
  - **Own model (vLLM)** — the internal OpenAI-compatible Qwen endpoint already used by `email_categorizer` and the `illustrator` sibling (`VLLM_BASE_URL`/`VLLM_MODEL`/`VLLM_API_KEY`). Reuse the same client pattern (`illustrator/backend/llm.py`).
  - Abstract behind one `segment_video(transcript, instruction) -> [{start,end,title,description}]` function with a `SEGMENTER_PROVIDER` env switch, so swapping providers doesn't touch the rest.
- **Output → batch config**: emit exactly the `config.json` job schema so this dovetails with batch mode (item above). User reviews the list in the UI, tweaks, then renders all (or sends to Position one by one).
- Keep timestamps as `HH:MM:SS` strings (matches `config.json` + the `/api/download` `start`/`end` params).

**Open questions**

- Transcript of a *full* long video can be big — chunk + map-reduce the segmentation prompt, or summarize first? Cost/latency vs. accuracy.
- Whisper on a full long video is slow on CPU — do we require the user to set a coarse range first, or accept the wait / require GPU?
- How much should the user steer it — free-text instruction ("clip all the reaction segments") vs. presets (reactions / highlights / chapters)?
- Validate/clamp LLM timestamps against actual duration (LLM can hallucinate times past the end).
- Provider abstraction: where do per-provider keys live (`.env`), and what's the default when none is set?

---

## Progress / loading bar during render

**Status:** planned

**Current behavior**

`/api/render` is a single **blocking** request — it runs the whole ffmpeg compose (+ Whisper transcribe on the captioned path) and only returns when done. The frontend just shows a static status string ("Rendering + caption…") in `#rd-status`. There's no indication of progress or how long is left.

**Limitation**

For longer clips the UI looks **frozen** — no feedback for tens of seconds (or minutes on CPU). The user can't tell if it's working or hung, and might re-click / give up.

**Proposed**

A real progress bar after hitting Render.

- **Parse ffmpeg progress.** Run ffmpeg with `-progress pipe:1` (or parse `out_time_ms`/`time=` from stderr) and compute `% = out_time_ms / total_duration`. Total duration is already known (ffprobe in `downloader.py` / the render sub-range).
- **Make render non-blocking.** Kick the render off as a background task keyed by `job_id`, return immediately, and keep a small **in-memory** progress map `{job_id: {stage, percent}}` (ephemeral — consistent with the no-DB / filesystem-state design; lost on restart is fine).
- **Expose progress** via `GET /api/progress/{job_id}` (frontend polls every ~0.5–1s) or Server-Sent Events (`text/event-stream`) for push updates.
- **Frontend**: a determinate progress bar bound to the percent, plus a stage label. Swap the static `#rd-status` text for the bar; on 100% / done, fetch the result and show the player as today.
- **Stages**: the captioned path has two slow phases — Whisper transcribe then ffmpeg render. Show transcribe as an indeterminate spinner (Whisper doesn't expose easy progress) and ffmpeg as the determinate bar, or split the bar 0–30% transcribe / 30–100% render.

Applies to the `illustrator` sibling too (same blocking render + static status pattern) — share the approach once settled here.

**Open questions**

- SSE vs. simple polling — polling is dead-simple and fits the vanilla-JS no-framework style; SSE is smoother but more moving parts.
- Background task mechanism: FastAPI `BackgroundTasks` vs. a thread vs. `asyncio.create_subprocess_exec` for ffmpeg so the event loop can read progress without blocking.
- Whisper transcribe progress is hard to surface granularly — accept an indeterminate phase, or estimate from audio duration?
- Concurrency: in-memory progress map assumes one render per `job_id` at a time — fine for single-user local tool, but document it.

---

## Thumbnail generator (cover image for the clip) — DONE (2026-06)

**Status:** ✅ shipped. A standalone **Thumbnail** step (panel 4).

**What shipped:** pick a frame on a dedicated scrubber → the text LLM proposes eye-catching headline ideas (`POST /api/thumbnail-text`), editable or type your own → style it (font / size / color / outline / position / UPPERCASE / shade + a cover-crop focus pan) → **Download PNG** at 1080×1920.

**How it differs from the original proposal:** built **client-side on a canvas** (frame capture, cover-crop, text compositing, PNG export) rather than ffmpeg single-frame — instant WYSIWYG, no new temp/output files, no `to_ass_color()` reuse. Aspect is **9:16 only** (the chosen output format) instead of 16:9/1:1 options. The only backend addition is the headline-text LLM call; headlines come back in the content's language. See CLAUDE.md "Thumbnail generator".

**Still open (different feature):** an **in-video text-overlay hook** (big bold text burned over the first 1-3s of the rendered mp4) — that one needs a `RenderRequest` field + a renderer change. Don't conflate it with the PNG thumbnail above.

---

## Transcription accuracy (Whisper) — "the voice isn't accurate enough"

**Status:** ✅ mostly DONE 2026-06 (shared with illustrator — `transcriber.py` is identical).
Done: auto GPU (torch fixed to `cu128`), default model **medium** on GPU, `WHISPER_LANGUAGE=id`
(via `clipper/.env`), `condition_on_previous_text=False`, VRAM freed after transcribe + CPU fallback
on OOM. **Remaining (stretch):** `large-v3`/faster-whisper for maximum accuracy, and `initial_prompt`
from title/description (the param already exists, it just needs to be plumbed into `/api/transcribe`).

**Why**

Whisper often mishears, especially **Indonesian** + **proper names/specialized terms** (names of
people, places, religious/technical terms). Captions end up with wrong words, and because per-word
timing is used for the karaoke highlight (`_group_words`/`_build_ass`), a wrong word means the
highlight is off too. Roadmap #4 ("Edit transcript") only patches it **manually after** the error;
this issue is about making the transcription more correct **from the start**. (See also the "Whisper
model" gotcha in CLAUDE.md.)

**Root cause** (`backend/transcriber.py`)

1. Model was **hardcoded to `base`** — the smallest useful tier, the weakest for non-English.
2. **No `language` hint** — `model.transcribe()` auto-detects; easy to miss or code-switch
   on Indonesian content.
3. **No `initial_prompt`** — proper names / domain terms aren't biased → frequently misspelled.
4. **Not configurable via env** — changing the model meant editing code.
5. `condition_on_previous_text=True` (default) — can cause repetition/hallucination over music/silence.

**Proposed**

- `WHISPER_MODEL` env (raise the default to `small`/`medium`; `large-v3` if a GPU is available).
- `WHISPER_LANGUAGE` env (e.g. `id`) → `transcribe(language=...)`, with override.
- Optional `initial_prompt` to bias vocabulary (from title/description) → consistent proper names &
  terms.
- Set `condition_on_previous_text=False` (or expose it) to reduce loops/hallucination.
- **(Stretch, needs approval)** swap to `faster-whisper` (CTranslate2): much faster +
  more accurate + built-in VAD. This is a **tech change / new dependency** → get owner approval first (see "Things NOT to do").

**Implementation notes**

- `transcriber.py` is **identical in clipper & illustrator** → change it once, mirror to the other.
- `get_model` is `lru_cache`d by name — safe for swapping model sizes.
- A bigger model = slower on CPU → connects to the GPU/latency open question in the
  Auto-segment issue.

**Open questions**

- Default model tier vs. CPU latency — raise the default or let the owner choose (per the
  "Whisper model" gotcha: *"Don't auto-detect; let owner choose"*)?
- faster-whisper = new dependency (CTranslate2) — approve?
- Language: fix to `id` or keep auto-detect with an override?

**Acceptance**

- Indonesian speech + proper names transcribe accurately enough that captions read correctly & per-word
  timing stays in sync; minimal garbled words / repetition.
