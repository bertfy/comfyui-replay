#!/usr/bin/env node

/**
 * ComfyUI Replay Recording Server
 *
 * Launches ffmpeg to capture the screen while the replay runs in ComfyUI.
 * Communicates with the browser-side replay script via WebSocket.
 *
 * Usage:
 *   node record-server.js [--port 3001] [--screen 3] [--fps 30] [--output ./recordings]
 *
 * The browser replay script connects to ws://localhost:3001 and sends:
 *   { type: "start" }                                              → begin recording
 *   { type: "step", name: "...", timeMs: 1234, audioKey?: "..." } → log a step event;
 *                                                                    if audioKey is present, server
 *                                                                    will mux that VO clip at timeMs
 *   { type: "stop" }                                               → stop recording, mux audio, generate files
 *
 * The browser ALSO talks to the server over HTTP for TTS:
 *   POST /tts            body: { text }            → { audioUrl, durationMs, key }
 *   GET  /tts-cache/:key.mp3                       → serves cached MP3 (for browser playback)
 *   GET  /health                                   → { ok: true }
 */

require("dotenv").config();

const http = require("http");
const { spawn, execSync } = require("child_process");
const { WebSocketServer } = require("ws");
const fs = require("fs");
const path = require("path");
const { tts, probeDurationMs, muxBeatsOntoVideo, cachePath, CACHE_DIR } = require("./lib/tts");

// ─── CLI Args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
let wsPort = 3001;
let screenDevice = null; // auto-detect if not specified
let fps = 30;
let outputDir = path.join(require("os").homedir(), "Desktop");
// libx264 is the reliable default. h264_videotoolbox is faster but fails on
// resolutions wider than ~4096px (ultrawide screens) with "Cannot create
// compression session: -12903". Use --codec h264_videotoolbox to opt-in.
let codec = "libx264";
let maxWidth = 2560; // downscale wider screens; -1 to disable. Use --max-width.
let windowUrl = null; // --window-url <substring> → crop ffmpeg to that Chrome window
let cropOverride = null; // --crop W:H:X:Y → explicit crop
let resizeAspect = null; // --resize W:H → resize Chrome window to fit aspect ratio on screen
let mockCapture = false; // --mock-capture: replace screen capture with lavfi color source (for tests)

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--port" && args[i + 1]) { wsPort = parseInt(args[i + 1], 10); i++; }
  else if (args[i] === "--screen" && args[i + 1]) { screenDevice = args[i + 1]; i++; }
  else if (args[i] === "--fps" && args[i + 1]) { fps = parseInt(args[i + 1], 10); i++; }
  else if (args[i] === "--output" && args[i + 1]) { outputDir = args[i + 1]; i++; }
  else if (args[i] === "--codec" && args[i + 1]) { codec = args[i + 1]; i++; }
  else if (args[i] === "--max-width" && args[i + 1]) { maxWidth = parseInt(args[i + 1], 10); i++; }
  else if (args[i] === "--window-url" && args[i + 1]) { windowUrl = args[i + 1]; i++; }
  else if (args[i] === "--crop" && args[i + 1]) { cropOverride = args[i + 1]; i++; }
  else if (args[i] === "--resize" && args[i + 1]) { resizeAspect = args[i + 1]; i++; }
  else if (args[i] === "--mock-capture") { mockCapture = true; }
}

// ─── Auto-detect screen device ─────────────────────────────────────────────────

function detectScreenDevice() {
  if (screenDevice !== null) return screenDevice;

  try {
    const output = execSync('ffmpeg -f avfoundation -list_devices true -i "" 2>&1', {
      encoding: "utf-8",
      timeout: 5000,
    }).toString();
    // Look for "Capture screen N" lines
    const match = output.match(/\[(\d+)\]\s+Capture screen/);
    if (match) {
      console.log(`📺 Auto-detected screen capture device: [${match[1]}]`);
      return match[1];
    }
  } catch (e) {
    // execSync throws on non-zero exit — ffmpeg -list_devices always exits non-zero
    const output = e.stdout?.toString() || e.stderr?.toString() || e.message || "";
    const match = output.match(/\[(\d+)\]\s+Capture screen/);
    if (match) {
      console.log(`📺 Auto-detected screen capture device: [${match[1]}]`);
      return match[1];
    }
  }

  console.warn("⚠️  Could not auto-detect screen device, defaulting to '3'");
  return "3";
}

// ─── Check codec availability ──────────────────────────────────────────────────

// ─── Main display size (in points = pixels on 1x; pixels/2 on 2x retina) ──────
function getMainScreenSize() {
  try {
    const out = execSync('system_profiler SPDisplaysDataType', { timeout: 5000 }).toString();
    // First "Resolution: W x H" is the main display
    const m = out.match(/Resolution:\s*(\d+)\s*x\s*(\d+)/);
    if (m) return { w: parseInt(m[1], 10), h: parseInt(m[2], 10) };
  } catch (e) { /* fall through */ }
  return null;
}

// ─── Display CSS-points-to-physical-pixels scale (1 on non-retina, 2 on retina) ─
// Compares physical "Resolution" to logical "UI Looks like" from system_profiler.
function getDisplayScale() {
  try {
    const out = execSync('system_profiler SPDisplaysDataType', { timeout: 5000 }).toString();
    const phys = out.match(/Resolution:\s*(\d+)\s*x\s*(\d+)/);
    const logi = out.match(/UI Looks like:\s*(\d+)\s*x\s*(\d+)/);
    if (phys && logi) {
      const s = +phys[1] / +logi[1];
      // Snap to nearest 0.5 (typical scales: 1, 1.5, 2, 2.5, 3)
      const snapped = Math.round(s * 2) / 2;
      return snapped >= 1 ? snapped : 1;
    }
  } catch (e) { /* fall through */ }
  return 1;
}

// ─── Resize a Chrome window matching urlSubstr to (x,y,w,h) in screen points ──
function resizeChromeWindow(urlSubstr, x, y, w, h) {
  const escaped = urlSubstr.replace(/"/g, '\\"');
  const x2 = x + w, y2 = y + h;
  const script = `
    tell application "Google Chrome"
      repeat with W in windows
        repeat with T in tabs of W
          if URL of T contains "${escaped}" then
            set bounds of W to {${x}, ${y}, ${x2}, ${y2}}
            return "OK"
          end if
        end repeat
      end repeat
      return "MISS"
    end tell
  `;
  try {
    const out = execSync(`osascript -`, { input: script, timeout: 5000 }).toString().trim();
    return out === "OK";
  } catch (e) {
    console.warn(`   ⚠️  resizeChromeWindow error: ${e.message}`);
    return false;
  }
}

// Largest (w,h) of given aspect that fits within (availW, availH).
function fitAspect(availW, availH, arN, arD) {
  const ar = arN / arD;
  let w, h;
  if (availW / availH > ar) { h = availH; w = Math.round(h * ar); }
  else                      { w = availW; h = Math.round(w / ar); }
  return { w, h };
}

// ─── Chrome VIEWPORT rect (excludes browser chrome + DevTools, any dock side) ─
// Returns { rect: {x,y,w,h} } in CSS points, or { error: string } on failure.
// Requires Chrome → View → Developer → "Allow JavaScript from Apple Events" to be
// enabled. The server prints a one-time setup message if it isn't.
function findChromeViewportRect(urlSubstr) {
  const escaped = urlSubstr.replace(/"/g, '\\"');
  // Pipe to osascript stdin (osascript -) so nested quotes don't fight shell escaping.
  const script = `
    tell application "Google Chrome"
      repeat with W in windows
        repeat with i from 1 to count of tabs of W
          set T to tab i of W
          if URL of T contains "${escaped}" then
            try
              return (execute T javascript "JSON.stringify([window.screenX,window.screenY,window.innerWidth,window.innerHeight,window.devicePixelRatio])")
            on error errMsg number errNum
              return "ERR:" & errNum & ":" & errMsg
            end try
          end if
        end repeat
      end repeat
      return "MISS"
    end tell
  `;
  try {
    const out = execSync(`osascript -`, { input: script, timeout: 5000 }).toString().trim();
    if (out === "MISS") return { error: "no tab matched" };
    if (out.startsWith("ERR:")) return { error: out };
    const arr = JSON.parse(out);
    return { rect: { x: arr[0], y: arr[1], w: arr[2], h: arr[3] }, dpr: arr[4] || 1 };
  } catch (e) {
    return { error: e.message };
  }
}

// ─── Chrome window bounds via AppleScript ──────────────────────────────────────
// Returns { x, y, w, h } for the first Chrome window whose ANY tab URL contains
// the given substring. Bounds are in screen points; on a 1x display these equal
// pixels. (Chrome's AppleScript dictionary is exposed without accessibility
// permission, unlike System Events.) Used as a fallback when "Allow JavaScript
// from Apple Events" is disabled — gives the whole-window rect including UI chrome.
function findChromeWindowBounds(urlSubstr) {
  const escaped = urlSubstr.replace(/"/g, '\\"');
  const script = `
    tell application "Google Chrome"
      set match to missing value
      repeat with w in windows
        repeat with t in tabs of w
          if URL of t contains "${escaped}" then
            set match to w
            exit repeat
          end if
        end repeat
        if match is not missing value then exit repeat
      end repeat
      if match is missing value then return "MISS"
      set b to bounds of match
      return ((item 1 of b) as text) & "," & ((item 2 of b) as text) & "," & ((item 3 of b) as text) & "," & ((item 4 of b) as text)
    end tell
  `;
  try {
    const out = execSync(`osascript -`, { input: script, timeout: 5000 }).toString().trim();
    if (out === "MISS") return null;
    const [l, t, r, b] = out.split(",").map(s => parseInt(s.trim(), 10));
    if ([l, t, r, b].some(n => !Number.isFinite(n))) return null;
    return { x: l, y: t, w: r - l, h: b - t };
  } catch (e) {
    console.warn(`   ⚠️  findChromeWindowBounds error: ${e.message}`);
    return null;
  }
}

function checkCodec(preferred) {
  try {
    const output = execSync(`ffmpeg -codecs 2>&1`, { encoding: "utf-8", timeout: 5000 });
    if (output.includes(preferred)) return preferred;
  } catch (e) {
    const output = e.stdout?.toString() || e.stderr?.toString() || "";
    if (output.includes(preferred)) return preferred;
  }
  console.log(`⚠️  Codec ${preferred} not available, falling back to libx264`);
  return "libx264";
}

// ─── FCPXML Generation ─────────────────────────────────────────────────────────

function generateFCPXML(stepEvents, videoFile, durationMs) {
  const durationFrames = Math.round((durationMs / 1000) * fps);
  const videoBasename = path.basename(videoFile);

  let clipsXml = "";
  for (let i = 0; i < stepEvents.length; i++) {
    const e = stepEvents[i];
    const nxt = i < stepEvents.length - 1
      ? stepEvents[i + 1].timeMs
      : durationMs;

    const startFrame = Math.round((e.timeMs / 1000) * fps);
    let endFrame = Math.round((nxt / 1000) * fps);

    if (endFrame <= startFrame) endFrame = startFrame + 1;
    if (endFrame > durationFrames) endFrame = durationFrames;
    if (startFrame >= durationFrames) break;

    // First clip includes the full file definition
    const fileDef = i === 0
      ? `<file id="file-1"><name>${videoBasename}</name><pathurl>file://localhost/${videoBasename}</pathurl><rate><timebase>${fps}</timebase><ntsc>FALSE</ntsc></rate><duration>${durationFrames}</duration><media><video><duration>${durationFrames}</duration><samplecharacteristics><width>1920</width><height>1080</height></samplecharacteristics></video></media></file>`
      : `<file id="file-1"/>`;

    clipsXml += `\n<clipitem id="clip-${i}"><name>${escapeXml(e.name)}</name><duration>${durationFrames}</duration><rate><timebase>${fps}</timebase><ntsc>FALSE</ntsc></rate><start>${startFrame}</start><end>${endFrame}</end><in>${startFrame}</in><out>${endFrame}</out>${fileDef}</clipitem>`;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="4"><project><name>Comfy Replay</name><children><sequence id="sequence-1"><name>Replay Sequence</name><duration>${durationFrames}</duration><rate><timebase>${fps}</timebase><ntsc>FALSE</ntsc></rate><media><video><track>${clipsXml}</track></video></media></sequence></children></project></xmeml>`;
}

function escapeXml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ─── HTTP routing (CORS open; localhost is a secure context per Chrome) ───────

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
};

function send(res, code, body, headers = {}) {
  res.writeHead(code, { ...CORS_HEADERS, ...headers });
  res.end(body);
}

function sendJson(res, code, obj) {
  send(res, code, JSON.stringify(obj), { "Content-Type": "application/json" });
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

const httpServer = http.createServer(async (req, res) => {
  const u = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (req.method === "OPTIONS") return send(res, 204, "");

  if (req.method === "GET" && u.pathname === "/health") {
    return sendJson(res, 200, {
      ok: true,
      hasKey: !!process.env.ELEVENLABS_API_KEY,
      voiceId: process.env.ELEVENLABS_VOICE_ID || "EXAVITQu4vr4xnSDxMaL",
    });
  }

  // GET /tts-cache/<key>.mp3 — serve cached audio for browser playback
  if (req.method === "GET" && u.pathname && u.pathname.startsWith("/tts-cache/")) {
    const fname = u.pathname.slice("/tts-cache/".length);
    if (!/^[a-f0-9]{16}\.mp3$/.test(fname)) return send(res, 400, "bad cache key");
    const file = path.join(CACHE_DIR, fname);
    if (!fs.existsSync(file)) return send(res, 404, "not cached");
    const stat = fs.statSync(file);
    res.writeHead(200, {
      ...CORS_HEADERS,
      "Content-Type": "audio/mpeg",
      "Content-Length": stat.size,
      "Cache-Control": "public, max-age=31536000, immutable",
    });
    fs.createReadStream(file).pipe(res);
    return;
  }

  // POST /tts — generate (or fetch from cache) MP3 for narration text
  if (req.method === "POST" && u.pathname === "/tts") {
    try {
      const body = JSON.parse(await readBody(req));
      const text = String(body.text || "").trim();
      if (!text) return sendJson(res, 400, { error: "missing text" });

      const { file, key, fromCache } = await tts(text);
      const durationMs = probeDurationMs(file);
      console.log(`   🗣  /tts ${fromCache ? "[cache]" : "[gen]  "} ${durationMs}ms  "${text.slice(0, 60)}${text.length > 60 ? "…" : ""}"`);

      return sendJson(res, 200, {
        key,
        audioUrl: `/tts-cache/${key}.mp3`,
        durationMs,
        fromCache,
      });
    } catch (e) {
      console.error("   /tts error:", e.message);
      return sendJson(res, 500, { error: e.message });
    }
  }

  return send(res, 404, "not found");
});

// ─── Main Server ───────────────────────────────────────────────────────────────

fs.mkdirSync(outputDir, { recursive: true });

const resolvedCodec = checkCodec(codec);
const device = detectScreenDevice();

// Attach WebSocket to the same HTTP server so they share a port.
const wss = new WebSocketServer({ server: httpServer });
httpServer.listen(wsPort);

console.log(`\n🎬 ComfyUI Recording Server`);
console.log(`   HTTP/WS:  http://localhost:${wsPort}  (ws://localhost:${wsPort})`);
console.log(`   Screen device: ${device}`);
console.log(`   Codec: ${resolvedCodec}`);
console.log(`   FPS: ${fps}`);
console.log(`   Output: ${path.resolve(outputDir)}`);
console.log(`   TTS:    ${process.env.ELEVENLABS_API_KEY ? "✓ ElevenLabs key loaded" : "✗ ELEVENLABS_API_KEY missing — /tts will fail"}`);
console.log(`\n⏳ Waiting for replay to connect...\n`);

let activeRecording = null;

wss.on("connection", (ws) => {
  console.log("🔌 Replay connected");
  let ffmpegProc = null;
  let stepEvents = [];
  let startTime = null;
  let outputFile = null;
  let timelineBeats = null; // [{ id, startMs, file }] built from audioKey'd step events

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    // ── START ────────────────────────────────────────────────────
    if (msg.type === "start") {
      const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      outputFile = path.join(outputDir, `comfyui-replay-${ts}.mp4`);
      stepEvents = [];
      startTime = Date.now();

      // Build a video filter chain: optionally crop to a single Chrome window,
      // downscale wide screens, force even dimensions for yuv420p, and bake in
      // the pixel format.
      const vfParts = [];

      // Auto-resize the Chrome window to a target aspect ratio (largest fit).
      // macOS menu bar is ~25px tall and you can't place windows underneath it,
      // so we start at y=25 and reduce available height accordingly.
      if (resizeAspect && windowUrl) {
        const m = /^(\d+):(\d+)$/.exec(resizeAspect);
        if (!m) {
          console.warn(`   ⚠️  --resize "${resizeAspect}" must be W:H (e.g. 16:9)`);
        } else {
          const screen = getMainScreenSize();
          if (!screen) {
            console.warn(`   ⚠️  could not detect screen size; skipping resize`);
          } else {
            const MENU_BAR = 25;
            const fit = fitAspect(screen.w, screen.h - MENU_BAR, +m[1], +m[2]);
            const ok = resizeChromeWindow(windowUrl, 0, MENU_BAR, fit.w, fit.h);
            if (ok) {
              console.log(`   📐 Resized Chrome("${windowUrl}") to ${fit.w}x${fit.h} (${resizeAspect}) on ${screen.w}x${screen.h} screen`);
              // give Chrome a beat to apply the new bounds before we read them
              execSync('sleep 0.3');
            } else {
              console.warn(`   ⚠️  Could not resize: no Chrome window contains "${windowUrl}"`);
            }
          }
        }
      }

      // Crop selection: prefer the JS-driven VIEWPORT rect (excludes browser
      // chrome + DevTools, regardless of dock side). Fall back to window bounds
      // if Chrome's "Allow JavaScript from Apple Events" is disabled.
      let cropSpec = null;
      if (cropOverride) {
        cropSpec = cropOverride; // user gave "W:H:X:Y" directly
      } else if (windowUrl) {
        const scale = getDisplayScale(); // CSS points → physical pixels
        const vp = findChromeViewportRect(windowUrl);
        if (vp.rect) {
          // Multiply by display scale so the crop is in avfoundation's pixel space.
          // Prefer Chrome's reported devicePixelRatio when present (matches retina exactly).
          const k = vp.dpr || scale;
          const W = Math.round(vp.rect.w * k), H = Math.round(vp.rect.h * k);
          const X = Math.round(vp.rect.x * k), Y = Math.round(vp.rect.y * k);
          // ffmpeg crop expects even values for yuv420p
          const We = W - (W % 2), He = H - (H % 2);
          cropSpec = `${We}:${He}:${X}:${Y}`;
          console.log(`   ✂  Cropping to Chrome VIEWPORT "${windowUrl}" → ${cropSpec} (devtools/url-bar excluded; dpr=${k})`);
        } else {
          // Viewport detection failed — figure out why and inform user.
          const errStr = vp.error || "";
          const jsBlocked = /1743|10004|not allowed|Allow JavaScript|sending Apple events/i.test(errStr);
          if (jsBlocked) {
            console.warn(`   ⚠️  Chrome blocks JS-from-AppleScript. Enable: View → Developer → "Allow JavaScript from Apple Events"`);
            console.warn(`        Then DevTools will be auto-excluded from recordings. Falling back to whole-window crop for now.`);
          } else if (errStr === "no tab matched") {
            console.warn(`   ⚠️  No tab containing "${windowUrl}" — recording full screen`);
          } else {
            console.warn(`   ⚠️  Viewport detection failed: ${errStr}`);
          }
          // Fallback: whole-window bounds (includes URL bar + tabs + any docked DevTools)
          const b = findChromeWindowBounds(windowUrl);
          if (b) {
            const W = Math.round(b.w * scale), H = Math.round(b.h * scale);
            const X = Math.round(b.x * scale), Y = Math.round(b.y * scale);
            const We = W - (W % 2), He = H - (H % 2);
            cropSpec = `${We}:${He}:${X}:${Y}`;
            console.log(`   ✂  Cropping to Chrome WINDOW "${windowUrl}" → ${cropSpec} (chrome UI included)`);
          }
        }
      }
      if (cropSpec) vfParts.push(`crop=${cropSpec}`);

      if (maxWidth > 0) {
        vfParts.push(`scale='min(${maxWidth},iw)':-2:flags=lanczos`);
      } else {
        vfParts.push(`scale=trunc(iw/2)*2:trunc(ih/2)*2`); // ensure even dims
      }
      vfParts.push("format=yuv420p");
      const vfChain = vfParts.join(",");

      const ffmpegArgs = mockCapture
        ? [
            // Headless test mode: render a black 1280x720 video at <fps> until 'q' is pressed.
            "-f", "lavfi", "-i", `color=c=black:s=1280x720:r=${fps}`,
            "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
            "-y", outputFile,
          ]
        : [
            "-f", "avfoundation",
            "-framerate", String(fps),
            "-i", `${device}:none`,
            "-vf", vfChain,
            "-c:v", resolvedCodec,
            ...(resolvedCodec === "libx264"
              ? ["-preset", "fast", "-crf", "20"]
              : ["-allow_sw", "1", "-q:v", "55"]), // -allow_sw forces software fallback if HW fails
            "-r", String(fps),
            "-y",
            outputFile,
          ];

      console.log(`\n🔴 Recording started → ${outputFile}`);
      console.log(`   ffmpeg ${ffmpegArgs.join(" ")}`);

      ffmpegProc = spawn("ffmpeg", ffmpegArgs, { stdio: ["pipe", "pipe", "pipe"] });
      activeRecording = { proc: ffmpegProc, outputFile, stepEvents };

      ffmpegProc.stderr.on("data", (data) => {
        // Only show ffmpeg errors/warnings, not the verbose progress
        const line = data.toString().trim();
        if (line.includes("Error") || line.includes("error") || line.includes("Warning")) {
          console.error(`   ffmpeg: ${line}`);
        }
      });

      ffmpegProc.on("close", (code) => {
        console.log(`   ffmpeg exited with code ${code}`);
        activeRecording = null;
      });

      ws.send(JSON.stringify({ type: "recording", file: outputFile }));
    }

    // ── STEP EVENT ───────────────────────────────────────────────
    // If the event carries audioKey (16-hex sha256 prefix), record it as a
    // VO beat for muxing — server will compose audio at timeMs on stop.
    else if (msg.type === "step") {
      stepEvents.push({ name: msg.name, timeMs: msg.timeMs });
      const elapsed = ((msg.timeMs) / 1000).toFixed(1);

      if (typeof msg.audioKey === "string" && /^[a-f0-9]{16}$/.test(msg.audioKey)) {
        const file = cachePath(msg.audioKey);
        if (fs.existsSync(file)) {
          if (!timelineBeats) timelineBeats = [];
          timelineBeats.push({ id: msg.name, startMs: Math.max(0, msg.timeMs | 0), file });
          console.log(`   📌 [${elapsed}s] ${msg.name}  🎵 ${msg.audioKey}.mp3`);
        } else {
          console.warn(`   ⚠️  [${elapsed}s] ${msg.name} — audioKey ${msg.audioKey} not in cache`);
        }
      } else {
        console.log(`   📌 [${elapsed}s] ${msg.name}`);
      }
    }

    // ── STOP ─────────────────────────────────────────────────────
    else if (msg.type === "stop") {
      const durationMs = Date.now() - (startTime || Date.now());
      console.log(`\n⏹  Stopping recording (${(durationMs / 1000).toFixed(1)}s)...`);

      if (ffmpegProc && !ffmpegProc.killed) {
        // Send 'q' to ffmpeg stdin for graceful shutdown
        ffmpegProc.stdin.write("q");

        ffmpegProc.on("close", () => {
          const result = { type: "done", file: outputFile };

          // ── Mux VO audio if we have a timeline ─────────────────
          if (timelineBeats && timelineBeats.length > 0) {
            const voicedFile = outputFile.replace(/\.mp4$/, "-voiced.mp4");
            try {
              console.log(`🎙️  Muxing ${timelineBeats.length} VO clips → ${voicedFile}`);
              muxBeatsOntoVideo(outputFile, timelineBeats, voicedFile);
              result.voicedFile = voicedFile;
              console.log(`✅ Voiced video saved → ${voicedFile}`);
            } catch (e) {
              console.error(`   mux error: ${e.message}`);
              result.muxError = e.message;
            }
          }

          // Generate FCPXML if we have step events
          if (stepEvents.length > 0) {
            const xmlContent = generateFCPXML(stepEvents, outputFile, durationMs);
            const xmlFile = outputFile.replace(/\.mp4$/, ".xml");
            fs.writeFileSync(xmlFile, xmlContent, "utf-8");
            result.xml = xmlFile;
            console.log(`📋 FCPXML saved → ${xmlFile}`);
          }

          console.log(`✅ Silent video saved → ${outputFile}`);
          console.log(`\n⏳ Waiting for next replay...\n`);

          ws.send(JSON.stringify(result));
        });
      } else {
        ws.send(JSON.stringify({ type: "done", file: outputFile, error: "ffmpeg was not running" }));
      }
    }
  });

  ws.on("close", () => {
    console.log("🔌 Replay disconnected");
    // If recording is still running, stop it gracefully
    if (ffmpegProc && !ffmpegProc.killed) {
      console.log("   Stopping orphaned recording...");
      ffmpegProc.stdin.write("q");
    }
  });

  ws.on("error", (err) => {
    console.error("WebSocket error:", err.message);
  });
});

// ─── Graceful shutdown ─────────────────────────────────────────────────────────

process.on("SIGINT", () => {
  console.log("\n\n🛑 Shutting down...");
  if (activeRecording?.proc && !activeRecording.proc.killed) {
    activeRecording.proc.stdin.write("q");
  }
  wss.close();
  setTimeout(() => process.exit(0), 1000);
});
