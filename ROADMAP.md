# Roadmap / Notes

Planned future work. Each item is written issue-style so it can be copy-pasted into GitHub Issues.

See also the "Roadmap (priority order)" section in `CLAUDE.md` for the existing backlog.

---

## Vision-LM automatic crop-box detection (replace manual boxes)

**Status:** planned

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
