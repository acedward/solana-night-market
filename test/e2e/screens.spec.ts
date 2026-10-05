// AA 00047 P8.1, P8.2: the design review screens of the dark consumer UI (spec FR-006b), taken with
// the mock Phantom and the mock relay (nothing leaves the page's origin), at a 1440 px desktop and a
// 390 px phone. Each screen also runs the layout checks of ./visual.spec.ts' kind (no horizontal
// scroll). The PNGs go to $SCREENS_OUT_DIR (default test-results/screens):
//
//   <viewport>-01-markets-landing      Markets for a new visitor (the "Start trading" steps)
//   <viewport>-02-trade                Trade, connected, with holdings
//   <viewport>-03-create-offer         the "Create offer" card filled in, with the exact amounts
//   <viewport>-04-signing-approve      the signing modal while Phantom is open (text + fingerprint,
//                                      and, for a make, "nothing goes on-chain")
//   <viewport>-05-offer-preparing      a make after the approval: "Preparing your offer" (the proof)
//   <viewport>-06-offer-listing        a make once proven: "Listed on the market" in progress, no bar
//                                      length (it is not a transaction)
//   <viewport>-07-offer-listed         the offer listed: the toast, the banner and Your offers, each
//                                      saying it is not on-chain and the tokens stay in the account
//   <viewport>-08-take-progress        a take (on-chain): Approve → Market prepares it → Confirmed on
//                                      Midnight, with the bar against the take's usual duration
//   <viewport>-09-portfolio            Portfolio with balances (private and public)
//   <viewport>-10-portfolio-drawer     the portfolio panel beside Trade (the drawer on a phone)
//   <viewport>-11-demo-tokens          a new account's free demo pack, before the claim
//   <viewport>-12-demo-delivered       after the claim: the success toast and the new holdings
//   <viewport>-13-error-toast          a request declined in Phantom: the error toast

import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { expect, test, type Page } from '@playwright/test';

import { connectPhantom } from './mock-phantom.js';
import { serveExchange } from './visual-fixtures.js';
import { openAction } from './portfolio-fixtures.js';
import { setup } from './wallet-fixtures.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
const OUT = process.env.SCREENS_OUT_DIR ?? `${root}/test-results/screens`;
mkdirSync(OUT, { recursive: true });

const VIEWPORTS = [
  { name: 'desktop1440', width: 1440, height: 900, touch: false, scale: 1 },
  { name: 'phone390', width: 390, height: 844, touch: true, scale: 2 },
] as const;

async function noSideScroll(page: Page) {
  const r = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    vw: document.documentElement.clientWidth,
  }));
  expect(r.scroll, 'no horizontal page scroll').toBeLessThanOrEqual(r.vw);
}

async function shot(page: Page, name: string, fullPage: boolean) {
  await page.evaluate(() => document.fonts.ready);
  // Let the finite animations (a toast sliding in, the drawer) end; spinners and skeletons loop.
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => undefined)),
    ),
  );
  await noSideScroll(page);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage, animations: 'disabled' });
}

const pairHash = (pair: string) => `#trade?pair=${encodeURIComponent(pair)}`;

for (const vp of VIEWPORTS) {
  test.describe(`screens at ${vp.width} px`, () => {
    test.use({
      viewport: { width: vp.width, height: vp.height },
      hasTouch: vp.touch,
      isMobile: vp.touch,
      deviceScaleFactor: vp.scale,
    });
    const full = !vp.touch; // a phone's screens are what one screen shows (its tab bar is fixed)

    test('markets, the landing page for a new visitor', async ({ page }) => {
      await serveExchange(page);
      await page.goto('/#markets');
      await expect(page.getByTestId('market-feed-status')).toHaveAttribute('data-status', 'ready');
      await expect(page.getByTestId('holdings-panel')).toHaveAttribute('data-state', 'no-wallet');
      await shot(page, `${vp.name}-01-markets-landing`, full);
    });

    test('trade, create an offer, the signing modal, and the make-offer progress to the listing', async ({ page }) => {
      test.setTimeout(120_000); // it waits on purpose while the relay "proves"
      const { phantom, relay } = await setup(page, { seeded: true });
      // A two-sided market the account can buy on: the book, the spread, and live Buy buttons.
      await page.goto(`/${pairHash('twUSDM/twUSDC')}`);
      await connectPhantom(page);
      await expect(page.locator('[data-testid=holding][data-symbol="twBTC"]')).toContainText('0.10');
      await expect(page.getByTestId('trade-book-asks').getByTestId('take-line').first()).toBeEnabled();
      await shot(page, `${vp.name}-02-trade`, full);

      await page.getByTestId('trade-pair').selectOption('twBTC/twUSDC');
      await page.getByTestId('side-sell').click();
      await page.getByTestId('make-quantity').fill('0.05');
      await page.getByTestId('make-price').fill('61500');
      await expect(page.getByTestId('legs-want')).toContainText('3,075.00 twUSDC');
      await page.getByTestId('make-section').scrollIntoViewIfNeeded();
      if (vp.touch) await page.getByTestId('make-sign').scrollIntoViewIfNeeded();
      await shot(page, `${vp.name}-03-create-offer`, false);

      // Phantom's window is open: the exact text, its fingerprint, and "nothing goes on-chain".
      const releaseSign = phantom.holdNext();
      const hold = relay.holdNextJob();
      await page.getByTestId('make-sign').click();
      await expect(page.getByTestId('sign-prompt')).toBeVisible();
      await expect(page.getByTestId('sign-prompt-text')).toContainText('Swap offer');
      await expect(page.getByTestId('sign-prompt-off-chain')).toContainText('Nothing goes on-chain');
      await shot(page, `${vp.name}-04-signing-approve`, false);

      // Approved: the relay proves (held at "proving"): "Preparing your offer", with a bar.
      releaseSign();
      const progress = page.getByTestId('activity-progress');
      await expect(progress).toBeVisible();
      await expect(page.getByTestId('activity-stage')).toHaveAttribute('data-stage', 'proving');
      await expect(progress.locator('[data-step-state=current]')).toContainText('Preparing your offer');
      await expect(progress).not.toContainText(/Midnight|confirmed/i);
      await expect(page.getByTestId('activity-elapsed')).toHaveText(/^0:(1[2-9]|[2-5]\d)$/, { timeout: 20_000 });
      await shot(page, `${vp.name}-05-offer-preparing`, false);

      // Proven and sent to the exchange: "Listed on the market" in progress, the bar has no length.
      hold.at(['proving', 'proven', 'posted']);
      await expect(page.getByTestId('activity-stage')).toHaveAttribute('data-stage', 'posted', { timeout: 10_000 });
      await expect(progress.locator('[data-step-state=current]')).toContainText('Listed on the market');
      await expect(page.getByTestId('activity-bar')).not.toHaveAttribute('aria-valuenow');
      await expect(progress).not.toContainText(/Midnight|confirmed/i);
      await shot(page, `${vp.name}-06-offer-listing`, false);

      // Listed: the modal closes; the toast, the banner and Your offers say it is not on-chain.
      hold();
      await expect(progress).toHaveCount(0, { timeout: 15_000 });
      await expect(page.getByTestId('trade-message')).toContainText('Your offer is listed on the market');
      await expect(page.getByTestId('live-offer-banner')).toContainText('It is not on-chain');
      await expect(page.locator('[data-testid=my-trade][data-role=make]')).toContainText('Listed');
      await expect(page.getByTestId('my-offers-off-chain')).toBeVisible();
      await page.evaluate(() => window.scrollTo({ top: 0 }));
      await shot(page, `${vp.name}-07-offer-listed`, full);
    });

    test('a take keeps the on-chain steps: Confirmed on Midnight', async ({ page }) => {
      test.setTimeout(90_000);
      const { relay } = await setup(page, { seeded: true });
      await page.goto(`/${pairHash('twUSDM/twUSDC')}`);
      await connectPhantom(page);
      await expect(page.locator('[data-testid=holding][data-symbol="twUSDC"]')).toContainText('1,000.00');
      await page.getByTestId('buy-best-ask').click();
      await expect(page.getByTestId('take-confirm')).toBeVisible();
      const hold = relay.holdNextJob();
      hold.at(['offer-checked', 'proving', 'merged']);
      await page.getByTestId('take-sign').click();
      const progress = page.getByTestId('activity-progress');
      await expect(progress).toBeVisible();
      await expect(page.getByTestId('activity-stage')).toHaveAttribute('data-stage', 'merged');
      await expect(progress.locator('[data-step-state=current]')).toContainText('Confirmed on Midnight');
      await expect(page.getByTestId('activity-bar')).toHaveAttribute('aria-valuenow', /\d+/);
      await expect(page.getByTestId('activity-elapsed')).toHaveText(/^0:(0[5-9]|[1-5]\d)$/, { timeout: 15_000 });
      await shot(page, `${vp.name}-08-take-progress`, false);
      hold();
      await expect(progress).toHaveCount(0, { timeout: 15_000 });
      await expect(page.getByTestId('trade-message')).toContainText('settled in one transaction on Midnight');
    });

    test('portfolio with balances, and the portfolio panel beside Trade', async ({ page }) => {
      await setup(page, { seeded: true });
      await page.goto('/#account');
      await connectPhantom(page);
      await expect(page.locator('[data-testid=passport-row][data-symbol="twUSDC"]')).toContainText('1,000.00');
      await expect(page.locator('[data-testid=passport-row][data-kind="unshielded"]')).toContainText('25.00');
      await shot(page, `${vp.name}-09-portfolio`, full);

      await page.getByTestId('tab-trade').click();
      await expect(page.getByTestId('holdings-panel')).toHaveAttribute('data-state', 'account');
      if (vp.touch) {
        await page.getByTestId('portfolio-toggle').click();
        await expect(page.getByTestId('portfolio-dock')).toBeVisible();
      }
      await expect(page.locator('[data-testid=holding][data-symbol="twBTC"]')).toBeVisible();
      await shot(page, `${vp.name}-10-portfolio-drawer`, false);
    });

    test('demo tokens: the free pack, then delivered', async ({ page }) => {
      await setup(page);
      await page.goto('/#account');
      await connectPhantom(page);
      await page.getByTestId('open-account').click();
      await expect(page.getByTestId('masthead-account')).toBeVisible();
      await openAction(page, 'mint-midnight');
      await expect(page.getByTestId('demo-pack')).toHaveText('1,000.00 twUSDC · 0.10 twBTC · 1.00 twETH');
      await page.getByTestId('accounts-message').getByRole('button', { name: 'Dismiss' }).click();
      await page.getByTestId('demo-tokens').scrollIntoViewIfNeeded();
      await shot(page, `${vp.name}-11-demo-tokens`, full);

      await page.getByTestId('get-demo-tokens').click();
      await expect(page.getByTestId('demo-message')).toContainText('Demo tokens delivered');
      await expect(page.locator('[data-testid=passport-row][data-symbol="twBTC"]')).toContainText('0.10');
      await shot(page, `${vp.name}-12-demo-delivered`, false);
    });

    test('an error toast: a request declined in Phantom', async ({ page }) => {
      const { phantom, relay } = await setup(page);
      await page.goto('/#account');
      await connectPhantom(page);
      phantom.mode = 'reject';
      await page.getByTestId('open-account').click();
      await expect(page.getByTestId('accounts-message')).toContainText('You declined the request in your wallet');
      await expect(page.getByTestId('sign-prompt')).toHaveCount(0);
      expect(relay.submitted).toEqual([]);
      await shot(page, `${vp.name}-13-error-toast`, false);
    });
  });
}
