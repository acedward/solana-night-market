// AA 00047 P10.S, the site lane of the round-2 security fix pass (spec FR-004b "Round 2"; audit
// "Consolidation, round 2": R2-3, R2-4, R2-5, R2-6), with the mock Phantom, the mock relay and the
// mock PUBLIC INDEXER (real serialised account states). Each test fails on the site before P10.S and
// passes after:
//
//   - R2-4: an approval shows as ended only from what the browser reads on the chain: a relay's
//     "done" for another call does not cancel a live offer, a cancel that lands as the offer's fill
//     shows Filled (never Cancelled), and a record an older page ended too early is decided again;
//   - R2-5: a withdrawal's change is written down before the approval leaves the page, so a relay
//     that lands it and reports a failure cannot make the page forget it (a reload included);
//   - R2-6: a just-opened account with a note already in its inbox is refused, and stays refused; a
//     note for a coin the chain does not show never counts; a history longer than the indexer's
//     newest page still syncs;
//   - R2-3: an account whose on-chain encryption key is not this browser's (its wallet still its one
//     device) gets "Restore my encryption key", and is usable again once the chain shows the key.

import { expect, test, type Page } from '@playwright/test';

import { bytesToHex } from '../../packages/core/src/hex.js';
import { formatShieldedAddress } from '../../packages/core/src/shielded-address.js';
import { formatUnshieldedAddress } from '../../packages/core/src/unshielded.js';
import { COLOUR } from '../../packages/core/test/fixtures/kernel/book.js';
import { connectPhantom } from './mock-phantom.js';
import { setup } from './wallet-fixtures.js';

const lines = (text: string) => text.split('\n');
/** The Portfolio's private (shielded) token rows. */
const portfolioRow = (page: Page, symbol: string) =>
  page.locator(`[data-testid=passport-row][data-symbol="${symbol}"]:not([data-kind="unshielded"])`);
const holding = (page: Page, symbol: string, kind = 'shielded') =>
  page.locator(`[data-testid=holding][data-symbol="${symbol}"][data-kind="${kind}"]`);
const myMake = (page: Page) => page.locator('[data-testid=my-trade][data-role=make]');

/** Make an offer on twBTC/twUSDC (sell 0.05 twBTC at 60,000): live and listed. */
async function makeAnOffer(page: Page) {
  await page.goto(`/#trade?pair=${encodeURIComponent('twBTC/twUSDC')}`);
  await connectPhantom(page);
  await expect(holding(page, 'twBTC')).toContainText('0.10');
  await page.getByTestId('side-sell').click();
  await page.getByTestId('make-quantity').fill('0.05');
  await page.getByTestId('make-price').fill('60000');
  await page.getByTestId('make-sign').click();
  await expect(page.getByTestId('live-offer-banner')).toBeVisible();
  await expect(myMake(page)).toHaveAttribute('data-state', 'live');
}

test.describe('R2-4: an approval ends on the chain’s word, never the relay’s', () => {
  test('a withdrawal the relay reports done but never lands does not cancel the live offer', async ({ page }) => {
    const { relay } = await setup(page, { seeded: true });
    page.on('dialog', (d) => void d.accept()); // "This withdrawal cancels your live offer. Continue?"
    await makeAnOffer(page);
    relay.fakeSuccess.add('withdraw-unshielded');
    await page.goto('/#account');
    await page.getByTestId('withdraw-kind-unshielded').click();
    await page.getByTestId('wu-amount').fill('5');
    await page.getByTestId('wu-recipient').fill(formatUnshieldedAddress('66'.repeat(32), 'stagenet'));
    await page.getByTestId('wu-submit').click();
    await expect(page.getByTestId('accounts-message')).toContainText('Withdrawn');
    expect(relay.authNonce).toBe(3n); // nothing landed
    await page.goto(`/#trade?pair=${encodeURIComponent('twBTC/twUSDC')}`);
    // The approval can still execute: it is not shown as ended.
    await expect(myMake(page)).toHaveAttribute('data-state', 'live');
    await expect(page.getByTestId('live-offer-banner')).toBeVisible();
    // Once the chain shows the nonce moved (another call landed) and no fill: Cancelled.
    relay.authNonce += 1n;
    relay.useCounter += 1n;
    await page.reload();
    await connectPhantom(page);
    await expect(myMake(page)).toHaveAttribute('data-state', 'cancelled');
  });

  test('a cancel the relay lands as the offer’s FILL shows Filled, never Cancelled', async ({ page }) => {
    const { relay } = await setup(page, { seeded: true });
    await makeAnOffer(page);
    relay.settleOnCancel = true;
    await page.getByTestId('cancel-offer').click();
    await expect(page.getByTestId('trade-message')).toContainText('Your offer was taken before the cancel landed');
    await expect(myMake(page)).toHaveAttribute('data-state', 'filled');
    await expect(myMake(page).getByTestId('my-trade-tx')).not.toContainText('—');
  });

  test('an offer an older page marked Cancelled too early is live again while the chain says so', async ({ page }) => {
    const { relay } = await setup(page, { seeded: true });
    await makeAnOffer(page);
    // What the page before P10 did on a relay's "succeeded" for another call: the record says Cancelled.
    const key = await page.evaluate(() => Object.keys(localStorage).find((k) => k.includes('/offer/make-'))!);
    await page.evaluate((k) => {
      const r = JSON.parse(localStorage.getItem(k)!) as { data: { status: string } };
      r.data.status = 'cancelled';
      localStorage.setItem(k, JSON.stringify(r));
    }, key);
    await page.reload();
    await connectPhantom(page);
    expect(relay.authNonce).toBe(3n);
    await expect(myMake(page)).toHaveAttribute('data-state', 'live');
  });
});

test.describe('R2-5: a withdrawal’s change survives a relay that lands it and reports a failure', () => {
  test('the change is kept as pending (a reload included) and counts once the chain shows it', async ({ page }) => {
    const { relay } = await setup(page, { seeded: true });
    relay.landButFail.add('withdraw');
    await page.goto('/#account');
    await connectPhantom(page);
    await expect(portfolioRow(page, 'twUSDC')).toContainText('1,000.00');
    await page.getByTestId('withdraw-kind-shielded').click();
    await page.getByTestId('send-token').selectOption(COLOUR.twUSDC);
    await page.getByTestId('send-amount').fill('100');
    await page
      .getByTestId('send-recipient')
      .fill(
        formatShieldedAddress({ coinPublicKey: '44'.repeat(32), encryptionPublicKey: '55'.repeat(32) }, 'stagenet'),
      );
    await page.getByTestId('send-submit').click();
    await expect(page.getByTestId('accounts-message')).toContainText('The prover crashed');
    // The relay DID land it: the 1,000 coin is spent on chain, and 900 of change exists. The page wrote
    // the change down before it sent anything.
    await expect(page.getByTestId('pending-change')).toContainText('900.00 twUSDC');
    await page.reload();
    await connectPhantom(page);
    // Read from the chain: the change's leaf is there, so it counts and the pending item is gone.
    await expect(portfolioRow(page, 'twUSDC')).toContainText('900.00');
    await expect(page.getByTestId('pending-change')).toHaveCount(0);
  });
});

test.describe('R2-6: the chain view survives seeded state, fake notes and a long history', () => {
  test('a just-opened account with a note already in its inbox is refused, and stays refused', async ({ page }) => {
    const { relay, indexer, phantom } = await setup(page);
    indexer.tamper = { seededInbox: true };
    await page.goto('/#account');
    await connectPhantom(page);
    await page.getByTestId('open-account').click();
    await expect(page.getByTestId('accounts-message')).toContainText("does not pass this site's checks");
    await expect(page.locator('[data-testid=account-check-problem][data-code="not-empty"]')).toBeVisible();
    // Later, the chain view alone would pass (an account in use is neither fresh nor empty): still refused.
    await page.reload();
    await connectPhantom(page);
    await expect(page.getByTestId('account-check')).toHaveAttribute('data-state', 'failed');
    await expect(page.locator('[data-testid=account-check-problem][data-code="not-empty"]')).toBeVisible();
    await expect(page.getByTestId('get-demo-tokens')).toBeDisabled();
    expect(relay.submitted.map((s) => s.action)).toEqual(['register']);
    expect(phantom.requests).toHaveLength(1);
  });

  test('a deposit by anyone right after the deploy does NOT get the new account refused (questions Q42)', async ({
    page,
  }) => {
    const { relay, indexer } = await setup(page);
    relay.depositAfterDeploy = true; // a real one-unit coin, with its note, before the page looks
    await page.goto('/#account');
    await connectPhantom(page);
    await page.getByTestId('open-account').click();
    await expect(page.getByTestId('accounts-message')).toContainText('is open');
    await expect(page.getByTestId('account-check')).toHaveAttribute('data-state', 'ok');
    expect(indexer.queries).toContain(`deployed:${'7e'.repeat(32)}`); // judged on the account as deployed
  });

  test('a just-opened account seeded with a balance that would overflow deposits is refused', async ({ page }) => {
    const { indexer } = await setup(page);
    indexer.tamper = { seededCredit: true };
    await page.goto('/#account');
    await connectPhantom(page);
    await page.getByTestId('open-account').click();
    await expect(page.locator('[data-testid=account-check-problem][data-code="not-empty"]')).toContainText(
      'balances already in it',
    );
  });

  test('a note in the inbox for a coin the chain does not show never counts', async ({ page }) => {
    const { relay } = await setup(page, { seeded: true });
    // Anyone can file a note with deposit_shielded: "5,000 twBTC", with no coin behind it.
    await relay.fakeNote({ nonce: '5f'.repeat(32), color: COLOUR.twBTC, value: 500_000_000_000n });
    await page.goto('/#account');
    await connectPhantom(page);
    await expect(portfolioRow(page, 'twBTC').getByTestId('passport-amount')).toHaveAttribute('data-raw', '10000000');
    await expect(page.getByTestId('unconfirmed-notes')).toHaveAttribute('data-count', '1');
    await expect(page.getByTestId('unconfirmed-notes')).not.toContainText('5,000');
  });

  test('an account with more transactions than the indexer’s newest page still syncs', async ({ page }) => {
    const { indexer } = await setup(page, { seeded: true });
    indexer.padActions = 600; // newer than the account's own: a griefer's one-unit deposits
    await page.goto('/#account');
    await connectPhantom(page);
    await expect(portfolioRow(page, 'twBTC')).toContainText('0.10');
    await expect(portfolioRow(page, 'twBTC').getByTestId('passport-largest')).toHaveAttribute('data-raw', '10000000');
    expect(indexer.byHash.length).toBeGreaterThan(0); // the older ones were read by hash
  });
});

test.describe('P10.R’s new refusals and failures reach the customer in plain words', () => {
  test('an account with a request in progress, the open-offers cap, and a market-side failure', async ({ page }) => {
    const { relay } = await setup(page, { seeded: true });
    await page.goto(`/#trade?pair=${encodeURIComponent('twBTC/twUSDC')}`);
    await connectPhantom(page);
    await expect(holding(page, 'twBTC')).toContainText('0.10');
    await page.getByTestId('side-sell').click();
    await page.getByTestId('make-quantity').fill('0.05');
    await page.getByTestId('make-price').fill('60000');
    relay.refuseNext = {
      status: 429,
      code: 'open-offers-cap',
      message: 'this account has 3 open offers, the most the market lists at once',
      retryAfter: 900,
    };
    await page.getByTestId('make-sign').click();
    await expect(page.getByTestId('trade-message')).toContainText(
      'Your account already has as many open offers as the market lists at once',
    );
    relay.refuseNext = { status: 429, code: 'account-busy', message: 'busy', retryAfter: 40 };
    await page.getByTestId('make-sign').click();
    await expect(page.getByTestId('trade-message')).toContainText(
      'Your account already has a request in progress at the market. Wait for it to finish (about 40 s)',
    );
    relay.failNextJob = { code: 'market-unavailable', message: 'the prover failed' };
    await page.getByTestId('make-sign').click();
    await expect(page.getByTestId('trade-message')).toContainText(
      "The market's prover or its connection to Midnight failed while working on this. It does not count against you",
    );
    expect(relay.refused).toEqual(['open-swap: open-offers-cap', 'open-swap: account-busy']);
  });
});

test.describe('R2-3: "Restore my encryption key" instead of a dead end', () => {
  test('the wallet signs the key back, and the account is usable again once the chain shows it', async ({ page }) => {
    const { relay, phantom } = await setup(page, { seeded: true });
    const mine = relay.encKey!;
    relay.encKey = 'e1'.repeat(32); // someone changed the account's key (a page passed it off as a cancel)
    await page.goto('/#account');
    await connectPhantom(page);
    await expect(page.locator('[data-testid=account-check-problem][data-code="enc-key"]')).toBeVisible();
    await expect(page.getByTestId('account-check-restorable')).toBeVisible();
    await page.getByTestId('restore-key').click();
    await expect(page.getByTestId('accounts-message')).toContainText('Your encryption key is restored');
    expect(relay.submitted.map((s) => [s.action, s.verified])).toEqual([['restore-enc-key', 'ok']]);
    expect(relay.submitted[0]!.body.payload).toEqual({ newKey: mine, authNonce: '3' });
    expect(relay.encKey).toBe(mine);
    // The wallet's text: a key change, to THIS browser's key.
    expect(
      lines(phantom.requests[0]!.text)
        .slice(1, 3)
        .map((l) => l.trimEnd()),
    ).toEqual(['Rotate encryption key', `New key ${mine.slice(0, 16)}`]);
    await expect(page.getByTestId('account-check')).toHaveAttribute('data-state', 'ok');
  });

  test('the Trade page points to it; a market that cannot restore yet says so', async ({ page }) => {
    const { relay } = await setup(page, { seeded: true });
    relay.encKey = bytesToHex(new Uint8Array(32).fill(0xe1));
    relay.restoreMode = 'not-implemented';
    await page.goto(`/#trade?pair=${encodeURIComponent('twBTC/twUSDC')}`);
    await connectPhantom(page);
    await expect(page.getByTestId('trade-restore-key')).toBeVisible();
    await page.getByTestId('trade-restore-key').click();
    await page.getByTestId('restore-key').click();
    await expect(page.getByTestId('accounts-message')).toContainText('This market cannot restore encryption keys yet');
    expect(relay.encKey).toBe('e1'.repeat(32));
  });
});
