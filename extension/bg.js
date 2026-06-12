// Service worker — opens side panel on icon click, bridges script injection
// from the panel to the active Comfy tab.

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
  .catch(e => console.error('sidePanel.setPanelBehavior failed:', e));

async function findComfyTab() {
  const tabs = await chrome.tabs.query({ url: 'https://cloud.comfy.org/*' });
  if (!tabs.length) return null;
  tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
  return tabs.find(t => t.active) || tabs[0];
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === 'find-comfy-tab') {
        const tab = await findComfyTab();
        sendResponse({ tab: tab ? { id: tab.id, url: tab.url, title: tab.title, windowId: tab.windowId } : null });
        return;
      }

      if (msg.type === 'focus-comfy') {
        const tab = await findComfyTab();
        if (!tab) { sendResponse({ ok: false, error: 'no comfy tab' }); return; }
        await chrome.tabs.update(tab.id, { active: true });
        await chrome.windows.update(tab.windowId, { focused: true });
        sendResponse({ ok: true, tab: { id: tab.id } });
        return;
      }

      if (msg.type === 'inject') {
        // Legacy path (v0.1 MVP runner) — kept for back-compat in case anything
        // still calls it. New flow uses 'inject-script' below.
        const tab = await findComfyTab();
        if (!tab) { sendResponse({ ok: false, error: 'no comfy tab' }); return; }
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            world: 'MAIN',
            func: (input) => { window.__comfyReplayInput = input; },
            args: [msg.input],
          });
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            world: 'MAIN',
            files: ['lib/runner.js'],
          });
          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({ ok: false, error: e.message });
        }
        return;
      }

      if (msg.type === 'inject-script') {
        // v0.2 path: inject the full index.html-generated replay script
        // (after panel-side patching). Two steps so we can prime the VO map
        // BEFORE the script's IIFE evaluates its const VO_AUDIO = window.__PREBUILT_VO_AUDIO || {}.
        // CRITICAL: panel passes explicit tabId so capture and inject target
        // the same tab — otherwise findComfyTab() can return different tabs
        // between calls, causing silent recordings of an empty tab.
        let tab = null;
        if (typeof msg.tabId === 'number') {
          try { tab = await chrome.tabs.get(msg.tabId); } catch (_) { /* fall through */ }
        }
        if (!tab) tab = await findComfyTab();
        if (!tab) { sendResponse({ ok: false, error: 'no comfy tab' }); return; }
        try {
          // 1. Set window.__PREBUILT_VO_AUDIO in MAIN world
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            world: 'MAIN',
            func: (voMap) => {
              window.__PREBUILT_VO_AUDIO = voMap || {};
              // Reset replay flags so any prior partial run doesn't block us
              window.__comfyReplayDone = false;
              window.__comfyReplayErr  = null;
            },
            args: [msg.prebuiltVoAudio || {}],
          });
          // 2. Execute the patched generator script. Use the inline `func`
          //    pattern with the script as an arg + an indirect Function() call
          //    — but cloud.comfy.org's CSP may block that. Safer path: write
          //    the script to a one-shot blob URL in the extension and inject
          //    via files. But chrome.scripting.executeScript files: requires
          //    paths INSIDE the extension package, not arbitrary blobs.
          //
          //    Use the args+func trick: stash the script as a string on window,
          //    then evaluate via a <script> tag with textContent — which uses
          //    the page's own script-src self policy (cloud.comfy.org allows
          //    inline scripts; if it doesn't we'll discover and switch tactics).
          const ret = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            world: 'MAIN',
            func: (scriptText) => {
              try {
                const s = document.createElement('script');
                s.textContent = scriptText;
                (document.head || document.documentElement).appendChild(s);
                s.remove();
                return { ok: true };
              } catch (e) {
                return { ok: false, error: e.message, stack: e.stack };
              }
            },
            args: [msg.script],
          });
          const r = ret[0]?.result;
          if (r && r.ok === false) {
            sendResponse({ ok: false, error: 'inject-script error: ' + r.error });
            return;
          }
          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({ ok: false, error: e.message });
        }
        return;
      }

      if (msg.type === 'survey-graph') {
        // JSON-safe snapshot of the live graph: groups, nodes (with widget
        // values truncated), links, and the current viewport. Feeds the
        // panel-side shot-list planner.
        let tab = null;
        if (typeof msg.tabId === 'number') {
          try { tab = await chrome.tabs.get(msg.tabId); } catch (_) {}
        }
        if (!tab) tab = await findComfyTab();
        if (!tab) { sendResponse({ ok: false, error: 'no comfy tab' }); return; }
        try {
          const r = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            world: 'MAIN',
            func: () => {
              const app = window.app;
              if (!app || !app.graph) return { ok: false, error: 'no app.graph' };
              const arr = v => (v && typeof v.length === 'number') ? Array.from(v) : [0, 0, 0, 0];
              const groupsRaw = app.graph._groups || app.graph.groups || [];
              const groups = [...groupsRaw].map((g, i) => ({
                id: i,
                title: String(g.title || ('Group ' + (i + 1))),
                bounding: arr(g.bounding || g._bounding).slice(0, 4),
                color: g.color || null,
              }));
              const nodes = (app.graph._nodes || []).map(n => {
                const widgets = (n.widgets || []).map(w => ({
                  name: w.name || null,
                  type: w.type || null,
                  value: typeof w.value === 'string' ? w.value.slice(0, 300)
                       : (typeof w.value === 'number' || typeof w.value === 'boolean') ? w.value : null,
                }));
                let inDeg = 0, outDeg = 0;
                (n.inputs || []).forEach(i2 => { if (i2 && i2.link != null) inDeg++; });
                (n.outputs || []).forEach(o => { if (o && o.links) outDeg += o.links.length; });
                return {
                  id: n.id, type: String(n.type || ''),
                  title: String(n.title || n.type || ''),
                  pos: arr(n.pos).slice(0, 2), size: arr(n.size).slice(0, 2),
                  widgets,
                  hasImage: !!((n.imgs && n.imgs.length) || n.previewMediaType),
                  inDeg, outDeg,
                  collapsed: !!(n.flags && n.flags.collapsed),
                };
              });
              const links = [];
              const lm = app.graph.links;
              if (lm) {
                const vals = (typeof lm.values === 'function') ? [...lm.values()] : Object.values(lm);
                for (const l of vals) {
                  if (l && l.origin_id != null) links.push({ id: l.id, origin: l.origin_id, target: l.target_id });
                }
              }
              const ds = app.canvas && app.canvas.ds;
              return {
                ok: true, groups, nodes, links,
                view: ds ? { scale: ds.scale, offset: arr(ds.offset).slice(0, 2) } : null,
                viewport: { w: window.innerWidth, h: window.innerHeight },
              };
            },
          });
          sendResponse({ ok: true, survey: r[0]?.result });
        } catch (e) {
          sendResponse({ ok: false, error: e.message });
        }
        return;
      }

      if (msg.type === 'load-workflow') {
        // Load a workflow JSON into the LIVE graph (debug/test path) — the
        // inverse of serialize-graph. Uses the frontend's own loader so
        // groups, links and widget values land exactly as from a file open.
        let tab = null;
        if (typeof msg.tabId === 'number') {
          try { tab = await chrome.tabs.get(msg.tabId); } catch (_) {}
        }
        if (!tab) tab = await findComfyTab();
        if (!tab) { sendResponse({ ok: false, error: 'no comfy tab' }); return; }
        try {
          const r = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            world: 'MAIN',
            func: async (wf) => {
              try {
                const app = window.app;
                if (!app || typeof app.loadGraphData !== 'function') return { ok: false, error: 'app.loadGraphData unavailable' };
                await app.loadGraphData(wf);
                return { ok: true, nodes: (app.graph && app.graph._nodes || []).length };
              } catch (e) { return { ok: false, error: e.message }; }
            },
            args: [msg.workflow],
          });
          sendResponse({ ok: true, result: r[0]?.result });
        } catch (e) {
          sendResponse({ ok: false, error: e.message });
        }
        return;
      }

      if (msg.type === 'serialize-graph') {
        // Full LiteGraph workflow JSON of the LIVE graph — identical shape to
        // a dropped .json file (widgets_values, links with slots, groups).
        // Feeds one-click Build: rebuild the workflow that's already open.
        let tab = null;
        if (typeof msg.tabId === 'number') {
          try { tab = await chrome.tabs.get(msg.tabId); } catch (_) {}
        }
        if (!tab) tab = await findComfyTab();
        if (!tab) { sendResponse({ ok: false, error: 'no comfy tab' }); return; }
        try {
          const r = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            world: 'MAIN',
            func: () => {
              try {
                const app = window.app;
                if (!app || !app.graph) return { ok: false, error: 'no app.graph' };
                if (typeof app.graph.serialize !== 'function') return { ok: false, error: 'graph.serialize unavailable' };
                // JSON round-trip strips TypedArrays/functions so the payload
                // survives the executeScript bridge.
                const wf = JSON.parse(JSON.stringify(app.graph.serialize()));
                return { ok: true, workflow: wf, title: document.title || 'workflow', nodeCount: (wf.nodes || []).length };
              } catch (e) { return { ok: false, error: e.message }; }
            },
          });
          sendResponse({ ok: true, result: r[0]?.result });
        } catch (e) {
          sendResponse({ ok: false, error: e.message });
        }
        return;
      }

      if (msg.type === 'inject-tour') {
        // Tour mode: set the input globals, then inject the static engine
        // files (no string templating / regex patching — the whole point).
        let tab = null;
        if (typeof msg.tabId === 'number') {
          try { tab = await chrome.tabs.get(msg.tabId); } catch (_) {}
        }
        if (!tab) tab = await findComfyTab();
        if (!tab) { sendResponse({ ok: false, error: 'no comfy tab' }); return; }
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            world: 'MAIN',
            func: (input) => {
              window.__comfyTourInput = input;
              window.__comfyReplayDone = false;
              window.__comfyReplayErr = null;
              window.__extBeatIdx = 0;
              window.__extBeatLabel = null;
              window.__extPhase = null;
              // A finished Build replay leaves __replayRunning === false, which
              // the probe treats as "replay done" — clear it so a Tour isn't
              // declared complete on the first poll.
              window.__replayRunning = undefined;
            },
            args: [msg.input],
          });
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            world: 'MAIN',
            files: ['lib/motion.js', 'lib/tour.js'],
          });
          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({ ok: false, error: e.message });
        }
        return;
      }

      if (msg.type === 'prepare-window') {
        // "Set window to 1080p" helper — resize the Comfy tab's window so the
        // tab viewport lands at exactly targetW×targetH (default 1920×1080).
        // Probe the current viewport, compute chrome (toolbars etc.) overhead,
        // then resize the window by the delta.
        const targetW = msg.width || 1920, targetH = msg.height || 1080;
        const tab = await findComfyTab();
        if (!tab) { sendResponse({ ok: false, error: 'no comfy tab' }); return; }
        try {
          const probeViewport = async () => {
            const r = await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              func: () => ({ w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio }),
            });
            return r[0]?.result;
          };
          const win = await chrome.windows.get(tab.windowId);
          if (win.state === 'maximized' || win.state === 'fullscreen') {
            await chrome.windows.update(tab.windowId, { state: 'normal' });
            await new Promise(r => setTimeout(r, 150));
          }
          let vp = await probeViewport();
          if (!vp) { sendResponse({ ok: false, error: 'viewport probe failed' }); return; }
          // Two passes: chrome overhead can change after the first resize
          for (let i = 0; i < 2 && (vp.w !== targetW || vp.h !== targetH); i++) {
            const cur = await chrome.windows.get(tab.windowId);
            await chrome.windows.update(tab.windowId, {
              width:  cur.width  + (targetW - vp.w),
              height: cur.height + (targetH - vp.h),
            });
            await new Promise(r => setTimeout(r, 200));
            vp = await probeViewport();
          }
          sendResponse({ ok: vp.w === targetW && vp.h === targetH, viewport: vp });
        } catch (e) {
          sendResponse({ ok: false, error: e.message });
        }
        return;
      }

      if (msg.type === 'probe') {
        let tab = null;
        if (typeof msg.tabId === 'number') {
          try { tab = await chrome.tabs.get(msg.tabId); } catch (_) { /* fall through */ }
        }
        if (!tab) tab = await findComfyTab();
        if (!tab) { sendResponse({ ok: false, error: 'no comfy tab' }); return; }
        try {
          const r = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            world: 'MAIN',
            func: () => {
              const running = !!(window.__replayRunning || window.__comfyReplayRunning);
              const done    = !!window.__comfyReplayDone || (window.__replayRunning === false && window.app?.graph?._nodes?.length > 0);
              return {
                running,
                done,
                err: window.__comfyReplayErr || null,
                nodes: (window.app && window.app.graph && window.app.graph._nodes) ? window.app.graph._nodes.length : -1,
                // Beat progress exposed by the patched recStep — see panel.js patcher
                beatIdx:   window.__extBeatIdx || 0,
                beatLabel: window.__extBeatLabel || null,
                // 'waiting' while a cloud render runs post-VO — the panel
                // pauses the MediaRecorder for the duration.
                phase:     window.__extPhase || null,
              };
            },
          });
          sendResponse({ ok: true, result: r[0]?.result });
        } catch (e) {
          sendResponse({ ok: false, error: e.message });
        }
        return;
      }
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
  })();
  return true; // async response
});
