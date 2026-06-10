#!/usr/bin/env node
/**
 * Dev HTTP server with no-cache headers so JS edits are always picked up
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 5500;
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
};

http.createServer((req, res) => {
  const urlPath = new URL(req.url, `http://localhost:${PORT}`).pathname;
  let filePath = path.join(ROOT, urlPath === '/' ? '/index.html' : urlPath);

  if (!fs.existsSync(filePath)) {
    res.writeHead(404); res.end('Not Found'); return;
  }
  if (fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, 'index.html');
  }

  const ext = path.extname(filePath);
  const mime = MIME[ext] || 'application/octet-stream';

  res.writeHead(200, {
    'Content-Type': mime,
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0',
  });
  fs.createReadStream(filePath).pipe(res);
}).listen(PORT, '127.0.0.1', () => console.log(`✅ Dev server (no-cache) running on http://localhost:${PORT}`));
