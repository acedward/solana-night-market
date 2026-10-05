// AA 00060 P6 (spec US2; T6.3 and the signing panel's landing-key kind, in the browser): "Bridge out to
// Solana" on the Portfolio page, with the mock wallet, a seeded account holding a bridged X coin, and the
// mock relay. The whole bridge-out (tx1, the computed landing coin, the lock) runs on the local stack
// (test/gates/landing GATE=t65, plan T6.5); here, what the page does BEFORE anything is sent:
//   - only bridged holdings are offered, an amount above the largest coin is refused before the wallet;
//   - the confirmation says what happens (two signatures of the same landing-key text, one approval);
//     Cancel asks the wallet nothing;
//   - Bridge out first asks the wallet for the landing-key text (the signing panel says it is asked
//     twice); declining stops everything: no withdrawal reaches the market.

import { expect, test } from '@playwright/test';

import { LANDING_KEY_FIRST_LINE } from '../../packages/core/src/bridge/landing-key.js';
import { X, bridgeSite, openPortfolio } from './bridge-fixtures.js';

const text = (b: Uint8Array) => String.fromCharCode(...b);

async function withX(page: Parameters<typeof bridgeSite>[0]) {
  const s = await bridgeSite(page);
  // The account holds 7 X (6 decimals) in one coin.
  await s.relay.deposit([{ nonce: '9a'.repeat(32), color: X.colour, value: 7_000_000n }]);
  await openPortfolio(page);
  await expect(page.getByTestId('bridge-out-section')).toBeVisible();
  return s;
}

test('only bridged holdings; too much is refused before the wallet; the confirmation; Cancel asks nothing', async ({
  page,
}) => {
  const s = await withX(page);
  await expect(page.getByTestId('bridge-out-token').locator('option')).toHaveText(['X']);
  await page.getByTestId('bridge-out-amount').fill('8');
  await page.getByTestId('bridge-out-review').click();
  await expect(page.getByTestId('bridge-out-error')).toContainText('the most you can send now is 7 X');
  await page.getByTestId('bridge-out-amount').fill('5');
  await page.getByTestId('bridge-out-review').click();
  const confirm = page.getByTestId('bridge-out-confirm');
  await expect(confirm).toContainText('Two signatures of the same landing-key text');
  await expect(confirm).toContainText('One approval');
  await expect(confirm).toContainText('5 X');
  await expect(confirm).toContainText(s.wallet.address);
  await page.getByTestId('bridge-out-cancel').click();
  await expect(confirm).toHaveCount(0);
  expect(s.wallet.requests).toHaveLength(0);
  expect(s.relay.submitted).toHaveLength(0);
});

test('Bridge out asks for the landing-key text first (twice, said so); declining stops everything', async ({
  page,
}) => {
  const s = await withX(page);
  await page.getByTestId('bridge-out-amount').fill('5');
  await page.getByTestId('bridge-out-review').click();
  const release = s.wallet.holdNext();
  await page.getByTestId('bridge-out-send').click();
  await expect(page.getByTestId('sign-prompt-kind')).toHaveAttribute('data-kind', 'landing-key');
  await expect(page.getByTestId('sign-prompt-kind')).toContainText('asks you twice');
  await expect(page.getByTestId('sign-prompt-text')).toContainText(LANDING_KEY_FIRST_LINE);
  await expect.poll(() => s.wallet.requests.length).toBe(1);
  const asked = text(s.wallet.requests[0]!.bytes).split('\n');
  expect(asked[0]).toBe(LANDING_KEY_FIRST_LINE);
  expect(asked).toContain(`Key: ${s.wallet.address}`);
  // The customer declines in the wallet.
  s.wallet.mode = 'reject';
  release();
  await expect(page.getByTestId('bridge-out-error')).toBeVisible();
  await page.waitForTimeout(500);
  expect(s.wallet.requests).toHaveLength(1);
  expect(s.relay.submitted.map((x) => x.action)).not.toContain('withdraw');
  await expect(page.getByTestId('bridge-out-record')).toHaveCount(0);
});

// AA 00060 P10.3 C8 (F-A5): the landing key does not change: one leaked signature opens every future
// Bridge out of this wallet on this site. The confirmation and the wallet panel say so.
test('C8: the confirmation and the wallet panel say the landing key is permanent for this site, network and wallet', async ({
  page,
}) => {
  const s = await withX(page);
  await page.getByTestId('bridge-out-amount').fill('5');
  await page.getByTestId('bridge-out-review').click();
  await expect(page.getByTestId('bridge-out-confirm')).toContainText(
    'every future Bridge out from this wallet on this site',
  );
  const release = s.wallet.holdNext();
  await page.getByTestId('bridge-out-send').click();
  await expect(page.getByTestId('sign-prompt-kind')).toContainText('permanent');
  s.wallet.mode = 'reject';
  release();
  await expect(page.getByTestId('bridge-out-error')).toBeVisible();
});
