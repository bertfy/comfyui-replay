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
        const tab = await findComfyTab();
        if (!tab) { sendResponse({ ok: false, error: 'no comfy tab' }); return; }

        // Two-step injection (avoids needing eval/new Function which both
        // extension CSP and cloud.comfy.org's CSP would block):
        //
        //   1. Set window.__comfyReplayInput in MAIN world via func+args
        //   2. Load lib/runner.js as a file into MAIN world — it reads
        //      __comfyReplayInput on entry and runs.
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

      if (msg.type === 'probe') {
        const tab = await findComfyTab();
        if (!tab) { sendResponse({ ok: false, error: 'no comfy tab' }); return; }
        try {
          const r = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            world: 'MAIN',
            func: () => ({
              running: !!window.__comfyReplayRunning,
              done:    !!window.__comfyReplayDone,
              err:     window.__comfyReplayErr || null,
              nodes:   (window.app && window.app.graph && window.app.graph._nodes) ? window.app.graph._nodes.length : -1,
            }),
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
