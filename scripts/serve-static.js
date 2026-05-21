#!/usr/bin/env node
/**
 * Tiny static server for index.html. Used for local development and for
 * the verify-generated-script test below. Adds COOP/COEP headers so the
 * page can use the (optional) ffmpeg.wasm browser MP4 path if a future
 * change swaps to the multi-threaded core.
 *
 *   node scripts/serve-static.js [--port 8080] [--dir .]
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
let port = 8080, dir = path.resolve(__dirname, '..');
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port') port = parseInt(args[++i], 10);
  else if (args[i] === '--dir') dir = path.resolve(args[++i]);
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg',
  '.svg': 'image/svg+xml',
};

http.createServer((req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  let rel = decodeURIComponent(u.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.join(dir, rel);
  // basic path-escape guard
  if (!file.startsWith(dir)) { res.writeHead(403); return res.end('forbidden'); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end('not found'); }
    const headers = {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      // COOP/COEP enables SharedArrayBuffer for ffmpeg.wasm multi-threaded core,
      // if/when that path is enabled. Harmless when not.
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    };
    res.writeHead(200, headers);
    fs.createReadStream(file).pipe(res);
  });
}).listen(port, () => {
  console.log(`📁 serving ${dir} on http://localhost:${port}`);
});
