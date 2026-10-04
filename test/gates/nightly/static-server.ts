// AA 00060 P2 (G-NIGHTLY part A): a tiny static server for the built site (`web/dist`), run in the
// `oven/bun` image by run-probe.sh. It serves files only (no directory listing, no path outside the
// root), with the content types the page needs (`application/wasm` for ledger-v9's WASM).
//
//   SITE_DIR=/site PORT=8080 bun static-server.ts

import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, normalize, sep } from 'node:path';

const root = normalize(process.env.SITE_DIR ?? '/site');
const port = Number(process.env.PORT ?? 8080);
const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json',
  wasm: 'application/wasm',
  woff2: 'font/woff2',
  svg: 'image/svg+xml',
  png: 'image/png',
  ico: 'image/x-icon',
  txt: 'text/plain; charset=utf-8',
  map: 'application/json',
};

createServer(async (req, res) => {
  const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
  const path = normalize(join(root, pathname === '/' ? 'index.html' : pathname));
  if (path !== root && !path.startsWith(root + sep)) {
    res.writeHead(404).end('not found');
    return;
  }
  try {
    const body = await readFile(path);
    const ext = path.split('.').pop() ?? '';
    res
      .writeHead(200, { 'content-type': TYPES[ext] ?? 'application/octet-stream', 'cache-control': 'no-store' })
      .end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(port, '0.0.0.0', () => console.log(`static-server: ${root} on :${port}`));
