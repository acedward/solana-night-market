// Shared helpers for the AA 00060 mocks: each mock is a fetch-style handler `(Request) => Response`,
// usable as a `fetch` in unit tests (`asFetch`), behind Playwright's `page.route`, or served over HTTP on
// 127.0.0.1 (`serveHandler`, a random port >= 10000 unless one is given).

import { createServer, type Server } from 'node:http';

export type Handler = (req: Request) => Promise<Response> | Response;

export const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type' };

export const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...CORS } });

/** A `fetch` that answers every request with `handler` (any host). */
export const asFetch =
  (handler: Handler): typeof fetch =>
  async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(input instanceof Request ? input : new Request(String(input), init));

/** Serve `handler` on 127.0.0.1; resolves with the base URL and a close function. */
export async function serveHandler(handler: Handler, port = 0): Promise<{ url: string; close(): Promise<void> }> {
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
    const request = new Request(`http://127.0.0.1${req.url ?? '/'}`, {
      method: req.method,
      headers: req.headers as Record<string, string>,
      ...(body && req.method !== 'GET' && req.method !== 'HEAD' ? { body } : {}),
    });
    const response =
      req.method === 'OPTIONS' ? new Response(null, { status: 204, headers: CORS }) : await handler(request);
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => (headers[key] = value));
    res.writeHead(response.status, headers);
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  const pick = port || 10_000 + Math.floor(Math.random() * 50_000);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(pick, '127.0.0.1', () => resolve());
  });
  return {
    url: `http://127.0.0.1:${pick}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
