// AA 00057 P5R: a copy of AA 00060's P9.5 owner-site-server.ts (evidence/00060-night-market-bridge-wallet/p9/harness/
// owner-site-server.ts), used by e2e/stagenet/run-gate.sh to serve Night Market's built site against stagenet.
//
// AA 00060 P9.5 (G-NIGHTLY part B): Night Market's built site for the owner's by-hand session, served on the
// P9 stack's network and published on 127.0.0.1 only. Like production (deploy/web/nginx.conf `/relay/`),
// the relay shares the site's origin, so no CORS is needed. The mock exchange (`kernel`, `batcher`) is
// served the same way because it sends no CORS headers. The indexer, the Solana validator, the bridge
// nodes' APIs and the injector are called directly (they answer cross-origin). Files are served only
// from the site directory, with no listing.
//
//   SITE_DIR=/site PORT=8080 bun owner-site-server.ts      (in oven/bun on the stack network)

import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage } from 'node:http';
import { join, normalize, sep } from 'node:path';

const root = normalize(process.env.SITE_DIR ?? '/site');
const port = Number(process.env.PORT ?? 8080);
const PROXIES: ReadonlyArray<[string, string]> = [
  ['/relay/', process.env.RELAY_UPSTREAM ?? 'http://relay:8080/'],
  ['/kernel/', process.env.KERNEL_UPSTREAM ?? 'http://kernel:9999/'],
  ['/batcher/', process.env.BATCHER_UPSTREAM ?? 'http://batcher:3334/'],
];
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
const HOP = new Set(['host', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'content-length']);

const bodyOf = (req: IncomingMessage): Promise<Buffer> =>
  new Promise((ok, fail) => {
    const parts: Buffer[] = [];
    req.on('data', (c: Buffer) => parts.push(c));
    req.on('end', () => ok(Buffer.concat(parts)));
    req.on('error', fail);
  });

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  for (const [prefix, upstream] of PROXIES) {
    if (!url.pathname.startsWith(prefix)) continue;
    const target = `${upstream}${url.pathname.slice(prefix.length)}${url.search}`;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k) && typeof v === 'string') headers[k] = v;
    try {
      const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await bodyOf(req);
      const r = await fetch(target, {
        method: req.method,
        headers,
        body: body ? new Uint8Array(body) : undefined,
        redirect: 'manual',
      });
      const out: Record<string, string> = {};
      r.headers.forEach((v, k) => {
        if (!HOP.has(k) && k !== 'content-encoding') out[k] = v;
      });
      res.writeHead(r.status, out).end(Buffer.from(await r.arrayBuffer()));
    } catch (e) {
      res.writeHead(502, { 'content-type': 'text/plain' }).end(`upstream ${prefix} unreachable: ${String(e)}`);
    }
    return;
  }
  const pathname = decodeURIComponent(url.pathname);
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
}).listen(port, '0.0.0.0', () =>
  console.log(`owner-site-server: ${root} on :${port}; proxies ${PROXIES.map((p) => p[0]).join(' ')}`),
);
