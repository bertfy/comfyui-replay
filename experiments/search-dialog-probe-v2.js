// ═══════════════════════════════════════════════════════════════
// ComfyUI Search-Dialog Probe v2 — DOM diff edition
// ───────────────────────────────────────────────────────────────
// v1's selector guesses missed ComfyCloud's Vue frontend. v2 takes
// a DOM snapshot before opening the dialog and after, then prints
// exactly what appeared. That tells us the real selectors with
// zero guessing.
//
// Usage: paste into a ComfyCloud DevTools console. It will:
//   1. Snapshot all elements currently in the DOM.
//   2. Dispatch the dblclick that we already know opens the dialog.
//   3. List every newly-added element, with tag, class, role,
//      placeholder, and a short outerHTML preview.
//   4. Type "KSampler" into whichever <input> showed up and snapshot
//      again so we can see what result elements appeared.
//   5. Press Escape to close. No nodes added or removed.
// ═══════════════════════════════════════════════════════════════

(async function probeV2() {
  const sl = ms => new Promise(r => setTimeout(r, ms));
  const log = (...a) => console.log('%c[probe-v2]', 'color:#00d4ff;font-weight:bold;', ...a);
  const warn = (...a) => console.warn('[probe-v2]', ...a);

  if (typeof app === 'undefined' || !app.canvas) {
    warn('No `app.canvas`. Are you on a ComfyUI tab?');
    return;
  }

  // ── Snapshot helper ───────────────────────────────────────────
  // Returns a Set of every Element currently in the DOM tree.
  const snapshot = () => new Set(document.querySelectorAll('*'));

  // Returns the elements present in `after` but not `before`.
  // Filtered to "interesting" ones — visible, not pure layout wrappers.
  function diff(before, after) {
    const added = [];
    for (const el of after) {
      if (before.has(el)) continue;
      added.push(el);
    }
    return added;
  }

  function describe(el) {
    const r = el.getBoundingClientRect();
    return {
      tag: el.tagName.toLowerCase(),
      class: el.className && typeof el.className === 'string'
        ? el.className.slice(0, 120)
        : '',
      id: el.id || '',
      role: el.getAttribute('role') || '',
      placeholder: el.getAttribute('placeholder') || '',
      type: el.getAttribute('type') || '',
      text: (el.textContent || '').trim().slice(0, 60),
      visible: r.width > 0 && r.height > 0,
      x: Math.round(r.left), y: Math.round(r.top),
      w: Math.round(r.width), h: Math.round(r.height),
    };
  }

  // ── Locate canvas + compute a click point ─────────────────────
  const canvasEl =
    document.querySelector('canvas.graph-canvas-container') ||
    document.querySelector('canvas#graph-canvas') ||
    document.querySelector('canvas');
  const rect = canvasEl.getBoundingClientRect();
  const sx = rect.left + rect.width / 2;
  const sy = rect.top + rect.height / 2;

  function mkEvt(type, x, y, extra = {}) {
    const e = new MouseEvent(type, {
      bubbles: true, cancelable: true,
      clientX: x, clientY: y, screenX: x, screenY: y,
      button: 0, buttons: type === 'mousedown' ? 1 : 0, ...extra,
    });
    e.canvasX = x - rect.left;
    e.canvasY = y - rect.top;
    return e;
  }

  // ── STEP 1: snapshot, then open dialog, then diff ─────────────
  log('snapshot before dblclick — element count:', document.querySelectorAll('*').length);
  const before = snapshot();

  canvasEl.dispatchEvent(mkEvt('mousedown', sx, sy));
  canvasEl.dispatchEvent(mkEvt('mouseup', sx, sy));
  canvasEl.dispatchEvent(mkEvt('click', sx, sy, { detail: 1 }));
  canvasEl.dispatchEvent(mkEvt('mousedown', sx, sy));
  canvasEl.dispatchEvent(mkEvt('mouseup', sx, sy));
  canvasEl.dispatchEvent(mkEvt('click', sx, sy, { detail: 2 }));
  canvasEl.dispatchEvent(mkEvt('dblclick', sx, sy, { detail: 2 }));
  await sl(400);

  const afterOpen = snapshot();
  const newAfterOpen = diff(before, afterOpen);
  log('after dblclick — new element count:', newAfterOpen.length);

  if (newAfterOpen.length === 0) {
    warn('No new elements appeared. Either the dialog did not open, or it was reused from existing DOM.');
    return;
  }

  // Print all <input> / <textarea> elements that appeared
  const newInputs = newAfterOpen.filter(el =>
    el.tagName === 'INPUT' || el.tagName === 'TEXTAREA'
  );
  log('🔍 NEW INPUTS that appeared:', newInputs.length);
  newInputs.forEach((el, i) => {
    console.log('  ['+i+']', describe(el), el);
  });

  // Print the dialog "root" — usually the top-most new element with a class
  const dialogRoot = newAfterOpen.find(el =>
    el.parentElement && !newAfterOpen.includes(el.parentElement) && el.className
  );
  if (dialogRoot) {
    log('📦 likely dialog ROOT:');
    console.log('  ', describe(dialogRoot), dialogRoot);
    log('   outerHTML (first 500 chars):',
      (dialogRoot.outerHTML || '').slice(0, 500));
  }

  // Useful selector fingerprints
  log('💡 selectors you can try after the dblclick:');
  newAfterOpen.slice(0, 30).forEach(el => {
    if (!el.className || typeof el.className !== 'string') return;
    const cls = el.className.split(/\s+/).filter(Boolean);
    if (cls.length) console.log('  ', el.tagName.toLowerCase() + '.' + cls.join('.').slice(0, 100));
  });

  // ── STEP 2: type into the first new input and diff again ──────
  const searchInput = newInputs[0];
  if (!searchInput) {
    warn('No new <input>/<textarea> appeared inside the new DOM — search dialog may render its input lazily.');
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return;
  }

  log('typing "KSampler" into:', searchInput);
  searchInput.focus();
  searchInput.value = '';
  searchInput.dispatchEvent(new Event('input', { bubbles: true }));
  await sl(50);
  for (const ch of 'KSampler') {
    searchInput.value += ch;
    searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    searchInput.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }));
    await sl(25);
  }
  await sl(500);

  const afterType = snapshot();
  const newAfterType = diff(afterOpen, afterType);
  log('after typing — new element count:', newAfterType.length);

  // Show options/list items
  const candidates = newAfterType.filter(el => {
    if (!el.textContent) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    // Heuristics for "this looks like a result row"
    const tag = el.tagName;
    if (tag === 'LI') return true;
    const role = el.getAttribute('role');
    if (role === 'option' || role === 'menuitem' || role === 'row') return true;
    const cls = (typeof el.className === 'string' ? el.className : '').toLowerCase();
    return /option|item|result|entry|row/.test(cls);
  });
  log('🎯 RESULT-LIKE elements after typing:', candidates.length);
  candidates.slice(0, 10).forEach((el, i) => {
    console.log('  ['+i+']', describe(el), el);
  });

  // Show parent container of the first candidate — often the listbox/ul we'll target.
  if (candidates.length) {
    let p = candidates[0].parentElement;
    while (p && p !== document.body) {
      const role = p.getAttribute('role');
      const cls = (typeof p.className === 'string' ? p.className : '').toLowerCase();
      if (role === 'listbox' || /listbox|results|list|options|dropdown/.test(cls)) {
        log('📂 result CONTAINER:', describe(p), p);
        break;
      }
      p = p.parentElement;
    }
  }

  // Cleanup — close dialog
  document.body.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Escape', bubbles: true, cancelable: true,
  }));
  searchInput.blur?.();
  log('done — dialog closed, no nodes added.');
})();
