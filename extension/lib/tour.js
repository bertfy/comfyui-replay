// Tour runner — walks the live, already-loaded graph on cloud.comfy.org.
// Runs in MAIN world; motion.js must be injected first.
//
// Input (set by bg.js 'inject-tour' before this file):
//   window.__comfyTourInput = {
//     shots:   [...]            // from lib/shotlist.js (panel side)
//     voAudio: { id: { audioUrl, durationMs } }   // data-URLs ok
//     opts:    { cursorSize, runWorkflow, executionTimeoutMs }
//   }
//
// Progress contract (same globals the panel's waitForReplayDone polls):
//   __extBeatIdx / __extBeatLabel — per shot
//   __comfyReplayDone / __comfyReplayErr — at the end

(function () {
  const TAG = '%c[ComfyTour]';
  const STY = 'color:#F2FF59;font-weight:bold;';
  const log = (...a) => console.log(TAG, STY, ...a);
  const warn = (...a) => console.warn(TAG, STY, ...a);

  const M = window.__ComfyReplayMotion;
  const slp = ms => new Promise(r => setTimeout(r, ms));
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  // ── Pacing (tuned against a 6-video reference corpus) ─────────────────────
  // The reference narrator breathes every 4–7s: median pause 0.55s, p90 ~0.8s,
  // max 1.3s — never longer. Lines run continuously with the CAMERA moving into
  // each next beat during the previous line's tail; a slightly longer breath
  // lands at section changes. We never overlap two VO clips (no double-talk) —
  // only motion overlaps the audio.
  const OVERLAP_MS = 600;   // start the next beat's camera move this long before the current line ends
  const GAP_MS     = 350;   // breath between lines within a section (~0.5s w/ the clip's own tail)
  const BREATH_MS  = 700;   // longer breath at a section change (reference p90–max territory)
  const MOVE_MIN   = 500;   // camera-move duration floor
  const MOVE_MAX   = 1800;  // camera-move duration ceiling
  // Camera move fit to a line: roughly half the clip, so the camera lands with
  // time left for the cursor to gesture over the subject while the line finishes.
  const fitMoveMs = clipMs => clamp((clipMs || 1500) * 0.5, MOVE_MIN, MOVE_MAX);
  const isTourSection = s => s === 'overview' || s === 'tour';

  // Live framing: the plan-time targetScale was estimated from the full window,
  // but the real canvas is narrower (side panels) — shots were over-zoomed and
  // cropped. Fit against the LIVE canvas rect at shot time; the planned scale
  // only acts as an upper bound, and node close-ups stay ≤0.9 so context
  // around the subject remains visible.
  function liveScale(shot) {
    if (!shot || !shot.bbox || !window.__ComfyReplayMotion) return shot && shot.targetScale || undefined;
    const kind = shot.kind;
    // Overviews pull back but NEVER go microscopic: a 58-node graph fit-to-all
    // landed at 20% (unreadable postage stamps); the reference videos never
    // drop below ~56% even when that crops the graph's edges. Floor at 0.30
    // and ignore the plan-time targetScale (its old 0.18 floor drags it down).
    if (kind === 'overview' || kind === 'overview2') {
      return M.fitScaleFor(shot.bbox, 0.88, 0.30, 0.40);
    }
    // Showcase shots (coldopen / result) FILL the frame — they're the payoff,
    // not a node to read. Node close-ups keep breathing room for context.
    const showcase = kind === 'result' || kind === 'coldopen';
    const margin = showcase ? 0.75 : (kind === 'node' ? 0.55 : 0.78);
    const maxS   = showcase ? 1.1  : (kind === 'node' ? 0.9  : 0.95);
    const s = M.fitScaleFor(shot.bbox, margin, 0.08, maxS);
    return shot.targetScale ? Math.min(shot.targetScale, s) : s;
  }

  // For showcase shots, center on the MEDIA region (lower part of the node),
  // not the title bar — shifts the framed box down ~12% of its height.
  const showcaseBBox = b => b ? [b[0], b[1] + b[3] * 0.12, b[2], b[3]] : b;
  const camBBox = shot => (shot.kind === 'coldopen' || shot.kind === 'result')
    ? showcaseBBox(shot.bbox) : shot.bbox;

  // ── Single-instance guard ─────────────────────────────────────────────────
  // Signal any prior run (tour OR build replay) to stop, then yield with an
  // async wait so it can actually wind down — a synchronous spin would block
  // the main thread and the prior run could never release its flag.
  async function stopPriorRun() {
    if (!window.__comfyReplayRunning && !window.__replayRunning) return;
    log('Stopping prior replay/tour…');
    if (window.__comfyReplayRunning) window.__comfyReplayStop = true;
    if (window.__replayRunning) window.__replayStop = true;
    const t0 = Date.now();
    while ((window.__comfyReplayRunning || window.__replayRunning) && Date.now() - t0 < 5000) {
      await slp(100);
    }
  }

  // All cloud-frontend DOM selectors live here — they are the part most
  // likely to drift with frontend releases.
  const SELECTORS = {
    runButton: [
      '[data-testid="queue-button"]',
      'button.comfyui-button.primary',
      '#queue-button',
      'button[title="Queue Prompt"]',
    ],
    runButtonTextRe: /queue|run/i,
    readyOverlay: '.p-dialog-mask, .loading-overlay, [role="progressbar"]',
    // Queue rejections (e.g. "Subscription required to queue workflows") surface
    // as a DOM toast, NOT an app.api execution_error event — watch for them so a
    // failed Run doesn't leave the tour hanging in silence.
    errorToast: '.p-toast-message-error, .p-toast-message-danger, .p-message-error, [role="alert"]',
  };
  const ERROR_TOAST_RE = /subscription|required|error|failed|insufficient|limit|quota|denied/i;
  function domRunError() {
    for (const el of document.querySelectorAll(SELECTORS.errorToast)) {
      if (el.offsetParent !== null && ERROR_TOAST_RE.test(el.textContent || '')) {
        return (el.textContent || 'queue error').trim().replace(/\s+/g, ' ').slice(0, 120);
      }
    }
    return null;
  }

  async function waitForReady(timeoutMs = 30000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (window.__comfyReplayStop) return false;
      const ok = !!(window.app && window.app.graph && window.app.canvas
                    && Array.isArray(window.app.graph._nodes));
      const overlay = document.querySelector(SELECTORS.readyOverlay);
      const overlayVisible = !!(overlay && overlay.offsetParent !== null);
      if (ok && !overlayVisible) { log('Comfy ready ✓'); return true; }
      await slp(250);
    }
    warn('waitForReady timeout');
    return false;
  }

  // ── VO: decode data-URLs to AudioBuffers up front ─────────────────────────
  async function prefetchAudio(voAudio) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    try { await ctx.resume(); } catch (_) {}
    const buffers = {};
    const entries = Object.entries(voAudio || {});
    await Promise.all(entries.map(async ([id, v]) => {
      try {
        const resp = await fetch(v.audioUrl);
        const arr = await resp.arrayBuffer();
        buffers[id] = await ctx.decodeAudioData(arr);
      } catch (e) { warn(`VO decode failed for ${id}:`, e.message); }
    }));
    log(`VO ready: ${Object.keys(buffers).length}/${entries.length}`);
    return { ctx, buffers };
  }

  function playBuffer(ctx, buf) {
    if (!buf) return 0;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.start();
    return Math.round(buf.duration * 1000);
  }

  // ── Run button ────────────────────────────────────────────────────────────
  function findRunButton() {
    for (const sel of SELECTORS.runButton) {
      const el = document.querySelector(sel);
      if (el && el.offsetParent !== null) return el;
    }
    return [...document.querySelectorAll('button')].find(b =>
      (SELECTORS.runButtonTextRe.test(b.textContent || '') ||
       SELECTORS.runButtonTextRe.test(b.title || '')) && b.offsetParent !== null) || null;
  }

  async function triggerRun() {
    const btn = findRunButton();
    if (btn) {
      const r = btn.getBoundingClientRect();
      await M.moveCursor(r.left + r.width / 2, r.top + r.height / 2);
      await slp(250);
      btn.click();
      log('Run clicked ✓');
      return true;
    }
    warn('No Run button found — falling back to app.queuePrompt');
    try { await window.app.queuePrompt(0, 1); return true; } catch (e) { warn('queuePrompt failed:', e.message); }
    try {
      const p = await window.app.graphToPrompt();
      const resp = await fetch('/prompt', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: p.output }),
      });
      return resp.ok;
    } catch (e) { warn('POST /prompt failed:', e.message); return false; }
  }

  // ── Execution completion ──────────────────────────────────────────────────
  // Prefer app.api events; fall back to polling runningNodeId. The poller
  // requires execution activity to have been OBSERVED before idle counts as
  // done — a cloud job can take seconds to enter the queue, during which
  // runningNodeId is null and a naive "3s idle = done" fires way too early.
  async function waitForExecution(maxMs) {
    let done = false, errMsg = null, sawActivity = false;
    const api = window.app && window.app.api;
    const cleanups = [];
    if (api && typeof api.addEventListener === 'function') {
      try {
        const onSuccess = () => { done = true; };
        const onExecuted = () => { sawActivity = true; };
        const onError = (e) => { errMsg = (e && e.detail && (e.detail.exception_message || e.detail.error)) || 'execution_error'; done = true; };
        const onExecuting = (e) => { if (e && e.detail) sawActivity = true; };
        api.addEventListener('execution_success', onSuccess);
        api.addEventListener('executed', onExecuted);
        api.addEventListener('execution_error', onError);
        api.addEventListener('executing', onExecuting);
        cleanups.push(() => {
          try {
            api.removeEventListener('execution_success', onSuccess);
            api.removeEventListener('executed', onExecuted);
            api.removeEventListener('execution_error', onError);
            api.removeEventListener('executing', onExecuting);
          } catch (_) {}
        });
        log('Listening on app.api execution events');
      } catch (e) { warn('app.api listeners unavailable:', e.message); }
    }

    // If no execution activity is ever observed, don't wait the full timeout —
    // a queue rejection (e.g. no subscription) means the job never starts.
    const NO_ACTIVITY_GRACE_MS = 20000;
    const t0 = Date.now();
    let idleSince = null, lastQueueCheck = 0;
    while (Date.now() - t0 < maxMs && !window.__comfyReplayStop && !done) {
      // Terminal DOM error toast (queue rejection) — bail immediately.
      const toast = domRunError();
      if (toast) { errMsg = toast; done = true; break; }
      const running = window.app && window.app.runningNodeId != null;
      if (running) { sawActivity = true; idleSince = null; }
      else if (sawActivity) {
        if (idleSince == null) idleSince = Date.now();
        else if (Date.now() - idleSince > 3000) { done = true; break; }
      } else if (Date.now() - t0 > NO_ACTIVITY_GRACE_MS) {
        // 20s in with nothing running/pending/executing and no events — the job
        // almost certainly never queued. Fail rather than hang in silence.
        errMsg = 'no execution activity (job may not have queued)';
        done = true; break;
      } else if (Date.now() - lastQueueCheck > 4000) {
        // Haven't seen activity yet — check the queue so a job that's
        // pending-but-not-running still counts as activity.
        lastQueueCheck = Date.now();
        try {
          const r = await fetch('/queue');
          if (r.ok) {
            const q = await r.json();
            if ((q.queue_running && q.queue_running.length) ||
                (q.queue_pending && q.queue_pending.length)) sawActivity = true;
          }
        } catch (_) { /* cloud may not serve /queue — rely on events */ }
      }
      await slp(500);
    }
    cleanups.forEach(fn => fn());
    return { completed: done && !errMsg, error: errMsg, sawActivity, elapsedMs: Date.now() - t0 };
  }

  // ── Live node lookups ─────────────────────────────────────────────────────
  function liveNode(id) {
    try { return window.app.graph.getNodeById(id); } catch (_) { return null; }
  }
  function liveNodeBBox(id) {
    const n = liveNode(id);
    if (!n) return null;
    return [n.pos[0], n.pos[1], n.size[0], n.size[1]];
  }
  function nodesWithImages() {
    const out = new Set();
    for (const n of (window.app.graph._nodes || [])) {
      if ((n.imgs && n.imgs.length) || n.previewMediaType) out.add(n.id);
    }
    return out;
  }
  // After a run, prefer a node whose media is NEW (wasn't there pre-run);
  // else any node with media; else null. Within a candidate set, the SAVED
  // output (Video Combine / Save*) outranks scratch previews — the tour must
  // end on the real deliverable, not a PreviewImage.
  const SAVE_TYPE_RE = /combine|savevideo|saveanimated|saveimage|save/i;
  const PREVIEW_TYPE_RE = /^PreviewImage$|preview/i;
  function rankResult(list) {
    const score = n => {
      const ty = String(n.type || '');
      let s = 0;
      if (SAVE_TYPE_RE.test(ty)) s += 3;
      if (!(n.outputs || []).some(o => o.links && o.links.length)) s += 2;
      if (PREVIEW_TYPE_RE.test(ty)) s -= 2;
      return s;
    };
    return list.slice().sort((a, b) =>
      (score(b) - score(a)) ||
      ((b.size[0] * b.size[1]) - (a.size[0] * a.size[1])))[0] || null;
  }
  function findResultNode(preRunImageIds) {
    const nodes = window.app.graph._nodes || [];
    const withMedia = nodes.filter(n => (n.imgs && n.imgs.length) || n.previewMediaType);
    const fresh = withMedia.filter(n => !preRunImageIds.has(n.id));
    if (fresh.length) return rankResult(fresh);
    if (withMedia.length) return rankResult(withMedia);
    return null;
  }

  // ── Cursor gestures ───────────────────────────────────────────────────────
  // Purposeful sub-targets within a shot to sweep between WHILE the line plays —
  // so the cursor is never frozen. Canvas-space points; converted live so they
  // track the camera. Returned as a small ring the gesture loop cycles through.
  function gesturePoints(shot) {
    const action = shot.cursorAction;
    // Prefer the live node bbox for node shots (camera/layout may have shifted)
    let b = shot.bbox;
    if (action && action.type === 'hover-node') b = liveNodeBBox(action.nodeId) || shot.bbox;
    if (!b) return null;
    const [x, y, w, h] = b;
    if (action && action.type === 'hover-node') {
      // Trace the lower/middle band where prompt text and previews live.
      return [
        [x + w * 0.30, y + h * 0.60],
        [x + w * 0.62, y + h * 0.66],
        [x + w * 0.46, y + h * 0.52],
      ];
    }
    // group / overview: a slow diagonal drift across the framed region's middle
    return [
      [x + w * 0.34, y + h * 0.42],
      [x + w * 0.60, y + h * 0.58],
      [x + w * 0.46, y + h * 0.50],
    ];
  }

  // Cursor presence during a line: a couple of slow, deliberate gestures with
  // long RESTS between them — like a person talking over their own screen, not
  // a metronome. Most of a line is spent resting on the subject.
  const MAX_GESTURES_PER_SHOT = 3;
  async function gestureLoop(shot, untilFn) {
    const pts = gesturePoints(shot);
    if (!pts) { while (!untilFn() && !window.__comfyReplayStop) await slp(60); return; }
    let i = 0;
    while (!untilFn() && !window.__comfyReplayStop) {
      if (i < MAX_GESTURES_PER_SHOT) {
        const [cvx, cvy] = pts[i % pts.length];
        const p = M.c2s(cvx, cvy);
        await M.moveCursor(p.x, p.y, { duration: 1400 + (i % 3) * 400 });
        i++;
      }
      // Rest — 1.8–3s, woken early when the line releases.
      const restMs = 1800 + Math.min(1200, i * 400);
      const t0 = Date.now();
      while (Date.now() - t0 < restMs && !untilFn() && !window.__comfyReplayStop) await slp(80);
    }
  }

  // ── Main ──────────────────────────────────────────────────────────────────
  async function main(input) {
    const { shots = [], voAudio = {}, opts = {} } = input;
    const cursorSize = opts.cursorSize || 20;
    const executionTimeoutMs = opts.executionTimeoutMs || 10 * 60 * 1000;
    const useArc = opts.arc !== false; // mid-flight zoom-out arc (off in Fast Draft)

    await stopPriorRun();
    window.__comfyReplayStop = false;
    window.__comfyReplayRunning = true;

    window.__extBeatIdx = 0;
    window.__extBeatLabel = null;
    window.__extPhase = null;

    if (!await waitForReady()) {
      window.__comfyReplayErr = 'comfy not ready';
      window.__comfyReplayDone = true;
      window.__comfyReplayRunning = false;
      return;
    }

    const audio = await prefetchAudio(voAudio);
    M.ensureCursor({ size: cursorSize });
    const preRunImageIds = nodesWithImages();
    const hadRun = shots.some(s => s.kind === 'run'); // prerun ending has none
    let runFailed = false;

    // Play a VO clip and return when it's expected to end (ms timestamp). When
    // there's no audio (silent tour), fall back to the stashed clip length or
    // the shot's dwell floor so pacing still works.
    const playShotVO = (shot) => {
      const buf = audio.buffers[shot.voId];
      if (buf) return Date.now() + playBuffer(audio.ctx, buf);
      return Date.now() + (shot.clipMs || shot.minDwellMs || 1800);
    };

    // pendingMove carries the camera move toward the CURRENT shot — it was
    // kicked off during the PREVIOUS line's tail (the overlap), so the camera is
    // already arriving when this line starts. null on the first beat / after a
    // special beat, in which case we move now.
    let pendingMove = null;

    for (let i = 0; i < shots.length; i++) {
      if (window.__comfyReplayStop) break;
      const shot = shots[i];
      const next = shots[i + 1];
      window.__extBeatIdx = i + 1;
      window.__extBeatLabel = shot.label || shot.kind;
      log(`Shot ${i + 1}/${shots.length}: [${shot.kind}] ${shot.label}`);

      // ── Special beats: run / executing / result stay blocking (cloud job is
      // variable-length; never overlap these). ────────────────────────────────
      if (shot.kind === 'run') {
        if (pendingMove) { try { await pendingMove; } catch (_) {} pendingMove = null; }
        M.stopDrift();
        const voEnds = playShotVO(shot);
        const ok = await triggerRun();
        if (!ok) { runFailed = true; warn('Run could not be triggered — ending tour'); }
        while (Date.now() < voEnds && !window.__comfyReplayStop) await slp(80);
        if (runFailed) break; // graceful: don't sit on an unrun graph
        continue;
      }
      if (shot.kind === 'executing') {
        if (runFailed) continue;
        M.stopDrift();
        const voEnds = playShotVO(shot);
        const drift = M.startCameraDrift(160, 90, Math.max(8000, (shot.minDwellMs || 4000) * 3));
        // Once the line has been said and the job is still cooking, flag the
        // wait phase — the panel pauses the MediaRecorder so a 6-minute cloud
        // render becomes a clean cut from "Run" to "result" in the video.
        const phaseTimer = setTimeout(() => { window.__extPhase = 'waiting'; },
          Math.max(0, voEnds - Date.now() + 300));
        const res = await waitForExecution(executionTimeoutMs);
        clearTimeout(phaseTimer);
        window.__extPhase = null;
        drift.stop();
        log(`Execution: ${res.completed ? 'complete ✓' : (res.error || 'timeout/no-activity')} after ${Math.round(res.elapsedMs / 1000)}s`);
        if (res.error) { warn('Execution error:', res.error); runFailed = true; break; } // never hang in silence
        while (Date.now() < voEnds && !window.__comfyReplayStop) await slp(80);
        // Brief beat for the panel's resume poll — the result shot's preview
        // wait covers the rest, so the recorded cut stays ~1s (reference max
        // is 1.3s; simulation flagged the old 900+700+camera chain at 3.7s).
        await slp(300);
        continue;
      }
      if (shot.kind === 'result') {
        if (runFailed) continue;
        M.stopDrift();
        // Previews-mount wait only matters when a run just happened (it also
        // covers the recorder's resume poll). In prerun mode the media has
        // been there all along — waiting would pad the breath past ~1.3s.
        if (hadRun) await slp(500);
        const resultNode = findResultNode(preRunImageIds);
        const bbox = resultNode ? liveNodeBBox(resultNode.id) : shot.bbox;
        // Line starts as the camera flies to the result — same concurrent
        // model as the tour beats, so the cut from render → result stays tight.
        const voEnds = playShotVO(shot);
        if (bbox) await M.cameraToBBox(showcaseBBox(bbox), { scale: liveScale({ kind: 'result', bbox, targetScale: shot.targetScale || 1.1 }), arc: useArc });
        const resultShot = resultNode
          ? { ...shot, cursorAction: { type: 'hover-node', nodeId: resultNode.id } }
          : shot;
        await gestureLoop(resultShot, () => Date.now() >= voEnds);
        continue;
      }

      // ── Tour beats: overview / group / node / overview2 — continuous flow ────
      // The camera move toward this shot was (usually) already kicked off during
      // the previous line's tail. Start THIS line immediately so audio is
      // gapless; the cursor waits for the camera to arrive, then gestures.
      const voEndsAt = playShotVO(shot);
      const clipMs = Math.max(shot.clipMs || 0, voEndsAt - Date.now());

      if (!pendingMove && shot.bbox) {
        // First tour beat (or after a special beat): no carried move — start one
        // now, concurrent with the line (camera catches up as we talk).
        pendingMove = M.cameraToBBox(camBBox(shot), { scale: liveScale(shot), arc: useArc, duration: fitMoveMs(clipMs) });
      }
      const arrival = pendingMove; pendingMove = null;

      // Decide breath length at the boundary to the NEXT shot: a short one
      // between lines, a longer one when the section changes.
      const nextIsTour = next && isTourSection(next.section) && next.bbox;
      const sameSection = next && next.section === shot.section;
      const releaseAt = !next ? voEndsAt : (sameSection ? voEndsAt + GAP_MS : voEndsAt + BREATH_MS);
      const kickAt = nextIsTour ? voEndsAt - OVERLAP_MS : null;

      // Wait for the camera to arrive (it may already be in flight), then keep
      // the cursor gesturing over the subject for the rest of the line.
      if (arrival) { try { await arrival; } catch (_) {} }
      let kicked = false;
      await gestureLoop(shot, () => {
        // Mid-tail: kick the next beat's camera move so it overlaps this line.
        if (kickAt != null && !kicked && Date.now() >= kickAt) {
          kicked = true;
          pendingMove = M.cameraToBBox(camBBox(next), {
            scale: liveScale(next), arc: useArc, duration: fitMoveMs(next.clipMs),
          });
        }
        return Date.now() >= (kickAt != null ? kickAt : releaseAt);
      });
      // Hold out any remaining time to the release point (gapless, or +breath).
      while (Date.now() < releaseAt && !window.__comfyReplayStop) await slp(60);
    }

    if (pendingMove) { try { await pendingMove; } catch (_) {} }
    window.__extPhase = null; // never leave the panel's recorder paused
    M.stopDrift();
    await M.fadeOutCursor();
    try { audio.ctx.close(); } catch (_) {}
    log(runFailed ? 'Tour ended early (run failed) ✓' : 'Tour complete ✓');
    window.__comfyReplayDone = true;
    window.__comfyReplayRunning = false;
  }

  const input = window.__comfyTourInput;
  window.__comfyReplayDone = false;
  window.__comfyReplayErr = null;
  if (!input || !Array.isArray(input.shots) || !input.shots.length) {
    // Note: don't touch __comfyReplayRunning here — this path never claimed
    // it, and a prior run may still own it.
    warn('no tour input; nothing to do');
    window.__comfyReplayErr = 'no tour input';
    window.__comfyReplayDone = true;
    return;
  }
  main(input).catch(e => {
    warn('tour error:', e);
    window.__comfyReplayErr = e.message;
    window.__comfyReplayDone = true;
    window.__comfyReplayRunning = false;
  });
})();
