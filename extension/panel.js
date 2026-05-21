// Side panel logic — orchestrates record + inject + save.
// Loaded as a module (panel.html uses type="module").

import './lib/example1.js';  // populates window.__EXAMPLE_1
import { tts, getSettings, saveSettings, listVoices, cacheClear } from './lib/eleven.js';

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

// ─── Comfy tab status ────────────────────────────────────────────────────────
async function refreshComfyStatus() {
  const lbl = document.getElementById('comfy-tab-label');
  try {
    const r = await chrome.runtime.sendMessage({ type: 'find-comfy-tab' });
    if (r && r.tab) {
      lbl.textContent = `${r.tab.title || 'ComfyUI'} (#${r.tab.id})`;
      lbl.style.color = 'var(--ok)';
    } else {
      lbl.textContent = 'no cloud.comfy.org tab open — open one first';
      lbl.style.color = 'var(--warn)';
    }
  } catch (e) {
    lbl.textContent = 'error: ' + e.message;
    lbl.style.color = 'var(--err)';
  }
}
refreshComfyStatus();
setInterval(refreshComfyStatus, 2500);

// ─── Build the input object for the runner ───────────────────────────────────
async function buildInput({ useVO, voSource }) {
  const ex = window.__EXAMPLE_1;
  const audioMap = {};

  if (useVO) {
    if (voSource === 'bundled') {
      for (const [id, basename] of Object.entries(ex.AUDIO_BASENAMES)) {
        audioMap[id] = chrome.runtime.getURL('audio/' + basename);
      }
      log(`VO source: bundled (${Object.keys(audioMap).length} clips)`, 'info');
    } else if (voSource === 'elevenlabs') {
      const settings = await getSettings();
      const entries = Object.entries(ex.NARRATIONS);
      log(`VO source: ElevenLabs — fetching ${entries.length} clips (voice=${settings.voiceId})…`, 'info');
      const results = await Promise.all(entries.map(async ([id, text]) => {
        try {
          const r = await tts(text, settings);
          return { id, ok: true, dataUrl: r.dataUrl, durationMs: r.durationMs, fromCache: r.fromCache };
        } catch (e) {
          return { id, ok: false, err: e.message };
        }
      }));
      let hit = 0, miss = 0, fail = 0;
      for (const r of results) {
        if (!r.ok) { fail++; log(`  ✗ ${r.id}: ${r.err}`, 'err'); continue; }
        audioMap[r.id] = r.dataUrl;
        if (r.fromCache) hit++; else miss++;
      }
      log(`VO ready: ${hit} cached, ${miss} fetched, ${fail} failed`, fail ? 'warn' : 'ok');
      if (fail > 0 && hit + miss === 0) {
        throw new Error(`All ${fail} TTS calls failed. Check API key + voice ID.`);
      }
    }
  }

  return {
    NODES: ex.NODES,
    LINKS: ex.LINKS,
    NARRATIONS: ex.NARRATIONS,
    AUDIO_MAP: audioMap,
    OPTS: { useVO, stepDly: 800 },
  };
}

// ─── Recording pipeline ──────────────────────────────────────────────────────
async function startRecording() {
  log('Asking for screen share — pick the Comfy tab + check "Share tab audio"', 'info');
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: 30 },
    audio: true,
    selfBrowserSurface: 'exclude',
    surfaceSwitching: 'include',
  });

  const hasAudio = stream.getAudioTracks().length > 0;
  log(`Stream got ${stream.getVideoTracks().length}v / ${stream.getAudioTracks().length}a tracks`, hasAudio ? 'ok' : 'warn');
  if (!hasAudio) log('No audio track — VO will be missing from the recording', 'warn');

  const candidates = [
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4;codecs=avc1',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
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
    stream,
    recorder,
    mime,
    async stop() {
      stream.getTracks().forEach(t => t.stop());
      await stopped;
      return new Blob(chunks, { type: mime });
    },
  };
}

async function saveBlob(blob, suggestedName) {
  try {
    if (window.showSaveFilePicker) {
      const ext = blob.type.includes('mp4') ? '.mp4' : '.webm';
      const handle = await window.showSaveFilePicker({
        suggestedName,
        types: [{ description: 'Video', accept: { [blob.type]: [ext] } }],
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

// ─── Probe loop — waits for runner completion ────────────────────────────────
async function waitForReplayDone({ timeoutMs = 5 * 60 * 1000, onTick }) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await new Promise(r => setTimeout(r, 1000));
    const r = await chrome.runtime.sendMessage({ type: 'probe' });
    if (r && r.ok && r.result) {
      if (onTick) onTick(r.result, Date.now() - t0);
      if (r.result.done) return r.result;
    }
  }
  return { done: false, timeout: true };
}

// ─── Main button ─────────────────────────────────────────────────────────────
let inFlight = false;

document.getElementById('btn-record').addEventListener('click', async () => {
  if (inFlight) { log('Already running — wait or refresh panel', 'warn'); return; }
  inFlight = true;
  const btn = document.getElementById('btn-record');
  btn.disabled = true;
  btn.textContent = '⏳ Working…';

  const useVO    = document.getElementById('opt-vo').checked;
  const useRec   = document.getElementById('opt-rec').checked;
  const voSource = document.getElementById('opt-vo-source').value;

  let rec = null;
  try {
    const tabR = await chrome.runtime.sendMessage({ type: 'find-comfy-tab' });
    if (!tabR || !tabR.tab) throw new Error('No cloud.comfy.org tab found. Open one and log in first.');
    log(`Target: ${tabR.tab.title} (tab #${tabR.tab.id})`, 'info');

    const input = await buildInput({ useVO, voSource });
    log(`Input: ${input.NODES.length} nodes, ${input.LINKS.length} links, useVO=${useVO}, voSource=${voSource}`);

    if (useRec) rec = await startRecording();

    await chrome.runtime.sendMessage({ type: 'focus-comfy' });
    await new Promise(r => setTimeout(r, 300));

    log('Injecting runner…', 'info');
    const r = await chrome.runtime.sendMessage({ type: 'inject', input });
    if (!r || !r.ok) throw new Error('inject failed: ' + (r && r.error));
    log('Injection accepted ✓', 'ok');

    log('Waiting for replay to finish…', 'info');
    let lastNodes = -1;
    const result = await waitForReplayDone({
      onTick: (state, ms) => {
        if (state.nodes !== lastNodes) {
          lastNodes = state.nodes;
          log(`  …${(ms/1000)|0}s elapsed, nodes on canvas: ${state.nodes}`);
        }
      },
    });
    if (result.timeout) throw new Error('replay timed out');
    if (result.err)     throw new Error('runner: ' + result.err);
    log('Replay finished ✓', 'ok');

    // Brief pause so the recording captures the final state
    await new Promise(r => setTimeout(r, 1200));

    if (rec) {
      log('Stopping recording…', 'info');
      const blob = await rec.stop();
      log(`Blob: ${(blob.size/1024/1024).toFixed(2)} MB (${blob.type})`, 'ok');
      const ext = blob.type.includes('mp4') ? 'mp4' : 'webm';
      const ts  = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      await saveBlob(blob, `comfyui-replay-${ts}.${ext}`);
    }
    log('Done ✓', 'ok');
  } catch (e) {
    log('ERROR: ' + e.message, 'err');
    console.error(e);
    if (rec) {
      try {
        const b = await rec.stop();
        if (b.size > 0) await saveBlob(b, 'comfyui-replay-PARTIAL.webm');
      } catch(_){}
    }
  } finally {
    inFlight = false;
    btn.disabled = false;
    btn.textContent = '▶ Record Replay';
  }
});

document.getElementById('btn-example').addEventListener('click', () => {
  const ex = window.__EXAMPLE_1;
  log(`Example 1: ${ex.NODES.length} nodes, ${ex.LINKS.length} links, ${Object.keys(ex.NARRATIONS).length} narrations, ${Object.keys(ex.AUDIO_BASENAMES).length} audio clips`, 'info');
});

// ─── ElevenLabs settings ─────────────────────────────────────────────────────
const elKey   = document.getElementById('el-key');
const elVoice = document.getElementById('el-voice');
const elModel = document.getElementById('el-model');
const elStatus = document.getElementById('el-status');
const elVoiceName = document.getElementById('el-voice-name');

async function loadSettingsIntoUI() {
  const s = await getSettings();
  elKey.value   = s.apiKey;
  elVoice.value = s.voiceId;
  elModel.value = s.model;
}
loadSettingsIntoUI();

document.getElementById('el-save').addEventListener('click', async () => {
  await saveSettings({ apiKey: elKey.value.trim(), voiceId: elVoice.value.trim(), model: elModel.value.trim() });
  elStatus.textContent = '✓ Saved';
  elStatus.style.color = 'var(--ok)';
  log('ElevenLabs settings saved', 'ok');
  setTimeout(() => { elStatus.textContent = ''; }, 2500);
});

document.getElementById('el-list-voices').addEventListener('click', async () => {
  try {
    const key = elKey.value.trim();
    if (!key) { elStatus.textContent = 'Enter API key first'; elStatus.style.color = 'var(--warn)'; return; }
    elStatus.textContent = 'Fetching voices…';
    const voices = await listVoices(key);
    log(`ElevenLabs voices (${voices.length}):`, 'info');
    voices.slice(0, 15).forEach(v => log(`  ${v.voice_id} · ${v.category} · ${v.name}`));
    elStatus.textContent = `${voices.length} voices listed in panel log`;
    elStatus.style.color = 'var(--ok)';
  } catch (e) {
    elStatus.textContent = 'Error: ' + e.message;
    elStatus.style.color = 'var(--err)';
    log('listVoices failed: ' + e.message, 'err');
  }
});

document.getElementById('el-clear-cache').addEventListener('click', async () => {
  await cacheClear();
  log('IndexedDB TTS cache cleared', 'ok');
});

log('Panel ready · v0.1', 'ok');
