#!/usr/bin/env node
const fs = require('fs');
const https = require('https');
const KEY = require('./config.local.js').comfyApiKey;
const BASE = 'https://cloud.comfy.org';
const OUT = '/tmp/tts_test.mp3';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const wf = {
  "1": { "class_type": "ElevenLabsVoiceSelector", "inputs": { "voice": "Sarah (female, american)" } },
  "2": { "class_type": "ElevenLabsTextToSpeech", "inputs": {
      "voice": ["1", 0], "text": "Hello from studio. This is a one node test.",
      "stability": 0.5, "apply_text_normalization": "auto",
      "model": "eleven_multilingual_v2", "model.speed": 1.0,
      "model.similarity_boost": 0.75, "model.style": 0.0,
      "model.use_speaker_boost": false, "language_code": "en",
      "seed": 1, "output_format": "mp3_44100_192" } },
  "3": { "class_type": "SaveAudioMP3", "inputs": {
      "audio": ["2", 0], "filename_prefix": "studio_narration", "quality": "320k" } }
};

const HEAD = { 'Content-Type': 'application/json', 'X-API-Key': KEY };

function dl(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, { headers: { 'X-API-Key': KEY } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close(); return dl(res.headers.location, dest).then(resolve).catch(reject);
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', reject);
  });
}

(async () => {
  console.log('▶  POST /api/prompt');
  const r1 = await fetch(`${BASE}/api/prompt`, {
    method: 'POST', headers: HEAD,
    body: JSON.stringify({ prompt: wf, extra_data: { api_key_comfy_org: KEY } }),
  });
  const t1 = await r1.text();
  console.log(`   HTTP ${r1.status}`);
  if (!r1.ok) { console.error(t1.slice(0,600)); process.exit(1); }
  const sub = JSON.parse(t1);
  const pid = sub.prompt_id || sub.id;
  console.log(`   prompt_id: ${pid}`);

  console.log('▶  Polling /api/job/{id}/status');
  let final = null;
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    await sleep(2500);
    const r = await fetch(`${BASE}/api/job/${pid}/status`, { headers: HEAD });
    if (!r.ok) { console.log(`   ...HTTP ${r.status}`); continue; }
    const j = await r.json();
    const s = j.status || j.status_str || JSON.stringify(j).slice(0,80);
    console.log(`   status: ${s}`);
    if (['success','complete','completed'].includes(s)) { final = j; break; }
    if (['error','failed'].includes(s)) { console.error('❌ job failed', JSON.stringify(j)); process.exit(1); }
  }
  if (!final) { console.error('❌ timeout'); process.exit(1); }

  console.log('▶  GET /api/jobs/{id}');
  const r3 = await fetch(`${BASE}/api/jobs/${pid}`, { headers: HEAD });
  if (!r3.ok) { console.error('detail failed', r3.status); process.exit(1); }
  const detail = await r3.json();
  const raw = JSON.stringify(detail);

  let url = null, filename = null, subfolder = '', type = 'output';
  for (const out of Object.values(detail.outputs || {})) {
    const arr = out.audio || out.mp3 || [];
    for (const a of arr) {
      if (a.url) { url = a.url; break; }
      if (a.filename) { filename = a.filename; subfolder = a.subfolder || ''; type = a.type || 'output'; break; }
    }
    if (url || filename) break;
  }
  if (!url && filename) {
    const qs = new URLSearchParams({ filename, subfolder, type });
    url = `${BASE}/api/view?${qs}`;
  }
  if (!url) {
    const m = raw.match(/"url"\s*:\s*"(https?:[^"]+\.mp3[^"]*)"/);
    if (m) url = JSON.parse(`"${m[1]}"`);
  }
  if (!url) { console.error('❌ no audio url'); console.error(raw.slice(0,1000)); process.exit(1); }

  console.log(`▶  Download: ${url.slice(0,90)}...`);
  await dl(url, OUT);
  console.log(`✅ Saved ${OUT} (${fs.statSync(OUT).size} bytes)`);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
