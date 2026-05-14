#!/usr/bin/env node

/**
 * ComfyUI Animated Replay Script Generator
 *
 * Generates a JS snippet for pasting into ComfyUI's DevTools console.
 * Features:
 *   - Animated cursor with smooth eased movement
 *   - Right-click → menu navigation → node selection
 *   - Character-by-character typing in text widgets
 *   - Auto canvas panning when targets go off-screen
 *   - Built-in screen recording (MediaRecorder + getDisplayMedia)
 *   - Drag-to-connect with visual trail
 *
 * Usage:
 *   node animated-replay.js <workflow.json> [--delay 800] [--output replay.js]
 */

const fs = require("fs");
const path = require("path");

// ─── CLI ───────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
let inputFile = null, delay = 800, outputFile = null;
let useCameraPan = true, convertToMp4 = false, useNodePanel = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--delay" && args[i + 1]) { delay = parseInt(args[i + 1], 10); i++; }
  else if (args[i] === "--output" && args[i + 1]) { outputFile = args[i + 1]; i++; }
  else if (args[i] === "--no-pan") { useCameraPan = false; }
  else if (args[i] === "--mp4") { convertToMp4 = true; }
  else if (args[i] === "--node-panel") { useNodePanel = true; }
  else if (!args[i].startsWith("--")) inputFile = args[i];
}

if (!inputFile) {
  console.error("Usage: node animated-replay.js <workflow.json> [--delay 800] [--output replay.js] [--no-pan] [--mp4] [--node-panel]");
  process.exit(1);
}

// ─── Parse & Sort ──────────────────────────────────────────────────────────────

const workflow = JSON.parse(fs.readFileSync(path.resolve(inputFile), "utf-8"));
const nodes = workflow.nodes || [];
const links = workflow.links || [];
if (!nodes.length) { console.error("No nodes found."); process.exit(1); }

const nodeMap = new Map(nodes.map(n => [n.id, n]));
const inDeg = new Map(), adj = new Map();
nodes.forEach(n => { inDeg.set(n.id, 0); adj.set(n.id, []); });
links.forEach(([, s, , t]) => {
  if (nodeMap.has(s) && nodeMap.has(t)) { adj.get(s).push(t); inDeg.set(t, inDeg.get(t) + 1); }
});
const q = []; inDeg.forEach((d, id) => { if (d === 0) q.push(id); });
const sorted = [];
while (q.length) {
  q.sort((a, b) => {
    const pa = nodeMap.get(a).pos || [0,0], pb = nodeMap.get(b).pos || [0,0];
    return pa[0]-pb[0] || pa[1]-pb[1];
  });
  const c = q.shift(); sorted.push(c);
  for (const nb of adj.get(c)||[]) { inDeg.set(nb, inDeg.get(nb)-1); if (inDeg.get(nb)===0) q.push(nb); }
}
nodes.forEach(n => { if (!sorted.includes(n.id)) sorted.push(n.id); });

const connByTgt = new Map();
links.forEach(([, s, ss, t, ts]) => {
  if (!connByTgt.has(t)) connByTgt.set(t, []);
  connByTgt.get(t).push({ srcId: s, srcSlot: ss, tgtId: t, tgtSlot: ts });
});
const connsInOrder = [];
sorted.forEach(id => (connByTgt.get(id)||[]).forEach(c => connsInOrder.push(c)));

const nodesData = sorted.map(id => {
  const n = nodeMap.get(id);
  return {
    id: n.id, type: n.type, title: n.title || n.type,
    pos: Array.isArray(n.pos) ? n.pos : [n.pos?.x||100, n.pos?.y||100],
    size: n.size || [200, 150],
    widgets_values: n.widgets_values || null,
    properties: n.properties || null,
  };
});
const linksData = connsInOrder.map(c => ({ srcId:c.srcId, srcSlot:c.srcSlot, tgtId:c.tgtId, tgtSlot:c.tgtSlot }));

// ─── Generate Script ───────────────────────────────────────────────────────────

const script = `// ═══════════════════════════════════════════════════════════════
// ComfyUI Animated Workflow Replay
// Source: ${path.basename(inputFile)} | ${nodes.length} nodes | ${links.length} links
// Features: right-click menus, typing, auto-pan, screen recording
// Stop: window.__replayStop = true;
// ═══════════════════════════════════════════════════════════════

(async function() {
  const DLY = ${delay};
  const NODES = ${JSON.stringify(nodesData)};
  const LINKS = ${JSON.stringify(linksData)};
  const USE_CAMERA_PAN = ${useCameraPan};
  const CONVERT_TO_MP4 = ${convertToMp4};
  const USE_NODE_PANEL = ${useNodePanel};
  window.__replayStop = false;

  // ── Cleanup ───────────────────────────────────────────────────
  document.getElementById('__rc')?.remove();
  document.getElementById('__ro')?.remove();
  document.getElementById('__rs')?.remove();
  if (window.__stopHandler) window.removeEventListener('keydown', window.__stopHandler);

  window.__stopHandler = (e) => {
    if (e.key === 'Escape') {
      window.__replayStop = true;
      console.log('%c🛑 Replay stopped by user (ESC).', 'color:#ff4444;font-size:14px;font-weight:bold;');
      window.removeEventListener('keydown', window.__stopHandler);
    }
  };
  window.addEventListener('keydown', window.__stopHandler);

  // ── Styles ────────────────────────────────────────────────────
  const sty = document.createElement('style'); sty.id='__rs';
  sty.textContent = '@keyframes __rr{0%{transform:translate(-50%,-50%) scale(0);opacity:.6}100%{transform:translate(-50%,-50%) scale(1);opacity:0}}'
    + '@keyframes __rck{0%{transform:translate(-2px,-2px) scale(1)}50%{transform:translate(-2px,-2px) scale(.75)}100%{transform:translate(-2px,-2px) scale(1)}}'
    + '@keyframes __rlb{0%{opacity:0;transform:translateY(6px)}15%{opacity:1;transform:translateY(0)}85%{opacity:1}100%{opacity:0}}'
    + '#__rc.ck{animation:__rck .15s ease-in-out}';
  document.head.appendChild(sty);

  // ── Cursor ────────────────────────────────────────────────────
  const cur = document.createElement('div'); cur.id='__rc';
  cur.innerHTML='<svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M5 3L19 12L12 13L9 20L5 3Z" fill="white" stroke="black" stroke-width="1.5" stroke-linejoin="round"/></svg>';
  Object.assign(cur.style,{position:'fixed',top:'0',left:'0',width:'24px',height:'24px',zIndex:'999999',pointerEvents:'none',filter:'drop-shadow(1px 2px 3px rgba(0,0,0,.4))',transform:'translate(-2px,-2px)'});
  document.body.appendChild(cur);

  const ov = document.createElement('div'); ov.id='__ro';
  Object.assign(ov.style,{position:'fixed',top:'0',left:'0',width:'100%',height:'100%',zIndex:'999998',pointerEvents:'none'});
  document.body.appendChild(ov);

  let cx=window.innerWidth/2, cy=window.innerHeight/2;
  cur.style.left=cx+'px'; cur.style.top=cy+'px';

  // ── Helpers ───────────────────────────────────────────────────
  const slp = ms => new Promise(r=>setTimeout(r,ms));
  const frm = () => new Promise(r=>requestAnimationFrame(r));
  function log(s,t,m){ console.log('%c[Step ' + s + '/' + t + '] ' + m,'color:#00d4ff;font-weight:bold;'); }

  // ── Recording ─────────────────────────────────────────────────
  let recorder=null, chunks=[], recStream=null;
  try {
    console.log('%c🎥 Select the ComfyUI window to record...','color:#ff9900;font-size:14px;font-weight:bold;');
    recStream = await navigator.mediaDevices.getDisplayMedia({video:{cursor:'always',frameRate:30},audio:false});
    recorder = new MediaRecorder(recStream, {
      mimeType: MediaRecorder.isTypeSupported('video/webm;codecs=vp9')?'video/webm;codecs=vp9':'video/webm',
    });
    recorder.ondataavailable = e => { if(e.data.size>0) chunks.push(e.data); };
    recorder.start();
    console.log('%c🔴 Recording!','color:#ff4444;font-size:14px;font-weight:bold;');
    await slp(500);
  } catch(e) {
    console.warn('⚠️ Recording skipped:', e.message);
  }

  function c2s(cx2,cy2){
    const el=document.querySelector('canvas.graph-canvas-container')||document.querySelector('canvas#graph-canvas')||document.querySelector('canvas');
    if(!el) return {x:cx2,y:cy2};
    const r=el.getBoundingClientRect(),ds=app.canvas.ds;
    return {x:(cx2+ds.offset[0])*ds.scale+r.left, y:(cy2+ds.offset[1])*ds.scale+r.top};
  }

  // ── Auto-Pan ──────────────────────────────────────────────────
  async function panTo(canvX,canvY,dur){
    dur=dur||400;
    const margin=120, sc=c2s(canvX,canvY);
    const vw=window.innerWidth, vh=window.innerHeight;
    if(sc.x>margin && sc.x<vw-margin && sc.y>margin && sc.y<vh-margin) return;

    const ds=app.canvas.ds;
    const el=document.querySelector('canvas.graph-canvas-container')||document.querySelector('canvas#graph-canvas')||document.querySelector('canvas');
    const rect=el?el.getBoundingClientRect():{left:0,top:0,width:vw,height:vh};
    const newOX=(rect.width/2)/ds.scale - canvX;
    const newOY=(rect.height/2)/ds.scale - canvY;
    const sOX=ds.offset[0], sOY=ds.offset[1];
    const steps=Math.max(20,Math.floor(dur/16));
    for(let i=0;i<=steps;i++){
      if(window.__replayStop) return;
      const t=i/steps, ease=t<.5?4*t*t*t:1-Math.pow(-2*t+2,3)/2;
      ds.offset[0]=sOX+(newOX-sOX)*ease;
      ds.offset[1]=sOY+(newOY-sOY)*ease;
      app.canvas.setDirty(true,true);
      await frm();
    }
  }

  // ── Cursor Movement ───────────────────────────────────────────
  async function moveTo(tx,ty,dur){
    dur=dur||500;
    const fx=cx,fy=cy,steps=Math.max(30,Math.floor(dur/16));
    for(let i=0;i<=steps;i++){
      if(window.__replayStop) return;
      const t=i/steps, ease=t<.5?4*t*t*t:1-Math.pow(-2*t+2,3)/2;
      cx=fx+(tx-fx)*ease; cy=fy+(ty-fy)*ease;
      cur.style.left=cx+'px'; cur.style.top=cy+'px';
      await frm();
    }
    cx=tx; cy=ty;
  }

  function ripple(color){
    color=color||'rgba(0,212,255,.6)';
    cur.classList.remove('ck'); void cur.offsetWidth; cur.classList.add('ck');
    const r=document.createElement('div');
    Object.assign(r.style,{position:'fixed',left:cx+'px',top:cy+'px',width:'40px',height:'40px',borderRadius:'50%',border:'2px solid '+color,animation:'__rr .4s ease-out forwards',pointerEvents:'none'});
    ov.appendChild(r); setTimeout(()=>r.remove(),500);
  }

  function label(text,dur){
    dur=dur||2000;
    const l=document.createElement('div');l.textContent=text;
    Object.assign(l.style,{position:'fixed',left:(cx+30)+'px',top:(cy-10)+'px',background:'rgba(0,0,0,.8)',color:'#00d4ff',padding:'4px 10px',borderRadius:'6px',fontSize:'13px',fontFamily:'system-ui',fontWeight:'500',pointerEvents:'none',zIndex:'999999',whiteSpace:'nowrap',animation:'__rlb '+dur+'ms ease-in-out forwards'});
    ov.appendChild(l); setTimeout(()=>l.remove(),dur);
  }

  // ── Typing Animation ──────────────────────────────────────────
  async function typeInWidget(node, widgetIndex, text) {
    if (!node.widgets || !node.widgets[widgetIndex]) return;
    const w = node.widgets[widgetIndex];

    // Find the widget's screen position using last_y if available
    const wy = (w.last_y !== undefined) ? w.last_y + 10 : (30 + widgetIndex * 20);
    const nodeScreen = c2s(node.pos[0] + node.size[0]/2, node.pos[1] + wy);
    await moveTo(nodeScreen.x, nodeScreen.y, 300);
    ripple();
    await slp(200);

    // Type character by character with blinking cursor
    w.value = '';
    const strText = String(text);
    let cursorVisible = true;
    const cursorBlink = setInterval(() => {
      cursorVisible = !cursorVisible;
      const base = w.value.endsWith('|') ? w.value.slice(0,-1) : w.value;
      w.value = cursorVisible ? base + '|' : base;
      app.canvas.setDirty(true, true);
    }, 400);

    for (let i = 0; i < strText.length; i++) {
      if (window.__replayStop) { clearInterval(cursorBlink); w.value = strText; return; }
      w.value = strText.slice(0, i + 1) + '|';
      cursorVisible = true;
      app.canvas.setDirty(true, true);
      // Variable typing speed for realism
      const charDelay = 25 + Math.random() * 40;
      await slp(charDelay);
    }

    clearInterval(cursorBlink);
    w.value = strText; // Remove cursor, set final value
    app.canvas.setDirty(true, true);

    // Trigger callback
    try { w.callback?.(w.value); } catch(e) {}
    app.canvas.setDirty(true, true);
  }

  async function clickWidgetArrow(node, wi, v) {
    if (!node.widgets || !node.widgets[wi]) return;
    const w = node.widgets[wi];
    const wy = (w.last_y !== undefined) ? w.last_y + 10 : (30 + wi * 20);
    const ns = c2s(node.pos[0] + node.size[0] - 20, node.pos[1] + wy);
    await moveTo(ns.x, ns.y, 300);
    ripple();
    await slp(100);
    if (Math.random() > 0.5) { ripple(); await slp(100); } // simulate a couple clicks sometimes
    w.value = v;
    try { w.callback?.(v); } catch(e) {}
    app.canvas.setDirty(true, true);
  }

  async function clickWidget(node, wi, v) {
    if (!node.widgets || !node.widgets[wi]) return;
    const w = node.widgets[wi];
    const wy = (w.last_y !== undefined) ? w.last_y + 10 : (30 + wi * 20);
    const ns = c2s(node.pos[0] + node.size[0] / 2, node.pos[1] + wy);
    await moveTo(ns.x, ns.y, 300);
    ripple();
    await slp(150);
    w.value = v;
    try { w.callback?.(v); } catch(e) {}
    app.canvas.setDirty(true, true);
  }

  // ── Drag Trail ────────────────────────────────────────────────
  async function dragTo(fx,fy,tx,ty,dur){
    dur=dur||700;
    await moveTo(fx,fy,400); await slp(100); ripple(); await slp(100);
    const trail=document.createElement('canvas');
    trail.width=window.innerWidth; trail.height=window.innerHeight;
    Object.assign(trail.style,{position:'fixed',top:'0',left:'0',width:'100%',height:'100%',zIndex:'999997',pointerEvents:'none'});
    ov.appendChild(trail);
    const ctx=trail.getContext('2d'), steps=Math.max(30,Math.floor(dur/16));
    let px=fx,py=fy;
    for(let i=0;i<=steps;i++){
      if(window.__replayStop){trail.remove();return;}
      const t=i/steps,ease=t<.5?4*t*t*t:1-Math.pow(-2*t+2,3)/2;
      cx=fx+(tx-fx)*ease; cy=fy+(ty-fy)*ease;
      cur.style.left=cx+'px'; cur.style.top=cy+'px';
      ctx.beginPath();ctx.moveTo(px,py);ctx.lineTo(cx,cy);
      ctx.strokeStyle='rgba(0,212,255,.3)';ctx.lineWidth=2;ctx.stroke();
      px=cx;py=cy; await frm();
    }
    ripple();
    let op=1; const fi=setInterval(()=>{op-=.05;trail.style.opacity=op;if(op<=0){clearInterval(fi);trail.remove();}},30);
  }

  // ── Right-Click Menu ──────────────────────────────────────────
  function dismissMenus(){
    document.querySelectorAll('.litecontextmenu,.comfy-context-menu').forEach(m=>m.remove());
  }

  function findEntry(text){
    // Search only the LAST (deepest) open menu panel
    const menus = document.querySelectorAll('.litecontextmenu, .comfy-context-menu, .litegraph-context-menu');
    if (menus.length === 0) return null;
    const lastMenu = menus[menus.length - 1];
    const entries = lastMenu.querySelectorAll('.litemenu-entry, .menu-entry');
    // Exact match first
    for(const e of entries){
      const lb=e.querySelector('.litemenu-entry-content')?.textContent?.trim()||e.childNodes[0]?.textContent?.trim()||e.textContent?.trim();
      if(lb===text) return e;
    }
    // Partial match
    for(const e of entries){
      const lb=e.querySelector('.litemenu-entry-content')?.textContent?.trim()||e.childNodes[0]?.textContent?.trim()||e.textContent?.trim();
      if(lb&&lb.includes(text)) return e;
    }
    // If not found in deepest, try all menus (reverse order = newest first)
    for (let mi = menus.length - 2; mi >= 0; mi--) {
      const entries2 = menus[mi].querySelectorAll('.litemenu-entry, .menu-entry');
      for(const e of entries2){
        const lb=e.querySelector('.litemenu-entry-content')?.textContent?.trim()||e.childNodes[0]?.textContent?.trim()||e.textContent?.trim();
        if(lb===text) return e;
      }
    }
    return null;
  }

  async function hoverEntry(e){
    const r=e.getBoundingClientRect();
    await moveTo(r.left+r.width/2, r.top+r.height/2, 200);
    e.dispatchEvent(new MouseEvent('mouseenter',{bubbles:true,clientX:cx,clientY:cy}));
    e.dispatchEvent(new MouseEvent('mouseover',{bubbles:true,clientX:cx,clientY:cy}));
    e.dispatchEvent(new PointerEvent('pointerenter',{bubbles:true,clientX:cx,clientY:cy}));
    e.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,clientX:cx,clientY:cy}));
  }

  async function clickEntry(e){
    ripple();
    e.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,clientX:cx,clientY:cy}));
    await slp(30);
    e.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,clientX:cx,clientY:cy}));
    e.dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:cx,clientY:cy}));
  }

  async function addViaMenu(nd,sx,sy){
    const canvasEl=document.querySelector('canvas.graph-canvas-container')||document.querySelector('canvas#graph-canvas')||document.querySelector('canvas');
    if(!canvasEl) return false;

    ripple('rgba(255,165,0,.6)');

    // Build a synthetic event object with ALL coordinate properties
    const rect = canvasEl.getBoundingClientRect();
    function mkEvt(type) {
      const e = new MouseEvent(type, {
        bubbles: true, cancelable: true,
        clientX: sx, clientY: sy,
        screenX: sx, screenY: sy,
        button: 2, buttons: 2,
      });
      // Attach extra properties LiteGraph expects
      e.canvasX = sx - rect.left;
      e.canvasY = sy - rect.top;
      e.isPrimary = true;
      return e;
    }

    // Try multiple approaches to open the context menu
    let menuOpened = false;

    // Approach 1: Use LiteGraph's processMouseDown/processMouseUp
    try {
      if (app.canvas.processMouseDown) {
        app.canvas.processMouseDown(mkEvt('mousedown'));
        await slp(80);
        if (app.canvas.processMouseUp) {
          app.canvas.processMouseUp(mkEvt('mouseup'));
        }
        await slp(400);
        menuOpened = !!document.querySelector('.litecontextmenu, .comfy-context-menu, .litegraph-context-menu');
      }
    } catch(e) { console.warn('processMouseDown failed:', e.message); }

    // Approach 2: Direct canvas context menu via getCanvasMenuOptions
    if (!menuOpened) {
      try {
        if (app.canvas.getCanvasMenuOptions && LiteGraph.ContextMenu) {
          const options = app.canvas.getCanvasMenuOptions();
          new LiteGraph.ContextMenu(options, {
            event: mkEvt('contextmenu'),
            callback: null,
            parentMenu: null,
            allow_html: false,
            node: null,
          });
          await slp(400);
          menuOpened = !!document.querySelector('.litecontextmenu, .litegraph-context-menu');
        }
      } catch(e) { console.warn('ContextMenu fallback failed:', e.message); }
    }

    // Approach 3: Dispatch DOM events as final attempt
    if (!menuOpened) {
      try {
        const evOpts = {bubbles:true,cancelable:true,clientX:sx,clientY:sy,button:2,buttons:2};
        canvasEl.dispatchEvent(new PointerEvent('pointerdown',evOpts));
        canvasEl.dispatchEvent(new MouseEvent('mousedown',evOpts));
        await slp(80);
        canvasEl.dispatchEvent(new PointerEvent('pointerup',evOpts));
        canvasEl.dispatchEvent(new MouseEvent('mouseup',evOpts));
        canvasEl.dispatchEvent(new MouseEvent('contextmenu',evOpts));
        await slp(400);
        menuOpened = !!document.querySelector('.litecontextmenu, .comfy-context-menu, .litegraph-context-menu');
      } catch(e) {}
    }

    // Force-reposition the menu at the cursor if it ended up at wrong coords
    if (menuOpened) {
      const menu = document.querySelector('.litecontextmenu, .comfy-context-menu, .litegraph-context-menu');
      if (menu) {
        menu.style.left = sx + 'px';
        menu.style.top = sy + 'px';
      }
    }

    if (!menuOpened) {
      dismissMenus();
      return false;
    }

    // Navigate the menu — click each level to drill into submenus
    // Count current menus so we can detect when new ones appear
    function menuCount() {
      return document.querySelectorAll('.litecontextmenu, .comfy-context-menu, .litegraph-context-menu').length;
    }

    async function waitForSubmenu(prevCount, timeout) {
      timeout = timeout || 800;
      const start = Date.now();
      while (Date.now() - start < timeout) {
        if (menuCount() > prevCount) return true;
        await slp(50);
      }
      return false;
    }

    // Step 1: Click "Add Node"
    let mc = menuCount();
    const an = findEntry('Add Node') || findEntry('Add node');
    if (an) { await hoverEntry(an); await slp(200); await clickEntry(an); await waitForSubmenu(mc); await slp(200); }

    // Step 2: Drill through every category level (handles any depth)
    const cat = LiteGraph.registered_node_types[nd.type]?.category;
    if (cat) {
      const parts = cat.split('/');
      for (let pi = 0; pi < parts.length; pi++) {
        mc = menuCount();
        await slp(200);
        const ce = findEntry(parts[pi]);
        if (ce) {
          await hoverEntry(ce); await slp(200); await clickEntry(ce);
          await waitForSubmenu(mc); await slp(200);
        } else {
          console.warn('⚠️ Menu entry not found: ' + parts[pi]);
        }
      }
    }

    // Step 3: Click the final node type
    await slp(200);
    const reg = LiteGraph.registered_node_types[nd.type];
    let ne = findEntry(nd.type) || findEntry(nd.title);
    if (!ne && reg && reg.title) ne = findEntry(reg.title);
    if (!ne && reg && reg.name) ne = findEntry(reg.name);
    if (!ne && nd.type.includes('/')) ne = findEntry(nd.type.split('/').pop());
    if (ne) { await hoverEntry(ne); await slp(200); await clickEntry(ne); await slp(300); dismissMenus(); return true; }
    dismissMenus(); return false;
  }

  // ── Add via Node Panel (sidebar search + drag) ─────────────
  async function addViaPanel(nd, targetScreenX, targetScreenY) {
    const nodesTab = [...document.querySelectorAll('nav button, aside button, [role="tab"], .sidebar-tab, .comfyui-sidebar button')]
      .find(b => /^nodes$/i.test(b.textContent?.trim()) || b.getAttribute('aria-label')?.toLowerCase() === 'nodes');
    if (nodesTab) {
      const nr = nodesTab.getBoundingClientRect();
      await moveTo(nr.left + nr.width/2, nr.top + nr.height/2, 300);
      ripple(); nodesTab.click(); await slp(400);
    }
    const searchInput = document.querySelector('.comfyui-sidebar input[type="text"], .comfyui-sidebar input[placeholder*="Search"], aside input[type="text"], .node-search input, .sidebar-content input');
    if (!searchInput) { console.warn('Node panel search input not found'); return false; }
    const sr = searchInput.getBoundingClientRect();
    await moveTo(sr.left + sr.width/2, sr.top + sr.height/2, 300);
    ripple(); searchInput.focus(); searchInput.click(); await slp(200);
    const searchTerm = nd.title !== nd.type ? nd.title : (nd.type.includes('/') ? nd.type.split('/').pop() : nd.type);
    searchInput.value = '';
    searchInput.dispatchEvent(new Event('input', {bubbles: true}));
    await slp(100);
    for (let i = 0; i < searchTerm.length; i++) {
      if (window.__replayStop) return false;
      searchInput.value = searchTerm.slice(0, i + 1);
      searchInput.dispatchEvent(new Event('input', {bubbles: true}));
      await slp(30 + Math.random() * 30);
    }
    await slp(400);
    const results = document.querySelectorAll('.comfyui-sidebar .node-item, .comfyui-sidebar [draggable], aside .comfy-node-item, .sidebar-content .tree-leaf, .comfyui-sidebar li');
    let match = null;
    for (const r of results) {
      const label = r.textContent?.trim();
      if (label && (label === nd.type || label === searchTerm || label.includes(searchTerm))) { match = r; break; }
    }
    if (!match) { console.warn('Node panel: no match for ' + searchTerm); return false; }
    const mr = match.getBoundingClientRect();
    const startX = mr.left + mr.width/2, startY = mr.top + mr.height/2;
    await moveTo(startX, startY, 300); ripple(); await slp(150);
    const dragOpts = {bubbles: true, cancelable: true, clientX: startX, clientY: startY};
    match.dispatchEvent(new DragEvent('dragstart', {...dragOpts, dataTransfer: new DataTransfer()}));
    match.dispatchEvent(new PointerEvent('pointerdown', dragOpts));
    match.dispatchEvent(new MouseEvent('mousedown', dragOpts));
    await slp(100);
    const canvasEl2 = document.querySelector('canvas.graph-canvas-container') || document.querySelector('canvas#graph-canvas') || document.querySelector('canvas');
    if (!canvasEl2) return false;
    const panelSteps = 25;
    for (let i = 0; i <= panelSteps; i++) {
      if (window.__replayStop) return false;
      const t = i / panelSteps, ease = t < .5 ? 4*t*t*t : 1 - Math.pow(-2*t+2, 3)/2;
      const mx = startX + (targetScreenX - startX) * ease;
      const my = startY + (targetScreenY - startY) * ease;
      cx = mx; cy = my; cur.style.left = cx + 'px'; cur.style.top = cy + 'px';
      canvasEl2.dispatchEvent(new DragEvent('dragover', {bubbles: true, cancelable: true, clientX: mx, clientY: my}));
      await frm();
    }
    const dt = new DataTransfer();
    dt.setData('text/plain', nd.type);
    canvasEl2.dispatchEvent(new DragEvent('drop', {bubbles: true, cancelable: true, clientX: targetScreenX, clientY: targetScreenY, dataTransfer: dt}));
    canvasEl2.dispatchEvent(new DragEvent('dragend', {bubbles: true, cancelable: true, clientX: targetScreenX, clientY: targetScreenY}));
    match.dispatchEvent(new PointerEvent('pointerup', {bubbles: true, clientX: targetScreenX, clientY: targetScreenY}));
    match.dispatchEvent(new MouseEvent('mouseup', {bubbles: true, clientX: targetScreenX, clientY: targetScreenY}));
    ripple('rgba(0,255,136,.6)');
    await slp(300);
    searchInput.value = ''; searchInput.dispatchEvent(new Event('input', {bubbles: true}));
    return true;
  }

  // ── Determine which widgets are text/string widgets ───────────
  function isTextWidget(widget) {
    if (!widget) return false;
    const t = (widget.type || '').toLowerCase();
    if (t === 'text' || t === 'string' || t === 'customtext') return true;
    // Check if it looks like a multiline text widget
    if (widget.options?.multiline) return true;
    // Check if the value is a long string (likely a prompt)
    if (typeof widget.value === 'string' && widget.value.length > 20) return true;
    return false;
  }

  // ═══════════════════════════════════════════════════════════════
  // MAIN REPLAY
  // ═══════════════════════════════════════════════════════════════

  const total = NODES.length + LINKS.length;
  let step = 0;
  const refs = {};

  log(0, total, '🧹 Clearing canvas...');
  app.graph.clear(); app.canvas.setDirty(true, true);
  await slp(DLY);

  // ── Place Nodes & Connect Immediately ─────────────────────────

  const connectedLinks = new Set();

  for (const nd of NODES) {
    if (window.__replayStop) break;
    step++;
    log(step, total, '➕ ' + nd.title + ' (' + nd.type + ')');

    // Pan canvas if target is off-screen
    const nodeCX = nd.pos[0] + nd.size[0]/2;
    const nodeCY = nd.pos[1] + nd.size[1]/2;
    if (USE_CAMERA_PAN) await panTo(nodeCX, nodeCY, 500);

    // Move cursor to target
    const sp = c2s(nodeCX, nodeCY);
    await moveTo(sp.x, sp.y, 500);
    await slp(200);

    // Try right-click menu
    const before = app.graph._nodes.length;
    if (USE_NODE_PANEL) { await addViaPanel(nd, sp.x, sp.y); } else { await addViaMenu(nd, sp.x, sp.y); }
    await slp(200);
    let created = app.graph._nodes.length > before ? app.graph._nodes[app.graph._nodes.length-1] : null;

    if (!created) {
      log(step, total, '   ⚙️ API fallback: ' + nd.type);
      ripple();
      created = LiteGraph.createNode(nd.type);
      if (created) app.graph.add(created);
    }

    if (created) {
      created.pos = [nd.pos[0], nd.pos[1]];
      created.size = [nd.size[0], nd.size[1]];
      if (nd.title !== nd.type) created.title = nd.title;

      // Force a draw so widget.last_y is populated for accurate clicking
      app.canvas.setDirty(true, true);
      await slp(50);

      // Set widget values — with typing animation for text widgets
      if (nd.widgets_values && created.widgets) {
        for (let i = 0; i < Math.min(created.widgets.length, nd.widgets_values.length); i++) {
          const v = nd.widgets_values[i];
          if (v == null) continue;

          if (typeof v === 'string' && isTextWidget(created.widgets[i])) {
            await typeInWidget(created, i, v);
          } else if (created.widgets[i].type === 'combo') {
            await clickWidgetArrow(created, i, v);
          } else {
            await clickWidget(created, i, v);
          }
        }
      }

      if (nd.properties) Object.assign(created.properties, nd.properties);
      refs[nd.id] = created.id;
      app.canvas.setDirty(true, true);
    } else {
      console.warn('⚠️ Could not create: ' + nd.type);
    }

    label(nd.title, DLY + 500);
    await slp(DLY * 0.5);

    // ── Connect any links where both nodes now exist ──────────
    for (let li = 0; li < LINKS.length; li++) {
      if (window.__replayStop) break;
      if (connectedLinks.has(li)) continue;
      const lk = LINKS[li];

      // Only connect if both source and target have been placed
      if (refs[lk.srcId] == null || refs[lk.tgtId] == null) continue;

      connectedLinks.add(li);
      step++;

      const sn = app.graph.getNodeById(refs[lk.srcId]);
      const tn = app.graph.getNodeById(refs[lk.tgtId]);
      if (!sn || !tn) continue;

      log(step, total, '🔗 '+(sn.title||sn.type)+'['+lk.srcSlot+'] → '+(tn.title||tn.type)+'['+lk.tgtSlot+']');

      // Pan to show both endpoints
      const midX = (sn.pos[0]+tn.pos[0])/2, midY = (sn.pos[1]+tn.pos[1])/2;
      if (USE_CAMERA_PAN) await panTo(midX, midY, 400);

      const sp2=new Float32Array(2), tp2=new Float32Array(2);
      sn.getConnectionPos(false, lk.srcSlot, sp2);
      tn.getConnectionPos(true, lk.tgtSlot, tp2);
      const ss=c2s(sp2[0],sp2[1]), ts=c2s(tp2[0],tp2[1]);

      await dragTo(ss.x, ss.y, ts.x, ts.y, 600);
      await slp(50);

      sn.connect(lk.srcSlot, tn, lk.tgtSlot);
      app.canvas.setDirty(true, true);
      await slp(DLY * 0.3);
    }

    await slp(DLY * 0.3);
  }

  // ── Zoom to Fit ───────────────────────────────────────────────

  console.log('%c📐 Zooming to fit workflow...', 'color: #00d4ff; font-weight: bold;');
  
  // Calculate bounding box and animate is no longer needed since we trigger native shortcut
  const zoomEvent = new KeyboardEvent('keydown', { key: '.', code: 'Period', keyCode: 190, bubbles: true });
  document.dispatchEvent(zoomEvent);
  window.dispatchEvent(zoomEvent);
  await slp(800);

  // ── Click Run / Queue Prompt ──────────────────────────────────

  console.log('%c▶️ Clicking Run...', 'color: #00d4ff; font-weight: bold;');

  // Find the Queue/Run button — try multiple selectors for different ComfyUI versions
  const runBtn = document.querySelector('[data-testid="queue-button"]')
    || document.querySelector('button.comfyui-button.primary')
    || document.querySelector('#queue-button')
    || document.querySelector('button[title="Queue Prompt"]')
    || [...document.querySelectorAll('button')].find(b =>
        /queue|run/i.test(b.textContent) || /queue|run/i.test(b.title || '')
      );

  if (runBtn) {
    console.log('%c✅ Found Run button:', 'color:#00ff88;', runBtn);
    const btnRect = runBtn.getBoundingClientRect();
    const btnX = btnRect.left + btnRect.width / 2;
    const btnY = btnRect.top + btnRect.height / 2;
    await moveTo(btnX, btnY, 500);
    await slp(300);
    ripple('rgba(0,255,136,.6)');
    // Dispatch full pointer+mouse event sequence for modern UI frameworks
    const evOpts = {bubbles: true, cancelable: true, clientX: btnX, clientY: btnY, button: 0};
    runBtn.dispatchEvent(new PointerEvent('pointerdown', evOpts));
    runBtn.dispatchEvent(new MouseEvent('mousedown', evOpts));
    await slp(80);
    runBtn.dispatchEvent(new PointerEvent('pointerup', evOpts));
    runBtn.dispatchEvent(new MouseEvent('mouseup', evOpts));
    runBtn.dispatchEvent(new MouseEvent('click', evOpts));
    runBtn.click(); // Also call .click() as backup
    console.log('%c⏳ Workflow queued! Waiting for execution...', 'color: #fcd34d; font-weight: bold;');
  } else {
    // Fallback: use the API directly
    console.log('%c⚙️ No Run button found, queuing via API...', 'color: #888;');
    try {
      await app.queuePrompt(0, 1);
    } catch(e) {
      try {
        // Alternative API call
        const p = await app.graphToPrompt();
        await fetch('/prompt', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: p.output }),
        });
      } catch(e2) {
        console.warn('⚠️ Could not trigger execution:', e2.message);
      }
    }
    console.log('%c⏳ Waiting for execution...', 'color: #fcd34d; font-weight: bold;');
  }

  // ── Wait for Execution ────────────────────────────────────────

  // Move cursor to center while waiting
  await moveTo(window.innerWidth / 2, window.innerHeight / 2, 400);

  // Poll until execution completes (max 5 minutes)
  const maxWait = 5 * 60 * 1000;
  const pollStart = Date.now();
  let executionDone = false;

  while (Date.now() - pollStart < maxWait && !window.__replayStop) {
    await slp(500);

    // Check various completion indicators
    // 1. Progress bar gone / at 100%
    const progressBar = document.querySelector('.comfyui-menu .progress-bar')
      || document.querySelector('.progress-text');
    const progressText = progressBar?.textContent || '';

    // 2. Check if any nodes are still executing (green outline)
    const runningNodes = app.graph._nodes.filter(n =>
      n.is_selected === false && (n.bgcolor === '#335533' || n.mode === 4)
    );

    // 3. Check app.runningNodeId
    const appRunning = app.runningNodeId != null;

    // 4. Check if we see output images
    const hasOutputImages = document.querySelectorAll('.comfyui-image-preview img, .preview-image img').length > 0;

    if (!appRunning && hasOutputImages) {
      executionDone = true;
      break;
    }

    // Simple fallback: if progress text shows completion
    if (progressText && /100%|complete/i.test(progressText)) {
      await slp(1500); // Wait a bit more for output to render
      executionDone = true;
      break;
    }

    // If no indication of running after initial delay, assume it's done
    if (Date.now() - pollStart > 3000 && !appRunning) {
      await slp(2000);
      executionDone = true;
      break;
    }
  }

  if (executionDone) {
    console.log('%c✅ Execution complete!', 'color: #00ff88; font-size: 14px; font-weight: bold;');
  } else {
    console.log('%c⏰ Execution wait timed out.', 'color: #fcd34d; font-weight: bold;');
  }

  await slp(2000); // Let the output render fully

  // ── Cleanup & Save Recording ──────────────────────────────────

  if (window.__replayStop) {
    console.log('%c🛑 Replay was interrupted.', 'color:#ff4444;font-size:14px;font-weight:bold;');
  } else {
    console.log('%c✅ Replay complete! ' + NODES.length + ' nodes, ' + LINKS.length + ' connections.', 'color:#00ff88;font-size:14px;font-weight:bold;');
  }

  cur.style.transition='opacity .5s'; cur.style.opacity='0';
  await slp(600);
  cur.remove(); ov.remove(); sty.remove();
  window.removeEventListener('keydown', window.__stopHandler);

  // Stop recording & auto-download
  if (recorder && recorder.state !== 'inactive') {
    recorder.stop();
    if (recStream) recStream.getTracks().forEach(t=>t.stop());
    await new Promise(resolve => {
      recorder.onstop = async () => {
        let blob = new Blob(chunks, {type:'video/webm'});
        const ts = new Date().toISOString().replace(/[:.]/g,'-').slice(0,19);
        let filename = 'comfyui-replay-'+ts;
        if (CONVERT_TO_MP4) {
          try {
            console.log('%c🔄 Converting to MP4...','color:#fcd34d;font-size:14px;font-weight:bold;');
            const {FFmpeg} = await import('https://esm.sh/@ffmpeg/ffmpeg@0.12.10');
            const {fetchFile} = await import('https://esm.sh/@ffmpeg/util@0.12.1');
            const ffmpeg = new FFmpeg();
            await ffmpeg.load({coreURL:'https://esm.sh/@ffmpeg/core@0.12.6/dist/esm/ffmpeg-core.js'});
            await ffmpeg.writeFile('input.webm', await fetchFile(blob));
            await ffmpeg.exec(['-i','input.webm','-c:v','libx264','-preset','fast','-crf','23','-pix_fmt','yuv420p',filename+'.mp4']);
            const data = await ffmpeg.readFile(filename+'.mp4');
            blob = new Blob([data.buffer], {type:'video/mp4'});
            filename += '.mp4';
            console.log('%c✅ MP4 conversion complete!','color:#00ff88;font-size:14px;font-weight:bold;');
          } catch(e) {
            console.warn('⚠️ MP4 conversion failed, saving WebM:', e.message);
            filename += '.webm';
          }
        } else { filename += '.webm'; }
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        document.body.appendChild(a); a.click(); a.remove();
        console.log('%c🎥 Recording saved! Check Downloads.','color:#00ff88;font-size:14px;font-weight:bold;');
        resolve();
      };
    });
  }
})();
`;

// ─── Output ────────────────────────────────────────────────────────────────────

if (outputFile) {
  const outPath = outputFile.endsWith(".js") ? outputFile : `${outputFile}.js`;
  fs.writeFileSync(path.resolve(outPath), script, "utf-8");
  console.log(`\n✅ Animated replay → ${outPath}`);
  console.log(`   ${nodes.length} nodes | ${links.length} links | ${delay}ms delay`);
  console.log(`\n📋 Paste into ComfyUI DevTools Console (Cmd+Option+I)\n`);
} else {
  console.error(`✅ Generated (${nodes.length} nodes, ${links.length} links, ${delay}ms)\n`);
  process.stdout.write(script);
}
