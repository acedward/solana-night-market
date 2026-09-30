// AA 00047 lane B2: the connected-wallet walkthroughs, with a MOCK PHANTOM (./mock-phantom.ts:
// tweetnacl in the test process, Phantom's byte semantics) and a MOCK RELAY that checks every
// signature the way the real relay does (./mock-relay.ts: the Solana envelope scheme, and each
// account call's F3 message rebuilt by Track A's client from the call's own arguments). The
// exchange is the markets fixture; nothing leaves the page's origin.
//
//   - connect Phantom (Wallet Standard), open an account with ONE approval (the page shows the
//     exact text Phantom shows, with its fingerprint), get the demo pack with one more, see it in the
//     holdings side panel and on Account; a second claim is refused;
//   - make an offer and take one, each ONE approval of the readable "Swap offer" text;
//   - withdraw shielded (one approval, then one to record the change) and unshielded (one approval);
//   - export, CLEAR ALL and import the connected wallet's records;
//   - errors: a Ledger account (refused as hardware, nothing sent), a declined request, a declined
//     connection, a locked wallet, a wallet that never answers, a signature by another key;
//   - Phantom's injected provider, asked for `display: 'utf8'`.

import { readFile } from 'node:fs/promises';

import { expect, test, type Page } from '@playwright/test';

import { formatShieldedAddress } from '../../packages/core/src/shielded-address.js';
import { formatUnshieldedAddress } from '../../packages/core/src/unshielded.js';
import { shortSolanaAddress } from '../../packages/core/src/signing.js';
import { COLOUR } from '../../packages/core/test/fixtures/kernel/book.js';
import { connectPhantom, type MockPhantom } from './mock-phantom.js';
import { setup } from './wallet-fixtures.js';

const lines = (text: string) => text.split('\n');

const holding = (page: Page, symbol: string, kind = 'shielded') =>
  page.locator(`[data-testid=holding][data-symbol="${symbol}"][data-kind="${kind}"]`);

test('connect Phantom, open an account with one approval, get the demo pack, see it in the holdings', async ({
  page,
}) => {
  const { ex, phantom, relay } = await setup(page);
  await page.goto('/#account');
  await connectPhantom(page);
  await expect(page.getByTestId('wallet-address')).toHaveText(shortSolanaAddress(phantom.address));
  await expect(page.getByTestId('no-account')).toBeVisible();

  // Opening the account: ONE approval. While Phantom's window is open, the page shows exactly the
  // text Phantom shows, and its fingerprint.
  const release = phantom.holdNext();
  await page.getByTestId('open-account').click();
  await expect(page.getByTestId('sign-prompt')).toBeVisible();
  await expect.poll(() => phantom.requests.length).toBe(1);
  const asked = phantom.requests[0]!;
  expect(asked.via).toBe('wallet-standard');
  expect(lines(asked.text).slice(0, 4)).toEqual([
    'Night Market - stagenet',
    'Prove you hold this key',
    `Key ${phantom.address}`,
    'For Open a Night Market account',
  ]);
  expect(asked.text).toContain('This signature authorises nothing and moves no funds.');
  expect(await page.getByTestId('sign-prompt-text').textContent()).toBe(asked.text);
  const nonce = /^Nonce ([0-9a-f]{64})$/m.exec(asked.text)![1]!;
  await expect(page.getByTestId('sign-prompt-fingerprint')).toHaveText(`${nonce.slice(0, 4)} ${nonce.slice(4, 8)}`);
  await expect(page.getByTestId('sign-prompt-kind')).toHaveAttribute('data-kind', 'relay-envelope');
  release();
  await expect(page.getByTestId('sign-prompt')).toHaveCount(0);
  await expect(page.getByTestId('accounts-message')).toContainText('is open');
  await expect(page.getByTestId('masthead-account')).toBeVisible();
  expect(relay.submitted.map((s) => [s.action, s.verified])).toEqual([['register', 'ok']]);
  expect(phantom.requests).toHaveLength(1);

  // The demo pack: what it is, the limits, then ONE more approval.
  await expect(page.getByTestId('demo-pack')).toHaveText('1,000.00 twUSDC · 0.10 twBTC · 1.00 twETH');
  await expect(page.getByTestId('demo-limits')).toContainText('7 of 25 left today');
  await page.getByTestId('get-demo-tokens').click();
  await expect(page.getByTestId('demo-message')).toContainText('Demo tokens delivered');
  expect(phantom.requests).toHaveLength(2);
  expect(lines(phantom.requests[1]!.text)[3]).toBe('For Claim demo tokens for my Night Market account');
  expect(relay.submitted.map((s) => [s.action, s.verified])).toEqual([
    ['register', 'ok'],
    ['demo-tokens', 'ok'],
  ]);
  for (const [symbol, amount] of [
    ['twUSDC', '1,000.00'],
    ['twBTC', '0.10'],
    ['twETH', '1.00'],
  ])
    await expect(page.locator(`[data-testid=passport-row][data-symbol="${symbol}"]`)).toContainText(amount!);
  await expect(page.getByTestId('demo-unavailable')).toHaveAttribute('data-code', 'claimed');
  await expect(page.getByTestId('get-demo-tokens')).toBeDisabled();

  // The holdings side panel beside the books shows the same pack.
  await page.getByTestId('tab-markets').click();
  await expect(page.getByTestId('holdings-panel')).toHaveAttribute('data-state', 'account');
  await expect(holding(page, 'twBTC')).toContainText('0.10');
  await expect(holding(page, 'twETH')).toContainText('1.00');
  expect(ex.external).toEqual([]);
});

test('make an offer and take one: each ONE approval of the readable swap text the relay rebuilds', async ({ page }) => {
  const { phantom, relay } = await setup(page, { seeded: true });
  await page.goto(`/#trade?pair=${encodeURIComponent('twBTC/twUSDC')}`);
  await connectPhantom(page);
  await expect(holding(page, 'twBTC')).toContainText('0.10');

  // Make: sell 0.05 twBTC at 60,000 twUSDC.
  await page.getByTestId('side-sell').click();
  await page.getByTestId('make-quantity').fill('0.05');
  await page.getByTestId('make-price').fill('60000');
  await expect(page.getByTestId('legs-give')).toContainText('0.05 twBTC');
  await expect(page.getByTestId('legs-want')).toContainText('3,000.00 twUSDC');
  await page.getByTestId('make-sign').click();
  // Listed on the market, and plainly NOT on-chain (the owner's Q18 finding; questions Q24).
  await expect(page.getByTestId('trade-message')).toContainText('Your offer is listed on the market');
  await expect(page.getByTestId('trade-message')).toContainText('Nothing goes on-chain until someone takes your offer');
  await expect(page.getByTestId('live-offer-banner')).toContainText('It is not on-chain');
  await expect(page.locator('[data-testid=my-trade][data-role=make]')).toContainText('Listed');
  await expect(page.getByTestId('my-offers-off-chain')).toContainText('listed on the market, not on-chain');
  expect(phantom.requests).toHaveLength(1);
  const make = lines(phantom.requests[0]!.text);
  expect(make[0]).toBe('Night Market - stagenet '); // the arm's 24-character label field
  expect(make[1]).toBe('Swap offer');
  expect(make[2]).toMatch(/^Give +0\.05000000 twBTC +\[ad2ba014\]$/);
  expect(make[3]).toMatch(/^Get +3000\.000000 twUSDC +\[e934b965\]$/);
  expect(make.at(-1)).toMatch(/^Digest [0-9a-f]{64}$/);
  expect(relay.submitted.map((s) => [s.action, s.verified])).toEqual([['open-swap', 'ok']]);
  await expect(page.locator('[data-testid=my-trade][data-role=make]')).toHaveAttribute('data-state', 'live');

  // Take: on twETH/twBTC (no twUSDC in it), sell the 1 twETH coin at the best bid, 0.04 twBTC.
  await page.getByTestId('trade-pair').selectOption('twETH/twBTC');
  await page.getByTestId('sell-best-bid').click();
  await expect(page.getByTestId('take-confirm')).toBeVisible();
  await expect(page.getByTestId('take-cancels-offer')).toBeVisible(); // the live offer dies with it
  await page.getByTestId('take-sign').click();
  await expect(page.getByTestId('trade-message')).toContainText('settled in one transaction on Midnight');
  expect(phantom.requests).toHaveLength(2);
  const take = lines(phantom.requests[1]!.text);
  expect(take[1]).toBe('Swap offer');
  expect(take[2]).toMatch(/^Give +1\.000000000000000000 twETH +\[2862f0f3\]$/);
  expect(take[3]).toMatch(/^Get +0\.04000000 twBTC +\[ad2ba014\]$/);
  expect(relay.submitted.map((s) => [s.action, s.verified])).toEqual([
    ['open-swap', 'ok'],
    ['take', 'ok'],
  ]);
  await expect(page.locator('[data-testid=my-trade][data-role=take]')).toHaveAttribute('data-state', 'filled');
  await expect(page.locator('[data-testid=my-trade][data-role=make]')).toHaveAttribute('data-state', 'cancelled');
  await expect(holding(page, 'twBTC')).toContainText('0.14');
  await expect(holding(page, 'twETH')).toHaveCount(0);
});

test('a make the exchange has not listed yet says so, and that nothing is on-chain (questions Q24)', async ({
  page,
}) => {
  const { relay } = await setup(page, { seeded: true });
  relay.makeListing = 'unknown';
  await page.goto(`/#trade?pair=${encodeURIComponent('twBTC/twUSDC')}`);
  await connectPhantom(page);
  await expect(holding(page, 'twBTC')).toContainText('0.10');
  await page.getByTestId('side-sell').click();
  await page.getByTestId('make-quantity').fill('0.05');
  await page.getByTestId('make-price').fill('60000');
  await page.getByTestId('make-sign').click();
  await expect(page.getByTestId('trade-message')).toContainText('The market has your offer, but it is not listed yet');
  await expect(page.getByTestId('trade-message')).toContainText('Nothing goes on-chain until someone takes your offer');
  // The tokens stayed: the offer's coin is not spent.
  await expect(holding(page, 'twBTC')).toContainText('0.10');
});

test('withdraw shielded (one approval, one more to record the change) and unshielded (one approval)', async ({
  page,
}) => {
  const { phantom, relay } = await setup(page, { seeded: true });
  await page.goto('/#account');
  await connectPhantom(page);
  await expect(page.locator('[data-testid=passport-row][data-symbol="twUSDC"]')).toContainText('1,000.00');
  await expect(page.locator('[data-testid=passport-row][data-kind="unshielded"]')).toContainText('25.00');

  // Shielded: 100 twUSDC to a shielded wallet.
  const to = formatShieldedAddress(
    { coinPublicKey: '44'.repeat(32), encryptionPublicKey: '55'.repeat(32) },
    'stagenet',
  );
  await page.getByTestId('send-token').selectOption(COLOUR.twUSDC);
  await page.getByTestId('send-amount').fill('100');
  await page.getByTestId('send-recipient').fill(to);
  await page.getByTestId('send-submit').click();
  await expect(page.getByTestId('accounts-message')).toContainText('the change is recorded in your inbox');
  expect(phantom.requests.map((r) => lines(r.text)[1])).toEqual(['Withdraw shielded', 'File inbox note']);
  expect(lines(phantom.requests[0]!.text)[2]).toMatch(/^Amount +100\.000000 twUSDC +\[e934b965\]$/);
  expect(relay.submitted.map((s) => [s.action, s.verified])).toEqual([
    ['withdraw', 'ok'],
    ['append-inbox', 'ok'],
  ]);
  expect(relay.submitted[0]!.body.auth).toBeUndefined(); // one prompt (questions Q13 option B)
  await expect(page.locator('[data-testid=passport-row][data-symbol="twUSDC"]')).toContainText('900.00');

  // Unshielded: 5 utwUSDC to an unshielded wallet.
  await page.getByTestId('withdraw-kind-unshielded').click();
  await page.getByTestId('wu-amount').fill('5');
  await page.getByTestId('wu-recipient').fill(formatUnshieldedAddress('66'.repeat(32), 'stagenet'));
  await page.getByTestId('wu-submit').click();
  await expect(page.getByTestId('accounts-message')).toContainText('Withdrawn');
  expect(phantom.requests).toHaveLength(3);
  expect(lines(phantom.requests[2]!.text)[1]).toBe('Withdraw unshielded');
  expect(relay.submitted.at(-1)).toMatchObject({ action: 'withdraw-unshielded', verified: 'ok' });
  expect(relay.submitted.at(-1)!.body.payload).toMatchObject({ recipient: '66'.repeat(32), amount: '5000000' });
  await expect(page.locator('[data-testid=passport-row][data-kind="unshielded"]')).toContainText('20.00');

  // An address for another network is refused before Phantom is asked.
  await page.getByTestId('wu-amount').fill('1');
  await page.getByTestId('wu-recipient').fill(formatUnshieldedAddress('66'.repeat(32), 'undeployed'));
  await page.getByTestId('wu-submit').click();
  await expect(page.getByTestId('accounts-message')).toContainText('for the undeployed network, not stagenet');
  expect(phantom.requests).toHaveLength(3);
});

test('?assets= narrows the connected views (00042), and a line one coin cannot pay says why (00044)', async ({
  page,
}) => {
  const { phantom } = await setup(page, { seeded: true });
  await page.goto('/?assets=twETH,twBTC#trade');
  await connectPhantom(page);
  // The holdings side panel and the Trade picker show only the listed assets and their pair.
  await expect(holding(page, 'twBTC')).toContainText('0.10');
  await expect(holding(page, 'twETH')).toContainText('1.00');
  await expect(holding(page, 'twUSDC')).toHaveCount(0);
  await expect(page.getByTestId('trade-pair').locator('option')).toHaveText([/^twETH \/ twBTC/]);
  await page.getByTestId('tab-account').click();
  await expect(page.locator('[data-testid=passport-row][data-symbol="twUSDC"]')).toHaveCount(0);
  await expect(page.locator('[data-testid=passport-row][data-symbol="twBTC"]')).toBeVisible();

  // Everything again, and on twBTC/twUSDC the 0.50 twBTC ask (30,000 twUSDC) is more than the account
  // holds: its Buy stays in place, greyed, and says why on hover and to a screen reader.
  await page.goto(`/?assets=all#trade?pair=${encodeURIComponent('twBTC/twUSDC')}`);
  await connectPhantom(page);
  await expect(holding(page, 'twUSDC')).toContainText('1,000.00');
  const line = page.locator('[data-testid=trade-line]').first();
  const buy = line.getByTestId('take-line-not-enough');
  await expect(buy).toBeDisabled();
  const words = 'Not enough twUSDC. You hold 1,000.00 twUSDC.';
  await expect(buy).toHaveAccessibleDescription(words);
  await line.getByTestId('not-enough').hover();
  await expect(line.getByTestId('tooltip')).toHaveText(words);
  expect(phantom.requests).toEqual([]);
});

test("export, CLEAR ALL and import the connected wallet's records", async ({ page }) => {
  const { phantom } = await setup(page, { seeded: true });
  await page.goto('/#account');
  await connectPhantom(page);
  await expect(page.locator('[data-testid=passport-row][data-symbol="twUSDC"]')).toContainText('1,000.00');
  await page.getByTestId('tab-local').click();
  const keys = () =>
    page.evaluate(() => {
      const out: Record<string, string> = {};
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i)!;
        if (k.startsWith('night-market/')) out[k] = localStorage.getItem(k)!;
      }
      return out;
    });
  const before = await keys();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export').click()]);
  expect(download.suggestedFilename()).toMatch(
    new RegExp(`^night-market-stagenet-${phantom.address.slice(0, 8)}-\\d{4}-\\d{2}-\\d{2}\\.json$`),
  );
  const exported = await readFile((await download.path())!, 'utf8');
  expect(JSON.parse(exported)).toMatchObject({ format: 'night-market-local-data', owner: phantom.deviceKey });

  await page.getByTestId('clear-all').click();
  await page.getByTestId('clear-confirm-input').fill('CLEAR ALL');
  await page.getByTestId('clear-confirm').click();
  await expect(page.getByTestId('records-empty')).toBeVisible();
  expect(await keys()).toEqual({});

  await page
    .getByTestId('import-file')
    .setInputFiles({ name: 'export.json', mimeType: 'application/json', buffer: Buffer.from(exported) });
  await expect(page.getByTestId('local-message')).toContainText('Imported');
  const after = await keys();
  for (const k of Object.keys(before).filter((k) => !k.endsWith('/profile'))) expect(after[k]).toBe(before[k]);
  await page.getByTestId('tab-account').click();
  await expect(page.locator('[data-testid=passport-row][data-symbol="twBTC"]')).toContainText('0.10');
});

test.describe('the wallet refuses or fails: a clear message, and nothing is sent', () => {
  test('a Ledger (hardware) account: refused as hardware, the session ends, the relay sees nothing', async ({
    page,
  }) => {
    const { phantom, relay } = await setup(page);
    await page.goto('/#account');
    await connectPhantom(page);
    phantom.mode = 'ledger';
    await page.getByTestId('open-account').click();
    await expect(page.getByTestId('wallet-error')).toContainText("Hardware (Ledger) accounts aren't supported yet");
    await expect(page.getByTestId('connect')).toBeVisible(); // disconnected
    expect(phantom.requests).toHaveLength(1);
    expect(relay.submitted).toEqual([]);
    expect(relay.refused).toEqual([]);
  });

  test('a declined request, a locked wallet, a signature by another key, a wallet that never answers', async ({
    page,
  }) => {
    const { phantom, relay } = await setup(page, { walletTimeoutSeconds: 5 });
    await page.goto('/#account');
    await connectPhantom(page);
    const attempt = async (mode: MockPhantom['mode'], words: RegExp) => {
      phantom.mode = mode;
      await page.getByTestId('open-account').click();
      await expect(page.getByTestId('accounts-message')).toHaveText(words, { timeout: 15_000 });
      await expect(page.getByTestId('sign-prompt')).toHaveCount(0);
    };
    await attempt('reject', /You declined the request in your wallet\. Nothing was signed, and nothing was sent\./);
    await attempt('locked', /Your wallet is locked/);
    await attempt('other-key', /does not match the request/);
    await attempt('hang', /did not answer within 5 seconds/);
    expect(relay.submitted).toEqual([]);
    expect(relay.refused).toEqual([]);
    // Still connected: the next approval goes through.
    phantom.mode = 'software';
    await page.getByTestId('open-account').click();
    await expect(page.getByTestId('accounts-message')).toContainText('is open');
  });

  test('a declined connection', async ({ page }) => {
    const { phantom } = await setup(page);
    phantom.connectMode = 'reject';
    await page.goto('/#account');
    await connectPhantom(page);
    await expect(page.getByTestId('wallet-error')).toContainText('You declined the connection in your wallet');
    await expect(page.getByTestId('connect')).toBeVisible();
  });

  test("a signature the market's own rebuild does not match is refused before any proof, in words", async ({
    page,
  }) => {
    const { phantom, relay } = await setup(page, { seeded: true });
    relay.mismatchedTokens = true; // the relay shows twBTC as "BTC": its rebuilt message differs
    await page.goto(`/#trade?pair=${encodeURIComponent('twBTC/twUSDC')}`);
    await connectPhantom(page);
    await page.getByTestId('side-sell').click();
    await page.getByTestId('make-quantity').fill('0.05');
    await page.getByTestId('make-price').fill('60000');
    await page.getByTestId('make-sign').click();
    await expect(page.getByTestId('trade-message')).toContainText('could not verify your wallet’s signature');
    expect(phantom.requests).toHaveLength(1);
    expect(relay.refused).toEqual(['open-swap: bad-signature']);
    expect(relay.submitted).toEqual([]);
  });

  test('a second demo claim is refused by the market, in words', async ({ page }) => {
    const { phantom, relay } = await setup(page, { seeded: true });
    relay.demo.claimed.add(phantom.deviceKey);
    await page.goto('/#account');
    await connectPhantom(page);
    await expect(page.getByTestId('demo-unavailable')).toHaveAttribute('data-code', 'claimed');
    await expect(page.getByTestId('get-demo-tokens')).toBeDisabled();
  });
});

test("Phantom's injected provider (no Wallet Standard): display 'utf8', and an account opens", async ({ page }) => {
  const { phantom, relay } = await setup(page, { injected: true, standard: false });
  await page.goto('/#account');
  await connectPhantom(page);
  await expect(page.getByTestId('wallet-address')).toHaveText(shortSolanaAddress(phantom.address));
  await page.getByTestId('open-account').click();
  await expect(page.getByTestId('accounts-message')).toContainText('is open');
  expect(phantom.requests.map((r) => [r.via, r.display])).toEqual([['injected', 'utf8']]);
  expect(relay.submitted.map((s) => [s.action, s.verified])).toEqual([['register', 'ok']]);
});
