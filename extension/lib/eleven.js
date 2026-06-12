// ElevenLabs TTS helper for the side panel. Caches MP3 blobs in IndexedDB
// keyed by sha256(voice|model|text).

const DB = 'comfy-replay';
const STORE = 'tts';
const VERSION = 1;

function openDb() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB, VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE);
    };
    req.onsuccess = () => res(req.result);
    req.onerror   = () => rej(req.error);
  });
}

async function cacheGet(key) {
  const db = await openDb();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, 'readonly');
    const r = tx.objectStore(STORE).get(key);
    r.onsuccess = () => res(r.result || null);
    r.onerror   = () => rej(r.error);
  });
}

async function cachePut(key, blob) {
  const db = await openDb();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(blob, key);
    tx.oncomplete = res;
    tx.onerror    = () => rej(tx.error);
  });
}

export async function cacheClear() {
  const db = await openDb();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    tx.oncomplete = res;
    tx.onerror    = () => rej(tx.error);
  });
}

// sha256 → 16 hex (browser SubtleCrypto). The key includes the stitching
// context (previous/next text) — the same line reads differently mid-flow vs.
// standalone, so they are genuinely different audio.
async function cacheKey(voiceId, model, text, extra = '') {
  const enc = new TextEncoder().encode(`${voiceId}|${model}|${text}|${extra}`);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  return [...new Uint8Array(buf)].slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Delivery tuning: lower stability = more natural variation in pacing and
// emphasis (less "announcer reading a list"); speaker boost keeps presence.
const VOICE_SETTINGS = {
  stability: 0.45,
  similarity_boost: 0.75,
  style: 0.2,
  use_speaker_boost: true,
};

// Convert Blob → base64 data URL (works in any execution context, transferable
// through chrome.scripting.executeScript args).
async function blobToDataUrl(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload  = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.readAsDataURL(blob);
  });
}

// Fetch (or cache-hit) one narration. Returns { dataUrl, durationMs, fromCache, key }
// Throws on network / API errors.
// opts.previousText / opts.nextText enable ElevenLabs request stitching: the
// voice delivers this line as part of one continuous read (prosody flows
// across clips) instead of each clip opening with fresh announcer energy.
export async function tts(text, { apiKey, voiceId, model }, opts = {}) {
  if (!apiKey)  throw new Error('No API key — set in ⚙ ElevenLabs Settings');
  if (!voiceId) throw new Error('No voice ID — set in ⚙ ElevenLabs Settings');
  const { previousText = null, nextText = null } = opts;
  const key = await cacheKey(voiceId, model, text,
    `${previousText || ''}|${nextText || ''}|v2`);

  let blob = await cacheGet(key);
  let fromCache = !!blob;
  if (!blob) {
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`;
    const body = { text, model_id: model, voice_settings: VOICE_SETTINGS };
    if (previousText) body.previous_text = previousText;
    if (nextText)     body.next_text     = nextText;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json', 'accept': 'audio/mpeg' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const err = await resp.text().catch(() => '');
      throw new Error(`ElevenLabs ${resp.status}: ${err.slice(0, 300)}`);
    }
    blob = await resp.blob();
    await cachePut(key, blob);
  }

  // Decode duration via Web Audio
  const arr = await blob.arrayBuffer();
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const buf = await ctx.decodeAudioData(arr.slice(0));
  const durationMs = Math.round(buf.duration * 1000);
  try { ctx.close(); } catch(_){}

  const dataUrl = await blobToDataUrl(blob);
  return { dataUrl, durationMs, fromCache, key };
}

// Settings — chrome.storage.sync
export async function getSettings() {
  const v = await chrome.storage.sync.get(['el_key', 'el_voice', 'el_model']);
  return {
    apiKey:  v.el_key   || '',
    voiceId: v.el_voice || 'EXAVITQu4vr4xnSDxMaL', // Sarah — free-tier ok
    model:   v.el_model || 'eleven_turbo_v2_5',
  };
}

export async function saveSettings({ apiKey, voiceId, model }) {
  await chrome.storage.sync.set({ el_key: apiKey, el_voice: voiceId, el_model: model });
}

// Query the voices available to this account. Free-tier accounts can only
// use "premade" voices; we surface category so the user picks correctly.
export async function listVoices(apiKey) {
  const r = await fetch('https://api.elevenlabs.io/v2/voices?include_total_count=true', {
    headers: { 'xi-api-key': apiKey },
  });
  if (!r.ok) throw new Error(`ElevenLabs voices ${r.status}`);
  const j = await r.json();
  return (j.voices || []).map(v => ({
    voice_id: v.voice_id,
    name: v.name,
    category: v.category,
  }));
}
