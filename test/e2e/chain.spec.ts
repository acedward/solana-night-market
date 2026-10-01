// AA 00047 P9.S, the site lane of the security fix pass (spec FR-004b; audit C3, C6, C7; questions
// Q25 B′, Q26 A, Q28 A, Q30, Q31), with the mock Phantom, the mock relay and the mock PUBLIC INDEXER
// (./mock-indexer.ts: real serialised account states, real verifier keys). Each test fails on the site
// before P9.S and passes after:
//
//   - the page reads a new account from the indexer and checks it before any deposit or trade, and
//     refuses every way a compromised relay could deploy it (a second device, a live authority,
//     another verifier key, another encryption key, another network);
//   - the nonce, the device counter, the inbox and the public balances come from the chain: a relay
//     that misreports them changes nothing;
//   - a coin position the indexer's events do not carry is not used (Q31);
//   - makes and takes sign a real expiry, shown readably; "Cancel offer" lands the cancel and the
//     offer shows Cancelled only once the chain's nonce moved (Q30);
//   - a withdrawal's change is computed in the page (Q28 A);
//   - the signing panel lists what the contract enforces: base units and full token ids (Q25 B′);
//   - the page works under the RUNBOOK's Content-Security-Policy, whose connect-src must name the
//     indexer.

import { expect, test, type Page } from '@playwright/test';

import { formatShieldedAddress } from '../../packages/core/src/shielded-address.js';
import { formatUnshieldedAddress } from '../../packages/core/src/unshielded.js';
import { COLOUR } from '../../packages/core/test/fixtures/kernel/book.js';
import { contractCoinCommitment } from '../../packages/core/src/coins.js';
import { INDEXER, type Tamper } from './mock-indexer.js';
import { connectPhantom } from './mock-phantom.js';
import { ACCOUNT, RELAY } from './mock-relay.js';
import { KERNEL } from './visual-fixtures.js';
import { setup } from './wallet-fixtures.js';

const lines = (text: string) => text.split('\n');
/** The trade page's holdings panel. */
const holding = (page: Page, symbol: string, kind = 'shielded') =>
  page.locator(`[data-testid=holding][data-symbol="${symbol}"][data-kind="${kind}"]`);
/** The Portfolio's private (shielded) token rows. */
const portfolioRow = (page: Page, symbol: string) =>
  page.locator(`[data-testid=passport-row][data-symbol="${symbol}"]:not([data-kind="unshielded"])`);
const nowS = () => Math.floor(Date.now() / 1000);

test.describe('the browser checks its account on the chain (audit C3, questions Q26)', () => {
  test('a new account is read from the public indexer and checked before the first deposit', async ({ page }) => {
    const { phantom, relay, indexer } = await setup(page);
    await page.goto('/#account');
    await connectPhantom(page);
    await page.getByTestId('open-account').click();
    await expect(page.getByTestId('accounts-message')).toContainText('is open');
    // The page asked the INDEXER for the account (the relay's own state route is never asked).
    expect(indexer.queries).toContain(`state:${ACCOUNT}`);
    await expect(page.getByTestId('account-check')).toHaveAttribute('data-state', 'ok');
    await expect(page.getByTestId('account-check')).toContainText('your wallet as its only device');
    // Only then the deposit: the demo pack, one more approval.
    await page.getByTestId('get-demo-tokens').click();
    await expect(page.getByTestId('demo-message')).toContainText('Demo tokens delivered');
    expect(relay.submitted.map((s) => [s.action, s.verified])).toEqual([
      ['register', 'ok'],
      ['demo-tokens', 'ok'],
    ]);
    expect(phantom.requests).toHaveLength(2);
  });

  const BACKDOORS: Array<[string, Tamper, string]> = [
    ['a second device (the relay’s own key)', { extraDevice: true }, 'devices'],
    ['a maintenance authority kept', { liveAuthority: true }, 'authority-live'],
    ['another verifier key under a circuit’s name', { swappedKey: true }, 'verifier-keys'],
    ['another encryption key', { otherEncKey: true }, 'enc-key'],
    ['another network’s salt', { otherSalt: true }, 'network-salt'],
  ];
  for (const [what, tamper, code] of BACKDOORS) {
    test(`refuses an account deployed with ${what}, and signs nothing for it`, async ({ page }) => {
      const { phantom, relay, indexer } = await setup(page);
      indexer.tamper = tamper;
      await page.goto('/#account');
      await connectPhantom(page);
      await page.getByTestId('open-account').click();
      await expect(page.getByTestId('accounts-message')).toContainText("does not pass this site's checks");
      await expect(page.getByTestId('accounts-message')).toContainText('Do not send tokens to it');
      await expect(page.getByTestId('account-check')).toHaveAttribute('data-state', 'failed');
      await expect(page.locator(`[data-testid=account-check-problem][data-code="${code}"]`)).toBeVisible();
      // No deposit into it: the demo tokens are refused before any approval.
      await expect(page.getByTestId('demo-account-refused')).toBeVisible();
      await expect(page.getByTestId('get-demo-tokens')).toBeDisabled();
      expect(phantom.requests).toHaveLength(1); // the registration's, nothing since
      expect(relay.submitted.map((s) => s.action)).toEqual(['register']);
    });
  }

  test('the nonce, the device counter, the inbox and the public balances come from the chain, not the relay', async ({
    page,
  }) => {
    const { phantom, relay } = await setup(page, { seeded: true });
    relay.lies = true; // the relay's own account routes now misreport everything
    await page.goto('/#account');
    await connectPhantom(page);
    // The chain's numbers: 25 utwUSDC (the lying relay says 25,000), the inbox's three coins.
    await expect(page.locator('[data-testid=passport-row][data-kind="unshielded"]')).toContainText('25.00');
    await expect(page.locator('[data-testid=passport-row][data-kind="unshielded"]')).not.toContainText('25,000');
    await expect(portfolioRow(page, 'twBTC')).toContainText('0.10');
    // A call signed at the CHAIN's nonce and counter, which the (honest) check accepts.
    await page.getByTestId('withdraw-kind-unshielded').click();
    await page.getByTestId('wu-amount').fill('5');
    await page.getByTestId('wu-recipient').fill(formatUnshieldedAddress('66'.repeat(32), 'stagenet'));
    await page.getByTestId('wu-submit').click();
    await expect(page.getByTestId('accounts-message')).toContainText('Withdrawn');
    expect(relay.submitted.map((s) => [s.action, s.verified])).toEqual([['withdraw-unshielded', 'ok']]);
    expect(lines(phantom.requests[0]!.text).at(-2)).toMatch(/ nonce 3 *$/); // the chain's nonce, not the relay's 8 (F3 v2: left-aligned)
    await expect(page.locator('[data-testid=passport-row][data-kind="unshielded"]')).toContainText('20.00');
  });

  test('a coin position the indexer’s own events do not carry is not used (questions Q31)', async ({ page }) => {
    const { indexer } = await setup(page, { seeded: true });
    // The relay reports the twETH coin's leaf; the chain's events do not carry it.
    const twEthCoin = { nonce: 'a2'.repeat(32), color: COLOUR.twETH, value: '1000000000000000000' };
    indexer.hideFromEvents.add(contractCoinCommitment(twEthCoin, ACCOUNT));
    await page.goto('/#account');
    await connectPhantom(page);
    const row = portfolioRow(page, 'twETH');
    await expect(row.getByTestId('passport-amount')).toHaveAttribute('data-raw', twEthCoin.value);
    // Held, but not spendable: no position the chain confirms.
    await expect(row.getByTestId('passport-largest')).toHaveAttribute('data-raw', '0');
    await expect(
      page.locator('[data-testid=passport-row][data-symbol="twBTC"]').getByTestId('passport-largest'),
    ).toHaveAttribute('data-raw', '10000000');
  });
});

test.describe('offers sign a real expiry, and can be cancelled (audit C6, questions Q30)', () => {
  test('a make signs now + one hour and shows it; a take signs now + five minutes', async ({ page }) => {
    const { phantom, relay } = await setup(page, { seeded: true });
    await page.goto(`/#trade?pair=${encodeURIComponent('twBTC/twUSDC')}`);
    await connectPhantom(page);
    await expect(holding(page, 'twBTC')).toContainText('0.10');
    await page.getByTestId('side-sell').click();
    await page.getByTestId('make-quantity').fill('0.05');
    await page.getByTestId('make-price').fill('60000');
    const t0 = nowS();
    await page.getByTestId('make-sign').click();
    await expect(page.getByTestId('trade-message')).toContainText('Your offer is listed on the market');
    expect(relay.submitted.map((s) => [s.action, s.verified])).toEqual([['open-swap', 'ok']]);
    const until = Number(relay.signedExpiries[0]);
    expect(until).toBeGreaterThanOrEqual(t0 + 3600);
    expect(until).toBeLessThanOrEqual(nowS() + 3600);
    // The wallet's text carries it as a UTC date and time (F3 v2, audit C6).
    const readable = new Date(until * 1000).toISOString().slice(0, 19).replace('T', ' ') + ' UTC';
    expect(lines(phantom.requests[0]!.text)).toContain(`Expires ${readable}`);
    await expect(page.getByTestId('my-trade-expiry')).toHaveText(`until ${readable.slice(11, 16)} UTC`);
    await expect(page.getByTestId('my-trade-expiry')).toHaveAttribute('title', `Expires ${readable}`);
    await expect(page.getByTestId('live-offer-banner')).toContainText(`until ${readable} (the expiry you approved)`);

    // A take: five minutes.
    await page.getByTestId('trade-pair').selectOption('twETH/twBTC');
    await page.getByTestId('sell-best-bid').click();
    await expect(page.getByTestId('take-validity')).toContainText('valid for 5 minutes');
    const t1 = nowS();
    await page.getByTestId('take-sign').click();
    await expect(page.getByTestId('trade-message')).toContainText('settled in one transaction on Midnight');
    const takeUntil = Number(relay.signedExpiries[1]);
    expect(takeUntil).toBeGreaterThanOrEqual(t1 + 300);
    expect(takeUntil).toBeLessThanOrEqual(nowS() + 300);
  });

  test('Cancel offer: one approval, the chain’s nonce moves, and only then the offer shows Cancelled', async ({
    page,
  }) => {
    const { phantom, relay, indexer } = await setup(page, { seeded: true });
    await page.goto(`/#trade?pair=${encodeURIComponent('twBTC/twUSDC')}`);
    await connectPhantom(page);
    await expect(holding(page, 'twBTC')).toContainText('0.10');
    await page.getByTestId('side-sell').click();
    await page.getByTestId('make-quantity').fill('0.05');
    await page.getByTestId('make-price').fill('60000');
    await page.getByTestId('make-sign').click();
    await expect(page.getByTestId('live-offer-banner')).toBeVisible();
    const before = indexer.queries.length;
    await page.getByTestId('cancel-offer').click();
    await expect(page.getByTestId('trade-message')).toContainText('Cancelled: your offer can no longer be taken');
    expect(relay.submitted.map((s) => [s.action, s.verified])).toEqual([
      ['open-swap', 'ok'],
      ['cancel-offers', 'ok'],
    ]);
    // The account's own key, re-affirmed: the call changes nothing but the nonce.
    expect(relay.submitted[1]!.body.payload).toMatchObject({ newKey: relay.encKey, authNonce: '3' });
    expect(phantom.requests).toHaveLength(2);
    // F3 v2 (questions Q30, Q32): the account's own key re-affirmed reads as a cancel, not a key change.
    expect(lines(phantom.requests[1]!.text).slice(1, 3)).toEqual([
      'Cancel all open offers',
      'Your key does not change',
    ]);
    expect(relay.authNonce).toBe(4n);
    expect(indexer.queries.slice(before)).toContain(`state:${ACCOUNT}`); // the chain confirmed it
    await expect(page.locator('[data-testid=my-trade][data-role=make]')).toHaveAttribute('data-state', 'cancelled');
    await expect(page.getByTestId('live-offer-banner')).toHaveCount(0);
  });

  test('a market that cannot cancel yet says so, and the offer stays as it is', async ({ page }) => {
    const { relay } = await setup(page, { seeded: true });
    relay.cancelMode = 'not-implemented';
    await page.goto(`/#trade?pair=${encodeURIComponent('twBTC/twUSDC')}`);
    await connectPhantom(page);
    await expect(holding(page, 'twBTC')).toContainText('0.10');
    await page.getByTestId('side-sell').click();
    await page.getByTestId('make-quantity').fill('0.05');
    await page.getByTestId('make-price').fill('60000');
    await page.getByTestId('make-sign').click();
    await expect(page.getByTestId('live-offer-banner')).toBeVisible();
    await page.getByTestId('cancel-offer').click();
    await expect(page.getByTestId('trade-message')).toContainText('This market cannot cancel offers yet');
    await expect(page.locator('[data-testid=my-trade][data-role=make]')).toHaveAttribute('data-state', 'live');
  });
});

test('a withdrawal’s change is computed in the page: a relay that reports another one is caught (questions Q28 A)', async ({
  page,
}) => {
  const { phantom, relay } = await setup(page, { seeded: true });
  relay.misreportChange = true;
  await page.goto('/#account');
  await connectPhantom(page);
  await expect(portfolioRow(page, 'twUSDC')).toContainText('1,000.00');
  await page.getByTestId('withdraw-kind-shielded').click();
  await page.getByTestId('send-token').selectOption(COLOUR.twUSDC);
  await page.getByTestId('send-amount').fill('100');
  await page
    .getByTestId('send-recipient')
    .fill(formatShieldedAddress({ coinPublicKey: '44'.repeat(32), encryptionPublicKey: '55'.repeat(32) }, 'stagenet'));
  await page.getByTestId('send-submit').click();
  await expect(page.getByTestId('accounts-message')).toContainText('reported a different change coin');
  // The change recorded and filed is the one the withdrawal made, not the relay's fabrication.
  await expect
    .poll(() => relay.submitted.map((s) => [s.action, s.verified]))
    .toEqual([
      ['withdraw', 'ok'],
      ['append-inbox', 'ok'],
    ]);
  expect(phantom.requests).toHaveLength(2);
  const stored = await page.evaluate(() =>
    Object.keys(localStorage)
      .filter((k) => k.endsWith('/coins'))
      .map((k) => localStorage.getItem(k) ?? '')
      .join('\n'),
  );
  expect(stored).toContain('"origin":"change"');
  expect(stored).not.toContain('c4'.repeat(32));
  await expect(portfolioRow(page, 'twUSDC')).toContainText('900.00');
});

test('the signing panel lists what the contract enforces: base units and full token ids (questions Q25 B′)', async ({
  page,
}) => {
  const { phantom } = await setup(page, { seeded: true });
  await page.goto(`/#trade?pair=${encodeURIComponent('twBTC/twUSDC')}`);
  await connectPhantom(page);
  await expect(holding(page, 'twBTC')).toContainText('0.10');
  await page.getByTestId('side-sell').click();
  await page.getByTestId('make-quantity').fill('0.05');
  await page.getByTestId('make-price').fill('60000');
  const release = phantom.holdNext();
  await page.getByTestId('make-sign').click();
  const facts = page.getByTestId('sign-facts');
  await expect(facts).toBeVisible();
  await expect(page.getByTestId('sign-facts-title')).toHaveText('Make an offer');
  const give = facts.locator('[data-testid=sign-fact][data-label="Give"]');
  await expect(give.getByTestId('sign-fact-base-units')).toHaveText('5000000');
  await expect(give.getByTestId('sign-fact-token-id')).toHaveText(COLOUR.twBTC);
  await expect(give.getByTestId('sign-fact-site-label')).toHaveText('This site labels it: 0.05000000 twBTC');
  const get = facts.locator('[data-testid=sign-fact][data-label="Get"]');
  await expect(get.getByTestId('sign-fact-base-units')).toHaveText('3000000000');
  await expect(get.getByTestId('sign-fact-token-id')).toHaveText(COLOUR.twUSDC);
  await expect(facts.locator('[data-testid=sign-fact][data-label="Expires"]')).toContainText(
    /\d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC/,
  );
  release();
  await expect(page.getByTestId('sign-prompt')).toHaveCount(0);
});

// deploy/RUNBOOK.md §16: the tested Content-Security-Policy, with this test's origins in place of the
// stagenet ones (the relay is cross-origin here; in a deployment it is the same-origin /relay).
const CSP = (connect: string[]) =>
  [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src 'self' ${connect.join(' ')}`,
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'none'",
  ].join('; ');

async function withCsp(page: Page, policy: string): Promise<string[]> {
  const violations: string[] = [];
  await page.exposeFunction('__cspViolation', (v: string) => violations.push(v));
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) =>
      (window as unknown as { __cspViolation(v: string): void }).__cspViolation(
        `${e.violatedDirective} ${e.blockedURI} at ${e.sourceFile.split('/').pop()}:${e.lineNumber}:${e.columnNumber}`,
      ),
    );
  });
  await page.route(
    (url) => url.hostname === '127.0.0.1',
    async (route) => {
      if (route.request().resourceType() !== 'document') return route.fallback();
      const response = await route.fetch();
      return route.fulfill({ response, headers: { ...response.headers(), 'content-security-policy': policy } });
    },
  );
  return violations;
}

test('works under the RUNBOOK’s Content-Security-Policy, whose connect-src names the indexer', async ({ page }) => {
  await setup(page);
  const violations = await withCsp(page, CSP([RELAY, new URL(INDEXER).origin, KERNEL]));
  await page.goto('/#account');
  await connectPhantom(page);
  await page.getByTestId('open-account').click();
  await expect(page.getByTestId('accounts-message')).toContainText('is open');
  await expect(page.getByTestId('account-check')).toHaveAttribute('data-state', 'ok');
  expect(violations).toEqual([]);
});

test('without the indexer in connect-src the page cannot check the account, and says so', async ({ page }) => {
  await setup(page, { seeded: true });
  const violations = await withCsp(page, CSP([RELAY, KERNEL]));
  await page.goto('/#account');
  await connectPhantom(page);
  await expect(page.getByTestId('account-check')).toHaveAttribute('data-state', 'error');
  expect(violations.some((v) => v.startsWith('connect-src') && v.includes('indexer.test'))).toBe(true);
});
