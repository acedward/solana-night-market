// Prices for each configured pair, derived ONLY from the exchange's live offers.
//
// - Kept: offers with exactly one leg on each side, both SHIELDED, whose two tokens are a listed
//   pair (../tokens/pairs.ts), in either orientation. Baskets, unshielded legs, unknown colours and
//   two listed tokens that are not a listed pair are ignored (counted, never priced).
// - An ASK gives the pair's base and wants its quote; a BID gives the quote and wants the base. Both
//   are priced in whole tokens as quote ÷ base: an ask at want ÷ give, a bid at give ÷ want.
// - Best ask = the lowest ask; best bid = the highest bid. A pair with no live offer has
//   "no liquidity". Nothing is interpolated or invented: no mid, no reference price.
// - The last trade is the newest FILL: `/v1/chart/stats?base=<base>&quote=<quote>` (already
//   oriented to the pair), with `/v1/pairs` (oriented by colour hex) as the fallback. Both are
//   raw base-unit ratios; they are converted with each token's decimals. The kernel answers the
//   open-book MID as `last` for a pair that never filled, so a stats `last` counts only when a
//   fill is proven (the pair's `trade_count` > 0, or 24 h volume).
//
// No token is special (owner rule): every pair is handled by the same code.
// All amounts are bigint base units and all prices exact rationals (`Ratio`); no floats.

import { type Ratio, compareRatio, formatUnits, priceRatio } from '../amount.js';
import { type MarketPair, pairFor } from '../tokens/pairs.js';
import type { TokenEntry, TokenRegistry } from '../tokens/registry.js';
import type { ChartStats, OfferLeg, Pair } from './wire.js';

/** The fields of an offer the derivation reads (an `OfferRow` has them). */
export interface BookOfferInput {
  offerId: string;
  computed: {
    gives: readonly OfferLeg[];
    wants: readonly OfferLeg[];
    expiresAt?: string | null;
    firstSeenAt?: string | null;
  };
}

export type IgnoreReason =
  /** a side with no leg */
  | 'one-sided'
  /** more than one leg on a side */
  | 'basket'
  /** a leg that is not SHIELDED */
  | 'unshielded'
  /** a colour the market does not list */
  | 'unknown-token'
  /** two listed tokens that are not a listed pair (or the same token both ways) */
  | 'not-a-pair'
  /** a zero amount: no price */
  | 'zero-amount'
  /** the same offer id twice */
  | 'duplicate';

export type Side = 'ask' | 'bid';

export interface BookEntry {
  offerId: string;
  side: Side;
  /** The base leg, in the base token's base units. */
  baseRaw: bigint;
  /** The quote leg, in the quote token's base units. */
  quoteRaw: bigint;
  /** Whole quote tokens per whole base token. */
  price: Ratio;
  expiresAt: string | null;
  firstSeenAt: string | null;
}

export type Classified =
  { kind: 'priced'; pair: MarketPair; entry: BookEntry } | { kind: 'ignored'; reason: IgnoreReason };

/** Classify one live offer against the market's tokens and pairs. */
export function classifyOffer(
  offer: BookOfferInput,
  registry: TokenRegistry,
  pairs: readonly MarketPair[],
): Classified {
  const { gives, wants } = offer.computed;
  if (gives.length === 0 || wants.length === 0) return { kind: 'ignored', reason: 'one-sided' };
  if (gives.length > 1 || wants.length > 1) return { kind: 'ignored', reason: 'basket' };
  const give = gives[0]!;
  const want = wants[0]!;
  if (give.type !== 'SHIELDED' || want.type !== 'SHIELDED') return { kind: 'ignored', reason: 'unshielded' };
  if (!registry.byColour(give.token) || !registry.byColour(want.token))
    return { kind: 'ignored', reason: 'unknown-token' };
  const found = pairFor(pairs, give.token, want.token);
  if (!found) return { kind: 'ignored', reason: 'not-a-pair' };
  if (give.amount <= 0n || want.amount <= 0n) return { kind: 'ignored', reason: 'zero-amount' };
  const { pair, givesBase } = found;
  const side: Side = givesBase ? 'ask' : 'bid';
  const baseRaw = givesBase ? give.amount : want.amount;
  const quoteRaw = givesBase ? want.amount : give.amount;
  return {
    kind: 'priced',
    pair,
    entry: {
      offerId: offer.offerId,
      side,
      baseRaw,
      quoteRaw,
      price: reduce(priceRatio(quoteRaw, pair.quote.decimals, baseRaw, pair.base.decimals)),
      expiresAt: offer.computed.expiresAt ?? null,
      firstSeenAt: offer.computed.firstSeenAt ?? null,
    },
  };
}

// ── Last trade ─────────────────────────────────────────────────────────────

/** Parse a decimal text (as the kernel sends prices: "1.05", "0.0104", "1e-7") exactly. */
export function parseDecimalRatio(text: string): Ratio {
  const m = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text.trim());
  if (!m) throw new RangeError(`not a non-negative decimal: "${text}"`);
  const frac = m[2] ?? '';
  let num = BigInt(m[1]! + frac);
  let den = 10n ** BigInt(frac.length);
  const exp = Number(m[3] ?? '0');
  if (!Number.isSafeInteger(exp) || Math.abs(exp) > 400) throw new RangeError(`exponent out of range: "${text}"`);
  if (exp > 0) num *= 10n ** BigInt(exp);
  if (exp < 0) den *= 10n ** BigInt(-exp);
  return reduce({ num, den });
}

function gcd(a: bigint, b: bigint): bigint {
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

/** The ratio in lowest terms (display and equality are easier; comparisons never need it). */
export function reduce(r: Ratio): Ratio {
  if (r.num === 0n) return { num: 0n, den: 1n };
  const g = gcd(r.num, r.den);
  return { num: r.num / g, den: r.den / g };
}

/** A raw base-unit ratio quote ÷ base, as whole quote tokens per whole base token. */
export function wholeFromRaw(raw: Ratio, baseDecimals: number, quoteDecimals: number): Ratio {
  return reduce({ num: raw.num * 10n ** BigInt(baseDecimals), den: raw.den * 10n ** BigInt(quoteDecimals) });
}

export type LastTrade =
  /** The newest fill, whole quote tokens per whole base token. */
  | { state: 'trade'; price: Ratio; source: 'chart-stats' | 'pairs'; at: string | null }
  /** The pair has never filled. */
  | { state: 'none' }
  /** The exchange's trade data could not be read, or does not prove a fill. */
  | { state: 'unknown' };

export interface TradeData {
  /** `/v1/pairs`, or null when it failed. */
  pairs: readonly Pair[] | null;
  /** `/v1/chart/stats?base=<base>&quote=<quote>` for this pair, or null when it failed. */
  stats: ChartStats | null;
}

/** The last trade of a pair, from the kernel's fill data, never from the book. */
export function deriveLastTrade(pair: Pick<MarketPair, 'base' | 'quote'>, data: TradeData): LastTrade {
  const { base, quote } = pair;
  const s = base.midnightColour;
  const u = quote.midnightColour;
  const row =
    data.pairs?.find(
      (p) => (p.base_color === s && p.quote_color === u) || (p.base_color === u && p.quote_color === s),
    ) ?? null;
  const at = row?.last_traded_at ?? null;

  // Is a fill proven?
  let filled: boolean | null;
  if (data.pairs !== null) filled = row !== null && row.trade_count > 0 && row.last_price !== null;
  // Without the pair list, only 24 h volume proves a fill (a zero-volume `last` may be the mid).
  else if (data.stats !== null) filled = (safeRatio(data.stats.volume_base)?.num ?? 0n) > 0n ? true : null;
  else filled = null;
  if (filled === false) return { state: 'none' };
  if (filled === null) return { state: 'unknown' };

  // Primary: chart stats, oriented to the pair by the kernel.
  if (data.stats !== null && data.stats.base === s && data.stats.quote === u) {
    const raw = safeRatio(data.stats.last);
    if (raw && raw.num > 0n) {
      return { state: 'trade', price: wholeFromRaw(raw, base.decimals, quote.decimals), source: 'chart-stats', at };
    }
  }
  // Fallback: the pair row, oriented by colour hex (LEAST = base); re-orient to the pair's base.
  if (row !== null && row.last_price !== null) {
    const raw = safeRatio(row.last_price);
    if (raw && raw.num > 0n) {
      const quotePerBaseRaw = row.base_color === s ? raw : { num: raw.den, den: raw.num };
      return {
        state: 'trade',
        price: wholeFromRaw(quotePerBaseRaw, base.decimals, quote.decimals),
        source: 'pairs',
        at,
      };
    }
  }
  return { state: 'unknown' };
}

function safeRatio(text: string): Ratio | null {
  try {
    return parseDecimalRatio(text);
  } catch {
    return null;
  }
}

// ── Markets ────────────────────────────────────────────────────────────────

export interface SideSummary {
  /** Best first: asks ascending, bids descending; ties by offer id. */
  entries: BookEntry[];
  best: BookEntry | null;
  count: number;
  /** Sum of the base legs, base units. */
  depthBaseRaw: bigint;
  /** Sum of the quote legs, base units. */
  depthQuoteRaw: bigint;
}

export interface Market {
  pair: MarketPair;
  /** The pair's base token (what a buy gets, a sell gives). */
  base: TokenEntry;
  /** The pair's quote token (what prices are in). */
  quote: TokenEntry;
  asks: SideSummary;
  bids: SideSummary;
  lastTrade: LastTrade;
  /** 'no-liquidity' when the pair has no live offer at all. */
  status: 'live' | 'no-liquidity';
}

export interface MarketsSnapshot {
  /** One per listed pair, in the list's order. */
  markets: Market[];
  /** Offers seen but not priced, by reason. */
  ignored: Partial<Record<IgnoreReason, number>>;
  /** Live offers read from the exchange (priced + ignored). */
  offersSeen: number;
}

function summarise(entries: BookEntry[], side: Side): SideSummary {
  const sorted = [...entries].sort((a, b) => {
    const c = compareRatio(a.price, b.price);
    if (c !== 0) return side === 'ask' ? c : -c;
    return a.offerId < b.offerId ? -1 : a.offerId > b.offerId ? 1 : 0;
  });
  return {
    entries: sorted,
    best: sorted[0] ?? null,
    count: sorted.length,
    depthBaseRaw: sorted.reduce((t, e) => t + e.baseRaw, 0n),
    depthQuoteRaw: sorted.reduce((t, e) => t + e.quoteRaw, 0n),
  };
}

/**
 * Every listed pair's market, from the live offers and the fill data.
 * `trade(pair)` gives the fill data for one pair (null fields when the requests failed).
 */
export function deriveMarkets(
  offers: readonly BookOfferInput[],
  registry: TokenRegistry,
  pairs: readonly MarketPair[],
  trade: (pair: MarketPair) => TradeData = () => ({ pairs: null, stats: null }),
): MarketsSnapshot {
  const byPair = new Map<string, { asks: BookEntry[]; bids: BookEntry[] }>();
  for (const p of pairs) byPair.set(p.id, { asks: [], bids: [] });
  const ignored: Partial<Record<IgnoreReason, number>> = {};
  const seen = new Set<string>();
  for (const offer of offers) {
    const id = offer.offerId.toLowerCase();
    if (seen.has(id)) {
      ignored.duplicate = (ignored.duplicate ?? 0) + 1;
      continue;
    }
    seen.add(id);
    const c = classifyOffer(offer, registry, pairs);
    if (c.kind === 'ignored') {
      ignored[c.reason] = (ignored[c.reason] ?? 0) + 1;
      continue;
    }
    const book = byPair.get(c.pair.id)!;
    (c.entry.side === 'ask' ? book.asks : book.bids).push(c.entry);
  }
  const markets = pairs.map((pair): Market => {
    const book = byPair.get(pair.id)!;
    const asks = summarise(book.asks, 'ask');
    const bids = summarise(book.bids, 'bid');
    return {
      pair,
      base: pair.base,
      quote: pair.quote,
      asks,
      bids,
      lastTrade: deriveLastTrade(pair, trade(pair)),
      status: asks.count + bids.count === 0 ? 'no-liquidity' : 'live',
    };
  });
  return { markets, ignored, offersSeen: seen.size };
}

// ── Display ────────────────────────────────────────────────────────────────

/**
 * Format a price (whole quote tokens per whole base token) with up to `maxDigits` decimals (at
 * least 2). Asks round UP and bids DOWN (the default), so a shown price never flatters the offer;
 * a last trade, which nobody can deal at, rounds to the NEAREST (half up). `exact` says whether
 * rounding happened.
 */
export function formatPrice(
  r: Ratio,
  opts: { maxDigits?: number; round?: 'down' | 'up' | 'nearest' } = {},
): { text: string; exact: boolean } {
  if (r.den <= 0n || r.num < 0n) throw new RangeError('a price is a non-negative ratio');
  const digits = opts.maxDigits ?? 6;
  const scaledNum = r.num * 10n ** BigInt(digits);
  let q = scaledNum / r.den;
  const exact = q * r.den === scaledNum;
  if (!exact && opts.round === 'up') q += 1n;
  if (!exact && opts.round === 'nearest') q = (2n * scaledNum + r.den) / (2n * r.den);
  return { text: formatUnits(q, digits, { minFractionDigits: 2, grouping: true }), exact };
}
