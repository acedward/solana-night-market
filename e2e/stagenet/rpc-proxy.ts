// AA 00057 P5R.1: a Solana JSON-RPC + websocket pass-through for the services that must not hold the private
// devnet RPC URL (it carries an API key). The URL is read in-process from RPC_URL_FILE (a 600 file mounted
// read-only); it never appears in an environment variable, a command line, `docker inspect` or a log line.
// The injector's banner prints its UPSTREAM, and the relay's faucet takes SPL_FAUCET_RPC_URL from its
// environment, so both point here (`http://devnet-rpc:8080`, `ws://devnet-rpc:8080`) instead.
//
//   RPC_URL_FILE=/run/secrets/rpc-url bun rpc-proxy.ts      (oven/bun, on the preview's network, alias devnet-rpc)
//
// HTTP: every POST body is sent to the upstream URL as is (JSON-RPC; the path is ignored); GET answers `ok`
// (a liveness probe). Websockets: one upstream connection per client, messages passed both ways, queued
// until the upstream is open. Errors are reported without their text (it could name the URL).

import { readFileSync } from 'node:fs';

const file = process.env.RPC_URL_FILE ?? '/run/secrets/rpc-url';
const upstream = readFileSync(file, 'utf8').trim();
if (!/^https?:\/\//.test(upstream)) {
  console.error(`rpc-proxy: ${file} does not hold an http(s) URL`);
  process.exit(1);
}
const upstreamWs = upstream.replace(/^http/, 'ws');
const port = Number(process.env.PORT ?? 8080);
let posts = 0;
let failures = 0;
let sockets = 0;

interface Link {
  up: WebSocket | null;
  queue: (string | Uint8Array)[];
}
// The few Bun server types used here (the repository's tsconfig has no Bun types; this runs under `bun`).
interface BunServer {
  upgrade(req: Request, o: { data: Link }): boolean;
}
interface BunSocket {
  data: Link;
  send(m: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
}
declare const Bun: {
  serve(o: {
    port: number;
    hostname: string;
    fetch(req: Request, server: BunServer): Promise<Response | undefined>;
    websocket: {
      open(ws: BunSocket): void;
      message(ws: BunSocket, m: string | Uint8Array): void;
      close(ws: BunSocket): void;
    };
  }): unknown;
};

Bun.serve({
  port,
  hostname: '0.0.0.0',
  async fetch(req, server) {
    if (req.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      if (server.upgrade(req, { data: { up: null, queue: [] } })) return undefined;
      return new Response('websocket upgrade failed', { status: 400 });
    }
    if (req.method !== 'POST') return new Response(`ok posts=${posts} failures=${failures} sockets=${sockets}\n`);
    posts += 1;
    try {
      const r = await fetch(upstream, {
        method: 'POST',
        headers: { 'content-type': req.headers.get('content-type') ?? 'application/json' },
        body: await req.arrayBuffer(),
      });
      return new Response(await r.arrayBuffer(), {
        status: r.status,
        headers: { 'content-type': r.headers.get('content-type') ?? 'application/json' },
      });
    } catch {
      failures += 1;
      return Response.json(
        { jsonrpc: '2.0', id: null, error: { code: -32603, message: 'rpc-proxy: the upstream is unreachable' } },
        { status: 502 },
      );
    }
  },
  websocket: {
    open(ws) {
      sockets += 1;
      const up = new WebSocket(upstreamWs);
      ws.data.up = up;
      up.binaryType = 'arraybuffer';
      up.onopen = () => {
        for (const m of ws.data.queue) up.send(m);
        ws.data.queue = [];
      };
      up.onmessage = (e) => ws.send(typeof e.data === 'string' ? e.data : new Uint8Array(e.data as ArrayBuffer));
      up.onclose = () => ws.close();
      up.onerror = () => ws.close(1011, 'upstream error');
    },
    message(ws, m) {
      const up = ws.data.up;
      if (up && up.readyState === WebSocket.OPEN) up.send(m);
      else ws.data.queue.push(m);
    },
    close(ws) {
      sockets -= 1;
      try {
        ws.data.up?.close();
      } catch {
        /* already closed */
      }
    },
  },
});
console.log(`rpc-proxy: listening on :${port} (the upstream URL is not printed)`);
