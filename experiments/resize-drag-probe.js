// ═══════════════════════════════════════════════════════════════
// ComfyUI Node-Resize Synthetic-Drag Probe
// ───────────────────────────────────────────────────────────────
// We want to know whether synthetic pointer events dispatched at
// a node's bottom-right resize handle will drive LiteGraph's
// resize logic the same way a real user's drag does. If yes, we
// can animate node resizes by "fake-dragging" the corner — clean,
// no fighting the framework. If no, we have to fall back to
// setting node.size each frame ourselves.
//
// The probe operates on the first node in the graph (creates a
// KSampler near canvas center if the graph is empty). For each of
// 3 dispatch strategies it:
//   1. Captures node.size before
//   2. Runs the drag sequence (down → moves → up) toward
//      [+80, +80] in canvas coords from the current corner
//   3. Captures node.size after
//   4. Records whether size changed by ~80 in each axis
//
// Whichever strategy wins is what we'll use in production.
// Report stashed at window.__report — run copy(__report) in
// the DevTools prompt to copy it.
// ═══════════════════════════════════════════════════════════════

(async function resizeProbe() {
  const lines = [];
  const log = (...a) => { const s = a.join(' '); console.log('[resize-probe]', s); lines.push(s); };
  const sl = ms => new Promise(r => setTimeout(r, ms));

  if (typeof app === 'undefined' || !app.canvas || !app.graph) {
    log('no app.canvas / app.graph — are you in a ComfyUI tab?');
    return;
  }

  // ── Setup ─────────────────────────────────────────────────────
  const canvasEl =
    document.querySelector('canvas.graph-canvas-container') ||
    document.querySelector('canvas#graph-canvas') ||
    document.querySelector('canvas');
  if (!canvasEl) { log('no canvas element found'); return; }

  function c2s(cx, cy) {
    const r = canvasEl.getBoundingClientRect();
    const ds = app.canvas.ds;
    return {
      x: (cx + ds.offset[0]) * ds.scale + r.left,
      y: (cy + ds.offset[1]) * ds.scale + r.top,
    };
  }

  // ── Pick or create a node ─────────────────────────────────────
  let node = app.graph._nodes[0];
  let createdNew = false;
  if (!node) {
    log('graph empty — creating a KSampler near canvas center');
    node = LiteGraph.createNode('KSampler');
    if (!node) { log('FAIL: could not create KSampler'); return; }
    const rect = canvasEl.getBoundingClientRect();
    const ds = app.canvas.ds;
    node.pos = [
      (rect.width / 2) / ds.scale - ds.offset[0] - node.size[0] / 2,
      (rect.height / 2) / ds.scale - ds.offset[1] - node.size[1] / 2,
    ];
    app.graph.add(node);
    app.canvas.setDirty(true, true);
    createdNew = true;
    await sl(300);
  }
  log('test node:', node.type, '· id:', node.id, '· pos:', JSON.stringify([node.pos[0], node.pos[1]]));

  // ── Helpers for the drag ──────────────────────────────────────
  const DELTA = 80;  // canvas-space pixels to grow

  function snapshot() {
    return [node.size[0], node.size[1]];
  }

  function cornerCanvas() {
    return [node.pos[0] + node.size[0], node.pos[1] + node.size[1]];
  }
  function targetCornerCanvas() {
    return [node.pos[0] + node.size[0] + DELTA, node.pos[1] + node.size[1] + DELTA];
  }

  function pointerEvt(type, x, y, isDown) {
    return new PointerEvent(type, {
      bubbles: true, cancelable: true,
      clientX: x, clientY: y,
      screenX: x, screenY: y,
      pointerId: 1, pointerType: 'mouse', isPrimary: true,
      button: 0, buttons: isDown ? 1 : 0,
      view: window,
    });
  }
  function mouseEvt(type, x, y, isDown) {
    const e = new MouseEvent(type, {
      bubbles: true, cancelable: true,
      clientX: x, clientY: y,
      screenX: x, screenY: y,
      button: 0, buttons: isDown ? 1 : 0,
      view: window,
    });
    const r = canvasEl.getBoundingClientRect();
    e.canvasX = x - r.left;
    e.canvasY = y - r.top;
    return e;
  }

  async function runDragSequence(target, name, dispatch, postDispatchHook) {
    log('--- trying', name);
    const before = snapshot();
    log('   before:', JSON.stringify(before));

    const startScreen = c2s(...cornerCanvas());
    const endScreen = c2s(...targetCornerCanvas());

    try {
      dispatch('down', startScreen.x, startScreen.y);
    } catch (e) { log('   pointerdown threw:', e.message); return false; }
    await sl(60);
    log('   after down:', JSON.stringify(snapshot()));

    const steps = 12;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const x = startScreen.x + (endScreen.x - startScreen.x) * t;
      const y = startScreen.y + (endScreen.y - startScreen.y) * t;
      try { dispatch('move', x, y); } catch (e) { log('   move threw:', e.message); break; }
      await sl(20);
    }
    log('   after moves:', JSON.stringify(snapshot()));

    try { dispatch('up', endScreen.x, endScreen.y); } catch (e) { log('   up threw:', e.message); }
    await sl(120);
    if (postDispatchHook) {
      try { postDispatchHook(); } catch (e) { log('   posthook threw:', e.message); }
    }

    const after = snapshot();
    log('   after up:', JSON.stringify(after));
    const dx = after[0] - before[0], dy = after[1] - before[1];
    log('   delta:', dx.toFixed(1), dy.toFixed(1));
    const won = Math.abs(dx - DELTA) < 15 && Math.abs(dy - DELTA) < 15;
    if (won) log('   ✅ resized by expected amount');
    else log('   ❌ not resized as expected (delta should be ~' + DELTA + ',' + DELTA + ')');
    // Reset size for the next attempt
    node.size = [before[0], before[1]];
    app.canvas.setDirty(true, true);
    await sl(80);
    return won;
  }

  // ── Strategy A: PointerEvent on canvasEl ──────────────────────
  let winner = null;
  const aWon = await runDragSequence(null, 'A: PointerEvent on canvasEl', (kind, x, y) => {
    const type = kind === 'down' ? 'pointerdown' : kind === 'up' ? 'pointerup' : 'pointermove';
    canvasEl.dispatchEvent(pointerEvt(type, x, y, kind !== 'up'));
  });
  if (aWon) winner = 'A: PointerEvent on canvasEl';

  // ── Strategy B: MouseEvent on canvasEl ────────────────────────
  if (!winner) {
    const bWon = await runDragSequence(null, 'B: MouseEvent on canvasEl', (kind, x, y) => {
      const type = kind === 'down' ? 'mousedown' : kind === 'up' ? 'mouseup' : 'mousemove';
      canvasEl.dispatchEvent(mouseEvt(type, x, y, kind !== 'up'));
    });
    if (bWon) winner = 'B: MouseEvent on canvasEl';
  }

  // ── Strategy C: app.canvas.processMouseDown/Move/Up ───────────
  if (!winner) {
    if (typeof app.canvas.processMouseDown === 'function') {
      const cWon = await runDragSequence(null, 'C: LGraphCanvas.processMouseDown/Move/Up', (kind, x, y) => {
        if (kind === 'down') app.canvas.processMouseDown(mouseEvt('mousedown', x, y, true));
        else if (kind === 'up' && app.canvas.processMouseUp) app.canvas.processMouseUp(mouseEvt('mouseup', x, y, false));
        else if (kind === 'move' && app.canvas.processMouseMove) app.canvas.processMouseMove(mouseEvt('mousemove', x, y, true));
      });
      if (cWon) winner = 'C: LGraphCanvas.processMouseDown/Move/Up';
    } else {
      log('C: app.canvas.processMouseDown not available — skipping');
    }
  }

  log('========================================');
  log('RESULT — winning strategy:', winner || 'NONE');
  log('========================================');

  if (createdNew) {
    log('removing test KSampler (it was created by the probe)');
    app.graph.remove(node);
    app.canvas.setDirty(true, true);
  }

  window.__report = lines.join('\n');
  console.log(
    '%c[resize-probe] report at window.__report — run  copy(__report)  in the prompt',
    'color:#00ff88;font-weight:bold;'
  );
})();
