// AA 00060 P7 (T7.2-T7.8): Bridge in from Solana on the Portfolio page, end to end in the browser, with a
// mock Wallet Standard wallet that has the transaction features (./mock-wallet.ts), the mock Solana RPC
// and the mock bridge API (test/mocks), and the mock relay and public indexer (a seeded account). The
// bridge's delivery is played by the mock relay's `deposit` (a `deposit_shielded` into the account, as
// 00058's passport adapter does), so completion is the page's OWN decode of its account.
//
//   T7.2 Token-2022 refused · T7.3 a recipient that fails the page's check refused · T7.4 too little SPL /
//   SOL refused (each with no wallet request) · T7.5 404 → observed → submitted → completed, and
//   undeliverable with its plain reason · T7.6 a reload resumes · T7.7 another genesis hash: no Bridge in
//   · T7.8 the wallet refuses: nothing recorded · a wallet with only signTransaction: the page sends ·
//   a wallet without transaction features: Bridge in off, with the reason.

import { readFileSync } from 'node:fs';

import { expect, test, type Page } from '@playwright/test';

import { bytesToHex } from '../../packages/core/src/hex.js';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '../../packages/core/src/solana/tx.js';
import { associatedTokenAddress } from '../../packages/core/src/solana/pda.js';
import { mockBridgeApi, transferView, type MockBridgeApi } from '../mocks/bridge-api.js';
import { asFetch } from '../mocks/http.js';
import { mockSolanaRpc, type MockSolanaRpc } from '../mocks/solana-rpc.js';
import { MockIndexer, INDEXER, INDEXER_OVERRIDE, INDEXER_WS } from './mock-indexer.js';
import { connectPhantom, type MockPhantom } from './mock-phantom.js';
import { ACCOUNT, MockRelay, RELAY } from './mock-relay.js';
import { PHANTOM_PROFILE, installMockWallet, type MockWallet, type WalletProfile } from './mock-wallet.js';
import { serveExchange } from './visual-fixtures.js';
import { seedAccount } from './wallet-fixtures.js';

const RPC = 'http://solana-rpc.test/';
const BRIDGE = 'http://bridge-x.test';
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type' };

const fixture = JSON.parse(
  readFileSync(new URL('../fixtures/journey-registry.undeployed.json', import.meta.url), 'utf8'),
) as { tokens: Array<Record<string, unknown> & { colour: string; splMint: string; bridgeProgram: string }> };
const X = fixture.tokens[0]!;

const mintData = (decimals: number) => {
  const d = new Uint8Array(82);
  d[44] = decimals;
  d[45] = 1;
  return d;
};

interface Site {
  wallet: MockWallet;
  rpc: MockSolanaRpc;
  bridge: MockBridgeApi;
  relay: MockRelay;
  indexer: MockIndexer;
  ata: string;
}

/** A seeded stagenet account, a site that bridges X, and a wallet holding 600 X and 1 SOL. */
async function bridgeSite(
  page: Page,
  opts: { profile?: WalletProfile; genesis?: string; noTxFeatures?: boolean } = {},
): Promise<Site> {
  await serveExchange(page);
  const rpc = mockSolanaRpc();
  const bridge = mockBridgeApi();
  const rpcFetch = asFetch(rpc.handler);
  const wallet = await installMockWallet(page, {
    profile: opts.profile ?? PHANTOM_PROFILE,
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
        walletTimeoutSeconds: 20,
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

const txRequests = (w: MockWallet) => w.requests.filter((r) => r.kind !== 'signMessage');

async function openPortfolio(page: Page) {
  await page.goto('/#account');
  await connectPhantom(page);
  await expect(page.getByTestId('account-check')).toHaveAttribute('data-state', 'ok');
  await expect(page.getByTestId('bridge-in-section')).toBeVisible();
}

async function review(page: Page, amount: string) {
  await page.getByTestId('bridge-in-amount').fill(amount);
  await page.getByTestId('bridge-in-check').click();
}

const lockc = (s: Site, nonce: number, amount = '500000000') =>
  `Program log: EFFECTSTREAM_BRIDGE|LOCKC|${nonce}|${s.wallet.address}|${X.splMint}|${amount}|${ACCOUNT}`;

test('T7.5: the facts before the prompt, one transaction, then 404 → observed → submitted → in the account by the page', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const s = await bridgeSite(page);
  s.rpc.logsFor = () => ['Program x invoke [1]', lockc(s, 4), 'Program x success'];
  await openPortfolio(page);
  await review(page, '500');
  const facts = page.getByTestId('bridge-in-facts');
  await expect(facts).toBeVisible();
  await expect(page.getByTestId('bridge-in-fact-program')).toHaveText(`Program ${X.bridgeProgram}`);
  await expect(page.getByTestId('bridge-in-fact-mint')).toHaveText(`Mint ${X.splMint}`);
  await expect(page.getByTestId('bridge-in-fact-amount')).toHaveText('Amount 500000000 base units (500 X)');
  await expect(page.getByTestId('bridge-in-fact-source')).toHaveText(`From your token account ${s.ata}`);
  await expect(page.getByTestId('bridge-in-fact-account')).toHaveText(`To your Night Market account ${ACCOUNT}`);
  // Nothing was asked of the wallet yet; the footer no longer says the site never sends a transaction.
  expect(txRequests(s.wallet)).toHaveLength(0);
  await expect(page.getByTestId('footer-wallet-bridging')).toContainText('only when you bridge tokens in');
  await page.getByTestId('bridge-in-send').click();
  await expect(page.getByTestId('bridge-in-ok')).toContainText('500 X are on their way');
  expect(txRequests(s.wallet).map((r) => [r.kind, r.chain])).toEqual([['signAndSendTransaction', 'solana:localnet']]);
  expect(s.rpc.sent).toHaveLength(1);
  const record = page.getByTestId('bridge-in-record');
  await expect(record).toHaveAttribute('data-state', 'locked', { timeout: 15_000 });
  await expect(record).toContainText('Waiting for the bridge to see the lock');
  s.bridge.setTransfer(transferView({ id: 's2m:4', status: 'observed', recipient: ACCOUNT }));
  await expect(record).toContainText('The bridge has seen the lock', { timeout: 15_000 });
  await expect(record).toHaveAttribute('data-state', 'bridging');
  s.bridge.setTransfer(transferView({ id: 's2m:4', status: 'submitted', recipient: ACCOUNT }));
  await expect(record).toContainText('The bridge is delivering', { timeout: 15_000 });
  // The bridge says it delivered: not completion until the page's own decode shows the coin.
  const coin = { nonce: '5e'.repeat(32), colour: X.colour, value: '500000000' };
  s.bridge.setTransfer(
    transferView({
      id: 's2m:4',
      status: 'completed',
      recipient: ACCOUNT,
      delivery: { adapter: 'passport-ed25519@21493588', account: ACCOUNT, coin, tx: null },
    }),
  );
  await expect(record).toContainText('The bridge reports it delivered', { timeout: 15_000 });
  await expect(record).toHaveAttribute('data-state', 'bridging');
  await s.relay.deposit([{ nonce: coin.nonce, color: coin.colour, value: 500_000_000n }]);
  await expect(record).toHaveAttribute('data-state', 'completed', { timeout: 20_000 });
  await expect(record).toContainText('In your account');
  // Exactly one Solana transaction in all.
  expect(txRequests(s.wallet)).toHaveLength(1);
  expect(s.rpc.sent).toHaveLength(1);
});

test('T7.6: a reload after sending shows the record and resumes following it', async ({ page }) => {
  test.setTimeout(60_000);
  const s = await bridgeSite(page);
  s.rpc.logsFor = () => [lockc(s, 9, '1500000')];
  await openPortfolio(page);
  await review(page, '1.5');
  await page.getByTestId('bridge-in-send').click();
  await expect(page.getByTestId('bridge-in-record')).toHaveAttribute('data-state', 'locked', { timeout: 15_000 });
  await page.reload();
  await connectPhantom(page);
  const record = page.getByTestId('bridge-in-record');
  await expect(record).toBeVisible();
  await expect(record).toContainText('1.5 X');
  s.bridge.setTransfer(transferView({ id: 's2m:9', status: 'submitted', amount: '1500000', recipient: ACCOUNT }));
  await expect(record).toContainText('The bridge is delivering', { timeout: 15_000 });
  await s.relay.deposit([{ nonce: '61'.repeat(32), color: X.colour, value: 1_500_000n }]);
  await expect(record).toHaveAttribute('data-state', 'completed', { timeout: 20_000 });
  expect(txRequests(s.wallet)).toHaveLength(1);
});

test('T7.5: undeliverable shows the plain reason and that the SPL stays locked', async ({ page }) => {
  test.setTimeout(60_000);
  const s = await bridgeSite(page);
  s.rpc.logsFor = () => [lockc(s, 2)];
  await openPortfolio(page);
  await review(page, '500');
  await page.getByTestId('bridge-in-send').click();
  const record = page.getByTestId('bridge-in-record');
  await expect(record).toHaveAttribute('data-state', 'locked', { timeout: 15_000 });
  s.bridge.setTransfer(
    transferView({
      id: 's2m:2',
      status: 'undeliverable',
      recipient: ACCOUNT,
      reason: { code: 'not-a-passport-account', message: 'raw text from the bridge', at: '2026-10-04T00:00:00Z' },
    }),
  );
  await expect(record).toHaveAttribute('data-state', 'undeliverable', { timeout: 15_000 });
  await expect(record).toContainText('The bridge does not recognise the account as a Night Market account.');
  await expect(record).toContainText('The tokens stay locked on Solana.');
  await expect(record).not.toContainText('raw text from the bridge');
});

test('T7.2 / T7.4: Token-2022, too little SPL, too little SOL: refused before the prompt, naming the token', async ({
  page,
}) => {
  const s = await bridgeSite(page);
  await openPortfolio(page);
  const error = page.getByTestId('bridge-in-error');
  await review(page, '700');
  await expect(error).toHaveText('Your wallet holds only 600 X, less than the 700 X entered.');
  s.rpc.balances.set(s.wallet.address, 5_000);
  await review(page, '1');
  await expect(error).toContainText('needs a little SOL');
  s.rpc.accounts.set(X.splMint, { owner: TOKEN_2022_PROGRAM_ID, data: mintData(6) });
  await review(page, '1');
  await expect(error).toHaveText("Token-2022 tokens can't be bridged.");
  await expect(page.getByTestId('bridge-in-facts')).toHaveCount(0);
  expect(txRequests(s.wallet)).toHaveLength(0);
  expect(s.rpc.sent).toHaveLength(0);
});

test("T7.3: an account that fails the page's check: refused, with no wallet request", async ({ page }) => {
  const s = await bridgeSite(page);
  s.indexer.tamper = { extraDevice: true };
  await page.goto('/#account');
  await connectPhantom(page);
  await expect(page.getByTestId('account-check')).toHaveAttribute('data-state', 'failed');
  await review(page, '1');
  await expect(page.getByTestId('bridge-in-error')).toContainText('check of your account on Midnight failed');
  expect(txRequests(s.wallet)).toHaveLength(0);
});

test("T7.3: the bridge's own verdict says undeliverable: refused, with no wallet request", async ({ page }) => {
  const s = await bridgeSite(page);
  s.bridge.setVerdict(ACCOUNT, 'undeliverable', 'authority-live');
  await openPortfolio(page);
  await review(page, '1');
  await expect(page.getByTestId('bridge-in-error')).toContainText("The account's setup key is still live");
  expect(txRequests(s.wallet)).toHaveLength(0);
});

test('T7.7: a Solana RPC on another genesis hash than the registry: no Bridge in, with the reason', async ({
  page,
}) => {
  const s = await bridgeSite(page, { genesis: '11111111111111111111111111111111' });
  await page.goto('/#account');
  await connectPhantom(page);
  await expect(page.getByTestId('bridge-unavailable')).toContainText('another Solana network');
  await expect(page.getByTestId('bridge-in-section')).toHaveCount(0);
  expect(txRequests(s.wallet)).toHaveLength(0);
});

test('T7.8: the wallet refuses: the page says so and nothing is recorded or sent', async ({ page }) => {
  const s = await bridgeSite(page);
  await openPortfolio(page);
  await review(page, '500');
  s.wallet.mode = 'reject';
  await page.getByTestId('bridge-in-send').click();
  await expect(page.getByTestId('bridge-in-error')).toContainText('Nothing was locked.');
  await expect(page.getByTestId('bridge-in-record')).toHaveCount(0);
  expect(txRequests(s.wallet)).toHaveLength(1);
  expect(s.rpc.sent).toHaveLength(0);
});

test('a wallet with only solana:signTransaction: the page checks the signed lock and sends it itself', async ({
  page,
}) => {
  const features = { ...PHANTOM_PROFILE.features };
  delete features['solana:signAndSendTransaction'];
  const s = await bridgeSite(page, {
    profile: {
      ...PHANTOM_PROFILE,
      features,
      accountFeatures: PHANTOM_PROFILE.accountFeatures.filter((f) => f !== 'solana:signAndSendTransaction'),
    },
  });
  await openPortfolio(page);
  await review(page, '500');
  await page.getByTestId('bridge-in-send').click();
  await expect(page.getByTestId('bridge-in-ok')).toBeVisible();
  expect(txRequests(s.wallet).map((r) => r.kind)).toEqual(['signTransaction']);
  expect(s.rpc.sent).toHaveLength(1);
  expect(s.rpc.calls).toContain('sendTransaction');
});

test('a wallet without transaction features: Bridge in is off with the reason; nothing is asked', async ({ page }) => {
  const features = { ...PHANTOM_PROFILE.features };
  delete features['solana:signAndSendTransaction'];
  delete features['solana:signTransaction'];
  const s = await bridgeSite(page, {
    profile: { ...PHANTOM_PROFILE, features, accountFeatures: ['solana:signMessage'] },
  });
  await openPortfolio(page);
  await expect(page.getByTestId('bridge-in-no-transactions')).toBeVisible();
  await expect(page.getByTestId('bridge-in-check')).toBeDisabled();
  expect(txRequests(s.wallet)).toHaveLength(0);
});
