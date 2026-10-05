// AA 00060 (P7, P5): a site that bridges X (journey registry), a seeded stagenet account, the mock Wallet
// Standard wallet with transaction features (./mock-wallet.ts), the mock Solana RPC and the mock bridge
// API (test/mocks), and the mock relay and public indexer. Shared by ./bridge-in.spec.ts and
// ./nightly.spec.ts.

import { readFileSync } from 'node:fs';

import { expect, type Page } from '@playwright/test';

import { bytesToHex } from '../../packages/core/src/hex.js';
import { TOKEN_PROGRAM_ID } from '../../packages/core/src/solana/tx.js';
import { associatedTokenAddress } from '../../packages/core/src/solana/pda.js';
import { mockBridgeApi, type MockBridgeApi } from '../mocks/bridge-api.js';
import { asFetch } from '../mocks/http.js';
import { mockSolanaRpc, type MockSolanaRpc } from '../mocks/solana-rpc.js';
import { MockIndexer, INDEXER, INDEXER_OVERRIDE, INDEXER_WS } from './mock-indexer.js';
import { E2E_WALLET, type MockPhantom } from './mock-phantom.js';
import { ACCOUNT, MockRelay, RELAY } from './mock-relay.js';
import {
  NIGHTLY_OTHER_WALLETS,
  NIGHTLY_PROFILE,
  PHANTOM_PROFILE,
  installMockWallet,
  type MockWallet,
  type WalletProfile,
} from './mock-wallet.js';
import { serveExchange } from './visual-fixtures.js';
import { seedAccount } from './wallet-fixtures.js';

/** The wallet profile the run plays (E2E_WALLET; ./mock-phantom.ts): Phantom by default, or Nightly. */
export const DEFAULT_PROFILE: WalletProfile = E2E_WALLET === 'nightly' ? NIGHTLY_PROFILE : PHANTOM_PROFILE;

export const RPC = 'http://solana-rpc.test/';
export const BRIDGE = 'http://bridge-x.test';
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type' };

const fixture = JSON.parse(
  readFileSync(new URL('../fixtures/journey-registry.undeployed.json', import.meta.url), 'utf8'),
) as { tokens: Array<Record<string, unknown> & { colour: string; splMint: string; bridgeProgram: string }> };
export const X = fixture.tokens[0]!;

export const mintData = (decimals: number) => {
  const d = new Uint8Array(82);
  d[44] = decimals;
  d[45] = 1;
  return d;
};

export interface Site {
  wallet: MockWallet;
  rpc: MockSolanaRpc;
  bridge: MockBridgeApi;
  relay: MockRelay;
  indexer: MockIndexer;
  ata: string;
}

/** A seeded stagenet account, a site that bridges X, and a wallet holding 600 X and 1 SOL. */
export async function bridgeSite(
  page: Page,
  opts: { profile?: WalletProfile; genesis?: string; walletTimeoutSeconds?: number } = {},
): Promise<Site> {
  await serveExchange(page);
  const rpc = mockSolanaRpc();
  const bridge = mockBridgeApi();
  const rpcFetch = asFetch(rpc.handler);
  const wallet = await installMockWallet(page, {
    profile: opts.profile ?? DEFAULT_PROFILE,
    ...((opts.profile ?? DEFAULT_PROFILE).name === 'Nightly' ? { extraWallets: NIGHTLY_OTHER_WALLETS } : {}),
    send: async (b64) => {
      const res = await rpcFetch(RPC, {
        method: 'POST',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'sendTransaction',
          params: [b64, { encoding: 'base64' }],
        }),
      });
      const body = (await res.json()) as { result?: string; error?: { message: string } };
      if (!body.result) throw new Error(body.error?.message ?? 'send failed');
      return body.result;
    },
  });
  await page.route(`${RPC}**`, async (route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const res = await rpcFetch(RPC, { method: 'POST', body: route.request().postData() ?? '' });
    return route.fulfill({
      status: 200,
      headers: { ...CORS, 'content-type': 'application/json' },
      body: await res.text(),
    });
  });
  await page.route(`${BRIDGE}/**`, async (route) => {
    const res = await bridge.handler(new Request(route.request().url(), { method: route.request().method() }));
    return route.fulfill({
      status: res.status,
      headers: { ...CORS, 'content-type': 'application/json' },
      body: await res.text(),
    });
  });
  const relay = new MockRelay();
  const indexer = new MockIndexer(relay);
  await page.route(`${RELAY}/**`, (r) => relay.handle(r));
  await page.route(INDEXER, (r) => indexer.handle(r));
  await page.routeWebSocket(INDEXER_WS, (ws) => indexer.handleWs(ws));
  const journey = {
    midnightNetwork: 'stagenet',
    solanaGenesisHash: opts.genesis ?? rpc.genesisHash,
    tokens: [{ ...X, bridgeApi: BRIDGE }],
  };
  await page.route('**/config.json', (r) =>
    r.fulfill({
      json: {
        network: 'stagenet',
        relayUrl: RELAY,
        overrides: INDEXER_OVERRIDE,
        walletTimeoutSeconds: opts.walletTimeoutSeconds ?? 20,
        solana: { rpcUrl: RPC, cluster: 'solana:localnet' },
        bridges: journey,
      },
    }),
  );
  // The mock wallet's key is the account's device.
  await seedAccount(page, { deviceKey: bytesToHex(wallet.publicKey) } as MockPhantom, relay);
  rpc.accounts.set(X.splMint, { owner: TOKEN_PROGRAM_ID, data: mintData(6) });
  const ata = associatedTokenAddress(wallet.address, X.splMint);
  rpc.tokenBalances.set(ata, { amount: 600_000_000n, decimals: 6 });
  rpc.balances.set(wallet.address, 1_000_000_000);
  return { wallet, rpc, bridge, relay, indexer, ata };
}

export const txRequests = (w: MockWallet) => w.requests.filter((r) => r.kind !== 'signMessage');

/** Connect the wallet named `name` through the page's own menu. */
export async function connectWallet(page: Page, name: string): Promise<void> {
  await page.getByTestId('connect').click();
  await page.getByTestId('wallet-option').filter({ hasText: name }).click();
}

export async function openPortfolio(page: Page, walletName = DEFAULT_PROFILE.name) {
  await page.goto('/#account');
  await connectWallet(page, walletName);
  await expect(page.getByTestId('account-check')).toHaveAttribute('data-state', 'ok');
  await expect(page.getByTestId('bridge-in-section')).toBeVisible();
}

export async function review(page: Page, amount: string) {
  await page.getByTestId('bridge-in-amount').fill(amount);
  await page.getByTestId('bridge-in-check').click();
}

export const lockc = (s: Site, nonce: number, amount = '500000000') =>
  `Program log: EFFECTSTREAM_BRIDGE|LOCKC|${nonce}|${s.wallet.address}|${X.splMint}|${amount}|${ACCOUNT}`;
