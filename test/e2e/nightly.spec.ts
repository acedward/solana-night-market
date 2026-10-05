// AA 00060 P5 (T5.1, T5.4; G-NIGHTLY part A's findings): Night Market with Nightly, through the Wallet
// Standard, as the owner's run recorded it (evidence/00060-night-market-bridge-wallet/p2/
// report-2-pass-20261005T003042Z.md): Nightly's own profile (`solana:signMessage` 1.1.0, both transaction
// features, `solana:signIn` listed, no `solana:localnet` in its chains) plus its Sui, Aptos, IOTA and
// Cedra wallets, all named "Nightly".
//
//   - one "Nightly" in the Connect menu; an account opens with one approval; the copy names Nightly;
//   - requests are paced: a wallet that drops a request asked within 500 ms of its previous answer
//     (G-NIGHTLY run 1) still gets every request of a withdrawal with change;
//   - a request the wallet drops (no window): the panel says so, then the request ends with a clear
//     message and nothing is sent;
//   - Bridge in: the chain `solana:localnet` is asked (Nightly accepts it), and the signing panel shows the
//     transaction's decoded facts while the wallet is open.
// Every other spec also runs against Nightly's profile with `E2E_WALLET=nightly` (./mock-phantom.ts).

import { expect, test, type Page } from '@playwright/test';

import { bytesToHex } from '../../packages/core/src/hex.js';
import { formatShieldedAddress } from '../../packages/core/src/shielded-address.js';
import { COLOUR } from '../../packages/core/test/fixtures/kernel/book.js';
import { X, bridgeSite, connectWallet, lockc, openPortfolio, review } from './bridge-fixtures.js';
import { INDEXER, INDEXER_OVERRIDE, INDEXER_WS, MockIndexer } from './mock-indexer.js';
import { type MockPhantom } from './mock-phantom.js';
import { MockRelay, RELAY } from './mock-relay.js';
import { NIGHTLY_OTHER_WALLETS, NIGHTLY_PROFILE, installMockWallet } from './mock-wallet.js';
import { serveExchange } from './visual-fixtures.js';
import { seedAccount } from './wallet-fixtures.js';

const text = (b: Uint8Array) => String.fromCharCode(...b);

async function nightlySite(page: Page, opts: { seeded?: boolean; walletTimeoutSeconds?: number } = {}) {
  await serveExchange(page);
  const wallet = await installMockWallet(page, { profile: NIGHTLY_PROFILE, extraWallets: NIGHTLY_OTHER_WALLETS });
  const relay = new MockRelay();
  const indexer = new MockIndexer(relay);
  await page.route(`${RELAY}/**`, (r) => relay.handle(r));
  await page.route(INDEXER, (r) => indexer.handle(r));
  await page.routeWebSocket(INDEXER_WS, (ws) => indexer.handleWs(ws));
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
  if (opts.seeded) await seedAccount(page, { deviceKey: bytesToHex(wallet.publicKey) } as MockPhantom, relay);
  return { wallet, relay };
}

test('one Nightly in the menu (its other-chain wallets skipped); an account opens with one approval; the copy names Nightly', async ({
  page,
}) => {
  const { wallet, relay } = await nightlySite(page);
  await page.goto('/#account');
  await page.getByTestId('connect').click();
  await expect(page.getByTestId('wallet-option')).toHaveCount(1);
  await expect(page.getByTestId('wallet-option')).toContainText('Nightly');
  await page.getByTestId('wallet-option').click();
  await expect(page.getByTestId('no-account')).toContainText('One approval in Nightly');
  const release = wallet.holdNext();
  await page.getByTestId('open-account').click();
  await expect(page.getByTestId('sign-prompt')).toBeVisible();
  await expect(page.getByTestId('sign-prompt-kind')).toHaveAttribute('data-kind', 'relay-envelope');
  await expect(page.getByTestId('sign-prompt-kind')).toContainText('Nightly asks you to prove you own this wallet');
  await expect.poll(() => wallet.requests.length).toBe(1);
  // The page shows exactly the bytes Nightly is asked to sign.
  expect(await page.getByTestId('sign-prompt-text').textContent()).toBe(text(wallet.requests[0]!.bytes));
  expect(text(wallet.requests[0]!.bytes).split('\n')[2]).toBe(`Key ${wallet.address}`);
  release();
  await expect(page.getByTestId('accounts-message')).toContainText('is open');
  expect(relay.submitted.map((s) => [s.action, s.verified])).toEqual([['register', 'ok']]);
  expect(wallet.requests).toHaveLength(1);
  await expect(page.getByText('Phantom', { exact: false })).toHaveCount(0);
});

test('requests are paced: a wallet that drops one asked within 500 ms of its last answer still gets all of a withdrawal', async ({
  page,
}) => {
  const { wallet, relay } = await nightlySite(page, { seeded: true });
  wallet.dropWithinMs = 500;
  await page.goto('/#account');
  await connectWallet(page, 'Nightly');
  await expect(page.locator('[data-testid=passport-row][data-symbol="twUSDC"]')).toContainText('1,000.00');
  await page.getByTestId('send-token').selectOption(COLOUR.twUSDC);
  await page.getByTestId('send-amount').fill('100');
  await page
    .getByTestId('send-recipient')
    .fill(formatShieldedAddress({ coinPublicKey: '44'.repeat(32), encryptionPublicKey: '55'.repeat(32) }, 'stagenet'));
  await page.getByTestId('send-submit').click();
  await expect(page.getByTestId('accounts-message')).toContainText('the change is recorded in your inbox');
  expect(wallet.requests.map((r) => text(r.bytes).split('\n')[1])).toEqual(['Withdraw shielded', 'File inbox note']);
  expect(wallet.timings.map((t) => t.dropped)).toEqual([false, false]);
  expect(wallet.timings[1]!.at - wallet.timings[0]!.answeredAt!).toBeGreaterThanOrEqual(700);
  expect(relay.submitted.map((s) => [s.action, s.verified])).toEqual([
    ['withdraw', 'ok'],
    ['append-inbox', 'ok'],
  ]);
});

test('a request the wallet drops: the panel says no window appeared, then it ends clearly and nothing is sent', async ({
  page,
}) => {
  const { wallet, relay } = await nightlySite(page, { walletTimeoutSeconds: 5 });
  wallet.mode = 'drop';
  await page.goto('/#account');
  await connectWallet(page, 'Nightly');
  await page.getByTestId('open-account').click();
  await expect(page.getByTestId('sign-prompt')).toBeVisible();
  await expect(page.getByTestId('sign-prompt-no-window')).toHaveCount(0);
  await expect(page.getByTestId('sign-prompt-no-window')).toContainText('No window from Nightly?', { timeout: 4_000 });
  await expect(page.getByTestId('accounts-message')).toContainText('did not answer within 5 seconds', {
    timeout: 8_000,
  });
  await expect(page.getByTestId('accounts-message')).toContainText('Nothing was sent');
  await expect(page.getByTestId('sign-prompt')).toHaveCount(0);
  expect(relay.submitted).toHaveLength(0);
});

test("Bridge in with Nightly: the chain solana:localnet is asked, and the panel shows the transaction's facts", async ({
  page,
}) => {
  const s = await bridgeSite(page, { profile: NIGHTLY_PROFILE });
  s.rpc.logsFor = () => [lockc(s, 6)];
  await openPortfolio(page, 'Nightly');
  await review(page, '500');
  const release = s.wallet.holdNext();
  await page.getByTestId('bridge-in-send').click();
  await expect(page.getByTestId('sign-prompt-kind')).toHaveAttribute('data-kind', 'solana-transaction');
  await expect(page.getByTestId('sign-prompt-kind')).toContainText(
    'Nightly asks you to approve one Solana transaction',
  );
  await expect(page.getByTestId('sign-tx-title')).toHaveText('Lock 500 X on Solana for your Night Market account');
  await expect(page.locator('[data-testid=sign-tx-fact][data-label="Program"] dd')).toHaveText(X.bridgeProgram);
  await expect(page.locator('[data-testid=sign-tx-fact][data-label="Amount"] dd')).toHaveText(
    '500000000 base units (500 X)',
  );
  release();
  await expect(page.getByTestId('bridge-in-ok')).toBeVisible();
  await expect(page.getByTestId('sign-prompt')).toHaveCount(0);
  const tx = s.wallet.requests.filter((r) => r.kind !== 'signMessage');
  expect(tx.map((r) => [r.kind, r.chain])).toEqual([['signAndSendTransaction', 'solana:localnet']]);
  expect(s.rpc.sent).toHaveLength(1);
  await expect(page.getByTestId('bridge-in-record')).toHaveAttribute('data-state', 'locked', { timeout: 15_000 });
});
