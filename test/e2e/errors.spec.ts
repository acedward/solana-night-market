// Plan P4-A, carried over: error-state walkthroughs in the browser, against a mocked relay (its
// /health) and the mocked exchange of the visual fixtures. Each state shows a clear, specific
// message on every page:
//
//   the market's relay unreachable · its fee wallet (DUST) low or still syncing · its prover down ·
//   local storage full.
//
// The wallet's own error states (a Ledger account, a declined or locked wallet, no answer, another
// key) are in ./wallet.spec.ts, with the mock Phantom.

import { expect, test, type Page, type Route } from '@playwright/test';

import { healthBody } from './errors-fixtures.js';
import { serveExchange } from './visual-fixtures.js';

const json = (route: Route, status: number, body: unknown) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function serveHealth(page: Page, opts: Parameters<typeof healthBody>[0] = {}) {
  await page.route('**/health', (route) => json(route, opts.proverDown ? 503 : 200, healthBody(opts)));
}

test.describe('the market itself', () => {
  test('healthy: no notice', async ({ page }) => {
    await serveExchange(page);
    await serveHealth(page);
    await page.goto('/#markets');
    await expect(page.getByTestId('market-feed-status')).toHaveAttribute('data-status', 'ready');
    await page.waitForTimeout(500);
    for (const id of ['relay-down', 'prover-down', 'sponsor-low', 'sponsor-syncing'])
      await expect(page.getByTestId(`market-${id}`)).toHaveCount(0);
  });

  test('its relay unreachable: every page says so, and the records are safe', async ({ page }) => {
    await serveExchange(page);
    await page.route('**/health', (route) => route.abort('connectionrefused'));
    await page.goto('/#markets');
    const notice = page.getByTestId('market-relay-down');
    await expect(notice).toContainText("The market's server cannot be reached.");
    await expect(notice).toContainText('records in this browser are safe');
    for (const tab of ['trade', 'account', 'local']) {
      await page.getByTestId(`tab-${tab}`).click();
      await expect(notice).toBeVisible();
    }
  });

  test('its fee wallet low on DUST: new actions pause, with the reason', async ({ page }) => {
    await serveExchange(page);
    await serveHealth(page, { dustLow: true });
    await page.goto('/#account');
    await expect(page.getByTestId('market-sponsor-low')).toContainText('The market is low on network-fee funds.');
    await expect(page.getByTestId('market-sponsor-low')).toContainText('Your balances are safe');
  });

  test('its fee wallet still syncing', async ({ page }) => {
    await serveExchange(page);
    await serveHealth(page, { syncing: true });
    await page.goto('/#account');
    await expect(page.getByTestId('market-sponsor-syncing')).toContainText("The market's fee wallet is starting up.");
  });

  test('its prover down', async ({ page }) => {
    await serveExchange(page);
    await serveHealth(page, { proverDown: true });
    await page.goto('/#trade');
    await expect(page.getByTestId('market-prover-down')).toContainText("The market's prover is not available.");
  });
});

test.describe('the browser', () => {
  test('local storage full: the page says so', async ({ page }) => {
    await page.addInitScript(() => {
      const setItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key: string, value: string) {
        if (this === window.localStorage) throw new DOMException('quota', 'QuotaExceededError');
        return setItem.call(this, key, value);
      };
    });
    await serveExchange(page);
    await serveHealth(page);
    await page.goto('/#account');
    const banner = page.getByTestId('storage-banner');
    await expect(banner).toHaveAttribute('data-status', 'full');
    await expect(banner).toContainText('This browser has no room left for Night Market’s records.');
    await expect(banner).toContainText('Free some site data');
    await page.goto('/#local');
    await expect(page.getByTestId('storage-blocked')).toHaveAttribute('data-status', 'full');
  });
});
