// ═══════════════════════════════════════════════════════════════
// ComfyCloud Combo Widget Synthetic-Click Probe
// ───────────────────────────────────────────────────────────────
// Vue-rendered nodes expose combo widgets as PrimeVue Select
// components — DOM elements with role="combobox" and a listbox
// overlay with role="option" rows. This probe tests whether we
// can:
//   1. Open the dropdown by dispatching a click on the combo span
//   2. Select an option by dispatching a click on a <li role=option>
//   3. See widget.value update + the dropdown close
//
// Targets the aspect_ratio combo on the Nano Banana 2 node (node
// id 2). Tries to flip it from current value to "1:1". Reports
// what happened at each step.
//
// Report at window.__report — copy(__report) in the prompt.
// ═══════════════════════════════════════════════════════════════

(async function comboProbe() {
  const lines = [];
  const log = (...a) => { const s = a.join(' '); console.log('[combo-probe]', s); lines.push(s); };
  const sl = ms => new Promise(r => setTimeout(r, ms));

  // ── Find the target node ──────────────────────────────────────
  const nodeEl = document.querySelector('[data-node-id="2"]');
  if (!nodeEl) {
    log('FAIL: no DOM element with data-node-id=2 — is the Gemini node placed?');
    return finalize();
  }
  log('found DOM node:',
    nodeEl.querySelector('[data-testid="node-title"]')?.textContent?.trim() || '?');

  // ── Inventory all combo widgets on the node ───────────────────
  const combos = [...nodeEl.querySelectorAll('[role="combobox"]')];
  log('combos on node: ' + combos.length);
  combos.forEach((c, i) => {
    log('  [' + i + '] aria-label="' + c.getAttribute('aria-label')
      + '" current-value="' + c.textContent.trim() + '"'
      + ' aria-expanded=' + c.getAttribute('aria-expanded'));
  });

  // ── Target aspect_ratio specifically ──────────────────────────
  const target = combos.find(c => c.getAttribute('aria-label') === 'model.aspect_ratio');
  if (!target) {
    log('FAIL: no aspect_ratio combo found by aria-label');
    return finalize();
  }
  const beforeText = target.textContent.trim();
  log('========================================');
  log('targeting aspect_ratio combo · before-value="' + beforeText + '"');

  // ── Step 1: open the dropdown via synthetic click ────────────
  const rect = target.getBoundingClientRect();
  const center = { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
  const evtOpts = { ...center, bubbles: true, cancelable: true, button: 0, view: window };
  log('dispatching pointerdown/pointerup/click on the combo span...');
  target.dispatchEvent(new PointerEvent('pointerdown', { ...evtOpts, buttons: 1, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
  target.dispatchEvent(new MouseEvent('mousedown', evtOpts));
  target.dispatchEvent(new PointerEvent('pointerup',   { ...evtOpts, buttons: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
  target.dispatchEvent(new MouseEvent('mouseup', evtOpts));
  target.dispatchEvent(new MouseEvent('click', evtOpts));
  await sl(300);

  const overlay = document.querySelector('.p-select-overlay');
  log('dropdown overlay present? ' + !!overlay);
  log('combo aria-expanded after click: ' + target.getAttribute('aria-expanded'));

  if (!overlay) {
    log('FAIL: dropdown did not open — synthetic click on combo span was ignored');
    return finalize();
  }

  // ── Inspect the options ──────────────────────────────────────
  const options = [...overlay.querySelectorAll('[role="option"]')];
  log('options in dropdown: ' + options.length);
  options.slice(0, 16).forEach((o, i) => {
    log('  [' + i + '] aria-label="' + o.getAttribute('aria-label')
      + '" aria-selected=' + o.getAttribute('aria-selected'));
  });

  // ── Step 2: click "1:1" option synthetically ─────────────────
  const desired = beforeText === '1:1' ? '4:3' : '1:1';
  const optionEl = options.find(o => o.getAttribute('aria-label') === desired);
  if (!optionEl) {
    log('FAIL: no option found with aria-label="' + desired + '"');
    // close dialog to clean up
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    return finalize();
  }
  log('dispatching click on option aria-label="' + desired + '"...');
  const optRect = optionEl.getBoundingClientRect();
  const optCenter = { clientX: optRect.left + optRect.width / 2, clientY: optRect.top + optRect.height / 2 };
  const optEvt = { ...optCenter, bubbles: true, cancelable: true, button: 0, view: window };
  optionEl.dispatchEvent(new PointerEvent('pointerdown', { ...optEvt, buttons: 1, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
  optionEl.dispatchEvent(new MouseEvent('mousedown', optEvt));
  optionEl.dispatchEvent(new PointerEvent('pointerup',   { ...optEvt, buttons: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
  optionEl.dispatchEvent(new MouseEvent('mouseup', optEvt));
  optionEl.dispatchEvent(new MouseEvent('click', optEvt));
  await sl(400);

  // ── Step 3: verify what happened ─────────────────────────────
  log('========================================');
  log('after option click:');
  log('  dropdown still open? ' + !!document.querySelector('.p-select-overlay'));
  log('  combo aria-expanded:  ' + target.getAttribute('aria-expanded'));
  log('  combo visible text:   "' + target.textContent.trim() + '"');

  // Data-layer verification
  const dataNode = app.graph._nodes.find(n => n.id === 2);
  if (dataNode) {
    const widget = (dataNode.widgets || []).find(w => w.name === 'model.aspect_ratio');
    log('  widget.value (data): "' + (widget ? widget.value : 'widget-not-found') + '"');
  }

  log('========================================');
  log('expected: dropdown closed, combo text = "' + desired + '", widget.value = "' + desired + '"');

  function finalize() {
    window.__report = lines.join('\n');
    console.log('%c[combo-probe] report at window.__report — run  copy(__report)  in the prompt',
      'color:#00ff88;font-weight:bold;');
  }
  finalize();
})();
