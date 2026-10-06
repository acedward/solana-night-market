// AA 00047 P8.2 (spec FR-006b "contrast is WCAG AA on dark"; plan P8 testing): accessibility of the
// dark consumer UI, with the mock Phantom and the mock relay (nothing leaves the page's origin).
//
//   - axe-core (WCAG 2.0/2.1/2.2 A and AA rules) finds no violation on the key screens, at a 1440 px
//     desktop and a 390 px phone: Markets (a new visitor, and a book open), Trade connected, the
//     Create offer card filled in, the signing modal, the make-offer progress (preparing, listing),
//     Portfolio, the portfolio drawer, the wallet menu, the demo tokens, an error toast, Local Data
//     and its CLEAR ALL dialog.
//   - The portfolio drawer is a modal on narrow screens: it takes the focus, keeps Tab and Shift+Tab
//     inside, closes on Escape and gives the focus back to the button that opened it.
//   - Escape closes every overlay (the menus, the drawer, the dialogs, the signing modal, a tooltip)
//     and the focus goes back where it was.
//   - Every control reached with the keyboard shows a visible focus ring.

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

import { connectPhantom } from './mock-phantom.js';
import { customerRecords, seedRecords, serveExchange } from './visual-fixtures.js';
import { openAction } from './portfolio-fixtures.js';
import { setup } from './wallet-fixtures.js';

const VIEWPORTS = [
  { name: 'desktop1440', width: 1440, height: 900, touch: false },
  { name: 'phone390', width: 390, height: 844, touch: true },
] as const;

/** axe on the whole page (a modal: the page behind is inert, so axe reads the modal), or only on
 *  `include` (an open menu: the controls it covers for a moment are not its violations). */
async function axe(page: Page, screen: string, include?: string) {
  await page.evaluate(() => document.fonts.ready);
  // Let the finite animations (a toast sliding in, the drawer, a modal) end: axe reads colours as
  // they are painted, and a half-faded panel is not what the customer reads.
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => undefined)),
    ),
  );
  const builder = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']);
  const r = await (include ? builder.include(include) : builder).analyze();
  const found = r.violations.map(
    (v) =>
      `${v.id} (${v.impact}): ${v.help}\n${v.nodes
        .slice(0, 6)
        .map((n) => `    ${n.target.join(' ')}  ${n.failureSummary?.replace(/\s+/g, ' ').slice(0, 200) ?? ''}`)
        .join('\n')}`,
  );
  expect(found, `axe violations on "${screen}"`).toEqual([]);
}

const pairHash = (pair: string) => `#trade?pair=${encodeURIComponent(pair)}`;

for (const vp of VIEWPORTS) {
  test.describe(`axe at ${vp.width} px`, () => {
    test.use({
      viewport: { width: vp.width, height: vp.height },
      hasTouch: vp.touch,
      isMobile: vp.touch,
    });

    test('Markets: a new visitor, the connect menu, and a book open', async ({ page }) => {
      await setup(page);
      await page.goto('/#markets');
      await expect(page.getByTestId('market-feed-status')).toHaveAttribute('data-status', 'ready');
      await axe(page, 'markets, new visitor');
      await page.getByTestId('connect').click();
      await expect(page.getByTestId('wallet-option')).toBeVisible();
      await axe(page, 'the connect menu', '[data-testid=wallet-menu]');
      await page.keyboard.press('Escape');
      await page.locator('[data-testid=market-row][data-pair="twUSDM/twUSDC"]').getByTestId('open-book').click();
      await expect(page.getByTestId('book')).toBeVisible();
      await axe(page, 'markets, a book open');
    });

    test('Trade connected, Create offer, the signing modal and the make-offer progress', async ({ page }) => {
      test.setTimeout(90_000);
      const { phantom, relay } = await setup(page, { seeded: true });
      await page.goto(`/${pairHash('twBTC/twUSDC')}`);
      await connectPhantom(page);
      await expect(page.locator('[data-testid=holding][data-symbol="twBTC"]')).toContainText('0.10');
      await axe(page, 'trade, connected');

      await page.getByTestId('wallet-connected').click();
      await expect(page.getByTestId('account-menu')).toBeVisible();
      await axe(page, 'the wallet menu', '[data-testid=account-menu]');
      await page.keyboard.press('Escape');

      await page.getByTestId('side-sell').click();
      await page.getByTestId('make-quantity').fill('0.05');
      await page.getByTestId('make-price').fill('61500');
      await expect(page.getByTestId('legs-want')).toContainText('3,075.00 twUSDC');
      await axe(page, 'create offer, filled in');

      const releaseSign = phantom.holdNext();
      const hold = relay.holdNextJob();
      await page.getByTestId('make-sign').click();
      await expect(page.getByTestId('sign-prompt')).toBeVisible();
      await axe(page, 'the signing modal (make)');
      releaseSign();
      await expect(page.getByTestId('activity-progress')).toBeVisible();
      await expect(page.getByTestId('activity-stage')).toHaveAttribute('data-stage', 'proving');
      await axe(page, 'make-offer progress, preparing');
      hold.at(['proving', 'proven', 'posted']);
      await expect(page.getByTestId('activity-stage')).toHaveAttribute('data-stage', 'posted', { timeout: 10_000 });
      await axe(page, 'make-offer progress, listing');
      hold();
      await expect(page.getByTestId('activity-progress')).toHaveCount(0, { timeout: 15_000 });
      await expect(page.getByTestId('trade-message')).toBeVisible();
      await axe(page, 'trade, the offer listed');
    });

    test('Portfolio, the drawer, the demo tokens and an error toast', async ({ page }) => {
      const { phantom } = await setup(page);
      await page.goto('/#account');
      await connectPhantom(page);
      await axe(page, 'portfolio, no account');
      phantom.mode = 'reject';
      await page.getByTestId('open-account').click();
      await expect(page.getByTestId('accounts-message')).toContainText('You declined the request in your wallet');
      await axe(page, 'an error toast');
      phantom.mode = 'software';
      await page.getByTestId('accounts-message').getByRole('button', { name: 'Dismiss' }).click();
      await page.getByTestId('open-account').click();
      await expect(page.getByTestId('masthead-account')).toBeVisible();
      // AA 00060 FR-023: the Portfolio's list of actions, then the demo tokens (Mint Midnight tokens).
      await expect(page.getByTestId('portfolio-actions')).toBeVisible();
      await axe(page, 'portfolio, the list of actions');
      await openAction(page, 'mint-midnight');
      await expect(page.getByTestId('demo-pack')).toBeVisible();
      await axe(page, 'portfolio, the demo tokens');
      await page.getByTestId('get-demo-tokens').click();
      await expect(page.getByTestId('demo-message')).toContainText('Demo tokens delivered');
      await page.getByTestId('portfolio-back').click();
      await axe(page, 'portfolio with balances');
      await page.getByTestId('tab-trade').click();
      await expect(page.getByTestId('holdings-panel')).toHaveAttribute('data-state', 'account');
      if (vp.touch) {
        await page.getByTestId('portfolio-toggle').click();
        await expect(page.getByTestId('portfolio-dock')).toBeVisible();
        await axe(page, 'the portfolio drawer');
      }
    });

    test('Local Data and the CLEAR ALL dialog', async ({ page }) => {
      await serveExchange(page);
      await seedRecords(page, customerRecords().entries);
      await page.goto('/#local');
      await expect(page.locator('[data-testid=record-row]').first()).toBeVisible();
      await axe(page, 'local data');
      await page.getByTestId('clear-all').click();
      await expect(page.getByTestId('clear-dialog')).toBeVisible();
      await axe(page, 'the CLEAR ALL dialog');
    });
  });
}

/** Tab through the page (at most `max` stops) and report every stop without a visible focus ring:
 *  no outline and no ring shadow, or a ring clipped by a scrolling or clipping ancestor. */
async function tabRings(page: Page, max: number) {
  const bad: string[] = [];
  let stops = 0;
  await page.evaluate(() => {
    delete (window as unknown as { __a11yStops?: WeakSet<Element> }).__a11yStops;
  });
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    const r = await page.evaluate(async () => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      // The ring as it settles: a field's shadow ring fades in (a short CSS transition).
      const unit = el.closest('.input-unit');
      await Promise.all(
        [...el.getAnimations(), ...(unit?.getAnimations() ?? [])].map((a) => a.finished.catch(() => undefined)),
      );
      // Each stop by identity (many share a name, e.g. every card's "Order book"): the walk ends
      // when the focus comes back to a stop it has already visited.
      const w = window as unknown as { __a11yStops?: WeakSet<Element> };
      w.__a11yStops ??= new WeakSet();
      const again = w.__a11yStops.has(el);
      w.__a11yStops.add(el);
      const name = `${el.tagName.toLowerCase()}${el.dataset.testid ? `[${el.dataset.testid}]` : ''} "${(el.textContent ?? el.getAttribute('aria-label') ?? '').trim().slice(0, 30)}"`;
      const ringOf = (e: Element) => {
        const cs = getComputedStyle(e);
        const w = parseFloat(cs.outlineWidth) || 0;
        if (cs.outlineStyle !== 'none' && w >= 2) return w + Math.max(0, parseFloat(cs.outlineOffset) || 0);
        // The field ring (components.css `--focus`): a 2 px gap, then 2 px of cyan.
        if (cs.boxShadow.includes('rgb(34, 211, 238)')) return 4;
        return 0;
      };
      // A field's ring may be drawn on its unit wrapper (components.css .input-unit:focus-within).
      const holder = ringOf(el) > 0 ? el : el.closest('.input-unit');
      const ext = holder ? ringOf(holder) : 0;
      if (!holder || ext === 0) return { name, again, problem: 'no focus ring' };
      const b = holder.getBoundingClientRect();
      for (let p = holder.parentElement; p && p !== document.body; p = p.parentElement) {
        const cs = getComputedStyle(p);
        const clips = [cs.overflowX, cs.overflowY].some((o) => o !== 'visible');
        if (!clips) continue;
        const pb = p.getBoundingClientRect();
        const room = Math.min(b.left - pb.left, pb.right - b.right, b.top - pb.top, pb.bottom - b.bottom);
        // Clipped when the ring would cross the clipping box (a scroll box scrolls the stop into view,
        // so only its sides across the scroll direction count; 1 px of the ring may touch the edge).
        const across =
          cs.overflowX !== 'visible' && cs.overflowY === 'visible'
            ? Math.min(b.top - pb.top, pb.bottom - b.bottom)
            : cs.overflowY !== 'visible' && cs.overflowX === 'visible'
              ? Math.min(b.left - pb.left, pb.right - b.right)
              : room;
        if (across < ext - 1)
          return {
            name,
            again,
            problem: `ring clipped by ${p.tagName.toLowerCase()}.${String(p.className).slice(0, 30)}`,
          };
      }
      return { name, again, problem: null };
    });
    if (!r) continue;
    if (r.again) break;
    stops += 1;
    if (r.problem) bad.push(`${r.name}: ${r.problem}`);
  }
  return { bad, stops };
}

for (const vp of VIEWPORTS) {
  test.describe(`keyboard at ${vp.width} px`, () => {
    test.use({
      viewport: { width: vp.width, height: vp.height },
      hasTouch: vp.touch,
      isMobile: vp.touch,
    });

    test('every keyboard stop shows a visible focus ring (Markets, Trade, Portfolio, Local Data)', async ({ page }) => {
      test.setTimeout(120_000);
      await setup(page, { seeded: true });
      await page.goto('/#markets');
      await connectPhantom(page);
      await expect(page.getByTestId('market-feed-status')).toHaveAttribute('data-status', 'ready');
      for (const [hash, ready] of [
        ['#markets', 'market-feed-status'],
        [`#trade?pair=${encodeURIComponent('twBTC/twUSDC')}`, 'trade-book'],
        ['#account', 'passport-section'],
        ['#local', 'local-data'],
      ] as const) {
        await page.goto(`/${hash}`);
        await expect(page.getByTestId(ready)).toBeVisible();
        if (hash.startsWith('#trade')) {
          // A create row open and filled in (AA 00060 FR-026), so its preview and the submit button
          // are stops too.
          await page.getByTestId('side-sell').click();
          await page.getByTestId('make-quantity').fill('0.05');
          await page.getByTestId('make-price').fill('61500');
          await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        }
        const r = await tabRings(page, 150);
        expect(r.stops, `keyboard stops on ${hash}`).toBeGreaterThan(5);
        expect(r.bad, `stops without a visible focus ring on ${hash}`).toEqual([]);
      }
    });

    test('the wallet menus: arrow keys between items, Escape closes and the focus goes back', async ({ page }) => {
      await setup(page, { seeded: true });
      await page.goto('/#markets');
      await page.getByTestId('connect').focus();
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('wallet-menu')).toBeVisible();
      await expect(page.getByTestId('wallet-option')).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('wallet-menu')).toHaveCount(0);
      await expect(page.getByTestId('connect')).toBeFocused();
      await page.keyboard.press('Enter');
      await page.keyboard.press('Enter'); // the focused wallet: Phantom connects
      await expect(page.getByTestId('wallet-connected')).toBeVisible();

      await page.getByTestId('wallet-connected').focus();
      await page.keyboard.press('Enter');
      const menu = page.getByTestId('account-menu');
      await expect(menu).toBeVisible();
      await expect(page.getByTestId('copy-address')).toBeFocused();
      await page.keyboard.press('ArrowDown');
      await expect(menu.getByRole('menuitem', { name: 'Portfolio' })).toBeFocused();
      await page.keyboard.press('End');
      await expect(page.getByTestId('disconnect')).toBeFocused();
      await page.keyboard.press('ArrowDown'); // wraps
      await expect(page.getByTestId('copy-address')).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(menu).toHaveCount(0);
      await expect(page.getByTestId('wallet-connected')).toBeFocused();
      // Tab out of an open menu closes it.
      await page.keyboard.press('Enter');
      await expect(menu).toBeVisible();
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Shift+Tab');
      await expect(menu).toHaveCount(0);
    });

    test('Escape closes the signing modal, the progress view, a dialog and a tooltip', async ({ page }) => {
      test.setTimeout(90_000);
      const { phantom, relay } = await setup(page, { seeded: true });
      await page.goto(`/#trade?pair=${encodeURIComponent('twBTC/twUSDC')}`);
      await connectPhantom(page);
      await expect(page.locator('[data-testid=holding][data-symbol="twBTC"]')).toContainText('0.10');

      // A greyed Buy's tooltip: shown on keyboard focus, hidden by Escape (WCAG 1.4.13).
      const tip = page.locator('[data-testid=trade-line]').first().getByTestId('not-enough');
      await tip.focus();
      await expect(tip).toHaveClass(/tip-open/);
      await page.keyboard.press('Escape');
      await expect(tip).not.toHaveClass(/tip-open/);

      // The signing modal: Escape hides it while Phantom stays open; the request is not cancelled.
      await page.getByTestId('side-sell').click();
      await page.getByTestId('make-quantity').fill('0.05');
      await page.getByTestId('make-price').fill('61500');
      const releaseSign = phantom.holdNext();
      const hold = relay.holdNextJob();
      await page.getByTestId('make-sign').click();
      await expect(page.getByTestId('sign-prompt')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('sign-prompt')).toHaveCount(0);
      // The request is not cancelled: the action goes on in the background, and the page says how
      // it went.
      releaseSign();
      await expect.poll(() => relay.submitted.length).toBe(1);
      await expect(page.getByTestId('activity-progress')).toHaveCount(0);
      hold();
      await expect(page.getByTestId('trade-message')).toContainText('Your offer is listed on the market');

      // The progress view of a take: Escape hides it ("Continue in background"); the take goes on.
      await page.getByTestId('trade-pair').selectOption('twUSDM/twUSDC');
      // AA 00060 FR-026: the best ask is the first row under Sellers.
      await page.getByTestId('trade-book-asks').getByTestId('take-line').first().click();
      const holdTake = relay.holdNextJob();
      await page.getByTestId('take-sign').click();
      await expect(page.getByTestId('activity-progress')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('activity-progress')).toHaveCount(0);
      holdTake();
      await expect(page.getByTestId('trade-message')).toContainText('settled in one transaction on Midnight');

      // A dialog (Local Data's CLEAR ALL): Escape closes it and the focus goes back to its button.
      await page.goto('/#local');
      await page.getByTestId('clear-all').focus();
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('clear-dialog')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('clear-dialog')).toHaveCount(0);
      await expect(page.getByTestId('clear-all')).toBeFocused();
    });
  });
}

// The drawer exists below 1180 px (the phone, and a 768 px tablet); from 1180 px the panel is docked.
for (const vp of [
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
] as const) {
  test(`the portfolio drawer at ${vp.width} px traps the focus, closes on Escape and gives the focus back`, async ({
    page,
  }) => {
    await page.setViewportSize(vp);
    await setup(page, { seeded: true });
    await page.goto(`/#trade?pair=${encodeURIComponent('twBTC/twUSDC')}`);
    await connectPhantom(page);
    const toggle = page.getByTestId('portfolio-toggle');
    const dock = page.getByTestId('portfolio-dock');
    await expect(dock).toBeHidden();
    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(dock).toBeVisible();
    await expect(dock).toHaveAttribute('role', 'dialog');
    await expect(dock).toHaveAttribute('aria-modal', 'true');
    await expect(page.getByRole('dialog', { name: 'Portfolio' })).toBeVisible();
    await expect(dock.getByRole('button', { name: 'Close the portfolio' })).toBeFocused();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');

    // Tab and Shift+Tab never leave the drawer, and wrap at both ends.
    const inside = () => page.evaluate(() => !!document.activeElement?.closest('[data-testid=portfolio-dock]'));
    const stops = await dock.evaluate(
      (el) =>
        Array.from(
          el.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input, select, [tabindex]'),
        ).filter((e) => e.tabIndex >= 0 && e.getClientRects().length > 0).length,
    );
    expect(stops).toBeGreaterThan(2);
    for (let i = 0; i < stops + 2; i++) {
      await page.keyboard.press('Tab');
      expect(await inside(), `Tab ${i + 1} stays in the drawer`).toBe(true);
    }
    await dock.getByRole('button', { name: 'Close the portfolio' }).focus();
    await page.keyboard.press('Shift+Tab');
    expect(await inside()).toBe(true);
    await expect(dock.getByRole('button', { name: 'Close the portfolio' })).not.toBeFocused();
    for (let i = 0; i < stops + 2; i++) {
      await page.keyboard.press('Shift+Tab');
      expect(await inside(), `Shift+Tab ${i + 1} stays in the drawer`).toBe(true);
    }

    // Escape closes it; the focus is back on the Portfolio button.
    await page.keyboard.press('Escape');
    await expect(dock).toBeHidden();
    await expect(toggle).toBeFocused();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');

    // The close button and the scrim close it too, with the same focus return.
    await page.keyboard.press('Enter');
    await expect(dock).toBeVisible();
    await page.keyboard.press('Enter'); // the focused close button
    await expect(dock).toBeHidden();
    await expect(toggle).toBeFocused();
  });
}
