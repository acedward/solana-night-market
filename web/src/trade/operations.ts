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
// (never the relay's transaction TTL). "Cancel offer" ends it sooner (../passport/operations.ts
// `cancelOpenApprovals`, questions Q30).
//
// An approval is marked ENDED only from what this browser reads on the CHAIN, and its own signed
// expiry (AA 00047 P10, audit round 2 R2-4; spec FR-004b "Round 2"), never from the relay's or the
// exchange's word: filled once its own call's wanted-coin note is in the account's inbox and the
// account's nonce moved; cancelled once the nonce moved and no such note is there; expired once its
// signed `validUntil` passed. The exchange's "consumed" or "expired" is the LISTING's state, shown
// apart (`kernelStatus`); one they call taken shows "Settling" until the chain shows it (questions
// Q44). Records an older page ended too early (on a relay's "succeeded" or the exchange's
// "expired") are decided again (`reconcileOffers`).

import {
  confirmedOnChain,
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
  cancelOpenApprovals,
  dropJob,
  gatedContext,
  putJob,
  syncAccount,
  updateJob,
  type OperationEnv,
} from '../passport/operations.js';
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
  const job = await env.relay.submit(action, { account, payload, passportAuth });
  putJob(env, account, job, action, context);
  env.onJob?.(job);
  const done = await env.relay.waitForJob(job.requestId, (j) => updateJob(env, account, j));
  dropJob(env, account, job.requestId);
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
  const giveToken = legs.side === 'sell' ? pair.base : pair.quote;
  const validUntil = signedValidUntil('make', now);
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

/** One read of the account on the chain: its auth nonce and its coins (the inbox walk's). */
export interface ChainView {
  authNonce: bigint;
  coins: readonly StoredCoin[];
}

/**
 * What the CHAIN (and the approval's own signed expiry) says of one of the account's approvals, a
 * make or a take (AA 00047 P10, R2-4). From one read of the account (its nonce and its inbox are one
 * state, so a fill and the nonce it moves are seen together):
 *   filled     the account's nonce moved past the one it signed AND its own call's wanted-coin note
 *              is in the inbox (the call files it in the same transaction); `settledTx` once the
 *              chain shows that coin's leaf (its creating transaction);
 *   cancelled  the nonce moved and no such note is there: it can never execute (another signed call,
 *              or "Cancel offer");
 *   expired    the nonce has not moved but its SIGNED `validUntil` passed: the circuit refuses it;
 *   live       otherwise: it can still execute, whatever the exchange or the relay says.
 */
export function decideApproval(t: TradeRecord, chain: ChainView, now: number): TradeRecord {
  if (chain.authNonce > BigInt(t.authNonce)) {
    const note = chain.coins.find((c) => c.inInbox && c.nonce === t.wantNonce);
    if (!note) {
      const { settledTx: _s, ...rest } = t;
      return { ...rest, status: 'cancelled' };
    }
    return {
      ...t,
      status: 'filled',
      ...(confirmedOnChain(note) && note.createdTx ? { settledTx: note.createdTx } : {}),
    };
  }
  const { settledTx: _s, ...open } = t;
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
  // Everything but a fill the chain confirmed (its settling transaction known) and a refusal.
  const open = readTrades(env.store, env.scope, account).filter(
    (t) => t.status !== 'refused' && !(t.status === 'filled' && t.settledTx),
  );
  if (open.length === 0) return [];
  const synced = await syncAccount(env, account);
  const chain: ChainView = { authNonce: BigInt(synced.state.authNonce), coins: synced.coins };
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
    putTrade(env.store, env.scope, account, next);
    if (next.status !== o.status || next.settledTx !== o.settledTx) changed.push(next);
  }
  return changed;
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

/**
 * "Cancel offer" (audit C6, questions Q30): land the nonce bump that ends every open approval of the
 * account. Done only when the CHAIN shows the new nonce (`cancelOpenApprovals`), and an offer shows
 * Cancelled only when, on that chain read, it was not filled instead (R2-4: a fill moves the nonce
 * too, and a relay can settle the offer it holds and report the cancel done).
 */
export async function cancelOffers(env: OperationEnv, account: string): Promise<{ txId: string; cancelled: number }> {
  const { txId } = await cancelOpenApprovals(env, account);
  const changed = await reconcileOffers(env, account, null);
  return { txId, cancelled: changed.filter((t) => t.status === 'cancelled').length };
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
