// The price derivation, over fixtures. Every expected price is written out by hand (whole quote
// tokens per whole base token), never computed by the code under test. No token is special: the
// four stagenet default pairs, including one without twUSDC, go through the same code.

import { describe, expect, it } from 'vitest';

import {
  NETWORK_DEFAULT_PAIRS,
  type BookOfferInput,
  type MarketsSnapshot,
  type Ratio,
  classifyOffer,
  deriveLastTrade,
  deriveMarkets,
  formatPrice,
  makePair,
  parseDecimalRatio,
  parseOffersPage,
  registryFromConfig,
  resolvePairs,
  stagenetRegistry,
  wholeFromRaw,
  PairsSchema,
  ChartStatsSchema,
} from '../src/index.js';
import {
  BOOK,
  COLOUR,
  EXPECTED,
  PAIRS,
  PAIR_IDS,
  STATS,
  leg,
  offerRow,
  type PairId,
  type WireOffer,
} from './fixtures/kernel/book.js';

const registry = stagenetRegistry();
const listed = resolvePairs(registry, undefined, NETWORK_DEFAULT_PAIRS.stagenet).pairs;
const rows = (offers: WireOffer[]): BookOfferInput[] => parseOffersPage({ offers, nextCursor: null }).offers;
const price = (r: Ratio | undefined, round: 'down' | 'up' | 'nearest' = 'down') =>
  r === undefined ? null : formatPrice(r, { round }).text;
const pairs = PairsSchema.parse(PAIRS);
const stats = (k: PairId) => ChartStatsSchema.parse(STATS[k]);
const market = (snap: MarketsSnapshot, id: string) => snap.markets.find((m) => m.pair.id === id)!;
const pairById = (id: PairId) => listed.find((p) => p.id === id)!;

describe('classifying one live offer', () => {
  const one = (o: WireOffer) => classifyOffer(rows([o])[0]!, registry, listed);

  it("an ask gives the pair's base and wants its quote, priced want ÷ give", () => {
    const c = one(offerRow(1, [leg(COLOUR.twUSDM, 10_000_000)], [leg(COLOUR.twUSDC, 10_500_000)]));
    expect(c.kind).toBe('priced');
    if (c.kind !== 'priced') return;
    expect(c.entry.side).toBe('ask');
    expect(c.pair.id).toBe('twUSDM/twUSDC');
    expect([c.entry.baseRaw, c.entry.quoteRaw]).toEqual([10_000_000n, 10_500_000n]);
    expect(price(c.entry.price)).toBe('1.05');
  });

  it("a bid gives the pair's quote and wants its base, priced give ÷ want", () => {
    const c = one(offerRow(2, [leg(COLOUR.twUSDC, 9_500_000)], [leg(COLOUR.twUSDM, 10_000_000)]));
    expect(c.kind === 'priced' && c.entry.side).toBe('bid');
    if (c.kind === 'priced') expect(price(c.entry.price)).toBe('0.95');
  });

  it('prices a pair without twUSDC exactly like any other (twETH/twBTC, 18 and 8 decimals)', () => {
    // 1 twETH (10^18) wanted for 0.04 twBTC (4·10^6): a bid at 0.04 twBTC per twETH.
    const bid = one(offerRow(7, [leg(COLOUR.twBTC, 4_000_000)], [leg(COLOUR.twETH, 10n ** 18n)]));
    expect(bid.kind === 'priced' && [bid.pair.id, bid.entry.side, price(bid.entry.price)]).toEqual([
      'twETH/twBTC',
      'bid',
      '0.04',
    ]);
    // 2.5 twETH given for 0.1 twBTC: an ask at 0.04.
    const ask = one(offerRow(8, [leg(COLOUR.twETH, 25n * 10n ** 17n)], [leg(COLOUR.twBTC, 10_000_000)]));
    expect(ask.kind === 'priced' && [ask.entry.side, price(ask.entry.price, 'up')]).toEqual(['ask', '0.04']);
  });

  it.each([
    ['basket', offerRow(8, [leg(COLOUR.twETH, 1), leg(COLOUR.twBTC, 1)], [leg(COLOUR.twUSDC, 2)])],
    ['basket', offerRow(8, [leg(COLOUR.twUSDC, 2)], [leg(COLOUR.twETH, 1), leg(COLOUR.twETH, 1)])],
    ['not-a-pair', offerRow(7, [leg(COLOUR.twUSDM, 5)], [leg(COLOUR.twBTC, 5)])],
    ['not-a-pair', offerRow(12, [leg(COLOUR.twUSDC, 1)], [leg(COLOUR.twUSDC, 2)])],
    ['unshielded', offerRow(9, [leg(COLOUR.twETH, 1)], [leg(COLOUR.twUSDC, 1, 'UNSHIELDED')])],
    ['unshielded', offerRow(9, [leg(COLOUR.twETH, 1, 'UNSHIELDED')], [leg(COLOUR.twUSDC, 1)])],
    ['unshielded', offerRow(11, [leg(COLOUR.NIGHT, 1, 'UNSHIELDED')], [leg(COLOUR.twUSDC, 1)])],
    ['unknown-token', offerRow(10, [leg(COLOUR.twETH, 1)], [leg(COLOUR.UNLISTED, 1)])],
    ['unknown-token', offerRow(10, [leg(COLOUR.UNLISTED, 1)], [leg(COLOUR.twUSDM, 1)])],
    ['unknown-token', offerRow(10, [leg('not-a-colour', 1)], [leg(COLOUR.twUSDM, 1)])],
    // A listed token that cannot trade (unshielded in the registry) is never part of a pair.
    ['not-a-pair', offerRow(10, [leg(COLOUR.utwUSDC, 1)], [leg(COLOUR.twUSDM, 1)])],
    ['zero-amount', offerRow(13, [leg(COLOUR.twUSDM, 0)], [leg(COLOUR.twUSDC, 1)])],
    ['zero-amount', offerRow(13, [leg(COLOUR.twUSDC, 1)], [leg(COLOUR.twUSDM, 0)])],
    ['one-sided', offerRow(14, [leg(COLOUR.twUSDM, 1)], [])],
    ['one-sided', offerRow(14, [], [leg(COLOUR.twUSDC, 1)])],
  ] as const)('ignores %s offers', (reason, o) => {
    expect(one(o)).toEqual({ kind: 'ignored', reason });
  });

  it('reads colours in any case (the kernel serves lowercase; the registry normalises)', () => {
    const c = one(offerRow(1, [leg(COLOUR.twUSDM.toUpperCase(), 1_000_000)], [leg(COLOUR.twUSDC, 2_000_000)]));
    expect(c.kind === 'priced' && price(c.entry.price)).toBe('2.00');
  });

  it('a pair that is not listed is not priced, even between two tradable tokens', () => {
    const onlyBtc = [makePair(registry, 'twBTC', 'twUSDC')];
    const c = classifyOffer(
      rows([offerRow(1, [leg(COLOUR.twUSDM, 1)], [leg(COLOUR.twUSDC, 1)])])[0]!,
      registry,
      onlyBtc,
    );
    expect(c).toEqual({ kind: 'ignored', reason: 'not-a-pair' });
  });
});

describe('the markets from a book', () => {
  const snap = deriveMarkets(rows(BOOK), registry, listed, (p) => ({ pairs, stats: stats(p.id as PairId) }));

  it('lists every configured pair, in the list order', () => {
    expect(snap.markets.map((m) => [m.base.symbol, m.quote.symbol])).toEqual([
      ['twBTC', 'twUSDC'],
      ['twETH', 'twUSDC'],
      ['twUSDM', 'twUSDC'],
      ['twETH', 'twBTC'],
    ]);
    expect(snap.markets.map((m) => m.pair.id)).toEqual([...PAIR_IDS]);
  });

  it('both sides: best ask is the lowest ask, best bid the highest bid, with counts and depth', () => {
    const a = market(snap, 'twUSDM/twUSDC');
    const want = EXPECTED['twUSDM/twUSDC'];
    expect(a.status).toBe('live');
    expect(price(a.asks.best?.price, 'up')).toBe(want.bestAsk);
    expect(price(a.bids.best?.price)).toBe(want.bestBid);
    expect([a.bids.count, a.asks.count]).toEqual([want.bids, want.asks]);
    expect(a.asks.entries.map((e) => price(e.price, 'up'))).toEqual(['1.05', '1.10']);
    expect(a.bids.entries.map((e) => price(e.price))).toEqual(['0.95', '0.90']);
    expect([a.asks.depthBaseRaw, a.asks.depthQuoteRaw]).toEqual([30_000_000n, 32_500_000n]);
    expect([a.bids.depthBaseRaw, a.bids.depthQuoteRaw]).toEqual([15_000_000n, 14_000_000n]);
  });

  it('asks only: the ask shows and there is no bid (8 and 6 decimals)', () => {
    const c = market(snap, 'twBTC/twUSDC');
    expect(c.status).toBe('live');
    expect(price(c.asks.best?.price, 'up')).toBe(EXPECTED['twBTC/twUSDC'].bestAsk);
    expect(c.asks.entries.map((e) => price(e.price, 'up'))).toEqual(['60,000.00', '65,000.00']);
    expect(c.bids.best).toBeNull();
    expect([c.bids.count, c.asks.count]).toEqual([0, 2]);
    expect([c.asks.depthBaseRaw, c.asks.depthQuoteRaw]).toEqual([75_000_000n, 46_250_000_000n]);
  });

  it('bids only, on the pair without twUSDC', () => {
    const e = market(snap, 'twETH/twBTC');
    expect(e.status).toBe('live');
    expect(price(e.bids.best?.price)).toBe(EXPECTED['twETH/twBTC'].bestBid);
    expect(e.asks.best).toBeNull();
  });

  it('a pair with no live offer has no liquidity, whatever else is on the exchange', () => {
    const b = market(snap, 'twETH/twUSDC');
    expect(b.status).toBe('no-liquidity');
    expect(b.asks.count + b.bids.count).toBe(0);
    expect(deriveMarkets([], registry, listed).markets.every((m) => m.status === 'no-liquidity')).toBe(true);
  });

  it('counts what it ignored, and never prices it', () => {
    expect(snap.ignored).toEqual({ 'not-a-pair': 1, basket: 1, unshielded: 2, 'unknown-token': 1 });
    expect(snap.offersSeen).toBe(BOOK.length);
  });

  it('counts a repeated offer once', () => {
    const s = deriveMarkets(rows([BOOK[BOOK.length - 1]!, BOOK[BOOK.length - 1]!]), registry, listed);
    expect(market(s, 'twUSDM/twUSDC').asks.count).toBe(1);
    expect(s.ignored.duplicate).toBe(1);
  });

  it('orders equal prices by offer id, so the book is stable', () => {
    const s = deriveMarkets(
      rows([
        offerRow(21, [leg(COLOUR.twUSDM, 2_000_000)], [leg(COLOUR.twUSDC, 2_000_000)]),
        offerRow(20, [leg(COLOUR.twUSDM, 1_000_000)], [leg(COLOUR.twUSDC, 1_000_000)]),
      ]),
      registry,
      listed,
    );
    const ids = market(s, 'twUSDM/twUSDC').asks.entries.map((e) => e.offerId);
    expect(ids).toEqual([...ids].sort());
  });

  it('a pair listed the other way round is the same market, priced in its own quote', () => {
    const flipped = [makePair(registry, 'twUSDC', 'twUSDM')];
    const s = deriveMarkets(rows(BOOK), registry, flipped);
    const m = market(s, 'twUSDC/twUSDM');
    // The twUSDM asks at 1.05 and 1.10 are twUSDC bids at 1/1.05 and 1/1.10.
    expect(m.bids.entries.map((e) => price(e.price))).toEqual(['0.95238', '0.90909']);
    expect(m.asks.entries.map((e) => price(e.price, 'up'))).toEqual(['1.052632', '1.111112']);
  });
});

describe('0-, 6- and 18-decimal maths', () => {
  const colour = (c: string) => c.repeat(64);
  const reg = registryFromConfig('undeployed', {
    tokens: [
      { symbol: 'Q6', decimals: 6, midnightColour: colour('c') },
      { symbol: 'E18', decimals: 18, midnightColour: colour('a') },
      { symbol: 'TINY', decimals: 0, midnightColour: colour('e') },
      { symbol: 'Q18', decimals: 18, midnightColour: colour('1') },
      { symbol: 'S6', decimals: 6, midnightColour: colour('b') },
    ],
  });
  const e18 = makePair(reg, 'E18', 'Q6');
  const tiny = makePair(reg, 'TINY', 'Q6');
  // Q18's colour sorts first here, so the kernel would orient this pair with the QUOTE as the base.
  const s6 = makePair(reg, 'S6', 'Q18');
  const all = [e18, tiny, s6];

  it('prices an 18-decimal base against a 6-decimal quote exactly', () => {
    // 2 whole (2e18 base units) for 3000 (3e9 base units) = 1500 each.
    const s = deriveMarkets(
      rows([offerRow(1, [leg(colour('a'), 2n * 10n ** 18n)], [leg(colour('c'), 3_000_000_000n)])]),
      reg,
      all,
    );
    expect(price(market(s, 'E18/Q6').asks.best?.price, 'up')).toBe('1,500.00');
    // 1 base unit wanted for 0.000001 of the quote: 10^12 each.
    const t = deriveMarkets(rows([offerRow(2, [leg(colour('c'), 1)], [leg(colour('a'), 1)])]), reg, all);
    expect(market(t, 'E18/Q6').bids.best?.price).toEqual({ num: 10n ** 12n, den: 1n });
  });

  it('prices a 6-decimal base against an 18-decimal quote exactly', () => {
    // 10 (10e6) for 10.5 (10.5e18) = 1.05.
    const s = deriveMarkets(
      rows([offerRow(1, [leg(colour('b'), 10_000_000)], [leg(colour('1'), 105n * 10n ** 17n)])]),
      reg,
      all,
    );
    expect(price(market(s, 'S6/Q18').asks.best?.price, 'up')).toBe('1.05');
  });

  it('prices a 0-decimal base', () => {
    const s = deriveMarkets(rows([offerRow(1, [leg(colour('e'), 3)], [leg(colour('c'), 1_000_000)])]), reg, all);
    expect(price(market(s, 'TINY/Q6').asks.best?.price, 'up')).toBe('0.333334');
    expect(price(market(s, 'TINY/Q6').asks.best?.price, 'down')).toBe('0.333333');
  });

  it("converts a raw last-trade ratio with each side's decimals, in both orientations", () => {
    // 18-dp base at 1500: raw ratio quote/base = 1.5e-9, as a JSON number from chart stats.
    const row = {
      pair_key: 'x',
      base_color: colour('a'),
      quote_color: colour('c'),
      trade_count: 1,
      last_price: '0.0000000015',
      last_traded_at: null,
      open_count: 0,
    };
    const lt = deriveLastTrade(e18, {
      pairs: [row],
      stats: ChartStatsSchema.parse({ base: colour('a'), quote: colour('c'), last: 1.5e-9, volume_base: 1 }),
    });
    expect(lt).toMatchObject({ state: 'trade', source: 'chart-stats', price: { num: 1500n, den: 1n } });
    // The same from the pair list alone, and from a pair oriented the other way (the quote as base).
    const pairOnly = deriveLastTrade(e18, { pairs: [row], stats: null });
    expect(pairOnly).toMatchObject({ state: 'trade', source: 'pairs', price: { num: 1500n, den: 1n } });
    const flipped = deriveLastTrade(s6, {
      pairs: [
        {
          pair_key: 'x',
          base_color: colour('1'), // LEAST colour: the quote is the kernel's base, so last_price = base raw ÷ quote raw
          quote_color: colour('b'),
          trade_count: 2,
          last_price: '0.00000000000095238095238095238095', // 10e6 of S6 per 10.5e18 of Q18
          last_traded_at: null,
          open_count: 0,
        },
      ],
      stats: null,
    });
    expect(flipped.state === 'trade' && formatPrice(flipped.price, { round: 'nearest' }).text).toBe('1.05');
  });
});

describe('the last trade (fills only, never the book)', () => {
  it('takes the chart stats, already oriented to the pair', () => {
    expect(deriveLastTrade(pairById('twUSDM/twUSDC'), { pairs, stats: stats('twUSDM/twUSDC') })).toEqual({
      state: 'trade',
      price: { num: 51n, den: 50n },
      source: 'chart-stats',
      at: '2026-09-27T11:00:00.000Z',
    });
  });

  it('falls back to the pair list, with 18- and 6-decimal legs', () => {
    const lt = deriveLastTrade(pairById('twETH/twUSDC'), { pairs, stats: null });
    expect(lt.state === 'trade' && lt.source).toBe('pairs');
    expect(lt.state === 'trade' && formatPrice(lt.price, { round: 'nearest' }).text).toBe(
      EXPECTED['twETH/twUSDC'].last,
    );
    // With the stats available (an old fill: zero volume, but the pair list proves it), the same.
    const exact = deriveLastTrade(pairById('twETH/twUSDC'), { pairs, stats: stats('twETH/twUSDC') });
    expect(exact.state === 'trade' && formatPrice(exact.price).text).toBe('2,500.00');
  });

  it("never shows the kernel's open-book mid as a trade", () => {
    // twBTC/twUSDC never filled: the pair list says so, and the stats' `last` (600 raw) is the mid.
    const btc = pairById('twBTC/twUSDC');
    expect(deriveLastTrade(btc, { pairs, stats: stats('twBTC/twUSDC') })).toEqual({ state: 'none' });
    // Without the pair list, a zero-volume stats `last` proves nothing.
    expect(deriveLastTrade(btc, { pairs: null, stats: stats('twBTC/twUSDC') })).toEqual({ state: 'unknown' });
    // … but 24 h volume does.
    expect(deriveLastTrade(pairById('twUSDM/twUSDC'), { pairs: null, stats: stats('twUSDM/twUSDC') })).toMatchObject({
      state: 'trade',
    });
  });

  it('a pair the kernel has never seen has no trade; no data at all is unknown', () => {
    const e = pairById('twETH/twBTC');
    expect(deriveLastTrade(e, { pairs, stats: stats('twETH/twBTC') })).toEqual({ state: 'none' });
    expect(deriveLastTrade(e, { pairs: [], stats: null })).toEqual({ state: 'none' });
    expect(deriveLastTrade(e, { pairs: null, stats: null })).toEqual({ state: 'unknown' });
  });

  it('reads the staging kernel\'s captured "no data" answers as no trade', async () => {
    const { readFile } = await import('node:fs/promises');
    const dir = new URL('./fixtures/kernel/staging-2026-09-27/', import.meta.url);
    const p = PairsSchema.parse(JSON.parse(await readFile(new URL('pairs.json', dir), 'utf8')));
    const s = ChartStatsSchema.parse(JSON.parse(await readFile(new URL('chart-stats-wstka-wusdc.json', dir), 'utf8')));
    const any = pairById('twBTC/twUSDC');
    expect(deriveLastTrade(any, { pairs: p, stats: s })).toEqual({ state: 'none' });
    expect(deriveLastTrade(any, { pairs: null, stats: s })).toEqual({ state: 'unknown' });
  });
});

describe('decimal parsing and display', () => {
  it("parses the kernel's decimal texts exactly", () => {
    expect(parseDecimalRatio('1.05000000000000000000')).toEqual({ num: 21n, den: 20n });
    expect(parseDecimalRatio('0.0104')).toEqual({ num: 13n, den: 1250n });
    expect(parseDecimalRatio('1.5e-9')).toEqual({ num: 3n, den: 2_000_000_000n });
    expect(parseDecimalRatio('12')).toEqual({ num: 12n, den: 1n });
    expect(parseDecimalRatio('2E+3')).toEqual({ num: 2000n, den: 1n });
    expect(parseDecimalRatio('0')).toEqual({ num: 0n, den: 1n });
    for (const bad of ['', '-1', '1.', '.5', 'NaN', 'Infinity', '1,5', '0x10', '1e']) {
      expect(() => parseDecimalRatio(bad), bad).toThrow(RangeError);
    }
  });

  it('rounds asks up, bids down and last trades to the nearest', () => {
    const third = { num: 1n, den: 3n };
    const twoThirds = { num: 2n, den: 3n };
    expect(formatPrice(third, { round: 'up' })).toEqual({ text: '0.333334', exact: false });
    expect(formatPrice(third, { round: 'down' })).toEqual({ text: '0.333333', exact: false });
    expect(formatPrice(twoThirds, { round: 'nearest' }).text).toBe('0.666667');
    expect(formatPrice({ num: 21n, den: 20n }, { round: 'up' })).toEqual({ text: '1.05', exact: true });
    expect(formatPrice({ num: 1234567n, den: 1n })).toEqual({ text: '1,234,567.00', exact: true });
    expect(formatPrice({ num: 1n, den: 3n }, { maxDigits: 2, round: 'up' }).text).toBe('0.34');
  });

  it('converts raw ratios with decimals', () => {
    expect(wholeFromRaw({ num: 3n, den: 2_000_000_000n }, 18, 6)).toEqual({ num: 1500n, den: 1n });
  });
});
