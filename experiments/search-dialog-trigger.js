// ═══════════════════════════════════════════════════════════════
// ComfyUI Search-Dialog Trigger Probe — end-to-end
// ───────────────────────────────────────────────────────────────
// Builds on the inspector's findings. We now KNOW the dialog's
// DOM:
//   input  : input[aria-controls="results-list"]
//   rows   : [data-testid="result-item"]
//   root   : .p-dialog-mask
//
// What we still need to know: which programmatic action OPENS the
// dialog? (real user dblclick works; synthetic dblclick did not.)
//
// This probe tries open methods one at a time. For each that
// succeeds, it runs the full flow: type "KSampler", select
// first result, verify a node was added, remove the test node,
// close the dialog. Whichever method gets to the end wins.
//
// All console noise is also written to a plain-text report that
// is `copy()`'d to your clipboard automatically. Just paste it
// back into chat.
// ═══════════════════════════════════════════════════════════════

(async function trigger() {
  const lines = [];
  const log = (...a) => { const s = a.join(' '); console.log('[trigger]', s); lines.push(s); };

  const sl = ms => new Promise(r => setTimeout(r, ms));

  // ── Setup ─────────────────────────────────────────────────────
  if (typeof app === 'undefined' || !app.canvas) { log('no app.canvas'); return; }
  const canvasEl =
    document.querySelector('canvas.graph-canvas-container') ||
    document.querySelector('canvas#graph-canvas') ||
    document.querySelector('canvas');
  const rect = canvasEl.getBoundingClientRect();
  const sx = rect.left + rect.width / 2;
  const sy = rect.top + rect.height / 2;

  const dialogOpen = () => !!document.querySelector('.p-dialog-mask');
  const searchInput = () =>
    document.querySelector('input[aria-controls="results-list"]') ||
    document.querySelector('input[role="combobox"][placeholder="Add a node..."]') ||
    document.querySelector('.p-dialog-mask input[type="text"]');
  const resultRows = () =>
    document.querySelectorAll('[data-testid="result-item"]');

  async function closeDialog() {
    // Pressing Escape on body closes the PrimeVue dialog reliably
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    document.body.dispatchEvent(new KeyboardEvent('keyup',   { key: 'Escape', bubbles: true, cancelable: true }));
    await sl(200);
    // Also try clicking the mask
    if (dialogOpen()) {
      const mask = document.querySelector('.p-dialog-mask');
      const r = mask.getBoundingClientRect();
      mask.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: r.left + 5, clientY: r.top + 5 }));
      mask.dispatchEvent(new MouseEvent('mouseup',   { bubbles: true, clientX: r.left + 5, clientY: r.top + 5 }));
      await sl(150);
    }
  }

  // Inventory what we can reach
  log('========================================');
  log('environment inventory');
  log('========================================');
  log('app.canvas exists:', !!app.canvas);
  log('app.canvas.showSearchBox:', typeof app.canvas?.showSearchBox);
  log('app.extensionManager:', !!app.extensionManager);
  log('app.extensionManager.command:', !!app.extensionManager?.command);
  if (app.extensionManager?.command) {
    const cmds = app.extensionManager.command.commands ||
                 app.extensionManager.command.commandsArray ||
                 app.extensionManager.command._commands;
    if (cmds) {
      const ids = Array.isArray(cmds) ? cmds.map(c => c.id) : Object.keys(cmds);
      const searchy = ids.filter(id => /search|node[-_ ]?box|add[-_ ]?node|quick/i.test(id));
      log('search-related command ids:', JSON.stringify(searchy));
    } else {
      log('command list shape unknown — keys:', Object.keys(app.extensionManager.command).slice(0, 20));
    }
  }
  log('window.LiteGraph:', typeof LiteGraph);
  log('current dialog open?', dialogOpen());

  if (dialogOpen()) { log('dialog already open — closing first'); await closeDialog(); }

  // ── Open-method candidates ────────────────────────────────────
  const methods = [
    {
      name: 'A: PointerEvent dblclick on canvas',
      run: async () => {
        const opts = { bubbles: true, cancelable: true, clientX: sx, clientY: sy, pointerType: 'mouse', isPrimary: true, button: 0 };
        canvasEl.dispatchEvent(new PointerEvent('pointerdown', opts));
        canvasEl.dispatchEvent(new PointerEvent('pointerup',   opts));
        canvasEl.dispatchEvent(new PointerEvent('pointerdown', opts));
        canvasEl.dispatchEvent(new PointerEvent('pointerup',   opts));
        canvasEl.dispatchEvent(new MouseEvent('dblclick', { ...opts, detail: 2 }));
      },
    },
    {
      name: 'B: app.canvas.showSearchBox(synthetic event)',
      run: async () => {
        const e = new MouseEvent('dblclick', { clientX: sx, clientY: sy, detail: 2 });
        e.canvasX = sx - rect.left;
        e.canvasY = sy - rect.top;
        app.canvas.showSearchBox?.(e);
      },
    },
    {
      name: 'C: keydown "f" on document.body',
      run: async () => {
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', code: 'KeyF', bubbles: true, cancelable: true }));
      },
    },
    {
      name: 'D: keydown space on document.body',
      run: async () => {
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: ' ',  code: 'Space', bubbles: true, cancelable: true }));
      },
    },
    {
      name: 'E: extensionManager command Comfy.Canvas.OpenSearchBox',
      run: async () => {
        await app.extensionManager?.command?.execute?.('Comfy.Canvas.OpenSearchBox');
      },
    },
    {
      name: 'F: extensionManager command Workspace.NodeLibrary.SearchBoxOpen',
      run: async () => {
        await app.extensionManager?.command?.execute?.('Workspace.NodeLibrary.SearchBoxOpen');
      },
    },
  ];

  // ── Run each method; if it opens the dialog, complete the full flow ──
  let winner = null;
  for (const m of methods) {
    if (dialogOpen()) await closeDialog();
    log('--- trying', m.name);
    try { await m.run(); } catch (err) { log('   threw:', err.message); continue; }
    await sl(450);
    const opened = dialogOpen();
    log('   dialog open?', opened);
    if (!opened) continue;

    // Type the node name
    const inp = searchInput();
    if (!inp) { log('   no search input found — aborting this method'); await closeDialog(); continue; }
    log('   search input visible — typing KSampler');
    inp.focus();
    inp.value = '';
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    await sl(50);
    for (const ch of 'KSampler') {
      inp.value += ch;
      inp.dispatchEvent(new InputEvent('input', { bubbles: true, data: ch, inputType: 'insertText' }));
      await sl(20);
    }
    await sl(500);

    const rows = resultRows();
    log('   result rows visible:', rows.length);
    if (rows.length) {
      // Log the first result's text
      log('   first result text:', (rows[0].textContent || '').trim().slice(0, 80));
    }
    if (!rows.length) { await closeDialog(); continue; }

    // Click result-item-0
    const before = app.graph._nodes.length;
    const target = document.getElementById('result-item-0') || rows[0];
    const r = target.getBoundingClientRect();
    const clickAt = { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, cancelable: true };
    target.dispatchEvent(new PointerEvent('pointerdown', clickAt));
    target.dispatchEvent(new MouseEvent('mousedown',   clickAt));
    target.dispatchEvent(new PointerEvent('pointerup', clickAt));
    target.dispatchEvent(new MouseEvent('mouseup',     clickAt));
    target.dispatchEvent(new MouseEvent('click',       clickAt));
    await sl(400);

    const added = app.graph._nodes.length > before;
    log('   node added by click?', added);
    if (!added) {
      log('   click did not add node — trying Enter');
      inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      inp.dispatchEvent(new KeyboardEvent('keyup',   { key: 'Enter', bubbles: true }));
      await sl(400);
    }

    const finallyAdded = app.graph._nodes.length > before;
    log('   final node added?', finallyAdded);
    if (finallyAdded) {
      const n = app.graph._nodes[app.graph._nodes.length - 1];
      log('   added type:', n.type, 'pos:', JSON.stringify(n.pos));
      // Cleanup: remove the test node + close dialog
      app.graph.remove(n);
      app.canvas.setDirty(true, true);
      winner = m.name;
      await closeDialog();
      break;
    }
    await closeDialog();
  }

  log('========================================');
  log('RESULT — winning open method:', winner || 'NONE');
  log('========================================');

  // ── Build a clean text report and copy to clipboard ───────────
  const report = lines.join('\n');
  try {
    if (typeof copy === 'function') { copy(report); console.log('%c[trigger] report copied to clipboard — paste back in chat',
      'color:#00ff88;font-weight:bold;'); }
    else { await navigator.clipboard.writeText(report); console.log('%c[trigger] report copied to clipboard',
      'color:#00ff88;font-weight:bold;'); }
  } catch (e) {
    console.warn('[trigger] could not auto-copy — select the lines above manually');
  }
})();
