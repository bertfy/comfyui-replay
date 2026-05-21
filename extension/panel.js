// Side panel orchestrator — v0.4 (state pill + progress card + cleaner UX)
//
// Lifecycle: panel loads → iframe loads → bridge-ready postMessage →
// auto-bootstrap (load Example 1, enable AI VO Timing, click AI Script) →
// state = ready → user clicks Record.

import { tts, getSettings, saveSettings, listVoices, cacheClear } from './lib/eleven.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const logEl = $('log');
function log(msg, cls = '') {
  const ts = new Date().toISOString().split('T')[1].slice(0, 8);
  const line = document.createElement('div');
  if (cls) line.className = cls;
  line.textContent = `[${ts}] ${msg}`;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
  console.log('[panel]', msg);
}
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function fmtTime(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`;
}

// ─── State pill ──────────────────────────────────────────────────────────────
// Short, scannable labels for the small state pill — long copy reduces
// legibility at this size. Override via setState(status, longerText) when
// the extra detail matters mid-flow.
const STATES = {
  setup:      { text: 'Setup' },
  ready:      { text: 'Ready' },
  recording:  { text: 'Recording' },
  saving:     { text: 'Saving' },
  done:       { text: 'Done' },
  error:      { text: 'Error' },
};
let currentStatus = 'setup';
function setState(status, textOverride) {
  currentStatus = status;
  const pill = $('state-pill');
  pill.setAttribute('data-status', status);
  $('state-text').textContent = textOverride || STATES[status]?.text || status;
  // Record button only enabled in 'ready' or 'done'
  $('btn-record').disabled = !(status === 'ready' || status === 'done' || status === 'error');
  // Stop only enabled while recording
  $('btn-stop').disabled = status !== 'recording';
}

// ─── Comfy tab status ────────────────────────────────────────────────────────
let cachedComfyTabId = null;
async function refreshComfyStatus() {
  const info = $('tab-info'), lbl = $('tab-label');
  try {
    const r = await chrome.runtime.sendMessage({ type: 'find-comfy-tab' });
    if (r && r.tab) {
      lbl.innerHTML = `<b>${escapeHtml(r.tab.title || 'ComfyUI')}</b> · tab #${r.tab.id}`;
      info.className = 'connected';
      cachedComfyTabId = r.tab.id;
    } else {
      lbl.innerHTML = 'No <b>cloud.comfy.org</b> tab open';
      info.className = 'disconnected';
      cachedComfyTabId = null;
    }
  } catch (e) {
    lbl.textContent = 'error: ' + e.message;
    info.className = 'disconnected';
    cachedComfyTabId = null;
  }
}
refreshComfyStatus();
setInterval(refreshComfyStatus, 2500);

// ─── Bundled audio cache keys (Example 1, sha256-derived) ────────────────────
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

// ─── Generator iframe bridge (postMessage) ───────────────────────────────────
const pendingReqs = new Map();
let nextReqId = 1;
let bridgeReady = false;

function getIframeWindow() {
  const f = $('gen-frame');
  return f && f.contentWindow;
}
function sendToGenerator(type, extra = {}, { timeoutMs = 8000 } = {}) {
  const id = String(nextReqId++);
  const w = getIframeWindow();
  if (!w) return Promise.reject(new Error('generator iframe not present'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pendingReqs.delete(id); reject(new Error(`generator timeout (${type})`)); }, timeoutMs);
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
    if (bridgeReady) return; // ignore repeats
    bridgeReady = true;
    log('Generator bridge ready ✓', 'ok');
    setTimeout(autoBootstrap, 400);
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

// ─── Auto-bootstrap ─────────────────────────────────────────────────────────
let bootstrapped = false;
async function autoBootstrap() {
  if (bootstrapped) return;
  bootstrapped = true;
  try {
    setState('setup', 'Loading example…');
    await sendToGenerator('click-example');
    await new Promise(r => setTimeout(r, 600));

    setState('setup', 'Enabling VO timing…');
    await sendToGenerator('set-toggle', { elementId: 'ai-timing-toggle', checked: true });
    await new Promise(r => setTimeout(r, 250));

    setState('setup', 'Loading narrations…');
    await sendToGenerator('click-ai-script');
    await new Promise(r => setTimeout(r, 1400));

    setState('ready');
    log('Generator ready — click Record', 'ok');
    // Refresh the VO Script tab badge with the narration count
    refreshScriptBadge();
  } catch (e) {
    setState('error', 'Setup failed');
    log('Auto-bootstrap error: ' + e.message, 'err');
    bootstrapped = false;
  }
}

// ─── Patch the generated script for extension execution ──────────────────────
function patchScriptForExtension(script) {
  let patched = script;
  let patches = 0;

  // 1. VO_AUDIO declaration → read from window
  if (/const\s+VO_AUDIO\s*=\s*\{\}\s*;/.test(patched)) {
    patched = patched.replace(/const\s+VO_AUDIO\s*=\s*\{\}\s*;/, 'const VO_AUDIO = (window.__PREBUILT_VO_AUDIO || {});');
    patches++;
  }

  // 2. Skip prefetchVO — VO_AUDIO is already populated
  const prefetchPattern = /if\s*\(\s*USE_AI_TIMING\s*&&\s*NARRATIONS\s*\)\s*\{\s*\n?\s*await\s+prefetchVO\(\)\s*;\s*\n?\s*\}/;
  if (prefetchPattern.test(patched)) {
    patched = patched.replace(prefetchPattern,
      `if (USE_AI_TIMING && NARRATIONS) {
        voReady = Object.keys(VO_AUDIO).length > 0;
        console.log('%c[ext] VO from extension: ' + Object.keys(VO_AUDIO).length + ' clips', 'color:#34d399;font-weight:bold;');
      }`);
    patches++;
  }

  // 3. Force RECORD_VIDEO=false (panel handles capture)
  patched = patched.replace(/const\s+RECORD_VIDEO\s*=\s*[^;]+;/, 'const RECORD_VIDEO = false;');
  patches++;

  // 4. Replace playVO with Web Audio (autoplay-resilient)
  const playVoPattern = /function\s+playVO\s*\(\s*id\s*\)\s*\{[\s\S]*?return\s+v\.durationMs;\s*\}/;
  if (playVoPattern.test(patched)) {
    patched = patched.replace(playVoPattern, `function playVO(id) {
    const v = VO_AUDIO[id];
    if (!v) return 0;
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
      if (cache.has(id)) playBuf(cache.get(id));
      else {
        fetch(v.audioUrl)
          .then(r => r.arrayBuffer())
          .then(ab => ctx.decodeAudioData(ab))
          .then(buf => { cache.set(id, buf); playBuf(buf); })
          .catch(e => console.error('[ext] VO decode failed for', id, ':', e.message));
      }
    } catch (e) { console.error('[ext] VO playback error:', e.message); }
    return v.durationMs;
  }`);
    patches++;
  }

  // 5. Wake AudioContext at IIFE start (gesture still fresh)
  if (/\(async function\s*\(\s*\)\s*\{/.test(patched)) {
    patched = patched.replace(/\(async function\s*\(\s*\)\s*\{/, `(async function() {
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

  // 6. Expose progress on window so the panel probe can read it.
  //    Wrap recStep so each call updates __extBeatLabel and __extBeatIdx.
  if (/function\s+recStep\s*\(\s*name\s*,\s*voId\s*\)\s*\{/.test(patched)) {
    patched = patched.replace(/function\s+recStep\s*\(\s*name\s*,\s*voId\s*\)\s*\{/,
      `function recStep(name, voId) {
    // [ext] expose progress to the panel
    window.__extBeatLabel = name;
    window.__extBeatIdx = (window.__extBeatIdx || 0) + 1;
`);
    patches++;
  }
  // Reset the counter at IIFE start so reruns don't accumulate
  patched = patched.replace(/window\.__voCtx = new Ctx\(\);/, `window.__voCtx = new Ctx();
    window.__extBeatLabel = null;
    window.__extBeatIdx = 0;`);

  return { patched, patches };
}

// ─── Build VO map (bundled / ElevenLabs / none) ─────────────────────────────
async function buildVoAudioMap({ source, narrations }) {
  const map = {};
  if (source === 'none') return map;

  if (source === 'bundled') {
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
      try { return { id, ok: true, ...(await tts(text, settings)) }; }
      catch (e) { return { id, ok: false, err: e.message }; }
    }));
    for (const r of results) {
      if (!r.ok) { fail++; log(`  ✗ ${r.id}: ${r.err}`, 'err'); continue; }
      map[r.id] = { audioKey: r.key, audioUrl: r.dataUrl, durationMs: r.durationMs };
      if (r.fromCache) hit++; else miss++;
    }
    log(`ElevenLabs: ${hit} cached · ${miss} fetched · ${fail} failed`, fail ? 'warn' : 'ok');
  }
  return map;
}

async function probeDuration(url) {
  const resp = await fetch(url);
  const arr = await resp.arrayBuffer();
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const buf = await ctx.decodeAudioData(arr.slice(0));
  const ms = Math.round(buf.duration * 1000);
  try { ctx.close(); } catch(_){}
  return ms;
}

// ─── Recording ───────────────────────────────────────────────────────────────
async function startRecordingForTab(tabId, mode) {
  let stream;
  if (mode === 'tab') {
    log(`Tab capture for #${tabId}…`, 'info');
    const streamId = await new Promise((res, rej) => {
      chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, id => {
        if (chrome.runtime.lastError) rej(new Error(chrome.runtime.lastError.message));
        else res(id);
      });
    });
    stream = await navigator.mediaDevices.getUserMedia({
      video: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId, maxFrameRate: 30 } },
      audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
    });
  } else if (mode === 'screen') {
    log('Picker mode — choose the Comfy tab + "Share tab audio"', 'warn');
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 30 }, audio: true, selfBrowserSurface: 'exclude',
    });
  } else return null;

  log(`Stream: ${stream.getVideoTracks().length}v / ${stream.getAudioTracks().length}a`, stream.getAudioTracks().length ? 'ok' : 'warn');

  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4;codecs=avc1',
  ];
  const mime = candidates.find(m => MediaRecorder.isTypeSupported(m)) || 'video/webm';
  log(`MIME: ${mime}`);

  const chunks = [];
  const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6_000_000 });
  recorder.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
  const stopped = new Promise(res => { recorder.onstop = res; });
  recorder.start(1000);

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
    if (e.name !== 'AbortError') log(`saveFilePicker: ${e.message}`, 'warn');
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = suggestedName;
  a.click();
  log(`Downloaded → ${suggestedName}`, 'ok');
}

// ─── Progress card ──────────────────────────────────────────────────────────
function showProgress() {
  $('progress').classList.add('show');
  $('progress-beat').textContent = 'Waiting for first beat…';
  $('progress-counter').textContent = '0/0';
  $('progress-time').textContent = '0:00';
  $('pbar-fill').style.width = '0%';
}
function hideProgress() { $('progress').classList.remove('show'); }
function updateProgress({ beat, idx, total, elapsedMs }) {
  if (beat) $('progress-beat').textContent = beat;
  if (idx != null && total) $('progress-counter').textContent = `${idx}/${total}`;
  $('progress-time').textContent = fmtTime(elapsedMs);
  if (total) $('pbar-fill').style.width = `${Math.min(100, (idx / total) * 100)}%`;
}

// ─── Probe poll ──────────────────────────────────────────────────────────────
async function waitForReplayDone({ tabId, total, onTick, timeoutMs = 10 * 60 * 1000 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await new Promise(r => setTimeout(r, 700));
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

$('btn-record').addEventListener('click', async () => {
  if (inFlight) { log('Already running', 'warn'); return; }
  inFlight = true;

  const voSource = $('opt-vo-source').value;
  const recMode  = $('opt-record').value;

  try {
    if (!cachedComfyTabId) {
      await refreshComfyStatus();
      if (!cachedComfyTabId) throw new Error('No cloud.comfy.org tab open');
    }

    // Auto-switch to Record tab so the user always sees progress
    activateTab('record');

    setState('recording', 'Preparing…');
    const { name, item } = await pickGeneratorScript();
    log(`Script: "${name}" — ${item.script.length}B · ${Object.keys(item.narrations).length} narrations`);

    const voAudio = await buildVoAudioMap({ source: voSource, narrations: item.narrations });
    const { patched, patches } = patchScriptForExtension(item.script);
    log(`Patched (${patches}) · VO map: ${Object.keys(voAudio).length} clips`);

    setState('recording', 'Focusing tab…');
    await chrome.runtime.sendMessage({ type: 'focus-comfy' });
    await new Promise(r => setTimeout(r, 400));

    setState('recording', 'Starting capture…');
    currentRec = await startRecordingForTab(cachedComfyTabId, recMode);

    setState('recording');
    showProgress();
    const totalBeats = Object.keys(item.narrations || {}).length || 1;

    log('Injecting…', 'info');
    const injRes = await chrome.runtime.sendMessage({
      type: 'inject-script', tabId: cachedComfyTabId, script: patched, prebuiltVoAudio: voAudio,
    });
    if (!injRes || !injRes.ok) throw new Error('inject failed: ' + (injRes && injRes.error));

    let lastIdx = 0;
    const result = await waitForReplayDone({
      tabId: cachedComfyTabId, total: totalBeats,
      onTick: (state, ms) => {
        const idx = state.beatIdx || lastIdx;
        if (idx > lastIdx) lastIdx = idx;
        updateProgress({
          beat: state.beatLabel || `Beat ${idx}`,
          idx, total: totalBeats, elapsedMs: ms,
        });
      },
    });
    if (result.timeout) throw new Error('replay timed out');

    setState('saving', 'Finalizing…');
    await new Promise(r => setTimeout(r, 1500)); // tail capture

    if (currentRec) {
      const blob = await currentRec.stop();
      log(`Blob: ${(blob.size/1024/1024).toFixed(2)} MB (${blob.type})`, 'ok');
      const ext = blob.type.includes('mp4') ? 'mp4' : 'webm';
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      await saveBlob(blob, `comfyui-replay-${ts}.${ext}`);
    }
    setState('done');
  } catch (e) {
    setState('error', e.message.slice(0, 30));
    log('ERROR: ' + e.message, 'err');
    console.error(e);
    if (currentRec) {
      try { const b = await currentRec.stop(); if (b.size > 0) await saveBlob(b, 'comfyui-replay-PARTIAL.' + (currentRec.mime.includes('mp4') ? 'mp4' : 'webm')); } catch(_){}
    }
  } finally {
    currentRec = null;
    inFlight = false;
    hideProgress();
  }
});

$('btn-stop').addEventListener('click', async () => {
  log('Stop requested', 'warn');
  try {
    await chrome.runtime.sendMessage({
      type: 'inject-script',
      tabId: cachedComfyTabId,
      script: 'window.__replayStop = true; window.__comfyReplayStop = true;',
      prebuiltVoAudio: {},
    });
  } catch(_){}
});

$('btn-reload').addEventListener('click', async () => {
  bootstrapped = false;
  setState('setup', 'Reloading…');
  await autoBootstrap();
});

// ─── AI VO Generation — provider switcher ────────────────────────────────────
const voProviderSelect = $('vo-provider');

function showProviderFields(provider) {
  for (const el of document.querySelectorAll('[data-provider-fields]')) {
    el.style.display = el.dataset.providerFields === provider ? 'flex' : 'none';
  }
}

voProviderSelect.addEventListener('change', async () => {
  const next = voProviderSelect.value;
  showProviderFields(next);
  try { await chrome.storage.sync.set({ vo_provider: next }); } catch(_){}
  log(`VO provider: ${next}`, 'info');
});

chrome.storage.sync.get(['vo_provider']).then(({ vo_provider }) => {
  const p = vo_provider || 'elevenlabs';
  voProviderSelect.value = p;
  showProviderFields(p);
});

// AI Script Writing deep-link to the iframe form
$('link-ai-script')?.addEventListener('click', (e) => {
  e.preventDefault();
  activateTab('script');
});

// ─── ElevenLabs settings (loaded for the elevenlabs provider) ────────────────
(async () => {
  const s = await getSettings();
  $('el-key').value = s.apiKey;
  $('el-voice').value = s.voiceId;
  $('el-model').value = s.model;
})();

// ─── ComfyUI VO settings (stub — wire the actual TTS workflow when ready) ────
const cfVoFields = {
  endpoint: $('cf-vo-endpoint'),
  token:    $('cf-vo-token'),
  voice:    $('cf-vo-voice'),
  model:    $('cf-vo-model'),
};
const cfVoStatus = $('cf-vo-status');

(async () => {
  const v = await chrome.storage.sync.get(['cf_vo_endpoint', 'cf_vo_token', 'cf_vo_voice', 'cf_vo_model']);
  if (cfVoFields.endpoint) cfVoFields.endpoint.value = v.cf_vo_endpoint || '';
  if (cfVoFields.token)    cfVoFields.token.value    = v.cf_vo_token    || '';
  if (cfVoFields.voice)    cfVoFields.voice.value    = v.cf_vo_voice    || '';
  if (cfVoFields.model)    cfVoFields.model.value    = v.cf_vo_model    || '';
})();

$('cf-vo-save')?.addEventListener('click', async () => {
  await chrome.storage.sync.set({
    cf_vo_endpoint: cfVoFields.endpoint.value.trim(),
    cf_vo_token:    cfVoFields.token.value.trim(),
    cf_vo_voice:    cfVoFields.voice.value.trim(),
    cf_vo_model:    cfVoFields.model.value.trim(),
  });
  cfVoStatus.textContent = '✓ Saved';
  cfVoStatus.style.color = 'var(--ok)';
  log('ComfyUI VO settings saved', 'ok');
  setTimeout(() => { cfVoStatus.textContent = ''; }, 2500);
});

$('cf-vo-test')?.addEventListener('click', async () => {
  const endpoint = cfVoFields.endpoint.value.trim();
  if (!endpoint) {
    cfVoStatus.textContent = 'Enter an endpoint first';
    cfVoStatus.style.color = 'var(--warn)';
    return;
  }
  cfVoStatus.textContent = 'Pinging endpoint…';
  cfVoStatus.style.color = 'var(--muted)';
  try {
    const headers = {};
    if (cfVoFields.token.value.trim()) headers['authorization'] = 'Bearer ' + cfVoFields.token.value.trim();
    const r = await fetch(endpoint, { method: 'GET', headers });
    cfVoStatus.textContent = `Endpoint responded ${r.status} ${r.statusText || ''}`;
    cfVoStatus.style.color = r.ok ? 'var(--ok)' : 'var(--warn)';
    log(`ComfyUI VO endpoint test: ${r.status}`, r.ok ? 'ok' : 'warn');
  } catch (e) {
    cfVoStatus.textContent = 'Reachability error: ' + e.message;
    cfVoStatus.style.color = 'var(--err)';
  }
});

$('cf-vo-clear-cache')?.addEventListener('click', async () => {
  await cacheClear();
  log('IndexedDB TTS cache cleared', 'ok');
});

$('el-save').addEventListener('click', async () => {
  await saveSettings({ apiKey: $('el-key').value.trim(), voiceId: $('el-voice').value.trim(), model: $('el-model').value.trim() });
  $('el-status').textContent = '✓ Saved';
  $('el-status').style.color = 'var(--ok)';
  log('Settings saved', 'ok');
  setTimeout(() => { $('el-status').textContent = ''; }, 2500);
});

$('el-list').addEventListener('click', async () => {
  try {
    const key = $('el-key').value.trim();
    if (!key) { $('el-status').textContent = 'enter API key first'; $('el-status').style.color = 'var(--warn)'; return; }
    $('el-status').textContent = 'Fetching…';
    const voices = await listVoices(key);
    log(`ElevenLabs voices (${voices.length}):`, 'info');
    voices.slice(0, 15).forEach(v => log(`  ${v.voice_id} · ${v.category} · ${v.name}`));
    $('el-status').textContent = `${voices.length} voices listed in log`;
    $('el-status').style.color = 'var(--ok)';
  } catch (e) {
    $('el-status').textContent = 'Error: ' + e.message;
    $('el-status').style.color = 'var(--err)';
  }
});

$('el-clear').addEventListener('click', async () => {
  await cacheClear();
  log('Cache cleared', 'ok');
});

// ─── Replay options mirror — Comfy-styled controls in Record tab,
//     wired via postMessage to the iframe (single source of truth).
const cfOptionControls = [
  // Replay options (always visible)
  { id: 'cf-camera-follow', target: 'camera-pan-toggle',  kind: 'toggle' },
  { id: 'cf-camera-zoom',   target: 'camera-zoom-toggle', kind: 'toggle' },
  { id: 'cf-delay',         target: 'delay-range',         kind: 'range', valueEl: 'cf-delay-value',         suffix: 'ms' },
  { id: 'cf-typing',        target: 'typing-delay-range',  kind: 'range', valueEl: 'cf-typing-value',        suffix: 'ms' },
  { id: 'cf-cursor-size',   target: 'cursor-size',         kind: 'range', valueEl: 'cf-cursor-size-value',   suffix: 'px' },
  { id: 'cf-cursor-style',  target: 'cursor-style',        kind: 'select' },

  // Video Options
  { id: 'cf-record-video',  target: 'record-video-toggle', kind: 'toggle' },
  { id: 'cf-mp4',           target: 'mp4-toggle',          kind: 'toggle' },
  { id: 'cf-xml',           target: 'xml-toggle',          kind: 'toggle' },

  // UI Options
  { id: 'cf-captions',      target: 'captions-toggle',     kind: 'toggle' },
  { id: 'cf-node-resize',   target: 'node-resize-toggle',  kind: 'toggle' },
  { id: 'cf-autofit',       target: 'autofit-toggle',      kind: 'toggle' },
  { id: 'cf-humanistic',    target: 'humanistic-toggle',   kind: 'toggle' },
  { id: 'cf-combo-ui',      target: 'combo-ui-toggle',     kind: 'toggle' },
  { id: 'cf-resize-dur',    target: 'resize-duration',     kind: 'range', valueEl: 'cf-resize-dur-value',    suffix: 'ms' },
  { id: 'cf-resize-easing', target: 'resize-easing',       kind: 'select' },
  { id: 'cf-resize-start',  target: 'resize-start',        kind: 'select' },

  // VO Options
  { id: 'cf-vo-captions',   target: 'vo-captions-toggle',  kind: 'toggle' },
  { id: 'cf-ai-timing',     target: 'ai-timing-toggle',    kind: 'toggle' },

  // Debug Options
  { id: 'cf-debug-log',     target: 'show-debug-log-toggle', kind: 'toggle' },
];

function wireOptionControl(spec) {
  const el = $(spec.id);
  if (!el) return;
  if (spec.kind === 'toggle') {
    el.addEventListener('click', () => {
      const next = el.getAttribute('aria-checked') !== 'true';
      el.setAttribute('aria-checked', next ? 'true' : 'false');
      sendToGenerator('set-toggle', { elementId: spec.target, checked: next })
        .catch(e => log(`set-toggle ${spec.target}: ${e.message}`, 'warn'));
    });
  } else if (spec.kind === 'range') {
    const valEl = spec.valueEl ? $(spec.valueEl) : null;
    const updateValueLabel = () => {
      if (valEl) valEl.textContent = el.value + (spec.suffix || '');
    };
    el.addEventListener('input', () => {
      updateValueLabel();
      sendToGenerator('set-range', { elementId: spec.target, value: el.value })
        .catch(e => log(`set-range ${spec.target}: ${e.message}`, 'warn'));
    });
    updateValueLabel();
  } else if (spec.kind === 'select') {
    el.addEventListener('change', () => {
      sendToGenerator('set-value', { elementId: spec.target, value: el.value })
        .catch(e => log(`set-value ${spec.target}: ${e.message}`, 'warn'));
    });
  }
}

async function syncOptionsFromGenerator() {
  try {
    const r = await sendToGenerator('get-options');
    if (!r.ok || !r.options) return;
    for (const spec of cfOptionControls) {
      const got = r.options[spec.target];
      if (!got) continue;
      const el = $(spec.id);
      if (!el) continue;
      if (spec.kind === 'toggle' && got.kind === 'toggle') {
        el.setAttribute('aria-checked', got.value ? 'true' : 'false');
      } else if (spec.kind === 'range' && got.kind === 'value') {
        el.value = got.value;
        const valEl = spec.valueEl ? $(spec.valueEl) : null;
        if (valEl) valEl.textContent = got.value + (spec.suffix || '');
      } else if (spec.kind === 'select' && got.kind === 'value') {
        el.value = got.value;
      }
    }
  } catch (e) {
    log('Could not sync options from generator: ' + e.message, 'warn');
  }
}

for (const spec of cfOptionControls) wireOptionControl(spec);

// Use Example buttons → trigger generator's loadExampleWorkflow
const exBtn = document.getElementById('cf-use-example');
if (exBtn) exBtn.addEventListener('click', async () => {
  try {
    const r = await sendToGenerator('click-example');
    if (r.ok) {
      log('Loaded Example 1', 'ok');
      await new Promise(r => setTimeout(r, 700));
      await refreshWorkflowStatus();
    } else log('Example load failed: ' + r.error, 'err');
  } catch (e) { log('bridge error: ' + e.message, 'err'); }
});
const exShortBtn = document.getElementById('cf-use-example-short');
if (exShortBtn) exShortBtn.addEventListener('click', async () => {
  try {
    const r = await sendToGenerator('click-example', { short: true });
    if (r.ok) {
      log('Loaded Example 2 (Short)', 'ok');
      await new Promise(r => setTimeout(r, 700));
      await refreshWorkflowStatus();
    } else log('Example load failed: ' + r.error, 'err');
  } catch (e) { log('bridge error: ' + e.message, 'err'); }
});

// AI Settings shortcut link
const aiLink = document.getElementById('link-ai-settings');
if (aiLink) aiLink.addEventListener('click', (e) => {
  e.preventDefault();
  activateTab('script');
});

// ─── Workflow drop zone + file picker ────────────────────────────────────────
const dropZone   = document.getElementById('drop-zone');
const dropInput  = document.getElementById('drop-input');
const dropBrowse = document.getElementById('drop-browse');
const wfName     = document.getElementById('wf-name');
const wfMeta     = document.getElementById('wf-meta');

async function loadWorkflowFromText(text, filename) {
  const r = await sendToGenerator('load-json', { text, filename });
  if (!r.ok) {
    log('Workflow load failed: ' + (r.error || 'unknown'), 'err');
    return false;
  }
  log(`Workflow loaded: ${r.name}`, 'ok');
  // Generator's processFile is async — wait a beat then refresh the status
  await new Promise(r => setTimeout(r, 700));
  await refreshWorkflowStatus();
  // Switch to VO Script so the user can review/edit narrations
  activateTab('script');
  return true;
}

async function loadWorkflowFromFile(file) {
  if (!file) return;
  if (!/\.json$/i.test(file.name) && file.type !== 'application/json') {
    log(`Skipped "${file.name}" — only .json workflows are supported`, 'warn');
    return;
  }
  try {
    const text = await file.text();
    JSON.parse(text); // validate
    await loadWorkflowFromText(text, file.name);
  } catch (e) {
    log(`Couldn't read "${file.name}": ${e.message}`, 'err');
  }
}

dropBrowse.addEventListener('click', (e) => {
  e.preventDefault();
  dropInput.click();
});
dropInput.addEventListener('change', () => {
  const file = dropInput.files && dropInput.files[0];
  loadWorkflowFromFile(file);
  dropInput.value = ''; // allow re-selecting same file
});
dropZone.addEventListener('click', (e) => {
  if (e.target.tagName === 'A') return;
  dropInput.click();
});

// Drag-drop on the zone (and the entire Record pane for forgiveness)
for (const target of [dropZone, document.getElementById('pane-record')]) {
  target.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
  });
  target.addEventListener('dragleave', (e) => {
    if (target === dropZone || !dropZone.contains(e.relatedTarget)) {
      dropZone.classList.remove('dragover');
    }
  });
  target.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    const file = e.dataTransfer?.files?.[0];
    if (file) loadWorkflowFromFile(file);
  });
}

async function refreshWorkflowStatus() {
  try {
    const r = await sendToGenerator('get-script');
    if (r.ok && r.script) {
      // Parse a few quick facts out of the generated script
      const nMatch = r.script.match(/const\s+NODES\s*=\s*(\[[\s\S]*?\]);/);
      const lMatch = r.script.match(/const\s+LINKS\s*=\s*(\[[\s\S]*?\]);/);
      let nodes = '?', links = '?';
      try { if (nMatch) nodes = JSON.parse(nMatch[1]).length; } catch(_){}
      try { if (lMatch) links = JSON.parse(lMatch[1]).length; } catch(_){}
      const narrCount = r.narrations ? Object.keys(r.narrations).length : 0;
      wfName.textContent = r.name || 'Workflow';
      wfMeta.textContent = `${nodes} nodes · ${links} links · ${narrCount} narrations`;
      $('script-badge').textContent = String(narrCount);
    } else {
      wfName.textContent = 'No workflow loaded';
      wfMeta.textContent = 'drop a JSON above';
      $('script-badge').textContent = '—';
    }
  } catch (e) {
    wfName.textContent = 'Workflow status unavailable';
    wfMeta.textContent = '';
  }
}

// ─── Tab switcher ────────────────────────────────────────────────────────────
function activateTab(name) {
  for (const btn of document.querySelectorAll('.tab-btn')) {
    const on = btn.dataset.tab === name;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-selected', on ? 'true' : 'false');
  }
  for (const pane of document.querySelectorAll('.tab-pane')) {
    pane.classList.toggle('active', pane.id === 'pane-' + name);
  }
}
for (const btn of document.querySelectorAll('.tab-btn')) {
  btn.addEventListener('click', () => {
    if (btn.dataset.disabled === 'true') return;
    activateTab(btn.dataset.tab);
  });
}

// Refresh the VO Script tab badge with current narration count once the
// bridge bootstrap completes. Delegates to refreshWorkflowStatus for full
// indicator update too.
async function refreshScriptBadge() {
  await refreshWorkflowStatus();
  await syncOptionsFromGenerator();
}

// ─── Boot ────────────────────────────────────────────────────────────────────
$('gen-frame').addEventListener('load', () => { log('Generator iframe loaded', 'info'); });
setState('setup');
log('Panel ready · v0.5', 'ok');
