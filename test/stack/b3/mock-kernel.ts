// Local-stack harness (AA 00047 B3): a stand-in for the ZSwap offer-files kernel, so the relay's
// `open-swap` can be driven end to end locally (prove, bind, publish, wait until listed). It accepts
// every `POST /v1/offers`, reports each accepted offer as `live` (`GET /v1/offers/:id/status`), and
// lists the accepted ids (`GET /v1/offers`). No validation: the real kernel's acceptance is the
// stagenet run's (plan P6.3).
//
//   PORT=9999 bun test/stack/b3/mock-kernel.ts

import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

import { decodeOffer } from '@nightmarket/core';

const offers = new Map<string, string>();
const port = Number(process.env.PORT ?? 9999);

createServer((req, res) => {
  const json = (body: unknown, status = 200) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const url = new URL(req.url ?? '/', 'http://kernel');
  if (req.method === 'POST' && url.pathname === '/v1/offers') {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const { offer } = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { offer: string };
      const offerId = createHash('sha256').update(decodeOffer(offer)).digest('hex');
      if (offers.has(offerId)) return json({ error: 'DUPLICATE_OFFER', offerId }, 409);
      offers.set(offerId, offer);
      process.stdout.write(`mock-kernel: accepted offer ${offerId} (${offer.length} chars)\n`);
      json({ offerId }, 201);
    });
    return;
  }
  const status = /^\/v1\/offers\/([0-9a-f]{64})\/status$/.exec(url.pathname);
  if (status) return json({ offerId: status[1], status: offers.has(status[1]!) ? 'live' : 'not_found' });
  if (url.pathname === '/v1/offers') return json({ offers: [...offers.keys()] });
  if (['/health', '/v1/health', '/v1/status'].includes(url.pathname)) return json({ status: 'ok', synced: true });
  json({ error: 'NOT_FOUND' }, 404);
}).listen(port, '0.0.0.0', () => process.stdout.write(`mock-kernel: listening on ${port}\n`));
