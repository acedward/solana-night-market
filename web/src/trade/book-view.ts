// The Trade page's ONE view of a pair (AA 00060 spec FR-026, FR-027; plan P14): the order book
// `<base> ⇄ <quote>`, whose two halves each list the offers you can take AND a create row for your
// own offer. Pure rules only; the page (../pages/Trade.tsx) renders them. No token is special: every
// rule here is written in terms of the pair's base and quote.
//
//   "Sellers — you buy <base>"   the asks (Buy takes one), plus the create row "Sell <quote>": you
//                                give the quote and want the base, a BUY offer, listed under Buyers;
//   "Buyers — you sell <base>"   the bids (Sell takes one), plus the create row "Sell <base>": you
//                                give the base and want the quote, a SELL offer, listed under Sellers.
//
// Which create row sits in which half follows the spec's rule and plan P14.1. The owner's own example
// may mean the other way round (questions Q10): `CREATE_ROW` is the one place that decides it.
//
// Your own offer (FR-027): an account cannot take its own offer (P14.0, questions Q9). The make and the
// take are signed at the same auth nonce and device counter, so in one transaction the second call's
// device entry is gone and its guaranteed transcript no longer matches; the relay also refuses a call
// signed ahead of the chain's nonce. So your own live row offers "Cancel your offer" (the on-chain
// cancel, which leaves you with the same tokens a self-take would), never a take.

import type { BookEntry, Market, MarketPair, TradeSide } from '@nightmarket/core';

import { askText, bidText } from '../market/view.js';
import type { TradeRecord } from './records.js';

export type BookHalf = 'asks' | 'bids';

/** The offer each half's create row makes (questions Q10: the one switch). */
export const CREATE_ROW: Readonly<Record<BookHalf, TradeSide>> = { asks: 'buy', bids: 'sell' };

/** The half whose create row makes an offer of `side`. */
export const createRowHalf = (side: TradeSide): BookHalf => (side === CREATE_ROW.asks ? 'asks' : 'bids');

/** Where an offer of `side` is LISTED once the exchange has it: a sell of the base is an ask (Sellers),
 *  a buy of the base is a bid (Buyers). */
export const listedUnder = (side: TradeSide): BookHalf => (side === 'sell' ? 'asks' : 'bids');

/** The token an offer of `side` gives (what its create row sells). */
export const givenToken = (side: TradeSide, pair: Pick<MarketPair, 'base' | 'quote'>) =>
  side === 'sell' ? pair.base : pair.quote;

/** The create row's label: "Sell <the token you give>". */
export const createRowLabel = (side: TradeSide, pair: Pick<MarketPair, 'base' | 'quote'>): string =>
  `Sell ${givenToken(side, pair).symbol}`;

/** The create row's line under its label: what the offer does, in the pair's words. */
export function createRowHint(side: TradeSide, pair: Pick<MarketPair, 'base' | 'quote'>): string {
  const { base, quote } = pair;
  return side === 'sell'
    ? `Your own offer: sell ${base.symbol} for ${quote.symbol} at your price.`
    : `Your own offer: buy ${base.symbol} with ${quote.symbol} at your price.`;
}

/** The half's heading: "Sellers — you buy twBTC", "Buyers — you sell twBTC". */
export function halfHeading(half: BookHalf, pair: Pick<MarketPair, 'base'>): { who: string; you: string } {
  return half === 'asks'
    ? { who: 'Sellers', you: `— you buy ${pair.base.symbol}` }
    : { who: 'Buyers', you: `— you sell ${pair.base.symbol}` };
}

/** The view's title: `Order book <base> ⇄ <quote>`. */
export const bookTitle = (pair: Pick<MarketPair, 'base' | 'quote'>): string =>
  `Order book ${pair.base.symbol} ⇄ ${pair.quote.symbol}`;

/** "Use the best price": a sell joins the best ask (else the best bid), a buy the best bid (else the
 *  best ask), in the book's own rounding (asks up, bids down). Null when the book is empty. */
export function bestPriceText(side: TradeSide, market: Pick<Market, 'asks' | 'bids'> | null): string | null {
  if (!market) return null;
  const bestAsk = market.asks.best?.price;
  const bestBid = market.bids.best?.price;
  if (side === 'sell') return bestAsk ? askText(bestAsk) : bestBid ? bidText(bestBid) : null;
  return bestBid ? bidText(bestBid) : bestAsk ? askText(bestAsk) : null;
}

/** Whether this site can take the account's own offer (P14.0: no; questions Q9). */
export const SELF_TAKE_SUPPORTED = false;

/** The warning the owner asked for, kept for a self-take (FR-027); shown with the reason it cannot. */
export const OWN_OFFER_WARNING =
  'This is your offer. Taking it trades with yourself: you pay the fees and end up with the same tokens.';

/** Why your own account cannot take it, and what to do instead (P14.0). */
export const OWN_OFFER_CANNOT_TAKE =
  'Your account cannot take its own offer: taking it and the offer itself would use the same approval, so Midnight would refuse the trade. Cancel it instead: you keep your tokens, as a take would leave them.';

/**
 * What a book row offers this account (FR-026, FR-027):
 *   own-live   the account's own offer, the one live now: "Cancel your offer" (a self-take is
 *              impossible, P14.0);
 *   own        the account's own offer that has ended on its side (filled, cancelled, expired, ended)
 *              while the exchange still lists it: the badge only, nothing to do;
 *   take       anyone else's offer: take it (Buy or Sell), if one coin can pay.
 */
export type RowAction = 'own-live' | 'own' | 'take';

export function rowAction(
  entry: Pick<BookEntry, 'offerId'>,
  trades: readonly Pick<TradeRecord, 'role' | 'offerId'>[],
  live: Pick<TradeRecord, 'offerId'> | null,
): RowAction {
  if (live && live.offerId === entry.offerId) return 'own-live';
  if (trades.some((t) => t.role === 'make' && t.offerId === entry.offerId)) return 'own';
  return 'take';
}
