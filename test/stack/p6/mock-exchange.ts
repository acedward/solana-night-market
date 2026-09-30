// P6 (AA 00047) local stack: a stand-in for the offer-files kernel AND its batcher, so a take can be
// driven through the relay on a localnet (the staging exchange is the real test, plan P6.3).
//
//   kernel (PORT, default 9999): `POST /v1/offers` stores the offer; `GET /v1/offers` lists live
//     offers; `GET /v1/offers/:id` serves its `swapoffer1…` string; `GET /v1/offers/:id/status`.
//     No validation: the real kernel's is the stagenet run's.
//   batcher (BATCHER_PORT, default 3334): `POST /send-input` with the SPA's body. It deserializes the
//     settlement, adds DUST from its own wallet (MOCK_BATCHER_SEED_FILE, a localnet dev seed; never
//     the relay's sponsor seed: one wallet process per seed) exactly as `midnight-balancer` does,
//     submits it to the node, and marks the settled offers consumed. Without a seed, or when that
//     wallet has no DUST, it answers 503 with the reason and keeps the settlement's size.
//
//   PORT=9999 BATCHER_PORT=3334 MOCK_BATCHER_SEED_FILE=… bun test/stack/p6/mock-exchange.ts

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { decodeOffer } from '@nightmarket/core';

import { openFacadeWallet, type OpenedWallet } from '../../../relay/src/sponsor/facade.js';

const offers = new Map<string, { offer: string; status: string; firstSeenAt: string }>();
const port = Number(process.env.PORT ?? 9999);
const batcherPort = Number(process.env.BATCHER_PORT ?? 3334);
const say = (s: string) => process.stdout.write(`mock-exchange: ${s}\n`);

const body = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
const json = (res: ServerResponse, value: unknown, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
};
const computed = (o: { status: string; firstSeenAt: string }) => ({
  gives: [],
  wants: [],
  expiresAt: null,
  firstSeenAt: o.firstSeenAt,
  status: o.status,
});

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://kernel');
  if (req.method === 'POST' && url.pathname === '/v1/offers') {
    void body(req).then((text) => {
      const { offer } = JSON.parse(text) as { offer: string };
      const offerId = createHash('sha256').update(decodeOffer(offer)).digest('hex');
      if (offers.has(offerId)) return json(res, { error: 'DUPLICATE_OFFER', offerId }, 409);
      offers.set(offerId, { offer, status: 'live', firstSeenAt: new Date().toISOString() });
      say(`accepted offer ${offerId} (${offer.length} chars)`);
      json(res, { offerId }, 201);
    });
    return;
  }
  const status = /^\/v1\/offers\/([0-9a-f]{64})\/status$/.exec(url.pathname);
  if (status) return json(res, { offerId: status[1], status: offers.get(status[1]!)?.status ?? 'not_found' });
  const detail = /^\/v1\/offers\/([0-9a-f]{64})$/.exec(url.pathname);
  if (detail) {
    const o = offers.get(detail[1]!);
    if (!o) return json(res, { error: 'NOT_FOUND' }, 404);
    return json(res, {
      offerId: detail[1],
      offerBech32: o.offer,
      blockHeight: null,
      ttlSeconds: null,
      computed: computed(o),
    });
  }
  if (url.pathname === '/v1/offers') {
    const rows = [...offers.entries()]
      .filter(([, o]) => o.status === 'live')
      .map(([offerId, o]) => ({ offerId, blockHeight: null, blobChars: o.offer.length, computed: computed(o) }));
    return json(res, { offers: rows, nextCursor: null });
  }
  if (['/health', '/v1/health', '/v1/status'].includes(url.pathname)) return json(res, { status: 'ok', synced: true });
  json(res, { error: 'NOT_FOUND' }, 404);
}).listen(port, '0.0.0.0', () => say(`kernel listening on ${port}`));

// ── the batcher ──────────────────────────────────────────────────────────────
let wallet: OpenedWallet | null = null;
let walletError: string | null = null;
let dust: bigint | null = null;
const seedFile = process.env.MOCK_BATCHER_SEED_FILE;
if (seedFile) {
  const seedHex = readFileSync(seedFile, 'utf8').trim();
  openFacadeWallet(
    seedHex,
    {
      networkId: process.env.MIDNIGHT_NETWORK_ID ?? 'undeployed',
      indexerUrl: process.env.MIDNIGHT_INDEXER_URL ?? 'http://indexer:8088/api/v4/graphql',
      indexerWsUrl: process.env.MIDNIGHT_INDEXER_WS_URL ?? 'ws://indexer:8088/api/v4/graphql/ws',
      nodeWsUrl: process.env.MIDNIGHT_NODE_WS_URL ?? 'ws://node:9944',
      dustProofServerUrl: process.env.MIDNIGHT_DUST_PROOF_SERVER_URL ?? 'http://proof-server:6300',
    },
    { feeBlocksMargin: 5 },
  ).then(
    (w) => {
      wallet = w;
      w.subscribe(
        (s) => {
          if (s.synced && dust !== s.dustSpecks) {
            dust = s.dustSpecks;
            say(`batcher wallet synced, DUST ${String(dust)} specks`);
          }
        },
        (e) => {
          walletError = String(e);
        },
      );
    },
    (e: unknown) => {
      walletError = String(e);
      say(`batcher wallet failed to open: ${walletError}`);
    },
  );
}

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://batcher');
  if (req.method === 'POST' && url.pathname === '/send-input') {
    void body(req).then(async (text) => {
      try {
        const b = JSON.parse(text) as { data: { input: string; target: string; address: string } };
        const input = JSON.parse(b.data.input) as { tx: string; txStage: string };
        const bytes = Uint8Array.from(Buffer.from(input.tx, 'hex'));
        const ledger = (await import('@midnightntwrk/ledger-v9')) as unknown as {
          Transaction: { deserialize(s: string, p: string, bd: string, raw: Uint8Array): unknown };
        };
        const tx = ledger.Transaction.deserialize('signature', 'proof', 'binding', bytes);
        say(`settlement received: ${bytes.length} B, target ${b.data.target}, stage ${input.txStage}`);
        if (!wallet || dust === null || dust === 0n) {
          return json(
            res,
            {
              success: false,
              error: `mock batcher: no funded wallet (${walletError ?? (wallet ? 'no DUST' : 'no seed')}); the settlement deserialized (${bytes.length} B) but was not submitted`,
            },
            503,
          );
        }
        const h = wallet.handle as unknown as {
          wallet: {
            balanceFinalizedTransaction(t: unknown, k: unknown, o: unknown): Promise<unknown>;
            signRecipe(r: unknown, s: (p: Uint8Array) => Promise<unknown>): Promise<unknown>;
            finalizeRecipe(r: unknown): Promise<unknown>;
            submitTransaction(t: unknown): Promise<unknown>;
          };
          shieldedSecretKeys: unknown;
          dustSecretKey: unknown;
          unshieldedKeystore: { signDataAsync(p: Uint8Array): Promise<unknown> };
        };
        const recipe = await h.wallet.balanceFinalizedTransaction(
          tx,
          { shieldedSecretKeys: h.shieldedSecretKeys, dustSecretKey: h.dustSecretKey },
          { ttl: new Date(Date.now() + 60_000), tokenKindsToBalance: ['dust'] },
        );
        const signed = await h.wallet.signRecipe(recipe, (p) => h.unshieldedKeystore.signDataAsync(p));
        const finalized = await h.wallet.finalizeRecipe(signed);
        const id = String(await h.wallet.submitTransaction(finalized));
        for (const o of offers.values()) if (o.status === 'live') o.status = 'consumed';
        say(`settlement submitted: ${id}`);
        json(res, { success: true, transactionHash: id });
      } catch (e) {
        say(`settlement failed: ${String((e as Error)?.message ?? e)}`);
        json(res, { success: false, error: String((e as Error)?.message ?? e).slice(0, 2000) }, 500);
      }
    });
    return;
  }
  if (url.pathname === '/health') return json(res, { status: 'ok', dust: dust === null ? null : String(dust) });
  json(res, { error: 'NOT_FOUND' }, 404);
}).listen(batcherPort, '0.0.0.0', () => say(`batcher listening on ${batcherPort}`));
