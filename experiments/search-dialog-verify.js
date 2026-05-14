// ═══════════════════════════════════════════════════════════════
// ComfyUI Search-Dialog Verifier — uses the discovered command
// ───────────────────────────────────────────────────────────────
// Previous probe found that the open trigger is the
// "Workspace.SearchBox.Toggle" extension command. This probe runs
// the full flow against it and reports.
//
// After running, the plain-text report is stashed at:
//   window.__report
// In the DevTools prompt, run:  copy(__report)
// (DevTools "copy" only works from the interactive prompt, not
// from inside a pasted script.)
// ═══════════════════════════════════════════════════════════════

(async function verify() {
  const lines = [];
  const log = (...a) => { const s = a.join(' '); console.log('[verify]', s); lines.push(s); };
  const sl = ms => new Promise(r => setTimeout(r, ms));

  const dialogOpen = () => !!document.querySelector('.p-dialog-mask');
  const searchInput = () =>
    document.querySelector('input[aria-controls="results-list"]') ||
    document.querySelector('input[role="combobox"][placeholder="Add a node..."]');
  const resultRows = () => document.querySelectorAll('[data-testid="result-item"]');

  async function toggle() {
    await app.extensionManager.command.execute('Workspace.SearchBox.Toggle');
    await sl(300);
  }

  // ── Ensure starting state is closed ──────────────────────────
  if (dialogOpen()) { log('dialog already open at start — toggling closed'); await toggle(); }

  // ── 1. Open ──────────────────────────────────────────────────
  log('calling Workspace.SearchBox.Toggle to OPEN');
  await toggle();
  log('dialog open?', dialogOpen());
  if (!dialogOpen()) { log('FAIL: command did not open the dialog'); finalize(); return; }

  // ── 2. Type ──────────────────────────────────────────────────
  const inp = searchInput();
  if (!inp) { log('FAIL: search input not found after open'); finalize(); return; }
  log('search input found — typing "KSampler"');
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
  log('result rows after typing:', rows.length);
  if (rows.length) log('first row text:', (rows[0].textContent || '').trim().slice(0, 100));
  if (!rows.length) { log('FAIL: no result rows rendered'); finalize(); return; }

  // ── 3. Select result-item-0 ──────────────────────────────────
  const before = app.graph._nodes.length;
  const target = document.getElementById('result-item-0') || rows[0];
  const r = target.getBoundingClientRect();
  const clickAt = { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, cancelable: true };
  log('dispatching click on result-item-0');
  target.dispatchEvent(new PointerEvent('pointerdown', clickAt));
  target.dispatchEvent(new MouseEvent('mousedown',   clickAt));
  target.dispatchEvent(new PointerEvent('pointerup', clickAt));
  target.dispatchEvent(new MouseEvent('mouseup',     clickAt));
  target.dispatchEvent(new MouseEvent('click',       clickAt));
  await sl(400);

  let added = app.graph._nodes.length > before;
  log('node added by click?', added);
  if (!added) {
    log('falling back to Enter on input');
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    inp.dispatchEvent(new KeyboardEvent('keyup',   { key: 'Enter', bubbles: true }));
    await sl(400);
    added = app.graph._nodes.length > before;
    log('node added by Enter?', added);
  }

  if (added) {
    const n = app.graph._nodes[app.graph._nodes.length - 1];
    log('SUCCESS — added node type:', n.type, 'pos:', JSON.stringify(n.pos));
    log('removing test node and closing dialog');
    app.graph.remove(n);
    app.canvas.setDirty(true, true);
  } else {
    log('FAIL: selection did not add a node');
  }

  // ── 4. Close ─────────────────────────────────────────────────
  if (dialogOpen()) await toggle();
  log('dialog open at end?', dialogOpen());

  finalize();

  function finalize() {
    const report = lines.join('\n');
    window.__report = report;
    console.log(
      '%c[verify] report stored at window.__report — run  copy(__report)  in the prompt to copy it',
      'color:#00ff88;font-weight:bold;'
    );
  }
})();
