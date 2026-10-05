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

import { expect, test } from '@playwright/test';

import { TOKEN_2022_PROGRAM_ID } from '../../packages/core/src/solana/tx.js';
import { transferView } from '../mocks/bridge-api.js';
import {
  DEFAULT_PROFILE,
  X,
  bridgeSite,
  lockc,
  mintData,
  openPortfolio,
  review,
  txRequests,
} from './bridge-fixtures.js';
import { connectPhantom } from './mock-phantom.js';
import { ACCOUNT } from './mock-relay.js';

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
  await expect(page.getByTestId('bridge-in-fact-balances')).toHaveText(
    'Your wallet holds 600 X and 1 SOL (the fee is paid in SOL)',
  );
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
  const features = { ...DEFAULT_PROFILE.features };
  delete features['solana:signAndSendTransaction'];
  const s = await bridgeSite(page, {
    profile: {
      ...DEFAULT_PROFILE,
      features,
      accountFeatures: DEFAULT_PROFILE.accountFeatures.filter((f) => f !== 'solana:signAndSendTransaction'),
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
  const features = { ...DEFAULT_PROFILE.features };
  delete features['solana:signAndSendTransaction'];
  delete features['solana:signTransaction'];
  const s = await bridgeSite(page, {
    profile: { ...DEFAULT_PROFILE, features, accountFeatures: ['solana:signMessage'] },
  });
  await openPortfolio(page);
  await expect(page.getByTestId('bridge-in-no-transactions')).toBeVisible();
  await expect(page.getByTestId('bridge-in-check')).toBeDisabled();
  expect(txRequests(s.wallet)).toHaveLength(0);
});

// AA 00060 P10.3 C3 (F-A4, F-B3): the wallet SENDS the lock but answers after the page's timeout. The page
// must not say "Nothing was sent / Nothing was locked"; it keeps the lock's record from before it asked,
// finds the lock on Solana, and refuses a second Bridge in of the token until it has.
test('C3: a sign-and-send that answers after the timeout: status unknown, the lock found and tracked, no second lock meanwhile', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const s = await bridgeSite(page, { walletTimeoutSeconds: 5 });
  s.rpc.logsFor = () => ['Program x invoke [1]', lockc(s, 4), 'Program x success'];
  s.wallet.lateAnswerMs = 8_000;
  await openPortfolio(page);
  await review(page, '500');
  await page.getByTestId('bridge-in-send').click();
  const error = page.getByTestId('bridge-in-error');
  await expect(error).toBeVisible({ timeout: 15_000 });
  await expect(error).not.toContainText('Nothing was');
  await expect(error).toContainText('checking');
  expect(s.rpc.sent).toHaveLength(1);
  // A second Bridge in of X is refused before the wallet is asked, while the first is unknown.
  const record = page.getByTestId('bridge-in-record');
  await expect(record).toHaveCount(1);
  await review(page, '500');
  await expect(page.getByTestId('bridge-in-error')).toContainText('wait until this page has checked');
  expect(txRequests(s.wallet)).toHaveLength(1);
  // The page finds the lock on Solana (or the wallet's late answer): the first transfer is tracked.
  await expect(record).toHaveAttribute('data-state', 'locked', { timeout: 30_000 });
  expect(s.rpc.sent).toHaveLength(1);
});
