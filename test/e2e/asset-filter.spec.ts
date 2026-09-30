// Plan 00042 P3.1, carried over: the asset filter in the browser. `?assets=…` is stored, removed
// from the address bar and applied in every view; a market shows only when both of its assets are
// listed, whichever they are (twETH/twBTC has no twUSDC leg and is filtered like any other); a
// reload keeps the list; `?assets=all`, Show all assets and CLEAR ALL bring everything back; a
// token from the site's config (nmGOLD) and its pair are filtered with no code change. The
// exchange is the visual tests' fixture (served through page.route: nothing leaves the page's
// origin). The connected-wallet views (the holdings, the Trade picker) are checked with the mock
// Phantom in ./wallet.spec.ts. Screenshots go to $ASSET_FILTER_OUT_DIR (default test-results/asset-filter).

import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { expect, test, type Page } from '@playwright/test';

import { COLOUR, leg, offerRow, BOOK } from '../../packages/core/test/fixtures/kernel/book.js';
import { serveExchange } from './visual-fixtures.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
const OUT = process.env.ASSET_FILTER_OUT_DIR ?? `${root}/test-results/asset-filter`;
mkdirSync(OUT, { recursive: true });

const FILTER_KEY = 'night-market/v1/_global/settings/asset-filter';
const ALL_PAIRS = ['twBTC/twUSDC', 'twETH/twUSDC', 'twUSDM/twUSDC', 'twETH/twBTC'];

test.use({ viewport: { width: 1280, height: 900 } });

const shot = async (page: Page, name: string) => {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true, animations: 'disabled' });
};
const stored = (page: Page) => page.evaluate((k) => localStorage.getItem(k), FILTER_KEY);
const pairs = async (page: Page) => {
  await expect(page.getByTestId('market-feed-status')).toHaveAttribute('data-status', 'ready');
  return page
    .locator('[data-testid=market-row]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-pair') ?? ''));
};
const openTab = async (page: Page, id: string) => {
  await page.getByTestId(`tab-${id}`).click();
  await expect(page.getByTestId(`section-${id}`)).toBeVisible();
};

test('no parameter: every pair shows, and nothing is stored', async ({ page }) => {
  const ex = await serveExchange(page);
  await page.goto('/#markets');
  expect(await pairs(page)).toEqual(ALL_PAIRS);
  await expect(page.getByTestId('asset-filter-note')).toHaveCount(0);
  expect(await stored(page)).toBeNull();
  await shot(page, '01-no-filter-markets');
  expect(ex.external).toEqual([]);
});

test('?assets=twBTC,twUSDC: only their market; stored, gone from the address bar; a reload keeps it', async ({
  page,
}) => {
  const ex = await serveExchange(page);
  await page.goto('/?assets=twBTC,twUSDC#markets');
  await expect(page.getByTestId('asset-filter-note')).toContainText('Showing only twBTC, twUSDC.');
  await expect.poll(() => new URL(page.url()).search).toBe('');
  expect(new URL(page.url()).hash).toBe('#markets');
  expect(JSON.parse((await stored(page))!)).toMatchObject({
    kind: 'settings',
    data: { assets: ['twBTC', 'twUSDC'] },
  });
  expect(await pairs(page)).toEqual(['twBTC/twUSDC']);
  await expect(page.getByTestId('section-markets')).not.toContainText(/\btw(eth|usdm)\b/i);
  await shot(page, '02-twBTC-twUSDC-markets');

  // A reload, with no parameter: the same view.
  await page.reload();
  await expect(page.getByTestId('asset-filter-note')).toContainText('Showing only twBTC, twUSDC.');
  expect(await pairs(page)).toEqual(['twBTC/twUSDC']);
  expect(ex.external).toEqual([]);
});

test('?assets=twETH,twBTC: the pair without twUSDC, filtered like any other', async ({ page }) => {
  await serveExchange(page);
  await page.goto('/?assets=twETH,twBTC#markets');
  await expect(page.getByTestId('asset-filter-note')).toContainText('Showing only twETH, twBTC.');
  expect(await pairs(page)).toEqual(['twETH/twBTC']);
  await expect(page.getByTestId('section-markets')).not.toContainText(/\btwusd[cm]\b/i);
  await shot(page, '03-twETH-twBTC-markets');
});

test('?assets=twUSDC: no market has both tokens listed; Markets and Trade say so', async ({ page }) => {
  await serveExchange(page);
  await page.goto('/?assets=twUSDC#markets');
  await expect(page.getByTestId('asset-filter-note')).toContainText('Showing only twUSDC.');
  await expect(page.getByTestId('markets-filtered-empty')).toBeVisible();
  await expect(page.locator('[data-testid=market-row]')).toHaveCount(0);
  await openTab(page, 'trade');
  await expect(page.getByTestId('trade-filtered-empty')).toContainText(
    'A market shows only when both of its tokens are listed.',
  );
});

test('a token and a pair from the config (nmGOLD/twUSDC): filtered with no code change', async ({ page }) => {
  const GOLD = 'f7'.repeat(32);
  await serveExchange(page, {
    book: [...BOOK, offerRow(31, [leg(GOLD, 1_000)], [leg(COLOUR.twUSDC, 2_500_000_000)])], // ask 10.00 nmGOLD @ 250
  });
  await page.route('**/config.json', (route) =>
    route.fulfill({
      json: {
        network: 'stagenet',
        relayUrl: '',
        // The site config's extra tokens (added to the built-in list) and its pairs, as a
        // deployment would set them: data, no token special.
        tokens: { tokens: [{ symbol: 'nmGOLD', name: 'Night Market gold', decimals: 2, midnightColour: GOLD }] },
        pairs: ['nmGOLD/twUSDC', 'twBTC/twUSDC', 'twETH/twBTC'],
      },
    }),
  );
  await page.goto('/#markets');
  expect(await pairs(page)).toEqual(['nmGOLD/twUSDC', 'twBTC/twUSDC', 'twETH/twBTC']);
  await expect(page.locator('[data-testid=market-row][data-pair="nmGOLD/twUSDC"]').getByTestId('best-ask')).toHaveText(
    '250.00',
  );
  await page.goto('/?assets=twUSDC,nmGOLD#markets');
  await expect(page.getByTestId('asset-filter-note')).toHaveText('Showing only twUSDC, nmGOLD. Show all assets');
  expect(await pairs(page)).toEqual(['nmGOLD/twUSDC']);
  await shot(page, '04-config-nmGOLD-markets');
});

test('an unknown list shows everything; ?assets=all, Show all assets and CLEAR ALL clear it', async ({ page }) => {
  await serveExchange(page);
  // Nothing known: everything shows, and the note says why.
  await page.goto('/?assets=EURC#markets');
  await expect(page.getByTestId('asset-filter-note')).toContainText(
    'None of the listed assets is on this site, so every asset is shown. Not on this site yet: EURC.',
  );
  expect(await pairs(page)).toEqual(ALL_PAIRS);

  // ?assets=all.
  await page.goto('/?assets=twBTC,twUSDC#markets');
  expect(await pairs(page)).toEqual(['twBTC/twUSDC']);
  await page.goto('/?assets=all#markets');
  expect(await pairs(page)).toEqual(ALL_PAIRS);
  await expect(page.getByTestId('asset-filter-note')).toHaveCount(0);
  expect(await stored(page)).toBeNull();
  await expect.poll(() => new URL(page.url()).search).toBe('');

  // Show all assets, in Local data (with the note that it is not a security setting).
  await page.goto('/?assets=twBTC,twUSDC#local');
  await expect(page.getByTestId('asset-filter-panel')).toContainText('?assets=twBTC,twUSDC');
  await expect(page.getByTestId('asset-filter-disclaimer')).toHaveText(
    'This only changes what this page shows; it is not a security setting.',
  );
  await shot(page, '05-local-data-filter');
  await page.getByTestId('asset-filter-clear').click();
  await expect(page.getByTestId('asset-filter-panel')).toHaveCount(0);
  await expect(page.getByTestId('asset-filter-note')).toHaveCount(0);
  expect(await stored(page)).toBeNull();

  // The header note's Show all assets.
  await page.goto('/?assets=twUSDC#markets');
  await expect(page.locator('[data-testid=market-row]')).toHaveCount(0);
  await page.getByTestId('asset-filter-show-all').click();
  expect(await pairs(page)).toEqual(ALL_PAIRS);
  expect(await stored(page)).toBeNull();

  // CLEAR ALL.
  await page.goto('/?assets=twUSDC#local');
  await page.getByTestId('clear-all').click();
  await page.getByTestId('clear-confirm-input').fill('CLEAR ALL');
  await page.getByTestId('clear-confirm').click();
  await expect(page.getByTestId('asset-filter-note')).toHaveCount(0);
  expect(await stored(page)).toBeNull();
  await openTab(page, 'markets');
  expect(await pairs(page)).toEqual(ALL_PAIRS);
});
