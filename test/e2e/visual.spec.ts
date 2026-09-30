// Plan P1.5 testing: the visual smoke of the Night Market design. Every page at 1280 px and at 375 px
// (a touch phone), with:
//   - a screenshot per page (saved under $VISUAL_OUT_DIR, default test-results/visual);
//   - no horizontal page scroll, and no element wider than the page outside its own scroll box;
//   - every button at least 44 px tall on the phone (and every full-size button on desktop);
//   - the self-hosted fonts loaded from the page's own origin, and nothing else left it;
//   - a clean fallback when the font files cannot load (Georgia / the system sans);
//   - no gradients or glass effects, and motion off under prefers-reduced-motion.
// The contrast of the colour tokens is checked by web/test/design-contrast.test.ts.

import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { expect, test, type Page } from '@playwright/test';

import { healthBody } from './errors-fixtures.js';
import { customerRecords, seedRecords, serveExchange } from './visual-fixtures.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
const OUT = process.env.VISUAL_OUT_DIR ?? `${root}/test-results/visual`;
mkdirSync(OUT, { recursive: true });

const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 900, touch: false },
  { name: 'phone375', width: 375, height: 812, touch: true },
] as const;

/** Layout checks that must hold on every page, at every width. */
async function assertLayout(page: Page, touch: boolean) {
  const r = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const scrollBox = (el: Element | null): boolean => {
      for (let p = el?.parentElement ?? null; p; p = p.parentElement) {
        const o = getComputedStyle(p).overflowX;
        if (o === 'auto' || o === 'scroll' || o === 'hidden' || o === 'clip') return true;
      }
      return false;
    };
    const wide: string[] = [];
    for (const el of Array.from(document.body.querySelectorAll('*'))) {
      const b = el.getBoundingClientRect();
      if (b.width === 0 || b.height === 0) continue;
      if (el.closest('dialog:not([open])')) continue;
      if ((b.right > vw + 0.5 || b.left < -0.5) && !scrollBox(el))
        wide.push(
          `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 40)} ${Math.round(b.left)}–${Math.round(b.right)}`,
        );
    }
    const buttons = Array.from(document.querySelectorAll<HTMLElement>('button, a.btn'))
      .filter((b) => b.getBoundingClientRect().height > 0 && !b.closest('.hash') && !b.classList.contains('btn-link'))
      .map((b) => ({
        text: (b.textContent ?? '').trim().slice(0, 30),
        h: b.getBoundingClientRect().height,
        small: b.classList.contains('btn-small'),
      }));
    const styled = Array.from(document.querySelectorAll('*')).map((el) => getComputedStyle(el));
    return {
      scrollWidth: document.documentElement.scrollWidth,
      vw,
      wide,
      buttons,
      gradients: styled.filter((s) => s.backgroundImage.includes('gradient')).length,
      glass: styled.filter((s) => s.backdropFilter && s.backdropFilter !== 'none').length,
    };
  });
  expect(r.wide, 'no element wider than the page').toEqual([]);
  expect(r.scrollWidth, 'no horizontal page scroll').toBeLessThanOrEqual(r.vw);
  for (const b of r.buttons) {
    if (touch || !b.small) expect(b.h, `button "${b.text}" is at least 44 px tall`).toBeGreaterThanOrEqual(44);
  }
  expect(r.gradients, 'no gradients').toBe(0);
  expect(r.glass, 'no glass effects').toBe(0);
}

async function shot(page: Page, name: string, fullPage = true) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage, animations: 'disabled' });
}

for (const vp of VIEWPORTS) {
  test.describe(`visual at ${vp.width} px`, () => {
    test.use({
      viewport: { width: vp.width, height: vp.height },
      hasTouch: vp.touch,
      isMobile: vp.touch,
      deviceScaleFactor: vp.touch ? 2 : 1,
    });

    test('Account before a wallet connects', async ({ page }) => {
      const ex = await serveExchange(page);
      await page.goto('/#account');
      await expect(page.getByTestId('connect')).toBeVisible();
      await expect(page.getByTestId('account-connect')).toBeVisible();
      await assertLayout(page, vp.touch);
      await shot(page, `${vp.name}-account-disconnected`);
      expect(ex.external).toEqual([]);
    });

    test('the Connect menu (no Solana wallet adapter yet)', async ({ page }) => {
      await serveExchange(page);
      await page.goto('/#markets');
      await page.getByTestId('connect').click();
      await expect(page.getByTestId('wallet-unsupported')).toBeVisible();
      await assertLayout(page, vp.touch);
      await shot(page, `${vp.name}-connect-menu`, false);
    });

    test('Markets with a book open', async ({ page }) => {
      await serveExchange(page);
      await page.goto('/#markets');
      await expect(page.getByTestId('market-feed-status')).toHaveAttribute('data-status', 'ready');
      await page.locator('[data-testid=market-row][data-pair="twUSDM/twUSDC"]').getByTestId('open-book').click();
      await expect(page.getByTestId('book')).toBeVisible();
      await assertLayout(page, vp.touch);
      await shot(page, `${vp.name}-markets`);
    });

    test('Markets: a pair of 18- and 8-decimal tokens (twETH/twBTC)', async ({ page }) => {
      await serveExchange(page);
      await page.goto('/#markets');
      await expect(page.getByTestId('market-feed-status')).toHaveAttribute('data-status', 'ready');
      await page.locator('[data-testid=market-row][data-pair="twETH/twBTC"]').getByTestId('open-book').click();
      await expect(page.getByTestId('book')).toHaveAttribute('data-pair', 'twETH/twBTC');
      await assertLayout(page, vp.touch);
      await shot(page, `${vp.name}-markets-eth-btc`);
    });

    test('Markets when the exchange is down', async ({ page }) => {
      await serveExchange(page, { kernelDown: true });
      await page.goto('/#markets');
      await expect(page.getByTestId('exchange-unavailable')).toBeVisible({ timeout: 20_000 });
      await assertLayout(page, vp.touch);
      await shot(page, `${vp.name}-markets-unavailable`);
    });

    test('Local data', async ({ page }) => {
      await serveExchange(page);
      await seedRecords(page, customerRecords().entries);
      await page.goto('/#local');
      await expect(page.locator('[data-testid=record-row]').first()).toBeVisible();
      await assertLayout(page, vp.touch);
      await shot(page, `${vp.name}-local`);
    });

    // Layout checks run before any screenshot: a full-page capture can reset the touch emulation.
    test('Local data: the CLEAR ALL dialog', async ({ page }) => {
      await serveExchange(page);
      await seedRecords(page, customerRecords().entries);
      await page.goto('/#local');
      await expect(page.locator('[data-testid=record-row]').first()).toBeVisible();
      await page.getByTestId('clear-all').click();
      await expect(page.getByTestId('clear-dialog')).toBeVisible();
      await page.getByTestId('clear-confirm-input').fill('CLEAR');
      await expect(page.getByTestId('clear-confirm')).toBeDisabled();
      await assertLayout(page, vp.touch);
      await shot(page, `${vp.name}-local-clear`, false); // a modal: what the viewport shows
      // Escape closes it, as Cancel does, and nothing was cleared.
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('clear-dialog')).toHaveCount(0);
      await expect(page.locator('[data-testid=record-row]').first()).toBeVisible();
    });

    test('Trade before a wallet connects', async ({ page }) => {
      await serveExchange(page);
      await page.goto('/#trade');
      await expect(page.getByTestId('section-trade')).toBeVisible();
      await assertLayout(page, vp.touch);
      await shot(page, `${vp.name}-trade-disconnected`);
    });

    test('an error state: the market low on fee funds (plan P4-A)', async ({ page }) => {
      await serveExchange(page);
      await page.route('**/health', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(healthBody({ dustLow: true })),
        }),
      );
      await page.goto('/#markets');
      await expect(page.getByTestId('market-sponsor-low')).toBeVisible();
      await assertLayout(page, vp.touch);
      await shot(page, `${vp.name}-markets-paused`);
    });
  });
}

test('the fonts are self-hosted, load, and nothing else leaves the page', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', (r) => requests.push(r.url()));
  const ex = await serveExchange(page);
  await page.goto('/#markets');
  await page.evaluate(() => document.fonts.ready);
  const faces = await page.evaluate(() => {
    const out: string[] = [];
    document.fonts.forEach((f) => {
      if (f.status === 'loaded') out.push(`${f.family.replace(/"/g, '')} ${f.weight}`);
    });
    return out;
  });
  expect(faces).toEqual(expect.arrayContaining(['Libre Caslon Text 400', 'Source Sans 3 400', 'Source Sans 3 600']));
  expect(await page.evaluate(() => document.fonts.check('400 16px "Source Sans 3"'))).toBe(true);
  expect(await page.evaluate(() => document.fonts.check('400 22px "Libre Caslon Text"'))).toBe(true);
  const fontFiles = requests.filter((u) => /\.woff2?(\?|$)/.test(u));
  expect(fontFiles.length).toBeGreaterThan(0);
  for (const u of fontFiles) expect(new URL(u).hostname).toBe('127.0.0.1');
  expect(requests.some((u) => /fonts\.(googleapis|gstatic)\.com/.test(u))).toBe(false);
  expect(ex.external.filter((u) => !u.startsWith('https://stagenet.api-zswap.zkdojo.com'))).toEqual([]);
});

test('without the font files the page falls back cleanly', async ({ page }) => {
  await serveExchange(page);
  await page.route(/\.woff2?(\?.*)?$/, (route) => route.abort('failed'));
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/#markets');
  await expect(page.getByRole('heading', { name: 'Night Market' })).toBeVisible();
  await expect(page.getByTestId('market-feed-status')).toHaveAttribute('data-status', 'ready');
  await page.evaluate(() => document.fonts.ready);
  const loaded = await page.evaluate(() => {
    let n = 0;
    document.fonts.forEach((f) => {
      if (f.status === 'loaded') n++;
    });
    return n;
  });
  expect(loaded).toBe(0);
  // The stacks name real fallbacks after the web fonts.
  const families = await page.evaluate(() => ({
    heading: getComputedStyle(document.querySelector('.page-title')!).fontFamily,
    body: getComputedStyle(document.body).fontFamily,
  }));
  expect(families.heading).toMatch(/^"?Libre Caslon Text"?, Georgia/);
  expect(families.body).toMatch(/^"?Source Sans 3"?, /);
  await assertLayout(page, false);
  await shot(page, 'phone375-markets-font-fallback');
});

test('restrained motion, and none under prefers-reduced-motion', async ({ page }) => {
  await serveExchange(page);
  await page.goto('/#account');
  const tab = page.getByTestId('tab-markets');
  expect(await tab.evaluate((el) => getComputedStyle(el).transitionDuration)).toMatch(/^0\.12s/);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await tab.evaluate((el) => getComputedStyle(el).transitionDuration)).toMatch(/^0s/);
});
