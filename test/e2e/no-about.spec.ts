// AA 00060 FR-029 (the owner, 2026-10-05): the site has no About page. The header's sections are the four
// sections and nothing else, nothing on the page links to an About page, and the footer keeps its testnet
// notice without the old "About Night Market and its known limitations" link. The old route /#about opens
// Markets like any unknown route, with its book loaded (no blank screen), whether it is opened directly or
// reached by a hash change. A site that bridges is the same. The known limitations stay in the README and
// deploy/RUNBOOK.md. Nothing leaves the page's origin.

import { expect, test, type Page } from '@playwright/test';

import { bridgeSite } from './bridge-fixtures.js';
import { serveExchange } from './visual-fixtures.js';

const SECTIONS = ['markets', 'trade', 'account', 'local'];

/** No About link anywhere on the page: not in the header's sections, not in the footer, not in a page. */
async function expectNoAbout(page: Page) {
  await expect(page.getByTestId('about-link')).toHaveCount(0);
  await expect(page.locator('a[href="#about"]')).toHaveCount(0);
  await expect(page.getByRole('link', { name: /about/i })).toHaveCount(0);
  await expect(page.getByTestId('about')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: /About Night Market/i })).toHaveCount(0);
  await expect(page.locator('footer')).not.toContainText(/known limitations/i);
}

/** Markets is the page shown: its tab is current, the others are not, and its book has loaded. */
async function expectMarkets(page: Page) {
  await expect(page.getByTestId('tab-markets')).toHaveAttribute('aria-current', 'page');
  for (const s of SECTIONS.filter((x) => x !== 'markets')) {
    await expect(page.getByTestId(`tab-${s}`)).not.toHaveAttribute('aria-current', 'page');
  }
  await expect(page.getByTestId('market-feed-status')).toHaveAttribute('data-status', 'ready');
  await expect(page.getByTestId('market-row').first()).toBeVisible();
}

const VIEWPORTS = [
  { width: 1440, height: 900, touch: false },
  { width: 390, height: 844, touch: true },
] as const;

for (const vp of VIEWPORTS) {
  test.describe(`no About page at ${vp.width} px (FR-029)`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height }, hasTouch: vp.touch, isMobile: vp.touch });

    test('the navigation has no About link, and /#about falls back to Markets', async ({ page }) => {
      const ex = await serveExchange(page);

      // The header's sections are exactly the four, and the footer keeps its testnet notice.
      await page.goto('/#markets');
      await expectMarkets(page);
      const tabs = page.getByRole('navigation', { name: 'Sections' }).getByRole('link');
      expect(await tabs.evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')))).toEqual(
        SECTIONS.map((s) => `tab-${s}`),
      );
      await expect(page.getByTestId('testnet-notice')).toBeVisible();
      for (const s of SECTIONS) {
        await page.getByTestId(`tab-${s}`).click();
        await expect(page.getByTestId(`tab-${s}`)).toHaveAttribute('aria-current', 'page');
        await expectNoAbout(page);
      }

      // The old route, opened directly: Markets, not a blank page.
      await page.goto('/#about');
      await expectMarkets(page);
      await expectNoAbout(page);

      // The old route, reached by a hash change from another section.
      await page.getByTestId('tab-trade').click();
      await expect(page.getByTestId('tab-trade')).toHaveAttribute('aria-current', 'page');
      await page.evaluate(() => {
        window.location.hash = 'about';
      });
      await expectMarkets(page);
      await expectNoAbout(page);

      expect(ex.external).toEqual([]);
    });
  });
}

test('a site that bridges: no About link, and /#about falls back to Markets (FR-029)', async ({ page }) => {
  await bridgeSite(page);
  await page.goto('/#about');
  await expectMarkets(page);
  await expect(page.getByTestId('footer-wallet-bridging')).toBeVisible();
  await expectNoAbout(page);
});
