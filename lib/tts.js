/**
 * ElevenLabs TTS helper with on-disk MP3 cache.
 * Shared between record-server.js (live /tts route) and scripts/verify-audio-mux.js.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const CACHE_DIR = path.join(REPO, 'tts-cache');
fs.mkdirSync(CACHE_DIR, { recursive: true });

function getDefaults() {
  return {
    apiKey: process.env.ELEVENLABS_API_KEY || '',
    voiceId: process.env.ELEVENLABS_VOICE_ID || 'EXAVITQu4vr4xnSDxMaL',
    model: process.env.ELEVENLABS_MODEL || 'eleven_turbo_v2_5',
  };
}

function cacheKey(text, voiceId, model) {
  return crypto.createHash('sha256')
    .update(`${voiceId}|${model}|${text}`)
    .digest('hex').slice(0, 16);
}

function cachePath(key) {
  return path.join(CACHE_DIR, `${key}.mp3`);
}

/**
 * Generate (or retrieve from cache) an MP3 for `text`.
 * Returns { file, key, fromCache }.
 * Throws on ElevenLabs error (e.g. 402, 401, network).
 */
async function tts(text, opts = {}) {
  const { apiKey, voiceId, model } = { ...getDefaults(), ...opts };
  if (!apiKey) throw new Error('ELEVENLABS_API_KEY not set in environment');

  const key = cacheKey(text, voiceId, model);
  const file = cachePath(key);
  if (fs.existsSync(file) && fs.statSync(file).size > 0) {
    return { file, key, fromCache: true };
  }

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
      'accept': 'audio/mpeg',
    },
    body: JSON.stringify({ text, model_id: model }),
  });
  if (!resp.ok) {
    const err = await resp.text().catch(() => '');
    throw new Error(`ElevenLabs ${resp.status}: ${err.slice(0, 400)}`);
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  fs.writeFileSync(file, buf);
  return { file, key, fromCache: false };
}

/**
 * Probe an audio file's duration in ms.
 */
function probeDurationMs(file) {
  const out = execFileSync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', file,
  ]).toString().trim();
  return Math.round(parseFloat(out) * 1000);
}

/**
 * Mux per-beat audio clips onto a video at given startMs offsets.
 * Uses the verified adelay + amix pattern.
 *
 *   beats: [{ file: '/abs/path.mp3', startMs: number }]
 *
 * Throws on ffmpeg failure. Returns nothing.
 */
function muxBeatsOntoVideo(videoFile, beats, outFile) {
  if (!beats.length) throw new Error('muxBeatsOntoVideo: no beats');
  const args = ['-y', '-i', videoFile];
  beats.forEach(b => args.push('-i', b.file));

  const N = beats.length;
  const delayChain = beats.map((b, i) =>
    `[${i+1}:a]adelay=${b.startMs}|${b.startMs}:all=1[a${i}]`
  ).join(';');
  const mixInputs = beats.map((_, i) => `[a${i}]`).join('');
  const filter = `${delayChain};${mixInputs}amix=inputs=${N}:duration=longest:normalize=0[aout]`;

  args.push('-filter_complex', filter);
  args.push('-map', '0:v', '-map', '[aout]');
  args.push('-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k');
  args.push(outFile);

  execFileSync('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
}

module.exports = { tts, probeDurationMs, muxBeatsOntoVideo, cachePath, CACHE_DIR };
