// What the Markets page shows, as plain text per cell: a pure function of the feed's state, so
// the wording ("no liquidity", "exchange unavailable", "no bids") is unit-tested in one place.
// One row per listed pair; no token is special (AA 00047).

import {
  type BookEntry,
  type FeedState,
  type LastTrade,
  type Market,
  type MarketPair,
  type Ratio,
  type TokenEntry,
  formatPrice,
  formatUnits,
} from '@nightmarket/core';

export type MarketStatus = 'two-sided' | 'bids-only' | 'asks-only' | 'no-liquidity' | 'unavailable' | 'loading';

export const STATUS_TEXT: Record<MarketStatus, string> = {
  'two-sided': 'Two-sided',
  'bids-only': 'Bids only',
  'asks-only': 'Asks only',
  'no-liquidity': 'No liquidity',
  unavailable: 'Exchange unavailable',
  loading: 'Loading…',
};

export interface MarketRowView {
  /** The pair, `BASE/QUOTE` (twBTC/twUSDC). */
  pair: string;
  /** The base token's symbol (what the row buys or sells) and the quote's (what prices are in). */
  base: string;
  quote: string;
  /** The base token's full name ("Test-wrapped BTC"). */
  baseName: string;
  bestBid: string;
  bestAsk: string;
  lastTrade: string;
  lastTradeAt: string | null;
  bids: string;
  asks: string;
  status: MarketStatus;
}

/** Asks round up, bids down: a shown price never flatters the offer. */
export const askText = (r: Ratio) => formatPrice(r, { round: 'up' }).text;
export const bidText = (r: Ratio) => formatPrice(r, { round: 'down' }).text;

export function lastTradeText(t: LastTrade): string {
  if (t.state === 'trade') return formatPrice(t.price, { round: 'nearest' }).text;
  return t.state === 'none' ? 'no trades yet' : '—';
}

/** "2026-09-27 11:00 UTC" (the kernel's fill time is UTC). */
export function whenText(iso: string | null): string | null {
  if (iso === null) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return `${new Date(t).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

export function marketStatus(m: Market): MarketStatus {
  if (m.status === 'no-liquidity') return 'no-liquidity';
  if (m.bids.count > 0 && m.asks.count > 0) return 'two-sided';
  return m.bids.count > 0 ? 'bids-only' : 'asks-only';
}

export function marketRow(m: Market): MarketRowView {
  return {
    pair: m.pair.id,
    base: m.base.symbol,
    quote: m.quote.symbol,
    baseName: m.base.name,
    bestBid: m.bids.best ? bidText(m.bids.best.price) : 'no bids',
    bestAsk: m.asks.best ? askText(m.asks.best.price) : 'no asks',
    lastTrade: lastTradeText(m.lastTrade),
    lastTradeAt: m.lastTrade.state === 'trade' ? whenText(m.lastTrade.at) : null,
    bids: String(m.bids.count),
    asks: String(m.asks.count),
    status: marketStatus(m),
  };
}

/** One row per listed pair, whatever the feed's state. `keep` decides from a pair's two tokens
 *  whether the page shows it (the asset filter's `showsPair`, which treats both the same; plan
 *  00042). */
export function marketRows(
  state: FeedState,
  pairs: readonly MarketPair[],
  keep: (a: TokenEntry, b: TokenEntry) => boolean = () => true,
): MarketRowView[] {
  if (state.status === 'ready') return state.snapshot.markets.filter((m) => keep(m.base, m.quote)).map(marketRow);
  const status: MarketStatus = state.status === 'unavailable' ? 'unavailable' : 'loading';
  return pairs
    .filter((p) => keep(p.base, p.quote))
    .map((p) => ({
      pair: p.id,
      base: p.base.symbol,
      quote: p.quote.symbol,
      baseName: p.base.name,
      bestBid: '—',
      bestAsk: '—',
      lastTrade: '—',
      lastTradeAt: null,
      bids: '—',
      asks: '—',
      status,
    }));
}

export interface BookLineView {
  offerId: string;
  price: string;
  /** Base quantity, whole tokens. */
  quantity: string;
  /** Quote paid (asks) or received (bids), whole tokens. */
  total: string;
}

export function bookLines(m: Market, side: 'asks' | 'bids'): BookLineView[] {
  const fmt = (e: BookEntry): BookLineView => ({
    offerId: e.offerId,
    price: side === 'asks' ? askText(e.price) : bidText(e.price),
    quantity: formatUnits(e.baseRaw, m.base.decimals, { minFractionDigits: 2, grouping: true }),
    total: formatUnits(e.quoteRaw, m.quote.decimals, { minFractionDigits: 2, grouping: true }),
  });
  return m[side].entries.map(fmt);
}

/** Best ask minus best bid, when both exist (exact; shown rounded up). */
export function spreadText(m: Market): string | null {
  const a = m.asks.best?.price;
  const b = m.bids.best?.price;
  if (!a || !b) return null;
  const num = a.num * b.den - b.num * a.den;
  const den = a.den * b.den;
  if (num < 0n) return `-${formatPrice({ num: -num, den }, { round: 'up' }).text}`; // a crossed book
  return formatPrice({ num, den }, { round: 'up' }).text;
}

/** The amount side of a depth line: "0.75 twBTC for 46,250.00 twUSDC". */
export function depthText(m: Market, side: 'asks' | 'bids'): string {
  const s = m[side];
  const base = formatUnits(s.depthBaseRaw, m.base.decimals, { minFractionDigits: 2, grouping: true });
  const quote = formatUnits(s.depthQuoteRaw, m.quote.decimals, { minFractionDigits: 2, grouping: true });
  return `${base} ${m.base.symbol} for ${quote} ${m.quote.symbol}`;
}

/** "N other offers are not one of the listed pairs" (baskets, unlisted tokens or pairs, …). */
export function ignoredText(state: FeedState): string | null {
  if (state.status !== 'ready') return null;
  const n = Object.values(state.snapshot.ignored).reduce((t, x) => t + (x ?? 0), 0);
  if (n === 0) return null;
  return `${n} other ${n === 1 ? 'offer' : 'offers'} on the exchange ${n === 1 ? 'is' : 'are'} not one token against another of a listed pair (a basket, an unshielded leg, an unlisted token or pair) and ${n === 1 ? 'is' : 'are'} not shown.`;
}
