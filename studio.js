#!/usr/bin/env node
/**
 * studio.js — ComfyUI Replay Studio Server
 *
 * Bridges index.html with Comfy Cloud TTS + cursor-replay recording.
 * Run once, leave it running. The browser does the rest.
 *
 * Setup:
 *   1. Add to config.local.js:  module.exports = { comfyApiKey: 'YOUR_KEY' }
 *      Get your key at: https://comfy.org/settings/api-keys
 *      OR set env var:  COMFY_API_KEY=your_key node studio.js
 *
 *   2. node studio.js
 *   3. Open index.html — look for the green "Studio Connected" badge
 *   4. Drop a workflow, click "🎬 Generate Video"
 */

const { WebSocketServer } = require('ws');
const { spawn, execSync, spawnSync } = require('child_process');
const fs   = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

// ── Config ───────────────────────────────────────────────────────────────────

const WS_PORT     = 3002;
const COMFY_BASE  = process.env.COMFY_CLOUD_URL || 'https://cloud.comfy.org';
const STUDIO_TMP  = path.resolve('./studio_tmp');
const AUDIO_DIR   = path.resolve('./studio_tmp/audio');
const RECORDINGS  = path.resolve('./recordings');

let config = {};
try { config = require('./config.local.js'); } catch(e) {}

const COMFY_API_KEY     = process.env.COMFY_API_KEY     || config.comfyApiKey     || '';
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || config.elevenLabsApiKey || '';

// ── Bootstrap dirs ───────────────────────────────────────────────────────────

[STUDIO_TMP, AUDIO_DIR, RECORDINGS].forEach(d => fs.mkdirSync(d, { recursive: true }));

// ── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file  = fs.createWriteStream(dest);
    const proto = url.startsWith('https') ? https : http;
    // Only send X-API-Key to cloud.comfy.org; signed GCS URLs reject extra headers.
    const headers = url.includes('cloud.comfy.org') && COMFY_API_KEY
      ? { 'X-API-Key': COMFY_API_KEY }
      : {};
    proto.get(url, { headers }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        return downloadFile(res.headers.location, dest).then(resolve).catch(reject);
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
      file.on('error', reject);
    }).on('error', err => { fs.unlink(dest, () => {}); reject(err); });
  });
}

function getAudioDuration(filePath) {
  try {
    const out = execSync(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`,
      { encoding: 'utf-8', timeout: 10000 }
    ).trim();
    return Math.ceil(parseFloat(out) * 1000);
  } catch(e) {
    // Fallback: estimate ~150 words per minute
    return 3000;
  }
}

// ── Comfy Cloud API ──────────────────────────────────────────────────────────

function comfyHeaders() {
  return {
    'Content-Type': 'application/json',
    'X-API-Key':    COMFY_API_KEY,
  };
}

async function comfyPost(endpoint, body) {
  const resp = await fetch(`${COMFY_BASE}${endpoint}`, {
    method:  'POST',
    headers: comfyHeaders(),
    body:    JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Comfy Cloud ${resp.status} on ${endpoint}: ${text}`);
  }
  return resp.json();
}

async function comfyGet(endpoint) {
  const resp = await fetch(`${COMFY_BASE}${endpoint}`, { headers: comfyHeaders() });
  if (!resp.ok) throw new Error(`Comfy Cloud GET ${endpoint} ${resp.status}`);
  return resp.json();
}

async function pollUntilDone(promptId, onStatus, maxMs = 300000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    await sleep(2500);
    let s;
    try {
      s = await comfyGet(`/api/job/${promptId}/status`);
    } catch(e) {
      onStatus?.(`Polling... (${e.message})`);
      continue;
    }
    const status = s.status || s.status_str;
    if (status === 'success' || status === 'complete' || status === 'completed') {
      // Fetch full job detail (with outputs) before returning
      return await comfyGet(`/api/jobs/${promptId}`);
    }
    if (status === 'error' || status === 'failed') {
      throw new Error(`Comfy Cloud job failed: ${JSON.stringify(s)}`);
    }
    onStatus?.(`Job: ${status}`);
  }
  throw new Error('Comfy Cloud job timed out');
}

function extractAudioUrl(job) {
  const outputs = job.outputs || {};
  for (const nodeOut of Object.values(outputs)) {
    const audioArr = nodeOut.audio || nodeOut.mp3 || [];
    for (const a of audioArr) {
      if (a.url) return a.url;
      if (a.filename) {
        const qs = new URLSearchParams({
          filename:  a.filename,
          subfolder: a.subfolder || '',
          type:      a.type || 'output',
        });
        return `${COMFY_BASE}/api/view?${qs}`;
      }
    }
  }
  const raw = JSON.stringify(job);
  const match = raw.match(/"url"\s*:\s*"(https?:[^"]+\.mp3[^"]*)"/);
  if (match) return JSON.parse(`"${match[1]}"`);
  throw new Error('Could not find audio URL in Comfy Cloud response');
}

function buildTTSWorkflow(text, voice = 'Sarah (female, american)') {
  return {
    "1": {
      "class_type": "ElevenLabsVoiceSelector",
      "inputs": { "voice": voice }
    },
    "2": {
      "class_type": "ElevenLabsTextToSpeech",
      "inputs": {
        "voice":                    ["1", 0],
        "text":                     text,
        "stability":                0.5,
        "apply_text_normalization": "auto",
        "model":                    "eleven_multilingual_v2",
        "model.speed":              1.0,
        "model.similarity_boost":   0.75,
        "model.style":              0.0,
        "model.use_speaker_boost":  false,
        "language_code":            "en",
        "seed":                     1,
        "output_format":            "mp3_44100_192",
      }
    },
    "3": {
      "class_type": "SaveAudioMP3",
      "inputs": {
        "audio":           ["2", 0],
        "filename_prefix": "studio_narration",
        "quality":         "320k",
      }
    }
  };
}

// ── ElevenLabs fallback (direct API) ─────────────────────────────────────────

async function ttsElevenLabsDirect(text, destPath, voice = '21m00Tcm4TlvDq8ikWAM') {
  const resp = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}`, {
    method:  'POST',
    headers: {
      'Content-Type': 'application/json',
      'xi-api-key':   ELEVENLABS_API_KEY,
    },
    body: JSON.stringify({
      text,
      model_id:         'eleven_multilingual_v2',
      voice_settings:   { stability: 0.5, similarity_boost: 0.75 },
    }),
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`ElevenLabs error ${resp.status}: ${err}`);
  }
  const buf = await resp.arrayBuffer();
  fs.writeFileSync(destPath, Buffer.from(buf));
}

// ── TTS: generate one audio clip ─────────────────────────────────────────────

async function generateAudioClip(text, destPath, voice, onStatus) {
  if (COMFY_API_KEY) {
    onStatus?.('Submitting to Comfy Cloud...');
    const wf         = buildTTSWorkflow(text, voice);
    const submitResp = await comfyPost('/api/prompt', {
      prompt:     wf,
      extra_data: { api_key_comfy_org: COMFY_API_KEY },
    });
    const promptId   = submitResp.prompt_id || submitResp.id;
    if (!promptId) throw new Error(`No prompt_id in response: ${JSON.stringify(submitResp)}`);
    onStatus?.(`Comfy Cloud job ${promptId.slice(0,8)}...`);
    const job        = await pollUntilDone(promptId, onStatus);
    const audioUrl   = extractAudioUrl(job);
    onStatus?.('Downloading audio...');
    await downloadFile(audioUrl, destPath);
  } else if (ELEVENLABS_API_KEY) {
    onStatus?.('Calling ElevenLabs API...');
    await ttsElevenLabsDirect(text, destPath);
  } else {
    throw new Error(
      'No API key found. Add comfyApiKey or elevenLabsApiKey to config.local.js'
    );
  }
}

// ── ffmpeg helpers ────────────────────────────────────────────────────────────

function concatAudioFiles(audioPaths, outputPath) {
  if (audioPaths.length === 1) {
    fs.copyFileSync(audioPaths[0], outputPath);
    return;
  }
  // Use concat demuxer
  const listFile = path.join(STUDIO_TMP, 'concat_list.txt');
  const lines    = audioPaths.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join('\n');
  fs.writeFileSync(listFile, lines);
  const result = spawnSync('ffmpeg', [
    '-y', '-f', 'concat', '-safe', '0',
    '-i', listFile,
    '-c', 'copy',
    outputPath,
  ], { encoding: 'utf-8' });
  if (result.status !== 0) throw new Error(`ffmpeg concat failed: ${result.stderr}`);
}

function muxVideoAudio(videoPath, audioPath, outputPath) {
  const result = spawnSync('ffmpeg', [
    '-y',
    '-i', videoPath,
    '-i', audioPath,
    '-c:v', 'libx264',
    '-c:a', 'aac',
    '-shortest',
    '-movflags', '+faststart',
    outputPath,
  ], { encoding: 'utf-8', timeout: 300000 });
  if (result.status !== 0) throw new Error(`ffmpeg mux failed: ${result.stderr}`);
}

function getMediaSize(filePath) {
  try {
    const out = execSync(
      `ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "${filePath}"`,
      { encoding: 'utf-8', timeout: 10000 }
    ).trim();
    const [w, h] = out.split(',').map(Number);
    return { w, h };
  } catch(e) { return { w: 1920, h: 1080 }; }
}

// Re-encode an image into an N-second mp4 segment with narration audio.
// Pads/scales to match the build video's resolution so concat -c copy works.
function buildImageSegment(imagePath, audioPath, durationSec, targetW, targetH, outputPath) {
  const vf = `scale=${targetW}:${targetH}:force_original_aspect_ratio=decrease,` +
             `pad=${targetW}:${targetH}:(ow-iw)/2:(oh-ih)/2:black,` +
             `fps=30,format=yuv420p`;
  const args = [
    '-y',
    '-loop', '1', '-t', String(durationSec), '-i', imagePath,
    '-i', audioPath,
    '-vf', vf,
    '-c:v', 'libx264', '-preset', 'fast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-ar', '44100', '-ac', '2',
    '-shortest', '-movflags', '+faststart',
    outputPath,
  ];
  const r = spawnSync('ffmpeg', args, { encoding: 'utf-8', timeout: 120000 });
  if (r.status !== 0) throw new Error(`ffmpeg image-segment failed: ${r.stderr}`);
}

// Re-encode a video output to match build-video specs, with optional audio overlay.
function buildVideoSegment(videoPath, audioPath, targetW, targetH, outputPath) {
  const vf = `scale=${targetW}:${targetH}:force_original_aspect_ratio=decrease,` +
             `pad=${targetW}:${targetH}:(ow-iw)/2:(oh-ih)/2:black,` +
             `fps=30,format=yuv420p`;
  const args = ['-y', '-i', videoPath];
  if (audioPath) args.push('-i', audioPath);
  args.push(
    '-vf', vf,
    '-c:v', 'libx264', '-preset', 'fast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-ar', '44100', '-ac', '2',
  );
  if (audioPath) args.push('-map', '0:v:0', '-map', '1:a:0', '-shortest');
  args.push('-movflags', '+faststart', outputPath);
  const r = spawnSync('ffmpeg', args, { encoding: 'utf-8', timeout: 300000 });
  if (r.status !== 0) throw new Error(`ffmpeg video-segment failed: ${r.stderr}`);
}

// Concat mp4 parts via the concat demuxer. Inputs must have matching codecs+params.
function concatMp4s(parts, outputPath) {
  const listFile = path.join(STUDIO_TMP, 'mp4_concat.txt');
  const lines = parts.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join('\n');
  fs.writeFileSync(listFile, lines);
  const r = spawnSync('ffmpeg', [
    '-y', '-f', 'concat', '-safe', '0', '-i', listFile,
    '-c', 'copy', '-movflags', '+faststart', outputPath,
  ], { encoding: 'utf-8', timeout: 120000 });
  if (r.status !== 0) {
    // Fallback: re-encode on concat (codecs probably mismatched)
    const filter = parts.map((_, i) => `[${i}:v:0][${i}:a:0]`).join('') +
      `concat=n=${parts.length}:v=1:a=1[v][a]`;
    const args = ['-y'];
    for (const p of parts) args.push('-i', p);
    args.push('-filter_complex', filter, '-map', '[v]', '-map', '[a]',
      '-c:v', 'libx264', '-preset', 'fast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-movflags', '+faststart', outputPath);
    const r2 = spawnSync('ffmpeg', args, { encoding: 'utf-8', timeout: 300000 });
    if (r2.status !== 0) throw new Error(`ffmpeg concat fallback failed: ${r2.stderr}`);
  }
}

// Cache object_info from the cloud — fetched lazily once per process.
let _objectInfoCache = null;
async function getObjectInfo() {
  if (_objectInfoCache) return _objectInfoCache;
  const resp = await fetch(`${COMFY_BASE}/api/object_info`, { headers: comfyHeaders() });
  if (!resp.ok) throw new Error(`object_info fetch ${resp.status}`);
  _objectInfoCache = await resp.json();
  return _objectInfoCache;
}

// In ComfyUI object_info, `required.<name> = [typeOrComboList, options?]`.
// typeOrComboList is an array → combo widget; "STRING|INT|FLOAT|BOOLEAN" → scalar widget;
// anything else (e.g. "MODEL", "CLIP", "IMAGE", "LATENT") → link socket.
const SCALAR_WIDGETS = new Set(['STRING', 'INT', 'FLOAT', 'BOOLEAN']);
function isWidgetType(t) {
  if (Array.isArray(t)) return true;
  return SCALAR_WIDGETS.has(t);
}

// Convert ComfyUI save-format workflow to API format using authoritative
// schemas from object_info. Save format may strip node.inputs entirely
// (only widgets_values + the global wf.links table survive), so we walk the
// canonical input order from the schema and consume widget values / link
// slots in parallel.
async function convertSaveToApiFormat(wf) {
  if (!wf.nodes || !Array.isArray(wf.nodes)) return wf; // already API format
  const oi = await getObjectInfo();

  // tgtId -> Map(tgtSlot -> {srcId, srcSlot})
  const linksByTarget = new Map();
  for (const link of wf.links || []) {
    const [, srcId, srcSlot, tgtId, tgtSlot] = link;
    if (!linksByTarget.has(tgtId)) linksByTarget.set(tgtId, new Map());
    linksByTarget.get(tgtId).set(tgtSlot, { srcId, srcSlot });
  }

  const api = {};
  for (const node of wf.nodes) {
    const schema = oi[node.type];
    if (!schema) {
      // Unknown class — pass through with no inputs; cloud will reject and we'll log.
      api[String(node.id)] = { class_type: node.type, inputs: {} };
      continue;
    }
    const required = schema.input?.required || {};
    const optional = schema.input?.optional || {};
    const inputs   = {};
    const wv       = node.widgets_values || [];
    const tgtLinks = linksByTarget.get(node.id) || new Map();
    let linkSlot   = 0;
    let widgetIdx  = 0;

    // Walk required first (their order matches what the frontend serialized),
    // then optional.
    for (const block of [required, optional]) {
      for (const [name, spec] of Object.entries(block)) {
        const innerType = Array.isArray(spec) ? spec[0] : spec;
        if (isWidgetType(innerType)) {
          if (widgetIdx < wv.length) {
            inputs[name] = wv[widgetIdx++];
            // ComfyUI's frontend injects a synthetic "control_after_generate"
            // widget right after every INT input named seed/noise_seed.
            if ((name === 'seed' || name === 'noise_seed') && innerType === 'INT') {
              widgetIdx++; // skip the synthetic value
            }
          }
        } else {
          const link = tgtLinks.get(linkSlot);
          if (link) inputs[name] = [String(link.srcId), link.srcSlot];
          linkSlot++;
        }
      }
    }
    api[String(node.id)] = { class_type: node.type, inputs };
  }
  return api;
}

// Priority list of well-known checkpoints likely to be preloaded on Comfy Cloud
// pods. Ordered most-likely-available first.
const KNOWN_GOOD_CHECKPOINTS = [
  'v1-5-pruned-emaonly-fp16.safetensors',
  'sd_xl_base_1.0.safetensors',
  'sd_xl_turbo_1.0_fp16.safetensors',
  'flux1-schnell-fp8.safetensors',
  'flux1-dev-fp8.safetensors',
  'Juggernaut-XL_v9_RunDiffusionPhoto_v2.safetensors',
];

function pickBestSubstitute(originalValue, allowedList, nodeType, inputName) {
  // 1. Substring/fuzzy match on the original value (handles cases like
  //    "v1-5-pruned-emaonly" → "v1-5-pruned-emaonly-fp16")
  const orig = String(originalValue).toLowerCase().replace(/\.(safetensors|ckpt|pt|bin)$/, '');
  const exactish = allowedList.find(c => c.toLowerCase().includes(orig) || orig.includes(c.toLowerCase().replace(/\.(safetensors|ckpt|pt|bin)$/, '')));
  if (exactish) return exactish;

  // 2. For checkpoint inputs: walk the priority list and pick the first match
  if (nodeType.toLowerCase().includes('checkpoint') || inputName.toLowerCase().includes('ckpt')) {
    for (const known of KNOWN_GOOD_CHECKPOINTS) {
      if (allowedList.includes(known)) return known;
    }
    // De-prioritize anything that looks like a controlnet/encoder/non-base
    const baseLooking = allowedList.filter(c =>
      !c.includes('/') &&
      !/controlnet|encoder|lora|vae|upscal|inpaint/i.test(c)
    );
    if (baseLooking.length) return baseLooking[0];
  }
  // 3. Default: first allowed value
  return allowedList[0];
}

// For each combo widget (where the schema lists allowed string values),
// substitute any value not in the list with a sensible alternative.
// Mutates `api` in place.
async function validateAndSubstituteCombos(api, onStatus) {
  const oi = await getObjectInfo();
  for (const [nodeId, node] of Object.entries(api)) {
    const schema = oi[node.class_type];
    if (!schema) continue;
    const inputs = { ...(schema.input?.required || {}), ...(schema.input?.optional || {}) };
    for (const [name, value] of Object.entries(node.inputs || {})) {
      const spec = inputs[name];
      if (!spec) continue;
      const inner = Array.isArray(spec) ? spec[0] : spec;
      if (Array.isArray(inner) && inner.every(v => typeof v === 'string')) {
        if (!inner.includes(value)) {
          const replacement = pickBestSubstitute(value, inner, node.class_type, name);
          onStatus?.(`Substituting ${node.class_type}.${name}: "${value}" → "${replacement}"`);
          node.inputs[name] = replacement;
        }
      }
    }
  }
}

async function runWorkflowOnCloud(workflow, onStatus) {
  if (!COMFY_API_KEY) throw new Error('No Comfy Cloud key configured');
  const apiWf = await convertSaveToApiFormat(workflow);
  await validateAndSubstituteCombos(apiWf, onStatus);
  onStatus?.('Submitting workflow to Comfy Cloud...');
  const sub = await comfyPost('/api/prompt', {
    prompt: apiWf,
    extra_data: { api_key_comfy_org: COMFY_API_KEY },
  });
  const pid = sub.prompt_id || sub.id;
  if (!pid) throw new Error(`No prompt_id from cloud submit: ${JSON.stringify(sub)}`);
  onStatus?.(`Cloud job ${pid.slice(0, 8)}...`);
  return await pollUntilDone(pid, onStatus, 600000);
}

// Walk job.outputs to find the primary visual result.
// Returns { kind: 'image'|'video', filename, subfolder, type } or null.
function extractPrimaryResult(job) {
  const outputs = job.outputs || {};
  // Prefer videos > gifs > images
  const keysByKind = [
    ['video',  ['videos', 'gifs', 'video', 'mp4']],
    ['image',  ['images', 'image']],
  ];
  for (const [kind, keys] of keysByKind) {
    for (const nodeOut of Object.values(outputs)) {
      for (const k of keys) {
        const arr = nodeOut[k];
        if (Array.isArray(arr) && arr.length) {
          const a = arr[0];
          if (a.url) return { kind, url: a.url };
          if (a.filename) return {
            kind, filename: a.filename, subfolder: a.subfolder || '', type: a.type || 'output',
          };
        }
      }
    }
  }
  return null;
}

function buildResultViewUrl(result) {
  if (result.url) return result.url;
  const qs = new URLSearchParams({
    filename:  result.filename,
    subfolder: result.subfolder || '',
    type:      result.type || 'output',
  });
  return `${COMFY_BASE}/api/view?${qs}`;
}

function findLatestWebm(dir) {
  const files = fs.readdirSync(dir)
    .filter(f => f.endsWith('.webm'))
    .map(f => ({ f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (!files.length) throw new Error(`No .webm found in ${dir}`);
  return path.join(dir, files[0].f);
}

// ── Main: generate video ─────────────────────────────────────────────────────

async function generateVideo({ workflowJson, narrations, options = {}, send }) {
  const voice        = options.voice || 'Sarah (female, american)';
  const workflowFile = path.join(STUDIO_TMP, 'workflow.json');
  const narrsFile    = path.join(STUDIO_TMP, 'narrations.json');
  const audioAllFile = path.join(STUDIO_TMP, 'narrations_all.mp3');
  const timestamp    = Date.now();
  const finalVideo   = path.join(RECORDINGS, `tutorial_${timestamp}.mp4`);

  // 1. Save workflow
  fs.writeFileSync(workflowFile, JSON.stringify(workflowJson, null, 2));

  // 2. Generate TTS for each narration
  const enriched   = []; // { nodeId, text, audioFile, durationMs }
  const audioPaths = [];

  for (let i = 0; i < narrations.length; i++) {
    const { nodeId, text } = narrations[i];
    if (!text || !text.trim()) continue;

    send({ type: 'progress', step: 'tts', current: i + 1, total: narrations.length,
           message: `Generating voice for step ${i + 1} of ${narrations.length}...` });

    const audioFile = path.join(AUDIO_DIR, `node_${nodeId}.mp3`);
    await generateAudioClip(text, audioFile, voice,
      msg => send({ type: 'status', message: msg })
    );

    const durationMs = getAudioDuration(audioFile);
    enriched.push({ nodeId, text, audioFile, durationMs });
    audioPaths.push(audioFile);
    send({ type: 'status', message: `Step ${i + 1} done (${(durationMs / 1000).toFixed(1)}s)` });
  }

  if (!audioPaths.length) throw new Error('No narrations to process');

  // 3. Concatenate audio
  send({ type: 'progress', step: 'audio', message: 'Concatenating audio track...' });
  concatAudioFiles(audioPaths, audioAllFile);

  // 4. Write narrations.json for cursor-replay
  const narrsMap = {};
  for (const n of enriched) narrsMap[n.nodeId] = { text: n.text, durationMs: n.durationMs };
  fs.writeFileSync(narrsFile, JSON.stringify(narrsMap, null, 2));

  // 5. Run cursor-replay (Playwright records .webm automatically)
  send({ type: 'progress', step: 'record', message: 'Starting replay recording...' });

  await new Promise((resolve, reject) => {
    // Always record at 16:9. Width-led: H derived so the ratio can't drift,
    // even if a browser-side option tries to override only one dimension.
    const rawW = options.viewportW || 1920;
    const viewportW = rawW % 2 === 0 ? rawW : rawW + 1;
    const viewportH = Math.round(viewportW * 9 / 16 / 2) * 2;
    const replayArgs = [
      'cursor-replay.js',
      workflowFile,
      '--narrations', narrsFile,
      '--output', RECORDINGS,
      '--delay', String(options.delay || 800),
      '--viewport', `${viewportW}x${viewportH}`,
    ];
    if (options.comfyUrl) replayArgs.push('--url', options.comfyUrl);

    const proc = spawn('node', replayArgs, {
      cwd:   path.dirname(path.resolve('cursor-replay.js')),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    proc.stdout.on('data', d => {
      const line = d.toString().trim();
      if (line) send({ type: 'log', message: line });
    });
    proc.stderr.on('data', d => {
      const line = d.toString().trim();
      if (line) send({ type: 'log', message: line });
    });
    proc.on('close', code => {
      if (code === 0 || code === null) resolve();
      else reject(new Error(`cursor-replay exited with code ${code}`));
    });
    proc.on('error', reject);
  });

  // 6. Find the recorded webm
  send({ type: 'progress', step: 'mux', message: 'Muxing video and audio...' });
  await sleep(1000); // Let Playwright finalize the file
  const webmPath = findLatestWebm(RECORDINGS);

  // 7. Mux video + audio → build-only mp4
  const buildMp4 = path.join(STUDIO_TMP, `build_${timestamp}.mp4`);
  muxVideoAudio(webmPath, audioAllFile, buildMp4);
  try { fs.unlinkSync(webmPath); } catch(e) {}

  // 8. Run workflow on Comfy Cloud → fetch primary result → append as final segment
  let resultSegment = null;
  try {
    send({ type: 'progress', step: 'cloud_run', message: '☁️  Running workflow on Comfy Cloud...' });
    const job    = await runWorkflowOnCloud(workflowJson,
      msg => send({ type: 'status', message: msg }));
    const result = extractPrimaryResult(job);
    if (!result) throw new Error('No image/video output found in cloud job');

    const url     = buildResultViewUrl(result);
    const ext     = result.kind === 'video' ? 'mp4' : 'png';
    const resPath = path.join(STUDIO_TMP, `result_${timestamp}.${ext}`);
    send({ type: 'status', message: `Downloading result (${result.kind})...` });
    await downloadFile(url, resPath);

    // Closing narration
    const closingText = result.kind === 'video'
      ? 'And here is the rendered video.'
      : 'And here is the final result.';
    const closingMp3 = path.join(AUDIO_DIR, `closing_${timestamp}.mp3`);
    send({ type: 'status', message: 'Generating closing narration...' });
    await generateAudioClip(closingText, closingMp3, voice,
      msg => send({ type: 'status', message: msg }));

    // Match build video specs so concat -c copy works
    const { w, h } = getMediaSize(buildMp4);
    resultSegment  = path.join(STUDIO_TMP, `result_segment_${timestamp}.mp4`);
    send({ type: 'progress', step: 'cloud_append', message: 'Building result segment...' });
    if (result.kind === 'image') {
      buildImageSegment(resPath, closingMp3, 8, w, h, resultSegment);
    } else {
      buildVideoSegment(resPath, closingMp3, w, h, resultSegment);
    }
  } catch(err) {
    send({ type: 'log', message: `⚠️  Cloud-append step failed: ${err.message}` });
    send({ type: 'log', message: '   Falling back to build-only video.' });
  }

  // 9. Final concat (or just rename build if cloud step failed)
  if (resultSegment) {
    send({ type: 'progress', step: 'concat', message: 'Concatenating final video...' });
    concatMp4s([buildMp4, resultSegment], finalVideo);
    try { fs.unlinkSync(buildMp4); fs.unlinkSync(resultSegment); } catch(e) {}
  } else {
    fs.renameSync(buildMp4, finalVideo);
  }

  return finalVideo;
}

// ── WebSocket Server ──────────────────────────────────────────────────────────

// Also serve a tiny HTTP response so the browser can check studio is running
const httpServer = http.createServer((req, res) => {
  res.writeHead(200, {
    'Content-Type':                'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify({ status: 'studio_ready', version: '1.0.0' }));
});

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', ws => {
  console.log('🖥  Browser connected');

  function send(obj) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  }

  // Announce capabilities
  send({ type: 'hello', capabilities: { tts: !!(COMFY_API_KEY || ELEVENLABS_API_KEY) } });

  ws.on('message', async raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch(e) { return; }

    if (msg.type === 'ping') {
      send({ type: 'pong' });
      return;
    }

    if (msg.type === 'generate') {
      try {
        send({ type: 'progress', step: 'start', message: '🎬 Starting video generation...' });
        const finalPath = await generateVideo({
          workflowJson: msg.workflow,
          narrations:   msg.narrations,
          options:      msg.options || {},
          send,
        });
        send({ type: 'done', file: finalPath, filename: path.basename(finalPath) });
        console.log(`✅ Done → ${finalPath}`);
      } catch(err) {
        console.error('❌ Error:', err.message);
        send({ type: 'error', message: err.message });
      }
    }
  });

  ws.on('close', () => console.log('🖥  Browser disconnected'));
});

httpServer.listen(WS_PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════╗
║           ComfyUI Replay Studio  v1.0.0               ║
╠═══════════════════════════════════════════════════════╣
║  WebSocket  →  ws://localhost:${WS_PORT}                   ║
║  Status     →  http://localhost:${WS_PORT}                 ║
╠═══════════════════════════════════════════════════════╣
║  TTS via:   ${COMFY_API_KEY ? '✅ Comfy Cloud                        ' : ELEVENLABS_API_KEY ? '✅ ElevenLabs direct                  ' : '❌ No API key — add to config.local.js'}║
╠═══════════════════════════════════════════════════════╣
║  Open index.html → look for "Studio Connected" badge  ║
╚═══════════════════════════════════════════════════════╝
`);
  if (!COMFY_API_KEY && !ELEVENLABS_API_KEY) {
    console.warn('⚠️  No API key found. Add to config.local.js:');
    console.warn('     module.exports = { comfyApiKey: "YOUR_KEY" }');
    console.warn('   Get your key at: https://comfy.org/settings/api-keys\n');
  }
});
