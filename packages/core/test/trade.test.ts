// Plan L-TRD: the legs of an order in exact bigint maths, taking a whole book entry, funding it
// from one coin (Q9), and the one-live-offer rule with its warnings (L-TRD.3).

import { describe, expect, it } from 'vitest';

import type { StoredCoin } from '../src/coins.js';
import {
  OpenSwapPayloadSchema,
  TakePayloadSchema,
  TradeError,
  fundWithOneCoin,
  guardSignedAction,
  notEnoughText,
  offerStillLive,
  orderLegs,
  parsePrice,
  takeLegs,
} from '../src/trade.js';

const BASE = { midnightColour: 'a1'.repeat(32), decimals: 6, symbol: 'twUSDM' };
const QUOTE = { midnightColour: 'b2'.repeat(32), decimals: 6, symbol: 'twUSDC' };
const U = 1_000_000n;

const coin = (value: bigint, extra: Partial<StoredCoin> = {}): StoredCoin => ({
  nonce: (value.toString(16).padStart(2, '0') + 'cc'.repeat(32)).slice(0, 64),
  color: QUOTE.midnightColour,
  value: value.toString(),
  mtIndex: '7',
  commitment: `${value.toString(16)}`.padStart(64, '0'),
  origin: 'inbox',
  inInbox: true,
  spent: false,
  ...extra,
});

describe('the legs of an order (FR-011)', () => {
  it('sell 10 at 1.05 gives 10 twUSDM and wants 10.5 twUSDC; buy 10 at 0.95 gives 9.5 twUSDC and wants 10 twUSDM', () => {
    const sell = orderLegs('sell', BASE, QUOTE, 10n * U, parsePrice('1.05', QUOTE));
    expect(sell.give).toEqual({ colour: BASE.midnightColour, amount: 10_000_000n });
    expect(sell.want).toEqual({ colour: QUOTE.midnightColour, amount: 10_500_000n });
    expect(sell.rounded).toBe(false);
    const buy = orderLegs('buy', BASE, QUOTE, 10n * U, parsePrice('0.95', QUOTE));
    expect(buy.give).toEqual({ colour: QUOTE.midnightColour, amount: 9_500_000n });
    expect(buy.want).toEqual({ colour: BASE.midnightColour, amount: 10_000_000n });
  });

  it("L-TRD.0's order: sell 2 twUSDM at 1.05 wants exactly 2.10 twUSDC", () => {
    const o = orderLegs('sell', BASE, QUOTE, 2n * U, parsePrice('1.05', QUOTE));
    expect(o.want.amount).toBe(2_100_000n);
    expect(o.effectivePrice).toEqual({ num: 2_100_000n * U, den: 2_000_000n * U });
  });

  it('rounds a fractional quote leg in the customer’s favour: a sell asks at least P, a buy pays at most P', () => {
    // 0.000003 twUSDM at 0.5 = 0.0000015 twUSDC: not a whole base unit.
    const sell = orderLegs('sell', BASE, QUOTE, 3n, parsePrice('0.5', QUOTE));
    expect(sell.want.amount).toBe(2n);
    expect(sell.rounded).toBe(true);
    const buy = orderLegs('buy', BASE, QUOTE, 3n, parsePrice('0.5', QUOTE));
    expect(buy.give.amount).toBe(1n);
    expect(buy.rounded).toBe(true);
    // Effective prices respect the limit on both sides.
    expect(sell.effectivePrice.num * 2n >= sell.effectivePrice.den).toBe(true);
    expect(buy.effectivePrice.num * 2n <= buy.effectivePrice.den).toBe(true);
  });

  it('works across decimals (an 18-decimal base against a 6-decimal quote)', () => {
    const base18 = { ...BASE, decimals: 18 };
    const o = orderLegs('buy', base18, QUOTE, 10n ** 18n, parsePrice('2.5', QUOTE));
    expect(o.give.amount).toBe(2_500_000n);
    expect(o.want.amount).toBe(10n ** 18n);
  });

  it('refuses nonsense: zero quantity, zero price, a buy that rounds to nothing, too many price digits', () => {
    expect(() => orderLegs('sell', BASE, QUOTE, 0n, parsePrice('1', QUOTE))).toThrow(TradeError);
    expect(() => parsePrice('0', QUOTE)).toThrow(TradeError);
    expect(() => parsePrice('1.0000001', QUOTE)).toThrow(TradeError);
    expect(() => parsePrice('abc', QUOTE)).toThrow(TradeError);
    expect(() => orderLegs('buy', BASE, QUOTE, 1n, parsePrice('0.5', QUOTE))).toThrow(/rounds to zero/);
  });
});

describe('taking a whole book entry (FR-012)', () => {
  it('taking an ask is a buy: give its quote, want its base', () => {
    const t = takeLegs({ side: 'ask', baseRaw: 2n * U, quoteRaw: 2_100_000n }, BASE, QUOTE);
    expect(t.side).toBe('buy');
    expect(t.give).toEqual({ colour: QUOTE.midnightColour, amount: 2_100_000n });
    expect(t.want).toEqual({ colour: BASE.midnightColour, amount: 2n * U });
  });

  it('taking a bid is a sell: give its base, want its quote', () => {
    const t = takeLegs({ side: 'bid', baseRaw: 5n * U, quoteRaw: 4_750_000n }, BASE, QUOTE);
    expect(t.side).toBe('sell');
    expect(t.give).toEqual({ colour: BASE.midnightColour, amount: 5n * U });
    expect(t.want).toEqual({ colour: QUOTE.midnightColour, amount: 4_750_000n });
  });
});

describe('one coin per payment (Q9)', () => {
  const give = { colour: QUOTE.midnightColour, amount: 10_500_000n };

  it('uses the smallest positioned, unspent coin that covers the payment', () => {
    const coins = [coin(20n * U), coin(11n * U), coin(12n * U), coin(50n * U, { spent: true })];
    const r = fundWithOneCoin(coins, give, QUOTE);
    expect(r.ok && r.coin.value).toBe('11000000');
  });

  it('an offer bigger than every single coin is not takeable, and says why (US8 acceptance 1)', () => {
    const coins = [coin(8n * U), coin(6n * U), coin(40n * U, { mtIndex: null })];
    const r = fundWithOneCoin(coins, give, QUOTE);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.largest).toBe(8n * U);
      // 8 + 6 is enough in all, but no single coin covers 10.50 (the unpositioned 40 is not spendable).
      expect(r.reason).toBe('Not enough twUSDC in one coin. You hold 14.00 twUSDC; one payment can use at most 8.00.');
    }
  });

  it('says so when the account holds none of the token', () => {
    const r = fundWithOneCoin([], give, QUOTE);
    expect(!r.ok && r.reason).toBe('Not enough twUSDC. You hold 0.00 twUSDC.');
  });
});

describe('the "Not enough" wording and its facts (AA 00044)', () => {
  const baseCoin = (value: bigint, extra: Partial<StoredCoin> = {}) =>
    coin(value, { color: BASE.midnightColour, ...extra });

  it('the total is below the amount: "Not enough <T>. You hold <N> <T>."', () => {
    // 100 twUSDM in one coin; the bid needs 250 (spec US1's independent test).
    const r = fundWithOneCoin(
      [baseCoin(100n * U), coin(500n * U)],
      { colour: BASE.midnightColour, amount: 250n * U },
      BASE,
    );
    expect(r).toEqual({
      ok: false,
      kind: 'total',
      token: 'twUSDM',
      decimals: 6,
      total: 100n * U,
      largest: 100n * U,
      needed: 250n * U,
      reason: 'Not enough twUSDM. You hold 100.00 twUSDM.',
    });
  });

  it('no spendable coin: "Not enough <T>. You hold 0.00 <T>." (spent, unpositioned and other tokens do not count)', () => {
    const coins = [baseCoin(50n * U, { spent: true }), baseCoin(70n * U, { mtIndex: null }), coin(900n * U)];
    const r = fundWithOneCoin(coins, { colour: BASE.midnightColour, amount: 10n * U }, BASE);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r).toMatchObject({ kind: 'total', token: 'twUSDM', total: 0n, largest: 0n, needed: 10n * U });
      expect(r.reason).toBe('Not enough twUSDM. You hold 0.00 twUSDM.');
    }
  });

  it('enough in all but no single coin covers it: "Not enough <T> in one coin. You hold <N> <T>; one payment can use at most <M>."', () => {
    // 11 + 6 = 17 twUSDC; the ask needs 14.40, which only a merge could pay (Q9: no merge).
    const r = fundWithOneCoin(
      [coin(11n * U), coin(6n * U)],
      { colour: QUOTE.midnightColour, amount: 14_400_000n },
      QUOTE,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r).toMatchObject({ kind: 'one-coin', token: 'twUSDC', total: 17n * U, largest: 11n * U });
      expect(r.reason).toBe('Not enough twUSDC in one coin. You hold 17.00 twUSDC; one payment can use at most 11.00.');
    }
  });

  it('a total exactly equal to the amount across two coins is the one-coin case', () => {
    const r = fundWithOneCoin([coin(5n * U), coin(5n * U)], { colour: QUOTE.midnightColour, amount: 10n * U }, QUOTE);
    expect(!r.ok && r.kind).toBe('one-coin');
  });

  it('amounts are formatted as the book formats them: at least 2 decimals, grouped', () => {
    const r = fundWithOneCoin(
      [baseCoin(1_234_567_890_000n), baseCoin(1_500_000n)],
      { colour: BASE.midnightColour, amount: 9_000_000_000_000n },
      BASE,
    );
    expect(!r.ok && r.reason).toBe('Not enough twUSDM. You hold 1,234,569.39 twUSDM.');
    expect(
      notEnoughText({ kind: 'one-coin', token: 'twBTC', decimals: 6, total: 2_500_125_000n, largest: 1_000_000_000n }),
    ).toBe('Not enough twBTC in one coin. You hold 2,500.125 twBTC; one payment can use at most 1,000.00.');
  });

  it('`reason` is the wording function applied to the facts, for every case', () => {
    const cases = [
      fundWithOneCoin([baseCoin(3n * U)], { colour: BASE.midnightColour, amount: 10n * U }, BASE),
      fundWithOneCoin([], { colour: BASE.midnightColour, amount: 10n * U }, BASE),
      fundWithOneCoin([coin(8n * U), coin(6n * U)], { colour: QUOTE.midnightColour, amount: 12n * U }, QUOTE),
    ];
    expect(cases.map((r) => !r.ok && r.kind)).toEqual(['total', 'total', 'one-coin']);
    for (const r of cases) if (!r.ok) expect(r.reason).toBe(notEnoughText(r));
  });

  it('the token is whichever the account pays, never a special one: any symbol and decimals', () => {
    const GOLD = { midnightColour: 'c3'.repeat(32), decimals: 2, symbol: 'nmGOLD' };
    const r = fundWithOneCoin(
      [coin(4_000n, { color: GOLD.midnightColour })],
      { colour: GOLD.midnightColour, amount: 5_000n },
      GOLD,
    );
    expect(!r.ok && r.reason).toBe('Not enough nmGOLD. You hold 40.00 nmGOLD.');
  });

  it('a takeable offer is unchanged: ok, paid from the smallest covering coin, no facts', () => {
    const r = fundWithOneCoin(
      [baseCoin(300n * U), baseCoin(260n * U)],
      { colour: BASE.midnightColour, amount: 250n * U },
      BASE,
    );
    expect(r.ok).toBe(true);
    expect(r.ok && r.coin.value).toBe('260000000');
    expect(Object.keys(r).sort()).toEqual(['coin', 'ok']);
  });
});

describe('the one-live-offer rule and the warnings (Q9, L-TRD.1, L-TRD.3)', () => {
  const now = Date.parse('2026-09-27T20:00:00Z');
  const live = {
    status: 'live' as const,
    authNonce: '4',
    expiresAt: now + 30 * 60_000,
    summary: 'sell 2.00 twUSDM at 1.05',
  };

  it('a second offer is refused while one is live', () => {
    const g = guardSignedAction('open-swap', live, now, '4');
    expect(g.kind).toBe('refuse');
    expect(g.kind === 'refuse' && g.message).toContain('one live offer at a time');
    expect(g.kind === 'refuse' && g.message).toContain('20:30 UTC');
  });

  it('a withdrawal, re-filing change or a take warns that it cancels the offer', () => {
    for (const a of ['withdraw', 'append-inbox', 'take'] as const) {
      const g = guardSignedAction(a, live, now, '4');
      expect(g.kind).toBe('warn');
      expect(g.kind === 'warn' && g.message).toContain('cancels your live offer (sell 2.00 twUSDM at 1.05)');
    }
  });

  it('nothing to warn about once the offer is filled, expired, or already dead (the nonce moved)', () => {
    expect(guardSignedAction('withdraw', { ...live, status: 'filled' }, now).kind).toBe('ok');
    expect(guardSignedAction('withdraw', live, live.expiresAt).kind).toBe('ok');
    expect(guardSignedAction('open-swap', live, now, '5').kind).toBe('ok');
    expect(guardSignedAction('withdraw', null, now).kind).toBe('ok');
    expect(offerStillLive(live, now, 4n)).toBe(true);
    expect(offerStillLive(live, now)).toBe(true);
  });
});

describe('the wire shapes', () => {
  const payload = {
    giveColor: BASE.midnightColour,
    giveAmount: '2000000',
    wantColor: QUOTE.midnightColour,
    wantAmount: '2100000',
    wantNonce: '11'.repeat(32),
    wantEntry: '22'.repeat(192),
    changeEntry: '00'.repeat(192),
    validUntil: '0',
    coin: { nonce: '33'.repeat(32), color: BASE.midnightColour, value: '3000000', mtIndex: '9' },
    authNonce: '2',
  };

  it('accepts a make and a take, and nothing extra', () => {
    expect(OpenSwapPayloadSchema.safeParse(payload).success).toBe(true);
    expect(TakePayloadSchema.safeParse({ ...payload, offerId: 'ab'.repeat(32) }).success).toBe(true);
    expect(TakePayloadSchema.safeParse(payload).success).toBe(false);
    expect(OpenSwapPayloadSchema.safeParse({ ...payload, extra: 1 }).success).toBe(false);
    expect(OpenSwapPayloadSchema.safeParse({ ...payload, wantEntry: '22'.repeat(191) }).success).toBe(false);
  });
});
