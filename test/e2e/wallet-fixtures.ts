// The connected-wallet walkthroughs' setup (AA 00047 lane B2), shared by ./wallet.spec.ts and the
// design review screens (./screens.spec.ts, P8.1): the markets fixture, a mock Phantom, a mock relay
// that checks every signature, the mock public indexer the page reads the account from (P9.S,
// ./mock-indexer.ts), and optionally an account already open and holding the demo pack.

import { x25519 } from '@noble/curves/ed25519.js';
import type { Page } from '@playwright/test';

import { COLOUR } from '../../packages/core/test/fixtures/kernel/book.js';
import { encodeRecord, recordKey } from '../../web/src/store/schema.js';
import { INDEXER, INDEXER_OVERRIDE, INDEXER_WS, MockIndexer } from './mock-indexer.js';
import { installMockPhantom, type MockPhantom } from './mock-phantom.js';
import { ACCOUNT, DEMO_PACK, MockRelay, RELAY } from './mock-relay.js';
import { seedRecords, serveExchange } from './visual-fixtures.js';

export async function setup(
  page: Page,
  opts: {
    walletTimeoutSeconds?: number;
    injected?: boolean;
    standard?: boolean;
    seeded?: boolean;
    /** Leave the indexer's WebSocket unrouted (Playwright's routing bypasses a page's CSP). */
    noWsRoute?: boolean;
  } = {},
) {
  const ex = await serveExchange(page);
  const phantom = await installMockPhantom(page, {
    ...(opts.injected ? { injected: true } : {}),
    ...(opts.standard === false ? { standard: false } : {}),
  });
  const relay = new MockRelay();
  const indexer = new MockIndexer(relay);
  await page.route(`${RELAY}/**`, (r) => relay.handle(r));
  await page.route(INDEXER, (r) => indexer.handle(r));
  // The account's history past the newest page streams over the indexer's WebSocket (AA 00047 P11.B).
  if (!opts.noWsRoute) await page.routeWebSocket(INDEXER_WS, (ws) => indexer.handleWs(ws));
  await page.route('**/config.json', (r) =>
    r.fulfill({
      json: {
        network: 'stagenet',
        relayUrl: RELAY,
        overrides: INDEXER_OVERRIDE,
        walletTimeoutSeconds: opts.walletTimeoutSeconds ?? 20,
      },
    }),
  );
  if (opts.seeded) await seedAccount(page, phantom, relay);
  return { ex, phantom, relay, indexer };
}

/** An account that exists on chain and in this browser (its records as the page writes them),
 *  holding the demo pack, plus 25 utwUSDC unshielded. */
export async function seedAccount(page: Page, phantom: MockPhantom, relay: MockRelay) {
  const sk = x25519.utils.randomSecretKey();
  const pk = Buffer.from(x25519.getPublicKey(sk)).toString('hex');
  relay.existing(phantom.deviceKey, pk);
  await relay.deposit(
    DEMO_PACK.map((t, i) => ({ nonce: (0xa0 + i).toString(16).repeat(32), color: t.colour, value: BigInt(t.amount) })),
  );
  relay.unshielded.set(COLOUR.utwUSDC, 25_000_000n);
  const scope = { network: 'stagenet', owner: phantom.deviceKey };
  const now = Date.now();
  await seedRecords(page, [
    [
      recordKey(scope, 'account', { account: ACCOUNT }),
      encodeRecord(
        'account',
        { address: ACCOUNT, device: phantom.deviceKey, network: 'stagenet', createdAt: now },
        now,
      ),
    ],
    [
      recordKey(scope, 'secret', { account: ACCOUNT }),
      encodeRecord('secret', { encSecretKey: Buffer.from(sk).toString('hex'), encPublicKey: pk }, now),
    ],
    [recordKey(scope, 'roster', { account: ACCOUNT }), encodeRecord('roster', { useCounter: '0' }, now)],
    [recordKey(scope, 'coins', { account: ACCOUNT }), encodeRecord('coins', [], now)],
  ]);
}
