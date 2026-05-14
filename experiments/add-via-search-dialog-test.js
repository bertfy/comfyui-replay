// ═══════════════════════════════════════════════════════════════
// addViaSearchDialog — canonical implementation (v4, hybrid)
// ───────────────────────────────────────────────────────────────
// Confirmed: synthetic events can drive the search dialog up to
// the preview stage, but cannot commit the placement (framework
// event-trust check). So:
//
//   - We open the real native dialog for visual authenticity.
//   - We type into the real input so the real result list renders.
//   - We DO NOT click a result row (that would enter placement
//     mode we can't escape synthetically).
//   - We press Escape to close the dialog cleanly.
//   - We create the node directly via LiteGraph.createNode +
//     app.graph.add at the exact target canvas coordinates.
//
// Same visual tutorial UX, no placement-mode trap.
//
// After running, report at window.__report. In the prompt:
//   copy(__report)
// ═══════════════════════════════════════════════════════════════

(async function test() {
  const lines = [];
  const log = (...a) => { const s = a.join(' '); console.log('[test]', s); lines.push(s); };
  const sl = ms => new Promise(r => setTimeout(r, ms));

  // ── Canonical helpers ─────────────────────────────────────────
  const dialogOpen = () => !!document.querySelector('.p-dialog-mask');
  const searchInput = () =>
    document.querySelector('input[aria-controls="results-list"]') ||
    document.querySelector('input[role="combobox"][placeholder="Add a node..."]');
  const resultRows = () => [...document.querySelectorAll('[data-testid="result-item"]')];
  const toggleSearchBox = () => app.extensionManager.command.execute('Workspace.SearchBox.Toggle');

  async function closeDialog() {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    document.body.dispatchEvent(new KeyboardEvent('keyup',   { key: 'Escape', bubbles: true, cancelable: true }));
    await sl(200);
    // Toggle fallback if Escape didn't take.
    if (dialogOpen()) { await toggleSearchBox(); await sl(200); }
  }

  // ── The function ──────────────────────────────────────────────
  // Adds a node by visually driving the real search dialog, then
  // creating the node via LiteGraph API at the requested canvas
  // coordinates. Returns the new node, or null on failure.
  async function addViaSearchDialog(nodeType, canvX, canvY) {
    // Belt-and-suspenders: any stale dialog from a prior run goes.
    if (dialogOpen()) await closeDialog();

    // 1. Open
    await toggleSearchBox();
    await sl(300);
    if (!dialogOpen()) { log('  ✗ open failed'); return null; }

    // 2. Type into the real input (visual flair, real result list)
    const inp = searchInput();
    if (inp) {
      inp.focus();
      inp.value = '';
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      await sl(50);
      for (const ch of nodeType) {
        inp.value += ch;
        inp.dispatchEvent(new InputEvent('input', { bubbles: true, data: ch, inputType: 'insertText' }));
        await sl(25);
      }
      await sl(400); // let results render
      const rowCount = resultRows().length;
      log('  · typed "' + nodeType + '" — ' + rowCount + ' result row(s) visible');
    } else {
      log('  · no input found — proceeding to API creation anyway');
    }

    // 3. Close the dialog WITHOUT row click → no placement mode
    await closeDialog();
    if (dialogOpen()) { log('  ✗ dialog did not close cleanly'); return null; }

    // 4. Create the node via LiteGraph API at the exact position
    const created = LiteGraph.createNode(nodeType);
    if (!created) { log('  ✗ LiteGraph.createNode returned null for "' + nodeType + '"'); return null; }
    created.pos = [canvX, canvY];
    app.graph.add(created);
    app.canvas.setDirty(true, true);
    await sl(150);

    log('  ✓ "' + nodeType + '" placed @ ' + JSON.stringify(created.pos));
    return created;
  }

  // ── Reset canvas view so the test nodes are visible ───────────
  log('========================================');
  log('addViaSearchDialog v4 (hybrid) — reset canvas + clear graph');
  log('========================================');
  app.graph.clear();
  app.canvas.ds.scale = 1;
  app.canvas.ds.offset[0] = 100;
  app.canvas.ds.offset[1] = 100;
  app.canvas.setDirty(true, true);
  await sl(400);
  log('canvas reset — scale=' + app.canvas.ds.scale + ' offset=' + JSON.stringify(app.canvas.ds.offset));

  // ── Test graph ────────────────────────────────────────────────
  const SPEC = [
    { type: 'LoadImage',  pos: [ 50, 100] },
    { type: 'KSampler',   pos: [400, 100] },
    { type: 'SaveImage',  pos: [800, 100] },
  ];

  const created = [];
  for (const nd of SPEC) {
    log('adding ' + nd.type);
    const node = await addViaSearchDialog(nd.type, nd.pos[0], nd.pos[1]);
    if (!node) { log('FAIL on ' + nd.type); break; }
    created.push(node);
    await sl(300);
  }

  log('----');
  log('created ' + created.length + '/' + SPEC.length + ' nodes');
  for (const n of created) log('  ' + n.type + ' @ id=' + n.id + ' pos=' + JSON.stringify(n.pos));
  log('========================================');
  log('VISUAL CHECK: three nodes should be visible across the top of the canvas.');
  log('========================================');

  window.__report = lines.join('\n');
  console.log(
    '%c[test] report at window.__report — run  copy(__report)  in the prompt',
    'color:#00ff88;font-weight:bold;'
  );
})();
