// The trade operations, as the browser runs them (plan L-TRD, spec US7/US8): make an offer, take a
// whole offer from the book, and reconcile My offers, on any listed pair. Each trade asks the
// wallet for exactly ONE signature over the swap call (the arm's message, through the Solana
// wallet's `ActionSigning`, lane B2), which the relay rebuilds and checks.
//
// The browser picks the coin (one coin per payment, Q9), draws the wanted coin's nonce, and seals
// both inbox entries (the wanted coin, and the predicted change) to the account's OWN public key,
// so every coin the trade creates is recoverable from the chain (FR-005). The relay proves the call
// fully guaranteed (so any account can take it, and it can take any segment-0 offer), publishes a
// make, and settles a take through the exchange's batcher in one transaction.
//
// Every make and take SIGNS a real expiry (AA 00047 P9.S, audit C6): a make lasts
// OFFER_LIFETIME_SECONDS, a take TAKE_LIFETIME_SECONDS (@nightmarket/core). The circuit refuses the
// call after it, whoever holds the approval, and the offer's status here follows that signed expiry
// (never the relay's transaction TTL). Offers cannot be cancelled (AA 00060 spec FR-028, owner
// 2026-10-05; supersedes 00047 Q30's "Cancel offer"): any other signed call of the account ends one sooner.
//
// An approval is marked ENDED only from what this browser reads on the CHAIN, and its own signed
// expiry (AA 00047 P10, audit round 2 R2-4; spec FR-004b "Round 2"), never from the relay's or the
// exchange's word. Since AA 00047 P11.B (audit round 3 R3-6 / F-A3-3 / F-B3-5; questions Q47 A) the
// evidence of a FILL is the decoded swap transaction itself: the account's own swap call that received
// the wanted coin (its full commitment) and consumed the approval, in a transaction of the account's
// history this page decoded (@nightmarket/core `fillEvidence`); an inbox note, which anyone can file,
// proves nothing. Cancelled once the nonce moved and the history, COMPLETE through the height the
// nonce was read at, holds no such transaction; "ended" when the nonce moved but the history is not
// complete (neither can be claimed); expired once its signed `validUntil` passed. The exchange's
// "consumed" or "expired" is the LISTING's state, shown apart (`kernelStatus`); one they call taken
// shows "Settling" until the chain shows it (questions Q44). Records an older page decided otherwise
// (on a relay's "succeeded", the exchange's "expired", or a note) are decided again (`reconcileOffers`).

import {
  fillCandidates,
  fillEvidence,
  historyCovers,
  unresolvedFillCandidates,
  spendOf,
  type AccountHistory,
  type CoinInfo,
  type DecodedCall,
  type BookEntry,
  type JobView,
  type KernelClient,
  type KernelOfferStatus,
  type OpenSwapPayload,
  type OpenSwapResult,
  type OrderLegs,
  type StoredCoin,
  type TakePayload,
  type TakeResult,
  type MarketPair,
  type PassportAuth,
  type TokenEntry,
  bytesToHex,
  fundWithOneCoin,
  guardSignedAction,
  hexToBytes,
  signedValidUntil,
  takeLegs,
} from '@nightmarket/core';
import { freshWantNonce, offerInboxEntriesPortable, predictChangeCoin } from '@nightmarket/core/passport';

import {
  JobFailedError,
  OperationError,
  gatedContext,
  submitAndWait,
  syncAccount,
  type OperationEnv,
} from '../passport/operations.js';
import { ACTION_CIRCUIT } from '../prover/constants.js';
import { readCoins } from '../passport/records.js';
import { jobErrorText } from '../relay/messages.js';
import { liveOffer, putTrade, readTrades, tradeSummary, type TradeRecord } from './records.js';

/** The payload of one open-swap call and its single signature (the browser's half of a trade). */
async function buildCall(
  env: OperationEnv,
  account: string,
  action: 'open-swap' | 'take',
  legs: OrderLegs,
  giveToken: TokenEntry,
  validUntil: string,
  offerId?: string,
): Promise<{ payload: OpenSwapPayload; passportAuth: PassportAuth; coin: StoredCoin }> {
  const funded = fundWithOneCoin(readCoins(env.store, env.scope, account), legs.give, giveToken);
  if (!funded.ok) throw new OperationError(funded.reason);
  const coin = funded.coin;
  const { state, counter, ctx } = await gatedContext(env, account);
  const want = { nonce: freshWantNonce(), color: hexToBytes(legs.want.colour, 32), value: legs.want.amount };
  const change = predictChangeCoin(
    {
      nonce: hexToBytes(coin.nonce, 32),
      color: hexToBytes(coin.color, 32),
      value: BigInt(coin.value),
      mt_index: BigInt(coin.mtIndex),
    },
    legs.give.amount,
  );
  const entries = await offerInboxEntriesPortable(hexToBytes(state.encKey, 32), want, change);
  const payload: OpenSwapPayload = {
    giveColor: legs.give.colour,
    giveAmount: legs.give.amount.toString(10),
    wantColor: legs.want.colour,
    wantAmount: legs.want.amount.toString(10),
    wantNonce: bytesToHex(want.nonce),
    wantEntry: bytesToHex(entries.wantEntry),
    changeEntry: bytesToHex(entries.changeEntry),
    validUntil,
    coin: { nonce: coin.nonce, color: coin.color, value: coin.value, mtIndex: coin.mtIndex },
    authNonce: state.authNonce,
  };
  const signed = offerId === undefined ? payload : ({ ...payload, offerId } satisfies TakePayload);
  const passportAuth = await env.signing.authorise(ctx, { kind: 'swap', action, payload: signed }, counter);
  return { payload, passportAuth, coin };
}

async function runJob(
  env: OperationEnv,
  account: string,
  action: 'open-swap' | 'take',
  payload: Record<string, unknown>,
  passportAuth: PassportAuth,
  context: Record<string, unknown>,
): Promise<JobView> {
  // AA 00062 (I-62a v2): a stale call is sent again once on its own (`submitAndWait`).
  const done = await submitAndWait(env, account, action, { payload, passportAuth }, context);
  if (done.state !== 'succeeded' || !done.result)
    throw new JobFailedError(
      done.error?.code ?? 'failed',
      jobErrorText(done.error, 'The market could not complete this.'),
    );
  return done;
}

/**
 * Make an offer on a pair ("sell N base at P", "buy N base at P", P in quote per base, FR-011):
 * refused while another offer is live (Q9); one signature; the relay proves, publishes and reports
 * the exchange's id. The coin is NOT marked spent (the offer has not executed) and the device's use
 * counter does not move until it does.
 */
export async function makeOffer(
  env: OperationEnv,
  account: string,
  legs: OrderLegs,
  pair: MarketPair,
): Promise<TradeRecord> {
  const now = Date.now();
  const live = liveOffer(readTrades(env.store, env.scope, account), now);
  const guard = guardSignedAction('open-swap', live, now);
  if (guard.kind === 'refuse') throw new OperationError(guard.message);
  // AA 00062 (FR-009): a prover that passes, before anything is signed and before the signed expiry
  // starts to run.
  await env.prover?.ensure(ACTION_CIRCUIT['open-swap']);
  const giveToken = legs.side === 'sell' ? pair.base : pair.quote;
  const validUntil = signedValidUntil('make', Date.now());
  const { payload, passportAuth, coin } = await buildCall(env, account, 'open-swap', legs, giveToken, validUntil);
  const summary = tradeSummary(legs.side, legs.baseRaw, pair.base, legs.effectivePrice, pair.quote);
  const done = await runJob(env, account, 'open-swap', payload as never, passportAuth, { summary });
  const r = done.result as unknown as OpenSwapResult;
  const record: TradeRecord = {
    offerId: r.offerId,
    role: 'make',
    side: legs.side,
    pair: pair.id,
    base: pair.base.midnightColour,
    quote: pair.quote.midnightColour,
    baseRaw: legs.baseRaw.toString(10),
    quoteRaw: legs.quoteRaw.toString(10),
    summary,
    coin: coin.commitment,
    authNonce: payload.authNonce,
    wantNonce: payload.wantNonce,
    createdAt: now,
    // The SIGNED expiry, not the relay's transaction TTL (audit C6).
    expiresAt: Number(validUntil) * 1000,
    validUntil,
    // Live until the CHAIN shows it ended (R2-4): an exchange that already says "consumed" shows it
    // as settling (`offerShown`), and the next reconcile decides it from the chain.
    status: 'live',
    kernelStatus: r.kernel.status,
    checkedAt: Date.now(),
  };
  putTrade(env.store, env.scope, account, record);
  return record;
}

/**
 * Take one whole offer from the book (FR-012): the account gives what the maker wants and wants
 * what the maker gives, paid from ONE coin; the relay settles it in one transaction through the
 * batcher. A live offer of this account dies with it (the caller has warned, L-TRD.3).
 */
export async function takeOffer(
  env: OperationEnv,
  account: string,
  entry: Pick<BookEntry, 'offerId' | 'side' | 'baseRaw' | 'quoteRaw'>,
  pair: MarketPair,
): Promise<TradeRecord> {
  // AA 00062 (FR-009): before anything is signed, and before the take's 600 s start to run.
  await env.prover?.ensure(ACTION_CIRCUIT.take);
  const legs = takeLegs(entry, pair.base, pair.quote);
  const giveToken = legs.side === 'sell' ? pair.base : pair.quote;
  const validUntil = signedValidUntil('take', Date.now());
  const { payload, passportAuth, coin } = await buildCall(
    env,
    account,
    'take',
    legs,
    giveToken,
    validUntil,
    entry.offerId,
  );
  const summary = tradeSummary(legs.side, legs.baseRaw, pair.base, legs.effectivePrice, pair.quote);
  const takePayload: TakePayload = { ...payload, offerId: entry.offerId };
  const done = await runJob(env, account, 'take', takePayload as never, passportAuth, { summary });
  const r = done.result as unknown as TakeResult;
  // The market reports it settled: the device's counter hint moves, and the coin is set aside (the
  // next walk confirms the spend from the ledger's nullifier). Whether the take, and any live offer of
  // ours, ENDED is the chain's to say (R2-4): decided below from the account as the indexer shows it.
  env.store.put(env.scope, 'roster', { useCounter: (BigInt(passportAuth.useCounter) + 1n).toString(10) }, { account });
  const coins = readCoins(env.store, env.scope, account).map((c) =>
    c.commitment === coin.commitment ? { ...c, spent: true, spentTx: r.txHash } : c,
  );
  env.store.put(env.scope, 'coins', coins, { account });
  const record: TradeRecord = {
    offerId: entry.offerId,
    role: 'take',
    side: legs.side,
    pair: pair.id,
    base: pair.base.midnightColour,
    quote: pair.quote.midnightColour,
    baseRaw: legs.baseRaw.toString(10),
    quoteRaw: legs.quoteRaw.toString(10),
    summary,
    coin: coin.commitment,
    authNonce: payload.authNonce,
    wantNonce: payload.wantNonce,
    createdAt: Date.now(),
    expiresAt: Number(validUntil) * 1000,
    validUntil,
    // Settled as far as the market says: the chain decides (filled, once the wanted coin's note and
    // leaf are on it; `settledTx` is then the chain's transaction, not the relay's report).
    status: 'live',
    kernelStatus: 'consumed',
    checkedAt: Date.now(),
  };
  putTrade(env.store, env.scope, account, record);
  await reconcileOffers(env, account, null).catch(() => undefined);
  return (
    readTrades(env.store, env.scope, account).find((t) => t.role === 'take' && t.offerId === entry.offerId) ?? record
  );
}

/** The expiry an approval SIGNED (unix ms), or null when it signed none (older records signed
 *  "never"): the only expiry the page goes by (R2-4), never the exchange's or the relay's TTL. */
export function signedExpiryMs(t: Pick<TradeRecord, 'validUntil'>): number | null {
  if (!t.validUntil || !/^[0-9]+$/.test(t.validUntil)) return null;
  const s = BigInt(t.validUntil);
  return s > 0n ? Number(s) * 1000 : null;
}

/** One read of the account on the chain: its auth nonce, its coins (the inbox walk's), and its history
 *  as this page decoded it (AA 00047 P11.B). */
export interface ChainView {
  authNonce: bigint;
  coins: readonly StoredCoin[];
  history: AccountHistory;
  /** The height the nonce was read at. */
  stateHeight: number;
  /** A candidate fill transaction's decoded calls (undefined when not read). */
  calls: (txHash: string) => readonly DecodedCall[] | undefined;
}

/** The coin an approval WANTS, exactly as the wallet signed it (the swap circuit's challenge binds it):
 *  its fresh nonce, and the want leg's colour and amount (a sell wants the quote, a buy the base). */
export function wantCoinOf(
  t: Pick<TradeRecord, 'side' | 'base' | 'quote' | 'baseRaw' | 'quoteRaw' | 'wantNonce'>,
): CoinInfo {
  const sell = t.side === 'sell';
  return {
    nonce: t.wantNonce.replace(/^0x/, '').toLowerCase(),
    color: (sell ? t.quote : t.base).replace(/^0x/, '').toLowerCase(),
    value: BigInt(sell ? t.quoteRaw : t.baseRaw).toString(10),
  };
}

/**
 * What the CHAIN (and the approval's own signed expiry) says of one of the account's approvals, a
 * make or a take (AA 00047 P10, R2-4; P11.B, R3-6). From one read of the account:
 *   filled     the account's nonce moved past the one it signed AND a transaction of its decoded history
 *              carries the account's own swap call receiving the wanted coin (its full commitment) and
 *              spending the approval's coin (`fillEvidence`); `settledTx` is that transaction;
 *   cancelled  the nonce moved, and the history, complete through the height the nonce was read at,
 *              holds no such transaction, and every candidate's raw calls were read and decoded: it can
 *              never execute (another signed call of the account; before FR-028, also "Cancel offer");
 *   ended      the nonce moved, no such transaction was read, and the history is NOT complete, or a
 *              candidate fill's raw calls could not be read or decoded (AA 00047 P11.F, R4-4): it can
 *              never execute, but whether it filled is not known (decided again on the next read);
 *   expired    the nonce has not moved but its SIGNED `validUntil` passed: the circuit refuses it;
 *   live       otherwise: it can still execute, whatever the exchange or the relay says.
 */
export function decideApproval(t: TradeRecord, chain: ChainView, now: number): TradeRecord {
  const { settledTx: _s, fillVerified: _v, ...open } = t;
  if (chain.authNonce > BigInt(t.authNonce)) {
    const give = chain.coins.find((c) => c.commitment === t.coin) ?? null;
    const want = wantCoinOf(t);
    const fill = fillEvidence({ history: chain.history, want, give, calls: chain.calls });
    if (fill) return { ...open, status: 'filled', settledTx: fill.txHash, fillVerified: true };
    // "Cancelled" needs COMPLETE negative evidence: the history through the nonce's height, and every
    // candidate's calls decoded (R4-4: a raw read that failed may hide the approval's own swap).
    const unresolved = unresolvedFillCandidates({ history: chain.history, want, calls: chain.calls });
    const negative = historyCovers(chain.history, chain.stateHeight) && unresolved.length === 0;
    return { ...open, status: negative ? 'cancelled' : 'ended' };
  }
  const until = signedExpiryMs(t);
  return { ...open, status: until !== null && now >= until ? 'expired' : 'live' };
}

/**
 * Reconcile My offers and takes (FR-011: "reconcile the account when anyone settles it"): walk the
 * inbox first, then decide every approval that is not settled for good from the CHAIN and its signed
 * expiry (`decideApproval`, R2-4), records an older page marked ended too early included. The
 * exchange (`kernel`, when given) is asked about the makes still live, for whether it LISTS them
 * (`kernelStatus`, shown apart by `offerShown`), never for whether they ended. Returns the records
 * whose state changed.
 */
export async function reconcileOffers(
  env: OperationEnv,
  account: string,
  kernel: Pick<KernelClient, 'offerStatus'> | null,
  now = Date.now(),
): Promise<TradeRecord[]> {
  // Everything but a fill proven by its decoded swap transaction (R3-6) and a refusal: a "filled" an
  // older page decided from a note alone is decided again.
  const open = readTrades(env.store, env.scope, account).filter(
    (t) => t.status !== 'refused' && !(t.status === 'filled' && t.fillVerified && t.settledTx),
  );
  if (open.length === 0) return [];
  const synced = await syncAccount(env, account);
  // The raw bytes of every transaction that may have filled one of them (its wanted coin's leaf, and a
  // swap call of the account), decoded: the evidence of a fill (R3-6).
  const authNonce = BigInt(synced.state.authNonce);
  const candidates = new Set(
    open.filter((t) => authNonce > BigInt(t.authNonce)).flatMap((t) => fillCandidates(synced.history, wantCoinOf(t))),
  );
  // A candidate whose raw bytes could not be read or decoded stays unresolved (`calls` undefined): its
  // approval is then "Ended", never "Cancelled" (R4-4).
  const calls = new Map<string, DecodedCall[]>();
  for (const hash of candidates) {
    const c = await env.chain.transactionCalls(hash).catch(() => null);
    if (c) calls.set(hash, c);
  }
  const chain: ChainView = {
    authNonce,
    coins: synced.coins,
    history: synced.history,
    stateHeight: synced.stateHeight,
    calls: (h) => calls.get(h),
  };
  const changed: TradeRecord[] = [];
  for (const o of open) {
    let next: TradeRecord = { ...decideApproval(o, chain, now), checkedAt: now };
    if (kernel && next.role === 'make' && next.status === 'live') {
      try {
        const kernelStatus: KernelOfferStatus = await kernel.offerStatus(o.offerId);
        next = { ...next, kernelStatus };
      } catch {
        /* the listing's state stays the last one seen */
      }
    }
    // A coin this page set aside for an approval that can no longer execute and never spent it, as
    // the complete history shows, is spendable again (the take's coin, set aside when the relay said
    // it settled).
    if (next.status === 'cancelled') releaseSetAside(env, account, next.coin, synced.history);
    putTrade(env.store, env.scope, account, next);
    if (next.status !== o.status || next.settledTx !== o.settledTx) changed.push(next);
  }
  return changed;
}

/** Give back a coin this page set aside (`spent` without a chain spend) once the complete history
 *  shows the payment it was set aside for never happened (R3-4's rule, for takes). */
function releaseSetAside(env: OperationEnv, account: string, commitment: string, history: AccountHistory) {
  const coins = readCoins(env.store, env.scope, account);
  const c = coins.find((x) => x.commitment === commitment);
  if (!c?.spent || c.pending) return;
  if (spendOf(history, c)) return;
  const { spentTx: _t, ...rest } = c;
  env.store.put(
    env.scope,
    'coins',
    coins.map((x) => (x.commitment === commitment ? { ...rest, spent: false } : x)),
    { account },
  );
}

/** For a page: the guard before a signed action, from this browser's records (L-TRD.3). */
export function guardFor(
  env: Pick<OperationEnv, 'store' | 'scope'>,
  account: string,
  action: Parameters<typeof guardSignedAction>[0],
  now = Date.now(),
) {
  return guardSignedAction(action, liveOffer(readTrades(env.store, env.scope, account), now), now);
}

/** After another signed call of the account (a withdrawal, a re-filed change, a key restore): decide
 *  its approvals again from the CHAIN (R2-4), never from the relay's "succeeded". */
export const reconcileFromChain = (env: OperationEnv, account: string, now = Date.now()) =>
  reconcileOffers(env, account, null, now);

/** What the page shows for one of the account's offers: its state word, and whether the exchange
 *  lists it. A live offer the exchange has not listed (yet) never shows "Listed" (P8.2 follow-up);
 *  one the exchange (or the relay) says is taken shows "settling" until the chain shows the fill (R2-4). */
export function offerShown(t: Pick<TradeRecord, 'role' | 'status' | 'kernelStatus'>): {
  state: TradeRecord['status'] | 'unlisted' | 'settling';
  listed: boolean;
} {
  if (t.status === 'live' && t.kernelStatus === 'consumed') return { state: 'settling', listed: false };
  if (t.role === 'make' && t.status === 'live') {
    const listed = t.kernelStatus === 'live';
    return { state: listed ? 'live' : 'unlisted', listed };
  }
  return { state: t.status, listed: false };
}

/**
 * L-TRD.3 for a page: before a signed action, ask the customer to confirm when it would cancel the
 * account's live offer. True when there is nothing to cancel or the customer confirmed.
 */
export function confirmCancelsOffer(
  env: Pick<OperationEnv, 'store' | 'scope'>,
  account: string,
  action: Parameters<typeof guardSignedAction>[0],
  confirm: (message: string) => boolean = (m) => window.confirm(m),
): boolean {
  const g = guardFor(env, account, action);
  return g.kind === 'ok' || (g.kind === 'warn' && confirm(g.message));
}
