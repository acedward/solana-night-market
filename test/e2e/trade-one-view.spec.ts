// AA 00060 spec FR-026 / FR-027 (plan P14), with the mock Phantom, the mock relay and the mock
// exchange (nothing leaves the page's origin). The Trade page is ONE view of a pair, `Order book
// <base> ⇄ <quote>`: each half lists the offers you can take and ends with a create row for your own
// offer, which is listed in the OTHER half once the exchange has it. The "Buy or sell now" and
// "Create offer" panels are gone. Your own offer stays in the book, marked "Your offer", with a short
// note that you cannot take it and NO action (owner, questions Q9: no per-row "Cancel your offer"); the
// market-wide "Cancel offer" (00047 Q30) is unchanged. The book says "amounts in <base>, prices in <quote>"
// (questions Q10). Generic pairs only here (twETH/twBTC, twUSDM/twUSDC): no token is special.

import { expect, test, type Page } from '@playwright/test';

import { COLOUR, leg, offerRow } from '../../packages/core/test/fixtures/kernel/book.js';
import { connectPhantom } from './mock-phantom.js';
import { setup } from './wallet-fixtures.js';

const holding = (page: Page, symbol: string, kind = 'shielded') =>
  page.locator(`[data-testid=holding][data-symbol="${symbol}"][data-kind="${kind}"]`);
const pairHash = (id: string) => `#trade?pair=${encodeURIComponent(id)}`;

/** The exchange lists every make the relay posts, from its legs, as the kernel does. */
function listMakes(ex: Awaited<ReturnType<typeof setup>>['ex'], relay: Awaited<ReturnType<typeof setup>>['relay']) {
  let n = 900;
  relay.onMake = (offerId, p) => {
    n += 1;
    ex.fixture.book.push({
      ...offerRow(n, [leg(p.giveColor!, BigInt(p.giveAmount!))], [leg(p.wantColor!, BigInt(p.wantAmount!))]),
      offerId,
    });
  };
}

test('FR-026: one view; takes work from both halves (twUSDM/twUSDC)', async ({ page }) => {
  const { relay, phantom } = await setup(page, { seeded: true });
  await page.goto(`/${pairHash('twUSDM/twUSDC')}`);
  await connectPhantom(page);
  await expect(holding(page, 'twUSDC')).toContainText('1,000.00');

  // One view: the order book with both halves and their create rows; the old panels are gone.
  const book = page.getByTestId('trade-book');
  await expect(book.getByRole('heading', { name: 'Order book twUSDM ⇄ twUSDC' })).toBeVisible();
  await expect(page.getByTestId('trade-half-asks').locator('h4')).toHaveText('Sellers — you buy twUSDM');
  await expect(page.getByTestId('trade-half-bids').locator('h4')).toHaveText('Buyers — you sell twUSDM');
  await expect(page.getByTestId('side-buy')).toHaveText('Sell twUSDC');
  await expect(page.getByTestId('side-sell')).toHaveText('Sell twUSDM');
  await expect(page.getByTestId('trade-half-asks').getByTestId('side-buy')).toBeVisible();
  await expect(page.getByTestId('trade-half-bids').getByTestId('side-sell')).toBeVisible();
  await expect(page.getByText('Buy or sell now')).toHaveCount(0);
  await expect(page.getByTestId('take-section')).toHaveCount(0);
  await expect(page.getByTestId('make-section')).toHaveCount(0); // a create row opens on demand

  // Take from Sellers: buy the best ask, 10 twUSDM at 1.05 (pay 10.50 twUSDC). The review opens
  // under the half it belongs to.
  await page.getByTestId('trade-book-asks').getByTestId('take-line').first().click();
  await expect(page.getByTestId('trade-half-asks').getByTestId('take-confirm')).toBeVisible();
  await expect(page.getByTestId('legs-give')).toContainText('10.50 twUSDC');
  await expect(page.getByTestId('legs-want')).toContainText('10.00 twUSDM');
  await page.getByTestId('take-sign').click();
  await expect(page.getByTestId('trade-message')).toContainText('settled in one transaction on Midnight');
  await expect(holding(page, 'twUSDM')).toContainText('10.00');

  // Take from Buyers: sell the 10 twUSDM coin to the best bid, 0.95 (get 9.50 twUSDC).
  const sell = page.getByTestId('trade-book-bids').getByTestId('take-line').first();
  await expect(sell).toBeEnabled();
  await sell.click();
  await expect(page.getByTestId('trade-half-bids').getByTestId('take-confirm')).toBeVisible();
  await expect(page.getByTestId('legs-give')).toContainText('10.00 twUSDM');
  await expect(page.getByTestId('legs-want')).toContainText('9.50 twUSDC');
  await page.getByTestId('take-sign').click();
  await expect(page.getByTestId('trade-message')).toContainText('settled in one transaction on Midnight');

  expect(relay.submitted.map((s) => [s.action, s.verified])).toEqual([
    ['take', 'ok'],
    ['take', 'ok'],
  ]);
  expect(relay.submitted[0]!.body.payload).toMatchObject({
    giveColor: COLOUR.twUSDC,
    giveAmount: '10500000',
    wantColor: COLOUR.twUSDM,
    wantAmount: '10000000',
  });
  expect(relay.submitted[1]!.body.payload).toMatchObject({
    giveColor: COLOUR.twUSDM,
    giveAmount: '10000000',
    wantColor: COLOUR.twUSDC,
    wantAmount: '9500000',
  });
  expect(phantom.requests).toHaveLength(2);
});

test('FR-026 + FR-027: both create rows on twETH/twBTC, listed in the other half; your own offer: the badge and the note, no action', async ({
  page,
}) => {
  const { ex, relay, phantom } = await setup(page, { seeded: true });
  listMakes(ex, relay);
  await page.goto(`/${pairHash('twETH/twBTC')}`);
  await connectPhantom(page);
  await expect(holding(page, 'twBTC')).toContainText('0.10');
  await expect(page.getByTestId('trade-book').getByRole('heading', { name: 'Order book twETH ⇄ twBTC' })).toBeVisible();
  // Questions Q10: which token the amounts and the prices are in, so the title's order cannot be misread.
  await expect(page.getByTestId('trade-book')).toContainText('amounts in twETH, prices in twBTC');
  await expect(page.getByTestId('trade-book-asks').getByTestId('trade-line')).toHaveCount(0); // nobody is selling
  await expect(page.getByTestId('trade-book-bids').getByTestId('trade-line')).toHaveCount(1);

  // The create row under Sellers: "Sell twBTC" (you buy twETH). It opens with the best price.
  const sellQuote = page.getByTestId('side-buy');
  await expect(sellQuote).toHaveText('Sell twBTC');
  await expect(sellQuote).toHaveAttribute('aria-expanded', 'false');
  await sellQuote.click();
  await expect(sellQuote).toHaveAttribute('aria-expanded', 'true');
  const form = page.getByTestId('trade-half-asks').getByTestId('make-section');
  await expect(form).toHaveAttribute('data-side', 'buy');
  await expect(form.getByTestId('make-listed-under')).toHaveText('It is listed under Buyers once the exchange has it.');
  await expect(page.getByTestId('make-price')).toHaveValue(/^0\.04/); // the best bid
  await expect(page.getByTestId('make-prefill')).toContainText('Use the best price');

  // The existing validations, inside the row: the price, and one coin per payment.
  await page.getByTestId('make-quantity').fill('1');
  await page.getByTestId('make-price').fill('0');
  await expect(page.getByTestId('make-error')).toBeVisible();
  await expect(page.getByTestId('make-sign')).toBeDisabled();
  await page.getByTestId('make-quantity').fill('10');
  await page.getByTestId('make-price').fill('0.04');
  await expect(page.getByTestId('make-not-fundable')).toHaveText('Not enough twBTC. You hold 0.10 twBTC.');
  await expect(page.getByTestId('make-sign')).toBeDisabled();

  // Buy 0.5 twETH at 0.03: give 0.015 twBTC, want 0.5 twETH.
  await page.getByTestId('make-quantity').fill('0.5');
  await page.getByTestId('make-price').fill('0.03');
  await expect(page.getByTestId('legs-give')).toContainText('0.015 twBTC');
  await expect(page.getByTestId('legs-want')).toContainText('0.50 twETH');
  await expect(page.getByTestId('make-sign')).toHaveText('Create offer: sell twBTC');
  await page.getByTestId('make-sign').click();
  await expect(page.getByTestId('trade-message')).toContainText('Your offer is listed on the market');
  expect(relay.submitted.at(-1)!.body.payload).toMatchObject({
    giveColor: COLOUR.twBTC,
    giveAmount: '1500000',
    wantColor: COLOUR.twETH,
    wantAmount: '500000000000000000',
  });
  await expect(page.getByTestId('make-section')).toHaveCount(0); // the row closes once made

  // Listed in the OTHER half: under Buyers, as your offer: the badge and the note, no action, no take.
  const offerId = Object.keys(relay.offerStatus)[0]!;
  const mine = page.locator(`[data-testid=trade-line][data-offer="${offerId}"]`);
  await expect(page.getByTestId('trade-book-bids').locator(`[data-offer="${offerId}"]`)).toBeVisible();
  await expect(page.getByTestId('trade-book-asks').locator(`[data-offer="${offerId}"]`)).toHaveCount(0);
  await expect(mine).toHaveAttribute('data-own', 'yes');
  await expect(mine.getByTestId('own-offer')).toHaveText('Your offer');
  await expect(mine.getByTestId('own-offer-note')).toHaveText("You can't take your own offer.");
  await expect(mine.getByRole('button')).toHaveCount(0);
  await expect(mine.getByTestId('take-line')).toHaveCount(0);

  // One live offer per account: the other create row refuses a second one.
  await page.getByTestId('side-sell').click();
  await expect(page.getByTestId('trade-half-bids').getByTestId('make-section')).toHaveAttribute('data-side', 'sell');
  await page.getByTestId('make-quantity').fill('0.5');
  await page.getByTestId('make-price').fill('0.05');
  await expect(page.getByTestId('make-refused')).toContainText('You already have a live offer');
  await expect(page.getByTestId('make-sign')).toBeDisabled();
  await page.getByTestId('make-close').click();
  await expect(page.getByTestId('make-section')).toHaveCount(0);

  // Offers cannot be cancelled (spec FR-028): no cancel control anywhere; the offer ends at its expiry.
  await expect(page.getByTestId('cancel-offer')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /cancel/i })).toHaveCount(0);
  expect(relay.submitted.map((s) => s.action)).toEqual(['open-swap']);
  expect(phantom.requests).toHaveLength(1);
});

test('FR-026: the create row under Buyers ("Sell <base>") is listed under Sellers, as your offer with its note', async ({
  page,
}) => {
  const { ex, relay } = await setup(page, { seeded: true });
  listMakes(ex, relay);
  await page.goto(`/${pairHash('twETH/twBTC')}`);
  await connectPhantom(page);
  await expect(holding(page, 'twBTC')).toContainText('0.10');
  await page.getByTestId('side-sell').click();
  await page.getByTestId('make-quantity').fill('0.5');
  await page.getByTestId('make-price').fill('0.05');
  await expect(page.getByTestId('legs-give')).toContainText('0.50 twETH');
  await expect(page.getByTestId('legs-want')).toContainText('0.025 twBTC');
  await expect(page.getByTestId('make-sign')).toHaveText('Create offer: sell twETH');
  await page.getByTestId('make-sign').click();
  await expect(page.getByTestId('trade-message')).toContainText('Your offer is listed on the market');
  expect(relay.submitted.at(-1)!.body.payload).toMatchObject({
    giveColor: COLOUR.twETH,
    giveAmount: '500000000000000000',
    wantColor: COLOUR.twBTC,
    wantAmount: '2500000',
  });
  const offerId = Object.keys(relay.offerStatus)[0]!;
  const mine = page.getByTestId('trade-book-asks').locator(`[data-offer="${offerId}"]`);
  await expect(mine).toBeVisible();
  await expect(mine.getByTestId('own-offer-note')).toHaveText("You can't take your own offer.");
  await expect(mine.getByRole('button')).toHaveCount(0);
});

test.describe('at a 390 px phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('your own row, its note and the create rows fit inside the book', async ({ page }) => {
    const { ex, relay } = await setup(page, { seeded: true });
    listMakes(ex, relay);
    await page.goto(`/${pairHash('twBTC/twUSDC')}`);
    await connectPhantom(page);
    await expect(holding(page, 'twUSDC')).toContainText('1,000.00');
    await page.getByTestId('side-buy').click();
    await page.getByTestId('make-quantity').fill('0.01');
    await page.getByTestId('make-price').fill('59000');
    await page.getByTestId('make-sign').click();
    await expect(page.getByTestId('trade-message')).toContainText('Your offer is listed on the market');
    const note = page.getByTestId('trade-book-bids').getByTestId('own-offer-note');
    await expect(note).toBeVisible();
    const panel = (await page.getByTestId('trade-book').boundingBox())!;
    for (const el of [
      note,
      page.getByTestId('trade-book-bids').getByTestId('own-offer'),
      page.getByTestId('side-buy'),
      page.getByTestId('side-sell'),
    ]) {
      const b = (await el.boundingBox())!;
      expect(b.x).toBeGreaterThanOrEqual(panel.x);
      expect(b.x + b.width).toBeLessThanOrEqual(panel.x + panel.width);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  });
});
