// Plan P1 testing, carried over: the Playwright smoke. The Night Market shell renders with its
// four sections and no trace of an EVM wallet; until lane B2 ships the Phantom adapter, the Connect
// menu, Account and Trade say that Solana wallets are coming; Local data shows another tab's
// records, masks the encryption secret until revealed, and CLEAR ALL (behind the typed phrase)
// leaves nothing. Export and Import need a connected wallet: lane B2 tests them with a mock Phantom.

import { expect, test, type Page } from '@playwright/test';

import { customerRecords, serveExchange } from './visual-fixtures.js';

const SECTIONS = ['markets', 'trade', 'account', 'local'];

/** Every key the market keeps in this browser, with its value. */
const marketKeys = (page: Page) =>
  page.evaluate(() => {
    const out: Record<string, string> = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)!;
      if (k.startsWith('night-market/')) out[k] = localStorage.getItem(k)!;
    }
    return out;
  });

test('the shell, the Solana wallet placeholder, and Local data with another tab’s records', async ({
  page,
  context,
}) => {
  const ex = await serveExchange(page);
  await page.goto('/');

  // The shell renders: the brand, the sections (order books first), the network.
  await expect(page).toHaveTitle('Night Market');
  await expect(page.getByRole('heading', { name: 'Night Market' })).toBeVisible();
  for (const s of SECTIONS) await expect(page.getByTestId(`tab-${s}`)).toBeVisible();
  await expect(page.getByTestId('tab-transfers')).toHaveCount(0);
  await expect(page.getByTestId('network-name')).toContainText('stagenet');
  await expect(page.locator('body')).not.toContainText(/sepolia|ethereum|metamask|\bevm\b|MN Bank/i);

  // Connect: no wallet adapter in this build yet, and the menu says so.
  await page.getByTestId('connect').click();
  await expect(page.getByTestId('wallet-menu')).toBeVisible();
  await expect(page.getByTestId('wallet-unsupported')).toContainText('Solana wallets (Phantom) are coming');
  await page.getByTestId('tab-account').click();
  await expect(page.getByTestId('account-connect')).toContainText('controlled by a Solana wallet (Phantom)');
  await page.getByTestId('tab-trade').click();
  await expect(page.getByTestId('trade-connect')).toContainText('Trading with a Solana wallet is coming');

  // Another tab writes a wallet's records; this tab follows (storage events).
  await page.getByTestId('tab-local').click();
  await expect(page.getByTestId('records-empty')).toBeVisible();
  const { entries, secret } = customerRecords();
  const other = await context.newPage();
  await other.goto('/');
  await other.evaluate((pairs) => {
    for (const [k, v] of pairs) localStorage.setItem(k, v);
  }, entries);
  await other.close();
  await expect(page.locator('[data-testid=record-row]')).toHaveCount(4);
  expect(Object.keys(await marketKeys(page))).toHaveLength(5); // 4 records + the schema marker

  // The secret is masked until revealed.
  const secretRow = page.locator('[data-testid=record-row][data-kind=secret]');
  await expect(secretRow.getByTestId('record-masked')).toBeVisible();
  await expect(page.getByTestId('records')).not.toContainText(secret);
  await secretRow.getByTestId('reveal').click();
  await expect(secretRow.getByTestId('record-value')).toContainText(secret);
  await secretRow.getByTestId('reveal').click();
  await expect(page.getByTestId('records')).not.toContainText(secret);

  // Export and Import wait for a connected wallet.
  await expect(page.getByTestId('export')).toBeDisabled();
  await expect(page.getByTestId('import')).toBeDisabled();

  // CLEAR ALL needs the typed phrase, and leaves nothing.
  await page.getByTestId('clear-all').click();
  await expect(page.getByTestId('clear-dialog')).toBeVisible();
  await page.getByTestId('clear-confirm-input').fill('clear all');
  await expect(page.getByTestId('clear-confirm')).toBeDisabled();
  await page.getByTestId('clear-confirm-input').fill('CLEAR ALL');
  await page.getByTestId('clear-confirm').click();
  await expect(page.getByTestId('records-empty')).toBeVisible();
  expect(await marketKeys(page)).toEqual({}); // SC-005: no dApp key remains
  expect(ex.external).toEqual([]);
});

test('says so when the browser blocks storage', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('denied', 'SecurityError');
      },
    });
  });
  await page.goto('/#local');
  await expect(page.getByTestId('storage-banner')).toBeVisible();
  await expect(page.getByTestId('storage-blocked')).toBeVisible();
  await expect(page.getByTestId('export')).toBeDisabled();
});
