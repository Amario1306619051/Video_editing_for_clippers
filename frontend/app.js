// CLIPPER — vanilla JS. No framework, no build step.
// Coordinate spaces:
//   1. SOURCE  — actual video pixels (state.source.width × state.source.height)
//   2. OVERLAY — rendered <video> size in browser
//   3. PREVIEW — fixed 270×480 canvas (1/4 of 1080×1920)
// Always route mouse coords through overlayToSource() / sourceToOverlay().
//
// Keyframes: each box stores an array of {t, x, y, w, h} samples.
// Render interpolates linearly between consecutive keyframes per frame.
// Drawing a box at time T upserts a keyframe at T (replaces if existing
// keyframe is within KF_EPS seconds).

const OUT_W = 1080;
const OUT_H = 1920;
const TOP_H = 720;        // 3/8 of 1920
const BOTTOM_H = 1200;    // 5/8 of 1920
const ASPECT_TOP = OUT_W / TOP_H;       // 1.5  (3:2)  — always for box 1
const ASPECT_BOTTOM = OUT_W / BOTTOM_H; // 0.9  (9:10) — always for box 2

const PREVIEW_W = 270;
const PREVIEW_H = 480;

const KF_EPS = 0.1;  // seconds — keyframes within this are merged

const state = {
  step: 1,
  jobId: null,
  source: null,             // {width, height, duration, video_path}
  keyframes: { 1: [], 2: [] },
  activeBox: null,          // null = canvas inactive ; 1 or 2 = active draw target
  currentTime: 0,
  words: [],
  caption: { font: 'Anton', size: 64 },  // must match the default <option> in index.html
  renderRange: { start: null, end: null },  // sub-range in seconds, null = open
  drag: null,
  abDrag: null,                          // 'start' | 'end' while dragging a range handle
  autoRange: { start: 0, end: null },    // AI auto-box time range (null end = clip end)
  result: null,
  activeQueueKey: null,                   // batch-queue job currently loaded (null = ad-hoc)
  queueSig: null,                         // signature of last auto-saved queue state
  autoObs: '',                            // model's mid-clip observation (prepended to autobox prompts)
  sounds: [],                             // soundboard library (from /api/soundboard)
  sfx: [],                                // SFX placements for this clip (sent at render)
  sfxPreview: null,                       // currently-playing preview Audio
  ills: [],                               // full-frame illustration cutaways {url,thumb,t_start,t_end}
  illDrag: null,                          // {i, mode:'move'|'resize', ...} while dragging a block
  keep: [],                               // keep-windows {start,end} (everything else cut at render)
  keepA: null,                            // pending in-point while marking A→B
  keepDrag: null,                         // drag state for a keep block
  sfxDrag: null,                          // drag state for a sound bar/pin
};

// Fit mode is per-keyframe — each kf carries `fit: 'cover'|'blur_pad'` and
// applies for the segment that starts at that kf (matching `interp` semantics).
// New kfs inherit fit from the nearest prior kf of the same box (cover if none).

const $ = (sel) => document.querySelector(sel);
const els = {};

document.addEventListener('DOMContentLoaded', () => {
  els.video = $('#source-video');
  els.stage = $('#source-stage');
  els.overlay = $('#overlay');
  els.preview = $('#preview');
  els.preview2 = $('#preview-2');
  els.previewMeta = $('#preview-meta');
  els.wordsBox = $('#words-box');
  els.capFont = $('#cap-font');
  els.capSize = $('#cap-size');
  els.dots1 = $('#dots-1');
  els.dots2 = $('#dots-2');
  els.timelineCursor = $('#timeline-cursor');
  els.curTime = $('#cur-time');
  els.kfCount1 = $('#kf-count-1');
  els.kfCount2 = $('#kf-count-2');
  els.abRange = $('#ab-range');
  els.abBand = $('#ab-band');
  els.abHStart = $('#ab-h-start');
  els.abHEnd = $('#ab-h-end');
  els.abStartLbl = $('#ab-start-lbl');
  els.abEndLbl = $('#ab-end-lbl');
  els.abDensity = $('#ab-density');

  document.querySelectorAll('.steps .step').forEach(b => {
    b.addEventListener('click', () => {
      const n = +b.dataset.step;
      if (canGoToStep(n)) showStep(n);
    });
  });
  document.querySelectorAll('[data-go]').forEach(b => {
    b.addEventListener('click', () => showStep(+b.dataset.go));
  });

  $('#btn-download').addEventListener('click', doDownload);
  $('#btn-continue').addEventListener('click', doContinue);
  $('#btn-render').addEventListener('click', doRender);
  $('#btn-render-nocap').addEventListener('click', doRenderNoCaption);

  // Render sub-range inputs
  $('#rd-start').addEventListener('input', onRangeInput);
  $('#rd-end').addEventListener('input', onRangeInput);
  $('#rd-start-from-cur').addEventListener('click', () => setRangeFromCurrent('start'));
  $('#rd-end-from-cur').addEventListener('click', () => setRangeFromCurrent('end'));
  $('#rd-clear').addEventListener('click', clearRenderRange);
  $('#btn-done').addEventListener('click', doDone);
  $('#btn-kf-delete').addEventListener('click', deleteKeyframeAtCurrent);
  $('#btn-kf-toggle-interp').addEventListener('click', toggleInterpAtCurrent);
  $('#kf-list').addEventListener('click', onKfListClick);

  // AI auto-box
  document.querySelectorAll('.ab-gen').forEach(b =>
    b.addEventListener('click', () => doAutoBox(+b.dataset.box)));
  els.abHStart.addEventListener('mousedown', (e) => startAbDrag(e, 'start'));
  els.abHEnd.addEventListener('mousedown', (e) => startAbDrag(e, 'end'));
  window.addEventListener('mousemove', onAbDragMove);
  window.addEventListener('mouseup', () => { state.abDrag = null; });

  // custom video controls
  $('#btn-play').addEventListener('click', togglePlay);
  $('#btn-back-1').addEventListener('click', () => seekBy(-1));
  $('#btn-fwd-1').addEventListener('click', () => seekBy(+1));
  $('#scrubber').addEventListener('input', (e) => {
    if (!els.video.duration) return;
    els.video.currentTime = +e.target.value;
  });

  document.querySelectorAll('.box-pill').forEach((pill, idx) => {
    const n = idx + 1;
    pill.addEventListener('click', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      // toggle: click active pill = deactivate
      setActiveBox(state.activeBox === n ? null : n);
    });
  });
  document.querySelectorAll('.box-pill button[data-clear]').forEach(b => {
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      const n = +b.dataset.clear;
      state.keyframes[n] = [];
      renderTimeline();
      redrawOverlay();
      redrawPreviews();
    });
  });

  document.addEventListener('keydown', (e) => {
    if (state.step !== 2) return;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
    if (e.key === '1' || e.key === '2') {
      e.preventDefault();
      setActiveBox(+e.key);
    } else if (e.key === 'Escape') {
      setActiveBox(null);
    } else if (e.key === ' ') {
      e.preventDefault();
      togglePlay();
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      seekBy(-1);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      seekBy(+1);
    } else if (e.key === 'Delete' || e.key === 'd' || e.key === 'D') {
      e.preventDefault();
      deleteKeyframeAtCurrent();
    } else if ((e.key === 'Backspace' || e.key === 'x' || e.key === 'X') && e.shiftKey) {
      // Shift+X or Shift+Backspace = clear entire active box
      e.preventDefault();
      clearActiveBox();
    }
  });

  els.overlay.addEventListener('mousedown', onDragStart);
  els.overlay.addEventListener('mousemove', onHoverCursor);
  window.addEventListener('mousemove', onDragMove);
  window.addEventListener('mouseup', onDragEnd);

  els.video.addEventListener('loadedmetadata', () => {
    resizeOverlay();
    redrawOverlay();
    const dur = els.video.duration || 0;
    $('#scrubber').max = dur;
    $('#time-dur').textContent = formatTime(dur);
  });
  els.video.addEventListener('timeupdate', onTimeUpdate);
  els.video.addEventListener('seeked', onTimeUpdate);
  els.video.addEventListener('play',  () => updatePlayBtn(true));
  els.video.addEventListener('pause', () => updatePlayBtn(false));
  els.video.addEventListener('ended', () => updatePlayBtn(false));
  window.addEventListener('resize', () => {
    resizeOverlay();
    redrawOverlay();
    renderTimeline();
  });

  els.capFont.addEventListener('change', () => {
    state.caption.font = els.capFont.value;
    redrawPreview(els.preview2);
  });
  els.capSize.addEventListener('input', () => {
    state.caption.size = +els.capSize.value || 64;
    redrawPreview(els.preview2);
  });

  wireThumb();
  wireQueue();
  wireSfx();
  wireIll();
  wireTrim();
  updatePills();
  initCapabilities();
});

// Disable the AI auto-box UI when the backend has no vision model configured.
async function initCapabilities() {
  try {
    const r = await fetch('/api/capabilities');
    if (!r.ok) return;
    const caps = await r.json();
    if (!caps.vision) {
      document.querySelectorAll('.ab-gen, #ab-prompt-1, #ab-prompt-2').forEach(el => { el.disabled = true; });
      setStatus('ab-status', 'AI auto-box is off — no vision model configured (set VISION_BASE_URL / VISION_MODEL in .env).', 'err');
    }
    if (!caps.thumbnail) {
      const g = $('#btn-thumb-gen');
      if (g) g.disabled = true;
      setStatus('thumb-gen-status', 'AI ideas are off — no text model configured. You can still type your own headline.', 'err');
    }
    if (!caps.pexels) {
      const b = $('#btn-ill-search'), q = $('#ill-query');
      if (b) b.disabled = true;
      if (q) q.disabled = true;
      setStatus('ill-status', 'Illustration search is off — set PEXELS_API_KEY in clipper/.env (same key as illustrator).', 'err');
    }
    if (!caps.tts) {
      const vc = $('#th-intro-voice');
      if (vc) { vc.checked = false; vc.disabled = true; vc.closest('label').title = 'No TTS engine — install gTTS (pip install gTTS) or drop a Piper voice into clipper/voices/. Intro will be silent.'; }
      const pv = $('#btn-th-voice'); if (pv) pv.disabled = true;
      thumb.intro.voice = false;   // programmatic .checked fires no 'change' — sync the state too
      updateRenderIntroNote();
    }
  } catch (e) { /* capabilities are best-effort; manual boxing + manual headline still work */ }
}

// ───────────────────────── step nav ─────────────────────────
function canGoToStep(n) {
  if (n === 1) return true;
  if (n === 2) return !!state.jobId;
  if (n === 3) return !!state.jobId;
  if (n === 4) return !!state.jobId;
  if (n === 5) return !!state.jobId;
  if (n === 6) return !!state.jobId;
  if (n === 7) return !!state.jobId;
  return false;
}

function showStep(n) {
  state.step = n;
  for (let i = 1; i <= 7; i++) {
    $(`#panel-${i}`).classList.toggle('hidden', i !== n);
  }
  document.querySelectorAll('.steps .step').forEach(b => {
    b.classList.toggle('active', +b.dataset.step === n);
  });
  if (n === 2) {
    requestAnimationFrame(() => {
      resizeOverlay();
      renderTimeline();
      redrawOverlay();
      redrawPreviews();
      renderAutoRange();
    });
  }
  if (n === 3) {
    renderWordChips();
    redrawPreview(els.preview2);
    updateRenderIntroNote();
  }
  if (n === 4) {
    requestAnimationFrame(initThumbStep);
  }
  if (n === 5) {
    requestAnimationFrame(initSfxStep);
  }
  if (n === 6) {
    requestAnimationFrame(initIllStep);
  }
  if (n === 7) {
    requestAnimationFrame(initTrimStep);
  }
}

// ───────────────────────── coord helpers ─────────────────────────
function overlayToSource(px, py) {
  const r = els.overlay.getBoundingClientRect();
  const sx = (px / r.width) * state.source.width;
  const sy = (py / r.height) * state.source.height;
  return { x: sx, y: sy };
}

function sourceToOverlay(sx, sy) {
  const r = els.overlay.getBoundingClientRect();
  return {
    x: (sx / state.source.width) * r.width,
    y: (sy / state.source.height) * r.height,
  };
}

function resizeOverlay() {
  if (!els.video.videoWidth) return;
  const r = els.video.getBoundingClientRect();
  els.overlay.width = r.width;
  els.overlay.height = r.height;
}

// ───────────────────────── active-box / draw arming ─────────────────────────
// Canvas overlay is inactive (pointer-events: none) when activeBox === null —
// that's the only state in which the user can interact with the video stage
// normally. Pick a Box pill (or hit 1/2) to arm a target; canvas takes clicks
// then. Pressing Escape, clicking the pill again, or anything that nulls
// activeBox returns control to the video.
function setActiveBox(n) {
  state.activeBox = n;
  const stage = $('#source-stage');
  if (stage) stage.classList.toggle('draw-active', n !== null);
  if (n === null && state.drag) {
    state.drag = null;
    redrawOverlay();
  }
  updatePills();
}

// ───────────────────────── playback controls ─────────────────────────
function togglePlay() {
  if (!els.video || !els.video.src) return;
  if (els.video.paused) els.video.play(); else els.video.pause();
}

function seekBy(delta) {
  if (!els.video || !els.video.duration) return;
  els.video.currentTime = Math.max(0, Math.min(els.video.duration, els.video.currentTime + delta));
}

function updatePlayBtn(playing) {
  const btn = $('#btn-play');
  if (!btn) return;
  btn.textContent = playing ? '❚❚' : '▶';
  btn.classList.toggle('playing', playing);
}

function formatTime(t) {
  if (!isFinite(t)) return '0:00.0';
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

// ───────────────────────── aspect lock ─────────────────────────
// CONTAIN behavior: the locked box stays *inside* the user's drag rectangle.
// Pure horizontal / vertical drags need special-casing so the box doesn't
// collapse to a line — fall back to the non-zero dimension as the driver.
function lockAspect(w, h, aspect) {
  const sw = w < 0 ? -1 : 1;
  const sh = h < 0 ? -1 : 1;
  const aw = Math.abs(w);
  const ah = Math.abs(h);
  const TINY = 6;  // px in source space — below this, dimension is "not driven"

  if (aw < TINY && ah >= TINY) {
    // pure vertical drag → height drives, width derived
    return { w: sw * ah * aspect, h: sh * ah };
  }
  if (ah < TINY && aw >= TINY) {
    return { w: sw * aw, h: (sh * aw) / aspect };
  }
  // both dimensions meaningful → contain (box fits inside drag area)
  if (aw / aspect <= ah) {
    return { w: sw * aw, h: (sh * aw) / aspect };
  } else {
    return { w: sw * ah * aspect, h: sh * ah };
  }
}

function aspectForBox(n) {
  return n === 1 ? ASPECT_TOP : ASPECT_BOTTOM;
}

// ───────────────────────── render-area (crop) guide ─────────────────────────
// Boxes are FREE-FORM (draw any size/AR). The slot has a fixed AR, so in COVER
// mode the render keeps only the centered slot-AR sub-rect of the box (the rest
// is cropped); in BLUR_PAD mode the whole box renders (contained, blurred pad).
// coverKeepRect returns the kept sub-rect for cover — drawn as a guide on the
// overlay so what you see kept == the right-side preview == the render.
// Mirrors backend renderer._crop_chain cover (scale-cover + centered crop) and
// the preview drawCover math.
function coverKeepRect(box, aspect) {
  const boxAR = box.w / box.h;
  let kw, kh;
  if (boxAR > aspect) { kh = box.h; kw = box.h * aspect; }  // box wider → crop L/R
  else { kw = box.w; kh = box.w / aspect; }                 // box taller → crop T/B
  return { x: box.x + (box.w - kw) / 2, y: box.y + (box.h - kh) / 2, w: kw, h: kh };
}

// ───────────────────────── keyframe interpolation ─────────────────────────
// Mirrors backend renderer._build_expr — per-keyframe `interp` mode:
//   'hold'   → constant from this kf until next (frame N == frame N-1)
//   'linear' → smooth lerp to next kf
// Default is 'hold' (matches user's mental model: box stays put unless told to pan).
function interpAt(kfs, t, key) {
  if (!kfs.length) return null;
  if (kfs.length === 1) return kfs[0][key];
  if (t <= kfs[0].t) return kfs[0][key];
  const last = kfs[kfs.length - 1];
  if (t >= last.t) return last[key];
  for (let i = 0; i < kfs.length - 1; i++) {
    const k0 = kfs[i], k1 = kfs[i + 1];
    if (t >= k0.t && t < k1.t) {
      // Hold towards a gap kf — its xywh are dummies, never interp into them.
      if ((k0.interp || 'hold') === 'hold' || k1.gap) return k0[key];
      const span = k1.t - k0.t;
      const f = span > 0 ? (t - k0.t) / span : 0;
      return k0[key] + (k1[key] - k0[key]) * f;
    }
  }
  return last[key];
}

function nearestKeyframe(n, t) {
  const kfs = state.keyframes[n];
  if (!kfs.length) return null;
  return kfs.reduce((best, k) =>
    Math.abs(k.t - t) < Math.abs(best.t - t) ? k : best, kfs[0]);
}

// Returns the index of the kf whose segment contains time t — i.e. the kf that
// defines the box currently being displayed. Used by the in-overlay × delete handle:
// clicking the box's × always refers to "this kf", not just an exact-time match.
function activeSegmentKfIndex(n, t) {
  const kfs = state.keyframes[n];
  if (!kfs.length) return -1;
  if (t < kfs[0].t) return 0;
  for (let i = 0; i < kfs.length; i++) {
    const next = kfs[i + 1];
    if (!next || t < next.t) return i;
  }
  return kfs.length - 1;
}

function boxAt(n, t) {
  const kfs = state.keyframes[n];
  if (!kfs.length) return null;
  // If the segment containing t is a gap, the box is invisible there.
  const idx = activeSegmentKfIndex(n, t);
  if (idx >= 0 && kfs[idx].gap) return null;
  return {
    x: interpAt(kfs, t, 'x'),
    y: interpAt(kfs, t, 'y'),
    w: interpAt(kfs, t, 'w'),
    h: interpAt(kfs, t, 'h'),
  };
}

function upsertKeyframe(n, box, t) {
  const kfs = state.keyframes[n];
  for (let i = 0; i < kfs.length; i++) {
    if (Math.abs(kfs[i].t - t) < KF_EPS) {
      // Preserve interp + fit on re-upsert (user moved/resized at same time)
      const prevInterp = kfs[i].interp || 'hold';
      const prevFit = kfs[i].fit || 'cover';
      kfs[i] = { t, ...box, interp: prevInterp, fit: prevFit };
      return;
    }
  }
  // New kf inherits fit from the nearest prior kf of this box
  kfs.push({ t, ...box, interp: 'hold', fit: inheritFit(n, t) });
  kfs.sort((a, b) => a.t - b.t);
}

function defaultFit(n) {
  // owner's defaults: box1 (streamer) = cover, box2 (content) = blur_pad —
  // the content keeps its full aspect with blurred padding
  return n === 2 ? 'blur_pad' : 'cover';
}

function inheritFit(n, t) {
  const kfs = state.keyframes[n];
  if (!kfs.length) return defaultFit(n);
  let best = null;
  for (const k of kfs) {
    if (k.t <= t && (!best || k.t > best.t)) best = k;
  }
  return (best ? best.fit : kfs[0].fit) || defaultFit(n);
}

// Which fit mode applies at currentTime for box n, mirroring backend per-segment logic.
function currentFit(n) {
  const kfs = state.keyframes[n];
  if (!kfs.length) return 'cover';
  if (state.currentTime < kfs[0].t) return kfs[0].fit || 'cover';
  for (let i = 0; i < kfs.length; i++) {
    const next = kfs[i + 1];
    if (!next || state.currentTime < next.t) return kfs[i].fit || 'cover';
  }
  return kfs[kfs.length - 1].fit || 'cover';
}

function toggleInterpAtCurrent() {
  const n = state.activeBox;
  if (n === null) {
    setStatus('tr-status', 'Pick a Box first (click pill 1 or 2)', 'err');
    return;
  }
  const i = findKeyframeAt(n, state.currentTime);
  if (i < 0) {
    setStatus('tr-status', `No keyframe @${state.currentTime.toFixed(2)}s — drag first to create a kf`, 'err');
    return;
  }
  const cur = state.keyframes[n][i];
  cur.interp = (cur.interp || 'hold') === 'hold' ? 'linear' : 'hold';
  setStatus('tr-status',
    `Box ${n} kf @${cur.t.toFixed(2)}s → ${cur.interp === 'linear' ? 'LINEAR (smooth pan to the next kf)' : 'HOLD (stays put until the next kf)'}`,
    'ok');
  renderTimeline();
  redrawOverlay();
  redrawPreviews();
}

function findKeyframeAt(n, t) {
  const kfs = state.keyframes[n];
  for (let i = 0; i < kfs.length; i++) {
    if (Math.abs(kfs[i].t - t) < KF_EPS) return i;
  }
  return -1;
}

function deleteKeyframeAtCurrent() {
  const n = state.activeBox;
  if (n === null) {
    setStatus('tr-status', 'Pick a Box first (click pill 1/2) before deleting', 'err');
    return;
  }
  const i = findKeyframeAt(n, state.currentTime);
  if (i < 0) {
    setStatus('tr-status',
      `No keyframe exactly at ${state.currentTime.toFixed(2)}s for Box ${n}. Tip: click a dot on the timeline or ▶ in the segment list to seek to a kf, then press Delete`,
      'err');
    return;
  }
  state.keyframes[n].splice(i, 1);
  setStatus('tr-status',
    `Deleted kf Box ${n} @${state.currentTime.toFixed(2)}s · ${state.keyframes[n].length} kf remaining`,
    'ok');
  renderTimeline();
  redrawOverlay();
  redrawPreviews();
}

function clearActiveBox() {
  const n = state.activeBox;
  if (n === null) {
    setStatus('tr-status', 'Pick a Box first before clearing', 'err');
    return;
  }
  const count = state.keyframes[n].length;
  if (!count) {
    setStatus('tr-status', `Box ${n} is already empty`, 'err');
    return;
  }
  state.keyframes[n] = [];
  setStatus('tr-status', `Box ${n} cleared (removed ${count} kf)`, 'ok');
  renderTimeline();
  redrawOverlay();
  redrawPreviews();
}

function hasAnyKeyframes() {
  return state.keyframes[1].length > 0 || state.keyframes[2].length > 0;
}

// ───────────────────────── time / scrubber ─────────────────────────
function onTimeUpdate() {
  state.currentTime = els.video.currentTime || 0;
  if (els.curTime) els.curTime.textContent = state.currentTime.toFixed(2) + 's';
  const scr = $('#scrubber');
  if (scr && document.activeElement !== scr) scr.value = state.currentTime;
  const tc = $('#time-cur');
  if (tc) tc.textContent = formatTime(state.currentTime);
  updateTimelineCursor();
  updateKfListHighlight();
  redrawOverlay();
  redrawPreviews();
}

function updateKfListHighlight() {
  for (const n of [1, 2]) {
    const ol = document.getElementById(`kf-items-${n}`);
    if (!ol) continue;
    const kfs = state.keyframes[n];
    const items = ol.querySelectorAll('li');
    kfs.forEach((kf, idx) => {
      const next = kfs[idx + 1];
      const endT = next ? next.t : (state.source ? state.source.duration : kf.t);
      const isCur = state.currentTime >= kf.t && (next ? state.currentTime < endT : true);
      if (items[idx]) items[idx].classList.toggle('current', isCur);
    });
  }
}

function updateTimelineCursor() {
  if (!state.source || !els.dots1) return;
  const r = els.dots1.getBoundingClientRect();
  const trackR = els.dots1.parentElement.parentElement.getBoundingClientRect();
  const x = r.left - trackR.left + (state.source.duration > 0
    ? (state.currentTime / state.source.duration) * r.width
    : 0);
  els.timelineCursor.style.left = x + 'px';
}

function renderTimeline() {
  if (!state.source) return;
  renderTrack(els.dots1, 1);
  renderTrack(els.dots2, 2);
  els.kfCount1.textContent = state.keyframes[1].length + ' kf';
  els.kfCount2.textContent = state.keyframes[2].length + ' kf';
  updateTimelineCursor();
  renderKfList();
}

function renderKfList() {
  for (const n of [1, 2]) {
    const ol = document.getElementById(`kf-items-${n}`);
    const titleEl = document.querySelector(`.kf-list-box[data-box="${n}"] .kf-list-title`);
    if (!ol) continue;
    const kfs = state.keyframes[n];

    // header — keep title + add a "Clear all" button when there are kfs
    if (titleEl) {
      titleEl.innerHTML = `
        <span class="dot dot-${n}"></span>
        <span>Box ${n} segments</span>
        <span class="kf-count" style="margin-left:auto">${kfs.length} kf</span>
        ${kfs.length ? `<button class="clear-all-btn danger" data-act="clear-all" data-box="${n}" title="Clear all kfs in Box ${n}">Clear all ×</button>` : ''}
      `;
    }

    if (!kfs.length) {
      ol.innerHTML = '<li class="empty">No keyframes — pick this box, drag on the video</li>';
      continue;
    }
    const dur = state.source ? state.source.duration : null;
    ol.innerHTML = kfs.map((kf, idx) => {
      const next = kfs[idx + 1];
      const isLast = !next;
      const endT = isLast ? (dur || kf.t) : next.t;
      const mode = (kf.interp || 'hold');
      const tag = isLast ? '—' : (mode === 'linear' ? 'PAN→' : 'HOLD');
      const cls = isLast ? 'last' : mode;
      const fit = (kf.fit || 'cover');
      const fitLbl = fit === 'blur_pad' ? 'BLUR PAD' : 'COVER';
      const isGap = !!kf.gap;
      const isCur = state.currentTime >= kf.t && (isLast || state.currentTime < endT);
      // Gap segment: rendered black, can be removed to restore prior kf's extension.
      if (isGap) {
        return `
          <li class="gap ${isCur ? 'current' : ''}">
            <span class="kf-seg-time">${formatTime(kf.t)} → ${isLast ? 'end' : formatTime(endT)}</span>
            <span class="kf-seg-dims kf-seg-empty">— empty (rendered black) —</span>
            <span class="kf-seg-actions">
              <button data-act="seek" data-box="${n}" data-idx="${idx}" title="Seek to the start of the gap">▶ seek</button>
              <button data-act="del"  data-box="${n}" data-idx="${idx}" class="danger" title="Delete gap marker → restore prior kf's extension">× restore</button>
            </span>
          </li>
        `;
      }
      return `
        <li class="${isCur ? 'current' : ''}">
          <span class="kf-seg-time">${formatTime(kf.t)} → ${isLast ? 'end' : formatTime(endT)}</span>
          <span class="kf-seg-dims">${Math.round(kf.w)}×${Math.round(kf.h)} @(${Math.round(kf.x)},${Math.round(kf.y)})</span>
          <span class="kf-seg-mode ${cls}">${tag}</span>
          <span class="kf-seg-actions">
            <button data-act="seek"       data-box="${n}" data-idx="${idx}" title="Seek to this kf">▶ seek</button>
            <button data-act="toggle"     data-box="${n}" data-idx="${idx}" title="Toggle Hold ↔ Linear (interp)">⇄ ${mode}</button>
            <button data-act="toggle-fit" data-box="${n}" data-idx="${idx}" class="kf-seg-fit ${fit}" title="Toggle Cover ↔ Blur Pad (fit mode) for this segment">${fitLbl}</button>
            <button data-act="del"        data-box="${n}" data-idx="${idx}" class="danger" title="Delete this kf">× delete</button>
          </span>
        </li>
      `;
    }).join('');
  }
}

function onKfListClick(e) {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const act = btn.dataset.act;
  const n = +btn.dataset.box;
  // "clear-all" action doesn't have idx
  if (act === 'clear-all') {
    const count = state.keyframes[n].length;
    if (!count) { setStatus('tr-status', `Box ${n} is already empty`, 'err'); return; }
    state.keyframes[n] = [];
    setStatus('tr-status', `Box ${n} cleared (removed ${count} kf)`, 'ok');
    renderTimeline();
    redrawOverlay();
    redrawPreviews();
    return;
  }
  const idx = +btn.dataset.idx;
  const kf = state.keyframes[n][idx];
  if (!kf) return;
  if (act === 'seek') {
    els.video.currentTime = kf.t;
  } else if (act === 'toggle') {
    kf.interp = (kf.interp || 'hold') === 'hold' ? 'linear' : 'hold';
    setStatus('tr-status',
      `Box ${n} kf @${kf.t.toFixed(2)}s → ${kf.interp.toUpperCase()}`, 'ok');
    renderTimeline();
    redrawOverlay();
    redrawPreviews();
  } else if (act === 'toggle-fit') {
    kf.fit = (kf.fit || 'cover') === 'cover' ? 'blur_pad' : 'cover';
    setStatus('tr-status',
      `Box ${n} kf @${kf.t.toFixed(2)}s → fit ${kf.fit === 'blur_pad' ? 'BLUR PAD' : 'COVER'}`, 'ok');
    renderTimeline();
    redrawPreviews();
  } else if (act === 'del') {
    state.keyframes[n].splice(idx, 1);
    setStatus('tr-status',
      `Deleted kf Box ${n} @${kf.t.toFixed(2)}s · ${state.keyframes[n].length} kf remaining`, 'ok');
    renderTimeline();
    redrawOverlay();
    redrawPreviews();
  }
}

function renderTrack(container, boxNum) {
  container.innerHTML = '';
  const dur = state.source.duration || 1;
  const kfs = state.keyframes[boxNum];
  kfs.forEach((kf, idx) => {
    const mode = (kf.interp || 'hold');
    const isLast = idx === kfs.length - 1;
    const isGap = !!kf.gap;
    const dot = document.createElement('div');
    dot.className = `timeline-dot ${mode}` + (isLast ? ' last' : '') + (isGap ? ' gap' : '');
    dot.dataset.box = boxNum;
    dot.style.left = ((kf.t / dur) * 100) + '%';
    dot.title = `Box ${boxNum} kf #${idx + 1} @ ${kf.t.toFixed(2)}s · ${isGap ? 'GAP (empty segment)' : (isLast ? '(last)' : mode.toUpperCase())} — click to seek`;
    dot.addEventListener('click', () => {
      els.video.currentTime = kf.t;
    });
    container.appendChild(dot);

    // For non-last kfs, draw a segment indicator between this kf and the next.
    if (!isLast) {
      const next = kfs[idx + 1];
      const seg = document.createElement('div');
      seg.className = `timeline-seg ${mode}` + (isGap ? ' gap' : '');
      seg.style.left = ((kf.t / dur) * 100) + '%';
      seg.style.width = (((next.t - kf.t) / dur) * 100) + '%';
      container.appendChild(seg);
    }
  });
}

// ───────────────────────── drag ─────────────────────────
// Four hit zones (decided at mousedown):
//   delete-handle (×, top-right inside the box) → delete this segment's kf and bail
//   'resize' — corner handle → anchor opposite corner, resize free-form
//   'move'   — inside box, not on any handle → translate (size preserved)
//   'draw'   — outside box → free-form new rectangle
// Click (no movement) in 'draw' mode inherits size from nearest kf, repositions.
const HANDLES = ['nw', 'ne', 'sw', 'se'];
const HANDLE_HIT_PX = 12;     // overlay pixels for corner handles
const DELETE_HANDLE_INSET = 14;  // overlay px — × is offset inside top-right corner
const DELETE_HIT_PX = 11;

function pointInBox(src, box) {
  return box && src.x >= box.x && src.x <= box.x + box.w
             && src.y >= box.y && src.y <= box.y + box.h;
}

// Overlay-space position of the × delete handle for the given box.
function deleteHandlePos(box) {
  const a = sourceToOverlay(box.x, box.y);
  const b = sourceToOverlay(box.x + box.w, box.y);
  return { x: b.x - DELETE_HANDLE_INSET, y: a.y + DELETE_HANDLE_INSET };
}

function hitDeleteHandle(box, srcPos) {
  if (!box) return false;
  const h = deleteHandlePos(box);
  const p = sourceToOverlay(srcPos.x, srcPos.y);
  return Math.hypot(p.x - h.x, p.y - h.y) < DELETE_HIT_PX;
}

function findHandle(box, srcPos) {
  // Hit-test corner handles in overlay-pixel space so they stay clickable
  // regardless of source resolution.
  if (!box) return null;
  const a = sourceToOverlay(box.x, box.y);
  const b = sourceToOverlay(box.x + box.w, box.y + box.h);
  const p = sourceToOverlay(srcPos.x, srcPos.y);
  for (const corner of HANDLES) {
    const hx = corner.includes('w') ? a.x : b.x;
    const hy = corner.includes('n') ? a.y : b.y;
    if (Math.abs(p.x - hx) < HANDLE_HIT_PX && Math.abs(p.y - hy) < HANDLE_HIT_PX) {
      return corner;
    }
  }
  return null;
}

// Trim box from currentTime onwards: anything before currentTime stays, from
// currentTime forward the slot is empty (rendered black). Triggered by clicking
// × on the bbox overlay. Implementation: drop kfs with t > currentTime, insert
// a `gap=true` kf at currentTime if there are remaining real kfs before it; if
// no earlier kf exists, just clear the box entirely.
function trimBoxFromNow(n) {
  const kfs = state.keyframes[n];
  if (!kfs.length) {
    setStatus('tr-status', `Box ${n} is already empty`, 'err');
    return;
  }
  const t = state.currentTime;
  // Keep only kfs strictly before t (real ones earlier in the timeline)
  const kept = kfs.filter(k => k.t < t - KF_EPS);
  if (!kept.length) {
    // No earlier box — wipe entirely and disarm
    state.keyframes[n] = [];
    if (state.activeBox === n) setActiveBox(null);
    setStatus('tr-status', `Box ${n} removed (no earlier kf to keep)`, 'ok');
  } else {
    // Insert a gap kf right at t so prior segments end here and rest is empty
    const ref = kept[kept.length - 1];
    kept.push({
      t,
      x: ref.x, y: ref.y, w: ref.w, h: ref.h,
      interp: 'hold',
      fit: ref.fit || 'cover',
      gap: true,
    });
    state.keyframes[n] = kept;
    setStatus('tr-status', `Box ${n} trimmed @${t.toFixed(2)}s · earlier kfs kept, empty from here onwards`, 'ok');
  }
  renderTimeline();
  redrawOverlay();
  redrawPreviews();
}

function onDragStart(e) {
  if (!state.source || state.activeBox === null) return;
  const rect = els.overlay.getBoundingClientRect();
  const ox = e.clientX - rect.left;
  const oy = e.clientY - rect.top;
  const src = overlayToSource(ox, oy);

  const existing = boxAt(state.activeBox, state.currentTime);

  // × delete handle has priority over all other hit zones — trims the box at
  // currentTime: anything earlier kept, from here onwards becomes empty (gap).
  if (existing && hitDeleteHandle(existing, src)) {
    e.preventDefault();
    trimBoxFromNow(state.activeBox);
    return;
  }

  const corner = findHandle(existing, src);
  let mode;
  if (corner) mode = 'resize';
  else if (pointInBox(src, existing)) mode = 'move';
  else mode = 'draw';

  state.drag = {
    mode,
    corner,
    startSrc: src,
    current: src,
    origin: existing ? { x: existing.x, y: existing.y, w: existing.w, h: existing.h } : null,
  };
  redrawOverlay();
}

function onDragMove(e) {
  if (!state.drag) return;
  const rect = els.overlay.getBoundingClientRect();
  let ox = e.clientX - rect.left;
  let oy = e.clientY - rect.top;
  ox = Math.max(0, Math.min(rect.width, ox));
  oy = Math.max(0, Math.min(rect.height, oy));
  state.drag.current = overlayToSource(ox, oy);
  redrawOverlay();
}

function onHoverCursor(e) {
  if (state.drag || state.activeBox === null || !state.source) return;
  const rect = els.overlay.getBoundingClientRect();
  const src = overlayToSource(e.clientX - rect.left, e.clientY - rect.top);
  const existing = boxAt(state.activeBox, state.currentTime);
  let cursor = 'crosshair';
  if (existing) {
    if (hitDeleteHandle(existing, src)) {
      cursor = 'pointer';
    } else {
      const corner = findHandle(existing, src);
      if (corner) {
        cursor = (corner === 'nw' || corner === 'se') ? 'nwse-resize' : 'nesw-resize';
      } else if (pointInBox(src, existing)) {
        cursor = 'move';
      }
    }
  }
  els.overlay.style.cursor = cursor;
}

function computeResize(origin, corner, current) {
  // Opposite corner stays anchored; current mouse defines new opposite corner.
  const anchorX = corner.includes('w') ? origin.x + origin.w : origin.x;
  const anchorY = corner.includes('n') ? origin.y + origin.h : origin.y;
  const x = Math.min(anchorX, current.x);
  const y = Math.min(anchorY, current.y);
  const w = Math.abs(anchorX - current.x);
  const h = Math.abs(anchorY - current.y);
  return { x, y, w, h };
}

function onDragEnd(e) {
  if (!state.drag) return;
  const { startSrc, current, mode, origin, corner } = state.drag;
  state.drag = null;

  if (state.activeBox === null) { redrawOverlay(); return; }

  const dx = current.x - startSrc.x;
  const dy = current.y - startSrc.y;
  const isClick = Math.abs(dx) < 8 && Math.abs(dy) < 8;
  const n = state.activeBox;
  const t = state.currentTime;
  let x, y, w, h;
  let how;

  if (mode === 'resize') {
    if (isClick) { redrawOverlay(); return; }
    const r = computeResize(origin, corner, current);
    x = r.x; y = r.y; w = r.w; h = r.h;
    how = `resized via ${corner}`;
  } else if (mode === 'move') {
    if (isClick) { redrawOverlay(); return; }  // click inside box = no-op
    x = origin.x + dx;
    y = origin.y + dy;
    w = origin.w;
    h = origin.h;
    how = 'moved';
  } else if (isClick) {
    // Click in empty area = inherit size from nearest kf, place at click pos
    const ref = nearestKeyframe(n, t);
    if (!ref) {
      setStatus('tr-status', `Box ${n} has no kf yet — drag (don't just click) to set the first size`, 'err');
      redrawOverlay();
      return;
    }
    w = ref.w; h = ref.h;
    x = startSrc.x - w / 2;
    y = startSrc.y - h / 2;
    how = 'placed (size inherited)';
  } else {
    // Free-form draw — box is exactly the rectangle dragged (any size/AR).
    x = Math.min(startSrc.x, current.x);
    y = Math.min(startSrc.y, current.y);
    w = Math.abs(dx);
    h = Math.abs(dy);
    how = 'drawn';
  }

  // Clamp into source bounds — keep size, slide position so the box fits.
  if (x < 0) x = 0;
  if (y < 0) y = 0;
  if (x + w > state.source.width)  x = state.source.width  - w;
  if (y + h > state.source.height) y = state.source.height - h;
  x = Math.max(0, x);
  y = Math.max(0, y);
  w = Math.min(w, state.source.width  - x);
  h = Math.min(h, state.source.height - y);

  upsertKeyframe(n, { x, y, w, h }, t);
  setStatus('tr-status',
    `Box ${n} ${how} @${t.toFixed(2)}s · ${Math.round(w)}×${Math.round(h)} · total ${state.keyframes[n].length} kf`,
    'ok');

  renderTimeline();
  redrawOverlay();
  redrawPreviews();
}

// ───────────────────────── overlay draw ─────────────────────────
function redrawOverlay() {
  const c = els.overlay;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);

  const b1 = boxAt(1, state.currentTime);
  const b2 = boxAt(2, state.currentTime);

  drawBox(ctx, b1, '#5ee0ff', 'BOX 1 → TOP slot (3/8, 3:2)', 1);
  drawBox(ctx, b2, '#ff6ec7', 'BOX 2 → BOTTOM slot (5/8, 9:10)', 2);

  if (state.drag) {
    const color = state.activeBox === 1 ? '#5ee0ff' : '#ff6ec7';
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 4]);
    if (state.drag.mode === 'resize' && state.drag.origin) {
      const r = computeResize(state.drag.origin, state.drag.corner, state.drag.current);
      const a = sourceToOverlay(r.x, r.y);
      const sz = sourceToOverlay(r.x + r.w, r.y + r.h);
      ctx.strokeRect(a.x, a.y, sz.x - a.x, sz.y - a.y);
    } else if (state.drag.mode === 'move' && state.drag.origin) {
      const dx = state.drag.current.x - state.drag.startSrc.x;
      const dy = state.drag.current.y - state.drag.startSrc.y;
      const o = state.drag.origin;
      const a = sourceToOverlay(o.x + dx, o.y + dy);
      const sz = sourceToOverlay(o.x + dx + o.w, o.y + dy + o.h);
      ctx.strokeRect(a.x, a.y, sz.x - a.x, sz.y - a.y);
    } else {
      const a = sourceToOverlay(state.drag.startSrc.x, state.drag.startSrc.y);
      const b = sourceToOverlay(state.drag.current.x, state.drag.current.y);
      ctx.strokeRect(
        Math.min(a.x, b.x),
        Math.min(a.y, b.y),
        Math.abs(b.x - a.x),
        Math.abs(b.y - a.y),
      );
    }
    ctx.restore();
  }
}

function drawBox(ctx, box, color, label, boxNum) {
  if (!box) return;
  const a = sourceToOverlay(box.x, box.y);
  const b = sourceToOverlay(box.x + box.w, box.y + box.h);
  const isOnKeyframe = findKeyframeAt(boxNum, state.currentTime) >= 0;
  const isActive = boxNum === state.activeBox;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color + '22';
  ctx.lineWidth = 2;
  if (!isOnKeyframe) ctx.setLineDash([6, 4]);
  ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
  ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
  ctx.setLineDash([]);
  ctx.fillStyle = color;
  ctx.font = 'bold 11px JetBrains Mono, monospace';
  ctx.fillText(label + (isOnKeyframe ? '' : ' [interpolated]'), a.x + 4, a.y + 14);

  // Render-area guide: show exactly what ends up in the slot for this box's
  // current fit. COVER → dim the cropped margins + outline the kept centered
  // slot-AR sub-rect. BLUR_PAD → whole box renders (contained), no crop.
  const fit = currentFit(boxNum);
  if (fit !== 'blur_pad' && box.w > 1 && box.h > 1) {
    const keep = coverKeepRect(box, aspectForBox(boxNum));
    const ka = sourceToOverlay(keep.x, keep.y);
    const kb = sourceToOverlay(keep.x + keep.w, keep.y + keep.h);
    ctx.fillStyle = 'rgba(0,0,0,0.5)';  // dim the parts that get cropped away
    if (ka.x > a.x) ctx.fillRect(a.x, a.y, ka.x - a.x, b.y - a.y);          // left
    if (kb.x < b.x) ctx.fillRect(kb.x, a.y, b.x - kb.x, b.y - a.y);         // right
    if (ka.y > a.y) ctx.fillRect(a.x, a.y, b.x - a.x, ka.y - a.y);          // top
    if (kb.y < b.y) ctx.fillRect(a.x, kb.y, b.x - a.x, b.y - kb.y);         // bottom
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 3]);
    ctx.strokeRect(ka.x, ka.y, kb.x - ka.x, kb.y - ka.y);
    ctx.setLineDash([]);
  }

  // Corner resize handles + × delete handle — only when this box is the active target.
  if (isActive) {
    const HS = 8;  // handle size in overlay px
    const corners = [
      [a.x, a.y], [b.x, a.y], [a.x, b.y], [b.x, b.y],
    ];
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    for (const [cx, cy] of corners) {
      ctx.fillRect(cx - HS / 2, cy - HS / 2, HS, HS);
      ctx.strokeRect(cx - HS / 2, cy - HS / 2, HS, HS);
    }
    // × delete handle, inside top-right corner
    const d = { x: b.x - DELETE_HANDLE_INSET, y: a.y + DELETE_HANDLE_INSET };
    ctx.fillStyle = '#ff5252';
    ctx.beginPath();
    ctx.arc(d.x, d.y, 10, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(d.x - 4, d.y - 4); ctx.lineTo(d.x + 4, d.y + 4);
    ctx.moveTo(d.x + 4, d.y - 4); ctx.lineTo(d.x - 4, d.y + 4);
    ctx.stroke();
  }
  ctx.restore();
}

function updatePills() {
  document.querySelectorAll('.box-pill').forEach((pill, idx) => {
    pill.classList.toggle('active', (idx + 1) === state.activeBox);
  });
}

// ───────────────────────── preview (mirrors ffmpeg compose) ─────────────────────────
// drawSlot mirrors backend renderer._crop_chain for a single slot:
//   mode 'cover'    → scale-cover + center-crop (loses pixels outside slot AR)
//   mode 'blur_pad' → blurred cover bg + contained fg (full crop visible, gaps blurred)
// Slot is clipped so blur from bg doesn't bleed into the neighbor slot.
function drawSlot(ctx, box, dx, dy, dw, dh, mode) {
  if (!els.video.videoWidth) return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(dx, dy, dw, dh);
  ctx.clip();
  if (mode === 'blur_pad') {
    ctx.save();
    ctx.filter = 'blur(12px) brightness(0.88)';
    drawCover(ctx, box, dx, dy, dw, dh);
    ctx.restore();
    drawContain(ctx, box, dx, dy, dw, dh);
  } else {
    drawCover(ctx, box, dx, dy, dw, dh);
  }
  ctx.restore();
}

function drawCover(ctx, box, dx, dy, dw, dh) {
  const src = els.video;
  const srcAR = box.w / box.h;
  const dstAR = dw / dh;
  let sx, sy, sw, sh;
  if (srcAR > dstAR) {
    sh = box.h;
    sw = box.h * dstAR;
    sx = box.x + (box.w - sw) / 2;
    sy = box.y;
  } else {
    sw = box.w;
    sh = box.w / dstAR;
    sx = box.x;
    sy = box.y + (box.h - sh) / 2;
  }
  try { ctx.drawImage(src, sx, sy, sw, sh, dx, dy, dw, dh); } catch (_) {}
}

function drawContain(ctx, box, dx, dy, dw, dh) {
  const src = els.video;
  const boxAR = box.w / box.h;
  const slotAR = dw / dh;
  let outW, outH;
  if (boxAR > slotAR) {
    outW = dw;
    outH = dw / boxAR;
  } else {
    outH = dh;
    outW = dh * boxAR;
  }
  const ox = dx + (dw - outW) / 2;
  const oy = dy + (dh - outH) / 2;
  try { ctx.drawImage(src, box.x, box.y, box.w, box.h, ox, oy, outW, outH); } catch (_) {}
}

function redrawPreviews() {
  redrawPreview(els.preview);
  redrawPreview(els.preview2);
}

function redrawPreview(canvas) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, PREVIEW_W, PREVIEW_H);

  if (!state.source) return;
  const b1 = boxAt(1, state.currentTime);
  const b2 = boxAt(2, state.currentTime);
  const topH = (TOP_H / OUT_H) * PREVIEW_H;
  const botH = (BOTTOM_H / OUT_H) * PREVIEW_H;

  const single = !!b1 ^ !!b2;
  if (b1 && b2) {
    drawSlot(ctx, b1, 0, 0, PREVIEW_W, topH, currentFit(1));
    drawSlot(ctx, b2, 0, topH, PREVIEW_W, botH, currentFit(2));
    drawCaptionPreview(ctx, topH);
  } else if (b1) {
    // single box → full 1080×1920 focus on this box
    drawSlot(ctx, b1, 0, 0, PREVIEW_W, PREVIEW_H, currentFit(1));
    drawCaptionPreview(ctx, PREVIEW_H / 2);
  } else if (b2) {
    drawSlot(ctx, b2, 0, 0, PREVIEW_W, PREVIEW_H, currentFit(2));
    drawCaptionPreview(ctx, PREVIEW_H / 2);
  }

  // slot separator (3/8 line) only shown when both boxes split the frame
  if (!single && b1 && b2) {
    ctx.save();
    ctx.strokeStyle = '#ffffff44';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(0, topH);
    ctx.lineTo(PREVIEW_W, topH);
    ctx.stroke();
    ctx.restore();
  }

  if (canvas === els.preview && els.previewMeta) {
    const c = (b1 ? 1 : 0) + (b2 ? 1 : 0);
    const kf = `${state.keyframes[1].length}+${state.keyframes[2].length} keyframes`;
    els.previewMeta.textContent = c === 0
      ? 'No box yet'
      : c === 1 ? `1 box · full 1080×1920 focus · ${kf}` : `2 boxes · vstack 3/8+5/8 · ${kf}`;
  }
}

// Caption shown at currentTime — mirrors the burned caption (word group around
// `time`) instead of a fixed sample, so the preview caption matches the rendered
// caption at the same moment. Lets the user align preview ↔ download by caption.
function captionTextAt(time) {
  const words = state.words;
  if (!words.length) return 'YOUR CAPTION';
  let i = words.findIndex((w) => time >= w.start && time < w.end);
  if (i < 0) {                                  // between words → last that started
    for (let j = 0; j < words.length; j++) {
      if (words[j].start <= time) i = j; else break;
    }
  }
  if (i < 0) i = 0;
  const out = [];
  let chars = 0;
  for (let j = i; j < words.length && out.length < 3; j++) {  // up to 3 words, ≤18 chars
    const wd = words[j].word;
    if (out.length && chars + 1 + wd.length > 18) break;
    out.push(wd);
    chars += (chars ? 1 : 0) + wd.length;
  }
  return out.join(' ').toUpperCase().slice(0, 18) || '...';
}

function drawCaptionPreview(ctx, y) {
  const t = captionTextAt(state.currentTime);
  const scale = PREVIEW_W / OUT_W;
  const fs = Math.max(10, state.caption.size * scale);
  ctx.save();
  ctx.font = `bold ${fs}px ${state.caption.font}, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = Math.max(2, fs / 8);
  ctx.strokeStyle = '#000';
  ctx.strokeText(t, PREVIEW_W / 2, y);
  ctx.fillStyle = '#fff';
  ctx.fillText(t, PREVIEW_W / 2, y);
  ctx.restore();
}

// ───────────────────────── AI auto-box ─────────────────────────
// A single pair of draggable handles on a clip-width bar sets the [start,end]
// range. "Generate" asks the vision model for the prompted subject's box on
// frames across that range; the result drops into the ARMED box's keyframes
// (replacing any inside the range) so it's editable like manual boxing.
function clampAutoRange() {
  const dur = state.source ? state.source.duration : 0;
  let start = state.autoRange.start ?? 0;
  let end = state.autoRange.end == null ? dur : state.autoRange.end;
  start = Math.max(0, Math.min(start, dur));
  end = Math.max(0, Math.min(end, dur));
  const MIN = 0.2;
  if (end < start + MIN) {
    if (state.abDrag === 'start') start = Math.max(0, end - MIN);
    else end = Math.min(dur, start + MIN);
  }
  state.autoRange.start = start;
  state.autoRange.end = end;
}

function renderAutoRange() {
  if (!state.source || !els.abRange) return;
  const dur = state.source.duration || 1;
  clampAutoRange();
  const s = state.autoRange.start;
  const e = state.autoRange.end == null ? dur : state.autoRange.end;
  const sp = (s / dur) * 100;
  const ep = (e / dur) * 100;
  els.abHStart.style.left = sp + '%';
  els.abHEnd.style.left = ep + '%';
  els.abBand.style.left = sp + '%';
  els.abBand.style.width = Math.max(0, ep - sp) + '%';
  if (els.abStartLbl) els.abStartLbl.textContent = s.toFixed(1) + 's';
  if (els.abEndLbl) els.abEndLbl.textContent = e.toFixed(1) + 's';
}

function startAbDrag(e, which) {
  e.preventDefault();
  state.abDrag = which;
}

function onAbDragMove(e) {
  if (!state.abDrag || !state.source || !els.abRange) return;
  const r = els.abRange.getBoundingClientRect();
  const frac = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  const t = frac * state.source.duration;
  if (state.abDrag === 'start') state.autoRange.start = t;
  else state.autoRange.end = t;
  renderAutoRange();
}

async function doAutoBox(n) {
  if (!state.jobId) return;
  const input = $(`#ab-prompt-${n}`);
  const raw = (input ? input.value : '').trim();
  if (!raw) { setStatus('ab-status', `Type what Box ${n} should follow first`, 'err'); return; }
  // Merge [model observation] + [shared layout context] + [per-box instruction],
  // matching the batch worker. The context carries the {layout}/{side}
  // placeholders, which the backend resolves per detected segment.
  const obs = (state.autoObs || '').trim();
  const ctx = ($('#ab-context') ? $('#ab-context').value : '').trim();
  const prompt = [obs, ctx, raw].filter(Boolean).join(' ');
  const dur = state.source.duration;
  const t0 = Math.max(0, state.autoRange.start || 0);
  const t1 = state.autoRange.end == null ? dur : state.autoRange.end;
  const step = +els.abDensity.value || 0.2;
  const btn = document.querySelector(`.ab-gen[data-box="${n}"]`);
  if (btn) btn.disabled = true;
  setStatus('ab-status',
    `Box ${n}: predicting "${prompt}" over ${t0.toFixed(1)}–${t1.toFixed(1)}s… (AI scanning frames)`);
  try {
    const res = await apiPost('/api/autobox', {
      job_id: state.jobId, prompt, t_start: t0, t_end: t1, box: n, step_seconds: step,
      lock_size: $('#ab-lock') ? $('#ab-lock').checked : true,
    });
    const kfs = res.keyframes || [];
    if (!kfs.length) {
      setStatus('ab-status', res.message || 'Nothing detected — try a different prompt or range', 'err');
      return;
    }
    // Keep manual keyframes OUTSIDE the predicted range; replace inside it.
    const keep = state.keyframes[n].filter(k => k.t < t0 - KF_EPS || k.t > t1 + KF_EPS);
    state.keyframes[n] = [...keep, ...kfs].sort((a, b) => a.t - b.t);
    setStatus('ab-status',
      `${res.message} Added ${kfs.length} keyframes to Box ${n} — drag / resize / delete below.`, 'ok');
    renderTimeline();
    redrawOverlay();
    redrawPreviews();
  } catch (err) {
    setStatus('ab-status', 'Failed: ' + err.message, 'err');
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ───────────────────────── API ─────────────────────────
async function apiPost(path, body) {
  const r = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(txt || r.statusText);
  }
  return r.json();
}

function setStatus(id, msg, kind) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('err', 'ok');
  if (kind) el.classList.add(kind);
}

async function doDownload() {
  const url = $('#f-url').value.trim();
  if (!url) { setStatus('dl-status', 'URL required', 'err'); return; }
  const body = {
    url,
    start: $('#f-start').value.trim() || '00:00:00',
    end: $('#f-end').value.trim() || null,
    title: $('#f-title').value.trim() || 'clip',
    description: $('#f-desc').value.trim(),
  };
  const btn = $('#btn-download');
  btn.disabled = true;
  setStatus('dl-status', 'Downloading…');
  try {
    const res = await apiPost('/api/download', body);
    state.jobId = res.job_id;
    state.source = {
      width: res.width,
      height: res.height,
      duration: res.duration,
      video_path: res.video_path,
    };
    state.keyframes = { 1: [], 2: [] };
    state.currentTime = 0;
    state.words = [];
    state.renderRange = { start: null, end: null };
    state.autoRange = { start: 0, end: res.duration };
    state.sfx = [];                // placements are per-clip
    state.ills = [];               // cutaways are per-clip
    state.keep = []; state.keepA = null;  // keep-windows are per-clip
    state.autoObs = '';            // no model observation for an ad-hoc clip
    if ($('#ab-context')) $('#ab-context').value = '';   // context is per-clip
    resetThumbSlots();             // thumbnail backgrounds reference the old clip
    state.activeQueueKey = null;   // ad-hoc download — not editing a queue job
    if ($('#rd-start')) { $('#rd-start').value = ''; $('#rd-end').value = ''; }
    updateRangeMeta();
    setActiveBox(null);
    els.video.src = res.video_path;
    updatePlayBtn(false);
    setStatus('dl-status', `OK · ${res.width}×${res.height} · ${res.duration.toFixed(1)}s`, 'ok');
    showStep(2);
  } catch (e) {
    setStatus('dl-status', 'Failed: ' + e.message, 'err');
  } finally {
    btn.disabled = false;
  }
}

function doContinue() {
  if (!state.jobId) return;
  if (!hasAnyKeyframes()) {
    setStatus('tr-status', 'Draw at least 1 box first (set a keyframe)', 'err');
    return;
  }
  setStatus('tr-status', '', null);
  showStep(3);
}

function renderWordChips() {
  if (!state.words.length) {
    els.wordsBox.innerHTML = '<div class="muted">No transcript yet.</div>';
    return;
  }
  els.wordsBox.innerHTML = state.words
    .map(w => `<span class="word-chip">${escapeHtml(w.word)}</span>`)
    .join('');
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function activeFitSummary() {
  const summarize = (n) => {
    const kfs = state.keyframes[n];
    if (!kfs.length) return null;
    const c = kfs.filter(k => (k.fit || 'cover') === 'cover').length;
    const b = kfs.length - c;
    if (b === 0) return `Box ${n}: ${kfs.length}× cover`;
    if (c === 0) return `Box ${n}: ${kfs.length}× blur`;
    return `Box ${n}: ${c} cover / ${b} blur`;
  };
  const parts = [summarize(1), summarize(2)].filter(Boolean);
  return parts.length ? parts.join(' · ') : '—';
}

function fillResult(result, withCaption) {
  const card = $('#result-card');
  if (!card) return;
  card.classList.remove('loading');
  const v = card.querySelector('video');
  const dl = card.querySelector('.result-dl');
  if (v) v.src = result.output_path + '?t=' + Date.now();
  if (dl) { dl.href = result.output_path; dl.download = result.filename; }
  const titleEl = $('#result-card-title');
  if (titleEl) titleEl.textContent = `Output · ${activeFitSummary()}`;
  const descEl = $('#result-card-desc');
  if (descEl) {
    descEl.textContent = withCaption
      ? `Caption burned in. File: ${result.filename}`
      : `No caption (quick preview). File: ${result.filename}`;
  }
}

function setResultLoading(loading) {
  const card = $('#result-card');
  if (!card) return;
  card.classList.toggle('loading', !!loading);
  if (loading) {
    const v = card.querySelector('video');
    if (v) v.removeAttribute('src');
    const dl = card.querySelector('.result-dl');
    if (dl) { dl.href = '#'; dl.removeAttribute('download'); }
  }
}

function showResultHeader(withCaption) {
  $('#render-result').classList.remove('hidden');
  $('#result-title').textContent = withCaption
    ? `Render + caption · ${activeFitSummary()}`
    : `Render preview (no caption) · ${activeFitSummary()}`;
}

function buildRenderBody(withWords) {
  const body = {
    job_id: state.jobId,
    title: $('#f-title').value.trim() || 'clip',
    box1: state.keyframes[1].length ? state.keyframes[1] : null,
    box2: state.keyframes[2].length ? state.keyframes[2] : null,
    words: withWords ? state.words : [],
    caption_font: state.caption.font,
    caption_size: state.caption.size,
    cleanup: false,
    render_start: state.renderRange.start,
    render_end: state.renderRange.end,
    sfx: state.sfx,
    illustrations: state.ills.map(c => ({ t_start: c.t_start, t_end: c.t_end, url: c.url, target: c.target || 'full', fit: c.fit || 'cover' })),
    keep_segments: state.keep.map(s => ({ start: s.start, end: s.end })),
  };
  logBoxes(body);
  return body;
}

// Print the bbox keyframes being sent to render (open F12 → Console to read).
function logBoxes(body) {
  const src = state.source ? `${state.source.width}x${state.source.height}` : '?';
  console.log(`%c[RENDER] source=${src} range=(${body.render_start},${body.render_end})`,
    'color:#e8ff3a;font-weight:bold');
  for (const [name, box] of [['box1 TOP 3:2', body.box1], ['box2 BOTTOM 9:10', body.box2]]) {
    if (!box) { console.log(`  ${name}: (none)`); continue; }
    console.log(`  ${name}: ${box.length} kf`);
    console.table(box.map((k) => ({
      t: +k.t.toFixed(2), x: Math.round(k.x), y: Math.round(k.y),
      w: Math.round(k.w), h: Math.round(k.h), AR: +(k.w / k.h).toFixed(3),
      fit: k.fit, interp: k.interp, gap: k.gap,
    })));
  }
}

// ───────────────────────── render sub-range ─────────────────────────
function onRangeInput() {
  const sv = $('#rd-start').value.trim();
  const ev = $('#rd-end').value.trim();
  state.renderRange.start = sv === '' ? null : Math.max(0, parseFloat(sv));
  state.renderRange.end = ev === '' ? null : Math.max(0, parseFloat(ev));
  updateRangeMeta();
}

function setRangeFromCurrent(which) {
  const t = state.currentTime || 0;
  const el = $(which === 'start' ? '#rd-start' : '#rd-end');
  el.value = t.toFixed(2);
  onRangeInput();
}

function clearRenderRange() {
  $('#rd-start').value = '';
  $('#rd-end').value = '';
  state.renderRange.start = null;
  state.renderRange.end = null;
  updateRangeMeta();
}

function updateRangeMeta() {
  const meta = $('#range-meta');
  if (!meta) return;
  const dur = state.source?.duration;
  const durTxt = dur ? `${dur.toFixed(2)}s` : '—';
  const rs = state.renderRange.start;
  const re = state.renderRange.end;
  const hasRange = rs != null || re != null;
  if (!hasRange) {
    meta.textContent = `source: ${durTxt}`;
    meta.style.color = '';
    return;
  }
  const s = rs != null ? rs.toFixed(2) : '0';
  const e = re != null ? re.toFixed(2) : (dur ? dur.toFixed(2) : '?');
  const len = (re != null ? re : (dur || 0)) - (rs != null ? rs : 0);
  // visual nudge when range looks invalid
  const invalid = re != null && rs != null && re <= rs;
  meta.textContent = `source: ${durTxt} · render: ${s}s→${e}s (${len > 0 ? len.toFixed(2) : '?'}s)`;
  meta.style.color = invalid ? 'var(--danger, #e55)' : '';
}

async function renderOnce(withWords) {
  showResultHeader(withWords);
  setResultLoading(true);
  setStatus('rd-status', `Rendering${withWords ? ' + caption' : ''} · ${activeFitSummary()}…`);
  const body = buildRenderBody(withWords);
  // Intro card (configured in the Thumbnail step): compose the thumbnail, upload
  // it, attach the intro config.
  if (thumb.intro && thumb.intro.enabled) {
    setStatus('rd-status', 'Composing intro card…');
    try { await prepareIntro(); } catch (e) { setStatus('rd-status', 'Intro skipped: ' + e.message, 'err'); }
    const ttsOff = $('#th-intro-voice') && $('#th-intro-voice').disabled;  // no Piper voice installed
    body.intro = {
      transition: thumb.intro.transition || 'fade',
      duration: thumb.intro.duration || 4,
      text: (thumb.text || $('#f-title').value || '').trim(),
      voice: !!thumb.intro.voice && !ttsOff,
      engine: thumb.intro.engine || 'gtts',
    };
    setStatus('rd-status', `Rendering${withWords ? ' + caption' : ''} + intro…`);
  }
  const result = await apiPost('/api/render', body);
  fillResult(result, withWords);
  state.result = result;
  setStatus('rd-status', `Done · saved as ${result.filename}`, 'ok');
}

// Compose the Thumbnail at 1080×1920 and upload it as the intro card.
async function prepareIntro() {
  try { await document.fonts.load(`bold ${thumb.size}px "${thumb.font}"`); } catch (_) {}
  const off = document.createElement('canvas');
  off.width = OUT_W; off.height = OUT_H;
  drawThumbnailInto(off.getContext('2d'), OUT_W, OUT_H);
  const blob = await new Promise(res => off.toBlob(res, 'image/png'));
  if (!blob) throw new Error('could not compose the thumbnail (set it up in the Thumbnail step)');
  const r = await fetch(`/api/intro-image?job_id=${encodeURIComponent(state.jobId)}`, { method: 'POST', body: blob });
  if (!r.ok) throw new Error((await r.text()) || r.statusText);
}

async function doRender() {
  // Primary action: transcribe (cached) + render with per-box fit modes + caption.
  if (!state.jobId) return;
  $('#btn-done').disabled = false;
  const btn = $('#btn-render');
  const btn2 = $('#btn-render-nocap');
  btn.disabled = true; if (btn2) btn2.disabled = true;
  try {
    if (!state.words.length) {
      setStatus('rd-status', 'Transcribing audio (Whisper · first run is slow, the model downloads once)…');
      const tr = await apiPost('/api/transcribe', { job_id: state.jobId });
      state.words = tr.words;
      els.wordsBox.classList.remove('hidden');
      renderWordChips();
    }
    await renderOnce(true);
  } catch (e) {
    setStatus('rd-status', 'Failed: ' + e.message, 'err');
  } finally {
    btn.disabled = false; if (btn2) btn2.disabled = false;
  }
}

async function doRenderNoCaption() {
  // Quick preview path — skip Whisper, single render with current fit modes.
  if (!state.jobId) return;
  $('#btn-done').disabled = false;
  const btn = $('#btn-render');
  const btn2 = $('#btn-render-nocap');
  btn.disabled = true; btn2.disabled = true;
  try {
    await renderOnce(false);
  } catch (e) {
    setStatus('rd-status', 'Failed: ' + e.message, 'err');
  } finally {
    btn.disabled = false; btn2.disabled = false;
  }
}

async function doDone() {
  if (!state.jobId) return;
  const btn = $('#btn-done');
  btn.disabled = true;
  try {
    await apiPost('/api/cleanup', { job_id: state.jobId });
    setStatus('rd-status', 'Source cleaned. The output stays in the output/ folder.', 'ok');
    $('#btn-render').disabled = true;
    const nc = $('#btn-render-nocap'); if (nc) nc.disabled = true;
  } catch (e) {
    setStatus('rd-status', 'Cleanup failed: ' + e.message, 'err');
  } finally {
    btn.disabled = false;
  }
}

// ───────────────────────── thumbnail generator ─────────────────────────
// A dedicated 9:16 cover maker. Pick a frame on its own scrubber, generate an
// eye-catching headline (LLM) or type your own, then export a 1080×1920 PNG.
// Everything (frame capture, compositing, export) is client-side canvas — the
// only backend call is /api/thumbnail-text for the suggested wording.
function newThumbSlot() {
  return { kind: 'scene', fit: 'cover', snap: null, snapBox: null, snapTime: null,
           illImg: null, illUrl: null, illThumb: null };
}
const thumb = {
  text: '', font: 'Anton', size: 130, color: '#ffffff', stroke: '#000000',
  pos: 'bottom', upper: true, shade: true,
  layout: 'two',                         // 'full' (1 box) | 'two' (top 3/8 + bottom 5/8)
  effect: 'none',                        // finish over the whole thumbnail (crumple/grain/vignette)
  slots: [newThumbSlot(), newThumbSlot()],  // 0 = top/full → box1 ; 1 = bottom → box2
  intro: { enabled: false, transition: 'crumple', duration: 4, voice: true, engine: 'gtts' },  // intro card
};
function resetThumbSlots() {
  thumb.slots = [newThumbSlot(), newThumbSlot()];
  // New clip → the composed thumbnail no longer exists, so the intro must be
  // re-armed deliberately (transition/duration/voice prefs are kept).
  thumb.intro.enabled = false;
  const cb = $('#th-intro'); if (cb) cb.checked = false;
  if (typeof updateRenderIntroNote === 'function') updateRenderIntroNote();
}

function wireThumb() {
  els.thumbVideo = $('#thumb-video');
  els.thumbCanvas = $('#thumb-canvas');
  if (!els.thumbCanvas) return;
  const v = els.thumbVideo;

  v.addEventListener('loadedmetadata', () => {
    const scr = $('#thumb-scrubber'); if (scr) scr.max = v.duration || 0;
    const d = $('#thumb-dur'); if (d) d.textContent = formatTime(v.duration || 0);
    drawThumb();
  });
  v.addEventListener('loadeddata', drawThumb);
  v.addEventListener('seeked', drawThumb);
  v.addEventListener('timeupdate', () => {
    const t = $('#thumb-time'); if (t) t.textContent = formatTime(v.currentTime || 0);
  });
  $('#thumb-scrubber').addEventListener('input', (e) => {
    if (!v.duration) return;
    v.currentTime = +e.target.value;
    const t = $('#thumb-time'); if (t) t.textContent = formatTime(+e.target.value);
  });

  // headline text controls
  $('#thumb-text').addEventListener('input', (e) => { thumb.text = e.target.value; drawThumb(); });
  $('#thumb-font').addEventListener('change', (e) => {
    thumb.font = e.target.value;
    document.fonts.load(`bold 120px "${thumb.font}"`).then(drawThumb).catch(drawThumb);
  });
  $('#thumb-size').addEventListener('input', (e) => { thumb.size = +e.target.value || 130; drawThumb(); });
  $('#thumb-color').addEventListener('input', (e) => { thumb.color = e.target.value; drawThumb(); });
  $('#thumb-stroke').addEventListener('input', (e) => { thumb.stroke = e.target.value; drawThumb(); });
  $('#thumb-pos').addEventListener('change', (e) => { thumb.pos = e.target.value; drawThumb(); });
  $('#thumb-upper').addEventListener('change', (e) => { thumb.upper = e.target.checked; drawThumb(); });
  $('#thumb-shade').addEventListener('change', (e) => { thumb.shade = e.target.checked; drawThumb(); });
  const eff = $('#thumb-effect');
  if (eff) eff.addEventListener('change', (e) => { thumb.effect = e.target.value; drawThumb(); });
  $('#btn-thumb-gen').addEventListener('click', doThumbGen);
  $('#btn-thumb-dl').addEventListener('click', downloadThumb);

  // background layout toggle
  document.querySelectorAll('#thumb-layout-toggle .seg').forEach(b => b.addEventListener('click', () => {
    thumb.layout = b.dataset.layout;
    renderThumbLayoutToggle(); renderThumbSlots(); drawThumb();
  }));

  // intro card controls
  $('#th-intro').addEventListener('change', (e) => { thumb.intro.enabled = e.target.checked; updateRenderIntroNote(); });
  $('#th-intro-trans').addEventListener('change', (e) => { thumb.intro.transition = e.target.value; updateRenderIntroNote(); });
  $('#th-intro-dur').addEventListener('input', (e) => { thumb.intro.duration = +e.target.value || 4; });
  $('#th-intro-voice').addEventListener('change', (e) => { thumb.intro.voice = e.target.checked; });
  const eng = $('#th-intro-engine');
  if (eng) eng.addEventListener('change', (e) => { thumb.intro.engine = e.target.value; });
  $('#btn-th-voice').addEventListener('click', previewVoice);
  $('#btn-th-trans').addEventListener('click', playTransitionPreview);
}

// Synthesize the headline with Piper and play it (intro voice preview).
async function previewVoice() {
  const btn = $('#btn-th-voice');
  if (btn && btn.disabled) return;   // in-flight (or no TTS) — don't stack requests
  const text = (thumb.text || $('#f-title').value || '').trim();
  if (!text) { setStatus('th-intro-status', 'No headline text to read.', 'err'); return; }
  if (btn) btn.disabled = true;
  setStatus('th-intro-status', 'Synthesizing voice…');
  try {
    const r = await fetch('/api/tts-preview', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, engine: (thumb.intro && thumb.intro.engine) || 'gtts' }),
    });
    if (!r.ok) throw new Error((await r.text()) || r.statusText);
    const blob = await r.blob();
    if (thumb._voiceAudio) {
      try { thumb._voiceAudio.pause(); } catch (_) {}
      if (thumb._voiceUrl) URL.revokeObjectURL(thumb._voiceUrl);
    }
    const url = URL.createObjectURL(blob);
    const a = new Audio(url);
    a.onended = () => { if (thumb._voiceUrl === url) { URL.revokeObjectURL(url); thumb._voiceUrl = null; } };
    thumb._voiceAudio = a;
    thumb._voiceUrl = url;
    await a.play();
    setStatus('th-intro-status', '▶ playing the voiceover', 'ok');
  } catch (e) {
    setStatus('th-intro-status', 'Voice failed: ' + e.message, 'err');
  } finally {
    if (btn) btn.disabled = false;
  }
}

// Animate the transition (thumbnail → a content frame) on a small canvas.
function drawTrans(ctx, A, B, W, H, trans, p) {
  if (trans === 'fade' || trans === 'dissolve') {
    ctx.drawImage(B, 0, 0); ctx.globalAlpha = 1 - p; ctx.drawImage(A, 0, 0); ctx.globalAlpha = 1;
  } else if (trans === 'zoomin') {
    ctx.drawImage(B, 0, 0);
    ctx.save(); ctx.globalAlpha = 1 - p; const s = 1 + 0.5 * p;
    ctx.translate(W / 2, H / 2); ctx.scale(s, s); ctx.drawImage(A, -W / 2, -H / 2); ctx.restore();
  } else if (trans === 'slideleft') {
    ctx.drawImage(A, -p * W, 0); ctx.drawImage(B, (1 - p) * W, 0);
  } else if (trans === 'slideup') {
    ctx.drawImage(A, 0, -p * H); ctx.drawImage(B, 0, (1 - p) * H);
  } else if (trans === 'circleopen') {
    ctx.drawImage(A, 0, 0);
    ctx.save(); ctx.beginPath(); ctx.arc(W / 2, H / 2, p * Math.hypot(W, H) / 2, 0, Math.PI * 2); ctx.clip();
    ctx.drawImage(B, 0, 0); ctx.restore();
  } else if (trans === 'crumple') {
    // Mirror the backend's _CRUMPLE_EXPR: ~48px (scaled) facets flip A→B at a
    // threshold = blocky pseudo-noise + radial term, so it caves edge→centre.
    ctx.drawImage(A, 0, 0);
    const F = Math.max(8, Math.round(W / 11));    // facet size, ~ the 48px backend grid scaled to the preview
    const cx = W / 2, cy = H / 2, maxR = Math.hypot(W / 2, H / 2);
    for (let gy = 0; gy < H; gy += F) {
      for (let gx = 0; gx < W; gx += F) {
        const noise = Math.abs(Math.sin(Math.floor(gx / F) * 12.9898 + Math.floor(gy / F) * 78.233) * 43758.5453) % 1;
        const radial = 1 - Math.hypot(gx + F / 2 - cx, gy + F / 2 - cy) / maxR;
        const thresh = noise * 0.55 + radial * 0.45;
        if (p * 1.4 - 0.4 > thresh) ctx.drawImage(B, gx, gy, F, F, gx, gy, F, F);
      }
    }
  } else {  // cut / fallback
    ctx.drawImage(p < 0.5 ? A : B, 0, 0);
  }
}

function playTransitionPreview() {
  const cv = $('#th-trans-preview');
  if (!cv) return;
  cv.classList.remove('hidden');
  const W = cv.width, H = cv.height, ctx = cv.getContext('2d');
  // A = the composed thumbnail
  const A = document.createElement('canvas'); A.width = W; A.height = H;
  drawThumbnailInto(A.getContext('2d'), W, H);
  // B = a content frame (the thumb-video's current frame, cover-fit 9:16)
  const B = document.createElement('canvas'); B.width = W; B.height = H;
  const bx = B.getContext('2d'); bx.fillStyle = '#000'; bx.fillRect(0, 0, W, H);
  if (els.thumbVideo && els.thumbVideo.videoWidth) coverDraw(bx, els.thumbVideo, 0, 0, W, H);
  const trans = thumb.intro.transition || 'fade';
  const HOLD = 700, XF = trans === 'cut' ? 1 : 650;
  const start = performance.now();
  // Re-click restarts cleanly: only the latest generation keeps animating.
  const gen = (thumb._transGen = (thumb._transGen || 0) + 1);
  function frame(now) {
    if (gen !== thumb._transGen) return;
    const t = now - start;
    ctx.clearRect(0, 0, W, H);
    if (t < HOLD) ctx.drawImage(A, 0, 0);
    else if (t < HOLD + XF) drawTrans(ctx, A, B, W, H, trans, (t - HOLD) / XF);
    else { ctx.drawImage(B, 0, 0); if (t < HOLD + XF + HOLD) requestAnimationFrame(frame); return; }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

// Reflect the intro state in the Render step's note.
function updateRenderIntroNote() {
  const el = $('#rd-intro-status');
  if (!el) return;
  el.innerHTML = thumb.intro.enabled
    ? `Intro card: <b>ON</b> · ${thumb.intro.transition}${thumb.intro.voice ? ' · 🔊 voice' : ''} — set in the <b>Thumbnail</b> step.`
    : 'Intro card: off — turn it on in the <b>Thumbnail</b> step (preview voice + transition there).';
}

function renderThumbLayoutToggle() {
  document.querySelectorAll('#thumb-layout-toggle .seg')
    .forEach(b => b.classList.toggle('active', b.dataset.layout === thumb.layout));
}

function initThumbStep() {
  if (!state.source || !els.thumbVideo) return;
  const v = els.thumbVideo;
  if (v.dataset.path !== state.source.video_path) {
    v.dataset.path = state.source.video_path;
    v.src = state.source.video_path;
  }
  const ta = $('#thumb-text');
  if (ta && !ta.value) {
    const t = ($('#f-title').value || '').trim();
    if (t && t.toLowerCase() !== 'clip') { ta.value = t; thumb.text = t; }
  }
  renderThumbLayoutToggle();
  renderThumbSlots();
  drawThumb();
}

function thumbSlotCount() { return thumb.layout === 'full' ? 1 : 2; }
function thumbSlotLabel(i) {
  if (thumb.layout === 'full') return 'Background';
  return i === 0 ? 'Top (Box 1)' : 'Bottom (Box 2)';
}

// Render the per-box source cards (Scene / Illustration + fit) into #thumb-slots.
function renderThumbSlots() {
  const box = $('#thumb-slots');
  if (!box) return;
  let html = '';
  for (let i = 0; i < thumbSlotCount(); i++) {
    const s = thumb.slots[i];
    const stat = s.kind === 'scene'
      ? (s.snap ? `captured @ ${(s.snapTime || 0).toFixed(1)}s ✓` : 'not captured yet')
      : (s.illThumb ? 'image picked ✓' : 'no image yet');
    html += `<div class="thumb-slot" data-i="${i}">
      <div class="thumb-slot-head">${thumbSlotLabel(i)}</div>
      <div class="thumb-row">
        <div class="thumb-seg thumb-src">
          <button class="seg ${s.kind === 'scene' ? 'active' : ''}" data-src="scene" data-i="${i}">Scene</button>
          <button class="seg ${s.kind === 'ill' ? 'active' : ''}" data-src="ill" data-i="${i}">Illustration</button>
        </div>
        <select class="thumb-fit" data-i="${i}" title="fit"><option value="cover"${s.fit === 'cover' ? ' selected' : ''}>Cover</option><option value="blur"${s.fit === 'blur' ? ' selected' : ''}>Blur</option></select>
      </div>
      ${s.kind === 'scene' ? `
        <div class="thumb-scene">
          <button class="thumb-capture" data-i="${i}">📸 Capture current frame</button>
          <span class="status thumb-snap ${s.snap ? 'ok' : ''}">${stat}</span>
        </div>` : `
        <div class="thumb-ill">
          <div class="thumb-ill-search"><input class="thumb-ill-q" data-i="${i}" placeholder="search Pexels"><button class="thumb-ill-go" data-i="${i}">Search</button></div>
          <div class="thumb-ill-cands" data-i="${i}"></div>
          <span class="status thumb-ill-status ${s.illThumb ? 'ok' : ''}" data-i="${i}">${stat}</span>
        </div>`}
    </div>`;
  }
  box.innerHTML = html;
  box.querySelectorAll('.thumb-src .seg').forEach(b => b.addEventListener('click', () => {
    thumb.slots[+b.dataset.i].kind = b.dataset.src; renderThumbSlots(); drawThumb();
  }));
  box.querySelectorAll('.thumb-fit').forEach(s => s.addEventListener('change', (e) => {
    thumb.slots[+e.target.dataset.i].fit = e.target.value; drawThumb();
  }));
  box.querySelectorAll('.thumb-capture').forEach(b => b.addEventListener('click', () => captureSlot(+b.dataset.i)));
  box.querySelectorAll('.thumb-ill-go').forEach(b => b.addEventListener('click', () => {
    const i = +b.dataset.i;
    thumbIllSearch(i, box.querySelector(`.thumb-ill-q[data-i="${i}"]`).value.trim());
  }));
  box.querySelectorAll('.thumb-ill-q').forEach(inp => inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') thumbIllSearch(+e.target.dataset.i, e.target.value.trim());
  }));
}

// Snapshot the current video frame for a Scene slot (in 2-box mode it crops to
// the Position box: top → box1, bottom → box2; full → the whole frame).
function captureSlot(i) {
  const v = els.thumbVideo;
  if (!v || !v.videoWidth) { setStatus('thumb-status', 'Video not ready yet.', 'err'); return; }
  const off = document.createElement('canvas');
  off.width = v.videoWidth; off.height = v.videoHeight;
  off.getContext('2d').drawImage(v, 0, 0);
  const s = thumb.slots[i];
  s.snap = off; s.snapTime = v.currentTime || 0;
  if (thumb.layout === 'two') {
    const b = boxAt(i === 0 ? 1 : 2, s.snapTime);
    s.snapBox = b ? { x: b.x, y: b.y, w: b.w, h: b.h } : null;
  } else {
    s.snapBox = null;
  }
  renderThumbSlots(); drawThumb();
}

async function thumbIllSearch(i, q) {
  const box = $('#thumb-slots');
  const cont = box && box.querySelector(`.thumb-ill-cands[data-i="${i}"]`);
  const st = box && box.querySelector(`.thumb-ill-status[data-i="${i}"]`);
  if (!q) { if (st) { st.textContent = 'Type a query.'; st.className = 'status thumb-ill-status err'; } return; }
  if (st) { st.textContent = 'Searching…'; st.className = 'status thumb-ill-status'; }
  try {
    const res = await apiPost('/api/search', { query: q });
    const cands = res.candidates || [];
    if (cont) {
      cont.innerHTML = cands.map(c => `<button class="thumb-cand" data-url="${escapeHtml(c.full)}" data-thumb="${escapeHtml(c.thumb)}"><img src="${escapeHtml(c.thumb)}" loading="lazy" alt=""></button>`).join('');
      cont.querySelectorAll('.thumb-cand').forEach(b => b.addEventListener('click', () => pickThumbIll(i, b.dataset.url, b.dataset.thumb)));
    }
    if (st) { st.textContent = cands.length ? 'Click an image.' : 'No results.'; st.className = 'status thumb-ill-status ' + (cands.length ? 'ok' : 'err'); }
  } catch (e) {
    if (st) { st.textContent = 'Failed: ' + e.message; st.className = 'status thumb-ill-status err'; }
  }
}

function pickThumbIll(i, fullUrl, thumbUrl) {
  const s = thumb.slots[i];
  const img = new Image();
  img.onload = drawThumb;
  // via the same-origin proxy so the canvas isn't tainted (export would fail)
  img.src = '/api/img?url=' + encodeURIComponent(fullUrl);
  s.illImg = img; s.illUrl = fullUrl; s.illThumb = thumbUrl;
  renderThumbSlots(); drawThumb();
}

// Draw the preview at the canvas' display resolution.
function drawThumb() {
  const c = els.thumbCanvas;
  if (!c) return;
  drawThumbnailInto(c.getContext('2d'), c.width, c.height);
}

function thumbSlotRects(W, H) {
  if (thumb.layout === 'full') return [[0, 0, W, H]];
  const top = H * 3 / 8;
  return [[0, 0, W, top], [0, top, W, H - top]];
}

// Parametric so the same code renders the preview AND the 1080×1920 export.
function drawThumbnailInto(ctx, W, H) {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  thumbSlotRects(W, H).forEach((r, i) => drawThumbSlot(ctx, thumb.slots[i], r[0], r[1], r[2], r[3]));
  if (thumb.shade) drawThumbShade(ctx, W, H);
  drawThumbText(ctx, W, H);
  applyThumbEffect(ctx, W, H);
}

// ── thumbnail finish effects (crumpled paper / grain / vignette) ──
// Procedural, deterministic (seeded RNG) and cached per (effect, size) so the
// preview doesn't shimmer on every redraw. Drawn OVER everything — the paper
// holds the printed image, so the texture covers photo + text alike.
const _fxCache = {};

function _seededRand(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function _crumpleLayer(W, H) {
  const key = `crumple_${W}x${H}`;
  if (_fxCache[key]) return _fxCache[key];
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const x = c.getContext('2d');
  const rnd = _seededRand(1306619051);
  x.fillStyle = 'rgb(128,128,128)';            // neutral for 'overlay' blending
  x.fillRect(0, 0, W, H);
  // faceted shading: random triangles a touch lighter/darker than neutral
  for (let i = 0; i < 220; i++) {
    const cx = rnd() * W, cy = rnd() * H, r = (0.04 + rnd() * 0.16) * Math.max(W, H);
    const a0 = rnd() * Math.PI * 2, a1 = a0 + 0.6 + rnd() * 1.6, a2 = a1 + 0.6 + rnd() * 1.6;
    const tone = 128 + (rnd() - 0.5) * 56;
    x.fillStyle = `rgba(${tone | 0},${tone | 0},${tone | 0},0.5)`;
    x.beginPath();
    x.moveTo(cx + Math.cos(a0) * r, cy + Math.sin(a0) * r);
    x.lineTo(cx + Math.cos(a1) * r, cy + Math.sin(a1) * r);
    x.lineTo(cx + Math.cos(a2) * r, cy + Math.sin(a2) * r);
    x.closePath(); x.fill();
  }
  // sharp creases: long thin light/dark line pairs (the fold catches the light)
  for (let i = 0; i < 26; i++) {
    const x0 = rnd() * W, y0 = rnd() * H;
    const ang = rnd() * Math.PI * 2, len = (0.3 + rnd() * 0.7) * Math.max(W, H);
    const x1 = x0 + Math.cos(ang) * len, y1 = y0 + Math.sin(ang) * len;
    const nx = -Math.sin(ang), ny = Math.cos(ang);
    const lw = Math.max(1, W / 360);
    x.lineWidth = lw;
    x.strokeStyle = 'rgba(235,235,235,0.55)';
    x.beginPath(); x.moveTo(x0, y0); x.lineTo(x1, y1); x.stroke();
    x.strokeStyle = 'rgba(30,30,30,0.45)';
    x.beginPath(); x.moveTo(x0 + nx * lw, y0 + ny * lw); x.lineTo(x1 + nx * lw, y1 + ny * lw); x.stroke();
  }
  // soften the facets a touch
  const soft = document.createElement('canvas');
  soft.width = W; soft.height = H;
  const sx = soft.getContext('2d');
  sx.filter = `blur(${Math.max(1, W / 540)}px)`;
  sx.drawImage(c, 0, 0);
  _fxCache[key] = soft;
  return soft;
}

function _grainLayer(W, H) {
  const key = `grain_${W}x${H}`;
  if (_fxCache[key]) return _fxCache[key];
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const x = c.getContext('2d');
  const img = x.createImageData(W, H);
  const rnd = _seededRand(20260611);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = 96 + rnd() * 64;          // mid-gray noise
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  x.putImageData(img, 0, 0);
  _fxCache[key] = c;
  return c;
}

function applyThumbEffect(ctx, W, H) {
  const fx = thumb.effect || 'none';
  if (fx === 'none') return;
  if (fx.includes('crumple')) {
    ctx.save();
    ctx.globalCompositeOperation = 'overlay';
    ctx.globalAlpha = 0.85;
    ctx.drawImage(_crumpleLayer(W, H), 0, 0);
    ctx.restore();
  }
  if (fx.includes('grain')) {
    ctx.save();
    ctx.globalCompositeOperation = 'overlay';
    ctx.globalAlpha = 0.5;
    ctx.drawImage(_grainLayer(W, H), 0, 0);
    ctx.restore();
  }
  if (fx.includes('vignette')) {
    ctx.save();
    const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.45,
                                       W / 2, H / 2, Math.hypot(W, H) / 2);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,0.55)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }
}

// cover / contain a SOURCE REGION (sx,sy,sw,sh) of `src` into a dest rect.
function coverRegion(ctx, src, sx, sy, sw, sh, dx, dy, dw, dh) {
  const rAR = sw / sh, dAR = dw / dh;
  let cw, ch, cx, cy;
  if (rAR > dAR) { ch = sh; cw = sh * dAR; cx = sx + (sw - cw) / 2; cy = sy; }
  else { cw = sw; ch = sw / dAR; cx = sx; cy = sy + (sh - ch) / 2; }
  try { ctx.drawImage(src, cx, cy, cw, ch, dx, dy, dw, dh); } catch (_) {}
}
function containRegion(ctx, src, sx, sy, sw, sh, dx, dy, dw, dh) {
  const rAR = sw / sh, dAR = dw / dh;
  let ow, oh;
  if (rAR > dAR) { ow = dw; oh = dw / rAR; } else { oh = dh; ow = dh * rAR; }
  try { ctx.drawImage(src, sx, sy, sw, sh, dx + (dw - ow) / 2, dy + (dh - oh) / 2, ow, oh); } catch (_) {}
}

function drawThumbSlot(ctx, slot, dx, dy, dw, dh) {
  if (!slot) return;
  let src = null, sx = 0, sy = 0, sw = 0, sh = 0;
  if (slot.kind === 'ill' && slot.illImg && slot.illImg.complete && slot.illImg.naturalWidth) {
    src = slot.illImg; sw = src.naturalWidth; sh = src.naturalHeight;
  } else if (slot.kind === 'scene' && slot.snap) {
    src = slot.snap;
    if (slot.snapBox) { sx = slot.snapBox.x; sy = slot.snapBox.y; sw = slot.snapBox.w; sh = slot.snapBox.h; }
    else { sw = src.width; sh = src.height; }
  }
  if (!src) {  // placeholder
    ctx.save();
    ctx.fillStyle = '#15151a'; ctx.fillRect(dx, dy, dw, dh);
    ctx.fillStyle = '#555'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = `${Math.max(9, dw * 0.045)}px JetBrains Mono, monospace`;
    ctx.fillText(slot.kind === 'ill' ? 'pick an image' : 'capture a frame', dx + dw / 2, dy + dh / 2);
    ctx.restore();
    return;
  }
  ctx.save();
  ctx.beginPath(); ctx.rect(dx, dy, dw, dh); ctx.clip();
  if (slot.fit === 'blur') {
    ctx.filter = 'blur(10px) brightness(0.9)';
    coverRegion(ctx, src, sx, sy, sw, sh, dx, dy, dw, dh);
    ctx.filter = 'none';
    containRegion(ctx, src, sx, sy, sw, sh, dx, dy, dw, dh);
  } else {
    coverRegion(ctx, src, sx, sy, sw, sh, dx, dy, dw, dh);
  }
  ctx.restore();
}

// Dark gradient behind the text band so any footage stays readable.
function drawThumbShade(ctx, W, H) {
  ctx.save();
  let g;
  if (thumb.pos === 'top') {
    g = ctx.createLinearGradient(0, 0, 0, H * 0.5);
    g.addColorStop(0, 'rgba(0,0,0,0.7)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H * 0.5);
  } else if (thumb.pos === 'bottom') {
    g = ctx.createLinearGradient(0, H, 0, H * 0.5);
    g.addColorStop(0, 'rgba(0,0,0,0.7)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.fillRect(0, H * 0.5, W, H * 0.5);
  } else {
    g = ctx.createLinearGradient(0, H * 0.28, 0, H * 0.72);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(0.5, 'rgba(0,0,0,0.6)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.fillRect(0, H * 0.28, W, H * 0.44);
  }
  ctx.restore();
}

function wrapThumbLines(ctx, text, maxW) {
  const out = [];
  for (const para of text.split('\n')) {
    const words = para.split(/\s+/).filter(Boolean);
    if (!words.length) continue;
    let cur = words[0];
    for (let i = 1; i < words.length; i++) {
      const test = cur + ' ' + words[i];
      if (ctx.measureText(test).width > maxW) { out.push(cur); cur = words[i]; }
      else cur = test;
    }
    out.push(cur);
  }
  return out;
}

function drawThumbText(ctx, W, H) {
  let text = (thumb.text || '').trim();
  if (!text) return;
  if (thumb.upper) text = text.toUpperCase();
  const scale = W / OUT_W;                       // OUT_W = 1080 (output width)
  const fontPx = Math.max(8, thumb.size * scale);
  const lineH = fontPx * 1.08;
  const maxW = W * 0.9;

  ctx.save();
  ctx.font = `bold ${fontPx}px "${thumb.font}", Impact, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';

  const lines = wrapThumbLines(ctx, text, maxW);
  const blockH = lines.length * lineH;
  const margin = H * 0.06;
  let cy;
  if (thumb.pos === 'top') cy = margin + lineH / 2;
  else if (thumb.pos === 'bottom') cy = H - margin - blockH + lineH / 2;
  else cy = H / 2 - blockH / 2 + lineH / 2;

  ctx.lineWidth = Math.max(2, fontPx * 0.14);
  ctx.strokeStyle = thumb.stroke;
  ctx.fillStyle = thumb.color;
  for (const line of lines) {
    ctx.strokeText(line, W / 2, cy);
    ctx.fillText(line, W / 2, cy);
    cy += lineH;
  }
  ctx.restore();
}

async function doThumbGen() {
  const btn = $('#btn-thumb-gen');
  const context = [
    ($('#f-title').value || '').trim(),
    ($('#f-desc').value || '').trim(),
    (state.words || []).map(w => w.word).join(' ').trim(),
  ].filter(Boolean).join('\n');
  if (btn) btn.disabled = true;
  setStatus('thumb-gen-status', 'Generating headline ideas… (first call may warm the model)');
  try {
    const tone = $('#thumb-tone') ? $('#thumb-tone').value : '';
    const res = await apiPost('/api/thumbnail-text', { context, n: 6, tone });
    const titles = res.titles || [];
    renderThumbIdeas(titles);
    setStatus('thumb-gen-status',
      titles.length ? `${titles.length} ideas — click one to use it, then tweak` : 'No ideas returned',
      titles.length ? 'ok' : 'err');
  } catch (e) {
    setStatus('thumb-gen-status', 'Failed: ' + e.message, 'err');
  } finally {
    if (btn) btn.disabled = false;
  }
}

function renderThumbIdeas(titles) {
  const box = $('#thumb-ideas');
  if (!box) return;
  box.innerHTML = titles
    .map(t => `<button class="thumb-idea" type="button">${escapeHtml(t)}</button>`)
    .join('');
  box.querySelectorAll('.thumb-idea').forEach(b => b.addEventListener('click', () => {
    const ta = $('#thumb-text');
    if (ta) ta.value = b.textContent;
    thumb.text = b.textContent;
    drawThumb();
  }));
}

async function downloadThumb() {
  // Make sure the chosen webfont is ready before rasterizing at full res.
  try { await document.fonts.load(`bold ${thumb.size}px "${thumb.font}"`); } catch (_) {}
  const off = document.createElement('canvas');
  off.width = OUT_W; off.height = OUT_H;        // 1080×1920
  try {
    drawThumbnailInto(off.getContext('2d'), OUT_W, OUT_H);
    off.toBlob((blob) => {
      if (!blob) { setStatus('thumb-status', 'Export failed (a background image may be cross-origin).', 'err'); return; }
      const a = document.createElement('a');
      const title = ($('#f-title').value.trim() || 'clip').replace(/[^\w.-]+/g, '_');
      a.href = URL.createObjectURL(blob);
      a.download = `${title}_thumbnail.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      setStatus('thumb-status', `Saved ${a.download}`, 'ok');
    }, 'image/png');
  } catch (e) {
    setStatus('thumb-status', 'Export failed: ' + e.message, 'err');
  }
}

// ───────────────────────── batch queue (sidebar) ─────────────────────────
// Upload a JSON of clips → the backend worker downloads + auto-boxes each one in
// the background (persisted across restarts). The sidebar lists jobs by id; open
// a ready one to fine-tune the boxes (auto-saved back to the job), delete when done.
function wireQueue() {
  const btn = $('#btn-queue-import');
  const file = $('#queue-file');
  if (!btn || !file) return;
  btn.addEventListener('click', () => file.click());
  file.addEventListener('change', async () => {
    const f = file.files[0];
    if (!f) return;
    const text = await f.text();
    file.value = '';
    setStatus('queue-status', 'Importing…');
    try {
      const res = await apiPost('/api/queue/import', { content: text });
      setStatus('queue-status',
        `Added ${res.added}, skipped ${res.skipped} (already queued). Working in the background…`, 'ok');
      refreshQueue();
    } catch (e) {
      setStatus('queue-status', 'Import failed: ' + e.message, 'err');
    }
  });
  const all = $('#btn-queue-render-all');
  if (all) all.addEventListener('click', renderAllReady);
  refreshQueue();
  setInterval(refreshQueue, 3000);   // live status while the worker churns
  setInterval(autosaveQueue, 5000);  // persist box edits on the active job
}

async function refreshQueue() {
  try {
    const r = await fetch('/api/queue');
    if (!r.ok) return;
    const data = await r.json();
    renderQueueList(data.jobs || []);
  } catch (e) { /* sidebar is best-effort */ }
}

function statusBadge(s) {
  const label = {
    pending: 'queued', downloading: 'downloading', predicting: 'boxing',
    ready: 'ready', render_queued: 'render queued', rendering: 'rendering',
    done: 'done', error: 'error',
  }[s] || s;
  return `<span class="q-badge ${s}">${label}</span>`;
}

function renderQueueList(jobs) {
  const ul = $('#queue-list');
  const meta = $('#queue-meta');
  if (!ul) return;
  if (!jobs.length) {
    ul.innerHTML = '';
    if (meta) meta.textContent = 'No jobs queued.';
    return;
  }
  const c = jobs.reduce((a, j) => { a[j.status] = (a[j.status] || 0) + 1; return a; }, {});
  const working = (c.pending || 0) + (c.downloading || 0) + (c.predicting || 0) + (c.render_queued || 0) + (c.rendering || 0);
  if (meta) meta.textContent = `${jobs.length} job(s) · ${c.ready || 0} ready · ${c.done || 0} done · ${working} working${c.error ? ` · ${c.error} error` : ''}`;
  ul.innerHTML = jobs.map(j => {
    const active = j.key === state.activeQueueKey ? ' active' : '';
    const canOpen = j.status === 'ready' || j.status === 'done';
    const kf = canOpen ? ` · ${j.kf1}+${j.kf2} kf` : '';
    const renderBtn = canOpen
      ? `<button class="q-render" data-key="${j.key}" title="${j.status === 'done' ? 're-render this clip' : 'transcribe + render this clip (queued, runs in background)'}">▶</button>`
      : '';
    const dl = (j.status === 'done' && j.output_path)
      ? `<a class="q-dl" href="${j.output_path}" download="${escapeHtml(j.filename || 'clip.mp4')}" title="download the rendered mp4">↓</a>`
      : '';
    const retry = j.status === 'error' ? `<button class="q-retry" data-key="${j.key}" title="retry this job">↻</button>` : '';
    return `<li class="queue-item${active}" data-status="${j.status}">
      <button class="queue-open" data-key="${j.key}" ${canOpen ? '' : 'disabled'} title="${escapeHtml(j.message || '')}">
        <span class="q-id">${escapeHtml(j.id)}</span>
        <span class="q-title">${escapeHtml(j.title || '')}</span>
        <span class="q-sub">${statusBadge(j.status)}${kf}</span>
      </button>
      ${dl}${renderBtn}${retry}
      <button class="q-del" data-key="${j.key}" title="delete job + its files">×</button>
    </li>`;
  }).join('');
  ul.querySelectorAll('.queue-open').forEach(b => b.addEventListener('click', () => openQueueJob(b.dataset.key)));
  ul.querySelectorAll('.q-render').forEach(b => b.addEventListener('click', () => renderQueueJob(b.dataset.key)));
  ul.querySelectorAll('.q-del').forEach(b => b.addEventListener('click', () => deleteQueueJob(b.dataset.key)));
  ul.querySelectorAll('.q-retry').forEach(b => b.addEventListener('click', () => retryQueueJob(b.dataset.key)));
}

async function openQueueJob(key) {
  await autosaveQueue();             // flush edits on the previously-open job first
  let job;
  try {
    const r = await fetch('/api/queue/' + key);
    if (!r.ok) throw new Error(await r.text());
    job = await r.json();
  } catch (e) {
    setStatus('queue-status', 'Could not open job: ' + e.message, 'err');
    return;
  }
  if (!job.job_id) {
    setStatus('queue-status', 'Still processing — open it once it says "ready".', 'err');
    return;
  }
  state.activeQueueKey = key;
  state.jobId = job.job_id;
  state.source = {
    width: job.width, height: job.height,
    duration: job.duration, video_path: job.video_path,
  };
  state.keyframes = { 1: job.box1 || [], 2: job.box2 || [] };
  state.currentTime = 0;
  state.words = [];
  state.sfx = [];                  // placements are per-clip
  state.ills = [];                 // cutaways are per-clip
  state.keep = []; state.keepA = null;  // keep-windows are per-clip
  resetThumbSlots();               // thumbnail backgrounds reference the old clip
  state.renderRange = { start: null, end: null };
  state.autoRange = { start: 0, end: job.duration };
  // Reflect the job in the Step 1 form + prefill the auto-box prompts so a
  // re-Generate uses the same prompt the batch ran with.
  $('#f-url').value = job.url || '';
  $('#f-title').value = job.title || 'clip';
  $('#f-start').value = job.start || '00:00:00';
  $('#f-end').value = job.end || '';
  $('#f-desc').value = job.description || '';
  // Context + per-box prompts are EDITABLE and kept SEPARATE in the UI. The
  // shared layout context (with {layout}/{side} placeholders) goes in its own
  // field; the box prompts hold only the short per-box instruction. doAutoBox
  // re-merges [model observation] + [context] + [per-box prompt] at Generate
  // time — exactly the batch worker's order. (auto_context = the model's own
  // mid-clip observation, hidden but still prepended.)
  state.autoObs = (job.auto_context || '').trim();
  if ($('#ab-context')) $('#ab-context').value = job.context || '';
  if ($('#ab-prompt-1')) $('#ab-prompt-1').value = job.prompt1 || '';
  if ($('#ab-prompt-2')) $('#ab-prompt-2').value = job.prompt2 || '';
  if ($('#rd-start')) { $('#rd-start').value = ''; $('#rd-end').value = ''; }
  els.video.src = job.video_path;
  updatePlayBtn(false);
  setActiveBox(null);
  updateRangeMeta();
  state.queueSig = queueSig();       // baseline so autosave only fires on real edits
  setStatus('queue-status', `Editing "${job.id}" — box edits auto-save.`, 'ok');
  showStep(2);
  refreshQueue();                    // update the active highlight
}

function queueSig() {
  return JSON.stringify({
    t: ($('#f-title').value || ''),
    b1: state.keyframes[1],
    b2: state.keyframes[2],
    ctx: ($('#ab-context') ? $('#ab-context').value : ''),
    p1: ($('#ab-prompt-1') ? $('#ab-prompt-1').value : ''),
    p2: ($('#ab-prompt-2') ? $('#ab-prompt-2').value : ''),
  });
}

async function autosaveQueue() {
  if (!state.activeQueueKey) return;
  const sig = queueSig();
  if (sig === state.queueSig) return;   // nothing changed since last save
  state.queueSig = sig;
  try {
    await apiPost(`/api/queue/${state.activeQueueKey}/save`, {
      title: $('#f-title').value.trim() || 'clip',
      box1: state.keyframes[1] || [],
      box2: state.keyframes[2] || [],
      context: $('#ab-context') ? $('#ab-context').value : '',
      prompt1: $('#ab-prompt-1') ? $('#ab-prompt-1').value : '',
      prompt2: $('#ab-prompt-2') ? $('#ab-prompt-2').value : '',
    });
    setStatus('queue-status', 'Progress saved ✓', 'ok');
  } catch (e) { /* try again next tick — keep the new sig so we don't spin */ }
}

async function deleteQueueJob(key) {
  if (!confirm('Delete this job from the queue? Its downloaded clip is removed too.')) return;
  try {
    await fetch('/api/queue/' + key, { method: 'DELETE' });
    if (state.activeQueueKey === key) state.activeQueueKey = null;
    refreshQueue();
  } catch (e) {
    setStatus('queue-status', 'Delete failed: ' + e.message, 'err');
  }
}

async function retryQueueJob(key) {
  try {
    await apiPost(`/api/queue/${key}/retry`, {});
    refreshQueue();
  } catch (e) {
    setStatus('queue-status', 'Retry failed: ' + e.message, 'err');
  }
}

async function renderQueueJob(key) {
  if (state.activeQueueKey === key) await autosaveQueue();   // flush box edits first
  try {
    await apiPost(`/api/queue/${key}/render`, {});
    setStatus('queue-status', 'Queued for render — transcribe + render runs in the background, one at a time.', 'ok');
    refreshQueue();
  } catch (e) {
    setStatus('queue-status', 'Could not queue render: ' + e.message, 'err');
  }
}

async function renderAllReady() {
  try {
    const r = await apiPost('/api/queue/render-ready', {});
    setStatus('queue-status', r.queued ? `Queued ${r.queued} clip(s) for render.` : 'No ready clips to render.', 'ok');
    refreshQueue();
  } catch (e) {
    setStatus('queue-status', 'Failed: ' + e.message, 'err');
  }
}

// ───────────────────────── sound effects (soundboard) ─────────────────────────
// A persistent library of imported sounds (server-side, survives restart) +
// per-clip placements (one-shot at a time, or a layer over a range, each with a
// volume). Placements ride along in the render body → renderer mixes them.
function wireSfx() {
  els.sfxVideo = $('#sfx-video');
  if (!els.sfxVideo) return;
  const v = els.sfxVideo;
  v.addEventListener('loadedmetadata', () => {
    const scr = $('#sfx-scrubber'); if (scr) scr.max = v.duration || 0;
    const d = $('#sfx-dur'); if (d) d.textContent = formatTime(v.duration || 0);
    renderSfxTrack(); drawSfxPreview();
  });
  v.addEventListener('loadeddata', drawSfxPreview);
  v.addEventListener('seeked', () => { resetSfxAudio(); drawSfxPreview(); });
  v.addEventListener('timeupdate', () => {
    const t = $('#sfx-time'); if (t) t.textContent = formatTime(v.currentTime || 0);
    const scr = $('#sfx-scrubber'); if (scr && document.activeElement !== scr) scr.value = v.currentTime || 0;
    updateSfxCursor();
    drawSfxPreview();
    syncSfxAudio();
  });
  v.addEventListener('play', () => { const b = $('#sfx-play'); if (b) b.textContent = '❚❚'; });
  v.addEventListener('pause', () => { const b = $('#sfx-play'); if (b) b.textContent = '▶'; resetSfxAudio(); });
  $('#sfx-play').addEventListener('click', () => { if (v.paused) v.play(); else v.pause(); });
  $('#sfx-scrubber').addEventListener('input', (e) => { if (v.duration) v.currentTime = +e.target.value; });
  $('#btn-sfx-import').addEventListener('click', () => $('#sfx-file').click());
  $('#sfx-file').addEventListener('change', onSfxImport);
  $('#sfx-rs-cur').addEventListener('click', () => { $('#sfx-rs').value = (v.currentTime || 0).toFixed(2); });
  $('#sfx-re-cur').addEventListener('click', () => { $('#sfx-re').value = (v.currentTime || 0).toFixed(2); });
  $('#btn-sfx-addrange').addEventListener('click', addSfxRange);
  const tr = $('#sfx-track');
  if (tr) {
    tr.addEventListener('mousedown', onSfxTrackDown);
    tr.addEventListener('dblclick', onSfxTrackDblClick);
    window.addEventListener('mousemove', onSfxDragMove);
    window.addEventListener('mouseup', () => { if (state.sfxDrag) { state.sfxDrag = null; renderSfxList(); } });
  }
  loadSounds();
}

// ── sfx timeline bars: drag body to move, edges to change start/end ──
function sfxDur() {
  return (els.sfxVideo && els.sfxVideo.duration) ? els.sfxVideo.duration
    : (state.source ? state.source.duration : 0) || 0;
}

function renderSfxTrack() {
  const track = $('#sfx-track');
  if (!track) return;
  const dur = sfxDur() || 1;
  track.innerHTML = state.sfx.map((p, i) => {
    if (p.kind === 'range') {
      const left = (p.t / dur) * 100;
      const width = Math.max(1.2, (((p.t_end ?? p.t + 1) - p.t) / dur) * 100);
      return `<div class="sfx-bar" data-i="${i}" style="left:${left}%;width:${width}%"
        title="${escapeHtml(soundName(p.sound_id))} ${p.t.toFixed(1)}–${(p.t_end ?? 0).toFixed(1)}s — drag to move, edges to resize, double-click to remove">
        <span class="sfx-bar-h sfx-bar-l"></span>
        <span class="sfx-bar-name">${escapeHtml(soundName(p.sound_id))}</span>
        <span class="sfx-bar-h sfx-bar-r"></span>
      </div>`;
    }
    const left = (p.t / dur) * 100;
    return `<div class="sfx-pin" data-i="${i}" style="left:${left}%"
      title="${escapeHtml(soundName(p.sound_id))} @ ${p.t.toFixed(1)}s — drag to move, double-click to remove">▾</div>`;
  }).join('') + '<div class="ill-cursor" id="sfx-cursor"></div>';
  updateSfxCursor();
}

function updateSfxCursor() {
  const cur = $('#sfx-cursor');
  if (!cur) return;
  const dur = sfxDur() || 1;
  cur.style.left = ((els.sfxVideo ? (els.sfxVideo.currentTime || 0) : 0) / dur) * 100 + '%';
}

function onSfxTrackDown(e) {
  const el = e.target.closest('.sfx-bar, .sfx-pin');
  if (!el) return;
  e.preventDefault();
  const i = +el.dataset.i;
  const p = state.sfx[i];
  if (!p) return;
  const rect = $('#sfx-track').getBoundingClientRect();
  let mode = 'move';
  if (p.kind === 'range' && el.classList.contains('sfx-bar')) {
    const r = el.getBoundingClientRect();
    if (e.target.classList.contains('sfx-bar-l') || e.clientX - r.left < 8) mode = 'left';
    else if (e.target.classList.contains('sfx-bar-r') || r.right - e.clientX < 8) mode = 'right';
  }
  state.sfxDrag = { i, mode, startX: e.clientX, trackW: rect.width, t0: p.t, t1: p.t_end ?? p.t };
}

function onSfxDragMove(e) {
  const d = state.sfxDrag;
  if (!d) return;
  const p = state.sfx[d.i];
  if (!p) { state.sfxDrag = null; return; }
  const dur = sfxDur() || 1;
  const dt = ((e.clientX - d.startX) / d.trackW) * dur;
  const MIN = 0.15;
  if (p.kind !== 'range' || d.mode === 'move') {
    const len = p.kind === 'range' ? (d.t1 - d.t0) : 0;
    let ns = Math.max(0, Math.min(d.t0 + dt, dur - len));
    p.t = +ns.toFixed(2);
    if (p.kind === 'range') p.t_end = +(ns + len).toFixed(2);
  } else if (d.mode === 'left') {
    p.t = +Math.max(0, Math.min(d.t0 + dt, (p.t_end ?? dur) - MIN)).toFixed(2);
  } else {
    p.t_end = +Math.max(p.t + MIN, Math.min(d.t1 + dt, dur)).toFixed(2);
  }
  renderSfxTrack();
}

function onSfxTrackDblClick(e) {
  const el = e.target.closest('.sfx-bar, .sfx-pin');
  if (!el) return;
  state.sfx.splice(+el.dataset.i, 1);
  renderSfxTrack(); renderSfxList();
  setStatus('sfx-status', 'Placement removed.', 'ok');
}

// ── audible preview: placed sounds play in sync while the sfx video plays ──
let sfxLive = [];   // [{p, audio}] currently-sounding range layers

function resetSfxAudio() {
  for (const l of sfxLive) { try { l.audio.pause(); } catch (_) {} }
  sfxLive = [];
  for (const p of state.sfx) p._fired = false;
}

function syncSfxAudio() {
  const v = els.sfxVideo;
  if (!v || v.paused) return;
  const t = v.currentTime || 0;
  for (const p of state.sfx) {
    const vol = Math.max(0, Math.min(1, p.volume == null ? 1 : p.volume));
    if (p.kind === 'range') {
      const te = p.t_end ?? p.t;
      const within = t >= p.t && t < te;
      let live = sfxLive.find(l => l.p === p);
      if (within && !live) {
        const a = new Audio('/api/soundboard/' + p.sound_id + '/audio');
        a.loop = !!p.loop;
        a.volume = vol;
        a.play().catch(() => {});
        sfxLive.push({ p, audio: a });
      } else if (!within && live) {
        try { live.audio.pause(); } catch (_) {}
        sfxLive = sfxLive.filter(l => l !== live);
      } else if (live) {
        live.audio.volume = vol;
      }
    } else if (t >= p.t && t < p.t + 0.4 && !p._fired) {
      p._fired = true;
      const a = new Audio('/api/soundboard/' + p.sound_id + '/audio');
      a.volume = vol;
      a.play().catch(() => {});
      setTimeout(() => { p._fired = false; }, 1200);
    }
  }
}

function initSfxStep() {
  if (!state.source || !els.sfxVideo) return;
  const v = els.sfxVideo;
  if (v.dataset.path !== state.source.video_path) {
    v.dataset.path = state.source.video_path;
    v.src = state.source.video_path;
  }
  loadSounds();
  renderSfxList();
}

async function loadSounds() {
  try {
    const r = await fetch('/api/soundboard');
    if (!r.ok) return;
    const data = await r.json();
    state.sounds = data.sounds || [];
    renderBoard();
    renderRangeSoundSelect();
  } catch (e) { /* best-effort */ }
}

function fmtDur(s) {
  s = s || 0;
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function renderBoard() {
  const board = $('#sfx-board');
  if (!board) return;
  if (!state.sounds.length) {
    board.innerHTML = '<div class="muted">No sounds yet — Import an audio file (mp3 / wav / ogg / m4a…).</div>';
    return;
  }
  board.innerHTML = state.sounds.map(s => `
    <div class="sfx-pad" data-id="${s.id}">
      <button class="sfx-pad-play" data-id="${s.id}" title="preview">▶</button>
      <span class="sfx-pad-name" title="${escapeHtml(s.name)}">${escapeHtml(s.name)}</span>
      <span class="sfx-pad-dur">${fmtDur(s.duration)}</span>
      <button class="sfx-pad-add" data-id="${s.id}" title="drop a one-shot at the current time">＋ here</button>
      <button class="sfx-pad-del danger" data-id="${s.id}" title="delete from library">×</button>
    </div>`).join('');
  board.querySelectorAll('.sfx-pad-play').forEach(b => b.addEventListener('click', () => previewSound(b.dataset.id)));
  board.querySelectorAll('.sfx-pad-add').forEach(b => b.addEventListener('click', () => addOneShot(b.dataset.id)));
  board.querySelectorAll('.sfx-pad-del').forEach(b => b.addEventListener('click', () => deleteSound(b.dataset.id)));
}

function renderRangeSoundSelect() {
  const sel = $('#sfx-range-sound');
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = state.sounds.map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');
  if (prev && state.sounds.some(s => s.id === prev)) sel.value = prev;
}

function previewSound(id) {
  if (state.sfxPreview) { try { state.sfxPreview.pause(); } catch (_) {} }
  const a = new Audio('/api/soundboard/' + id + '/audio');
  state.sfxPreview = a;
  a.play().catch(() => {});
}

async function onSfxImport() {
  const file = $('#sfx-file').files[0];
  if (!file) return;
  $('#sfx-file').value = '';
  setStatus('sfx-status', `Importing ${file.name}…`);
  try {
    const stem = file.name.replace(/\.[^.]+$/, '');
    const r = await fetch(`/api/soundboard?name=${encodeURIComponent(stem)}&filename=${encodeURIComponent(file.name)}`,
      { method: 'POST', body: file });
    if (!r.ok) throw new Error((await r.text()) || r.statusText);
    await loadSounds();
    setStatus('sfx-status', `Added "${stem}".`, 'ok');
  } catch (e) {
    setStatus('sfx-status', 'Import failed: ' + e.message, 'err');
  }
}

async function deleteSound(id) {
  const s = state.sounds.find(x => x.id === id);
  if (!confirm(`Delete "${s ? s.name : id}" from the soundboard? Its placements are removed too.`)) return;
  try {
    await fetch('/api/soundboard/' + id, { method: 'DELETE' });
    state.sfx = state.sfx.filter(p => p.sound_id !== id);
    await loadSounds();
    renderSfxList();
  } catch (e) {
    setStatus('sfx-status', 'Delete failed: ' + e.message, 'err');
  }
}

function addOneShot(id) {
  const t = els.sfxVideo ? (els.sfxVideo.currentTime || 0) : 0;
  state.sfx.push({ sound_id: id, kind: 'oneshot', t: +t.toFixed(2), volume: 1.0 });
  state.sfx.sort((a, b) => a.t - b.t);
  renderSfxList();
  setStatus('sfx-status', `One-shot added @ ${t.toFixed(2)}s.`, 'ok');
}

function addSfxRange() {
  const sel = $('#sfx-range-sound');
  const id = sel ? sel.value : '';
  if (!id) { setStatus('sfx-status', 'No sound selected — import one first.', 'err'); return; }
  const rs = parseFloat($('#sfx-rs').value);
  const reV = parseFloat($('#sfx-re').value);
  const t = isNaN(rs) ? 0 : Math.max(0, rs);
  const te = isNaN(reV) ? (els.sfxVideo && els.sfxVideo.duration ? els.sfxVideo.duration : t + 1) : reV;
  if (te <= t) { setStatus('sfx-status', 'End must be after start.', 'err'); return; }
  state.sfx.push({
    sound_id: id, kind: 'range', t: +t.toFixed(2), t_end: +te.toFixed(2),
    volume: 1.0, loop: $('#sfx-loop') ? $('#sfx-loop').checked : true,
  });
  state.sfx.sort((a, b) => a.t - b.t);
  renderSfxList();
  setStatus('sfx-status', `Layer added ${t.toFixed(1)}–${te.toFixed(1)}s.`, 'ok');
}

function soundName(id) {
  const s = state.sounds.find(x => x.id === id);
  return s ? s.name : '(deleted sound)';
}

function renderSfxList() {
  renderSfxTrack();   // the draggable timeline mirrors the list
  const ol = $('#sfx-list');
  const count = $('#sfx-count');
  if (count) count.textContent = state.sfx.length;
  if (!ol) return;
  if (!state.sfx.length) {
    ol.innerHTML = '<li class="empty">No sounds placed yet — preview a pad, then ＋ here / Add layer.</li>';
    return;
  }
  ol.innerHTML = state.sfx.map((p, i) => {
    const when = p.kind === 'range'
      ? `layer ${(+p.t).toFixed(1)}–${(+p.t_end).toFixed(1)}s${p.loop ? ' · loop' : ''}`
      : `one-shot @ ${(+p.t).toFixed(2)}s`;
    const volPct = Math.round((p.volume == null ? 1 : p.volume) * 100);
    return `<li>
      <span class="sfx-it-name" title="${escapeHtml(soundName(p.sound_id))}">${escapeHtml(soundName(p.sound_id))}</span>
      <span class="sfx-it-when">${when}</span>
      <span class="sfx-it-vol"><input type="range" min="0" max="200" step="5" value="${volPct}" data-i="${i}" class="sfx-vol"><b data-volb="${i}">${volPct}%</b></span>
      <button class="sfx-it-seek" data-seek="${i}" title="seek to its start">▶</button>
      <button class="sfx-it-del danger" data-del="${i}" title="remove placement">×</button>
    </li>`;
  }).join('');
  ol.querySelectorAll('.sfx-vol').forEach(inp => inp.addEventListener('input', (e) => {
    const i = +e.target.dataset.i;
    state.sfx[i].volume = (+e.target.value) / 100;
    const b = ol.querySelector(`b[data-volb="${i}"]`); if (b) b.textContent = e.target.value + '%';
  }));
  ol.querySelectorAll('.sfx-it-seek').forEach(b => b.addEventListener('click', () => {
    const p = state.sfx[+b.dataset.seek]; if (p && els.sfxVideo) els.sfxVideo.currentTime = p.t;
  }));
  ol.querySelectorAll('.sfx-it-del').forEach(b => b.addEventListener('click', () => {
    state.sfx.splice(+b.dataset.del, 1); renderSfxList();
  }));
}

// ───────────────────────── illustration cutaways (Pexels) ─────────────────────────
// Search Pexels → click an image to drop a FULL-FRAME cutaway at the current
// time. Cutaways live on a mini-timeline: drag a block to move it, drag its
// right edge to resize (duration). Sent in the render body → renderer overlays
// each image over the whole 9:16 frame during its window.
const ILL_MIN_DUR = 0.3;

function wireIll() {
  els.illVideo = $('#ill-video');
  if (!els.illVideo) return;
  const v = els.illVideo;
  v.addEventListener('loadedmetadata', () => {
    const scr = $('#ill-scrubber'); if (scr) scr.max = v.duration || 0;
    const d = $('#ill-dur'); if (d) d.textContent = formatTime(v.duration || 0);
    renderIllTrack(); drawIllPreview();
  });
  v.addEventListener('loadeddata', drawIllPreview);
  v.addEventListener('seeked', drawIllPreview);
  v.addEventListener('timeupdate', () => {
    const t = $('#ill-time'); if (t) t.textContent = formatTime(v.currentTime || 0);
    const scr = $('#ill-scrubber'); if (scr && document.activeElement !== scr) scr.value = v.currentTime || 0;
    updateIllCursor();
    drawIllPreview();
  });
  v.addEventListener('play', () => { const b = $('#ill-play'); if (b) b.textContent = '❚❚'; });
  v.addEventListener('pause', () => { const b = $('#ill-play'); if (b) b.textContent = '▶'; });
  $('#ill-play').addEventListener('click', () => { if (v.paused) v.play(); else v.pause(); });
  $('#ill-scrubber').addEventListener('input', (e) => { if (v.duration) v.currentTime = +e.target.value; });
  $('#btn-ill-search').addEventListener('click', doIllSearch);
  $('#ill-query').addEventListener('keydown', (e) => { if (e.key === 'Enter') doIllSearch(); });
  const up = $('#btn-ill-upload');
  if (up) up.addEventListener('click', () => $('#ill-file').click());
  const upf = $('#ill-file');
  if (upf) upf.addEventListener('change', onIllUpload);
  $('#ill-track').addEventListener('mousedown', onIllTrackDown);
  window.addEventListener('mousemove', onIllDragMove);
  window.addEventListener('mouseup', () => { if (state.illDrag) { state.illDrag = null; renderIllList(); } });
}

function illDur() {
  return (els.illVideo && els.illVideo.duration) ? els.illVideo.duration
    : (state.source ? state.source.duration : 0) || 0;
}

function initIllStep() {
  if (!state.source || !els.illVideo) return;
  const v = els.illVideo;
  if (v.dataset.path !== state.source.video_path) {
    v.dataset.path = state.source.video_path;
    v.src = state.source.video_path;
  }
  if (!$('#ill-query').value && $('#f-title').value && $('#f-title').value.toLowerCase() !== 'clip') {
    $('#ill-query').value = $('#f-title').value.trim();
  }
  state.ills.forEach(c => preloadIllImg(c.thumb));
  renderIllTrack();
  renderIllList();
  drawIllPreview();
}

async function doIllSearch() {
  const q = ($('#ill-query').value || '').trim();
  if (!q) { setStatus('ill-status', 'Type something to search.', 'err'); return; }
  const btn = $('#btn-ill-search');
  if (btn) btn.disabled = true;
  setStatus('ill-status', `Searching "${q}"…`);
  try {
    const res = await apiPost('/api/search', { query: q });
    renderIllCandidates(res.candidates || []);
    setStatus('ill-status', (res.candidates || []).length ? 'Click an image to drop a cutaway at the current time.' : 'No results.', (res.candidates || []).length ? 'ok' : 'err');
  } catch (e) {
    setStatus('ill-status', 'Search failed: ' + e.message, 'err');
  } finally {
    if (btn) btn.disabled = false;
  }
}

function renderIllCandidates(cands) {
  const box = $('#ill-candidates');
  if (!box) return;
  box.innerHTML = cands.map(c => `
    <button class="ill-cand" data-url="${escapeHtml(c.full)}" data-thumb="${escapeHtml(c.thumb)}" title="${escapeHtml(c.alt || '')} — ${escapeHtml(c.photographer || '')}">
      <img src="${escapeHtml(c.thumb)}" loading="lazy" alt="">
    </button>`).join('');
  box.querySelectorAll('.ill-cand').forEach(b => b.addEventListener('click', () => addCutaway(b.dataset.url, b.dataset.thumb)));
}

async function onIllUpload() {
  const file = $('#ill-file').files[0];
  if (!file) return;
  $('#ill-file').value = '';
  setStatus('ill-status', `Uploading ${file.name}…`);
  try {
    const r = await fetch('/api/ill-upload?filename=' + encodeURIComponent(file.name),
      { method: 'POST', body: file });
    if (!r.ok) throw new Error((await r.text()) || r.statusText);
    const j = await r.json();
    addCutaway(j.url, j.thumb || j.url);   // drops at the current time like a Pexels pick
    setStatus('ill-status', `"${file.name}" added as a cutaway at the current time.`, 'ok');
  } catch (e) {
    setStatus('ill-status', 'Upload failed: ' + e.message, 'err');
  }
}

function addCutaway(url, thumb) {
  const dur = illDur();
  const t = els.illVideo ? (els.illVideo.currentTime || 0) : 0;
  const defd = Math.max(ILL_MIN_DUR, parseFloat($('#ill-defdur').value) || 3);
  let t_end = t + defd;
  if (dur && t_end > dur) t_end = dur;
  if (t_end - t < ILL_MIN_DUR) { setStatus('ill-status', 'Too close to the end — scrub earlier.', 'err'); return; }
  state.ills.push({ url, thumb, t_start: +t.toFixed(2), t_end: +t_end.toFixed(2), target: 'full', fit: 'cover' });
  state.ills.sort((a, b) => a.t_start - b.t_start);
  preloadIllImg(thumb);
  renderIllTrack();
  renderIllList();
  drawIllPreview();
  setStatus('ill-status', `Cutaway added ${t.toFixed(1)}–${t_end.toFixed(1)}s.`, 'ok');
}

function renderIllTrack() {
  const track = $('#ill-track');
  const count = $('#ill-count');
  if (count) count.textContent = state.ills.length;
  if (!track) return;
  const dur = illDur() || 1;
  track.innerHTML = state.ills.map((c, i) => {
    const left = (c.t_start / dur) * 100;
    const width = Math.max(1.5, ((c.t_end - c.t_start) / dur) * 100);
    return `<div class="ill-block" data-i="${i}" style="left:${left}%;width:${width}%" title="${c.t_start.toFixed(1)}–${c.t_end.toFixed(1)}s — drag to move, right edge to resize">
      <img src="${escapeHtml(c.thumb)}" alt="">
      <span class="ill-block-handle"></span>
    </div>`;
  }).join('') + '<div class="ill-cursor" id="ill-cursor"></div>';
  updateIllCursor();
}

function updateIllCursor() {
  const cur = $('#ill-cursor');
  if (!cur) return;
  const dur = illDur() || 1;
  const t = els.illVideo ? (els.illVideo.currentTime || 0) : 0;
  cur.style.left = (t / dur) * 100 + '%';
}

function onIllTrackDown(e) {
  const block = e.target.closest('.ill-block');
  if (!block) return;
  e.preventDefault();
  const i = +block.dataset.i;
  const rect = $('#ill-track').getBoundingClientRect();
  const onHandle = e.target.classList.contains('ill-block-handle')
    || (block.getBoundingClientRect().right - e.clientX) < 10;
  state.illDrag = {
    i, mode: onHandle ? 'resize' : 'move',
    startX: e.clientX, trackW: rect.width,
    t0: state.ills[i].t_start, t1: state.ills[i].t_end,
  };
}

function onIllDragMove(e) {
  const d = state.illDrag;
  if (!d) return;
  const dur = illDur() || 1;
  const dt = ((e.clientX - d.startX) / d.trackW) * dur;
  const c = state.ills[d.i];
  if (!c) return;
  if (d.mode === 'move') {
    const len = d.t1 - d.t0;
    let ns = d.t0 + dt;
    ns = Math.max(0, Math.min(ns, dur - len));
    c.t_start = +ns.toFixed(2);
    c.t_end = +(ns + len).toFixed(2);
  } else {
    let ne = d.t1 + dt;
    ne = Math.max(c.t_start + ILL_MIN_DUR, Math.min(ne, dur));
    c.t_end = +ne.toFixed(2);
  }
  renderIllTrack();
}

function renderIllList() {
  const ol = $('#ill-list');
  if (!ol) return;
  if (!state.ills.length) {
    ol.innerHTML = '<li class="empty">No cutaways yet — search, then click an image.</li>';
    return;
  }
  const tgtOpt = (c, v, lbl) => `<option value="${v}"${(c.target || 'full') === v ? ' selected' : ''}>${lbl}</option>`;
  const fitOpt = (c, v, lbl) => `<option value="${v}"${(c.fit || 'cover') === v ? ' selected' : ''}>${lbl}</option>`;
  ol.innerHTML = state.ills.map((c, i) => `
    <li>
      <img class="ill-it-thumb" src="${escapeHtml(c.thumb)}" alt="">
      <span class="ill-it-when">${c.t_start.toFixed(1)}–${c.t_end.toFixed(1)}s</span>
      <span class="ill-it-dur">dur <input type="number" class="ill-dur-in" data-i="${i}" min="0.3" step="0.5" value="${(c.t_end - c.t_start).toFixed(1)}"> s</span>
      <select class="ill-tgt" data-i="${i}" title="which region the image fills">${tgtOpt(c, 'full', 'Full')}${tgtOpt(c, 'box1', 'Box 1 (top)')}${tgtOpt(c, 'box2', 'Box 2 (bot)')}</select>
      <select class="ill-fit" data-i="${i}" title="fit mode">${fitOpt(c, 'cover', 'Cover')}${fitOpt(c, 'blur', 'Blur')}</select>
      <button class="ill-it-seek" data-seek="${i}" title="seek to its start">▶</button>
      <button class="ill-it-del danger" data-del="${i}" title="remove cutaway">×</button>
    </li>`).join('');
  ol.querySelectorAll('.ill-dur-in').forEach(inp => inp.addEventListener('change', (e) => {
    const i = +e.target.dataset.i;
    const dur = illDur() || 1;
    let len = Math.max(ILL_MIN_DUR, parseFloat(e.target.value) || ILL_MIN_DUR);
    const c = state.ills[i];
    if (c.t_start + len > dur) len = dur - c.t_start;
    c.t_end = +(c.t_start + len).toFixed(2);
    renderIllTrack(); renderIllList(); drawIllPreview();
  }));
  ol.querySelectorAll('.ill-tgt').forEach(s => s.addEventListener('change', (e) => {
    state.ills[+e.target.dataset.i].target = e.target.value; drawIllPreview();
  }));
  ol.querySelectorAll('.ill-fit').forEach(s => s.addEventListener('change', (e) => {
    state.ills[+e.target.dataset.i].fit = e.target.value; drawIllPreview();
  }));
  ol.querySelectorAll('.ill-it-seek').forEach(b => b.addEventListener('click', () => {
    const c = state.ills[+b.dataset.seek]; if (c && els.illVideo) els.illVideo.currentTime = c.t_start;
  }));
  ol.querySelectorAll('.ill-it-del').forEach(b => b.addEventListener('click', () => {
    state.ills.splice(+b.dataset.del, 1); renderIllTrack(); renderIllList(); drawIllPreview();
  }));
}

// ── final-composite preview (shared by Sound / Illustration / Trim steps) ──
// Simulates the rendered 9:16 reel at time t: box1 crop in the top slot, box2
// in the bottom (per-kf cover/blur_pad fit), single-box full-focus when the
// other box is gap, black when both gap, plus illustration cutaways. So every
// step edits against (a preview of) the FINAL video, not the raw source.
const ILL_PV_W = 180, ILL_PV_H = 320;          // 9:16

function kfFitAtT(kfs, t) {
  if (!kfs || !kfs.length) return 'cover';
  let cur = kfs[0];
  for (const k of kfs) { if (k.t <= t) cur = k; else break; }
  return cur.fit || 'cover';
}

// Draw the source-rect `box` of video v into [dx,dy,dw,dh] with cover (crop)
// or blur_pad (contain + blurred cover behind) fit.
function drawCropBox(ctx, v, box, dx, dy, dw, dh, fit) {
  const sx = v.videoWidth / (state.source ? state.source.width : v.videoWidth) || 1;
  const sy = v.videoHeight / (state.source ? state.source.height : v.videoHeight) || 1;
  const bx = box.x * sx, by = box.y * sy, bw = box.w * sx, bh = box.h * sy;
  ctx.save();
  ctx.beginPath(); ctx.rect(dx, dy, dw, dh); ctx.clip();
  const coverCrop = () => {
    const s = Math.max(dw / bw, dh / bh);
    const vw = dw / s, vh = dh / s;                  // visible source sub-rect
    const ox = bx + (bw - vw) / 2, oy = by + (bh - vh) / 2;
    ctx.drawImage(v, ox, oy, vw, vh, dx, dy, dw, dh);
  };
  if (fit === 'blur_pad') {
    ctx.filter = 'blur(8px) brightness(0.85)';
    coverCrop();
    ctx.filter = 'none';
    const s = Math.min(dw / bw, dh / bh);
    const w = bw * s, h = bh * s;
    ctx.drawImage(v, bx, by, bw, bh, dx + (dw - w) / 2, dy + (dh - h) / 2, w, h);
  } else {
    coverCrop();
  }
  ctx.restore();
}

function drawComposite(ctx, v, t, W, H, opts) {
  const o = opts || {};
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
  if (!v || !v.videoWidth) return;
  const has1 = (state.keyframes[1] || []).length > 0;
  const has2 = (state.keyframes[2] || []).length > 0;
  if (!has1 && !has2) {
    coverDraw(ctx, v, 0, 0, W, H);                    // nothing boxed yet → raw
  } else {
    const b1 = boxAt(1, t), b2 = boxAt(2, t);
    const topH = H * 3 / 8;
    if (b1 && b2) {
      drawCropBox(ctx, v, b1, 0, 0, W, topH, kfFitAtT(state.keyframes[1], t));
      drawCropBox(ctx, v, b2, 0, topH, W, H - topH, kfFitAtT(state.keyframes[2], t));
    } else if (b1 || b2) {
      const n = b1 ? 1 : 2;                           // single-box full-focus mode
      drawCropBox(ctx, v, b1 || b2, 0, 0, W, H, kfFitAtT(state.keyframes[n], t));
    }                                                  // both gap → black
  }
  if (o.ills !== false) {
    for (const cut of (state.ills || [])) {
      if (t < cut.t_start || t >= cut.t_end) continue;
      const img = illImgCache[cut.thumb];
      if (!img || !img.complete || !img.naturalWidth) { preloadIllImg(cut.thumb); continue; }
      const [x, y, w, h] = illSlotRect2(cut.target || 'full', W, H);
      ctx.save();
      ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
      if ((cut.fit || 'cover') === 'blur') {
        ctx.filter = 'blur(8px) brightness(0.9)'; coverDraw(ctx, img, x, y, w, h); ctx.filter = 'none';
        containDraw(ctx, img, x, y, w, h);
      } else {
        coverDraw(ctx, img, x, y, w, h);
      }
      ctx.restore();
    }
  }
}

function illSlotRect2(target, W, H) {
  const top = H * 3 / 8;
  if (target === 'box1') return [0, 0, W, top];
  if (target === 'box2') return [0, top, W, H - top];
  return [0, 0, W, H];
}

const illImgCache = {};
function preloadIllImg(url) {
  if (!url || illImgCache[url]) return;
  const im = new Image();
  im.crossOrigin = 'anonymous';
  im.onload = drawIllPreview;
  im.src = url;
  illImgCache[url] = im;
}
function coverDraw(ctx, img, dx, dy, dw, dh) {
  const iw = img.naturalWidth || img.videoWidth, ih = img.naturalHeight || img.videoHeight;
  if (!iw || !ih) return;
  const s = Math.max(dw / iw, dh / ih);
  const w = iw * s, h = ih * s;
  ctx.drawImage(img, dx + (dw - w) / 2, dy + (dh - h) / 2, w, h);
}
function containDraw(ctx, img, dx, dy, dw, dh) {
  const iw = img.naturalWidth, ih = img.naturalHeight;
  if (!iw || !ih) return;
  const s = Math.min(dw / iw, dh / ih);
  const w = iw * s, h = ih * s;
  ctx.drawImage(img, dx + (dw - w) / 2, dy + (dh - h) / 2, w, h);
}
function drawIllPreview() {
  const c = $('#ill-preview');
  if (!c) return;
  const v = els.illVideo;
  drawComposite(c.getContext('2d'), v, v ? (v.currentTime || 0) : 0, ILL_PV_W, ILL_PV_H);
}

// trim-step preview: the same composite + a CUT tint when the playhead is in a
// stretch that the keep-windows will drop
function drawTrimPreview() {
  const c = $('#trim-preview');
  if (!c) return;
  const v = els.trimVideo;
  const t = v ? (v.currentTime || 0) : 0;
  const ctx = c.getContext('2d');
  drawComposite(ctx, v, t, ILL_PV_W, ILL_PV_H);
  if (state.keep.length && !state.keep.some(w => t >= w.start && t < w.end)) {
    ctx.fillStyle = 'rgba(180,30,30,.45)';
    ctx.fillRect(0, 0, ILL_PV_W, ILL_PV_H);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 26px system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('CUT', ILL_PV_W / 2, ILL_PV_H / 2);
  }
}

function drawSfxPreview() {
  const c = $('#sfx-preview');
  if (!c) return;
  const v = els.sfxVideo;
  drawComposite(c.getContext('2d'), v, v ? (v.currentTime || 0) : 0, ILL_PV_W, ILL_PV_H);
}

// ───────────────────────── trim (multi-segment keep) ─────────────────────────
// Mark keep-windows (A→B) on a timeline; everything OUTSIDE them is cut at
// render and the kept parts stitched. Arbitrary number of windows. Sent as
// keep_segments in the render body (renderer does select/aselect at the end).
const TRIM_MIN = 0.2;

function wireTrim() {
  els.trimVideo = $('#trim-video');
  if (!els.trimVideo) return;
  const v = els.trimVideo;
  v.addEventListener('loadedmetadata', () => {
    const scr = $('#trim-scrubber'); if (scr) scr.max = v.duration || 0;
    const d = $('#trim-dur'); if (d) d.textContent = formatTime(v.duration || 0);
    renderTrimTrack();
  });
  v.addEventListener('timeupdate', () => {
    // During PLAYBACK, skip over the parts that the render will cut, so the
    // preview plays EXACTLY the kept windows — what you watch == what you
    // download. (Only while playing: manual scrubbing into a cut still shows it,
    // tinted, so you can see what you're dropping.)
    if (!v.paused && state.keep.length) {
      const cur = v.currentTime || 0;
      const inKeep = state.keep.some(w => cur >= w.start - 1e-3 && cur < w.end);
      if (!inKeep) {
        const next = state.keep.filter(w => w.start > cur).sort((a, b) => a.start - b.start)[0];
        if (next) { v.currentTime = next.start; }      // jump to the next kept window
        else { v.pause(); v.currentTime = state.keep[state.keep.length - 1].end; }  // past the last keep → stop
      }
    }
    const t = $('#trim-time'); if (t) t.textContent = formatTime(v.currentTime || 0);
    const scr = $('#trim-scrubber'); if (scr && document.activeElement !== scr) scr.value = v.currentTime || 0;
    updateTrimCursor();
    drawTrimPreview();
  });
  v.addEventListener('loadeddata', drawTrimPreview);
  v.addEventListener('seeked', drawTrimPreview);
  v.addEventListener('play', () => { const b = $('#trim-play'); if (b) b.textContent = '❚❚'; });
  v.addEventListener('pause', () => { const b = $('#trim-play'); if (b) b.textContent = '▶'; });
  $('#trim-play').addEventListener('click', () => { if (v.paused) v.play(); else v.pause(); });
  $('#trim-scrubber').addEventListener('input', (e) => { if (v.duration) v.currentTime = +e.target.value; });
  $('#btn-trim-a').addEventListener('click', setKeepA);
  $('#btn-trim-b').addEventListener('click', setKeepB);
  $('#btn-trim-here').addEventListener('click', addKeepHere);
  const ai = $('#btn-trim-ai');
  if (ai) ai.addEventListener('click', autoTrimQuiet);
  $('#btn-trim-clear').addEventListener('click', () => { state.keep = []; state.keepA = null; renderTrimTrack(); renderTrimList(); setStatus('trim-status', 'Cleared — keeps the whole clip.', 'ok'); });
  $('#trim-track').addEventListener('mousedown', onTrimTrackDown);
  window.addEventListener('mousemove', onTrimDragMove);
  window.addEventListener('mouseup', () => { if (state.keepDrag) { state.keepDrag = null; renderTrimList(); } });
}

function trimDur() {
  return (els.trimVideo && els.trimVideo.duration) ? els.trimVideo.duration
    : (state.source ? state.source.duration : 0) || 0;
}

function initTrimStep() {
  if (!state.source || !els.trimVideo) return;
  const v = els.trimVideo;
  if (v.dataset.path !== state.source.video_path) {
    v.dataset.path = state.source.video_path;
    v.src = state.source.video_path;
  }
  renderTrimTrack();
  renderTrimList();
}

function addKeep(a, b) {
  const dur = trimDur() || 0;
  a = Math.max(0, a);
  if (dur) b = Math.min(b, dur);
  if (b - a < TRIM_MIN) { setStatus('trim-status', 'Window too short.', 'err'); return false; }
  state.keep.push({ start: +a.toFixed(2), end: +b.toFixed(2) });
  state.keep.sort((x, y) => x.start - y.start);
  renderTrimTrack(); renderTrimList();
  return true;
}

function setKeepA() {
  state.keepA = els.trimVideo ? (els.trimVideo.currentTime || 0) : 0;
  setStatus('trim-status', `A (in) = ${state.keepA.toFixed(2)}s — now scrub to the end and hit "Set B".`, 'ok');
}

function setKeepB() {
  if (state.keepA == null) { setStatus('trim-status', 'Set A (in) first.', 'err'); return; }
  const b = els.trimVideo ? (els.trimVideo.currentTime || 0) : 0;
  if (addKeep(state.keepA, b)) {
    setStatus('trim-status', `Kept ${state.keepA.toFixed(1)}–${b.toFixed(1)}s.`, 'ok');
    state.keepA = null;
  }
}

function addKeepHere() {
  const t = els.trimVideo ? (els.trimVideo.currentTime || 0) : 0;
  addKeep(t, t + 3);
}

function keptTotal() {
  return state.keep.reduce((s, w) => s + (w.end - w.start), 0);
}

// AI auto-trim: detect quiet/dead-air stretches (backend ffmpeg silencedetect)
// and keep only the talking parts. Every produced window is a normal keep bar —
// drag, resize, or delete it like a manual one.
async function autoTrimQuiet() {
  if (!state.jobId) { setStatus('trim-status', 'Load a clip first.', 'err'); return; }
  const btn = $('#btn-trim-ai');
  if (btn) btn.disabled = true;
  setStatus('trim-status', '🤖 Listening for quiet stretches…');
  try {
    const res = await apiPost('/api/detect-silence', { job_id: state.jobId, noise_db: -35, min_dur: 1.0 });
    const dur = res.duration || trimDur() || 0;
    const sil = (res.silences || []).filter(s => s.end - s.start >= 1.0);
    if (!sil.length) {
      setStatus('trim-status', 'No long quiet stretches found — nothing to cut.', 'ok');
      return;
    }
    // keep = complement of the silences, padded a touch so speech onsets survive
    const PAD = 0.15, MIN_KEEP = 0.4;
    const keeps = [];
    let cur = 0;
    for (const s of sil) {
      const a = cur, b = Math.min(s.start + PAD, dur);
      if (b - a >= MIN_KEEP) keeps.push({ start: +a.toFixed(2), end: +b.toFixed(2) });
      cur = Math.max(cur, s.end - PAD);
    }
    if (dur - cur >= MIN_KEEP) keeps.push({ start: +cur.toFixed(2), end: +dur.toFixed(2) });
    if (!keeps.length) {
      setStatus('trim-status', 'The whole clip is quiet?! Leaving it untrimmed.', 'err');
      return;
    }
    state.keep = keeps;
    state.keepA = null;
    renderTrimTrack(); renderTrimList(); drawTrimPreview();
    const cut = dur - keptTotal();
    setStatus('trim-status',
      `🤖 ${sil.length} quiet stretch(es) cut — saves ${cut.toFixed(1)}s (kept ${keptTotal().toFixed(1)}s of ${dur.toFixed(1)}s). Adjust or delete any bar.`,
      'ok');
  } catch (e) {
    setStatus('trim-status', 'Auto-trim failed: ' + e.message, 'err');
  } finally {
    if (btn) btn.disabled = false;
  }
}

function renderTrimTrack() {
  const track = $('#trim-track');
  const kept = $('#trim-kept');
  if (kept) {
    const dur = trimDur();
    kept.textContent = state.keep.length
      ? `keeps ${keptTotal().toFixed(1)}s of ${dur ? dur.toFixed(1) : '?'}s (${state.keep.length} window${state.keep.length > 1 ? 's' : ''})`
      : 'keeps whole clip';
  }
  if (!track) return;
  const dur = trimDur() || 1;
  track.innerHTML = state.keep.map((w, i) => {
    const left = (w.start / dur) * 100;
    const width = Math.max(1, ((w.end - w.start) / dur) * 100);
    return `<div class="trim-block" data-i="${i}" style="left:${left}%;width:${width}%" title="${w.start.toFixed(1)}–${w.end.toFixed(1)}s — drag to move, right edge to resize">
      <span class="trim-block-lbl">${(w.end - w.start).toFixed(1)}s</span>
      <span class="trim-block-handle"></span>
    </div>`;
  }).join('') + '<div class="ill-cursor" id="trim-cursor"></div>';
  updateTrimCursor();
}

function updateTrimCursor() {
  const cur = $('#trim-cursor');
  if (!cur) return;
  const dur = trimDur() || 1;
  cur.style.left = ((els.trimVideo ? (els.trimVideo.currentTime || 0) : 0) / dur) * 100 + '%';
}

function onTrimTrackDown(e) {
  const block = e.target.closest('.trim-block');
  if (!block) return;
  e.preventDefault();
  const i = +block.dataset.i;
  const rect = $('#trim-track').getBoundingClientRect();
  const onHandle = e.target.classList.contains('trim-block-handle')
    || (block.getBoundingClientRect().right - e.clientX) < 10;
  state.keepDrag = { i, mode: onHandle ? 'resize' : 'move', startX: e.clientX, trackW: rect.width,
                     a: state.keep[i].start, b: state.keep[i].end };
}

function onTrimDragMove(e) {
  const d = state.keepDrag;
  if (!d) return;
  const dur = trimDur() || 1;
  const dt = ((e.clientX - d.startX) / d.trackW) * dur;
  const w = state.keep[d.i];
  if (!w) return;
  if (d.mode === 'move') {
    const len = d.b - d.a;
    let ns = Math.max(0, Math.min(d.a + dt, dur - len));
    w.start = +ns.toFixed(2); w.end = +(ns + len).toFixed(2);
  } else {
    let ne = Math.max(w.start + TRIM_MIN, Math.min(d.b + dt, dur));
    w.end = +ne.toFixed(2);
  }
  renderTrimTrack();
}

function renderTrimList() {
  const ol = $('#trim-list');
  if (!ol) return;
  if (!state.keep.length) {
    ol.innerHTML = '<li class="empty">No windows — the whole clip is kept. Mark A→B to cut out the rest.</li>';
    return;
  }
  ol.innerHTML = state.keep.map((w, i) => `
    <li>
      <span class="sfx-it-name">Keep ${i + 1}</span>
      <span class="ill-it-when">${w.start.toFixed(1)} → ${w.end.toFixed(1)}s · ${(w.end - w.start).toFixed(1)}s</span>
      <button class="ill-it-seek" data-seek="${i}" title="seek to its start">▶</button>
      <button class="ill-it-del danger" data-del="${i}" title="remove window">×</button>
    </li>`).join('');
  ol.querySelectorAll('.ill-it-seek').forEach(b => b.addEventListener('click', () => {
    const w = state.keep[+b.dataset.seek]; if (w && els.trimVideo) els.trimVideo.currentTime = w.start;
  }));
  ol.querySelectorAll('.ill-it-del').forEach(b => b.addEventListener('click', () => {
    state.keep.splice(+b.dataset.del, 1); renderTrimTrack(); renderTrimList();
  }));
}
