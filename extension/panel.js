// Side panel orchestrator (v0.2 — iframe-wraps the full generator)
//
// Flow when user clicks Record:
//   1. Look up Comfy tab id (deterministic via chrome.tabs.query)
//   2. Read generated script + workflow + narrations from the embedded generator
//      iframe (reaches into iframe.contentWindow.files)
//   3. Patch the script to use extension-supplied VO_AUDIO instead of trying to
//      fetch from localhost:3001 (which isn't running in the extension model)
//      and to skip its own record-server WebSocket (we record via tabCapture)
//   4. Build the VO map: bundled MP3 URLs (Example 1) or fresh ElevenLabs blobs
//      (any narration) — passed as data URLs so they survive executeScript args
//   5. Start chrome.tabCapture against the Comfy tab id — no share picker, no
//      ambiguity
//   6. Two-step inject: set window.__PREBUILT_VO_AUDIO, then run patched script
//   7. Poll for window.__comfyReplayRunning → false
//   8. Stop recording, save MP4/WebM via showSaveFilePicker

import { tts, getSettings, saveSettings, listVoices, cacheClear } from './lib/eleven.js';

// ─── Logging ─────────────────────────────────────────────────────────────────
const logEl = document.getElementById('log');
function log(msg, cls = '') {
  const ts = new Date().toISOString().split('T')[1].slice(0, 8);
  const line = document.createElement('div');
  if (cls) line.className = cls;
  line.textContent = `[${ts}] ${msg}`;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
  console.log('[panel]', msg);
}

// ─── Bundled audio cache keys (Example 1, sha256-derived) ─────────────────────
const BUNDLED_AUDIO_KEYS = {
  "1":           "869a903e5fb89f71",
  "2":           "7ac62e1b3e4f69a0",
  "3":           "67373c877f07b528",
  "4":           "5ae87f5aa7e3ef4b",
  "5":           "dd8104fc312c8b60",
  "6":           "6a2ee08509b19e2d",
  "7":           "b8ff5dc06645455b",
  "link_1_1_2_0": "f4cc181c18079222",
  "link_1_1_3_0": "a9db5da685a0800e",
  "link_1_0_5_0": "dac0d6f67a8c26d2",
  "link_4_0_5_3": "3c0e07e2e484c7ad",
  "link_3_0_5_1": "d582bc8a78e23329",
  "link_2_0_5_2": "8529e2e17e74d439",
  "link_5_0_6_0": "41d97d3a644e7aaf",
  "link_1_2_6_1": "f97f460618177b37",
  "link_6_0_7_0": "0a24cee846b0f939",
};

// ─── Comfy tab status (refresh every 2.5s) ───────────────────────────────────
let cachedComfyTabId = null;
async function refreshComfyStatus() {
  const lbl = document.getElementById('status-tab');
  try {
    const r = await chrome.runtime.sendMessage({ type: 'find-comfy-tab' });
    if (r && r.tab) {
      lbl.innerHTML = `<b>${escapeHtml(r.tab.title || 'ComfyUI')}</b> · #${r.tab.id}`;
      lbl.style.color = 'var(--ok)';
      cachedComfyTabId = r.tab.id;
    } else {
      lbl.innerHTML = '<b style="color:var(--warn)">no cloud.comfy.org tab open</b>';
      cachedComfyTabId = null;
    }
  } catch (e) {
    lbl.innerHTML = '<b style="color:var(--err)">error: ' + escapeHtml(e.message) + '</b>';
    cachedComfyTabId = null;
  }
}
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
refreshComfyStatus();
setInterval(refreshComfyStatus, 2500);

// ─── Cross-origin bridge to the sandboxed generator iframe ───────────────────
// The iframe is in a sandboxed (null) origin, so we can't reach .contentWindow.
// All access goes through postMessage. Each request has a unique id; the
// iframe echoes the id in its reply so we can match.
let bridgeReady = false;
const pendingReqs = new Map(); // id → { resolve, reject }
let nextReqId = 1;

function getIframeWindow() {
  const f = document.getElementById('gen-frame');
  return f && f.contentWindow;
}

function sendToGenerator(type, extra = {}, { timeoutMs = 8000 } = {}) {
  const id = String(nextReqId++);
  const w = getIframeWindow();
  if (!w) return Promise.reject(new Error('generator iframe not present'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingReqs.delete(id);
      reject(new Error(`generator timeout (${type})`));
    }, timeoutMs);
    pendingReqs.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject:  (e) => { clearTimeout(timer); reject(e); },
    });
    w.postMessage({ source: 'comfy-replay-panel', id, type, ...extra }, '*');
  });
}

window.addEventListener('message', (ev) => {
  const m = ev.data;
  if (!m || m.source !== 'comfy-replay-gen') return;
  if (m.type === 'bridge-ready') {
    bridgeReady = true;
    log('Generator bridge ready ✓', 'ok');
    return;
  }
  const pending = pendingReqs.get(m.id);
  if (!pending) return;
  pendingReqs.delete(m.id);
  pending.resolve(m);
});

async function pickGeneratorScript() {
  const r = await sendToGenerator('get-script');
  if (!r.ok) throw new Error(r.error || 'failed to read generator script');
  return { name: r.name, item: { script: r.script, narrations: r.narrations || {} } };
}

// ─── Patch the generated script for extension execution ──────────────────────
// Two surgical text replacements:
//   1. Replace `const VO_AUDIO = {};` so the IIFE picks up window.__PREBUILT_VO_AUDIO
//   2. Replace `await prefetchVO();` with a no-op that uses the pre-built map
//   3. Disable RECORD_VIDEO (we record from the panel via tabCapture, not via
//      the script's WS-to-localhost:3001 path)
function patchScriptForExtension(script) {
  let patched = script;
  let patches = 0;

  // 1. VO_AUDIO declaration → read from window
  const voAudioPattern = /const\s+VO_AUDIO\s*=\s*\{\}\s*;/;
  if (voAudioPattern.test(patched)) {
    patched = patched.replace(voAudioPattern, 'const VO_AUDIO = (window.__PREBUILT_VO_AUDIO || {});');
    patches++;
  }

  // 2. Skip prefetchVO call — VO_AUDIO is already populated by the extension
  const prefetchPattern = /if\s*\(\s*USE_AI_TIMING\s*&&\s*NARRATIONS\s*\)\s*\{\s*\n?\s*await\s+prefetchVO\(\)\s*;\s*\n?\s*\}/;
  if (prefetchPattern.test(patched)) {
    patched = patched.replace(prefetchPattern,
      `if (USE_AI_TIMING && NARRATIONS) {
        voReady = Object.keys(VO_AUDIO).length > 0;
        console.log('%c[ext] VO from extension: ' + Object.keys(VO_AUDIO).length + ' clips', 'color:#34d399;font-weight:bold;');
      }`);
    patches++;
  }

  // 3. Force RECORD_VIDEO=false (the panel records via tabCapture; the script's
  //    own ws://localhost:3001 path would just time out).
  patched = patched.replace(/const\s+RECORD_VIDEO\s*=\s*[^;]+;/, 'const RECORD_VIDEO = false;');
  patches++;

  // 4. Replace playVO with a Web Audio version that survives autoplay policy.
  //    chrome.scripting.executeScript carries the panel button's user gesture
  //    into the page, which lets us createAudioContext + resume() at script
  //    boot. Once the context is "running", all subsequent BufferSource
  //    playbacks work without further activation.
  const playVoPattern = /function\s+playVO\s*\(\s*id\s*\)\s*\{[\s\S]*?return\s+v\.durationMs;\s*\}/;
  if (playVoPattern.test(patched)) {
    patched = patched.replace(playVoPattern, `function playVO(id) {
    const v = VO_AUDIO[id];
    if (!v) return 0;
    // Web Audio path: decode-on-demand, cached per id. Activation was
    // established at script boot (see __WAKE_AUDIO block).
    try {
      if (!window.__voCtx) {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        window.__voCtx = new Ctx();
        window.__voBufCache = new Map();
      }
      const ctx = window.__voCtx;
      const cache = window.__voBufCache;
      if (ctx.state === 'suspended') { try { ctx.resume(); } catch(_){} }
      const playBuf = (buf) => {
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(ctx.destination);
        src.start();
      };
      if (cache.has(id)) {
        playBuf(cache.get(id));
      } else {
        fetch(v.audioUrl)
          .then(r => r.arrayBuffer())
          .then(ab => ctx.decodeAudioData(ab))
          .then(buf => { cache.set(id, buf); playBuf(buf); })
          .catch(e => console.error('[ext] VO fetch/decode failed for', id, ':', e.message));
      }
    } catch (e) {
      console.error('[ext] VO playback error:', e.message);
    }
    return v.durationMs;
  }`);
    patches++;
  }

  // 5. Prepend a user-activation wake at the very start of the IIFE — uses
  //    the fresh gesture from the panel click to put AudioContext into
  //    "running" state so later beats play without autoplay blocks.
  const iifePattern = /\(async function\s*\(\s*\)\s*\{/;
  if (iifePattern.test(patched)) {
    patched = patched.replace(iifePattern, `(async function() {
  // __WAKE_AUDIO: claim activation while the panel-button gesture is still
  // fresh. AudioContext needs an active gesture for its first resume(); once
  // it's running, BufferSourceNodes play freely.
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    window.__voCtx = new Ctx();
    window.__voBufCache = new Map();
    if (window.__voCtx.state === 'suspended') {
      await window.__voCtx.resume().catch(e => console.warn('[ext] AudioContext resume failed:', e.message));
    }
    console.log('%c[ext] AudioContext: ' + window.__voCtx.state, 'color:#5cd5fd;font-weight:bold;');
  } catch (e) { console.warn('[ext] AudioContext init failed:', e.message); }
`);
    patches++;
  }

  return { patched, patches };
}

// ─── Build the VO_AUDIO map (bundled OR ElevenLabs) ──────────────────────────
async function buildVoAudioMap({ source, narrations }) {
  const map = {}; // id → { audioKey, audioUrl, durationMs }

  if (source === 'none') return map;

  if (source === 'bundled') {
    // Use the 16 cached MP3s shipped inside the extension — works for the
    // example1 narrations only. Any narration id not in the bundle is skipped.
    for (const id of Object.keys(narrations || {})) {
      const key = BUNDLED_AUDIO_KEYS[id];
      if (!key) continue;
      const url = chrome.runtime.getURL(`audio/${key}.mp3`);
      const durationMs = await probeDuration(url);
      map[id] = { audioKey: key, audioUrl: url, durationMs };
    }
    return map;
  }

  if (source === 'elevenlabs') {
    const settings = await getSettings();
    const entries = Object.entries(narrations || {});
    log(`Fetching ${entries.length} clips from ElevenLabs (voice=${settings.voiceId})…`, 'info');
    let hit = 0, miss = 0, fail = 0;
    const results = await Promise.all(entries.map(async ([id, text]) => {
      try {
        const r = await tts(text, settings);
        return { id, ok: true, ...r };
      } catch (e) {
        return { id, ok: false, err: e.message };
      }
    }));
    for (const r of results) {
      if (!r.ok) { fail++; log(`  ✗ ${r.id}: ${r.err}`, 'err'); continue; }
      map[r.id] = { audioKey: r.key, audioUrl: r.dataUrl, durationMs: r.durationMs };
      if (r.fromCache) hit++; else miss++;
    }
    log(`ElevenLabs: ${hit} cached, ${miss} fetched, ${fail} failed`, fail ? 'warn' : 'ok');
    return map;
  }

  return map;
}

// ─── Probe an audio URL's duration (used for bundled MP3s) ───────────────────
async function probeDuration(url) {
  const resp = await fetch(url);
  const arr = await resp.arrayBuffer();
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const buf = await ctx.decodeAudioData(arr.slice(0));
  const ms = Math.round(buf.duration * 1000);
  try { ctx.close(); } catch(_){}
  return ms;
}

// ─── Recording: chrome.tabCapture (deterministic) or getDisplayMedia (picker) ─
async function startRecordingForTab(tabId, mode) {
  let stream;
  if (mode === 'tab') {
    // chrome.tabCapture.getMediaStreamId returns a stream id usable with
    // getUserMedia + chromeMediaSourceId. Hits the SPECIFIED tab — no picker.
    log(`Requesting tab capture stream id for tab #${tabId}…`, 'info');
    const streamId = await new Promise((res, rej) => {
      chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, id => {
        if (chrome.runtime.lastError) rej(new Error(chrome.runtime.lastError.message));
        else res(id);
      });
    });
    log(`Got stream id; opening media stream…`);
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId,
          maxFrameRate: 30,
        },
      },
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId,
        },
      },
    });
  } else if (mode === 'screen') {
    log('Picker mode — choose the Comfy tab + check "Share tab audio"', 'warn');
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 30 },
      audio: true,
      selfBrowserSurface: 'exclude',
    });
  } else {
    return null;
  }

  const hasAudio = stream.getAudioTracks().length > 0;
  log(`Stream: ${stream.getVideoTracks().length}v / ${stream.getAudioTracks().length}a`, hasAudio ? 'ok' : 'warn');

  // Prefer WebM/VP9 over MP4/avc1 — avc1 in MediaRecorder is intolerant of
  // resolution changes during a recording (Chrome warns and corrupts frames
  // when focus/devtools/window-size shifts the captured surface). WebM
  // handles it cleanly. We can transcode WebM→MP4 in a follow-up if needed.
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4;codecs=avc1',
  ];
  const mime = candidates.find(m => MediaRecorder.isTypeSupported(m)) || 'video/webm';
  log(`MediaRecorder mime: ${mime}`);

  const chunks = [];
  const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6_000_000 });
  recorder.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
  const stopped = new Promise(res => { recorder.onstop = res; });
  recorder.start(1000);
  log('Recording 🔴', 'ok');

  return {
    stream, recorder, mime,
    async stop() {
      try { recorder.stop(); } catch(_){}
      stream.getTracks().forEach(t => t.stop());
      await stopped;
      return new Blob(chunks, { type: mime });
    },
  };
}

// ─── Save to disk ────────────────────────────────────────────────────────────
async function saveBlob(blob, suggestedName) {
  try {
    if (window.showSaveFilePicker) {
      const baseMime = blob.type.split(';')[0].trim() || 'application/octet-stream';
      const ext = baseMime === 'video/mp4' ? '.mp4' : baseMime === 'video/webm' ? '.webm' : '.' + (suggestedName.split('.').pop() || 'bin');
      const handle = await window.showSaveFilePicker({
        suggestedName,
        types: [{ description: 'Video', accept: { [baseMime]: [ext] } }],
      });
      const w = await handle.createWritable();
      await w.write(blob);
      await w.close();
      log(`Saved → ${handle.name}`, 'ok');
      return;
    }
  } catch (e) {
    if (e.name !== 'AbortError') log(`showSaveFilePicker: ${e.message}`, 'warn');
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = suggestedName;
  a.click();
  log(`Downloaded → ${suggestedName}`, 'ok');
}

// ─── Poll for completion ─────────────────────────────────────────────────────
async function waitForReplayDone({ tabId, timeoutMs = 10 * 60 * 1000, onTick } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await new Promise(r => setTimeout(r, 1000));
    const r = await chrome.runtime.sendMessage({ type: 'probe', tabId });
    if (r && r.ok && r.result) {
      if (onTick) onTick(r.result, Date.now() - t0);
      if (r.result.done || (r.result.running === false && r.result.nodes > 0)) return r.result;
    }
  }
  return { timeout: true };
}

// ─── Main click handler ─────────────────────────────────────────────────────
let inFlight = false;
let currentRec = null;

document.getElementById('btn-record').addEventListener('click', async () => {
  if (inFlight) { log('Already running — wait or refresh', 'warn'); return; }
  inFlight = true;
  const recBtn = document.getElementById('btn-record');
  const stopBtn = document.getElementById('btn-stop');
  recBtn.disabled = true; recBtn.textContent = '⏳ Working…';
  stopBtn.disabled = false;

  const voSource = document.getElementById('opt-vo-source').value;
  const recMode  = document.getElementById('opt-record').value;

  try {
    // 1. Comfy tab
    if (!cachedComfyTabId) {
      await refreshComfyStatus();
      if (!cachedComfyTabId) throw new Error('No cloud.comfy.org tab open. Open one and log in first.');
    }
    log(`Target: cloud.comfy.org tab #${cachedComfyTabId}`, 'info');

    // 2. Read script from generator iframe (cross-origin postMessage)
    const { name, item } = await pickGeneratorScript();
    log(`Generator script: "${name}" — ${item.script.length} bytes, ${Object.keys(item.narrations || {}).length} narrations`, 'info');

    // 3. Build VO_AUDIO from selected source
    const voAudio = await buildVoAudioMap({ source: voSource, narrations: item.narrations });
    log(`VO map: ${Object.keys(voAudio).length} clips ready`, 'info');

    // 4. Patch the script for extension execution
    const { patched, patches } = patchScriptForExtension(item.script);
    log(`Patched generated script (${patches} substitutions)`, 'info');

    // 5. CRITICAL ORDER: focus Comfy tab FIRST so Chrome doesn't throttle it,
    //    then start recording. Inverted order produces a freeze-frame at the
    //    very start of the recording.
    log(`Focusing Comfy tab #${cachedComfyTabId}…`);
    await chrome.runtime.sendMessage({ type: 'focus-comfy' });
    await new Promise(r => setTimeout(r, 400)); // let tab become foreground + render a frame

    // 6. Start recording — targets the specific tab we captured above. No
    //    re-resolve. If the user switches tabs after this, the capture
    //    follows the tab id, not the foreground.
    currentRec = await startRecordingForTab(cachedComfyTabId, recMode);

    // 7. Inject — bg.js does two-step: set VO_AUDIO global, then load script.
    //    Pass the explicit tabId so bg uses the SAME tab we're capturing.
    log('Injecting patched script…', 'info');
    const injRes = await chrome.runtime.sendMessage({
      type: 'inject-script',
      tabId: cachedComfyTabId,
      script: patched,
      prebuiltVoAudio: voAudio,
    });
    if (!injRes || !injRes.ok) throw new Error('inject failed: ' + (injRes && injRes.error));
    log('Injection accepted ✓', 'ok');

    // 8. Wait for completion — same tabId
    log('Replay running…', 'info');
    let lastNodes = -1;
    const result = await waitForReplayDone({
      tabId: cachedComfyTabId,
      onTick: (state, ms) => {
        if (state.nodes !== lastNodes) {
          lastNodes = state.nodes;
          log(`  …${(ms/1000)|0}s · ${state.nodes} nodes on canvas`);
        }
      },
    });
    if (result.timeout) throw new Error('replay timed out');
    log('Replay finished ✓', 'ok');

    // 9. Brief tail so the recording captures the final frame
    await new Promise(r => setTimeout(r, 1500));

    // 10. Stop & save
    if (currentRec) {
      log('Stopping recording…', 'info');
      const blob = await currentRec.stop();
      log(`Blob: ${(blob.size/1024/1024).toFixed(2)} MB (${blob.type})`, 'ok');
      const ext = blob.type.includes('mp4') ? 'mp4' : 'webm';
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      await saveBlob(blob, `comfyui-replay-${ts}.${ext}`);
    }
    log('Done ✓', 'ok');
  } catch (e) {
    log('ERROR: ' + e.message, 'err');
    console.error(e);
    if (currentRec) {
      try {
        const b = await currentRec.stop();
        if (b.size > 0) await saveBlob(b, 'comfyui-replay-PARTIAL.' + (currentRec.mime.includes('mp4') ? 'mp4' : 'webm'));
      } catch(_){}
    }
  } finally {
    currentRec = null;
    inFlight = false;
    recBtn.disabled = false; recBtn.textContent = '▶ Record Replay';
    stopBtn.disabled = true;
  }
});

document.getElementById('btn-stop').addEventListener('click', async () => {
  if (currentRec) {
    log('User requested stop', 'warn');
    // Signal the Comfy tab to stop replay
    try {
      await chrome.runtime.sendMessage({
        type: 'inject-script',
        script: 'window.__replayStop = true; window.__comfyReplayStop = true;',
        prebuiltVoAudio: {},
      });
    } catch(_){}
  }
});

// ─── ElevenLabs Settings ─────────────────────────────────────────────────────
const elKey   = document.getElementById('el-key');
const elVoice = document.getElementById('el-voice');
const elModel = document.getElementById('el-model');
const elStatus = document.getElementById('el-status');

(async () => {
  const s = await getSettings();
  elKey.value = s.apiKey; elVoice.value = s.voiceId; elModel.value = s.model;
})();

document.getElementById('el-save').addEventListener('click', async () => {
  await saveSettings({ apiKey: elKey.value.trim(), voiceId: elVoice.value.trim(), model: elModel.value.trim() });
  elStatus.textContent = '✓ Saved'; elStatus.style.color = 'var(--ok)';
  log('ElevenLabs settings saved', 'ok');
  setTimeout(() => { elStatus.textContent = ''; }, 2500);
});

document.getElementById('el-list').addEventListener('click', async () => {
  try {
    const key = elKey.value.trim();
    if (!key) { elStatus.textContent = 'enter API key first'; elStatus.style.color = 'var(--warn)'; return; }
    elStatus.textContent = 'Fetching…';
    const voices = await listVoices(key);
    log(`ElevenLabs voices (${voices.length}):`, 'info');
    voices.slice(0, 15).forEach(v => log(`  ${v.voice_id} · ${v.category} · ${v.name}`));
    elStatus.textContent = `${voices.length} voices listed in log`; elStatus.style.color = 'var(--ok)';
  } catch (e) {
    elStatus.textContent = 'Error: ' + e.message; elStatus.style.color = 'var(--err)';
    log('listVoices failed: ' + e.message, 'err');
  }
});

document.getElementById('el-clear').addEventListener('click', async () => {
  await cacheClear();
  log('IndexedDB TTS cache cleared', 'ok');
});

// ─── Iframe load → bridge-ready handshake ────────────────────────────────────
const iframe = document.getElementById('gen-frame');
iframe.addEventListener('load', () => {
  log('Generator iframe loaded (waiting for bridge…)', 'info');
});

// ─── Auto-bootstrap: as soon as the bridge is ready, set up Example 1 + VO + AI Script
let bootstrapped = false;
async function autoBootstrap() {
  if (bootstrapped) return;
  bootstrapped = true;
  try {
    log('Auto-loading Example 1 into generator…', 'info');
    await sendToGenerator('click-example');
    await new Promise(r => setTimeout(r, 600));

    log('Enabling "AI Voice Over Timing" toggle…', 'info');
    await sendToGenerator('set-toggle', { elementId: 'ai-timing-toggle', checked: true });
    await new Promise(r => setTimeout(r, 300));

    log('Loading pre-baked AI Script narrations…', 'info');
    await sendToGenerator('click-ai-script');
    await new Promise(r => setTimeout(r, 1500)); // give the regenerateAll() pass time to finish

    log('Generator pre-configured · click ▶ Record Replay when ready', 'ok');
  } catch (e) {
    log('Auto-bootstrap error: ' + e.message + ' — fall back to manual setup in the iframe', 'warn');
    bootstrapped = false;
  }
}

// Patch the message listener to trigger bootstrap on bridge-ready
const origListener = window.onmessage; // unused; we use addEventListener
window.addEventListener('message', (ev) => {
  const m = ev.data;
  if (m && m.source === 'comfy-replay-gen' && m.type === 'bridge-ready' && !bootstrapped) {
    // Small delay to let the generator's own scripts finish their async init
    setTimeout(autoBootstrap, 400);
  }
});

// ─── Manual re-bootstrap button (for when the user changes workflow) ─────────
const reloadBtn = document.createElement('button');
reloadBtn.textContent = '↻ Reload Example';
reloadBtn.style.cssText = 'font-size:11px; padding:3px 8px;';
reloadBtn.title = 'Re-run Example 1 setup (clears workflow and re-loads narrations)';
reloadBtn.addEventListener('click', async () => {
  bootstrapped = false;
  await autoBootstrap();
});
document.querySelector('.toolbar').appendChild(reloadBtn);

log('Panel ready · v0.3 (auto-bootstrap + deterministic capture)', 'ok');
