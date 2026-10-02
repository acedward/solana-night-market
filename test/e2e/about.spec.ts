// AA 00047 P11.D (questions Q48 A, Q58): the About page. The footer links it from every page; it
// opens at the top, keeps the header's four sections (none of them current), and lists the known
// limitations in plain words (the README's "Known limitations"). It names no withdrawal allowance
// (the owner's decision Q46: the page explains it only once a customer reaches it). axe finds no
// violation at a 1440 px desktop and a 390 px phone, and the page never scrolls sideways. A link
// straight to /#about opens it too. Nothing leaves the page's origin.

import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { serveExchange } from './visual-fixtures.js';

const SECTIONS = ['markets', 'trade', 'account', 'local'];
const LIMITS = [
  'refused-account',
  'key-change',
  'withdraw-key',
  'indexer',
  'long-history',
  'sign-in',
  'fees',
  'busy-prover',
  'busy-takes',
  'exchange-limit',
  'stuck-offer',
  'take-label',
  'restarts',
  'demo-tokens',
  'one-offer',
  'your-data',
];

const VIEWPORTS = [
  { width: 1440, height: 900, touch: false },
  { width: 390, height: 844, touch: true },
] as const;

for (const vp of VIEWPORTS) {
  test.describe(`About at ${vp.width} px`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height }, hasTouch: vp.touch, isMobile: vp.touch });

    test('the footer opens it at the top, with every known limitation, and axe finds nothing', async ({ page }) => {
      const ex = await serveExchange(page);
      await page.goto('/#markets');
      await expect(page.getByTestId('market-feed-status')).toHaveAttribute('data-status', 'ready');

      // From the footer, at the bottom of the page.
      const link = page.getByTestId('about-link');
      await link.scrollIntoViewIfNeeded();
      await link.click();
      await expect(page).toHaveURL(/#about$/);
      await expect(page.getByRole('heading', { name: 'About Night Market', level: 2 })).toBeVisible();
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);

      // The header keeps its four sections, and none is current.
      for (const s of SECTIONS) {
        await expect(page.getByTestId(`tab-${s}`)).toBeVisible();
        await expect(page.getByTestId(`tab-${s}`)).not.toHaveAttribute('aria-current', 'page');
      }

      // The test network, how it works, and the limitations.
      await expect(page.getByTestId('about-testnet')).toContainText('Midnight stagenet, a test network');
      await expect(page.getByTestId('about-how').locator('li')).toHaveCount(3);
      await expect(page.getByTestId('about-limit')).toHaveCount(LIMITS.length);
      expect(
        await page.getByTestId('about-limit').evaluateAll((els) => els.map((e) => e.getAttribute('data-limit'))),
      ).toEqual(LIMITS);
      await expect(page.locator('[data-limit=refused-account]')).toContainText('cannot open another account here');
      await expect(page.locator('[data-limit=withdraw-key]')).toContainText('could hide a coin, not take it');
      // AA 00047 P11.F2 (audit round 4b R4b-2, R4b-4): the two limits round 4b left.
      await expect(page.locator('[data-limit=busy-takes]')).toContainText('its prover is busy');
      await expect(page.locator('[data-limit=exchange-limit]')).toContainText('for everyone who uses it');
      // AA 00047 P11.I K.7 (audit round 4c F-A4c-1 / F-B4c-1, F-A4c-2 / F-B4c-2): the two limits round 4c left.
      await expect(page.locator('[data-limit=stuck-offer]')).toContainText('can never be filled');
      await expect(page.locator('[data-limit=take-label]')).toContainText('Only the label is wrong');
      // Q46: no allowance is named before a customer reaches it.
      await expect(page.getByTestId('about')).not.toContainText(/allowance|withdrawals a day|\b100\b/i);

      // No sideways scroll, and axe.
      const w = await page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        vw: document.documentElement.clientWidth,
      }));
      expect(w.scroll, 'no horizontal page scroll').toBeLessThanOrEqual(w.vw);
      await page.evaluate(() => document.fonts.ready);
      const r = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(r.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);

      // Back to a section from the header.
      await page.getByTestId('tab-trade').click();
      await expect(page.getByTestId('about')).toHaveCount(0);
      expect(ex.external).toEqual([]);
    });
  });
}

test('a link straight to /#about opens it', async ({ page }) => {
  const ex = await serveExchange(page);
  await page.goto('/#about');
  await expect(page.getByTestId('about')).toBeVisible();
  await expect(page.getByTestId('about-limit')).toHaveCount(LIMITS.length);
  expect(ex.external).toEqual([]);
});
