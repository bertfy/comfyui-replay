// Side panel orchestrator — v0.4 (state pill + progress card + cleaner UX)
//
// Lifecycle: panel loads → iframe loads → bridge-ready postMessage →
// auto-bootstrap (load Example 1, enable AI VO Timing, click AI Script) →
// state = ready → user clicks Record.

import { tts, getSettings, saveSettings, listVoices, cacheClear } from './lib/eleven.js';
import { buildShotList, describeShotList } from './lib/shotlist.js';
import { PRESETS, applyPreset, getPreset } from './lib/presets.js';

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
    restoreAIConfig();
    setTimeout(maybeBootstrap, 400);
    return;
  }
  if (m.type === 'ai-config') {
    // The sandboxed generator can't persist its script-writing provider/key
    // (origin=null localStorage shim is in-memory) — we own persistence here.
    chrome.storage.sync.set({ gen_ai_provider: m.provider || 'google', gen_ai_key: m.key || '' })
      .then(() => log('AI script settings saved ✓', 'ok'))
      .catch(() => {});
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

// Push the persisted script-writing provider/key back into the (sandboxed,
// storage-less) generator on every load.
async function restoreAIConfig() {
  try {
    const { gen_ai_provider, gen_ai_key } = await chrome.storage.sync.get(['gen_ai_provider', 'gen_ai_key']);
    if (!gen_ai_provider && !gen_ai_key) return;
    const r = await sendToGenerator('set-ai-config', { provider: gen_ai_provider, key: gen_ai_key });
    if (r.ok) log(`AI script key restored (${gen_ai_provider || 'google'}) ✓`, 'ok');
    else log('AI key restore failed: ' + (r.error || 'unknown'), 'warn');
  } catch (e) {
    log('AI key restore failed: ' + e.message, 'warn');
  }
}

// ─── Auto-bootstrap ─────────────────────────────────────────────────────────
// Generator setup (Example 1 + AI timing + narrations) only matters for the
// Build and Script tabs. Tour works straight off the live tab — it must NOT
// load Example 1, so bootstrap waits for the first Build/Script activation.
let bootstrapped = false;
function maybeBootstrap() {
  if (!bridgeReady || bootstrapped) return;
  if (activeTabName === 'tour') return;
  if (activeTabName === 'build') {
    // One-click live Build: when the Comfy tab already has a graph, skip the
    // Example-1 bootstrap — Record will read the live graph directly.
    probeLiveGraph().then(hasGraph => {
      if (hasGraph) {
        if (currentStatus === 'setup') setState('ready');
        log('Live graph detected — Record rebuilds it (no example needed)', 'ok');
      } else {
        autoBootstrap();
      }
    });
    return;
  }
  autoBootstrap();
}
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

    // ElevenLabs caps concurrent requests per subscription (6 on the user's
    // plan; firing 58 at once 429'd 52 of them). Run a small worker pool and
    // retry 429s with backoff — cached clips return instantly so the pool only
    // throttles real API hits.
    const POOL = 4;
    async function ttsWithRetry(text, stitch, tries = 4) {
      for (let attempt = 1; ; attempt++) {
        try { return await tts(text, settings, stitch); }
        catch (e) {
          const retriable = /429|concurrent|rate.?limit|too many/i.test(e.message);
          if (!retriable || attempt >= tries) throw e;
          await new Promise(r => setTimeout(r, 1000 * attempt + Math.random() * 500));
        }
      }
    }
    const results = [];
    let nextIdx = 0;
    await Promise.all(Array.from({ length: Math.min(POOL, entries.length) }, async () => {
      while (nextIdx < entries.length) {
        const i = nextIdx++;
        const [id, text] = entries[i];
        // Request stitching: hand ElevenLabs the surrounding lines (entries are
        // in playback order) so each clip is delivered as part of one
        // continuous read, not a fresh start.
        const stitch = {
          previousText: entries[i - 1] ? entries[i - 1][1] : null,
          nextText:     entries[i + 1] ? entries[i + 1][1] : null,
        };
        try { results.push({ id, ok: true, ...(await ttsWithRetry(text, stitch)) }); }
        catch (e) { results.push({ id, ok: false, err: e.message }); }
      }
    }));

    let hit = 0, miss = 0, fail = 0;
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
// Capture quality knobs — preset/advanced controls write these to storage.
// Defaults match the "Polished Demo" target: 1080p / 12 Mbps / 30fps.
// 60fps is exposed as an advanced knob but tab capture tends to drop frames
// at 60 on Retina displays — smoothness comes from easing, not fps.
const CAPTURE_DEFAULTS = { bitrateMbps: 12, fps: 30, width: 1920, height: 1080 };
async function getCaptureSettings() {
  try {
    const { capture } = await chrome.storage.sync.get(['capture']);
    return { ...CAPTURE_DEFAULTS, ...(capture || {}) };
  } catch (_) { return { ...CAPTURE_DEFAULTS }; }
}

async function startRecordingForTab(tabId, mode) {
  const cap = await getCaptureSettings();
  let stream;
  if (mode === 'tab') {
    log(`Tab capture for #${tabId} (${cap.width}×${cap.height} @ ${cap.fps}fps)…`, 'info');
    const streamId = await new Promise((res, rej) => {
      chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, id => {
        if (chrome.runtime.lastError) {
          const m = chrome.runtime.lastError.message || 'tabCapture failed';
          // Chrome grants tab capture per-tab, only on a toolbar-icon click
          // while that tab is focused — and a reload clears the grant.
          if (/not been invoked/i.test(m)) {
            rej(new Error('Tab capture not authorized yet — focus the Comfy tab, click the ComfyUI Replay toolbar icon, then press Record again.'));
          } else {
            rej(new Error(m));
          }
        } else res(id);
      });
    });
    stream = await navigator.mediaDevices.getUserMedia({
      video: { mandatory: {
        chromeMediaSource: 'tab', chromeMediaSourceId: streamId,
        maxFrameRate: cap.fps,
        minWidth: cap.width,  maxWidth: cap.width,
        minHeight: cap.height, maxHeight: cap.height,
      } },
      audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
    });
  } else if (mode === 'screen') {
    log('Picker mode — choose the Comfy tab + "Share tab audio"', 'warn');
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: cap.fps, width: { ideal: cap.width }, height: { ideal: cap.height } },
      audio: true, selfBrowserSurface: 'exclude',
    });
  } else return null;

  log(`Stream: ${stream.getVideoTracks().length}v / ${stream.getAudioTracks().length}a`, stream.getAudioTracks().length ? 'ok' : 'warn');

  // Codec order matters for SMOOTHNESS, not just quality. Chrome encodes VP9
  // in software and can't sustain 1080p — it silently drops to ~8fps. H.264
  // (avc1) is hardware-accelerated on Mac; VP8's encoder is light enough to
  // hold 30fps in software. VP9 is the choke point, so it's the last resort.
  const candidates = [
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2', // h264 — hardware on Apple Silicon
    'video/mp4;codecs=avc1',
    'video/webm;codecs=vp8,opus',             // fast software fallback
    'video/webm;codecs=vp8',
    'video/webm;codecs=vp9,opus',             // last resort — drops frames at 1080p
    'video/webm',
  ];
  const mime = candidates.find(m => MediaRecorder.isTypeSupported(m)) || 'video/webm';
  log(`MIME: ${mime} · ${cap.bitrateMbps} Mbps`);

  const chunks = [];
  const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: cap.bitrateMbps * 1_000_000 });
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
  // NOTE: showSaveFilePicker() requires an active user gesture. A real
  // recording runs for minutes, so by the time it finishes the gesture is
  // long gone and the picker throws "Must be handling a user gesture". Don't
  // even try it for recordings — go straight to the anchor download, which
  // has no gesture requirement.
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

// ─── Tour mode ───────────────────────────────────────────────────────────────
// Survey the live graph → plan shots → write narrations (AI w/ template
// fallback) → TTS → bake VO durations into shot dwells → record + inject.

async function surveyGraph() {
  const r = await chrome.runtime.sendMessage({ type: 'survey-graph', tabId: cachedComfyTabId });
  if (!r || !r.ok) throw new Error('survey failed: ' + (r && r.error));
  if (!r.survey || !r.survey.ok) throw new Error('survey failed: ' + (r.survey && r.survey.error || 'no result'));
  return r.survey;
}

// Debug helper — "Dump survey" button. Logs the survey + planned shot list
// without recording anything.
async function runSurveyDump() {
  try {
    if (!cachedComfyTabId) {
      await refreshComfyStatus();
      if (!cachedComfyTabId) throw new Error('No cloud.comfy.org tab open');
    }
    const survey = await surveyGraph();
    log(`Survey: ${survey.nodes.length} nodes · ${survey.groups.length} groups · ${survey.links.length} links`, 'ok');
    for (const g of survey.groups) log(`  group "${g.title}" @ [${g.bounding.map(v => Math.round(v)).join(', ')}]`);
    const shots = buildShotList(survey);
    log('Shot list:\n' + describeShotList(shots), 'info');
    console.log('[tour] survey', survey, 'shots', shots);
  } catch (e) {
    log('Survey dump failed: ' + e.message, 'err');
  }
}

async function runTour({ voSource, recMode }) {
  setState('recording', 'Surveying graph…');
  const survey = await surveyGraph();
  log(`Survey: ${survey.nodes.length} nodes · ${survey.groups.length} groups`, 'ok');
  if (!survey.nodes.length) throw new Error('Graph is empty — open a workflow in the Comfy tab first');

  const tourOpts = await getTourOptions();
  // Pre-flight the ending: 'prerun' needs an existing rendered output in the
  // graph. If there is none, fall back to 'none' — never silently queue a
  // live job (credits + the queue-rejection failure mode).
  let ending = tourOpts.ending;
  if (ending === 'prerun' && !survey.nodes.some(n => n.hasImage)) {
    log('No pre-run output found in the graph — run the workflow once first. Ending at the overview instead.', 'warn');
    ending = 'none';
  }
  const shots = buildShotList(survey, { ending });
  log(`Planned ${shots.length} shots · ending: ${ending}`, 'ok');

  // Narrations: AI via the generator bridge (30s budget), templates on miss
  let narrations = {};
  if (voSource !== 'none' && !bridgeReady) {
    log('Generator bridge not ready yet — recording without VO', 'warn');
  } else if (voSource !== 'none') {
    setState('recording', 'Writing narration…');
    try {
      const r = await sendToGenerator('write-tour-narrations', { survey, shots }, { timeoutMs: 30000 });
      if (r.ok && r.narrations) {
        narrations = r.narrations;
        log(`Narration: ${Object.keys(narrations).length} lines (${r.narrationSource})${r.error ? ' — AI error: ' + r.error : ''}`,
            r.narrationSource === 'ai' ? 'ok' : 'warn');
      } else throw new Error(r.error || 'no narrations');
    } catch (e) {
      log('Narration bridge failed (' + e.message + ') — recording without VO', 'warn');
    }
  }

  // TTS — then bake real clip durations into the shot dwells so the camera
  // pacing is decided at PLAN time, before injection.
  let voAudio = {};
  if (Object.keys(narrations).length && voSource === 'elevenlabs') {
    setState('recording', 'Fetching voice clips…');
    voAudio = await buildVoAudioMap({ source: 'elevenlabs', narrations });
    // Stash the raw clip length per shot; the runner owns pacing now (fits the
    // camera move to the line and overlaps the next beat into its tail). Do
    // NOT inflate minDwellMs here — that re-creates the talk-stop-talk hold.
    for (const shot of shots) {
      const clip = voAudio[shot.voId];
      if (clip) shot.clipMs = clip.durationMs;
    }
  }

  setState('recording', 'Focusing tab…');
  await chrome.runtime.sendMessage({ type: 'focus-comfy' });
  await new Promise(r => setTimeout(r, 400));

  setState('recording', 'Starting capture…');
  currentRec = await startRecordingForTab(cachedComfyTabId, recMode);

  setState('recording');
  showProgress();

  log('Injecting tour…', 'info');
  const injRes = await chrome.runtime.sendMessage({
    type: 'inject-tour', tabId: cachedComfyTabId,
    input: {
      shots,
      voAudio: Object.fromEntries(Object.entries(voAudio).map(([id, v]) => [id, { audioUrl: v.audioUrl, durationMs: v.durationMs }])),
      opts: { cursorSize: tourOpts.cursorSize, arc: tourOpts.arc !== false, executionTimeoutMs: 10 * 60 * 1000 },
    },
  });
  if (!injRes || !injRes.ok) throw new Error('inject-tour failed: ' + (injRes && injRes.error));

  let lastIdx = 0;
  const result = await waitForReplayDone({
    tabId: cachedComfyTabId, total: shots.length,
    timeoutMs: 15 * 60 * 1000,
    onTick: (state, ms) => {
      const idx = state.beatIdx || lastIdx;
      if (idx > lastIdx) lastIdx = idx;
      updateProgress({ beat: state.beatLabel || `Shot ${idx}`, idx, total: shots.length, elapsedMs: ms });
      // Cloud renders can take minutes of static screen — pause the recorder
      // for the wait so the video cuts straight from "Run" to the result.
      const rec = currentRec && currentRec.recorder;
      if (rec) {
        try {
          if (state.phase === 'waiting' && rec.state === 'recording') {
            rec.pause();
            log('Recording paused — waiting for the cloud render…', 'info');
          } else if (state.phase !== 'waiting' && rec.state === 'paused') {
            rec.resume();
            log('Recording resumed — result is in ✓', 'ok');
          }
        } catch (e) { log('recorder pause/resume: ' + e.message, 'warn'); }
      }
    },
  });
  if (result.timeout) throw new Error('tour timed out');
  if (result.err) log('Tour finished with error: ' + result.err, 'warn');
  // Safety: never leave the recorder paused (e.g., tour ended mid-wait).
  try { if (currentRec && currentRec.recorder.state === 'paused') currentRec.recorder.resume(); } catch (_) {}
}

async function getTourOptions() {
  let tour = {};
  try { ({ tour = {} } = await chrome.storage.sync.get(['tour'])); } catch (_) {}
  const opts = { cursorSize: 20, arc: true, ...(tour || {}) };
  // Ending migration: old boolean runWorkflow → 'live'/'none'; fresh installs
  // default to 'prerun' (close on the already-saved output, no live run).
  if (!opts.ending) {
    if (typeof opts.runWorkflow === 'boolean') opts.ending = opts.runWorkflow ? 'live' : 'none';
    else opts.ending = 'prerun';
  }
  return opts;
}

// ─── One-click live Build ────────────────────────────────────────────────────
// Tour-style: read the workflow ALREADY OPEN in the Comfy tab (LiteGraph
// serialize → same JSON shape as a dropped file), load it into the generator,
// write narration, then run the standard Build pipeline. No JSON drop, no
// Example bootstrap.

async function probeLiveGraph() {
  try {
    if (!cachedComfyTabId) await refreshComfyStatus();
    if (!cachedComfyTabId) return false;
    const r = await chrome.runtime.sendMessage({ type: 'probe', tabId: cachedComfyTabId });
    return !!(r && r.ok && r.result && r.result.nodes > 0);
  } catch (_) { return false; }
}

async function serializeLiveGraph() {
  const r = await chrome.runtime.sendMessage({ type: 'serialize-graph', tabId: cachedComfyTabId });
  const res = r && r.ok ? r.result : null;
  if (!res || !res.ok) throw new Error('serialize failed: ' + ((res && res.error) || (r && r.error) || 'unknown'));
  return res;
}

async function runBuildLive({ voSource, recMode }) {
  setState('recording', 'Reading live graph…');
  const live = await serializeLiveGraph();
  if (!live.nodeCount) throw new Error('Live graph is empty — open a workflow first');
  log(`Live graph: ${live.nodeCount} nodes — loading into generator…`, 'ok');

  const name = 'live-' + (live.title || 'workflow').replace(/[^\w-]+/g, '_').slice(0, 40) + '.json';
  const r = await sendToGenerator('load-json', { text: JSON.stringify(live.workflow), filename: name });
  if (!r.ok) throw new Error('generator load failed: ' + (r.error || 'unknown'));
  await new Promise(res => setTimeout(res, 700));
  await sendToGenerator('set-toggle', { elementId: 'ai-timing-toggle', checked: true }).catch(() => {});

  setState('recording', 'Writing narration…');
  try { await sendToGenerator('click-ai-script'); }
  catch (e) { log('AI script trigger: ' + e.message, 'warn'); }
  // The AI call can take a while on big graphs — poll until narrations land
  // (the no-key template fallback lands almost immediately).
  const t0 = Date.now();
  let narrCount = 0;
  while (Date.now() - t0 < 90_000) {
    await new Promise(res => setTimeout(res, 1500));
    try {
      const s = await sendToGenerator('get-script');
      narrCount = s.ok && s.narrations ? Object.keys(s.narrations).length : 0;
      if (narrCount > 0) break;
    } catch (_) { /* keep polling */ }
  }
  log(narrCount ? `Narration ready: ${narrCount} lines` : 'No narrations after 90s — building without VO pacing', narrCount ? 'ok' : 'warn');

  await runBuild({ voSource, recMode });
}

// ─── Build mode (v0.6 generator-script flow) ─────────────────────────────────
async function runBuild({ voSource, recMode }) {
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
      // A narrated beat runs ~10-25s (VO + camera + typing). 10 minutes was
      // killing a 58-beat build mid-recording — scale with the beat count.
      timeoutMs: Math.max(10 * 60 * 1000, totalBeats * 30_000),
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
}

// ─── Main recording flow — dispatches by active mode ─────────────────────────
// Shared by the Record button and the debug Test Tour button.
let inFlight = false;
let currentRec = null;

async function startRecordingFlow() {
  if (inFlight) { log('Already running', 'warn'); return; }
  inFlight = true;

  const mode = currentMode(); // 'tour' | 'build'
  const voSource = mode === 'tour' ? $('opt-tour-vo').value : $('opt-vo-source').value;
  const recMode  = mode === 'tour' ? $('opt-tour-record').value : $('opt-record').value;

  try {
    if (!cachedComfyTabId) {
      await refreshComfyStatus();
      if (!cachedComfyTabId) throw new Error('No cloud.comfy.org tab open');
    }

    if (mode === 'tour') {
      await runTour({ voSource, recMode });
    } else if (!droppedWorkflow && await probeLiveGraph()) {
      // One-click: rebuild the workflow already open in the Comfy tab. A
      // deliberately dropped JSON takes precedence over the live graph.
      log('Build source: live graph (drop a JSON to override)', 'info');
      await runBuildLive({ voSource, recMode });
    } else {
      await runBuild({ voSource, recMode });
    }

    setState('saving', 'Finalizing…');
    await new Promise(r => setTimeout(r, 1500)); // tail capture

    if (currentRec) {
      const blob = await currentRec.stop();
      log(`Blob: ${(blob.size/1024/1024).toFixed(2)} MB (${blob.type})`, 'ok');
      const ext = blob.type.includes('mp4') ? 'mp4' : 'webm';
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      await saveBlob(blob, `comfyui-${mode}-${ts}.${ext}`);
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
}

$('btn-record').addEventListener('click', startRecordingFlow);

// ─── Debug: Test Tour — load the bundled SkyReplacement workflow into the
//     live tab, then run the full tour automatically. One click, zero setup.
$('btn-test-tour').addEventListener('click', async () => {
  if (inFlight) { log('Already running', 'warn'); return; }
  try {
    if (!cachedComfyTabId) {
      await refreshComfyStatus();
      if (!cachedComfyTabId) throw new Error('No cloud.comfy.org tab open');
    }
    activateTab('tour');
    setState('setup', 'Loading test workflow…');
    log('Test Tour: loading SkyReplacement fixture into the Comfy tab…', 'info');
    const wf = await (await fetch(chrome.runtime.getURL('fixtures/skyreplacement.json'))).json();
    const r = await chrome.runtime.sendMessage({ type: 'load-workflow', tabId: cachedComfyTabId, workflow: wf });
    const res = r && r.ok ? r.result : null;
    if (!res || !res.ok) throw new Error('workflow load failed: ' + ((res && res.error) || (r && r.error) || 'unknown'));
    log(`Loaded: ${res.nodes} nodes ✓ — settling…`, 'ok');
    // Let the frontend finish layout/previews before the survey runs.
    await new Promise(s => setTimeout(s, 2000));
    setState('ready');
    await startRecordingFlow();
  } catch (e) {
    setState('error', e.message.slice(0, 30));
    log('Test Tour failed: ' + e.message, 'err');
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

  // Replay options (always visible) — Click Effects
  { id: 'cf-click-fx',      target: 'click-fx-toggle',     kind: 'toggle' },

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
      markCustom('build');
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
      markCustom('build');
      sendToGenerator('set-range', { elementId: spec.target, value: el.value })
        .catch(e => log(`set-range ${spec.target}: ${e.message}`, 'warn'));
    });
    updateValueLabel();
  } else if (spec.kind === 'select') {
    el.addEventListener('change', () => {
      markCustom('build');
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

// ─── Presets — one knob that sets many ───────────────────────────────────────
// Storage-backed knobs (capture/tour) apply via lib/presets.js; Build-mode
// generator options dispatch over the iframe bridge, then the accordion
// mirrors re-sync. Touching any individual knob flips the picker to Custom.
const presetSelTour  = $('preset-tour');
const presetSelBuild = $('preset-build');

function markCustom(mode) {
  const sel = mode === 'tour' ? presetSelTour : presetSelBuild;
  if (!sel || sel.value === 'custom') return;
  sel.value = 'custom';
  chrome.storage.sync.set({ ['preset_' + mode]: 'custom' }).catch(() => {});
}

async function patchStorage(key, patch) {
  const cur = (await chrome.storage.sync.get([key]))[key] || {};
  await chrome.storage.sync.set({ [key]: { ...cur, ...patch } });
}

async function syncTourControlsFromStorage() {
  const cap = await getCaptureSettings();
  const tour = await getTourOptions();
  $('cap-bitrate').value = cap.bitrateMbps;
  $('cap-bitrate-value').textContent = cap.bitrateMbps + ' Mbps';
  $('cap-fps').value = String(cap.fps);
  $('tour-cursor-size').value = tour.cursorSize;
  $('tour-cursor-size-value').textContent = tour.cursorSize + 'px';
  $('tour-ending').value = tour.ending;
  $('tour-arc-toggle').setAttribute('aria-checked', tour.arc !== false ? 'true' : 'false');
}

async function onPresetChange(mode) {
  const sel = mode === 'tour' ? presetSelTour : presetSelBuild;
  const id = sel.value;
  try {
    if (id === 'custom') {
      await chrome.storage.sync.set({ ['preset_' + mode]: 'custom' });
      return;
    }
    const p = await applyPreset(id, mode);
    if (mode === 'tour') {
      if (p.tourVo) $('opt-tour-vo').value = p.tourVo;
      await syncTourControlsFromStorage();
    } else {
      if (p.buildVo) $('opt-vo-source').value = p.buildVo;
      for (const [target, op] of Object.entries(p.build || {})) {
        const [type, payload] = op.kind === 'toggle'
          ? ['set-toggle', { elementId: target, checked: !!op.value }]
          : [op.kind === 'range' ? 'set-range' : 'set-value', { elementId: target, value: op.value }];
        try { await sendToGenerator(type, payload); }
        catch (e) { log(`preset → ${target}: ${e.message}`, 'warn'); }
      }
      await syncOptionsFromGenerator();
    }
    log(`Preset applied: ${p.label}`, 'ok');
  } catch (e) {
    log('Preset failed: ' + e.message, 'err');
  }
}

presetSelTour.addEventListener('change', () => onPresetChange('tour'));
presetSelBuild.addEventListener('change', () => onPresetChange('build'));

// Tour engine + capture-quality knobs (storage-backed; flip preset → Custom)
function wireTourToggle(id, key) {
  $(id).addEventListener('click', async () => {
    const el = $(id);
    const next = el.getAttribute('aria-checked') !== 'true';
    el.setAttribute('aria-checked', next ? 'true' : 'false');
    markCustom('tour');
    await patchStorage('tour', { [key]: next });
  });
}
wireTourToggle('tour-arc-toggle', 'arc');

$('tour-ending').addEventListener('change', async () => {
  markCustom('tour');
  await patchStorage('tour', { ending: $('tour-ending').value });
});

$('tour-cursor-size').addEventListener('input', async () => {
  const v = parseInt($('tour-cursor-size').value, 10);
  $('tour-cursor-size-value').textContent = v + 'px';
  markCustom('tour');
  await patchStorage('tour', { cursorSize: v });
});
$('cap-bitrate').addEventListener('input', async () => {
  const v = parseInt($('cap-bitrate').value, 10);
  $('cap-bitrate-value').textContent = v + ' Mbps';
  markCustom('tour');
  await patchStorage('capture', { bitrateMbps: v });
});
$('cap-fps').addEventListener('change', async () => {
  markCustom('tour');
  await patchStorage('capture', { fps: parseInt($('cap-fps').value, 10) });
});
$('opt-tour-vo').addEventListener('change', () => markCustom('tour'));
$('opt-vo-source').addEventListener('change', () => markCustom('build'));

// Restore preset selections; seed Polished Demo defaults on first run
(async () => {
  try {
    const { preset_tour, preset_build } = await chrome.storage.sync.get(['preset_tour', 'preset_build']);
    if (!preset_tour) await applyPreset('polished-demo', 'tour');
    presetSelTour.value = preset_tour || 'polished-demo';
    presetSelBuild.value = preset_build || 'polished-demo';
    await syncTourControlsFromStorage();
  } catch (e) {
    log('Preset init: ' + e.message, 'warn');
  }
})();

// ─── Tour debug + window-prep buttons ────────────────────────────────────────
$('btn-survey-dump').addEventListener('click', runSurveyDump);

$('btn-prep-window').addEventListener('click', async () => {
  log('Resizing Comfy window for a 1920×1080 viewport…', 'info');
  try {
    const r = await chrome.runtime.sendMessage({ type: 'prepare-window', width: 1920, height: 1080 });
    if (r && r.ok) log(`Viewport: ${r.viewport.w}×${r.viewport.h} ✓`, 'ok');
    else if (r && r.viewport) log(`Viewport landed at ${r.viewport.w}×${r.viewport.h} (display may be too small)`, 'warn');
    else log('Resize failed: ' + (r && r.error || 'unknown'), 'err');
  } catch (e) {
    log('prepare-window failed: ' + e.message, 'err');
  }
});

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

// Set when the user deliberately drops/browses a workflow JSON — Build then
// uses it instead of the live graph.
let droppedWorkflow = false;

async function loadWorkflowFromText(text, filename) {
  const r = await sendToGenerator('load-json', { text, filename });
  if (!r.ok) {
    log('Workflow load failed: ' + (r.error || 'unknown'), 'err');
    return false;
  }
  droppedWorkflow = true;
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

// Drag-drop on the zone (and the entire Build pane for forgiveness)
for (const target of [dropZone, document.getElementById('pane-build')]) {
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
// activeMode is the RECORDING mode ('tour' | 'build') — it sticks when the
// user visits the Script tab, so Record still does the right thing.
let activeTabName = 'tour';
let activeMode = 'tour';
function currentMode() { return activeMode; }

function activateTab(name) {
  activeTabName = name;
  for (const btn of document.querySelectorAll('.tab-btn')) {
    const on = btn.dataset.tab === name;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-selected', on ? 'true' : 'false');
  }
  for (const pane of document.querySelectorAll('.tab-pane')) {
    pane.classList.toggle('active', pane.id === 'pane-' + name);
  }
  if (name === 'tour' || name === 'build') {
    activeMode = name;
    if (!inFlight) $('btn-record').textContent = name === 'tour' ? '▶ Record Tour' : '▶ Record Build';
  }
  // Record/Stop/progress only make sense for the recording modes
  $('action-bar').classList.toggle('hidden', name === 'script');
  maybeBootstrap();
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
// Tour is the default mode and needs no generator setup — ready immediately.
// Switching to Build/Script triggers the example bootstrap (maybeBootstrap).
setState('ready');
const EXT_VERSION = chrome.runtime.getManifest().version;
$('hdr-version').textContent = 'v' + EXT_VERSION;
log(`Panel ready · v${EXT_VERSION}`, 'ok');
