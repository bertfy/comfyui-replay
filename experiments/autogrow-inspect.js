// ═══════════════════════════════════════════════════════════════
// Autogrow Node Slot-Position Inspector
// ───────────────────────────────────────────────────────────────
// Run AFTER the replay places an autogrow partner node on the
// canvas (Gemini, Grok, Nano Banana, etc.). Prints the node's
// inputs/outputs arrays as the runtime sees them and the screen
// position our c2s(getConnectionPos) computes for each input,
// then drops a red dot at each computed position so you can
// visually compare to the actual slot circle.
//
// Sends a clean text report to window.__report (then in the
// console prompt: copy(__report)). Two key things to look at:
//
//   (1) Does inputs.length match the workflow JSON's inputs
//       length? If not, LiteGraph.createNode short-changed the
//       autogrow slots and we need to hydrate them.
//
//   (2) Do the red dots land on the actual slot circles? If
//       they're WAY below where the slot is drawn, our
//       getConnectionPos values disagree with the autogrow
//       widget's render.
// ═══════════════════════════════════════════════════════════════

(function inspectAutogrow() {
  document.querySelectorAll('._agi_dot').forEach(d => d.remove());
  const lines = [];
  const log = (...a) => { const s = a.join(' '); console.log('[autogrow]', s); lines.push(s); };

  function c2s(cx, cy) {
    const el = document.querySelector('canvas.graph-canvas-container')
            || document.querySelector('canvas#graph-canvas')
            || document.querySelector('canvas');
    const r = el.getBoundingClientRect();
    const ds = app.canvas.ds;
    return { x: (cx + ds.offset[0]) * ds.scale + r.left,
             y: (cy + ds.offset[1]) * ds.scale + r.top };
  }

  function dot(x, y, color, label) {
    const d = document.createElement('div');
    d.className = '_agi_dot';
    Object.assign(d.style, {
      position: 'fixed', left: x + 'px', top: y + 'px',
      width: '10px', height: '10px', borderRadius: '50%',
      background: color, transform: 'translate(-50%,-50%)',
      pointerEvents: 'none', zIndex: '999999',
      boxShadow: '0 0 0 2px white',
    });
    if (label) {
      d.title = label;
      const tag = document.createElement('div');
      tag.textContent = label;
      Object.assign(tag.style, {
        position: 'absolute', left: '12px', top: '-6px',
        fontSize: '11px', fontFamily: 'monospace',
        color: 'white', background: 'rgba(0,0,0,.7)',
        padding: '1px 4px', borderRadius: '3px',
        whiteSpace: 'nowrap',
      });
      d.appendChild(tag);
    }
    document.body.appendChild(d);
  }

  // Find the autogrow-y nodes
  const autoGrowy = (app.graph._nodes || []).filter(n =>
    /Gemini|Banana|Grok|Imagen|Dalle|Autogrow|Openai/i.test(n.type)
    || (n.inputs || []).some(inp => inp && (inp.shape === 7 || /\./.test(inp.name || '')))
  );
  log('found ' + autoGrowy.length + ' autogrow-y node(s)');

  for (const node of autoGrowy) {
    log('========================================');
    log('node:', node.type, '· id=' + node.id);
    log('  pos:', JSON.stringify([node.pos[0], node.pos[1]]),
        ' size:', JSON.stringify([node.size[0], node.size[1]]));
    log('  inputs.length:', node.inputs ? node.inputs.length : 0);
    (node.inputs || []).forEach((inp, i) => {
      const p = new Float32Array(2);
      let posStr = 'getConnectionPos threw';
      try {
        node.getConnectionPos(true, i, p);
        posStr = p[0].toFixed(1) + ',' + p[1].toFixed(1);
      } catch (e) {}
      const yRel = (typeof p[1] === 'number') ? (p[1] - node.pos[1]).toFixed(1) : '?';
      log('    [' + i + '] name="' + (inp.name || '?')
        + '" label="' + (inp.label || '?')
        + '" type=' + inp.type
        + ' shape=' + inp.shape
        + ' link=' + inp.link
        + ' canvas-pos=' + posStr
        + ' (yRel=' + yRel + ')');
      // also dot it
      if (typeof p[0] === 'number' && typeof p[1] === 'number') {
        const sc = c2s(p[0], p[1]);
        dot(sc.x, sc.y, '#ff3b30', 'I' + i + ':' + (inp.label || inp.name || '?'));
      }
    });
    log('  outputs.length:', node.outputs ? node.outputs.length : 0);
    (node.outputs || []).forEach((out, i) => {
      const p = new Float32Array(2);
      try { node.getConnectionPos(false, i, p); } catch (e) {}
      log('    [' + i + '] name="' + (out.name || '?')
        + '" type=' + out.type
        + ' links=' + JSON.stringify(out.links)
        + ' canvas-pos=' + p[0].toFixed(1) + ',' + p[1].toFixed(1));
      const sc = c2s(p[0], p[1]);
      dot(sc.x, sc.y, '#0a84ff', 'O' + i + ':' + (out.name || '?'));
    });
    log('  widgets.length:', (node.widgets || []).length);
    (node.widgets || []).slice(0, 12).forEach((w, i) => {
      log('    w[' + i + '] type=' + w.type + ' name="' + (w.name || '?') + '"'
        + (w.last_y !== undefined ? ' last_y=' + w.last_y.toFixed(1) : ''));
    });
  }

  log('----');
  log('dot legend: red=input slots, blue=output slots');
  log('clear with: document.querySelectorAll(\'._agi_dot\').forEach(d=>d.remove())');

  window.__report = lines.join('\n');
  console.log('%c[autogrow] report at window.__report — run  copy(__report)  in the prompt',
    'color:#00ff88;font-weight:bold;');
})();
