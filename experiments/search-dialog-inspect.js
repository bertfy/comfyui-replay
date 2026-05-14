// ═══════════════════════════════════════════════════════════════
// ComfyUI Search-Dialog Inspector — manual-trigger edition
// ───────────────────────────────────────────────────────────────
// We stop guessing whether synthetic events open the dialog and
// stop guessing whether the dialog is newly-mounted or just toggled
// visible. You open it the normal way (real dblclick), this script
// snapshots the DOM diff — both new elements AND elements that
// went from invisible → visible.
//
// Usage:
//   1. Paste this whole file into ComfyCloud DevTools console.
//      It snapshots and exposes window.__inspect().
//   2. Manually double-click on the canvas to open the search box.
//      (Do nothing else — do not type yet.)
//   3. Run: __inspect()
//      It logs the dialog's actual DOM: inputs, list items, classes.
//   4. (Optional) Type a node name yourself, then run: __inspect()
//      again to see the result-row elements.
// ═══════════════════════════════════════════════════════════════

(function setupInspector() {
  const all = document.querySelectorAll('*');
  const snap = new Map();
  for (const el of all) {
    const r = el.getBoundingClientRect();
    const visible = r.width > 0 && r.height > 0;
    snap.set(el, { visible, w: r.width, h: r.height });
  }
  window.__inspectSnap = snap;
  console.log('%c[inspect] snapshot taken — ' + snap.size + ' elements recorded.',
    'color:#00d4ff;font-weight:bold;');
  console.log('%c[inspect] now manually double-click on the canvas to open the search dialog,' +
    ' then run: __inspect()', 'color:#fcd34d;');

  function describe(el) {
    const r = el.getBoundingClientRect();
    return {
      tag: el.tagName.toLowerCase(),
      class: typeof el.className === 'string' ? el.className.slice(0, 140) : '',
      id: el.id || '',
      role: el.getAttribute('role') || '',
      placeholder: el.getAttribute('placeholder') || '',
      type: el.getAttribute('type') || '',
      ariaLabel: el.getAttribute('aria-label') || '',
      text: (el.textContent || '').trim().slice(0, 60),
      x: Math.round(r.left), y: Math.round(r.top),
      w: Math.round(r.width), h: Math.round(r.height),
    };
  }

  window.__inspect = function inspect() {
    const snap = window.__inspectSnap;
    if (!snap) { console.warn('No snapshot — re-paste the file first.'); return; }
    const newlyAdded = [];
    const newlyVisible = [];
    for (const el of document.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      const visible = r.width > 0 && r.height > 0;
      const prev = snap.get(el);
      if (!prev) { if (visible) newlyAdded.push(el); }
      else if (visible && !prev.visible) newlyVisible.push(el);
    }
    console.log('%c[inspect] newly ADDED visible elements: ' + newlyAdded.length,
      'color:#00ff88;font-weight:bold;');
    console.log('%c[inspect] newly VISIBLE (was hidden) elements: ' + newlyVisible.length,
      'color:#00ff88;font-weight:bold;');

    const all = [...newlyAdded, ...newlyVisible];
    if (!all.length) {
      console.warn('Nothing changed visibility. Either the dialog is not open, or it lives entirely off-DOM and renders via a portal we missed.');
      return;
    }

    // INPUTS
    const inputs = all.filter(el => el.tagName === 'INPUT' || el.tagName === 'TEXTAREA');
    console.log('%c🔍 INPUTS (' + inputs.length + '):', 'color:#00d4ff;font-weight:bold;');
    inputs.forEach((el, i) => console.log('  [' + i + ']', describe(el), el));

    // LIKELY RESULT ROWS
    const rows = all.filter(el => {
      if (!el.textContent || !el.textContent.trim()) return false;
      const tag = el.tagName;
      if (tag === 'LI') return true;
      const role = el.getAttribute('role');
      if (role === 'option' || role === 'menuitem' || role === 'row') return true;
      const cls = (typeof el.className === 'string' ? el.className : '').toLowerCase();
      return /option|item|result|entry|row|node-/.test(cls);
    });
    console.log('%c🎯 RESULT-LIKE rows (' + rows.length + '):', 'color:#00d4ff;font-weight:bold;');
    rows.slice(0, 12).forEach((el, i) => console.log('  [' + i + ']', describe(el), el));

    // DIALOG ROOT (top-most newly-visible element with a class)
    const root = all.find(el =>
      typeof el.className === 'string' &&
      el.className &&
      el.parentElement && !all.includes(el.parentElement)
    );
    if (root) {
      console.log('%c📦 likely dialog ROOT:', 'color:#00d4ff;font-weight:bold;',
        describe(root), root);
      console.log('   outerHTML preview:',
        (root.outerHTML || '').slice(0, 600));
    }

    // CONCRETE SELECTORS — print one CSS selector per noteworthy element
    console.log('%c💡 selectors you can copy:', 'color:#a78bfa;font-weight:bold;');
    function selectorFor(el) {
      const parts = [];
      let cur = el;
      while (cur && cur !== document.body && parts.length < 4) {
        let p = cur.tagName.toLowerCase();
        if (cur.id) { p += '#' + cur.id; parts.unshift(p); break; }
        if (typeof cur.className === 'string' && cur.className.trim()) {
          const cls = cur.className.trim().split(/\s+/).slice(0, 3).join('.');
          p += '.' + cls;
        }
        parts.unshift(p);
        cur = cur.parentElement;
      }
      return parts.join(' > ');
    }
    inputs.forEach(el => console.log('  input :', selectorFor(el)));
    rows.slice(0, 5).forEach(el => console.log('  row   :', selectorFor(el)));
    if (root) console.log('  root  :', selectorFor(root));
  };
})();
