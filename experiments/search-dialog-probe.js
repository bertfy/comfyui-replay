// ═══════════════════════════════════════════════════════════════
// ComfyUI Native Search-Dialog Probe
// ───────────────────────────────────────────────────────────────
// PURPOSE
//   Diagnostic for the synthetic-event flow that will replace
//   addViaMenu / addViaPanel. Paste into a live ComfyUI tab's
//   DevTools console. It will:
//     1. Try several methods to OPEN the native search dialog
//        at a canvas point and log which method worked.
//     2. Probe the DOM for the search INPUT and the RESULT LIST
//        and log which selectors actually match in this version.
//     3. Type a hardcoded node type, select the first matching
//        result, and verify a node was added to app.graph.
//     4. Report final node position vs requested canvas coords.
//     5. Clean up after itself.
//
// USAGE
//   Paste the whole file. By default it adds a KSampler near the
//   middle of the visible canvas. To probe a different node:
//     window.__probeConfig = { nodeType: 'CLIPTextEncode' };
//   then paste again.
//
// What we are looking for (please report back):
//   - Which "open" method worked (A/B/C/D/E)
//   - Which input/result selectors matched
//   - Whether the new node landed at our requested canvas coords
//   - Any edge cases: dialog already open, no results, custom node
//     namespacing (e.g. "Some/Pack/Node"), fuzzy matches, etc.
// ═══════════════════════════════════════════════════════════════

(async function probeSearchDialog() {
  const cfg = Object.assign({
    nodeType: 'KSampler',
    canvasX: null,   // null = center of visible canvas
    canvasY: null,
    log: true,
  }, window.__probeConfig || {});

  const sl = ms => new Promise(r => setTimeout(r, ms));
  const log = (...a) => cfg.log && console.log('%c[probe]', 'color:#00d4ff;font-weight:bold;', ...a);
  const warn = (...a) => console.warn('[probe]', ...a);

  // ── 0. Sanity ─────────────────────────────────────────────────
  if (typeof app === 'undefined' || !app.canvas || !app.graph) {
    warn('No `app.canvas` / `app.graph` found. Are you on a ComfyUI tab?');
    return;
  }

  // ── 1. Compute target canvas coords & matching screen coords ──
  const canvasEl =
    document.querySelector('canvas.graph-canvas-container') ||
    document.querySelector('canvas#graph-canvas') ||
    document.querySelector('canvas');
  if (!canvasEl) { warn('No canvas element found.'); return; }
  const rect = canvasEl.getBoundingClientRect();
  const ds = app.canvas.ds;

  // Default: pick a canvas point that maps to the visible center
  const centerCanvX = (rect.width / 2) / ds.scale - ds.offset[0];
  const centerCanvY = (rect.height / 2) / ds.scale - ds.offset[1];
  const canvX = cfg.canvasX ?? centerCanvX;
  const canvY = cfg.canvasY ?? centerCanvY;
  const screenX = (canvX + ds.offset[0]) * ds.scale + rect.left;
  const screenY = (canvY + ds.offset[1]) * ds.scale + rect.top;

  log('target canvas coords:', { canvX, canvY });
  log('target screen coords:', { screenX, screenY });

  // ── 2. Try to OPEN the search dialog ──────────────────────────
  // We test the methods in order of "most native to ComfyUI" and
  // log which one actually opened the dialog. The probe stops at
  // the first method that succeeds so we know our preferred path.
  function dialogIsOpen() {
    // Cast a wide net — we narrow it in the next section.
    return !!document.querySelector(
      '.p-dialog, .litegraph-search, .litegraph .dialog, ' +
      '.comfy-modal, .node-search-box, dialog[open], ' +
      '[class*="search"][class*="dialog"], [class*="search"][class*="box"]'
    );
  }

  function mkEvt(type, x, y, extra = {}) {
    const e = new MouseEvent(type, {
      bubbles: true, cancelable: true,
      clientX: x, clientY: y,
      screenX: x, screenY: y,
      button: 0, buttons: type === 'mousedown' ? 1 : 0,
      ...extra,
    });
    e.canvasX = x - rect.left;
    e.canvasY = y - rect.top;
    return e;
  }

  let openedBy = null;

  // --- Method A: dispatch dblclick on the canvas ---------------
  log('A: trying canvas dblclick...');
  canvasEl.dispatchEvent(mkEvt('mousedown', screenX, screenY));
  canvasEl.dispatchEvent(mkEvt('mouseup', screenX, screenY));
  canvasEl.dispatchEvent(mkEvt('click', screenX, screenY, { detail: 1 }));
  canvasEl.dispatchEvent(mkEvt('mousedown', screenX, screenY));
  canvasEl.dispatchEvent(mkEvt('mouseup', screenX, screenY));
  canvasEl.dispatchEvent(mkEvt('click', screenX, screenY, { detail: 2 }));
  canvasEl.dispatchEvent(mkEvt('dblclick', screenX, screenY, { detail: 2 }));
  await sl(250);
  if (dialogIsOpen()) openedBy = 'A: synthetic dblclick on canvas';

  // --- Method B: app.canvas.showSearchBox (LiteGraph API) ------
  if (!openedBy && typeof app.canvas.showSearchBox === 'function') {
    log('B: trying app.canvas.showSearchBox(event)...');
    try {
      const e = mkEvt('dblclick', screenX, screenY, { detail: 2 });
      app.canvas.showSearchBox(e);
      await sl(250);
      if (dialogIsOpen()) openedBy = 'B: app.canvas.showSearchBox';
    } catch (err) { warn('B failed:', err.message); }
  }

  // --- Method C: Vue frontend command -------------------------
  if (!openedBy && app.extensionManager?.command?.execute) {
    const candidates = [
      'Comfy.NodeSearchBoxOpen',
      'Comfy.Canvas.OpenSearchBox',
      'Workspace.OpenSearch',
    ];
    for (const cmd of candidates) {
      log('C: trying command', cmd);
      try {
        await app.extensionManager.command.execute(cmd);
        await sl(250);
        if (dialogIsOpen()) { openedBy = 'C: command ' + cmd; break; }
      } catch (err) { /* command may not exist; keep trying */ }
    }
  }

  // --- Method D: keyboard shortcut (some versions bind "f") ---
  if (!openedBy) {
    log('D: trying keyboard shortcut "f"...');
    canvasEl.focus?.();
    document.body.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'f', code: 'KeyF', bubbles: true, cancelable: true,
    }));
    await sl(250);
    if (dialogIsOpen()) openedBy = 'D: keydown f';
  }

  // --- Method E: LiteGraph.ContextMenu fallback (last resort) -
  if (!openedBy && typeof LiteGraph !== 'undefined' && LiteGraph.ContextMenu) {
    log('E: trying LiteGraph.ContextMenu with showSearchBox...');
    try {
      const e = mkEvt('contextmenu', screenX, screenY);
      app.canvas.showSearchBox?.(e);
      await sl(250);
      if (dialogIsOpen()) openedBy = 'E: LiteGraph fallback';
    } catch (err) { warn('E failed:', err.message); }
  }

  if (!openedBy) {
    warn('❌ Could not open search dialog by any method. dialogIsOpen() === false');
    warn('   Please screenshot the current DOM and tell us what happened.');
    return;
  }
  log('✅ dialog opened via', openedBy);

  // ── 3. Probe for the SEARCH INPUT ─────────────────────────────
  // Try a wide list of selectors and log which ones currently match.
  const inputSelectors = [
    'input.comfy-vue-node-search-box-input',                  // Vue frontend
    '.comfy-vue-node-search-container input',
    '.p-dialog input[type="text"]',
    '.p-dialog input',
    '.node-search-box input',
    '.litegraph-search input',
    '.litegraph .dialog input',
    'dialog input[type="text"]',
    '.comfy-modal input',
    'input[placeholder*="Search" i]',
    'input.search',
    '.litecontextmenu input',
  ];
  const inputMatches = [];
  for (const sel of inputSelectors) {
    const els = document.querySelectorAll(sel);
    if (els.length) inputMatches.push({ selector: sel, count: els.length });
  }
  log('input selector matches:', inputMatches);
  const searchInput =
    document.querySelector(inputSelectors.find(s =>
      document.querySelector(s)
    ) || 'input');
  if (!searchInput) { warn('❌ No search input found.'); return; }
  log('using search input:', searchInput);

  // ── 4. Type the node type ─────────────────────────────────────
  searchInput.focus();
  searchInput.value = '';
  searchInput.dispatchEvent(new Event('input', { bubbles: true }));
  await sl(50);
  for (let i = 0; i < cfg.nodeType.length; i++) {
    searchInput.value = cfg.nodeType.slice(0, i + 1);
    searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    searchInput.dispatchEvent(new KeyboardEvent('keydown', {
      key: cfg.nodeType[i], bubbles: true,
    }));
    await sl(20);
  }
  await sl(400); // let results render
  log('typed:', cfg.nodeType);

  // ── 5. Probe for the RESULT LIST ──────────────────────────────
  const resultSelectors = [
    '.comfy-vue-node-search-container li',
    '.comfy-vue-node-search-container [role="option"]',
    '.p-dialog [role="option"]',
    '.p-dialog .p-listbox-item',
    '.node-search-results .item',
    '.litegraph .dialog .helper-list .item',
    '.litegraph-search .helper .item',
    'dialog .result-item',
    '.comfy-modal .result',
    '.litecontextmenu .litemenu-entry',
    '[class*="result"] [class*="item"]',
  ];
  const resultMatches = [];
  for (const sel of resultSelectors) {
    const els = document.querySelectorAll(sel);
    if (els.length) resultMatches.push({ selector: sel, count: els.length, firstText: els[0].textContent?.trim().slice(0, 80) });
  }
  log('result selector matches:', resultMatches);

  // Pick the first selector that has results.
  let results = [];
  let resultSelector = null;
  for (const sel of resultSelectors) {
    const els = [...document.querySelectorAll(sel)];
    if (els.length) { results = els; resultSelector = sel; break; }
  }
  if (!results.length) { warn('❌ No results matched any selector after typing.'); return; }
  log('using result selector:', resultSelector, '— count:', results.length);

  // ── 6. Find an exact or best match ────────────────────────────
  const norm = s => (s || '').trim().toLowerCase();
  const target = norm(cfg.nodeType);
  let match = results.find(r => norm(r.textContent) === target);
  if (!match) match = results.find(r => norm(r.textContent).split('/').pop() === target);
  if (!match) match = results.find(r => norm(r.textContent).includes(target));
  if (!match) match = results[0];
  log('chose result:', match.textContent?.trim());

  // ── 7. Activate the chosen result ─────────────────────────────
  const before = app.graph._nodes.length;
  // Vue listbox items often respond to click; some need pointerup/Enter.
  const r = match.getBoundingClientRect();
  const opts = { bubbles: true, cancelable: true, clientX: r.left + 5, clientY: r.top + 5, button: 0 };
  match.dispatchEvent(new PointerEvent('pointerdown', opts));
  match.dispatchEvent(new MouseEvent('mousedown', opts));
  match.dispatchEvent(new PointerEvent('pointerup', opts));
  match.dispatchEvent(new MouseEvent('mouseup', opts));
  match.dispatchEvent(new MouseEvent('click', opts));
  match.click?.();
  await sl(400);

  // Fallback: press Enter on the input (selects first/highlighted result)
  if (app.graph._nodes.length === before) {
    log('click did not add a node — trying Enter on input');
    searchInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    searchInput.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
    await sl(400);
  }

  // ── 8. Verify and report ──────────────────────────────────────
  const added = app.graph._nodes.length > before;
  if (!added) {
    warn('❌ No node was added. Dialog interaction failed downstream of selection.');
    return;
  }
  const newNode = app.graph._nodes[app.graph._nodes.length - 1];
  log('✅ added node:', { id: newNode.id, type: newNode.type, pos: [...newNode.pos] });
  log('   requested canvas pos:', { canvX, canvY });
  log('   delta:', { dx: newNode.pos[0] - canvX, dy: newNode.pos[1] - canvY });

  // ── 9. Clean up: remove the test node + close any open dialog ─
  await sl(500);
  app.graph.remove(newNode);
  app.canvas.setDirty(true, true);
  document.body.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Escape', bubbles: true,
  }));
  log('cleanup complete — test node removed, dialog closed.');

  // ── 10. Summary line for easy copy-paste back ─────────────────
  console.log(
    '%c[probe summary]\n' +
    'opened-by: ' + openedBy + '\n' +
    'input-selector: ' + (inputMatches[0]?.selector || '?') + '\n' +
    'result-selector: ' + resultSelector + '\n' +
    'positioning: ' + (Math.abs(newNode.pos[0] - canvX) < 50 && Math.abs(newNode.pos[1] - canvY) < 50
      ? 'matches request' : 'does NOT match request — node landed at ' + newNode.pos),
    'color:#00ff88;font-weight:bold;font-family:monospace;'
  );
})();
