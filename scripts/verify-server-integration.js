#!/usr/bin/env node
/**
 * Full server integration test:
 *   1. Spawn record-server.js with --mock-capture (no real screen recording)
 *   2. Connect WS, send {type:'start'}
 *   3. Pre-fetch TTS for the 16 example narrations via POST /tts
 *      (uses the SAME cache as scripts/verify-audio-mux.js)
 *   4. Send {type:'step', name, timeMs, audioKey} for each, with cumulative timeMs
 *      = sum of prior clip durations (mirroring the in-page replay loop)
 *   5. Send {type:'stop'}
 *   6. Wait for server's 'done' message — pulls back outputFile + voicedFile
 *   7. RMS-verify the produced -voiced.mp4 has audio at each expected timecode
 *
 * Proves: server collects audioKey'd events, builds timelineBeats, muxes correctly.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const WebSocket = require('ws');

const REPO = path.resolve(__dirname, '..');
const PORT = 3097;
const OUT = path.join(REPO, 'recordings');
fs.mkdirSync(OUT, { recursive: true });

const NARR = require('./_example-narrations.js'); // [[id, text], ...]

(async () => {
  let exitCode = 0;
  const srv = spawn('node', [path.join(REPO, 'record-server.js'),
    '--port', String(PORT), '--mock-capture', '--output', OUT, '--fps', '24'
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  srv.stdout.on('data', d => process.stdout.write('  [srv] ' + d));
  srv.stderr.on('data', d => process.stderr.write('  [srv!] ' + d));
  // wait for "Waiting for replay to connect"
  await new Promise(r => {
    srv.stdout.on('data', d => { if (d.toString().includes('Waiting for replay')) r(); });
  });

  try {
    // Pre-fetch TTS for all clips
    console.log('▶ prefetching TTS for', NARR.length, 'beats');
    const beats = [];
    for (const [id, text] of NARR) {
      const r = await fetch(`http://localhost:${PORT}/tts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(`/tts ${id}: ${j.error}`);
      beats.push({ id, audioKey: j.key, durationMs: j.durationMs });
    }
    // Compute cumulative startMs identically to the in-page replay
    const VISUAL_MS = 800;
    let cur = 0;
    beats.forEach(b => { b.startMs = cur; cur += Math.max(VISUAL_MS, b.durationMs); });
    const totalMs = cur;
    console.log(`▶ total timeline ${totalMs}ms across ${beats.length} beats`);

    // Connect WS
    const ws = new WebSocket(`ws://localhost:${PORT}`);
    await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
    console.log('▶ WS connected');

    let donePromiseResolve;
    const donePromise = new Promise(res => { donePromiseResolve = res; });
    ws.on('message', raw => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'done') donePromiseResolve(m);
    });

    // start
    ws.send(JSON.stringify({ type: 'start' }));
    await new Promise(r => setTimeout(r, 800)); // let ffmpeg warm up

    // step events with audioKey
    for (const b of beats) {
      ws.send(JSON.stringify({ type: 'step', name: 'Beat: ' + b.id, timeMs: b.startMs, audioKey: b.audioKey }));
    }

    // Wait for ffmpeg to produce a long-enough video, then stop
    // (mock capture is real-time lavfi; we need it to actually run for totalMs)
    console.log(`▶ waiting ${(totalMs/1000).toFixed(1)}s for mock capture...`);
    await new Promise(r => setTimeout(r, totalMs + 500));
    ws.send(JSON.stringify({ type: 'stop' }));

    const done = await donePromise;
    console.log('▶ server done:', { file: path.basename(done.file), voiced: done.voicedFile ? path.basename(done.voicedFile) : null, muxError: done.muxError });
    ws.close();

    if (done.muxError) throw new Error('mux error: ' + done.muxError);
    if (!done.voicedFile) throw new Error('no voicedFile produced');
    if (!fs.existsSync(done.voicedFile)) throw new Error('voicedFile missing: ' + done.voicedFile);

    // Verify audio at expected timecodes using RMS sampling
    function rmsAt(file, startMs, durMs) {
      const { spawnSync } = require('child_process');
      const r = spawnSync('ffmpeg', [
        '-v', 'info', '-ss', (startMs/1000).toFixed(3), '-t', (durMs/1000).toFixed(3),
        '-i', file, '-vn', '-af', 'astats=reset=1', '-f', 'null', '-',
      ]);
      const out = (r.stderr || '').toString();
      const ms = [...out.matchAll(/RMS level dB:\s*(-?\d+\.?\d*|-?inf|nan)/g)];
      if (!ms.length) return null;
      const last = ms[ms.length-1][1];
      return (last === '-inf' || last === 'inf' || last === 'nan') ? -Infinity : parseFloat(last);
    }

    console.log(`\n▶ RMS verification on ${path.basename(done.voicedFile)}`);
    const THRESHOLD = -45;
    let pass = 0, fail = 0;
    beats.forEach(b => {
      const samples = [0.25, 0.5, 0.75].map(f => rmsAt(done.voicedFile, b.startMs + Math.floor(b.durationMs * f), 200));
      const heard = samples.some(rms => rms != null && rms >= THRESHOLD);
      if (heard) pass++; else fail++;
      console.log(`  ${heard ? '✓' : '✗'} ${b.id.padEnd(20)} @${b.startMs}ms  rms=[${samples.map(r => r == null ? 'n/a' : r.toFixed(1)).join(' ')}]`);
    });
    console.log(`\n${fail === 0 ? '✅ PASS' : '❌ FAIL'} ${pass}/${beats.length} beats audible in muxed output`);
    if (fail) exitCode = 2;
  } catch (e) {
    console.error('FATAL:', e.message);
    exitCode = 1;
  } finally {
    srv.kill('SIGINT');
    await new Promise(r => setTimeout(r, 300));
  }
  process.exit(exitCode);
})();
