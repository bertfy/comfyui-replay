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
