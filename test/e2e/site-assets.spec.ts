// Plan 00046 P4.1, carried over: each domain's asset set in the browser. One build serves several
// domains, each with its own config.json: the market domain has no `assets` (stagenet's default:
// every token of the registry), and a partner domain names its own set (here twETH and twBTC).
// The partner link `?assets=` narrows within the domain's set, never beyond it. The exchange is the
// visual tests' fixture (served through page.route: nothing leaves the page's origin). Screenshots
// go to $SITE_ASSETS_OUT_DIR (default test-results/site-assets).

import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { expect, test, type Page } from '@playwright/test';

import { serveExchange } from './visual-fixtures.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
const OUT = process.env.SITE_ASSETS_OUT_DIR ?? `${root}/test-results/site-assets`;
mkdirSync(OUT, { recursive: true });

/** A partner domain's config.json (web/README.md): its own asset set. */
const PARTNER = { network: 'stagenet', relayUrl: '', assets: ['twETH', 'twBTC'] };
const ALL_PAIRS = ['twBTC/twUSDC', 'twETH/twUSDC', 'twUSDM/twUSDC', 'twETH/twBTC'];

test.use({ viewport: { width: 1280, height: 900 } });

const shot = async (page: Page, name: string) => {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true, animations: 'disabled' });
};
const pairs = async (page: Page) => {
  await expect(page.getByTestId('market-feed-status')).toHaveAttribute('data-status', 'ready');
  return page
    .locator('[data-testid=market-row]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-pair') ?? ''));
};

/** The page on one domain: its config.json (none = the build's own) and the exchange. */
async function onDomain(page: Page, config: object | null) {
  const ex = await serveExchange(page);
  if (config) await page.route('**/config.json', (route) => route.fulfill({ json: config }));
  const warnings: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'warning') warnings.push(m.text());
  });
  return { ex, warnings };
}

test('(a) the market domain (no assets): every pair', async ({ page }) => {
  const { ex, warnings } = await onDomain(page, null);
  await page.goto('/#markets');
  expect(await pairs(page)).toEqual(ALL_PAIRS);
  await expect(page.getByTestId('asset-filter-note')).toHaveCount(0);
  await shot(page, 'a-market-default-markets');
  expect(warnings).toEqual([]);
  expect(ex.external).toEqual([]);
});

test('(b) a partner domain (twETH, twBTC): its one market, no twUSDC anywhere', async ({ page }) => {
  const { ex, warnings } = await onDomain(page, PARTNER);
  await page.goto('/#markets');
  expect(await pairs(page)).toEqual(['twETH/twBTC']);
  await expect(page.getByTestId('section-markets')).not.toContainText(/\btwusd[cm]\b/i);
  await expect(page.getByTestId('asset-filter-note')).toHaveCount(0);
  await shot(page, 'b-partner-markets');
  expect(warnings).toEqual([]);
  expect(ex.external).toEqual([]);
});

test('(c) the partner domain with ?assets=twUSDC,twETH: twETH only, no market, twUSDC not on this site', async ({
  page,
}) => {
  await onDomain(page, PARTNER);
  await page.goto('/?assets=twUSDC,twETH#markets');
  await expect(page.getByTestId('asset-filter-note')).toHaveText(
    'Showing only twETH. Not available on this site: twUSDC. Show all assets',
  );
  await expect(page.getByTestId('markets-filtered-empty')).toContainText('Not available on this site: twUSDC.');
  await expect(page.locator('[data-testid=market-row]')).toHaveCount(0);
  await shot(page, 'c-partner-twUSDC-twETH-markets');

  // ?assets=all goes back to the domain's set, never beyond it.
  await page.goto('/?assets=all#markets');
  await expect(page.getByTestId('asset-filter-note')).toHaveCount(0);
  expect(await pairs(page)).toEqual(['twETH/twBTC']);
});

test('a typo in the domain set is ignored, with a console warning; "all" shows every pair', async ({ page }) => {
  const { warnings } = await onDomain(page, { ...PARTNER, assets: ['twETH', 'twBTX', 'twBTC'] });
  await page.goto('/#markets');
  expect(await pairs(page)).toEqual(['twETH/twBTC']);
  expect(warnings).toEqual(['Night Market: config.json "assets": ignoring unknown assets: twBTX']);

  await page.unroute('**/config.json');
  await page.route('**/config.json', (route) => route.fulfill({ json: { ...PARTNER, assets: 'all' } }));
  await page.reload();
  expect(await pairs(page)).toEqual(ALL_PAIRS);
});

test('a pair naming an unknown token is left out, with a console warning', async ({ page }) => {
  const { warnings } = await onDomain(page, {
    network: 'stagenet',
    relayUrl: '',
    pairs: ['twETH/twBTC', 'twSOL/twUSDC'],
  });
  await page.goto('/#markets');
  expect(await pairs(page)).toEqual(['twETH/twBTC']);
  expect(warnings.length).toBeGreaterThan(0);
  expect(warnings.every((w) => w.startsWith('Night Market: '))).toBe(true);
  expect(warnings.join('\n')).toContain('twSOL/twUSDC');
});
