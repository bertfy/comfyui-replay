// Paste AFTER the replay script finishes (so nodes + links exist).
// Draws a red dot wherever our c2s() thinks a slot is. If the dots
// don't sit dead-center on the slot circles, our coordinate
// translation is wrong and that's what the trail/wire mismatch
// is downstream of. If the dots DO sit on the slot circles but
// the wire still emerges from somewhere else, then ComfyUI is
// drawing the wire from an offset relative to the slot center.

(function probeSlotPositions() {
  document.querySelectorAll('._sp_dot').forEach(d => d.remove());

  function c2s(cx, cy) {
    const el = document.querySelector('canvas.graph-canvas-container')
            || document.querySelector('canvas#graph-canvas')
            || document.querySelector('canvas');
    const r = el.getBoundingClientRect();
    const ds = app.canvas.ds;
    return { x: (cx + ds.offset[0]) * ds.scale + r.left,
             y: (cy + ds.offset[1]) * ds.scale + r.top };
  }

  let dotted = 0;
  for (const node of app.graph._nodes) {
    const out = (node.outputs || []).length;
    const inn = (node.inputs || []).length;
    for (let s = 0; s < out; s++) {
      const p = new Float32Array(2);
      node.getConnectionPos(false, s, p);
      const sc = c2s(p[0], p[1]);
      dot(sc.x, sc.y, '#ff3b30', 'O' + s);
      dotted++;
    }
    for (let s = 0; s < inn; s++) {
      const p = new Float32Array(2);
      node.getConnectionPos(true, s, p);
      const sc = c2s(p[0], p[1]);
      dot(sc.x, sc.y, '#0a84ff', 'I' + s);
      dotted++;
    }
  }
  console.log('[slot-probe] dotted', dotted, 'slots — red=output, blue=input');
  console.log('[slot-probe] window.__clearDots() to remove');
  window.__clearDots = () => document.querySelectorAll('._sp_dot').forEach(d => d.remove());

  function dot(x, y, color, label) {
    const d = document.createElement('div');
    d.className = '_sp_dot';
    Object.assign(d.style, {
      position: 'fixed',
      left: x + 'px',
      top: y + 'px',
      width: '8px',
      height: '8px',
      borderRadius: '50%',
      background: color,
      transform: 'translate(-50%,-50%)',
      pointerEvents: 'none',
      zIndex: '999999',
      boxShadow: '0 0 0 1.5px white',
    });
    document.body.appendChild(d);
  }
})();
