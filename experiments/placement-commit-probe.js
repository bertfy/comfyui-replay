// ═══════════════════════════════════════════════════════════════
// Placement-Commit Probe
// ───────────────────────────────────────────────────────────────
// After selecting a row from the search dialog, the new node
// enters PLACEMENT MODE — added to app.graph._nodes but visually
// ghost-attached to the cursor until a real click commits it.
//
// This probe gets a KSampler into placement mode, then tries
// several commit strategies one at a time. For each, it tests
// whether the node still tracks cursor movement. The first one
// that "freezes" the node wins.
//
// Report at window.__report. In prompt:  copy(__report)
// ═══════════════════════════════════════════════════════════════

(async function probe() {
  const lines = [];
  const log = (...a) => { const s = a.join(' '); console.log('[commit]', s); lines.push(s); };
  const sl = ms => new Promise(r => setTimeout(r, ms));

  const dialogOpen = () => !!document.querySelector('.p-dialog-mask');
  const toggleSearchBox = () => app.extensionManager.command.execute('Workspace.SearchBox.Toggle');
  const canvasEl =
    document.querySelector('canvas.graph-canvas-container') ||
    document.querySelector('canvas#graph-canvas') ||
    document.querySelector('canvas');
  const cr = () => canvasEl.getBoundingClientRect();

  // ── 1. Enumerate all "placement-ish" extension commands ───────
  log('========================================');
  log('command inventory');
  log('========================================');
  const cmdMgr = app.extensionManager?.command;
  if (cmdMgr) {
    const cmds = cmdMgr.commands || cmdMgr.commandsArray || cmdMgr._commands;
    const ids = Array.isArray(cmds) ? cmds.map(c => c.id) : Object.keys(cmds || {});
    const interesting = ids.filter(id =>
      /place|drop|commit|insert|cancel|escape|accept|confirm|finish|deselect/i.test(id));
    log('placement-ish command ids:', JSON.stringify(interesting));
    // Also dump anything mentioning "node" that we might have missed
    const nodey = ids.filter(id => /node/i.test(id));
    log('node-related command ids:', JSON.stringify(nodey.slice(0, 30)));
  } else { log('no command manager'); }

  // ── 2. Quick canvas inspection ────────────────────────────────
  log('========================================');
  log('canvas state keys (interesting)');
  log('========================================');
  const interestingKeys = [
    'node_dragged', 'dragging_node', 'node_capturing_input',
    'pending_node', 'placement_node', 'selected_node', 'selected_nodes',
    'graph_mouse', 'last_mouse', 'last_mouse_position',
  ];
  for (const k of interestingKeys) {
    if (k in app.canvas) log('  ' + k + ' =', JSON.stringify(app.canvas[k]));
  }

  // ── 3. Get a node into placement mode ─────────────────────────
  log('========================================');
  log('getting KSampler into placement mode');
  log('========================================');
  // Clear graph first for a clean state
  app.graph.clear();
  app.canvas.setDirty(true, true);
  await sl(300);

  if (dialogOpen()) { await toggleSearchBox(); await sl(250); }
  await toggleSearchBox();
  await sl(300);
  if (!dialogOpen()) { log('FAIL: dialog did not open'); return finalize(); }

  const inp = document.querySelector('input[aria-controls="results-list"]');
  inp.focus();
  inp.value = '';
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  for (const ch of 'KSampler') {
    inp.value += ch;
    inp.dispatchEvent(new InputEvent('input', { bubbles: true, data: ch, inputType: 'insertText' }));
    await sl(15);
  }
  await sl(400);
  const row = document.getElementById('result-item-0');
  if (!row) { log('FAIL: no result row'); return finalize(); }
  const before = app.graph._nodes.length;
  const rr = row.getBoundingClientRect();
  const sel = { clientX: rr.left + rr.width / 2, clientY: rr.top + rr.height / 2, bubbles: true, cancelable: true };
  row.dispatchEvent(new MouseEvent('mousedown', sel));
  row.dispatchEvent(new MouseEvent('mouseup',   sel));
  row.dispatchEvent(new MouseEvent('click',     sel));
  await sl(400);
  if (app.graph._nodes.length <= before) { log('FAIL: row click did not add node'); return finalize(); }
  const node = app.graph._nodes[app.graph._nodes.length - 1];
  log('node added:', node.type, 'starting pos:', JSON.stringify(node.pos));

  // ── 4. Helper: is the node still in placement mode? ──────────
  // If wiggling the cursor changes node.pos, it's still attached.
  async function isStillTracking() {
    const r = cr();
    const startPos = [node.pos[0], node.pos[1]];
    canvasEl.dispatchEvent(new MouseEvent('mousemove', {
      clientX: r.left + 200, clientY: r.top + 200, bubbles: true, cancelable: true,
    }));
    await sl(120);
    canvasEl.dispatchEvent(new MouseEvent('mousemove', {
      clientX: r.left + 400, clientY: r.top + 400, bubbles: true, cancelable: true,
    }));
    await sl(120);
    const changed = node.pos[0] !== startPos[0] || node.pos[1] !== startPos[1];
    return changed;
  }

  log('initial placement-mode check: still tracking?', await isStillTracking());

  // ── 5. Try commit strategies in sequence ─────────────────────
  // Stop at the first one that freezes the node.
  log('========================================');
  log('commit strategy probe');
  log('========================================');

  const r = cr();
  const screen = { x: r.left + r.width / 2, y: r.top + r.height / 2 };

  const strategies = [
    {
      name: 'A: MouseEvent click on canvasEl',
      run: async () => {
        const opts = { clientX: screen.x, clientY: screen.y, bubbles: true, cancelable: true, button: 0, view: window };
        canvasEl.dispatchEvent(new MouseEvent('mousedown', opts));
        canvasEl.dispatchEvent(new MouseEvent('mouseup',   opts));
      },
    },
    {
      name: 'B: PointerEvent with explicit pointerId on canvasEl',
      run: async () => {
        const opts = { clientX: screen.x, clientY: screen.y, bubbles: true, cancelable: true,
          button: 0, buttons: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true };
        canvasEl.dispatchEvent(new PointerEvent('pointerdown', { ...opts, buttons: 1 }));
        canvasEl.dispatchEvent(new PointerEvent('pointerup',   opts));
      },
    },
    {
      name: 'C: dispatch on document.body instead of canvasEl',
      run: async () => {
        const opts = { clientX: screen.x, clientY: screen.y, bubbles: true, cancelable: true, button: 0 };
        document.body.dispatchEvent(new MouseEvent('mousedown', opts));
        document.body.dispatchEvent(new MouseEvent('mouseup',   opts));
      },
    },
    {
      name: 'D: LGraphCanvas.processMouseDown/Up',
      run: async () => {
        const ev = new MouseEvent('mousedown', { clientX: screen.x, clientY: screen.y, button: 0, bubbles: true });
        ev.canvasX = screen.x - r.left;
        ev.canvasY = screen.y - r.top;
        if (app.canvas.processMouseDown) app.canvas.processMouseDown(ev);
        await sl(60);
        const up = new MouseEvent('mouseup', { clientX: screen.x, clientY: screen.y, button: 0, bubbles: true });
        up.canvasX = screen.x - r.left;
        up.canvasY = screen.y - r.top;
        if (app.canvas.processMouseUp) app.canvas.processMouseUp(up);
      },
    },
    {
      name: 'E: keydown Enter on body',
      run: async () => {
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        document.body.dispatchEvent(new KeyboardEvent('keyup',   { key: 'Enter', bubbles: true, cancelable: true }));
      },
    },
    {
      name: 'F: keydown Escape on body',
      run: async () => {
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        document.body.dispatchEvent(new KeyboardEvent('keyup',   { key: 'Escape', bubbles: true, cancelable: true }));
      },
    },
    {
      name: 'G: app.canvas.deselectAllNodes',
      run: async () => { app.canvas.deselectAllNodes?.(); },
    },
    {
      name: 'H: null out canvas internal state flags',
      run: async () => {
        for (const k of ['node_dragged', 'dragging_node', 'node_capturing_input',
                         'pending_node', 'placement_node']) {
          if (k in app.canvas) app.canvas[k] = null;
        }
      },
    },
  ];

  let winner = null;
  for (const s of strategies) {
    log('--- trying', s.name);
    try { await s.run(); } catch (e) { log('   threw:', e.message); continue; }
    await sl(150);
    const stillTracking = await isStillTracking();
    log('   still tracking after?', stillTracking, '— pos now:', JSON.stringify(node.pos));
    if (!stillTracking) {
      winner = s.name;
      log('   ✓ this strategy froze the node');
      break;
    }
  }

  log('========================================');
  log('WINNING commit strategy:', winner || 'NONE');
  log('========================================');

  // Leave the graph as-is so user can inspect visually
  finalize();

  function finalize() {
    window.__report = lines.join('\n');
    console.log(
      '%c[commit] report at window.__report — run  copy(__report)  in the prompt',
      'color:#00ff88;font-weight:bold;'
    );
  }
})();
