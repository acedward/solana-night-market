// @vitest-environment node
// AA 00047 P8.2 (the owner's Q18 finding: "the zswap when posted on the offer files is not onchain
// (and loader suggests it is)"; questions Q24): what the Trade page says after a make and a take
// (src/trade/messages.ts). A make is listed on the market and is NOT on-chain until someone takes
// it; the tokens stay in the account until then. A take is the one Midnight transaction.

import { describe, expect, it } from 'vitest';

import { OFFER_OFF_CHAIN } from '../src/activity/activity.js';
import { OPEN_OFFERS_NOTE, madeOfferText, tookOfferText } from '../src/trade/messages.js';

const offerId = 'ab'.repeat(32);
const summary = 'sell 0.05 twBTC at 61,500.00 twUSDC';

describe('the make and take toasts', () => {
  it('a listed offer: listed on the market, and plainly not on-chain', () => {
    const t = madeOfferText({ summary, offerId, kernelStatus: 'live' });
    expect(t).toBe(
      `Your offer is listed on the market: ${summary} (offer abababab…ababab). Nothing goes on-chain until someone takes your offer, and your tokens stay in your account until then.`,
    );
    expect(t).not.toMatch(/Midnight|confirmed|transaction/i);
  });

  it('an offer the exchange has not listed yet says so, and that nothing is on-chain', () => {
    for (const kernelStatus of ['unknown', 'not_found', undefined]) {
      const t = madeOfferText({ summary, offerId, ...(kernelStatus ? { kernelStatus } : {}) });
      expect(t).toMatch(/^The market has your offer, but it is not listed yet: /);
      expect(t).toContain(OFFER_OFF_CHAIN);
    }
  });

  it('an offer taken before the relay stopped waiting: that take settled on Midnight', () => {
    expect(madeOfferText({ summary, offerId, kernelStatus: 'consumed' })).toMatch(
      /^Your offer was listed and someone has already taken it: .* It settled on Midnight/,
    );
  });

  it('a take is the one transaction', () => {
    expect(tookOfferText({ summary: 'buy 0.05 twBTC at 61,500.00 twUSDC', settledTx: 'cd'.repeat(32) })).toBe(
      'Done: buy 0.05 twBTC at 61,500.00 twUSDC, settled in one transaction on Midnight (tx cdcdcdcd…cdcdcd).',
    );
  });

  it('the open-offers note: listed, not on-chain; the take settles on Midnight', () => {
    expect(OPEN_OFFERS_NOTE).toMatch(/listed on the market, not on-chain/);
    expect(OPEN_OFFERS_NOTE).toMatch(/tokens stay in your account until someone takes an offer/);
  });
});
