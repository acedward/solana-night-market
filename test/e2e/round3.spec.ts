// AA 00047 P11.A, the site lane of the round-3 security fix pass for account provenance and the small
// items (spec FR-004b "Round 3"; audit "Consolidation, round 3": R3-1, R3-9, R3-10; owner decision
// Q46 A), with the mock Phantom, the mock relay and the mock PUBLIC INDEXER (real serialised account
// states, and the account's origin: its deploy, its retiring update, the blocks between). Each test
// fails on the site before P11.A and passes after:
//
//   - R3-1: a relay-made account whose deploy-time state is not the constructor's (auditor A's `round`
//     time bomb) or that was written to before its authority retired is refused at opening, and stays
//     refused; nothing is signed for it;
//   - R3-10: a deploy the indexer has no record of is read from the deploy transaction the page
//     recorded, and while the indexer does not show it at all the opening waits: a deposit by anyone
//     since never gets the account refused, and nothing is kept;
//   - R3-9: "Restore my encryption key" explains, before Phantom opens, that it sets the key back to
//     the one this browser holds and never moves funds;
//   - Q46: nothing is said about the withdrawal allowance until the market refuses one for it; then
//     the page explains it and offers the whole-coin exit.

import { expect, test, type Page } from '@playwright/test';

import { formatShieldedAddress } from '../../packages/core/src/shielded-address.js';
import { formatUnshieldedAddress } from '../../packages/core/src/unshielded.js';
import { COLOUR } from '../../packages/core/test/fixtures/kernel/book.js';
import { connectPhantom } from './mock-phantom.js';
import { ACCOUNT } from './mock-relay.js';
import { setup } from './wallet-fixtures.js';

const problem = (page: Page, code: string) => page.locator(`[data-testid=account-check-problem][data-code="${code}"]`);
const portfolioRow = (page: Page, symbol: string) =>
  page.locator(`[data-testid=passport-row][data-symbol="${symbol}"]:not([data-kind="unshielded"])`);
const WALLET = formatShieldedAddress(
  { coinPublicKey: '44'.repeat(32), encryptionPublicKey: '55'.repeat(32) },
  'stagenet',
);

test.describe('R3-1: the page checks where its new account came from', () => {
  test('auditor A’s `round` time bomb is refused at opening, stays refused, and nothing is signed for it', async ({
    page,
  }) => {
    const { relay, indexer, phantom } = await setup(page);
    indexer.tamper = { roundBomb: true };
    await page.goto('/#account');
    await connectPhantom(page);
    await page.getByTestId('open-account').click();
    await expect(page.getByTestId('accounts-message')).toContainText("does not pass this site's checks");
    await expect(problem(page, 'provenance')).toContainText('different starting state');
    await expect(problem(page, 'counters')).toContainText('freezing your tokens');
    await page.reload();
    await connectPhantom(page);
    await expect(page.getByTestId('account-check')).toHaveAttribute('data-state', 'failed');
    await expect(problem(page, 'provenance')).toBeVisible();
    await expect(page.getByTestId('get-demo-tokens')).toBeDisabled();
    expect(relay.submitted.map((s) => s.action)).toEqual(['register']);
    expect(phantom.requests).toHaveLength(1);
    expect(indexer.queries).toContain(`origin:${ACCOUNT}`);
  });

  test('an account written to before its maintenance authority retired is refused', async ({ page }) => {
    const { indexer } = await setup(page);
    indexer.tamper = { maintenanceWrite: true };
    await page.goto('/#account');
    await connectPhantom(page);
    await page.getByTestId('open-account').click();
    await expect(problem(page, 'provenance')).toContainText('before its contract was locked');
    expect(indexer.queries).toContain('window');
  });
});

test.describe('R3-10: a deploy the indexer does not show never makes the check stricter', () => {
  test('no deploy record: the recorded deploy transaction is read, and a deposit since changes nothing', async ({
    page,
  }) => {
    const { relay, indexer } = await setup(page);
    indexer.tamper = { noDeployRecord: true };
    relay.depositAfterDeploy = true; // anyone's one-unit coin, with its note, before the page looks
    await page.goto('/#account');
    await connectPhantom(page);
    await page.getByTestId('open-account').click();
    await expect(page.getByTestId('accounts-message')).toContainText('is open');
    await expect(page.getByTestId('account-check')).toHaveAttribute('data-state', 'ok');
    expect(indexer.queries).toContain('deploytx');
    await page.reload();
    await connectPhantom(page);
    await expect(page.getByTestId('account-check')).toHaveAttribute('data-state', 'ok');
  });

  test('no deploy shown at all yet: the opening waits for it instead of judging the account as it is now', async ({
    page,
  }) => {
    const { relay, indexer } = await setup(page);
    indexer.tamper = { originUnknown: true };
    relay.depositAfterDeploy = true;
    await page.goto('/#account');
    await connectPhantom(page);
    await page.getByTestId('open-account').click();
    await expect.poll(() => indexer.queries.filter((q) => q === `origin:${ACCOUNT}`).length).toBeGreaterThan(1);
    await expect(page.getByTestId('accounts-message')).toHaveCount(0); // still waiting, not refused
    indexer.tamper = {}; // the indexer catches up
    await expect(page.getByTestId('accounts-message')).toContainText('is open', { timeout: 20_000 });
    await expect(page.getByTestId('account-check')).toHaveAttribute('data-state', 'ok');
    const kept = await page.evaluate(() =>
      Object.keys(localStorage)
        .filter((k) => k.endsWith('/account'))
        .map((k) => localStorage.getItem(k) ?? '')
        .join('\n'),
    );
    expect(kept).not.toContain('refusedAtOpen');
  });
});

test.describe('R3-9: the restore says what it does before Phantom opens', () => {
  test('plain words first (this browser’s key back, no funds moved); Phantom only after Continue', async ({ page }) => {
    const { relay, phantom } = await setup(page, { seeded: true });
    const mine = relay.encKey!;
    relay.encKey = 'e1'.repeat(32); // a page changed the account's key
    await page.goto('/#account');
    await connectPhantom(page);
    await page.getByTestId('restore-key').click();
    const dialog = page.getByTestId('restore-explain');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('sets the key back to the one this browser holds');
    await expect(dialog).toContainText('It never moves funds');
    await expect(dialog).toContainText(`New key ${mine.slice(0, 16)}`);
    expect(phantom.requests).toHaveLength(0); // nothing asked of the wallet yet
    await page.getByTestId('restore-cancel').click();
    await expect(dialog).toHaveCount(0);
    expect(phantom.requests).toHaveLength(0);
    expect(relay.submitted).toHaveLength(0);
    await page.getByTestId('restore-key').click();
    await page.getByTestId('restore-continue').click();
    await expect(page.getByTestId('accounts-message')).toContainText('Your encryption key is restored');
    expect(phantom.requests).toHaveLength(1);
    expect(relay.encKey).toBe(mine);
  });
});

test.describe('Q46: the withdrawal allowance is explained only once it is used up', () => {
  test('refused for the allowance: plain words, then the whole-coin exit withdraws the entire coin', async ({
    page,
  }) => {
    const { relay, phantom } = await setup(page, { seeded: true });
    await page.goto('/#account');
    await connectPhantom(page);
    await expect(portfolioRow(page, 'twUSDC')).toContainText('1,000.00');
    // Before any refusal the page says nothing about an allowance.
    const text = await page.locator('body').innerText();
    expect(text).not.toMatch(/limited number of withdrawals|whole coin|allowance/i);
    await page.getByTestId('withdraw-kind-shielded').click();
    await page.getByTestId('send-token').selectOption(COLOUR.twUSDC);
    await page.getByTestId('send-amount').fill('100');
    await page.getByTestId('send-recipient').fill(WALLET);
    relay.refuseNext = {
      status: 429,
      code: 'withdraws-daily-cap',
      message: 'this account has used its 100 sponsored withdrawals in the last 24 hours',
      detail: 'whole-coin-exit',
      retryAfter: 7200,
    };
    await page.getByTestId('send-submit').click();
    await expect(page.getByTestId('accounts-message')).toContainText(
      'The market pays the network fee for a limited number of withdrawals per account each day',
    );
    await expect(page.getByTestId('accounts-message')).toContainText(
      'You can still withdraw one whole coin of this token today',
    );
    await expect(page.getByTestId('accounts-message')).toContainText('about 2 hours');
    const exit = page.getByTestId('whole-coin-exit');
    await expect(exit).toContainText('one whole coin of twUSDC');
    await expect(exit.getByTestId('whole-coin-exit-amount')).toHaveAttribute('data-raw', '1000000000');
    await exit.getByTestId('whole-coin-exit-coin').click();
    await expect(page.getByTestId('accounts-message')).toContainText('Sent');
    // The exit: the WHOLE coin, no change.
    expect(relay.refused).toEqual(['withdraw: withdraws-daily-cap']);
    expect(relay.submitted.map((s) => [s.action, s.verified])).toEqual([['withdraw', 'ok']]);
    const p = relay.submitted[0]!.body.payload as { amount: string; coin: { value: string } };
    expect(p.amount).toBe('1000000000');
    expect(p.coin.value).toBe('1000000000');
    expect(phantom.requests).toHaveLength(2); // the refused one, and the exit
    await expect(page.getByTestId('whole-coin-exit')).toHaveCount(0);
  });

  test('the token’s exit already used: says when, offers nothing', async ({ page }) => {
    const { relay } = await setup(page, { seeded: true });
    await page.goto('/#account');
    await connectPhantom(page);
    await page.getByTestId('withdraw-kind-unshielded').click();
    await page.getByTestId('wu-amount').fill('5');
    await page.getByTestId('wu-recipient').fill(formatUnshieldedAddress('66'.repeat(32), 'stagenet'));
    relay.refuseNext = {
      status: 429,
      code: 'withdraws-daily-cap',
      message: 'used',
      detail: 'whole-coin-exit-used',
      retryAfter: 600,
    };
    await page.getByTestId('wu-submit').click();
    await expect(page.getByTestId('accounts-message')).toContainText(
      'its one extra withdrawal of this token today as well',
    );
    await expect(page.getByTestId('accounts-message')).toContainText('You can withdraw again in 10 minutes');
    await expect(page.getByTestId('whole-coin-exit')).toHaveCount(0);
    // A private-token withdrawal refused the same way: no exit offered either.
    await page.getByTestId('withdraw-kind-shielded').click();
    await page.getByTestId('send-token').selectOption(COLOUR.twUSDC);
    await page.getByTestId('send-amount').fill('100');
    await page.getByTestId('send-recipient').fill(WALLET);
    relay.refuseNext = {
      status: 429,
      code: 'withdraws-daily-cap',
      message: 'used',
      detail: 'whole-coin-exit-used',
      retryAfter: 600,
    };
    await page.getByTestId('send-submit').click();
    await expect(page.getByTestId('accounts-message')).toContainText(
      'its one extra withdrawal of this token today as well',
    );
    await expect(page.getByTestId('whole-coin-exit')).toHaveCount(0);
    expect(relay.refused).toEqual(['withdraw-unshielded: withdraws-daily-cap', 'withdraw: withdraws-daily-cap']);
  });
});
