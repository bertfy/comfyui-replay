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
    const replayArgs = [
      'cursor-replay.js',
      workflowFile,
      '--narrations', narrsFile,
      '--output', RECORDINGS,
      '--delay', String(options.delay || 800),
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

  // 7. Mux video + audio → final mp4
  muxVideoAudio(webmPath, audioAllFile, finalVideo);

  // 8. Clean up webm
  try { fs.unlinkSync(webmPath); } catch(e) {}

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
