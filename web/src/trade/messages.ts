// What the Trade page says about the account's own offers (AA 00047 P8.2, the owner's Q18 finding:
// "the zswap when posted on the offer files is not onchain (and loader suggests it is)"; questions
// Q24). A made offer is a proven, signed intent that the exchange (the Offer Files kernel) lists;
// nothing reaches the chain until someone takes it, and the tokens stay in the account until then.
// A take is the transaction: it settles the offer on Midnight.

import { OFFER_OFF_CHAIN } from '../activity/activity.js';
import type { TradeRecord } from './records.js';

const short = (s: string, head = 8, tail = 6) =>
  s.length <= head + tail + 1 ? s : `${s.slice(0, head)}…${s.slice(-tail)}`;

/** The toast after a make, from what the exchange said when the relay last asked. */
export function madeOfferText(rec: Pick<TradeRecord, 'summary' | 'offerId' | 'kernelStatus'>): string {
  const id = `offer ${short(rec.offerId)}`;
  switch (rec.kernelStatus) {
    case 'live':
      return `Your offer is listed on the market: ${rec.summary} (${id}). ${OFFER_OFF_CHAIN}`;
    case 'consumed':
      // The exchange's word, not the chain's (AA 00047 P10, R2-4): it shows as Filled once Midnight does.
      return `Your offer was listed and the exchange says someone has already taken it: ${rec.summary} (${id}). It shows as Filled once Midnight shows the settlement.`;
    default:
      return `The market has your offer, but it is not listed yet: ${rec.summary} (${id}). Refresh in a minute. ${OFFER_OFF_CHAIN}`;
  }
}

/** The toast after a take: the one transaction that settles the offer, once the CHAIN shows it
 *  (AA 00047 P10, R2-4); until then, the market's report and that the page waits for Midnight. */
export function tookOfferText(
  rec: Pick<TradeRecord, 'summary' | 'settledTx'> & { status?: TradeRecord['status'] },
): string {
  if (rec.status !== undefined && (rec.status !== 'filled' || !rec.settledTx))
    return `The market reports it settled: ${rec.summary}. Midnight does not show it yet; it shows here as Filled once it does.`;
  return `Done: ${rec.summary}, settled in one transaction on Midnight (tx ${short(rec.settledTx ?? '')}).`;
}

/** Under "Your offers and trades", and on the live-offer banner. */
export const OPEN_OFFERS_NOTE = `Your open offers are listed on the market, not on-chain: the tokens stay in your account until someone takes an offer, and that take settles on Midnight in one transaction (under "Settled by").`;
