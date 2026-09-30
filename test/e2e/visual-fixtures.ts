// The browser tests' fixtures (plan P1.5, carried over): the markets book of the L-MKT fixture,
// served through page.route, and records seeded into this browser's local data as another tab
// would write them. No relay, kernel or chain is used, and nothing leaves the page's origin.
//
// No wallet is injected here: the connected-wallet walkthroughs (AA 00047 lane B2) use the mock
// Phantom of ./mock-phantom.ts and the mock relay of ./mock-relay.ts (./wallet.spec.ts).

import type { Page } from '@playwright/test';
import { x25519 } from '@noble/curves/ed25519.js';

import { BOOK, COLOUR, type WireOffer } from '../../packages/core/test/fixtures/kernel/book.js';
import { KernelFixture, STREAM_HEADERS, connectedEvent } from '../../packages/core/test/fixtures/kernel/mock-kernel.js';
import { encodeRecord, recordKey } from '../../web/src/store/schema.js';

export const KERNEL = 'https://stagenet.api-zswap.zkdojo.com';
export const ACCOUNT = 'e8d3a41c7b5f09e2d6c3b8a1f0e4d7c2b9a6f3e0d1c8b5a2f9e6d3c0b7a42d09';
/** A Solana wallet's public key (32 bytes, hex): the owner of the seeded records. */
export const OWNER = '3b6a27bcceb6a42d62a3a8d02a6f0d73653215771de243a63ac048a18b59da29';

/** Refuse (and record) anything that would leave the page's origin, and serve the mock kernel. */
export async function serveExchange(
  page: Page,
  opts: { kernelDown?: boolean; book?: WireOffer[]; fixture?: KernelFixture } = {},
) {
  const external: string[] = [];
  /** Every request to the kernel, as `METHOD /path` (the stream included). */
  const kernel: string[] = [];
  const fixture = opts.fixture ?? new KernelFixture({ book: opts.book ?? BOOK });
  await page.route(
    (url) => url.hostname !== '127.0.0.1',
    (route) => {
      external.push(route.request().url());
      return route.abort('blockedbyclient');
    },
  );
  await page.route(`${KERNEL}/**`, (route) => {
    const url = new URL(route.request().url());
    kernel.push(`${route.request().method()} ${url.pathname}`);
    if (opts.kernelDown) return route.abort('connectionrefused');
    if (url.pathname === '/v1/offers/stream') {
      return route.fulfill({ status: 200, headers: STREAM_HEADERS, body: connectedEvent() });
    }
    const r = fixture.respond(url.pathname + url.search);
    return route.fulfill({ status: r.status, headers: r.headers, body: r.body });
  });
  return { external, kernel, fixture };
}

/** One wallet's records as the page writes them (Import accepts nothing else): its profile, its
 *  account, the account's encryption secret, and its coins. */
export function customerRecords(owner = OWNER, now = Date.now()): { entries: Array<[string, string]>; secret: string } {
  const scope = { network: 'stagenet', owner };
  const sk = x25519.utils.randomSecretKey();
  const encSecretKey = Buffer.from(sk).toString('hex');
  const encPublicKey = Buffer.from(x25519.getPublicKey(sk)).toString('hex');
  const entries: Array<[string, string]> = [
    [recordKey(scope, 'profile'), encodeRecord('profile', { firstSeen: now - 86_400_000 }, now - 86_400_000)],
    [
      recordKey(scope, 'account', { account: ACCOUNT }),
      encodeRecord(
        'account',
        { address: ACCOUNT, device: owner, network: 'stagenet', createdAt: now - 3 * 86_400_000 },
        now - 3 * 86_400_000,
      ),
    ],
    [recordKey(scope, 'secret', { account: ACCOUNT }), encodeRecord('secret', { encSecretKey, encPublicKey }, now)],
    [
      recordKey(scope, 'coins', { account: ACCOUNT }),
      encodeRecord(
        'coins',
        [
          {
            nonce: '01'.repeat(32),
            color: COLOUR.twUSDC,
            value: '60000000',
            mtIndex: '7',
            commitment: 'c0'.repeat(32),
            origin: 'inbox',
            inInbox: true,
            inboxIndex: '0',
            spent: false,
          },
        ],
        now,
      ),
    ],
  ];
  return { entries, secret: encSecretKey };
}

/** Seed records into this origin's local data once per tab (not on reloads). */
export async function seedRecords(page: Page, entries: Array<[string, string]>): Promise<void> {
  await page.addInitScript((pairs) => {
    if (sessionStorage.getItem('nm-e2e-seeded')) return;
    for (const [k, v] of pairs) localStorage.setItem(k, v);
    sessionStorage.setItem('nm-e2e-seeded', '1');
  }, entries);
}
