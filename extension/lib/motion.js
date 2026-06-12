// Camera + cursor motion engine — runs in cloud.comfy.org MAIN world.
// Injected before tour.js; exposes window.__ComfyReplayMotion.
//
// Design notes (the "Screen Studio look"):
//  - All animation is TIME-based (rAF with elapsed-ms interpolation), never
//    fixed-step-per-frame, so dropped frames slow nothing down.
//  - Long camera travels use easeInOutQuint (slow-fast-slow with a long
//    glide); short adjustments use easeOutCubic.
//  - Camera moves that travel far interpolate the zoom THROUGH a midpoint
//    below both endpoints (zoom-out arc) — the signature cinematic move.
//  - Cursor rides a quadratic bezier with a perpendicular bow, Fitts-law
//    duration, a slight overshoot-settle, and 1–2px micro-drift while idle.
//  - No ripples, no labels. Clean native-looking macOS arrow only.

(function () {
  if (window.__ComfyReplayMotion) return; // idempotent re-injection

  // ── Easing ──────────────────────────────────────────────────────────────
  const easeInOutQuint = t => t < .5 ? 16 * t * t * t * t * t : 1 - Math.pow(-2 * t + 2, 5) / 2;
  const easeOutCubic   = t => 1 - Math.pow(1 - t, 3);
  const easeInOutCubic = t => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

  const frm = () => new Promise(r => requestAnimationFrame(r));
  const slp = ms => new Promise(r => setTimeout(r, ms));
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  function canvasEl() {
    return document.querySelector('canvas.graph-canvas-container')
        || document.querySelector('canvas#graph-canvas')
        || document.querySelector('canvas');
  }
  function canvasRect() {
    const el = canvasEl();
    return el ? el.getBoundingClientRect()
              : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
  }

  // Canvas-space → screen-space using the live drag-scale state.
  function c2s(cvX, cvY) {
    const app = window.app;
    const r = canvasRect();
    if (!app || !app.canvas || !app.canvas.ds) return { x: cvX, y: cvY };
    const ds = app.canvas.ds;
    return { x: (cvX + ds.offset[0]) * ds.scale + r.left, y: (cvY + ds.offset[1]) * ds.scale + r.top };
  }

  // ── Cursor ──────────────────────────────────────────────────────────────
  // Pixel-accurate macOS arrow: black fill, white outline, soft shadow.
  // Geometry traced from the system cursor — hotspot is the tip at top-left.
  function macCursorSVG(size) {
    return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">'
      + '<path d="M4.5 1.2 L4.5 16.6 L8.3 13.0 L10.6 18.3 L13.2 17.2 L10.9 11.9 L16.1 11.6 Z" '
      + 'fill="black" stroke="white" stroke-width="1.3" stroke-linejoin="round"/></svg>';
  }

  let cur = null, cx = 0, cy = 0;
  let driftRAF = null;

  function ensureCursor(opts = {}) {
    const size = opts.size || 20;
    if (cur && document.body.contains(cur)) return cur;
    cur = document.createElement('div');
    cur.id = '__crm_cursor';
    cur.innerHTML = macCursorSVG(size);
    Object.assign(cur.style, {
      position: 'fixed', top: '0', left: '0',
      width: size + 'px', height: size + 'px',
      zIndex: '999999', pointerEvents: 'none',
      filter: 'drop-shadow(0 1px 2px rgba(0,0,0,.35))',
      willChange: 'transform',
    });
    cx = window.innerWidth / 2; cy = window.innerHeight / 2;
    cur.style.transform = 'translate(' + cx + 'px,' + cy + 'px)';
    document.body.appendChild(cur);
    return cur;
  }

  function setCursor(x, y) {
    cx = x; cy = y;
    if (cur) cur.style.transform = 'translate(' + x + 'px,' + y + 'px)';
  }

  function removeCursor() {
    stopDrift();
    if (cur) { try { cur.remove(); } catch (_) {} cur = null; }
  }

  async function fadeOutCursor() {
    if (!cur) return;
    cur.style.transition = 'opacity .5s';
    cur.style.opacity = '0';
    await slp(550);
    removeCursor();
  }

  // Fitts-law-ish duration: longer travels take longer, sub-linearly.
  function cursorDuration(dist) {
    return clamp(120 + 190 * Math.log2(dist / 40 + 1), 220, 1100);
  }

  // Move along a quadratic bezier bowed perpendicular to the travel line.
  // ONE continuous motion that decelerates into the target and stops — no
  // overshoot, no settle pass. (The old overshoot+settle+snap was three
  // distinct motions at every arrival and read as a shake on screen.)
  async function moveCursor(tx, ty, opts = {}) {
    ensureCursor(opts);
    stopDrift();
    const fx = cx, fy = cy;
    const dx = tx - fx, dy = ty - fy;
    const dist = Math.hypot(dx, dy);
    if (dist < 2) return;

    const dur = opts.duration || cursorDuration(dist);
    // Perpendicular bow: subtle (±4–7% of distance) — enough to not be a laser
    // line, small enough to not read as a flourish. Side varies by direction.
    const bowMag = dist * (0.04 + 0.03 * Math.abs(Math.sin(fx * 0.013 + fy * 0.007)));
    const side = ((fx + fy + tx) % 2 < 1) ? 1 : -1;
    const mx = fx + dx / 2 - (dy / dist) * bowMag * side;
    const my = fy + dy / 2 + (dx / dist) * bowMag * side;

    const t0 = performance.now();
    while (true) {
      if (window.__comfyReplayStop) return;
      const t = clamp((performance.now() - t0) / dur, 0, 1);
      const e = easeOutCubic(t);
      const omt = 1 - e;
      setCursor(omt * omt * fx + 2 * omt * e * mx + e * e * tx,
                omt * omt * fy + 2 * omt * e * my + e * e * ty);
      if (t >= 1) break;
      await frm();
    }
    setCursor(tx, ty);
  }

  // Sub-pixel organic wander while "reading" — slow (>4s period) and under
  // 1px so it reads as presence, never as jitter. Call stopDrift() to move.
  function startDrift() {
    stopDrift();
    const bx = cx, by = cy, t0 = performance.now();
    const tick = () => {
      const t = (performance.now() - t0) / 1000;
      setCursor(bx + Math.sin(t * 0.35) * 0.8 + Math.sin(t * 0.9) * 0.25,
                by + Math.cos(t * 0.28) * 0.7 + Math.sin(t * 0.75) * 0.2);
      driftRAF = requestAnimationFrame(tick);
    };
    driftRAF = requestAnimationFrame(tick);
  }
  function stopDrift() {
    if (driftRAF) { cancelAnimationFrame(driftRAF); driftRAF = null; }
  }

  // ── Camera ──────────────────────────────────────────────────────────────
  // Time-based pan/zoom of LiteGraph's DragAndScale. Long travels get the
  // mid-flight zoom-out arc; short hops stay direct.
  function cameraDuration(cvDist, scaleFrom, scaleTo) {
    const px = cvDist * Math.max(scaleFrom, scaleTo); // approx screen distance
    return clamp(px * 0.9 + Math.abs(scaleTo - scaleFrom) * 900, 400, 1800);
  }

  async function cameraTo(cvX, cvY, targetScale, opts = {}) {
    const app = window.app;
    if (!app || !app.canvas || !app.canvas.ds) return;
    const ds = app.canvas.ds;
    const r = canvasRect();

    const s0 = ds.scale, s1 = targetScale;
    const oX0 = ds.offset[0], oY0 = ds.offset[1];
    const oX1 = (r.width / 2) / s1 - cvX, oY1 = (r.height / 2) / s1 - cvY;

    // Current canvas-space center, for travel distance
    const c0x = (r.width / 2) / s0 - oX0, c0y = (r.height / 2) / s0 - oY0;
    const cvDist = Math.hypot(cvX - c0x, cvY - c0y);

    const dur = opts.duration || cameraDuration(cvDist, s0, s1);
    if (typeof opts.onDuration === 'function') { try { opts.onDuration(dur); } catch (_) {} }
    const ease = dur > 900 ? easeInOutQuint : easeInOutCubic;

    // Zoom-out arc: only for long travels — pull the scale through a midpoint
    // below both endpoints so the camera "lifts off" then "lands".
    const screenDist = cvDist * Math.max(s0, s1);
    const useArc = opts.arc !== false && screenDist > r.width * 0.6;
    const sMid = Math.min(s0, s1) * 0.8;

    const t0 = performance.now();
    while (true) {
      if (window.__comfyReplayStop) return;
      const t = clamp((performance.now() - t0) / dur, 0, 1);
      const e = ease(t);
      let s;
      if (useArc) {
        const omt = 1 - e;
        s = omt * omt * s0 + 2 * omt * e * sMid + e * e * s1; // quadratic through sMid
      } else {
        s = s0 + (s1 - s0) * e;
      }
      // Pan the canvas-space center linearly in eased time, then derive the
      // offset from the CURRENT scale so pan + zoom stay locked together.
      const cxNow = c0x + (cvX - c0x) * e, cyNow = c0y + (cvY - c0y) * e;
      ds.scale = s;
      ds.offset[0] = (r.width / 2) / s - cxNow;
      ds.offset[1] = (r.height / 2) / s - cyNow;
      app.canvas.setDirty(true, true);
      if (t >= 1) break;
      await frm();
    }
  }

  // Fit a canvas-space bbox [x, y, w, h] into the viewport.
  // margin < 1 leaves breathing room; scale is clamped to [minScale, maxScale].
  function fitScaleFor(bbox, margin = 0.85, minScale = 0.1, maxScale = 1.2) {
    const r = canvasRect();
    const s = Math.min(r.width / Math.max(bbox[2], 1), r.height / Math.max(bbox[3], 1)) * margin;
    return clamp(s, minScale, maxScale);
  }

  async function cameraToBBox(bbox, opts = {}) {
    const scale = opts.scale != null ? opts.scale
      : fitScaleFor(bbox, opts.margin || 0.85, opts.minScale || 0.1, opts.maxScale || 1.2);
    await cameraTo(bbox[0] + bbox[2] / 2, bbox[1] + bbox[3] / 2, scale, opts);
    return scale;
  }

  // Very slow constant drift (for "executing" beats) — pans the center by
  // (dxCv, dyCv) canvas units over durMs. Cancels on __comfyReplayStop or
  // when the returned controller's .stop() is called.
  function startCameraDrift(dxCv, dyCv, durMs) {
    const app = window.app;
    if (!app || !app.canvas || !app.canvas.ds) return { stop() {} };
    const ds = app.canvas.ds;
    const oX0 = ds.offset[0], oY0 = ds.offset[1];
    let stopped = false, raf = null;
    const t0 = performance.now();
    const tick = () => {
      if (stopped || window.__comfyReplayStop) return;
      const t = clamp((performance.now() - t0) / durMs, 0, 1);
      ds.offset[0] = oX0 - dxCv * t;
      ds.offset[1] = oY0 - dyCv * t;
      app.canvas.setDirty(true, true);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return { stop() { stopped = true; if (raf) cancelAnimationFrame(raf); } };
  }

  window.__ComfyReplayMotion = {
    ensureCursor, moveCursor, setCursor, removeCursor, fadeOutCursor,
    startDrift, stopDrift,
    cameraTo, cameraToBBox, fitScaleFor, startCameraDrift,
    c2s, canvasRect, slp, frm, clamp,
  };
})();
