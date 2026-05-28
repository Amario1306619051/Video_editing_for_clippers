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
  caption: { font: 'Bricolage Grotesque', size: 64 },
  renderRange: { start: null, end: null },  // sub-range in seconds, null = open
  drag: null,
  result: null,
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
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
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

  updatePills();
});

// ───────────────────────── step nav ─────────────────────────
function canGoToStep(n) {
  if (n === 1) return true;
  if (n === 2) return !!state.jobId;
  if (n === 3) return !!state.jobId;
  return false;
}

function showStep(n) {
  state.step = n;
  for (let i = 1; i <= 3; i++) {
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
    });
  }
  if (n === 3) {
    renderWordChips();
    redrawPreview(els.preview2);
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

function inheritFit(n, t) {
  const kfs = state.keyframes[n];
  if (!kfs.length) return 'cover';
  let best = null;
  for (const k of kfs) {
    if (k.t <= t && (!best || k.t > best.t)) best = k;
  }
  return (best ? best.fit : kfs[0].fit) || 'cover';
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
    setStatus('tr-status', 'Pilih Box dulu (klik pill 1 atau 2)', 'err');
    return;
  }
  const i = findKeyframeAt(n, state.currentTime);
  if (i < 0) {
    setStatus('tr-status', `No keyframe @${state.currentTime.toFixed(2)}s — drag dulu buat bikin kf`, 'err');
    return;
  }
  const cur = state.keyframes[n][i];
  cur.interp = (cur.interp || 'hold') === 'hold' ? 'linear' : 'hold';
  setStatus('tr-status',
    `Box ${n} kf @${cur.t.toFixed(2)}s → ${cur.interp === 'linear' ? 'LINEAR (smooth pan ke kf berikutnya)' : 'HOLD (diam sampai kf berikutnya)'}`,
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
    setStatus('tr-status', 'Pilih Box dulu (klik pill 1/2) sebelum delete', 'err');
    return;
  }
  const i = findKeyframeAt(n, state.currentTime);
  if (i < 0) {
    setStatus('tr-status',
      `No keyframe pas di ${state.currentTime.toFixed(2)}s untuk Box ${n}. Tip: klik dot di timeline atau ▶ di segment list buat seek ke kf, baru tekan Delete`,
      'err');
    return;
  }
  state.keyframes[n].splice(i, 1);
  setStatus('tr-status',
    `Deleted kf Box ${n} @${state.currentTime.toFixed(2)}s · sisa ${state.keyframes[n].length} kf`,
    'ok');
  renderTimeline();
  redrawOverlay();
  redrawPreviews();
}

function clearActiveBox() {
  const n = state.activeBox;
  if (n === null) {
    setStatus('tr-status', 'Pilih Box dulu sebelum clear', 'err');
    return;
  }
  const count = state.keyframes[n].length;
  if (!count) {
    setStatus('tr-status', `Box ${n} udah kosong`, 'err');
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
        ${kfs.length ? `<button class="clear-all-btn danger" data-act="clear-all" data-box="${n}" title="Hapus semua kf Box ${n}">Clear all ×</button>` : ''}
      `;
    }

    if (!kfs.length) {
      ol.innerHTML = '<li class="empty">No keyframes — pilih box ini, drag di video</li>';
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
              <button data-act="seek" data-box="${n}" data-idx="${idx}" title="Seek ke awal gap">▶ seek</button>
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
            <button data-act="seek"       data-box="${n}" data-idx="${idx}" title="Seek ke kf ini">▶ seek</button>
            <button data-act="toggle"     data-box="${n}" data-idx="${idx}" title="Toggle Hold ↔ Linear (interp)">⇄ ${mode}</button>
            <button data-act="toggle-fit" data-box="${n}" data-idx="${idx}" class="kf-seg-fit ${fit}" title="Toggle Cover ↔ Blur Pad (fit mode) untuk segment ini">${fitLbl}</button>
            <button data-act="del"        data-box="${n}" data-idx="${idx}" class="danger" title="Delete kf ini">× delete</button>
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
    if (!count) { setStatus('tr-status', `Box ${n} udah kosong`, 'err'); return; }
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
      `Deleted kf Box ${n} @${kf.t.toFixed(2)}s · sisa ${state.keyframes[n].length} kf`, 'ok');
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
    setStatus('tr-status', `Box ${n} udah kosong`, 'err');
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
    setStatus('tr-status', `Box ${n} trimmed @${t.toFixed(2)}s · earlier kfs kept, from here onwards empty`, 'ok');
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
      setStatus('tr-status', `Box ${n} belum ada kf — drag (jangan cuma klik) buat set size pertama`, 'err');
      redrawOverlay();
      return;
    }
    w = ref.w; h = ref.h;
    x = startSrc.x - w / 2;
    y = startSrc.y - h / 2;
    how = 'placed (size inherited)';
  } else {
    // Free-form draw — box matches exactly what user dragged. No aspect lock.
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
      ? 'Belum ada box'
      : c === 1 ? `1 box · full 1080×1920 focus · ${kf}` : `2 boxes · vstack 3/8+5/8 · ${kf}`;
  }
}

function drawCaptionPreview(ctx, y) {
  const t = state.words.length
    ? (state.words.slice(0, 3).map(w => w.word).join(' ').toUpperCase().slice(0, 18))
    : 'YOUR CAPTION';
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
    setStatus('tr-status', 'Gambar minimal 1 box dulu (set keyframe)', 'err');
    return;
  }
  setStatus('tr-status', '', null);
  showStep(3);
}

function renderWordChips() {
  if (!state.words.length) {
    els.wordsBox.innerHTML = '<div class="muted">Belum ada transcript.</div>';
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
      ? `Caption di-burn. File: ${result.filename}`
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
  return {
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
  };
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
  const result = await apiPost('/api/render', buildRenderBody(withWords));
  fillResult(result, withWords);
  state.result = result;
  setStatus('rd-status', `Done · saved as ${result.filename}`, 'ok');
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
      setStatus('rd-status', 'Transcribing audio (Whisper · first run lambat, model di-download sekali)…');
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
    setStatus('rd-status', 'Source cleaned. Output tetep ada di folder output/.', 'ok');
    $('#btn-render').disabled = true;
    const nc = $('#btn-render-nocap'); if (nc) nc.disabled = true;
  } catch (e) {
    setStatus('rd-status', 'Cleanup failed: ' + e.message, 'err');
  } finally {
    btn.disabled = false;
  }
}
