// Trading on a pair (plan L-TRD, carried over from MN Bank; generic since AA 00047).
//
// A market is a configured pair BASE/QUOTE (./tokens/pairs.ts); no token is special. A customer
// either MAKES an offer ("sell N base at P", "buy N base at P", P in quote per base) or TAKES a
// whole live offer from the book. Both are one call of the account's swap circuit
// (`open_swap_shielded_with_<arm>`), proven with a fully guaranteed transcript by the relay, so its
// legs sit in segment 0, where any taker's or maker's legs can meet them.
//
// This module is the pure part both the browser and the relay use: the exact legs of an order in
// bigint base units, the complement of a book entry, whether one coin can fund it (one coin per
// payment, whole offers only), the one-live-offer rule and the warnings before a signed action
// would cancel a live offer, and the wire shapes of the two relay actions.

import { z } from 'zod';

import { QualifiedCoinSchema } from './accounts.js';
import { AmountError, type Ratio, formatUnits, parseUnits, priceRatio } from './amount.js';
import type { StoredCoin } from './coins.js';
import { normaliseHex32 } from './hex.js';
import type { BookEntry } from './market/prices.js';
import { OFFER_LIFETIME_SECONDS, TAKE_LIFETIME_SECONDS } from './offer-expiry.js';
import type { TokenEntry } from './tokens/registry.js';

export class TradeError extends Error {
  override name = 'TradeError';
}

/** Buying or selling the pair's BASE token. */
export type TradeSide = 'buy' | 'sell';

/** One leg: a colour (64 hex, lowercase) and an amount in its base units. */
export interface TradeLeg {
  colour: string;
  amount: bigint;
}

export interface OrderLegs {
  side: TradeSide;
  /** What the account gives up. */
  give: TradeLeg;
  /** What the account wants in return. */
  want: TradeLeg;
  /** The base leg, in the base token's base units. */
  baseRaw: bigint;
  /** The quote leg, in the quote token's base units. */
  quoteRaw: bigint;
  /** Whole quote tokens per whole base token that the legs actually carry. */
  effectivePrice: Ratio;
  /** True when N × P was not a whole number of quote base units and had to be rounded. */
  rounded: boolean;
}

type Leg = Pick<TokenEntry, 'midnightColour' | 'decimals'>;

/**
 * A price in whole quote tokens per whole base token ("1.05"), exact, with at most the quote
 * token's decimals. Zero and more digits than the quote token carries are refused (a price the
 * legs cannot express).
 */
export function parsePrice(text: string, quote: Pick<TokenEntry, 'decimals'>): Ratio {
  let raw: bigint;
  try {
    raw = parseUnits(text, quote.decimals);
  } catch (e) {
    throw new TradeError(e instanceof AmountError ? e.message.replace(/^amount/, 'the price') : 'not a price');
  }
  return { num: raw, den: 10n ** BigInt(quote.decimals) };
}

/**
 * The legs of a limit order, in exact bigint maths:
 *   sell N at P → give N base, want N × P quote;
 *   buy N at P  → give N × P quote, want N base.
 * When N × P is not a whole number of quote base units it is rounded IN THE CUSTOMER'S FAVOUR, as a
 * limit price must be: a sell asks for at least P (rounded up), a buy pays at most P (rounded
 * down). A quote leg that rounds to zero is refused.
 */
export function orderLegs(side: TradeSide, base: Leg, quote: Leg, quantityRaw: bigint, price: Ratio): OrderLegs {
  if (quantityRaw <= 0n) throw new TradeError('the quantity must be greater than zero');
  if (price.num <= 0n || price.den <= 0n) throw new TradeError('the price must be greater than zero');
  // Quote base units = quantityRaw / 10^bd × price × 10^qd.
  const num = quantityRaw * price.num * 10n ** BigInt(quote.decimals);
  const den = price.den * 10n ** BigInt(base.decimals);
  const floor = num / den;
  const exact = num % den === 0n;
  const quoteRaw = exact ? floor : side === 'sell' ? floor + 1n : floor;
  if (quoteRaw <= 0n) throw new TradeError('the order is too small: the amount it pays or asks rounds to zero');
  const baseLeg: TradeLeg = { colour: normaliseHex32(base.midnightColour), amount: quantityRaw };
  const quoteLeg: TradeLeg = { colour: normaliseHex32(quote.midnightColour), amount: quoteRaw };
  return {
    side,
    give: side === 'sell' ? baseLeg : quoteLeg,
    want: side === 'sell' ? quoteLeg : baseLeg,
    baseRaw: quantityRaw,
    quoteRaw,
    effectivePrice: priceRatio(quoteRaw, quote.decimals, quantityRaw, base.decimals),
    rounded: !exact,
  };
}

/**
 * What the account must give and want to take a whole book entry: taking an ASK (a maker selling
 * the base) is a BUY: give the ask's quote, want its base. Taking a BID is a SELL: give the bid's
 * base, want its quote.
 */
export function takeLegs(entry: Pick<BookEntry, 'side' | 'baseRaw' | 'quoteRaw'>, base: Leg, quote: Leg): OrderLegs {
  const baseLeg: TradeLeg = { colour: normaliseHex32(base.midnightColour), amount: entry.baseRaw };
  const quoteLeg: TradeLeg = { colour: normaliseHex32(quote.midnightColour), amount: entry.quoteRaw };
  const side: TradeSide = entry.side === 'ask' ? 'buy' : 'sell';
  return {
    side,
    give: side === 'buy' ? quoteLeg : baseLeg,
    want: side === 'buy' ? baseLeg : quoteLeg,
    baseRaw: entry.baseRaw,
    quoteRaw: entry.quoteRaw,
    effectivePrice: priceRatio(entry.quoteRaw, quote.decimals, entry.baseRaw, base.decimals),
    rounded: false,
  };
}

/**
 * Why ONE coin cannot pay (Q9: no coin merge), as facts the page words (AA 00044):
 *   - `total`: the account's spendable coins of the token add up to less than the amount (none at
 *     all included);
 *   - `one-coin`: they add up to enough, but no single coin covers the amount.
 */
export type ShortfallKind = 'total' | 'one-coin';

export interface NotEnoughFacts {
  kind: ShortfallKind;
  /** The token the account would pay: its symbol, as the book shows it (e.g. twBTC). */
  token: string;
  decimals: number;
  /** The sum of the unspent, positioned coins of the token, base units. */
  total: bigint;
  /** The largest single payment: the biggest of those coins, base units (0 when there are none). */
  largest: bigint;
  /** The amount the payment needs, base units. */
  needed: bigint;
}

export type Fundability =
  { ok: true; coin: StoredCoin & { mtIndex: string } } | ({ ok: false; reason: string } & NotEnoughFacts);

/**
 * The sentence for an amount ONE coin cannot pay (AA 00044), amounts as the book shows them
 * (2 decimals at least, grouped):
 *   - `Not enough twBTC. You hold 1.00 twBTC.` (the total is below the amount);
 *   - `Not enough twBTC. You hold 0.00 twBTC.` (no spendable coin of it);
 *   - `Not enough twUSDC in one coin. You hold 17.00 twUSDC; one payment can use at most 11.00.`
 *     (the total is enough, but coins are never merged, so no single payment covers it).
 */
export function notEnoughText(f: Pick<NotEnoughFacts, 'kind' | 'token' | 'decimals' | 'total' | 'largest'>): string {
  const fmt = (v: bigint) => formatUnits(v, f.decimals, { minFractionDigits: 2, grouping: true });
  return f.kind === 'one-coin'
    ? `Not enough ${f.token} in one coin. You hold ${fmt(f.total)} ${f.token}; one payment can use at most ${fmt(f.largest)}.`
    : `Not enough ${f.token}. You hold ${fmt(f.total)} ${f.token}.`;
}

/**
 * Can ONE coin pay `give` (Q9: no coin merge, offers are all or nothing)? The coin used is the
 * smallest unspent, positioned coin that covers it (L-ACC.5). When none does, the result carries
 * the facts (the token, the total held, the largest single coin, the amount needed) and `reason`,
 * the sentence `notEnoughText` builds from them (spec US8 acceptance 1; AA 00044).
 */
export function fundWithOneCoin(
  coins: readonly StoredCoin[],
  give: TradeLeg,
  token: Pick<TokenEntry, 'symbol' | 'decimals'>,
): Fundability {
  const colour = normaliseHex32(give.colour);
  const usable = coins.filter((c) => !c.spent && c.color === colour && c.mtIndex !== null);
  const covering = usable
    .filter((c) => BigInt(c.value) >= give.amount)
    .sort((a, b) => (BigInt(a.value) < BigInt(b.value) ? -1 : BigInt(a.value) > BigInt(b.value) ? 1 : 0));
  if (covering[0]) return { ok: true, coin: covering[0] as StoredCoin & { mtIndex: string } };
  const largest = usable.reduce((m, c) => (BigInt(c.value) > m ? BigInt(c.value) : m), 0n);
  const total = usable.reduce((s, c) => s + BigInt(c.value), 0n);
  const facts: NotEnoughFacts = {
    kind: total > 0n && total >= give.amount ? 'one-coin' : 'total',
    token: token.symbol,
    decimals: token.decimals,
    total,
    largest,
    needed: give.amount,
  };
  return { ok: false, reason: notEnoughText(facts), ...facts };
}

// ── Offers the account made, and the one-live-offer rule (Q9, L-TRD.1, L-TRD.3) ──────────

// ── The signed expiry of a make or a take (AA 00047 P9.S, audit C6; the lifetimes and the relay's
//    admission rule are ./offer-expiry.ts, shared with lane P9.R) ─────────────────────────────

/** The `validUntil` (unix seconds, decimal) a make or a take signs, from `nowMs`: now +
 *  OFFER_LIFETIME_SECONDS for a make, now + TAKE_LIFETIME_SECONDS for a take. The circuit refuses it
 *  after that (`assert_offer_live`), whoever holds it. */
export function signedValidUntil(kind: 'make' | 'take', nowMs: number): string {
  const lifetime = kind === 'make' ? OFFER_LIFETIME_SECONDS : TAKE_LIFETIME_SECONDS;
  return String(Math.floor(nowMs / 1000) + lifetime);
}

/** "2026-10-01 15:04:05 UTC": a signed deadline (unix seconds) as people read it, the way the F3 v2
 *  wallet text renders it (P9.C `Expires YYYY-MM-DD hh:mm:ss UTC`). */
export function deadlineText(validUntil: string | bigint | number): string {
  const s = Number(validUntil);
  if (!Number.isFinite(s) || s <= 0) return 'never';
  return `${new Date(s * 1000).toISOString().slice(0, 19).replace('T', ' ')} UTC`;
}

/** The kernel's lifecycle words, plus what only the browser can know. */
export type OfferState =
  /** On the book, and this account has not signed anything since. */
  | 'live'
  /** Settled by a taker: the account's coin was spent by the offer. */
  | 'filled'
  /** Its signed expiry (`validUntil`) passed: the circuit refuses it from then on. */
  | 'expired'
  /** Another signed action of the account moved its nonce, so the offer can never settle. */
  | 'cancelled'
  /** The account's nonce moved, so it can never execute, but the browser has not read the account's
   *  history in full, so whether it was filled or cancelled is not known yet (AA 00047 P11.B). */
  | 'ended'
  /** Proven but the exchange refused it, or never answered. */
  | 'refused';

/** The part of a stored offer the rules read. */
export interface OfferRuleInput {
  status: OfferState;
  /** The auth nonce the offer's signature binds. */
  authNonce: string;
  /** Unix ms after which the offer can no longer settle: its signed `validUntil` (AA 00047 P9.S). */
  expiresAt: number;
}

/**
 * Is this offer still able to settle? Live on the book, not past its TTL, and signed at the
 * account's CURRENT auth nonce (any other executed call advances it, which kills the offer).
 */
export function offerStillLive(o: OfferRuleInput, now: number, currentAuthNonce?: string | bigint): boolean {
  if (o.status !== 'live') return false;
  if (now >= o.expiresAt) return false;
  if (currentAuthNonce !== undefined && BigInt(currentAuthNonce) !== BigInt(o.authNonce)) return false;
  return true;
}

/** The signed actions an account can take. */
export type SignedAction = 'withdraw' | 'append-inbox' | 'open-swap' | 'take' | 'cancel-offers' | 'restore-enc-key';

const ACTION_TEXT: Record<SignedAction, string> = {
  withdraw: 'This withdrawal',
  'append-inbox': 'Recording this change',
  'open-swap': 'A second offer',
  take: 'Taking this offer',
  'cancel-offers': 'Cancelling',
  'restore-enc-key': 'Restoring your encryption key',
};

export type ActionGuard =
  | { kind: 'ok' }
  /** The action is allowed after the customer confirms. */
  | { kind: 'warn'; message: string }
  /** The action is refused. */
  | { kind: 'refuse'; message: string };

/**
 * What the page must do before `action` while `live` is the account's live offer (Q9: one live
 * offer per account; any other signed call, once executed, makes it unsettleable):
 *   - making a second offer is REFUSED: the two would share one auth nonce, so at most one could
 *     ever settle, and they may spend the same coin (L-TRD.1);
 *   - every other signed action WARNS that it cancels the offer, and needs a confirmation
 *     (L-TRD.3; spec US7 acceptance 1, US8 acceptance 2).
 */
export function guardSignedAction(
  action: SignedAction,
  live: (OfferRuleInput & { summary: string }) | null,
  now: number,
  currentAuthNonce?: string | bigint,
): ActionGuard {
  if (!live || !offerStillLive(live, now, currentAuthNonce)) return { kind: 'ok' };
  const until = new Date(live.expiresAt).toISOString().slice(11, 16);
  if (action === 'open-swap') {
    return {
      kind: 'refuse',
      message:
        `You already have a live offer (${live.summary}). An account can have one live offer at a time: ` +
        `it stays on the exchange until someone takes it or it expires at ${until} UTC.`,
    };
  }
  return {
    kind: 'warn',
    message:
      `${ACTION_TEXT[action]} cancels your live offer (${live.summary}): once it goes through, that offer can ` +
      'never be taken. Continue?',
  };
}

// ── The relay actions (wire) ───────────────────────────────────────────────────────────

const hex = (bytes: number) => z.string().regex(new RegExp(`^(0x)?[0-9a-fA-F]{${bytes * 2}}$`));
const hex32 = hex(32);
const decimal = z.string().regex(/^[0-9]{1,40}$/);

/**
 * `open-swap` (make): the account's swap circuit in the OPEN shape (anyone may take it). Every
 * field is what the circuit and its signed challenge bind: the give
 * leg, the wanted coin (its nonce is the browser's fresh randomness), the two inbox entries the
 * browser sealed to the account's own key (the wanted coin, and the predicted change or 192 zero
 * bytes), the deadline `validUntil` (unix seconds; the site signs now + OFFER_LIFETIME_SECONDS for a
 * make and now + TAKE_LIFETIME_SECONDS for a take, audit C6; 0 would mean "never" and the site no
 * longer sends it), and the coin the give is paid from.
 */
export const OpenSwapPayloadSchema = z
  .object({
    giveColor: hex32,
    giveAmount: decimal,
    wantColor: hex32,
    wantAmount: decimal,
    wantNonce: hex32,
    wantEntry: hex(192),
    changeEntry: hex(192),
    validUntil: decimal,
    coin: QualifiedCoinSchema,
    authNonce: decimal,
  })
  .strict();
export type OpenSwapPayload = z.infer<typeof OpenSwapPayloadSchema>;

/**
 * `take`: the same call, complementary to one whole live offer on the book (its give is
 * the maker's want, its want the maker's give), merged by the relay with the maker's offer and
 * settled in ONE transaction through the batcher.
 */
export const TakePayloadSchema = OpenSwapPayloadSchema.extend({
  offerId: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();
export type TakePayload = z.infer<typeof TakePayloadSchema>;

export interface OpenSwapResult {
  /** The kernel's id of the offer (SHA-256 of its bytes). */
  offerId: string;
  /** Whether the exchange accepted it, and what it said. */
  kernel: { accepted: boolean; status: string; code: string | null; reason: string | null };
  /** The segment its legs are in (0 when proven guaranteed, which is what makes it takeable). */
  legSegment: number;
  proveSeconds: number;
  /** Unix ms: the intent's TTL (the ledger refuses the offer after it). */
  expiresAt: number;
  bytes: number;
}

export interface TakeResult {
  offerId: string;
  /** The settling transaction, as the batcher reported it. */
  txHash: string;
  proveSeconds: number;
  /** The merged transaction's modelled cost against the chain's live parameters. */
  cost: { blockUsage: string; computeTimePs: string; readTimePs: string; feesSpecks: string | null };
  path: 'batcher';
}
