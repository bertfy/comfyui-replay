# ComfyUI Workflow Replay Tools

Automated tools for building ComfyUI workflows visually — perfect for screen recording tutorials.

![ComfyUI Replay Generator](assets/comfyui%20replay%20generator.png)

### Recording / Delay
https://github.com/user-attachments/assets/8c34f865-1a41-47b9-8eda-06cc0f81142c

### Camera Options (Zoom IN/OUT)
https://github.com/user-attachments/assets/9b6af309-b560-4d28-8e1c-6f606443ec92

### Replay in ComfyUI with AI-GEN Tutorial Tips 
![ReplayDirections](https://github.com/user-attachments/assets/01bd8931-039b-40ea-a681-cf826d13a13b)
![ReplayNotes2](https://github.com/user-attachments/assets/a5b2fcbf-9f50-4ad4-9e29-f27d7d675ddc)



## Deploy your own

The frontend (UI) splits from the worker (studio + ComfyUI + Playwright + ffmpeg) — Vercel hosts the frontend, Railway runs the worker.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fbertfy%2Fcomfyui-replay&env=STUDIO_URL&envDescription=WebSocket+URL+of+your+Railway+worker%2C+e.g.+wss%3A%2F%2Fyour-app.up.railway.app)
[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new/template?template=https%3A%2F%2Fgithub.com%2Fbertfy%2Fcomfyui-replay)

1. **Railway first** — click the button, deploy from this repo. Add `COMFY_API_KEY` in Variables. Generate a public domain in Settings → Networking. Copy the `wss://…` URL.
2. **Vercel second** — click the button, paste the Railway WebSocket URL into the `STUDIO_URL` env var. Deploy. Visit the Vercel URL.

Local-only: keep using `npm run studio` + open `index.html`. The frontend's WebSocket URL auto-detects (`?studio=` query → injected env → localhost fallback).

## Setup

```bash
npm install
npx playwright install chromium
```

## Tools

### 🎬 Cursor Replay (Playwright)

Opens a real browser with a visible, animated cursor that builds the workflow step-by-step. Records video automatically.

```bash
# Basic usage (ComfyUI must be running)
node cursor-replay.js my_workflow.json

# With options
node cursor-replay.js my_workflow.json \
  --url http://localhost:8188 \
  --delay 1000 \
  --output ./recordings \
  --viewport 1920x1080
```

**What happens:**
1. Browser opens → canvas clears
2. Cursor moves to each node position → double-clicks → searches type → adds node
3. Cursor drags from output slots to input slots to create connections
4. Video saved to `./recordings/`

| Option | Default | Description |
|--------|---------|-------------|
| `--url` | `http://127.0.0.1:8188` | ComfyUI URL |
| `--delay` | `800` | ms between steps |
| `--output` | `./recordings` | Video output dir |
| `--viewport` | `1920x1080` | Browser size |
| `--no-record` | - | Disable recording |
| `--slow-mo` | `50` | Playwright slow-mo |

---

### UI Options (Web Generator)

| Option | Description |
|--------|-------------|
| **Show Node Labels** | Displays the node title as an on-screen caption when created |
| **Show VO Captions** | Displays the AI narration script as on-screen captions |
| **Camera Follow** | Auto-pans the canvas to follow the active node being built |
| **Camera Zoom** | Zooms in/out on nodes and connections to keep focus tight |
| **AI Voice Over Timing** | Automatically adjusts replay speed to match narration length |

### 📋 Console Replay (No Browser Automation)

Generates a JS script you paste into ComfyUI's browser console. No Playwright needed.

```bash
node workflow-replay.js my_workflow.json --output replay --delay 1000
```

Then paste the generated `replay.js` into ComfyUI's DevTools console.

<details>
<summary>Example Generated Output (click to expand)</summary>

```js
// ComfyUI Animated Replay — example-workflow.json
// 7 nodes | 9 links | 1000ms delay
// Stop: window.__replayStop = true;

(async function() {
  const DLY = 1000;
  const NODES = [{"id":1,"type":"CheckpointLoaderSimple","title":"CheckpointLoaderSimple","pos":[26,474],"size":[315,98],"widgets_values":["v1-5-pruned-emaonly.ckpt"],"properties":{"Node name for S&R":"CheckpointLoaderSimple"}},{"id":2,"type":"CLIPTextEncode","title":"CLIPTextEncode","pos":[413,389],"size":[425.27801513671875,180.6060791015625],"widgets_values":["text, watermark"],"properties":{"Node name for S&R":"CLIPTextEncode"}},{"id":3,"type":"CLIPTextEncode","title":"CLIPTextEncode","pos":[415,186],"size":[422.84503173828125,164.31304931640625],"widgets_values":["beautiful scenery nature glass bottle landscape, purple galaxy bottle,"],"properties":{"Node name for S&R":"CLIPTextEncode"}},{"id":4,"type":"EmptyLatentImage","title":"EmptyLatentImage","pos":[473,609],"size":[315,106],"widgets_values":[512,512,1],"properties":{"Node name for S&R":"EmptyLatentImage"}},{"id":5,"type":"KSampler","title":"KSampler","pos":[863,186],"size":[315,262],"widgets_values":[778847685464853,"randomize",20,8,"euler","normal",1],"properties":{"Node name for S&R":"KSampler"}},{"id":6,"type":"VAEDecode","title":"VAEDecode","pos":[1209,188],"size":[210,46],"widgets_values":[],"properties":{"Node name for S&R":"VAEDecode"}},{"id":7,"type":"SaveImage","title":"SaveImage","pos":[1451,189],"size":[210,270],"widgets_values":["ComfyUI"],"properties":{}}];
  const LINKS = [{"srcId":1,"srcSlot":1,"tgtId":2,"tgtSlot":0},{"srcId":1,"srcSlot":1,"tgtId":3,"tgtSlot":0},{"srcId":1,"srcSlot":0,"tgtId":5,"tgtSlot":0},{"srcId":4,"srcSlot":0,"tgtId":5,"tgtSlot":3},{"srcId":3,"srcSlot":0,"tgtId":5,"tgtSlot":1},{"srcId":2,"srcSlot":0,"tgtId":5,"tgtSlot":2},{"srcId":5,"srcSlot":0,"tgtId":6,"tgtSlot":0},{"srcId":1,"srcSlot":2,"tgtId":6,"tgtSlot":1},{"srcId":6,"srcSlot":0,"tgtId":7,"tgtSlot":0}];
  const NARRATIONS = null;
  const USE_AI_TIMING = false;
  const USE_CAMERA_PAN = true;
  const USE_CAMERA_ZOOM = true;
  const CONVERT_TO_MP4 = false;
  const EXPORT_XML = false;
  const RECORD_VIDEO = false;
  const SHOW_DEBUG_LOG = false;
  const USE_NODE_PANEL = false;
  const CURSOR_STYLE = 'macos';
  const CURSOR_SIZE = 24;
  const SHOW_CAPTIONS = false;
  const SHOW_VO_CAPTIONS = false;
  window.__replayStop = false;

  document.getElementById('__rc')?.remove();
  document.getElementById('__ro')?.remove();
  document.getElementById('__rs')?.remove();

  const sty=document.createElement('style');sty.id='__rs';
  sty.textContent='@keyframes __rr{0%{transform:translate(-50%,-50%) scale(0);opacity:.6}100%{transform:translate(-50%,-50%) scale(1);opacity:0}}'
    +'@keyframes __rck{0%{transform:translate(-2px,-2px) scale(1)}50%{transform:translate(-2px,-2px) scale(.75)}100%{transform:translate(-2px,-2px) scale(1)}}'
    +'@keyframes __rlb{0%{opacity:0;transform:translateY(6px)}15%{opacity:1;transform:translateY(0)}85%{opacity:1}100%{opacity:0}}'
    +'#__rc.ck{animation:__rck .15s ease-in-out}';
  document.head.appendChild(sty);

  const CURSOR_SVGS = {
    default: '<svg width="'+CURSOR_SIZE+'" height="'+CURSOR_SIZE+'" viewBox="0 0 24 24" fill="none"><path d="M5 3L19 12L12 13L9 20L5 3Z" fill="white" stroke="black" stroke-width="1.5" stroke-linejoin="round"/></svg>',
    macos: '<svg width="'+CURSOR_SIZE+'" height="'+CURSOR_SIZE+'" viewBox="0 0 28 28" fill="none"><path d="M8.2 2.8L8.2 24.2L13.4 18.6L18.2 26.8L22.2 24.4L17.2 16.6L24.2 16.2L8.2 2.8Z" fill="black" stroke="white" stroke-width="1.8" stroke-linejoin="round"/></svg>'
  };
  const cur=document.createElement('div');cur.id='__rc';
  cur.innerHTML=CURSOR_SVGS[CURSOR_STYLE]||CURSOR_SVGS.default;
  Object.assign(cur.style,{position:'fixed',top:'0',left:'0',width:CURSOR_SIZE+'px',height:CURSOR_SIZE+'px',zIndex:'999999',pointerEvents:'none',filter:'drop-shadow(1px 2px 3px rgba(0,0,0,.4))',transform:'translate(-2px,-2px)'});
  document.body.appendChild(cur);

  const ov=document.createElement('div');ov.id='__ro';
  Object.assign(ov.style,{position:'fixed',top:'0',left:'0',width:'100%',height:'100%',zIndex:'999998',pointerEvents:'none'});
  document.body.appendChild(ov);

  let cx=window.innerWidth/2,cy=window.innerHeight/2;
  cur.style.left=cx+'px';cur.style.top=cy+'px';

  const slp=ms=>new Promise(r=>setTimeout(r,ms));
  const frm=()=>new Promise(r=>requestAnimationFrame(r));
  function log(s,t,m){console.log('%c[Step '+s+'/'+t+'] '+m,'color:#00d4ff;font-weight:bold;');}

  const dbg = document.createElement('div');
  Object.assign(dbg.style, {
    position:'fixed', bottom:'20px', right:'20px', width:'380px', height:'220px',
    background:'rgba(15,15,20,0.85)', backdropFilter:'blur(5px)', border:'1px solid #444',
    borderRadius:'8px', padding:'12px', color:'#0ee', fontFamily:'monospace',
    fontSize:'12px', overflowY:'auto', zIndex:'999999', pointerEvents:'none',
    boxShadow:'0 10px 30px rgba(0,0,0,0.5)', display:'flex', flexDirection:'column', gap:'4px'
  });
  dbg.innerHTML = '<strong style="color:#fff;margin-bottom:6px;">📡 Replay Debug Log</strong>';
  if(SHOW_DEBUG_LOG) document.body.appendChild(dbg);

  function logD(msg, c='#0ee') {
    if(!SHOW_DEBUG_LOG) return;
    const t = new Date().toISOString().split('T')[1].slice(0,-1);
    const line = document.createElement('div');
    line.innerHTML = `<span style="color:#888;">[${t}]</span> <span style="color:${c}">${msg}</span>`;
    dbg.appendChild(line);
    dbg.scrollTop = dbg.scrollHeight;
  }

  let recWs=null,recStartTime=0;
  if (RECORD_VIDEO) {
    logD('RECORD_VIDEO is enabled. Connecting to record server...', '#fca5a5');
    try {
      recWs = new WebSocket('ws://localhost:3001');
      await new Promise((resolve, reject) => {
        recWs.onopen = () => {
          logD('Connected to record server.', '#34d399');
          recWs.send(JSON.stringify({type:'start'}));
          recStartTime = Date.now();
          logD('Recording STARTED (external ffmpeg).', '#00ff88');
          console.log('%c🔴 Recording via ffmpeg!','color:#ff4444;font-size:14px;font-weight:bold;');
          resolve();
        };
        recWs.onerror = (e) => {
          logD('WebSocket error — is record-server.js running? (npm run record)', '#ef4444');
          console.warn('⚠️ Recording skipped: Could not connect to record server. Run: npm run record');
          recWs = null;
          resolve();
        };
        setTimeout(() => { if(recWs?.readyState !== 1) { recWs = null; resolve(); } }, 3000);
      });
    } catch(e) {
      logD('Recording connection failed: '+e.message, '#ef4444');
      recWs = null;
    }
  }
  function recStep(name) {
    if(recWs && recWs.readyState === 1) {
      recWs.send(JSON.stringify({type:'step', name:name, timeMs:Date.now()-recStartTime}));
    }
  }
  function c2s(cx2,cy2){
    const el=document.querySelector('canvas.graph-canvas-container')||document.querySelector('canvas#graph-canvas')||document.querySelector('canvas');
    if(!el)return{x:cx2,y:cy2};const r=el.getBoundingClientRect(),ds=app.canvas.ds;
    return{x:(cx2+ds.offset[0])*ds.scale+r.left,y:(cy2+ds.offset[1])*ds.scale+r.top};
  }

  async function cameraTo(cvX, cvY, targetScale, dur) {
    dur = dur || 400; const ds = app.canvas.ds;
    const sS = ds.scale, sOX = ds.offset[0], sOY = ds.offset[1];
    const el = document.querySelector('canvas.graph-canvas-container') || document.querySelector('canvas#graph-canvas') || document.querySelector('canvas');
    const rect = el ? el.getBoundingClientRect() : {width: window.innerWidth, height: window.innerHeight};
    const nOX = (rect.width/2)/targetScale - cvX, nOY = (rect.height/2)/targetScale - cvY;
    const steps = Math.max(20, Math.floor(dur/16));
    for (let i = 0; i <= steps; i++) {
      if (window.__replayStop) return;
      const t = i / steps;
      const ease = t < .5 ? 4*t*t*t : 1 - Math.pow(-2*t+2, 3)/2;
      if (Math.abs(targetScale - sS) > 0.001) ds.scale = sS + (targetScale - sS) * ease;
      ds.offset[0] = sOX + (nOX - sOX) * ease;
      ds.offset[1] = sOY + (nOY - sOY) * ease;
      app.canvas.setDirty(true, true); await frm();
    }
  }
  async function panTo(cvX,cvY,dur){ await cameraTo(cvX, cvY, USE_CAMERA_ZOOM ? 1.3 : app.canvas.ds.scale, dur); }

  async function moveTo(tx,ty,dur){dur=dur||500;const fx=cx,fy=cy,steps=Math.max(30,Math.floor(dur/16));
    for(let i=0;i<=steps;i++){if(window.__replayStop)return;const t=i/steps,ease=t<.5?4*t*t*t:1-Math.pow(-2*t+2,3)/2;
      cx=fx+(tx-fx)*ease;cy=fy+(ty-fy)*ease;cur.style.left=cx+'px';cur.style.top=cy+'px';await frm();}cx=tx;cy=ty;}

  function ripple(color){color=color||'rgba(0,212,255,.6)';cur.classList.remove('ck');void cur.offsetWidth;cur.classList.add('ck');
    const r=document.createElement('div');Object.assign(r.style,{position:'fixed',left:cx+'px',top:cy+'px',width:'40px',height:'40px',borderRadius:'50%',border:'2px solid '+color,animation:'__rr .4s ease-out forwards',pointerEvents:'none'});
    ov.appendChild(r);setTimeout(()=>r.remove(),500);}

  function label(text,dur,isVO){if(isVO){if(!SHOW_VO_CAPTIONS)return;}else{if(!SHOW_CAPTIONS)return;}
    dur=dur||2000;const l=document.createElement('div');l.textContent=text;
    Object.assign(l.style,{position:'fixed',left:(cx+30)+'px',top:(cy-10)+'px',background:'rgba(0,0,0,.8)',color:'#00d4ff',padding:'4px 10px',borderRadius:'6px',fontSize:'13px',fontFamily:'system-ui',fontWeight:'500',pointerEvents:'none',zIndex:'999999',whiteSpace:isVO?'normal':'nowrap',maxWidth:isVO?'300px':'none',animation:'__rlb '+dur+'ms ease-in-out forwards'});
    ov.appendChild(l);setTimeout(()=>l.remove(),dur);}

  async function typeInWidget(node,wi,text){
    if(!node.widgets||!node.widgets[wi])return;
    const w=node.widgets[wi];
    const wy=(w.last_y!==undefined)?w.last_y+10:(30+wi*20);
    const ns=c2s(node.pos[0]+node.size[0]/2,node.pos[1]+wy);
    await moveTo(ns.x,ns.y,300);ripple();await slp(200);
    w.value='';const s=String(text);
    let curVis=true;const curBlink=setInterval(()=>{curVis=!curVis;const base=w.value.endsWith('|')?w.value.slice(0,-1):w.value;w.value=curVis?base+'|':base;app.canvas.setDirty(true,true);},400);
    for(let i=0;i<s.length;i++){if(window.__replayStop){clearInterval(curBlink);w.value=s;return;}w.value=s.slice(0,i+1)+'|';curVis=true;app.canvas.setDirty(true,true);await slp(25+Math.random()*40);}
    clearInterval(curBlink);w.value=s;app.canvas.setDirty(true,true);
    try{w.callback?.(w.value);}catch(e){}app.canvas.setDirty(true,true);}

  async function clickWidgetArrow(node,wi,v){
    if(!node.widgets||!node.widgets[wi])return;
    const w=node.widgets[wi];
    const wy=(w.last_y!==undefined)?w.last_y+10:(30+wi*20);
    const ns=c2s(node.pos[0]+node.size[0]-20,node.pos[1]+wy);
    await moveTo(ns.x,ns.y,300);
    ripple();
    await slp(100);
    if(Math.random()>0.5){ripple();await slp(100);}
    w.value=v;try{w.callback?.(v);}catch(e){}app.canvas.setDirty(true,true);
  }

  async function dragNodeTo(node, tx, ty, dur) {
    dur = dur || 600;
    const sx = node.pos[0], sy = node.pos[1];
    if (Math.abs(sx - tx) < 2 && Math.abs(sy - ty) < 2) return;
    const hx = sx + Math.min(node.size[0]/2, 100);
    const hy = sy + 15;
    const sc = c2s(hx, hy);
    await moveTo(sc.x, sc.y, 300);
    ripple(); await slp(150);
    const steps = Math.max(30, Math.floor(dur/16));
    for (let i = 0; i <= steps; i++) {
      if (window.__replayStop) return;
      const t = i / steps;
      const ease = t < .5 ? 4*t*t*t : 1 - Math.pow(-2*t+2, 3)/2;
      node.pos[0] = sx + (tx - sx) * ease;
      node.pos[1] = sy + (ty - sy) * ease;
      const curSC = c2s(node.pos[0] + Math.min(node.size[0]/2, 100), node.pos[1] + 15);
      cx = curSC.x; cy = curSC.y;
      cur.style.left = cx+'px'; cur.style.top = cy+'px';
      app.canvas.setDirty(true,true);
      await frm();
    }
    node.pos[0] = tx; node.pos[1] = ty;
    ripple(); await slp(100);
  }

  async function dragTo(fx,fy,tx,ty,dur){dur=dur||700;await moveTo(fx,fy,400);await slp(100);ripple();await slp(100);
    const trail=document.createElement('canvas');trail.width=window.innerWidth;trail.height=window.innerHeight;
    Object.assign(trail.style,{position:'fixed',top:'0',left:'0',width:'100%',height:'100%',zIndex:'999997',pointerEvents:'none'});
    ov.appendChild(trail);const ctx=trail.getContext('2d'),steps=Math.max(30,Math.floor(dur/16));let px=fx,py=fy;
    for(let i=0;i<=steps;i++){if(window.__replayStop){trail.remove();return;}const t=i/steps,ease=t<.5?4*t*t*t:1-Math.pow(-2*t+2,3)/2;
      cx=fx+(tx-fx)*ease;cy=fy+(ty-fy)*ease;cur.style.left=cx+'px';cur.style.top=cy+'px';
      ctx.beginPath();ctx.moveTo(px,py);ctx.lineTo(cx,cy);ctx.strokeStyle='rgba(0,212,255,.3)';ctx.lineWidth=2;ctx.stroke();px=cx;py=cy;await frm();}
    ripple();let op=1;const fi=setInterval(()=>{op-=.05;trail.style.opacity=op;if(op<=0){clearInterval(fi);trail.remove();}},30);}

  function dismissMenus(){document.querySelectorAll('.litecontextmenu,.comfy-context-menu').forEach(m=>m.remove());}
  function findEntry(text){
    const menus=document.querySelectorAll('.litecontextmenu,.comfy-context-menu,.litegraph-context-menu');
    if(menus.length===0)return null;
    const last=menus[menus.length-1];
    const entries=last.querySelectorAll('.litemenu-entry,.menu-entry');
    for(const e of entries){const lb=e.querySelector('.litemenu-entry-content')?.textContent?.trim()||e.childNodes[0]?.textContent?.trim()||e.textContent?.trim();if(lb===text)return e;}
    for(const e of entries){const lb=e.querySelector('.litemenu-entry-content')?.textContent?.trim()||e.childNodes[0]?.textContent?.trim()||e.textContent?.trim();if(lb&&lb.includes(text))return e;}
    for(let mi=menus.length-2;mi>=0;mi--){const e2=menus[mi].querySelectorAll('.litemenu-entry,.menu-entry');for(const e of e2){const lb=e.querySelector('.litemenu-entry-content')?.textContent?.trim()||e.childNodes[0]?.textContent?.trim()||e.textContent?.trim();if(lb===text)return e;}}
    return null;}

  async function hoverEntry(e){const r=e.getBoundingClientRect();await moveTo(r.left+r.width/2,r.top+r.height/2,200);
    e.dispatchEvent(new MouseEvent('mouseenter',{bubbles:true,clientX:cx,clientY:cy}));
    e.dispatchEvent(new MouseEvent('mouseover',{bubbles:true,clientX:cx,clientY:cy}));
    e.dispatchEvent(new PointerEvent('pointerenter',{bubbles:true,clientX:cx,clientY:cy}));
    e.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,clientX:cx,clientY:cy}));}

  async function clickEntry(e){ripple();e.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,clientX:cx,clientY:cy}));
    await slp(30);e.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,clientX:cx,clientY:cy}));
    e.dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:cx,clientY:cy}));}

  async function addViaMenu(nd,sx,sy){
    const canvasEl=document.querySelector('canvas.graph-canvas-container')||document.querySelector('canvas#graph-canvas')||document.querySelector('canvas');
    if(!canvasEl)return false;
    ripple('rgba(255,165,0,.6)');
    const rect=canvasEl.getBoundingClientRect();
    function mkEvt(type){const e=new MouseEvent(type,{bubbles:true,cancelable:true,clientX:sx,clientY:sy,screenX:sx,screenY:sy,button:2,buttons:2});e.canvasX=sx-rect.left;e.canvasY=sy-rect.top;e.isPrimary=true;return e;}
    let menuOpened=false;
    try{if(app.canvas.processMouseDown){app.canvas.processMouseDown(mkEvt('mousedown'));await slp(80);if(app.canvas.processMouseUp)app.canvas.processMouseUp(mkEvt('mouseup'));await slp(400);menuOpened=!!document.querySelector('.litecontextmenu,.comfy-context-menu,.litegraph-context-menu');}}catch(e){}
    if(!menuOpened){try{if(app.canvas.getCanvasMenuOptions&&LiteGraph.ContextMenu){const options=app.canvas.getCanvasMenuOptions();new LiteGraph.ContextMenu(options,{event:mkEvt('contextmenu'),callback:null,parentMenu:null,allow_html:false,node:null});await slp(400);menuOpened=!!document.querySelector('.litecontextmenu,.litegraph-context-menu');}}catch(e){}}
    if(!menuOpened){try{const evOpts={bubbles:true,cancelable:true,clientX:sx,clientY:sy,button:2,buttons:2};canvasEl.dispatchEvent(new PointerEvent('pointerdown',evOpts));canvasEl.dispatchEvent(new MouseEvent('mousedown',evOpts));await slp(80);canvasEl.dispatchEvent(new PointerEvent('pointerup',evOpts));canvasEl.dispatchEvent(new MouseEvent('mouseup',evOpts));canvasEl.dispatchEvent(new MouseEvent('contextmenu',evOpts));await slp(400);menuOpened=!!document.querySelector('.litecontextmenu,.comfy-context-menu,.litegraph-context-menu');}catch(e){}}
    if(menuOpened){const menu=document.querySelector('.litecontextmenu,.comfy-context-menu,.litegraph-context-menu');if(menu){menu.style.left=sx+'px';menu.style.top=sy+'px';}}
    if(!menuOpened){dismissMenus();return false;}
    function menuCount(){return document.querySelectorAll('.litecontextmenu,.comfy-context-menu,.litegraph-context-menu').length;}
    async function waitSub(prev,timeout){timeout=timeout||800;const s=Date.now();while(Date.now()-s<timeout){if(menuCount()>prev)return true;await slp(50);}return false;}
    let mc=menuCount();
    const an=findEntry('Add Node')||findEntry('Add node');if(an){await hoverEntry(an);await slp(200);await clickEntry(an);await waitSub(mc);await slp(200);}
    const cat=LiteGraph.registered_node_types[nd.type]?.category;
    if(cat){const parts=cat.split('/');for(let pi=0;pi<parts.length;pi++){mc=menuCount();await slp(200);const ce=findEntry(parts[pi]);if(ce){await hoverEntry(ce);await slp(200);await clickEntry(ce);await waitSub(mc);await slp(200);}else{console.warn('Menu entry not found: '+parts[pi]);}}}
    await slp(200);const reg=LiteGraph.registered_node_types[nd.type];
    let ne=findEntry(nd.type)||findEntry(nd.title);
    if(!ne&&reg&&reg.title)ne=findEntry(reg.title);
    if(!ne&&reg&&reg.name)ne=findEntry(reg.name);
    if(!ne&&nd.type.includes('/'))ne=findEntry(nd.type.split('/').pop());
    if(ne){await hoverEntry(ne);await slp(200);await clickEntry(ne);await slp(300);dismissMenus();return true;}
    dismissMenus();return false;}

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

  function isTextWidget(w){if(!w)return false;const t=(w.type||'').toLowerCase();
    if(t==='combo')return false;
    if(t==='text'||t==='string'||t==='customtext')return true;if(w.options?.multiline)return true;
    if(typeof w.value==='string'&&w.value.length>20)return true;return false;}

  const total=NODES.length+LINKS.length;let step=0;const refs={};const connectedLinks=new Set();
  try{
    if(app.api&&app.api.clearItems){ await app.api.clearItems('history'); await app.api.clearItems('queue'); }
    else{ await fetch('/history',{method:'POST',body:JSON.stringify({clear:true})}); await fetch('/queue',{method:'POST',body:JSON.stringify({clear:true})}); }
  }catch(e){}
  log(0,total,'🧹 Clearing canvas...');app.graph.clear();app.canvas.setDirty(true,true);await slp(DLY);

  for(const nd of NODES){
    if(window.__replayStop)break;step++;
    log(step,total,'➕ '+nd.title+' ('+nd.type+')');
    recStep('Node: '+nd.title);
    const ncx=nd.pos[0]+nd.size[0]/2,ncy=nd.pos[1]+nd.size[1]/2;
    if(USE_CAMERA_PAN) await panTo(ncx,ncy,500);
    const sp=c2s(ncx,ncy);await moveTo(sp.x,sp.y,500);await slp(200);
    const before=app.graph._nodes.length;
    if(USE_NODE_PANEL){await addViaPanel(nd,sp.x,sp.y);}else{await addViaMenu(nd,sp.x,sp.y);}
    await slp(200);
    let created=app.graph._nodes.length>before?app.graph._nodes[app.graph._nodes.length-1]:null;
    if(!created){log(step,total,'   ⚙️ API fallback: '+nd.type);ripple();created=LiteGraph.createNode(nd.type);if(created)app.graph.add(created);}
    if(created){
      created.size=[nd.size[0],nd.size[1]];
      await dragNodeTo(created, nd.pos[0], nd.pos[1], 500);
      created.pos=[nd.pos[0],nd.pos[1]];
      if(nd.title!==nd.type)created.title=nd.title;
      app.canvas.setDirty(true,true);await slp(50);
      if(nd.widgets_values&&created.widgets){
        for(let i=0;i<Math.min(created.widgets.length,nd.widgets_values.length);i++){
          const v=nd.widgets_values[i];if(v==null)continue;
          if(typeof v==='string'&&isTextWidget(created.widgets[i])){await typeInWidget(created,i,v);}
          else if(created.widgets[i].type==='combo'){await clickWidgetArrow(created,i,v);}
          else{created.widgets[i].value=v;try{created.widgets[i].callback?.(v);}catch(e){}}
        }
      }
      if(nd.properties)Object.assign(created.properties,nd.properties);
      refs[nd.id]=created.id;app.canvas.setDirty(true,true);
    }
    label(nd.title, (DLY + 500) * 0.5, false);
    let stepDly = DLY * 0.5;
    if (USE_AI_TIMING && NARRATIONS && NARRATIONS[nd.id]) {
      const msg = NARRATIONS[nd.id];
      const wordCount = msg.split(' ').length;
      const speechTime = (wordCount / 2.5) * 1000;
      label(msg, speechTime + 1000, true);
      await slp(DLY);
      stepDly = speechTime;
      console.log('%c🎙️ Narration: ' + msg, 'color:#fcd34d;');
    }
    await slp(stepDly);
    if (USE_AI_TIMING && NARRATIONS && NARRATIONS[nd.id]) await slp(DLY);
    for(let li=0;li<LINKS.length;li++){
      if(window.__replayStop)break;
      if(connectedLinks.has(li))continue;
      const lk=LINKS[li];
      if(refs[lk.srcId]==null||refs[lk.tgtId]==null)continue;
      connectedLinks.add(li);step++;
      const sn=app.graph.getNodeById(refs[lk.srcId]),tn=app.graph.getNodeById(refs[lk.tgtId]);
      if(!sn||!tn)continue;
      log(step,total, '🔗 '+(sn.title||sn.type)+'['+lk.srcSlot+'] → '+(tn.title||tn.type)+'['+lk.tgtSlot+']');
      recStep('Link: '+sn.title+' -> '+tn.title);
      const midX=(sn.pos[0]+tn.pos[0])/2,midY=(sn.pos[1]+tn.pos[1])/2;
      if(USE_CAMERA_PAN) await panTo(midX,midY,400);
      const sp2=new Float32Array(2),tp2=new Float32Array(2);
      sn.getConnectionPos(false,lk.srcSlot,sp2);tn.getConnectionPos(true,lk.tgtSlot,tp2);
      const ss=c2s(sp2[0],sp2[1]),ts=c2s(tp2[0],tp2[1]);
      await dragTo(ss.x,ss.y,ts.x,ts.y,600);await slp(50);
      sn.connect(lk.srcSlot,tn,lk.tgtSlot);app.canvas.setDirty(true,true);await slp(DLY*0.3);
    }
    if (USE_CAMERA_ZOOM && USE_CAMERA_PAN) await cameraTo(nd.pos[0]+nd.size[0]/2, nd.pos[1]+nd.size[1]/2, 1.0, 500);
    await slp(stepDly * 0.5);
  }

  if (!false) {
    console.log('%c📐 Zooming to fit workflow...','color:#00d4ff;font-weight:bold;');
    const zoomEvent=new KeyboardEvent('keydown',{key:'.',code:'Period',keyCode:190,bubbles:true});
    document.dispatchEvent(zoomEvent);window.dispatchEvent(zoomEvent);
    await slp(800);
  }

  if (!false) {
    console.log('%c▶️ Clicking Run...','color:#00d4ff;font-weight:bold;');
    const runBtn=document.querySelector('[data-testid="queue-button"]')||document.querySelector('button.comfyui-button.primary')||document.querySelector('#queue-button')||document.querySelector('button[title="Queue Prompt"]')||[...document.querySelectorAll('button')].find(b=>/queue|run/i.test(b.textContent)||/queue|run/i.test(b.title||''));
    if(runBtn){
      console.log('%c✅ Found Run button:','color:#00ff88;',runBtn);
      const bR=runBtn.getBoundingClientRect();const bX=bR.left+bR.width/2,bY=bR.top+bR.height/2;
      await moveTo(bX,bY,500);await slp(300);
      ripple('rgba(0,255,136,.6)');
      const evO={bubbles:true,cancelable:true,clientX:bX,clientY:bY,button:0};
      runBtn.dispatchEvent(new PointerEvent('pointerdown',evO));runBtn.dispatchEvent(new MouseEvent('mousedown',evO));
      await slp(80);
      runBtn.dispatchEvent(new PointerEvent('pointerup',evO));runBtn.dispatchEvent(new MouseEvent('mouseup',evO));
      runBtn.dispatchEvent(new MouseEvent('click',evO));runBtn.click();
      console.log('%c⏳ Workflow queued! Waiting for execution...','color:#fcd34d;font-weight:bold;');
    }else{
      console.log('%c⚙️ No Run button found, queuing via API...','color:#888;');
      try{await app.queuePrompt(0,1);}catch(e){try{const p=await app.graphToPrompt();await fetch('/prompt',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt:p.output})});}catch(e2){console.warn('⚠️ Could not trigger execution:',e2.message);}}
      console.log('%c⏳ Waiting for execution...','color:#fcd34d;font-weight:bold;');
    }
  }

  await moveTo(window.innerWidth/2,window.innerHeight/2,400);
  const maxWait=5*60*1000,pollStart=Date.now();let execDone=false;
  while(Date.now()-pollStart<maxWait&&!window.__replayStop){await slp(500);
    const appRunning=app.runningNodeId!=null;
    const hasOut=document.querySelectorAll('.comfyui-image-preview img,.preview-image img').length>0;
    if(!appRunning&&hasOut){execDone=true;break;}
    if(Date.now()-pollStart>3000&&!appRunning){await slp(2000);execDone=true;break;}
  }
  if(execDone)console.log('%c✅ Execution complete!','color:#00ff88;font-size:14px;font-weight:bold;');
  else console.log('%c⏰ Execution wait timed out.','color:#fcd34d;font-weight:bold;');
  await slp(2000);

  console.log('%c✅ Replay complete! '+NODES.length+' nodes, '+LINKS.length+' connections.','color:#00ff88;font-size:14px;font-weight:bold;');
  cur.style.transition='opacity .5s';cur.style.opacity='0';await slp(600);
  cur.remove();ov.remove();sty.remove();
  if(recWs && recWs.readyState === 1){
    logD('Sending stop to record server...', '#fca5a5');
    recWs.send(JSON.stringify({type:'stop'}));
    await new Promise(resolve => {
      recWs.onmessage = (evt) => {
        try {
          const msg = JSON.parse(evt.data);
          if(msg.type === 'done') {
            logD('Recording saved by server: '+msg.file, '#00ff88');
            if(msg.xml) logD('FCPXML saved: '+msg.xml, '#fcd34d');
            console.log('%c🎥 Recording saved! Check recordings/ folder.','color:#00ff88;font-size:14px;font-weight:bold;');
            if(msg.file) console.log('%c   Video: '+msg.file,'color:#00d4ff;');
            if(msg.xml) console.log('%c   XML:   '+msg.xml,'color:#ff9900;');
            const ovly = document.createElement('div');
            Object.assign(ovly.style, {
              position:'fixed', top:'50%', left:'50%', transform:'translate(-50%,-50%)',
              background:'#1e1e1e', padding:'30px', borderRadius:'16px', boxShadow:'0 20px 50px rgba(0,0,0,0.8)',
              zIndex:'999999', textAlign:'center', color:'#fff', fontFamily:'sans-serif', border:'1px solid #333'
            });
            let info = '<h2 style="margin:0 0 20px 0;color:#00ff88;">✅ Replay Complete!</h2>';
            info += '<div style="font-size:14px;color:#00d4ff;margin-bottom:10px;">Files saved to recordings/ folder:</div>';
            if(msg.file) info += '<div style="font-size:13px;color:#aaa;margin:4px 0;">🎬 '+msg.file+'</div>';
            if(msg.xml) info += '<div style="font-size:13px;color:#aaa;margin:4px 0;">📋 '+msg.xml+'</div>';
            info += '<button id="__rclose" style="margin-top:20px;background:transparent;border:none;color:#aaa;cursor:pointer;text-decoration:underline;">Close</button>';
            ovly.innerHTML = info;
            document.body.appendChild(ovly);
            document.getElementById('__rclose').onclick = () => ovly.remove();
            resolve();
          }
        } catch(e) { resolve(); }
      };
      setTimeout(() => { logD('Timeout waiting for server response.', '#ef4444'); resolve(); }, 15000);
    });
    recWs.close();
  }
})();
```

</details>

### Replay in ComfyUI with AI-GEN Tutorial Tips

<details>
<summary>Example with AI Narrations (click to expand)</summary>

```js
// ComfyUI Animated Replay — example-workflow.json
// 7 nodes | 9 links | 1000ms delay
// Stop: window.__replayStop = true;

(async function() {
  const DLY = 1000;
  const NODES = [{"id":1,"type":"CheckpointLoaderSimple","title":"CheckpointLoaderSimple","pos":[26,474],"size":[315,98],"widgets_values":["v1-5-pruned-emaonly.ckpt"],"properties":{"Node name for S&R":"CheckpointLoaderSimple"}},{"id":2,"type":"CLIPTextEncode","title":"CLIPTextEncode","pos":[413,389],"size":[425.27801513671875,180.6060791015625],"widgets_values":["text, watermark"],"properties":{"Node name for S&R":"CLIPTextEncode"}},{"id":3,"type":"CLIPTextEncode","title":"CLIPTextEncode","pos":[415,186],"size":[422.84503173828125,164.31304931640625],"widgets_values":["beautiful scenery nature glass bottle landscape, purple galaxy bottle,"],"properties":{"Node name for S&R":"CLIPTextEncode"}},{"id":4,"type":"EmptyLatentImage","title":"EmptyLatentImage","pos":[473,609],"size":[315,106],"widgets_values":[512,512,1],"properties":{"Node name for S&R":"EmptyLatentImage"}},{"id":5,"type":"KSampler","title":"KSampler","pos":[863,186],"size":[315,262],"widgets_values":[778847685464853,"randomize",20,8,"euler","normal",1],"properties":{"Node name for S&R":"KSampler"}},{"id":6,"type":"VAEDecode","title":"VAEDecode","pos":[1209,188],"size":[210,46],"widgets_values":[],"properties":{"Node name for S&R":"VAEDecode"}},{"id":7,"type":"SaveImage","title":"SaveImage","pos":[1451,189],"size":[210,270],"widgets_values":["ComfyUI"],"properties":{}}];
  const LINKS = [{"srcId":1,"srcSlot":1,"tgtId":2,"tgtSlot":0},{"srcId":1,"srcSlot":1,"tgtId":3,"tgtSlot":0},{"srcId":1,"srcSlot":0,"tgtId":5,"tgtSlot":0},{"srcId":4,"srcSlot":0,"tgtId":5,"tgtSlot":3},{"srcId":3,"srcSlot":0,"tgtId":5,"tgtSlot":1},{"srcId":2,"srcSlot":0,"tgtId":5,"tgtSlot":2},{"srcId":5,"srcSlot":0,"tgtId":6,"tgtSlot":0},{"srcId":1,"srcSlot":2,"tgtId":6,"tgtSlot":1},{"srcId":6,"srcSlot":0,"tgtId":7,"tgtSlot":0}];
  const NARRATIONS = {"1":"First, we use the `CheckpointLoaderSimple` node to load our main Stable Diffusion model, 'v1-5-pruned-emaonly.ckpt'. This checkpoint is the fundamental AI brain, defining its capabilities for generating images.","2":"This `CLIPTextEncode` node takes our negative prompt, 'text, watermark', and translates it into a format the AI can understand. This tells the AI what elements to *avoid* including in our final image, like unwanted text or watermarks.","3":"Next, this `CLIPTextEncode` node takes our positive text prompt, 'beautiful scenery nature glass bottle landscape, purple galaxy bottle,', and translates it into a language the AI can understand. This guides the AI to create the image we desire based on our description.","4":"The `EmptyLatentImage` node sets up our initial canvas for image generation. Here, we specify that we want to generate an image that is 512 pixels wide by 512 pixels tall, providing the starting dimensions for our output.","5":"Now, the `KSampler` node is the heart of our image generation process. It takes our model, both positive and negative prompts, and the empty latent image, then iteratively refines it into our desired output image.","6":"Since the KSampler works with a compressed latent representation, the `VAEDecode` node is crucial. It converts that latent image data back into a high-quality, viewable pixel image that we can actually see and use.","7":"Finally, the `SaveImage` node does exactly what it says: it saves our beautifully generated image to your computer. You can also specify a subfolder name, like 'ComfyUI' here, to keep your outputs organized.","link_1_1_2_0":"Connect the CLIP output from the Checkpoint Loader to the CLIPTextEncode node to provide the model for encoding your positive prompt.","link_1_1_3_0":"Similarly, connect the Checkpoint Loader's CLIP output to the second CLIPTextEncode node for your negative prompt.","link_1_0_5_0":"Drag the main MODEL output from the Checkpoint Loader to the KSampler node to supply the core diffusion model.","link_4_0_5_3":"Connect the Empty Latent Image to the KSampler to provide the starting noise for image generation.","link_3_0_5_1":"Connect the conditioning output from the first CLIPTextEncode node to the KSampler's positive prompt input.","link_2_0_5_2":"Connect the conditioning output from the second CLIPTextEncode node to the KSampler's negative prompt input.","link_5_0_6_0":"Once the KSampler has generated the latent image, connect its output to the VAEDecode node to convert it back into a standard image format.","link_1_2_6_1":"Connect the VAE model from the Checkpoint Loader to the VAEDecode node, which is essential for transforming the latent image into a visual output.","link_6_0_7_0":"Finally, connect the decoded image output from VAEDecode to the SaveImage node to save your generated artwork."};
  const USE_AI_TIMING = true;
  const USE_CAMERA_PAN = true;
  const USE_CAMERA_ZOOM = true;
  const CONVERT_TO_MP4 = false;
  const EXPORT_XML = false;
  const RECORD_VIDEO = false;
  const SHOW_DEBUG_LOG = false;
  const USE_NODE_PANEL = false;
  const CURSOR_STYLE = 'macos';
  const CURSOR_SIZE = 24;
  const SHOW_CAPTIONS = false;
  const SHOW_VO_CAPTIONS = true;
  window.__replayStop = false;

  document.getElementById('__rc')?.remove();
  document.getElementById('__ro')?.remove();
  document.getElementById('__rs')?.remove();

  const sty=document.createElement('style');sty.id='__rs';
  sty.textContent='@keyframes __rr{0%{transform:translate(-50%,-50%) scale(0);opacity:.6}100%{transform:translate(-50%,-50%) scale(1);opacity:0}}'
    +'@keyframes __rck{0%{transform:translate(-2px,-2px) scale(1)}50%{transform:translate(-2px,-2px) scale(.75)}100%{transform:translate(-2px,-2px) scale(1)}}'
    +'@keyframes __rlb{0%{opacity:0;transform:translateY(6px)}15%{opacity:1;transform:translateY(0)}85%{opacity:1}100%{opacity:0}}'
    +'#__rc.ck{animation:__rck .15s ease-in-out}';
  document.head.appendChild(sty);

  const CURSOR_SVGS = {
    default: '<svg width="'+CURSOR_SIZE+'" height="'+CURSOR_SIZE+'" viewBox="0 0 24 24" fill="none"><path d="M5 3L19 12L12 13L9 20L5 3Z" fill="white" stroke="black" stroke-width="1.5" stroke-linejoin="round"/></svg>',
    macos: '<svg width="'+CURSOR_SIZE+'" height="'+CURSOR_SIZE+'" viewBox="0 0 28 28" fill="none"><path d="M8.2 2.8L8.2 24.2L13.4 18.6L18.2 26.8L22.2 24.4L17.2 16.6L24.2 16.2L8.2 2.8Z" fill="black" stroke="white" stroke-width="1.8" stroke-linejoin="round"/></svg>'
  };
  const cur=document.createElement('div');cur.id='__rc';
  cur.innerHTML=CURSOR_SVGS[CURSOR_STYLE]||CURSOR_SVGS.default;
  Object.assign(cur.style,{position:'fixed',top:'0',left:'0',width:CURSOR_SIZE+'px',height:CURSOR_SIZE+'px',zIndex:'999999',pointerEvents:'none',filter:'drop-shadow(1px 2px 3px rgba(0,0,0,.4))',transform:'translate(-2px,-2px)'});
  document.body.appendChild(cur);

  const ov=document.createElement('div');ov.id='__ro';
  Object.assign(ov.style,{position:'fixed',top:'0',left:'0',width:'100%',height:'100%',zIndex:'999998',pointerEvents:'none'});
  document.body.appendChild(ov);

  let cx=window.innerWidth/2,cy=window.innerHeight/2;
  cur.style.left=cx+'px';cur.style.top=cy+'px';

  const slp=ms=>new Promise(r=>setTimeout(r,ms));
  const frm=()=>new Promise(r=>requestAnimationFrame(r));
  function log(s,t,m){console.log('%c[Step '+s+'/'+t+'] '+m,'color:#00d4ff;font-weight:bold;');}

  const dbg = document.createElement('div');
  Object.assign(dbg.style, {
    position:'fixed', bottom:'20px', right:'20px', width:'380px', height:'220px',
    background:'rgba(15,15,20,0.85)', backdropFilter:'blur(5px)', border:'1px solid #444',
    borderRadius:'8px', padding:'12px', color:'#0ee', fontFamily:'monospace',
    fontSize:'12px', overflowY:'auto', zIndex:'999999', pointerEvents:'none',
    boxShadow:'0 10px 30px rgba(0,0,0,0.5)', display:'flex', flexDirection:'column', gap:'4px'
  });
  dbg.innerHTML = '<strong style="color:#fff;margin-bottom:6px;">📡 Replay Debug Log</strong>';
  if(SHOW_DEBUG_LOG) document.body.appendChild(dbg);

  function logD(msg, c='#0ee') {
    if(!SHOW_DEBUG_LOG) return;
    const t = new Date().toISOString().split('T')[1].slice(0,-1);
    const line = document.createElement('div');
    line.innerHTML = `<span style="color:#888;">[${t}]</span> <span style="color:${c}">${msg}</span>`;
    dbg.appendChild(line);
    dbg.scrollTop = dbg.scrollHeight;
  }

  let recWs=null,recStartTime=0;
  if (RECORD_VIDEO) {
    logD('RECORD_VIDEO is enabled. Connecting to record server...', '#fca5a5');
    try {
      recWs = new WebSocket('ws://localhost:3001');
      await new Promise((resolve, reject) => {
        recWs.onopen = () => {
          logD('Connected to record server.', '#34d399');
          recWs.send(JSON.stringify({type:'start'}));
          recStartTime = Date.now();
          logD('Recording STARTED (external ffmpeg).', '#00ff88');
          console.log('%c🔴 Recording via ffmpeg!','color:#ff4444;font-size:14px;font-weight:bold;');
          resolve();
        };
        recWs.onerror = (e) => {
          logD('WebSocket error — is record-server.js running? (npm run record)', '#ef4444');
          console.warn('⚠️ Recording skipped: Could not connect to record server. Run: npm run record');
          recWs = null;
          resolve();
        };
        setTimeout(() => { if(recWs?.readyState !== 1) { recWs = null; resolve(); } }, 3000);
      });
    } catch(e) {
      logD('Recording connection failed: '+e.message, '#ef4444');
      recWs = null;
    }
  }
  function recStep(name) {
    if(recWs && recWs.readyState === 1) {
      recWs.send(JSON.stringify({type:'step', name:name, timeMs:Date.now()-recStartTime}));
    }
  }
  function c2s(cx2,cy2){
    const el=document.querySelector('canvas.graph-canvas-container')||document.querySelector('canvas#graph-canvas')||document.querySelector('canvas');
    if(!el)return{x:cx2,y:cy2};const r=el.getBoundingClientRect(),ds=app.canvas.ds;
    return{x:(cx2+ds.offset[0])*ds.scale+r.left,y:(cy2+ds.offset[1])*ds.scale+r.top};
  }

  async function cameraTo(cvX, cvY, targetScale, dur) {
    dur = dur || 400; const ds = app.canvas.ds;
    const sS = ds.scale, sOX = ds.offset[0], sOY = ds.offset[1];
    const el = document.querySelector('canvas.graph-canvas-container') || document.querySelector('canvas#graph-canvas') || document.querySelector('canvas');
    const rect = el ? el.getBoundingClientRect() : {width: window.innerWidth, height: window.innerHeight};
    const nOX = (rect.width/2)/targetScale - cvX, nOY = (rect.height/2)/targetScale - cvY;
    const steps = Math.max(20, Math.floor(dur/16));
    for (let i = 0; i <= steps; i++) {
      if (window.__replayStop) return;
      const t = i / steps;
      const ease = t < .5 ? 4*t*t*t : 1 - Math.pow(-2*t+2, 3)/2;
      if (Math.abs(targetScale - sS) > 0.001) ds.scale = sS + (targetScale - sS) * ease;
      ds.offset[0] = sOX + (nOX - sOX) * ease;
      ds.offset[1] = sOY + (nOY - sOY) * ease;
      app.canvas.setDirty(true, true); await frm();
    }
  }
  async function panTo(cvX,cvY,dur){ await cameraTo(cvX, cvY, USE_CAMERA_ZOOM ? 1.3 : app.canvas.ds.scale, dur); }

  async function moveTo(tx,ty,dur){dur=dur||500;const fx=cx,fy=cy,steps=Math.max(30,Math.floor(dur/16));
    for(let i=0;i<=steps;i++){if(window.__replayStop)return;const t=i/steps,ease=t<.5?4*t*t*t:1-Math.pow(-2*t+2,3)/2;
      cx=fx+(tx-fx)*ease;cy=fy+(ty-fy)*ease;cur.style.left=cx+'px';cur.style.top=cy+'px';await frm();}cx=tx;cy=ty;}

  function ripple(color){color=color||'rgba(0,212,255,.6)';cur.classList.remove('ck');void cur.offsetWidth;cur.classList.add('ck');
    const r=document.createElement('div');Object.assign(r.style,{position:'fixed',left:cx+'px',top:cy+'px',width:'40px',height:'40px',borderRadius:'50%',border:'2px solid '+color,animation:'__rr .4s ease-out forwards',pointerEvents:'none'});
    ov.appendChild(r);setTimeout(()=>r.remove(),500);}

  function label(text,dur,isVO){if(isVO){if(!SHOW_VO_CAPTIONS)return;}else{if(!SHOW_CAPTIONS)return;}
    dur=dur||2000;const l=document.createElement('div');l.textContent=text;
    Object.assign(l.style,{position:'fixed',left:(cx+30)+'px',top:(cy-10)+'px',background:'rgba(0,0,0,.8)',color:'#00d4ff',padding:'4px 10px',borderRadius:'6px',fontSize:'13px',fontFamily:'system-ui',fontWeight:'500',pointerEvents:'none',zIndex:'999999',whiteSpace:isVO?'normal':'nowrap',maxWidth:isVO?'300px':'none',animation:'__rlb '+dur+'ms ease-in-out forwards'});
    ov.appendChild(l);setTimeout(()=>l.remove(),dur);}

  async function typeInWidget(node,wi,text){
    if(!node.widgets||!node.widgets[wi])return;
    const w=node.widgets[wi];
    const wy=(w.last_y!==undefined)?w.last_y+10:(30+wi*20);
    const ns=c2s(node.pos[0]+node.size[0]/2,node.pos[1]+wy);
    await moveTo(ns.x,ns.y,300);ripple();await slp(200);
    w.value='';const s=String(text);
    let curVis=true;const curBlink=setInterval(()=>{curVis=!curVis;const base=w.value.endsWith('|')?w.value.slice(0,-1):w.value;w.value=curVis?base+'|':base;app.canvas.setDirty(true,true);},400);
    for(let i=0;i<s.length;i++){if(window.__replayStop){clearInterval(curBlink);w.value=s;return;}w.value=s.slice(0,i+1)+'|';curVis=true;app.canvas.setDirty(true,true);await slp(25+Math.random()*40);}
    clearInterval(curBlink);w.value=s;app.canvas.setDirty(true,true);
    try{w.callback?.(w.value);}catch(e){}app.canvas.setDirty(true,true);}

  async function clickWidgetArrow(node,wi,v){
    if(!node.widgets||!node.widgets[wi])return;
    const w=node.widgets[wi];
    const wy=(w.last_y!==undefined)?w.last_y+10:(30+wi*20);
    const ns=c2s(node.pos[0]+node.size[0]-20,node.pos[1]+wy);
    await moveTo(ns.x,ns.y,300);
    ripple();
    await slp(100);
    if(Math.random()>0.5){ripple();await slp(100);}
    w.value=v;try{w.callback?.(v);}catch(e){}app.canvas.setDirty(true,true);
  }

  async function dragNodeTo(node, tx, ty, dur) {
    dur = dur || 600;
    const sx = node.pos[0], sy = node.pos[1];
    if (Math.abs(sx - tx) < 2 && Math.abs(sy - ty) < 2) return;
    const hx = sx + Math.min(node.size[0]/2, 100);
    const hy = sy + 15;
    const sc = c2s(hx, hy);
    await moveTo(sc.x, sc.y, 300);
    ripple(); await slp(150);
    const steps = Math.max(30, Math.floor(dur/16));
    for (let i = 0; i <= steps; i++) {
      if (window.__replayStop) return;
      const t = i / steps;
      const ease = t < .5 ? 4*t*t*t : 1 - Math.pow(-2*t+2, 3)/2;
      node.pos[0] = sx + (tx - sx) * ease;
      node.pos[1] = sy + (ty - sy) * ease;
      const curSC = c2s(node.pos[0] + Math.min(node.size[0]/2, 100), node.pos[1] + 15);
      cx = curSC.x; cy = curSC.y;
      cur.style.left = cx+'px'; cur.style.top = cy+'px';
      app.canvas.setDirty(true,true);
      await frm();
    }
    node.pos[0] = tx; node.pos[1] = ty;
    ripple(); await slp(100);
  }

  async function dragTo(fx,fy,tx,ty,dur){dur=dur||700;await moveTo(fx,fy,400);await slp(100);ripple();await slp(100);
    const trail=document.createElement('canvas');trail.width=window.innerWidth;trail.height=window.innerHeight;
    Object.assign(trail.style,{position:'fixed',top:'0',left:'0',width:'100%',height:'100%',zIndex:'999997',pointerEvents:'none'});
    ov.appendChild(trail);const ctx=trail.getContext('2d'),steps=Math.max(30,Math.floor(dur/16));let px=fx,py=fy;
    for(let i=0;i<=steps;i++){if(window.__replayStop){trail.remove();return;}const t=i/steps,ease=t<.5?4*t*t*t:1-Math.pow(-2*t+2,3)/2;
      cx=fx+(tx-fx)*ease;cy=fy+(ty-fy)*ease;cur.style.left=cx+'px';cur.style.top=cy+'px';
      ctx.beginPath();ctx.moveTo(px,py);ctx.lineTo(cx,cy);ctx.strokeStyle='rgba(0,212,255,.3)';ctx.lineWidth=2;ctx.stroke();px=cx;py=cy;await frm();}
    ripple();let op=1;const fi=setInterval(()=>{op-=.05;trail.style.opacity=op;if(op<=0){clearInterval(fi);trail.remove();}},30);}

  function dismissMenus(){document.querySelectorAll('.litecontextmenu,.comfy-context-menu').forEach(m=>m.remove());}
  function findEntry(text){
    const menus=document.querySelectorAll('.litecontextmenu,.comfy-context-menu,.litegraph-context-menu');
    if(menus.length===0)return null;
    const last=menus[menus.length-1];
    const entries=last.querySelectorAll('.litemenu-entry,.menu-entry');
    for(const e of entries){const lb=e.querySelector('.litemenu-entry-content')?.textContent?.trim()||e.childNodes[0]?.textContent?.trim()||e.textContent?.trim();if(lb===text)return e;}
    for(const e of entries){const lb=e.querySelector('.litemenu-entry-content')?.textContent?.trim()||e.childNodes[0]?.textContent?.trim()||e.textContent?.trim();if(lb&&lb.includes(text))return e;}
    for(let mi=menus.length-2;mi>=0;mi--){const e2=menus[mi].querySelectorAll('.litemenu-entry,.menu-entry');for(const e of e2){const lb=e.querySelector('.litemenu-entry-content')?.textContent?.trim()||e.childNodes[0]?.textContent?.trim()||e.textContent?.trim();if(lb===text)return e;}}
    return null;}

  async function hoverEntry(e){const r=e.getBoundingClientRect();await moveTo(r.left+r.width/2,r.top+r.height/2,200);
    e.dispatchEvent(new MouseEvent('mouseenter',{bubbles:true,clientX:cx,clientY:cy}));
    e.dispatchEvent(new MouseEvent('mouseover',{bubbles:true,clientX:cx,clientY:cy}));
    e.dispatchEvent(new PointerEvent('pointerenter',{bubbles:true,clientX:cx,clientY:cy}));
    e.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,clientX:cx,clientY:cy}));}

  async function clickEntry(e){ripple();e.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,clientX:cx,clientY:cy}));
    await slp(30);e.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,clientX:cx,clientY:cy}));
    e.dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:cx,clientY:cy}));}

  async function addViaMenu(nd,sx,sy){
    const canvasEl=document.querySelector('canvas.graph-canvas-container')||document.querySelector('canvas#graph-canvas')||document.querySelector('canvas');
    if(!canvasEl)return false;
    ripple('rgba(255,165,0,.6)');
    const rect=canvasEl.getBoundingClientRect();
    function mkEvt(type){const e=new MouseEvent(type,{bubbles:true,cancelable:true,clientX:sx,clientY:sy,screenX:sx,screenY:sy,button:2,buttons:2});e.canvasX=sx-rect.left;e.canvasY=sy-rect.top;e.isPrimary=true;return e;}
    let menuOpened=false;
    try{if(app.canvas.processMouseDown){app.canvas.processMouseDown(mkEvt('mousedown'));await slp(80);if(app.canvas.processMouseUp)app.canvas.processMouseUp(mkEvt('mouseup'));await slp(400);menuOpened=!!document.querySelector('.litecontextmenu,.comfy-context-menu,.litegraph-context-menu');}}catch(e){}
    if(!menuOpened){try{if(app.canvas.getCanvasMenuOptions&&LiteGraph.ContextMenu){const options=app.canvas.getCanvasMenuOptions();new LiteGraph.ContextMenu(options,{event:mkEvt('contextmenu'),callback:null,parentMenu:null,allow_html:false,node:null});await slp(400);menuOpened=!!document.querySelector('.litecontextmenu,.litegraph-context-menu');}}catch(e){}}
    if(!menuOpened){try{const evOpts={bubbles:true,cancelable:true,clientX:sx,clientY:sy,button:2,buttons:2};canvasEl.dispatchEvent(new PointerEvent('pointerdown',evOpts));canvasEl.dispatchEvent(new MouseEvent('mousedown',evOpts));await slp(80);canvasEl.dispatchEvent(new PointerEvent('pointerup',evOpts));canvasEl.dispatchEvent(new MouseEvent('mouseup',evOpts));canvasEl.dispatchEvent(new MouseEvent('contextmenu',evOpts));await slp(400);menuOpened=!!document.querySelector('.litecontextmenu,.comfy-context-menu,.litegraph-context-menu');}catch(e){}}
    if(menuOpened){const menu=document.querySelector('.litecontextmenu,.comfy-context-menu,.litegraph-context-menu');if(menu){menu.style.left=sx+'px';menu.style.top=sy+'px';}}
    if(!menuOpened){dismissMenus();return false;}
    function menuCount(){return document.querySelectorAll('.litecontextmenu,.comfy-context-menu,.litegraph-context-menu').length;}
    async function waitSub(prev,timeout){timeout=timeout||800;const s=Date.now();while(Date.now()-s<timeout){if(menuCount()>prev)return true;await slp(50);}return false;}
    let mc=menuCount();
    const an=findEntry('Add Node')||findEntry('Add node');if(an){await hoverEntry(an);await slp(200);await clickEntry(an);await waitSub(mc);await slp(200);}
    const cat=LiteGraph.registered_node_types[nd.type]?.category;
    if(cat){const parts=cat.split('/');for(let pi=0;pi<parts.length;pi++){mc=menuCount();await slp(200);const ce=findEntry(parts[pi]);if(ce){await hoverEntry(ce);await slp(200);await clickEntry(ce);await waitSub(mc);await slp(200);}else{console.warn('Menu entry not found: '+parts[pi]);}}}
    await slp(200);const reg=LiteGraph.registered_node_types[nd.type];
    let ne=findEntry(nd.type)||findEntry(nd.title);
    if(!ne&&reg&&reg.title)ne=findEntry(reg.title);
    if(!ne&&reg&&reg.name)ne=findEntry(reg.name);
    if(!ne&&nd.type.includes('/'))ne=findEntry(nd.type.split('/').pop());
    if(ne){await hoverEntry(ne);await slp(200);await clickEntry(ne);await slp(300);dismissMenus();return true;}
    dismissMenus();return false;}

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

  function isTextWidget(w){if(!w)return false;const t=(w.type||'').toLowerCase();
    if(t==='combo')return false;
    if(t==='text'||t==='string'||t==='customtext')return true;if(w.options?.multiline)return true;
    if(typeof w.value==='string'&&w.value.length>20)return true;return false;}

  const total=NODES.length+LINKS.length;let step=0;const refs={};const connectedLinks=new Set();
  try{
    if(app.api&&app.api.clearItems){ await app.api.clearItems('history'); await app.api.clearItems('queue'); }
    else{ await fetch('/history',{method:'POST',body:JSON.stringify({clear:true})}); await fetch('/queue',{method:'POST',body:JSON.stringify({clear:true})}); }
  }catch(e){}
  log(0,total,'🧹 Clearing canvas...');app.graph.clear();app.canvas.setDirty(true,true);await slp(DLY);

  for(const nd of NODES){
    if(window.__replayStop)break;step++;
    log(step,total,'➕ '+nd.title+' ('+nd.type+')');
    recStep('Node: '+nd.title);
    const ncx=nd.pos[0]+nd.size[0]/2,ncy=nd.pos[1]+nd.size[1]/2;
    if(USE_CAMERA_PAN) await panTo(ncx,ncy,500);
    const sp=c2s(ncx,ncy);await moveTo(sp.x,sp.y,500);await slp(200);
    const before=app.graph._nodes.length;
    if(USE_NODE_PANEL){await addViaPanel(nd,sp.x,sp.y);}else{await addViaMenu(nd,sp.x,sp.y);}
    await slp(200);
    let created=app.graph._nodes.length>before?app.graph._nodes[app.graph._nodes.length-1]:null;
    if(!created){log(step,total,'   ⚙️ API fallback: '+nd.type);ripple();created=LiteGraph.createNode(nd.type);if(created)app.graph.add(created);}
    if(created){
      created.size=[nd.size[0],nd.size[1]];
      await dragNodeTo(created, nd.pos[0], nd.pos[1], 500);
      created.pos=[nd.pos[0],nd.pos[1]];
      if(nd.title!==nd.type)created.title=nd.title;
      app.canvas.setDirty(true,true);await slp(50);
      if(nd.widgets_values&&created.widgets){
        for(let i=0;i<Math.min(created.widgets.length,nd.widgets_values.length);i++){
          const v=nd.widgets_values[i];if(v==null)continue;
          if(typeof v==='string'&&isTextWidget(created.widgets[i])){await typeInWidget(created,i,v);}
          else if(created.widgets[i].type==='combo'){await clickWidgetArrow(created,i,v);}
          else{created.widgets[i].value=v;try{created.widgets[i].callback?.(v);}catch(e){}}
        }
      }
      if(nd.properties)Object.assign(created.properties,nd.properties);
      refs[nd.id]=created.id;app.canvas.setDirty(true,true);
    }
    label(nd.title, (DLY + 500) * 0.5, false);
    let stepDly = DLY * 0.5;
    if (USE_AI_TIMING && NARRATIONS && NARRATIONS[nd.id]) {
      const msg = NARRATIONS[nd.id];
      const wordCount = msg.split(' ').length;
      const speechTime = (wordCount / 2.5) * 1000;
      label(msg, speechTime + 1000, true);
      await slp(DLY);
      stepDly = speechTime;
      console.log('%c🎙️ Narration: ' + msg, 'color:#fcd34d;');
    }
    await slp(stepDly);
    if (USE_AI_TIMING && NARRATIONS && NARRATIONS[nd.id]) await slp(DLY);
    for(let li=0;li<LINKS.length;li++){
      if(window.__replayStop)break;
      if(connectedLinks.has(li))continue;
      const lk=LINKS[li];
      if(refs[lk.srcId]==null||refs[lk.tgtId]==null)continue;
      connectedLinks.add(li);step++;
      const sn=app.graph.getNodeById(refs[lk.srcId]),tn=app.graph.getNodeById(refs[lk.tgtId]);
      if(!sn||!tn)continue;
      log(step,total, '🔗 '+(sn.title||sn.type)+'['+lk.srcSlot+'] → '+(tn.title||tn.type)+'['+lk.tgtSlot+']');
      recStep('Link: '+sn.title+' -> '+tn.title);
      const midX=(sn.pos[0]+tn.pos[0])/2,midY=(sn.pos[1]+tn.pos[1])/2;
      if(USE_CAMERA_PAN) await panTo(midX,midY,400);
      const sp2=new Float32Array(2),tp2=new Float32Array(2);
      sn.getConnectionPos(false,lk.srcSlot,sp2);tn.getConnectionPos(true,lk.tgtSlot,tp2);
      const ss=c2s(sp2[0],sp2[1]),ts=c2s(tp2[0],tp2[1]);
      await dragTo(ss.x,ss.y,ts.x,ts.y,600);await slp(50);
      sn.connect(lk.srcSlot,tn,lk.tgtSlot);app.canvas.setDirty(true,true);await slp(DLY*0.3);
    }
    if (USE_CAMERA_ZOOM && USE_CAMERA_PAN) await cameraTo(nd.pos[0]+nd.size[0]/2, nd.pos[1]+nd.size[1]/2, 1.0, 500);
    await slp(stepDly * 0.5);
  }

  if (!false) {
    console.log('%c📐 Zooming to fit workflow...','color:#00d4ff;font-weight:bold;');
    const zoomEvent=new KeyboardEvent('keydown',{key:'.',code:'Period',keyCode:190,bubbles:true});
    document.dispatchEvent(zoomEvent);window.dispatchEvent(zoomEvent);
    await slp(800);
  }

  if (!false) {
    console.log('%c▶️ Clicking Run...','color:#00d4ff;font-weight:bold;');
    const runBtn=document.querySelector('[data-testid="queue-button"]')||document.querySelector('button.comfyui-button.primary')||document.querySelector('#queue-button')||document.querySelector('button[title="Queue Prompt"]')||[...document.querySelectorAll('button')].find(b=>/queue|run/i.test(b.textContent)||/queue|run/i.test(b.title||''));
    if(runBtn){
      console.log('%c✅ Found Run button:','color:#00ff88;',runBtn);
      const bR=runBtn.getBoundingClientRect();const bX=bR.left+bR.width/2,bY=bR.top+bR.height/2;
      await moveTo(bX,bY,500);await slp(300);
      ripple('rgba(0,255,136,.6)');
      const evO={bubbles:true,cancelable:true,clientX:bX,clientY:bY,button:0};
      runBtn.dispatchEvent(new PointerEvent('pointerdown',evO));runBtn.dispatchEvent(new MouseEvent('mousedown',evO));
      await slp(80);
      runBtn.dispatchEvent(new PointerEvent('pointerup',evO));runBtn.dispatchEvent(new MouseEvent('mouseup',evO));
      runBtn.dispatchEvent(new MouseEvent('click',evO));runBtn.click();
      console.log('%c⏳ Workflow queued! Waiting for execution...','color:#fcd34d;font-weight:bold;');
    }else{
      console.log('%c⚙️ No Run button found, queuing via API...','color:#888;');
      try{await app.queuePrompt(0,1);}catch(e){try{const p=await app.graphToPrompt();await fetch('/prompt',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt:p.output})});}catch(e2){console.warn('⚠️ Could not trigger execution:',e2.message);}}
      console.log('%c⏳ Waiting for execution...','color:#fcd34d;font-weight:bold;');
    }
  }

  await moveTo(window.innerWidth/2,window.innerHeight/2,400);
  const maxWait=5*60*1000,pollStart=Date.now();let execDone=false;
  while(Date.now()-pollStart<maxWait&&!window.__replayStop){await slp(500);
    const appRunning=app.runningNodeId!=null;
    const hasOut=document.querySelectorAll('.comfyui-image-preview img,.preview-image img').length>0;
    if(!appRunning&&hasOut){execDone=true;break;}
    if(Date.now()-pollStart>3000&&!appRunning){await slp(2000);execDone=true;break;}
  }
  if(execDone)console.log('%c✅ Execution complete!','color:#00ff88;font-size:14px;font-weight:bold;');
  else console.log('%c⏰ Execution wait timed out.','color:#fcd34d;font-weight:bold;');
  await slp(2000);

  console.log('%c✅ Replay complete! '+NODES.length+' nodes, '+LINKS.length+' connections.','color:#00ff88;font-size:14px;font-weight:bold;');
  cur.style.transition='opacity .5s';cur.style.opacity='0';await slp(600);
  cur.remove();ov.remove();sty.remove();
  if(recWs && recWs.readyState === 1){
    logD('Sending stop to record server...', '#fca5a5');
    recWs.send(JSON.stringify({type:'stop'}));
    await new Promise(resolve => {
      recWs.onmessage = (evt) => {
        try {
          const msg = JSON.parse(evt.data);
          if(msg.type === 'done') {
            logD('Recording saved by server: '+msg.file, '#00ff88');
            if(msg.xml) logD('FCPXML saved: '+msg.xml, '#fcd34d');
            console.log('%c🎥 Recording saved! Check recordings/ folder.','color:#00ff88;font-size:14px;font-weight:bold;');
            if(msg.file) console.log('%c   Video: '+msg.file,'color:#00d4ff;');
            if(msg.xml) console.log('%c   XML:   '+msg.xml,'color:#ff9900;');
            const ovly = document.createElement('div');
            Object.assign(ovly.style, {
              position:'fixed', top:'50%', left:'50%', transform:'translate(-50%,-50%)',
              background:'#1e1e1e', padding:'30px', borderRadius:'16px', boxShadow:'0 20px 50px rgba(0,0,0,0.8)',
              zIndex:'999999', textAlign:'center', color:'#fff', fontFamily:'sans-serif', border:'1px solid #333'
            });
            let info = '<h2 style="margin:0 0 20px 0;color:#00ff88;">✅ Replay Complete!</h2>';
            info += '<div style="font-size:14px;color:#00d4ff;margin-bottom:10px;">Files saved to recordings/ folder:</div>';
            if(msg.file) info += '<div style="font-size:13px;color:#aaa;margin:4px 0;">🎬 '+msg.file+'</div>';
            if(msg.xml) info += '<div style="font-size:13px;color:#aaa;margin:4px 0;">📋 '+msg.xml+'</div>';
            info += '<button id="__rclose" style="margin-top:20px;background:transparent;border:none;color:#aaa;cursor:pointer;text-decoration:underline;">Close</button>';
            ovly.innerHTML = info;
            document.body.appendChild(ovly);
            document.getElementById('__rclose').onclick = () => ovly.remove();
            resolve();
          }
        } catch(e) { resolve(); }
      };
      setTimeout(() => { logD('Timeout waiting for server response.', '#ef4444'); resolve(); }, 15000);
    });
    recWs.close();
  }
})();
```

</details>

---

### 🎥 Screen Recording (ffmpeg)

External ffmpeg-based screen recording for ComfyUI Desktop (Electron). Bypasses `getDisplayMedia` limitations.

```bash
# Terminal 1: Start the recording server
npm run record

# Terminal 2: Paste generated script into ComfyUI DevTools console
# (with "Record Video" toggle enabled)
```

Records MP4 + generates FCPXML timeline for Premiere/Final Cut.

## How It Works

1. **Parses** the workflow JSON (`nodes` + `links` arrays)
2. **Topologically sorts** nodes so dependencies are created first
3. **Generates** timed build steps (either Playwright actions or JS code)
4. **Connects** nodes in dependency order

## Prerequisites

- **Node.js** ≥ 18
- **ComfyUI** running locally (for cursor replay)
- **ffmpeg** installed (for screen recording: `brew install ffmpeg`)
- All required models/checkpoints installed in ComfyUI
