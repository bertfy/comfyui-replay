// Replay runner — runs in cloud.comfy.org MAIN world.
// Inputs are baked in by the panel:
//   const NODES = [...]
//   const LINKS = [...]
//   const NARRATIONS = { id: text }   // optional
//   const AUDIO_MAP = { id: url }     // extension audio URLs (web_accessible_resources)
//   const OPTS = { useVO, stepDly }
//
// Postcondition: posts window.postMessage({source:'comfy-replay', type:'done', err?}) when finished.
//
// The runner re-implements the minimum from the larger generator. Single-instance
// guard, basic LiteGraph create + connect, optional VO playback per beat.

(function () {
  const TAG = '%c[ComfyReplay]';
  const STY = 'color:#5cd5fd;font-weight:bold;';
  function log(...a) { console.log(TAG, STY, ...a); }
  function warn(...a) { console.warn(TAG, STY, ...a); }

  // ── Single-instance guard ──────────────────────────────────────────────────
  if (window.__comfyReplayRunning) {
    log('Stopping prior replay…');
    window.__comfyReplayStop = true;
    const wait = Date.now();
    while (window.__comfyReplayRunning && Date.now() - wait < 5000) { /* wait */ }
    document.querySelectorAll('audio[data-comfy-vo]').forEach(a => { try { a.pause(); a.remove(); } catch(_){} });
  }
  window.__comfyReplayStop = false;
  window.__comfyReplayRunning = true;

  const slp = ms => new Promise(r => setTimeout(r, ms));

  // ── waitForComfyReady ──────────────────────────────────────────────────────
  async function waitForReady(timeoutMs = 30000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (window.__comfyReplayStop) return false;
      const ok = !!(window.app && window.app.graph && window.app.canvas
                    && Array.isArray(window.app.graph._nodes)
                    && typeof window.LiteGraph !== 'undefined');
      const overlay = document.querySelector('.p-dialog-mask, .loading-overlay, [role="progressbar"]');
      const overlayVisible = !!(overlay && overlay.offsetParent !== null);
      if (ok && !overlayVisible) { log('Comfy ready ✓'); return true; }
      await slp(250);
    }
    warn('waitForReady timeout');
    return false;
  }

  // ── Pre-load audio (AudioBuffers via fetch + decodeAudioData) ──────────────
  // Returns { ctx, buffers: { id: AudioBuffer }, totals: { id: durMs } }
  async function prefetchAudio(audioMap) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    const buffers = {};
    const totals = {};
    const entries = Object.entries(audioMap || {});
    log(`Prefetching ${entries.length} VO clip(s)…`);
    await Promise.all(entries.map(async ([id, url]) => {
      try {
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const arr = await resp.arrayBuffer();
        const buf = await ctx.decodeAudioData(arr);
        buffers[id] = buf;
        totals[id] = Math.round(buf.duration * 1000);
      } catch (e) {
        warn(`fetch failed for ${id}:`, e.message);
      }
    }));
    log(`VO ready: ${Object.keys(buffers).length}/${entries.length}`);
    return { ctx, buffers, totals };
  }

  // Play a buffer through ctx.destination — picked up by the tab audio
  // capture if user enabled "Share tab audio" in the gDM picker.
  function playBuffer(ctx, buf) {
    if (!buf) return 0;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.start();
    return Math.round(buf.duration * 1000);
  }

  // ── Main ───────────────────────────────────────────────────────────────────
  async function main(input) {
    const { NODES, LINKS, NARRATIONS = {}, AUDIO_MAP = {}, OPTS = {} } = input;
    const stepDly = OPTS.stepDly || 800;
    const useVO   = !!OPTS.useVO;

    if (!await waitForReady()) {
      window.postMessage({ source: 'comfy-replay', type: 'done', err: 'comfy not ready' }, '*');
      return;
    }

    let audio = { ctx: null, buffers: {}, totals: {} };
    if (useVO && Object.keys(AUDIO_MAP).length) {
      audio = await prefetchAudio(AUDIO_MAP);
      // Resume context — autoplay policy might keep it suspended
      try { await audio.ctx.resume(); } catch(_){}
    }

    const app = window.app;
    const LG  = window.LiteGraph;

    log(`Clearing canvas and building ${NODES.length} nodes / ${LINKS.length} links`);
    try { app.graph.clear(); app.canvas.setDirty(true, true); } catch (e) { warn('clear failed:', e.message); }
    await slp(400);

    const refs = {}; // workflow id → runtime node id
    const connected = new Set();

    for (let i = 0; i < NODES.length; i++) {
      if (window.__comfyReplayStop) break;
      const nd = NODES[i];

      log(`+ [${i+1}/${NODES.length}] ${nd.title || nd.type}`);
      const node = LG.createNode(nd.type);
      if (!node) { warn(`  could not create ${nd.type}`); continue; }
      node.pos = [nd.pos[0], nd.pos[1]];
      if (nd.title && nd.title !== nd.type) node.title = nd.title;
      app.graph.add(node);
      if (nd.size && nd.size.length === 2) node.size = [nd.size[0], nd.size[1]];

      // Set widget values directly (no animation in this MVP)
      if (nd.widgets_values && node.widgets) {
        for (let w = 0; w < Math.min(node.widgets.length, nd.widgets_values.length); w++) {
          const v = nd.widgets_values[w];
          if (v == null) continue;
          try {
            node.widgets[w].value = v;
            if (typeof node.widgets[w].callback === 'function') node.widgets[w].callback(v);
          } catch (e) { /* ignore */ }
        }
      }
      if (nd.properties) Object.assign(node.properties, nd.properties);
      refs[nd.id] = node.id;
      app.canvas.setDirty(true, true);

      // Per-beat VO + hold
      let holdMs = stepDly;
      if (useVO && NARRATIONS[nd.id]) {
        const buf = audio.buffers[nd.id];
        if (buf) {
          const dur = playBuffer(audio.ctx, buf);
          holdMs = Math.max(stepDly, dur);
        }
      }
      await slp(holdMs);

      // Try to connect newly-ready links
      for (let li = 0; li < LINKS.length; li++) {
        if (window.__comfyReplayStop) break;
        if (connected.has(li)) continue;
        const lk = LINKS[li];
        if (refs[lk.srcId] == null || refs[lk.tgtId] == null) continue;
        connected.add(li);
        const sn = app.graph.getNodeById(refs[lk.srcId]);
        const tn = app.graph.getNodeById(refs[lk.tgtId]);
        if (!sn || !tn) continue;
        try { sn.connect(lk.srcSlot, tn, lk.tgtSlot); app.canvas.setDirty(true, true); } catch(_){}

        const linkId = `link_${lk.srcId}_${lk.srcSlot}_${lk.tgtId}_${lk.tgtSlot}`;
        let linkHold = Math.round(stepDly * 0.3);
        if (useVO && NARRATIONS[linkId]) {
          const buf = audio.buffers[linkId];
          if (buf) {
            const dur = playBuffer(audio.ctx, buf);
            linkHold = Math.max(stepDly, dur);
          }
        }
        await slp(linkHold);
      }
    }

    // Best-effort: fit-to-view via Comfy's "." shortcut (zoom-fit)
    try {
      const ev = new KeyboardEvent('keydown', { key: '.', code: 'Period', keyCode: 190, bubbles: true });
      document.dispatchEvent(ev); window.dispatchEvent(ev);
    } catch(_){}

    await slp(500);
    log('Replay complete ✓');
    window.__comfyReplayDone = true;
    window.__comfyReplayRunning = false;
  }

  // Entry point — input is whatever the panel passed in.
  const input = window.__comfyReplayInput;
  window.__comfyReplayDone = false;
  window.__comfyReplayErr = null;
  if (!input) {
    warn('no input; nothing to do');
    window.__comfyReplayErr = 'no input';
    window.__comfyReplayDone = true;
    window.__comfyReplayRunning = false;
    return;
  }
  main(input).catch(e => {
    warn('replay error:', e);
    window.__comfyReplayErr = e.message;
    window.__comfyReplayDone = true;
    window.__comfyReplayRunning = false;
  });
})();
