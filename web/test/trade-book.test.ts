// AA 00060 FR-026 / FR-027 (plan P14): the Trade page's one view of a pair, its pure rules
// (../src/trade/book-view.ts). Each half of the book has a create row whose offer is listed in the
// OTHER half; the legs are exactly the make's (`orderLegs`); "Use the best price" joins the book; your
// own live offer offers "Cancel your offer", never a take (P14.0, questions Q9). Every rule is checked
// on more than one pair, and on pairs without twBTC or twUSDC: no token is special.

import { describe, expect, it } from 'vitest';

import {
  NETWORK_DEFAULT_PAIRS,
  ChartStatsSchema,
  PairsSchema,
  classifyOffer,
  deriveMarkets,
  fundWithOneCoin,
  orderLegs,
  parseOffersPage,
  parsePrice,
  parseUnits,
  resolvePairs,
  stagenetRegistry,
  type MarketPair,
  type StoredCoin,
  type TradeSide,
} from '@nightmarket/core';

import { BOOK, PAIRS, STATS, type PairId } from '../../packages/core/test/fixtures/kernel/book.js';
import { askText, bidText } from '../src/market/view.js';
import * as bookView from '../src/trade/book-view.js';
import {
  CREATE_ROW,
  SELF_TAKE_SUPPORTED,
  bestPriceText,
  bookTitle,
  createRowHalf,
  createRowHint,
  createRowLabel,
  givenToken,
  halfHeading,
  listedUnder,
  rowAction,
  type BookHalf,
} from '../src/trade/book-view.js';

const registry = stagenetRegistry();
const listed = resolvePairs(registry, undefined, NETWORK_DEFAULT_PAIRS.stagenet).pairs;
const pairRows = PairsSchema.parse(PAIRS);
const snapshot = deriveMarkets(parseOffersPage({ offers: BOOK, nextCursor: null }).offers, registry, listed, (p) => ({
  pairs: pairRows,
  stats: ChartStatsSchema.parse(STATS[p.id as PairId]),
}));
const pairOf = (id: string): MarketPair => listed.find((p) => p.id === id)!;
const marketOf = (id: string) => snapshot.markets.find((m) => m.pair.id === id)!;

/** Where the exchange lists an offer with these legs: classify it as the book does. */
function halfListing(
  pair: MarketPair,
  give: { colour: string; amount: bigint },
  want: { colour: string; amount: bigint },
) {
  const c = classifyOffer(
    {
      offerId: 'ff'.repeat(32),
      computed: {
        gives: [{ token: give.colour, amount: give.amount, type: 'SHIELDED' }],
        wants: [{ token: want.colour, amount: want.amount, type: 'SHIELDED' }],
      },
    },
    registry,
    listed,
  );
  if (c.kind !== 'priced') throw new Error(`not priced: ${c.reason}`);
  expect(c.pair.id).toBe(pair.id);
  return { half: (c.entry.side === 'ask' ? 'asks' : 'bids') as BookHalf, entry: c.entry };
}

describe('FR-026: the one view of a pair', () => {
  it('titles the book "Order book <base> ⇄ <quote>" and heads each half with the base', () => {
    const btc = pairOf('twBTC/twUSDC');
    expect(bookTitle(btc)).toBe('Order book twBTC ⇄ twUSDC');
    expect(halfHeading('asks', btc)).toEqual({ who: 'Sellers', you: '— you buy twBTC' });
    expect(halfHeading('bids', btc)).toEqual({ who: 'Buyers', you: '— you sell twBTC' });
    const eth = pairOf('twETH/twBTC');
    expect(bookTitle(eth)).toBe('Order book twETH ⇄ twBTC');
    expect(halfHeading('asks', eth).you).toBe('— you buy twETH');
  });

  it('puts "Sell <quote>" under Sellers and "Sell <base>" under Buyers (the spec rule; questions Q10)', () => {
    expect(CREATE_ROW).toEqual({ asks: 'buy', bids: 'sell' });
    for (const [id, underSellers, underBuyers] of [
      ['twBTC/twUSDC', 'Sell twUSDC', 'Sell twBTC'],
      ['twETH/twBTC', 'Sell twBTC', 'Sell twETH'],
      ['twUSDM/twUSDC', 'Sell twUSDC', 'Sell twUSDM'],
    ] as const) {
      const pair = pairOf(id);
      expect(createRowLabel(CREATE_ROW.asks, pair)).toBe(underSellers);
      expect(createRowLabel(CREATE_ROW.bids, pair)).toBe(underBuyers);
      expect(createRowHalf(CREATE_ROW.asks)).toBe('asks');
      expect(createRowHalf(CREATE_ROW.bids)).toBe('bids');
    }
    const eth = pairOf('twETH/twBTC');
    expect(createRowHint('buy', eth)).toBe('Your own offer: buy twETH with twBTC at your price.');
    expect(createRowHint('sell', eth)).toBe('Your own offer: sell twETH for twBTC at your price.');
  });

  // Prices in the quote, as the page enters them: amount of the base, price per base.
  const CASES: Array<{
    pair: string;
    qty: string;
    price: string;
    give: Record<TradeSide, bigint>;
    want: Record<TradeSide, bigint>;
  }> = [
    // twETH/twBTC (18 / 8 decimals): 0.5 twETH at 0.04 twBTC = 0.02 twBTC.
    {
      pair: 'twETH/twBTC',
      qty: '0.5',
      price: '0.04',
      give: { sell: 500_000_000_000_000_000n, buy: 2_000_000n },
      want: { sell: 2_000_000n, buy: 500_000_000_000_000_000n },
    },
    // twUSDM/twUSDC (6 / 6): 10 twUSDM at 1.01 = 10.10 twUSDC.
    {
      pair: 'twUSDM/twUSDC',
      qty: '10',
      price: '1.01',
      give: { sell: 10_000_000n, buy: 10_100_000n },
      want: { sell: 10_100_000n, buy: 10_000_000n },
    },
    // twBTC/twUSDC (8 / 6): 0.05 twBTC at 60,000 = 3,000 twUSDC.
    {
      pair: 'twBTC/twUSDC',
      qty: '0.05',
      price: '60000',
      give: { sell: 5_000_000n, buy: 3_000_000_000n },
      want: { sell: 3_000_000_000n, buy: 5_000_000n },
    },
  ];

  for (const c of CASES) {
    it(`each create row gives what it says and is listed in the OTHER half (${c.pair})`, () => {
      const pair = pairOf(c.pair);
      for (const half of ['asks', 'bids'] as const) {
        const side = CREATE_ROW[half];
        const legs = orderLegs(
          side,
          pair.base,
          pair.quote,
          parseUnits(c.qty, pair.base.decimals),
          parsePrice(c.price, pair.quote),
        );
        // The row's label names the token it gives, and the legs give exactly that token.
        expect(legs.give.colour).toBe(givenToken(side, pair).midnightColour);
        expect(createRowLabel(side, pair)).toBe(`Sell ${givenToken(side, pair).symbol}`);
        expect(legs.give.amount).toBe(c.give[side]);
        expect(legs.want.amount).toBe(c.want[side]);
        // The exchange lists the offer by its legs: in the other half, at the price entered.
        const shown = halfListing(pair, legs.give, legs.want);
        expect(shown.half).toBe(listedUnder(side));
        expect(shown.half).not.toBe(half);
        expect(shown.entry.baseRaw).toBe(legs.baseRaw);
        expect(shown.entry.quoteRaw).toBe(legs.quoteRaw);
      }
    });
  }

  it('"Use the best price": a sell joins the best ask, a buy the best bid, else the other side, else nothing', () => {
    // twBTC/twUSDC has asks only (60,000.00 best); twETH/twBTC has buyers.
    const btc = marketOf('twBTC/twUSDC');
    expect(bestPriceText('sell', btc)).toBe('60,000.00');
    expect(bestPriceText('buy', btc)).toBe('60,000.00'); // no buyers: the best ask
    const eth = marketOf('twETH/twBTC');
    expect(eth.bids.best).not.toBeNull();
    expect(bestPriceText('buy', eth)).toBe(bidText(eth.bids.best!.price));
    expect(bestPriceText('sell', eth)).toBe(
      eth.asks.best ? askText(eth.asks.best.price) : bidText(eth.bids.best!.price),
    );
    expect(bestPriceText('sell', null)).toBeNull();
    expect(bestPriceText('buy', { asks: { ...btc.asks, best: null }, bids: { ...btc.bids, best: null } })).toBeNull();
  });

  it('a create row keeps the one-coin rule: an offer one coin cannot pay says why (Q9)', () => {
    const pair = pairOf('twETH/twBTC');
    const coin = (color: string, value: bigint): StoredCoin =>
      ({
        nonce: '01'.repeat(32),
        color,
        value: value.toString(),
        mtIndex: '1',
        commitment: 'c1'.repeat(32),
        spent: false,
      }) as StoredCoin;
    const coins = [coin(pair.quote.midnightColour, 1_000_000n), coin(pair.quote.midnightColour, 1_500_000n)];
    // "Sell twBTC" (a buy of 0.5 twETH at 0.04): 0.02 twBTC, more than any one coin (0.015).
    const legs = orderLegs('buy', pair.base, pair.quote, parseUnits('0.5', 18), parsePrice('0.04', pair.quote));
    const f = fundWithOneCoin(coins, legs.give, givenToken('buy', pair));
    expect(f.ok).toBe(false);
    if (!f.ok)
      expect(f.reason).toBe('Not enough twBTC in one coin. You hold 0.025 twBTC; one payment can use at most 0.015.');
  });
});

describe('FR-027: your own offer in the book', () => {
  const entry = { offerId: 'aa'.repeat(32) };
  const other = { offerId: 'bb'.repeat(32) };
  const make = { role: 'make' as const, offerId: entry.offerId };

  it('cannot be taken by your own account on this site (P14.0, questions Q9)', () => {
    expect(SELF_TAKE_SUPPORTED).toBe(false);
  });

  // Owner, questions Q9 (2026-10-05): no per-row "Cancel your offer" ("you cannot really cancel an order once
  // it's placed"). Your own offer, live or ended, is the badge and a note: no action at all.
  it('your own offer, live or ended, is "own" (the badge and the note, no action); anyone else’s a take', () => {
    expect(rowAction(entry, [make], { offerId: entry.offerId })).toBe('own');
    expect(rowAction(entry, [make], null)).toBe('own');
    expect(rowAction(entry, [make], { offerId: 'cc'.repeat(32) })).toBe('own');
    expect(rowAction(other, [make], { offerId: entry.offerId })).toBe('take');
    // An offer this account TOOK is not its own.
    expect(rowAction(entry, [{ role: 'take', offerId: entry.offerId }], null)).toBe('take');
  });

  it('says, in a short note, that you cannot take your own offer', () => {
    expect((bookView as Record<string, unknown>).OWN_OFFER_NOTE).toBe("You can't take your own offer.");
  });
});

describe('questions Q10: the book says which token the amounts and the prices are in', () => {
  it('"amounts in <base>, prices in <quote>"', () => {
    const meta = (bookView as Record<string, unknown>).bookMeta as
      ((p: { base: { symbol: string }; quote: { symbol: string } }) => string) | undefined;
    expect(typeof meta).toBe('function');
    expect(meta!({ base: { symbol: 'twUSDC' }, quote: { symbol: 'twBTC' } })).toBe(
      'amounts in twUSDC, prices in twBTC',
    );
  });
});
