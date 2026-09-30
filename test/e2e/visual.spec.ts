// Plan P1.5 testing, redone for the dark consumer design (AA 00047 P8.1, spec FR-006b; plan P8
// testing: 390, 768 and 1440 px): the visual smoke of the Night Market design. Every page at 1440 px
// (a desktop), 768 px (a touch tablet) and 390 px (a touch phone), with:
//   - a screenshot per page (saved under $VISUAL_OUT_DIR, default test-results/visual);
//   - no horizontal page scroll, and no element wider than the page outside its own scroll box;
//   - every button at least 44 px tall on touch screens (and every full-size button on desktop);
//   - the self-hosted font (Inter) loaded from the page's own origin, and nothing else left it;
//   - a clean fallback when the font files cannot load (the system sans);
//   - no glass effects (backdrop blur), and motion off under prefers-reduced-motion.
// Gradients are allowed now, on decorative parts only (questions Q20: the brand gradient, the
// primary buttons, the night-sky background); every text colour's contrast, including the labels
// on both ends of the button gradient, is checked by web/test/design-contrast.test.ts.

import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { expect, test, type Page } from '@playwright/test';

import { formatShieldedAddress } from '../../packages/core/src/shielded-address.js';
import { healthBody } from './errors-fixtures.js';
import { installMockPhantom } from './mock-phantom.js';
import { MockRelay, RELAY } from './mock-relay.js';
import { customerRecords, seedRecords, serveExchange } from './visual-fixtures.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
const OUT = process.env.VISUAL_OUT_DIR ?? `${root}/test-results/visual`;
mkdirSync(OUT, { recursive: true });

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900, touch: false },
  { name: 'tablet768', width: 768, height: 1024, touch: true },
  { name: 'phone390', width: 390, height: 844, touch: true },
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
        // To 0.01 px: an element mid-animation can measure 43.99994 from floating-point error.
        h: Math.round(b.getBoundingClientRect().height * 100) / 100,
        small: b.classList.contains('btn-small'),
      }));
    const styled = Array.from(document.querySelectorAll('*')).map((el) => getComputedStyle(el));
    return {
      scrollWidth: document.documentElement.scrollWidth,
      vw,
      wide,
      buttons,
      glass: styled.filter((s) => s.backdropFilter && s.backdropFilter !== 'none').length,
    };
  });
  expect(r.wide, 'no element wider than the page').toEqual([]);
  expect(r.scrollWidth, 'no horizontal page scroll').toBeLessThanOrEqual(r.vw);
  for (const b of r.buttons) {
    if (touch || !b.small) expect(b.h, `button "${b.text}" is at least 44 px tall`).toBeGreaterThanOrEqual(44);
  }
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

    test('the Connect menu (Phantom found)', async ({ page }) => {
      await serveExchange(page);
      await installMockPhantom(page);
      await page.goto('/#markets');
      await page.getByTestId('connect').click();
      await expect(page.getByTestId('wallet-option')).toHaveText(/Phantom/);
      await assertLayout(page, vp.touch);
      await shot(page, `${vp.name}-connect-menu`, false);
    });

    test('Trade and Account with a connected wallet: the books, the forms and the holdings panel', async ({ page }) => {
      await serveExchange(page);
      const phantom = await installMockPhantom(page);
      const relay = new MockRelay();
      await page.route(`${RELAY}/**`, (r) => relay.handle(r));
      await page.route('**/config.json', (r) => r.fulfill({ json: { network: 'stagenet', relayUrl: RELAY } }));
      await page.goto('/#account');
      await page.getByTestId('connect').click();
      await page.getByTestId('wallet-option').click();
      await expect(page.getByTestId('wallet-address')).toBeVisible();
      await page.getByTestId('open-account').click();
      await expect(page.getByTestId('masthead-account')).toBeVisible();
      await page.getByTestId('get-demo-tokens').click();
      await expect(page.getByTestId('demo-message')).toBeVisible();
      await assertLayout(page, vp.touch);
      await shot(page, `${vp.name}-account-connected`);
      await page.getByTestId('tab-trade').click();
      await expect(page.getByTestId('holdings-panel')).toHaveAttribute('data-state', 'account');
      await assertLayout(page, vp.touch);
      await shot(page, `${vp.name}-trade-connected`);
      // The signing panel, while Phantom's window is open.
      const release = phantom.holdNext();
      await page.getByTestId('tab-account').click();
      await page.getByTestId('withdraw-kind-shielded').click();
      await page.getByTestId('send-amount').fill('1');
      await page
        .getByTestId('send-recipient')
        .fill(
          formatShieldedAddress({ coinPublicKey: '44'.repeat(32), encryptionPublicKey: '55'.repeat(32) }, 'stagenet'),
        );
      await page.getByTestId('send-submit').click();
      await expect(page.getByTestId('sign-prompt')).toBeVisible();
      await assertLayout(page, vp.touch);
      await shot(page, `${vp.name}-sign-prompt`, false);
      release();
      await expect(page.getByTestId('sign-prompt')).toHaveCount(0);
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
  // One variable face (weights 100–900), the Latin subset only: the page's text is English.
  expect(faces).toEqual(expect.arrayContaining(['Inter Variable 100 900']));
  expect(await page.evaluate(() => document.fonts.check('400 16px "Inter Variable"'))).toBe(true);
  expect(await page.evaluate(() => document.fonts.check('650 28px "Inter Variable"'))).toBe(true);
  const fontFiles = requests.filter((u) => /\.woff2?(\?|$)/.test(u));
  expect(fontFiles.length).toBeGreaterThan(0);
  for (const u of fontFiles) expect(new URL(u).hostname).toBe('127.0.0.1');
  expect(requests.some((u) => /fonts\.(googleapis|gstatic)\.com/.test(u))).toBe(false);
  expect(ex.external.filter((u) => !u.startsWith('https://stagenet.api-zswap.zkdojo.com'))).toEqual([]);
});

test('without the font files the page falls back cleanly', async ({ page }) => {
  await serveExchange(page);
  await page.route(/\.woff2?(\?.*)?$/, (route) => route.abort('failed'));
  await page.setViewportSize({ width: 390, height: 844 });
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
  // The stack names real fallbacks after the web font.
  const families = await page.evaluate(() => ({
    heading: getComputedStyle(document.querySelector('.page-title')!).fontFamily,
    body: getComputedStyle(document.body).fontFamily,
  }));
  expect(families.heading).toMatch(/^"?Inter Variable"?, Inter, -apple-system/);
  expect(families.body).toMatch(/^"?Inter Variable"?, Inter, -apple-system/);
  await assertLayout(page, false);
  await shot(page, 'phone390-markets-font-fallback');
});

test('restrained motion, and none under prefers-reduced-motion', async ({ page }) => {
  await serveExchange(page);
  await page.goto('/#account');
  const tab = page.getByTestId('tab-markets');
  expect(await tab.evaluate((el) => getComputedStyle(el).transitionDuration)).toMatch(/^0\.12s/);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await tab.evaluate((el) => getComputedStyle(el).transitionDuration)).toMatch(/^0s/);
});
