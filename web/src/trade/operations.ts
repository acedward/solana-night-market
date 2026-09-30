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

import {
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
  takeLegs,
} from '@nightmarket/core';
import { freshWantNonce, offerInboxEntriesPortable, predictChangeCoin } from '@nightmarket/core/passport';

import {
  OperationError,
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
    validUntil: '0',
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
    throw new OperationError(jobErrorText(done.error, 'The market could not complete this.'));
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
  const { payload, passportAuth, coin } = await buildCall(env, account, 'open-swap', legs, giveToken);
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
    expiresAt: r.expiresAt,
    status: r.kernel.status === 'consumed' ? 'filled' : 'live',
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
  const { payload, passportAuth, coin } = await buildCall(env, account, 'take', legs, giveToken, entry.offerId);
  const summary = tradeSummary(legs.side, legs.baseRaw, pair.base, legs.effectivePrice, pair.quote);
  const takePayload: TakePayload = { ...payload, offerId: entry.offerId };
  const done = await runJob(env, account, 'take', takePayload as never, passportAuth, { summary });
  const r = done.result as unknown as TakeResult;
  // The call executed: the counter moved, the coin is spent, and any live offer of ours is dead.
  env.store.put(env.scope, 'roster', { useCounter: (BigInt(passportAuth.useCounter) + 1n).toString(10) }, { account });
  const coins = readCoins(env.store, env.scope, account).map((c) =>
    c.commitment === coin.commitment ? { ...c, spent: true, spentTx: r.txHash } : c,
  );
  env.store.put(env.scope, 'coins', coins, { account });
  const trades = readTrades(env.store, env.scope, account);
  for (const other of trades) {
    if (other.role === 'make' && other.status === 'live')
      putTrade(env.store, env.scope, account, { ...other, status: 'cancelled' });
  }
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
    expiresAt: Date.now(),
    status: 'filled',
    kernelStatus: 'consumed',
    settledTx: r.txHash,
    checkedAt: Date.now(),
  };
  putTrade(env.store, env.scope, account, record);
  await syncAccount(env, account).catch(() => undefined);
  return record;
}

/**
 * Reconcile My offers (FR-011: "reconcile the account when anyone settles it"): walk the inbox
 * first, then decide each offer from the chain and the exchange:
 *   filled     a coin with the offer's want nonce reached the account (the settling tx is its
 *              creating transaction), or the exchange says consumed;
 *   expired    past the intent's TTL, or the exchange says so;
 *   cancelled  the account's auth nonce moved and the offer was not filled (another signed call);
 *   live       otherwise.
 * Returns the offers whose state changed.
 */
export async function reconcileOffers(
  env: OperationEnv,
  account: string,
  kernel: Pick<KernelClient, 'offerStatus'>,
  now = Date.now(),
): Promise<TradeRecord[]> {
  // Live offers, and filled ones whose settling transaction the inbox walk has not shown yet (the
  // exchange can report "consumed" a moment before the indexer serves the new inbox entries).
  const makes = readTrades(env.store, env.scope, account).filter(
    (t) => t.role === 'make' && (t.status === 'live' || (t.status === 'filled' && !t.settledTx)),
  );
  if (makes.length === 0) return [];
  const synced = await syncAccount(env, account);
  const changed: TradeRecord[] = [];
  for (const o of makes) {
    let kernelStatus: KernelOfferStatus | undefined;
    try {
      kernelStatus = await kernel.offerStatus(o.offerId);
    } catch {
      kernelStatus = undefined;
    }
    const received = synced.coins.find((c) => c.nonce === o.wantNonce);
    let next: TradeRecord = { ...o, checkedAt: now, ...(kernelStatus ? { kernelStatus } : {}) };
    if (received || kernelStatus === 'consumed') {
      next = { ...next, status: 'filled', ...(received?.createdTx ? { settledTx: received.createdTx } : {}) };
    } else if (kernelStatus === 'expired' || now >= o.expiresAt) {
      next = { ...next, status: 'expired' };
    } else if (BigInt(synced.state.authNonce) !== BigInt(o.authNonce)) {
      next = { ...next, status: 'cancelled' };
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

/** After another signed call executed (a withdrawal, a re-filed change), every live offer of the
 *  account is dead: its auth nonce moved (Q9). */
export function markLiveOffersCancelled(env: Pick<OperationEnv, 'store' | 'scope'>, account: string): number {
  let n = 0;
  for (const t of readTrades(env.store, env.scope, account)) {
    if (t.role === 'make' && t.status === 'live') {
      putTrade(env.store, env.scope, account, { ...t, status: 'cancelled' });
      n++;
    }
  }
  return n;
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
