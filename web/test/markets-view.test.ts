// Plan L-MKT.3: what the Markets page shows for each state, cell by cell, one row per listed pair.

import { describe, expect, it } from 'vitest';

import {
  NETWORK_DEFAULT_PAIRS,
  type FeedState,
  ChartStatsSchema,
  PairsSchema,
  deriveMarkets,
  parseOffersPage,
  resolvePairs,
  stagenetRegistry,
} from '@nightmarket/core';

import { BOOK, PAIRS, STATS, type PairId } from '../../packages/core/test/fixtures/kernel/book.js';
import { STATUS_TEXT, bookLines, depthText, ignoredText, marketRows, spreadText } from '../src/market/view.js';

const registry = stagenetRegistry();
const listed = resolvePairs(registry, undefined, NETWORK_DEFAULT_PAIRS.stagenet).pairs;
const pairRows = PairsSchema.parse(PAIRS);
const snapshot = deriveMarkets(parseOffersPage({ offers: BOOK, nextCursor: null }).offers, registry, listed, (p) => ({
  pairs: pairRows,
  stats: ChartStatsSchema.parse(STATS[p.id as PairId]),
}));
const ready: FeedState = {
  status: 'ready',
  snapshot,
  complete: true,
  skipped: 0,
  tradeDataOk: true,
  updatedAt: 0,
  stream: 'live',
};
const market = (id: string) => snapshot.markets.find((m) => m.pair.id === id)!;

describe('the markets table', () => {
  it('shows bid, ask, last trade, offers per side and status for each pair, none special', () => {
    const rows = marketRows(ready, listed).map(({ baseName: _n, ...r }) => r);
    expect(rows).toEqual([
      {
        pair: 'twBTC/twUSDC',
        base: 'twBTC',
        quote: 'twUSDC',
        bestBid: 'no bids',
        bestAsk: '60,000.00',
        lastTrade: 'no trades yet',
        lastTradeAt: null,
        bids: '0',
        asks: '2',
        status: 'asks-only',
      },
      {
        pair: 'twETH/twUSDC',
        base: 'twETH',
        quote: 'twUSDC',
        bestBid: 'no bids',
        bestAsk: 'no asks',
        lastTrade: '2,500.00',
        lastTradeAt: '2026-09-27 10:00 UTC',
        bids: '0',
        asks: '0',
        status: 'no-liquidity',
      },
      {
        pair: 'twUSDM/twUSDC',
        base: 'twUSDM',
        quote: 'twUSDC',
        bestBid: '0.95',
        bestAsk: '1.05',
        lastTrade: '1.02',
        lastTradeAt: '2026-09-27 11:00 UTC',
        bids: '2',
        asks: '2',
        status: 'two-sided',
      },
      {
        pair: 'twETH/twBTC',
        base: 'twETH',
        quote: 'twBTC',
        bestBid: '0.04',
        bestAsk: 'no asks',
        lastTrade: 'no trades yet',
        lastTradeAt: null,
        bids: '1',
        asks: '0',
        status: 'bids-only',
      },
    ]);
    expect(marketRows(ready, listed)[0]!.baseName).toBe('Test-wrapped BTC');
    expect(STATUS_TEXT['no-liquidity']).toBe('No liquidity');
  });

  it('keeps only the pairs the asset filter shows both tokens of', () => {
    const shown = new Set(['twETH', 'twBTC']);
    const rows = marketRows(ready, listed, (a, b) => shown.has(a.symbol) && shown.has(b.symbol));
    expect(rows.map((r) => r.pair)).toEqual(['twETH/twBTC']);
  });

  it('shows "exchange unavailable" on every row, with no price at all', () => {
    const rows = marketRows(
      { status: 'unavailable', reason: 'the exchange did not answer', since: 0, lastUpdatedAt: 0, stream: 'polling' },
      listed,
    );
    expect(rows.map((r) => r.status)).toEqual(Array.from({ length: 4 }, () => 'unavailable'));
    expect(rows.every((r) => r.bestBid === '—' && r.bestAsk === '—' && r.lastTrade === '—')).toBe(true);
    expect(STATUS_TEXT.unavailable).toBe('Exchange unavailable');
  });

  it('lists the pairs while loading', () => {
    expect(marketRows({ status: 'loading', stream: 'connecting' }, listed).map((r) => [r.pair, r.status])).toEqual([
      ['twBTC/twUSDC', 'loading'],
      ['twETH/twUSDC', 'loading'],
      ['twUSDM/twUSDC', 'loading'],
      ['twETH/twBTC', 'loading'],
    ]);
  });

  it('says how many offers it did not price', () => {
    expect(ignoredText(ready)).toMatch(
      /^5 other offers on the exchange are not one token against another of a listed pair/,
    );
  });
});

describe('the book of one pair', () => {
  it('asks cheapest first and bids dearest first, with exact quantities and totals', () => {
    const a = market('twUSDM/twUSDC');
    expect(bookLines(a, 'asks').map(({ offerId: _o, ...l }) => l)).toEqual([
      { price: '1.05', quantity: '10.00', total: '10.50' },
      { price: '1.10', quantity: '20.00', total: '22.00' },
    ]);
    expect(bookLines(a, 'bids').map(({ offerId: _o, ...l }) => l)).toEqual([
      { price: '0.95', quantity: '10.00', total: '9.50' },
      { price: '0.90', quantity: '5.00', total: '4.50' },
    ]);
    expect(spreadText(a)).toBe('0.10');
    expect(depthText(a, 'asks')).toBe('30.00 twUSDM for 32.50 twUSDC');
    expect(depthText(a, 'bids')).toBe('15.00 twUSDM for 14.00 twUSDC');
  });

  it('prices a pair of 8- and 6-decimal tokens, and one without twUSDC, the same way', () => {
    const btc = market('twBTC/twUSDC');
    expect(spreadText(btc)).toBeNull();
    expect(bookLines(btc, 'asks')).toEqual([
      expect.objectContaining({ price: '60,000.00', quantity: '0.50', total: '30,000.00' }),
      expect.objectContaining({ price: '65,000.00', quantity: '0.25', total: '16,250.00' }),
    ]);
    const eth = market('twETH/twBTC');
    expect(bookLines(eth, 'bids')).toEqual([
      expect.objectContaining({ price: '0.04', quantity: '1.00', total: '0.04' }),
    ]);
    expect(depthText(eth, 'bids')).toBe('1.00 twETH for 0.04 twBTC');
  });
});
