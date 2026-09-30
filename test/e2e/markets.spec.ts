// Plan L-MKT testing, carried over: the Markets page against a mock exchange that answers in the
// exact shapes the staging kernel returns (served through page.route, so nothing reaches the real
// kernel). The page must equal a manual computation over GET /v1/offers (spec SC-002) for every
// configured pair, none special (twETH/twBTC, a pair without twUSDC, is read the same way), show
// "no liquidity" for a pair with no live offer, and "exchange unavailable" when the kernel is down.

import { expect, test, type Page } from '@playwright/test';

import { BOOK, COLOUR, EXPECTED, PAIR_IDS, type WireOffer } from '../../packages/core/test/fixtures/kernel/book.js';
import { KernelFixture } from '../../packages/core/test/fixtures/kernel/mock-kernel.js';
import { serveExchange } from './visual-fixtures.js';

/** The tokens of the default pairs, with their decimals (the mint-test-tokens registry). */
const TOKENS: Record<string, { colour: string; decimals: number }> = {
  twBTC: { colour: COLOUR.twBTC, decimals: 8 },
  twETH: { colour: COLOUR.twETH, decimals: 18 },
  twUSDC: { colour: COLOUR.twUSDC, decimals: 6 },
  twUSDM: { colour: COLOUR.twUSDM, decimals: 6 },
};

/** A person's computation over GET /v1/offers, written independently of the app's code: only
 *  one-leg-per-side SHIELDED offers of the pair's two tokens count; asks give the base (price
 *  rounded up), bids give the quote (price rounded down); prices are whole quote tokens per whole
 *  base token, shown to at least 2 and at most 6 decimals, grouped by thousands. */
function manual(offers: WireOffer[], pairId: string) {
  const [b, q] = pairId.split('/') as [string, string];
  const base = TOKENS[b]!;
  const quote = TOKENS[q]!;
  const SCALE = 1_000_000n; // millionths of a quote token
  const asks: bigint[] = [];
  const bids: bigint[] = [];
  for (const o of offers) {
    const { gives, wants } = o.computed;
    if (gives.length !== 1 || wants.length !== 1) continue;
    const [g, w] = [gives[0]!, wants[0]!];
    if (g.type !== 'SHIELDED' || w.type !== 'SHIELDED') continue;
    // quoteRaw / 10^qd ÷ baseRaw / 10^bd, in millionths
    const num = (quoteRaw: string) => BigInt(quoteRaw) * 10n ** BigInt(base.decimals) * SCALE;
    const den = (baseRaw: string) => BigInt(baseRaw) * 10n ** BigInt(quote.decimals);
    if (g.token === base.colour && w.token === quote.colour)
      asks.push((num(w.amount) + den(g.amount) - 1n) / den(g.amount));
    if (g.token === quote.colour && w.token === base.colour) bids.push(num(g.amount) / den(w.amount));
  }
  const text = (micro: bigint) => {
    const whole = (micro / SCALE).toLocaleString('en-US');
    const frac = (micro % SCALE).toString().padStart(6, '0').replace(/0+$/, '').padEnd(2, '0');
    return `${whole}.${frac}`;
  };
  const min = asks.length ? asks.reduce((a, c) => (c < a ? c : a)) : null;
  const max = bids.length ? bids.reduce((a, c) => (c > a ? c : a)) : null;
  return {
    bestAsk: min === null ? 'no asks' : text(min),
    bestBid: max === null ? 'no bids' : text(max),
    counts: `${bids.length} / ${asks.length}`,
  };
}

const row = (page: Page, pair: string) => page.locator(`[data-testid=market-row][data-pair="${pair}"]`);

test('the Markets page equals a manual computation over /v1/offers, for every pair', async ({ page }) => {
  const { fixture, external, kernel } = await serveExchange(page);
  await page.goto('/#markets');
  await expect(page.getByTestId('market-feed-status')).toHaveAttribute('data-status', 'ready');
  await expect(page.locator('[data-testid=market-row]')).toHaveCount(PAIR_IDS.length);

  // Everything the exchange lists, unfiltered, as a person would read it.
  const all = JSON.parse(fixture.respond('/v1/offers?limit=100').body) as { offers: WireOffer[] };
  expect(all.offers).toHaveLength(BOOK.length);
  for (const pair of PAIR_IDS) {
    const m = manual(all.offers, pair);
    const r = row(page, pair);
    await expect(r.getByTestId('best-bid'), pair).toHaveText(m.bestBid);
    await expect(r.getByTestId('best-ask'), pair).toHaveText(m.bestAsk);
    await expect(r.getByTestId('offer-counts'), pair).toHaveText(m.counts);
  }
  // … and the hand-written expectations of the fixture.
  const usdm = row(page, 'twUSDM/twUSDC');
  await expect(usdm.getByTestId('best-ask')).toHaveText(EXPECTED['twUSDM/twUSDC'].bestAsk!);
  await expect(usdm.getByTestId('best-bid')).toHaveText(EXPECTED['twUSDM/twUSDC'].bestBid!);
  await expect(usdm.getByTestId('last-trade')).toContainText('1.02');
  await expect(usdm.getByTestId('market-status')).toHaveText('Two-sided');
  // A pair with no live offer: no liquidity (its old fill still shows as the last trade).
  await expect(row(page, 'twETH/twUSDC').getByTestId('market-status')).toHaveText('No liquidity');
  await expect(row(page, 'twETH/twUSDC').getByTestId('last-trade')).toContainText('2,500.00');
  // Asks only; the kernel's mid for a never-filled pair is not a trade.
  await expect(row(page, 'twBTC/twUSDC').getByTestId('best-ask')).toHaveText('60,000.00');
  await expect(row(page, 'twBTC/twUSDC').getByTestId('market-status')).toHaveText('Asks only');
  await expect(row(page, 'twBTC/twUSDC').getByTestId('last-trade')).toHaveText('no trades yet');
  // A pair without twUSDC, priced in twBTC.
  await expect(row(page, 'twETH/twBTC').getByTestId('best-bid')).toHaveText('0.04');
  await expect(row(page, 'twETH/twBTC').getByTestId('market-status')).toHaveText('Bids only');
  await expect(page.getByTestId('ignored-offers')).toContainText(/\d+ other offers/);

  // The book of one pair; each Take opens the Trade section on that offer.
  await usdm.getByTestId('open-book').click();
  const book = page.getByTestId('book');
  await expect(book).toHaveAttribute('data-pair', 'twUSDM/twUSDC');
  const lines = async (side: string) =>
    book
      .getByTestId(side)
      .getByTestId('book-line')
      .evaluateAll((trs) =>
        trs.map((tr) =>
          ['line-price', 'line-quantity', 'line-total'].map(
            (id) => tr.querySelector(`[data-testid=${id}]`)?.textContent ?? '',
          ),
        ),
      );
  expect(await lines('book-asks')).toEqual([
    ['1.05', '10.00', '10.50'],
    ['1.10', '20.00', '22.00'],
  ]);
  expect(await lines('book-bids')).toEqual([
    ['0.95', '10.00', '9.50'],
    ['0.90', '5.00', '4.50'],
  ]);
  await expect(book.getByTestId('book-summary')).toContainText('Spread 0.10');
  const takes = book.getByTestId('take');
  await expect(takes).toHaveCount(4);
  const lineIds = await book
    .getByTestId('book-line')
    .evaluateAll((trs) => trs.map((tr) => tr.getAttribute('data-offer') ?? ''));
  for (const [i, t] of (await takes.all()).entries()) {
    const q = new URLSearchParams({ pair: 'twUSDM/twUSDC', offer: lineIds[i]! }).toString();
    await expect(t).toHaveAttribute('href', `#trade?${q}`);
  }

  // Only GETs of the book (one read per quote token: twUSDC and twBTC), pairs, stats and the
  // stream; never /v1/prices or /v1/quote; nothing else leaves the browser.
  expect(external).toEqual([]);
  expect(kernel.every((k) => k.startsWith('GET '))).toBe(true);
  expect(kernel.some((k) => /\/v1\/(prices|quote)/.test(k))).toBe(false);
  const tokens = new Set(
    fixture.requests.filter((r) => r.path === '/v1/offers' && r.query.get('token')).map((r) => r.query.get('token')),
  );
  expect([...tokens].sort()).toEqual([COLOUR.twBTC, COLOUR.twUSDC].sort());
});

test('the staging exchange as captured (an empty book): every pair shows no liquidity', async ({ page }) => {
  await serveExchange(page, { fixture: new KernelFixture({ book: [], pairs: [], stats: {} }) });
  await page.goto('/#markets');
  await expect(page.getByTestId('market-feed-status')).toHaveAttribute('data-status', 'ready');
  for (const pair of PAIR_IDS) {
    await expect(row(page, pair).getByTestId('market-status')).toHaveText('No liquidity');
    await expect(row(page, pair).getByTestId('best-bid')).toHaveText('no bids');
    await expect(row(page, pair).getByTestId('best-ask')).toHaveText('no asks');
    await expect(row(page, pair).getByTestId('last-trade')).toHaveText('no trades yet');
  }
  await row(page, 'twBTC/twUSDC').getByTestId('open-book').click();
  await expect(page.getByTestId('book-empty')).toContainText('No liquidity');
});

test('a stopped exchange shows "exchange unavailable" and no price', async ({ page }) => {
  await serveExchange(page, { kernelDown: true });
  await page.goto('/#markets');
  await expect(page.getByTestId('exchange-unavailable')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('exchange-unavailable')).toContainText('Exchange unavailable');
  for (const pair of PAIR_IDS) {
    await expect(row(page, pair).getByTestId('market-status')).toHaveText('Exchange unavailable');
    await expect(row(page, pair).getByTestId('best-bid')).toHaveText('—');
    await expect(row(page, pair).getByTestId('best-ask')).toHaveText('—');
  }
});

test('sections without prices make no exchange request', async ({ page }) => {
  const { kernel } = await serveExchange(page);
  await page.goto('/#local');
  await expect(page.getByRole('heading', { name: 'Night Market' })).toBeVisible();
  await page.waitForTimeout(1_000);
  expect(kernel).toEqual([]);
  await page.getByTestId('tab-markets').click();
  await expect(page.getByTestId('market-feed-status')).toHaveAttribute('data-status', 'ready');
  expect(kernel.length).toBeGreaterThan(0);
});

test('config.json pairs: the site lists exactly those, in that order', async ({ page }) => {
  await serveExchange(page);
  await page.route('**/config.json', (route) =>
    route.fulfill({ json: { network: 'stagenet', relayUrl: '', pairs: ['twETH/twBTC', 'twUSDM/twUSDC'] } }),
  );
  await page.goto('/#markets');
  await expect(page.getByTestId('market-feed-status')).toHaveAttribute('data-status', 'ready');
  expect(
    await page
      .locator('[data-testid=market-row]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-pair') ?? '')),
  ).toEqual(['twETH/twBTC', 'twUSDM/twUSDC']);
});
