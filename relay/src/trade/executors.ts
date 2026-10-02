// The two trade actions (plan L-TRD): `open-swap` (make an offer) and `take` (take one whole live
// offer). Each is ONE call of the device arm's swap circuit (../passport/arm.ts) signed by the
// customer, proven here with a fully guaranteed transcript (./account-offer.ts), on the prover lane
// (one proof at a time). Everything below is arm-agnostic: the arm checks the call's signature.
//
//   open-swap: prove → bind → `swapoffer1…` → `POST /v1/offers` → wait until the exchange lists it.
//              Nothing is balanced or submitted: a taker settles it later, and the batcher pays.
//   take:      read the maker's offer from the exchange → check it is exactly what the customer
//              signed to take, legs in segment 0 → prove the complement → merge (token-balanced)
//              → check the cost against the chain's LIVE parameters → the batcher
//              (`midnight-balancer`) adds DUST and submits ONE transaction.
//
// The sponsor wallet is only borrowed for its public keys (midnight-js needs a wallet provider to
// build a call); neither action spends the sponsor's DUST. The coin the give is paid from is the
// call's private state for this job only, and is wiped when the job ends (Q5).
//
// Whose failure is it (AA 00047 P11, audit round 3 R3-7 / F-B3-6)? The failure budget charges only
// failures the requester caused (../actions/failure-budget.ts), and the batcher's refusals read as the
// counterparty's (`exchange-error`, `take-refused`: a maker who cancelled must not lock takers out).
// A taker could therefore take a live offer with its OWN spent coin (a valid membership path still
// proves) and repeat the failure for free. So:
//   - BEFORE proving, the coin the call spends is checked unspent on chain (../chain/coin-spend.ts:
//     its nullifier against the account's whole history): `coin-spent`, nothing proven (make and
//     take alike);
//   - AFTER a settlement refusal, the relay looks at the taker's side first: its coin spent meanwhile
//     → `coin-spent`, its account's auth nonce moved (another of its approvals landed) →
//     `stale-authorisation`; both are the taker's and are charged. Only otherwise is the refusal the
//     maker's or the exchange's (not charged), and those are bounded per account by
//     `TAKES_UNSETTLED_PER_ACCOUNT_PER_DAY` (../actions/account-caps.ts `admitTake`).

import type { ExpiryLimits, OpenSwapResult, TakeResult } from '@nightmarket/core';

import type { DigestReplayGuard } from '../auth/verifiers.js';
import type { Logger } from '../log.js';
import type { DeviceArm, TradeAction, TradeCheckOk } from '../passport/arm.js';
import { MemoryPrivateStateProvider } from '../passport/private-state.js';
import type { PassportRuntime } from '../passport/runtime.js';
import type { SponsorWalletHandle } from '../passport/wallet-provider.js';
import { assertCoinUnspent, coinSpent, type SpendReader } from '../chain/coin-spend.js';
import { PublicError, type JobContext, type JobExecutor } from '../queue/jobs.js';
import type { SponsorSession } from '../sponsor/session.js';
import { AccountOfferError, proveGuaranteedOffer, type AccountOfferCall } from './account-offer.js';
import { assertSignedExpiryOpen } from './expiry.js';
import { fetchOfferBytes, publishOffer, waitOfferStatus } from './publish.js';
import { TakeRefusal, checkMakerOffer, mergeForSettlement, submitSettlement } from './settle.js';

export interface TradeDeps {
  runtime: () => PassportRuntime | null;
  /** The device arm: checks each call's own signature (../passport/arm.ts). */
  arm: DeviceArm;
  sponsor: SponsorSession;
  kernelUrl: string;
  batcherUrl: string;
  batcherTarget?: string;
  replay: DigestReplayGuard;
  log: Logger;
  /** For tests: the kernel's and the batcher's HTTP. */
  fetchImpl?: typeof fetch;
  /** For tests: the proving step (default: proveGuaranteedOffer). */
  prove?: typeof proveGuaranteedOffer;
  /** For tests: the maker's ledger transaction from its bytes (default: ledger-v9). */
  deserialize?: (bytes: Uint8Array) => Promise<unknown>;
  /** For tests: the chain's ledger parameters (default: the indexer's latest). */
  ledgerParameters?: (rt: PassportRuntime, account: string) => Promise<unknown>;
  /** Poll timings (tests shorten them). */
  timings?: { publishRetryMs?: number; statusPollMs?: number; statusTimeoutMs?: number };
  /** Told when the batcher refuses a take (health shows the last one, plan P4-A). */
  onBatcherRefusal?: (httpStatus: number) => void;
  /** The limits on a call's signed expiry (audit C6; default: packages/core's). */
  expiry?: ExpiryLimits;
  /** For tests: Unix seconds now. */
  now?: () => number;
  /** The spent coins of an account (AA 00047 P11, R3-7): a call's coin is checked unspent before its
   *  proof, and a refused take is attributed. Absent: no check (tests of other behaviour). */
  coins?: SpendReader;
}

/**
 * The customer's words for a take the batcher did not settle (plan P4-A error states). The batcher
 * answers 429 at its request cap (1000 a day per client and across all clients, research finding
 * 13) and a generic 500 for failures, including a settlement it has already seen (L-TRD.0).
 */
export function batcherRefusalError(httpStatus: number, error: string | undefined): PublicError {
  if (httpStatus === 429) {
    return new PublicError(
      'exchange-busy',
      "the exchange's settlement service is not taking more settlements right now (HTTP 429: it allows a limited number a day). Nothing was settled and your coins did not move; try again later",
    );
  }
  if (httpStatus >= 500) {
    return new PublicError(
      'exchange-error',
      `the exchange's settlement service failed (HTTP ${httpStatus}) and did not confirm the take. Refresh the book: if the offer was taken by someone else it is gone, and if your take settled after all your balances show it`,
    );
  }
  return new PublicError(
    'take-refused',
    `the exchange did not settle the take${error ? `: ${error.slice(0, 300)}` : ''}`,
  );
}

/**
 * A take the batcher refused, attributed (AA 00047 P11, R3-7): the TAKER's fault when its own coin is
 * spent by now (`coin-spent`) or its account moved past the signed nonce (`stale-authorisation`), both
 * charged to it; otherwise the maker's or the exchange's (`exchange-error`, `take-refused`; not
 * charged). A 429 is the exchange's cap. When the chain cannot be read, the refusal stays the
 * counterparty's (never charge on a guess).
 */
export async function attributeSettlementRefusal(
  deps: Pick<TradeDeps, 'coins' | 'log'>,
  rt: Pick<PassportRuntime, 'ledgerState'>,
  account: string,
  taker: { coin: { nonce: string; color: string; value: string }; authNonce: string },
  httpStatus: number,
  error: string | undefined,
): Promise<PublicError> {
  const counterparty = batcherRefusalError(httpStatus, error);
  if (httpStatus === 429) return counterparty;
  try {
    if (deps.coins && (await coinSpent(deps.coins, account, taker.coin))) {
      return new PublicError(
        'coin-spent',
        'the exchange did not settle the take: the coin it pays with was already spent on Midnight. Refresh your balances and take again with another coin',
      );
    }
    const ledger = await rt.ledgerState(account);
    if (ledger && ledger.auth_nonce !== BigInt(taker.authNonce)) {
      return new PublicError(
        'stale-authorisation',
        'the exchange did not settle the take: another approval of your account landed first, so this one can no longer settle. Take again and sign once more',
      );
    }
  } catch (e) {
    deps.log.warn('a refused take could not be attributed (chain read failed)', { error: e });
  }
  return counterparty;
}

const seconds = (ms: number) => Math.round(ms / 100) / 10;

function needRuntime(deps: TradeDeps): PassportRuntime {
  const rt = deps.runtime();
  if (!rt)
    throw new PublicError('not-available', 'the market cannot run account operations right now (no prover keys)');
  return rt;
}

async function recheck<A extends TradeAction>(deps: TradeDeps, action: A, raw: unknown, ctx: JobContext) {
  const rt = needRuntime(deps);
  const body = raw as { account?: string; passportAuth?: unknown };
  const { account: _a, passportAuth: _p, signer: _s, auth: _auth, ...payload } = raw as Record<string, unknown>;
  const check = await deps.arm.checkTradeCall(rt, action, body.account, payload, body.passportAuth);
  if (!check.ok) {
    ctx.log.info('trade call no longer valid at run time', { code: check.code });
    throw new PublicError(check.code === 'expired' ? 'stale-authorisation' : 'unauthorised', check.reason);
  }
  // The signed expiry, again now that the job runs (audit C6): no proof for an approval that ended.
  assertSignedExpiryOpen(action, check.payload.validUntil, deps.expiry, deps.now);
  return { rt, check };
}

async function withReplayRelease<T>(deps: TradeDeps, digestHex: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    deps.replay.release(digestHex);
    throw e;
  }
}

/** The call's arguments, as upstream offer.ts takes them, from a checked payload. */
async function callOf(deps: TradeDeps, check: TradeCheckOk): Promise<AccountOfferCall> {
  const { openSwapArgs } = await import('@nightmarket/core/passport');
  const { call, coin } = openSwapArgs(check.payload);
  return { call, coin, authArgs: deps.arm.authArgs(check.auth) };
}

async function defaultLedgerParameters(rt: PassportRuntime, account: string): Promise<unknown> {
  const pdp = (rt as unknown as { shared: { publicDataProvider: unknown } }).shared.publicDataProvider as {
    queryZSwapAndContractState(a: string): Promise<readonly unknown[] | null>;
  };
  const states = await pdp.queryZSwapAndContractState(account);
  if (!states) throw new PublicError('not-available', 'the chain state could not be read');
  return states[2];
}

async function defaultDeserialize(bytes: Uint8Array): Promise<unknown> {
  const ledger = (await import('@midnightntwrk/ledger-v9')) as unknown as {
    Transaction: { deserialize(s: string, p: string, b: string, raw: Uint8Array): unknown };
  };
  return ledger.Transaction.deserialize('signature', 'proof', 'binding', bytes);
}

function proveError(e: unknown): never {
  if (e instanceof AccountOfferError) {
    throw new PublicError('offer-not-provable', `the offer could not be built as a takeable offer: ${e.message}`);
  }
  throw e;
}

/** `open-swap`: make an offer and publish it. */
export function openSwapExecutor(deps: TradeDeps): JobExecutor {
  return async (raw, ctx) => {
    const { rt, check } = await recheck(deps, 'open-swap', raw, ctx);
    const offer = await callOf(deps, check);
    // R3-7: an offer paid from a spent coin could never settle; refuse it before any proof.
    if (deps.coins) {
      const coins = deps.coins;
      await withReplayRelease(deps, check.digestHex, () => assertCoinUnspent(coins, check.account, check.payload.coin));
    }
    const prove = deps.prove ?? proveGuaranteedOffer;
    const proven = await withReplayRelease(deps, check.digestHex, () =>
      ctx.prove(() =>
        deps.sponsor.withWallet(async (w) => {
          const privateState = new MemoryPrivateStateProvider();
          try {
            const providers = await rt.providers(w as SponsorWalletHandle, privateState);
            ctx.stage('proving', { circuit: deps.arm.circuits.openSwap });
            return await prove({
              rt,
              providers,
              account: check.account,
              offer,
              circuitId: deps.arm.circuits.openSwap,
            }).catch(proveError);
          } finally {
            privateState.wipe();
          }
        }),
      ),
    );
    ctx.stage('proven', { offerId: proven.offerId });
    const posted = await publishOffer(proven.blob, {
      kernelUrl: deps.kernelUrl,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      ...(deps.timings?.publishRetryMs !== undefined ? { retryDelayMs: deps.timings.publishRetryMs } : {}),
    });
    if (!posted.accepted) {
      // The signature was spent on a proof the exchange refused; nothing reached the chain, so the
      // customer may sign again (a new digest: the want nonce is fresh each time).
      throw new PublicError(
        'offer-refused',
        `the exchange refused the offer${posted.code ? ` (${posted.code})` : ''}: ${posted.reason ?? `HTTP ${posted.status}`}`,
      );
    }
    ctx.stage('posted', { offerId: proven.offerId });
    const status = await waitOfferStatus(proven.offerId, ['live', 'consumed'], {
      kernelUrl: deps.kernelUrl,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      ...(deps.timings?.statusPollMs !== undefined ? { pollMs: deps.timings.statusPollMs } : {}),
      timeoutMs: deps.timings?.statusTimeoutMs ?? 90_000,
    });
    ctx.stage(status === 'live' ? 'listed' : `status-${status}`, { offerId: proven.offerId });
    const result: OpenSwapResult = {
      offerId: proven.offerId,
      kernel: { accepted: true, status, code: posted.code, reason: posted.reason },
      legSegment: proven.structure.legSegments[0] ?? 0,
      proveSeconds: seconds(proven.proveMs),
      expiresAt: proven.expiresAt,
      bytes: proven.bytes.length,
    };
    return result as unknown as Record<string, unknown>;
  };
}

/** `take`: take one whole live offer in one transaction through the batcher. */
export function takeExecutor(deps: TradeDeps): JobExecutor {
  return async (raw, ctx) => {
    const { rt, check } = await recheck(deps, 'take', raw, ctx);
    const p = check.payload as TradeCheckOk<'take'>['payload'];
    const give = { colour: p.giveColor, amount: BigInt(p.giveAmount) };
    const want = { colour: p.wantColor, amount: BigInt(p.wantAmount) };

    // The maker's offer, from the exchange, BEFORE any proof is spent on the take.
    const maker = await fetchOfferBytes(p.offerId, {
      kernelUrl: deps.kernelUrl,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    }).catch(() => {
      throw new PublicError('exchange-unavailable', 'the exchange could not be reached to read the offer');
    });
    if (!maker) throw new PublicError('offer-gone', 'the offer is no longer on the exchange');
    if (maker.status && maker.status !== 'live') {
      throw new PublicError('offer-gone', `the offer is ${maker.status}: it can no longer be taken`);
    }
    const makerTx = (await (deps.deserialize ?? defaultDeserialize)(maker.bytes)) as Parameters<
      typeof checkMakerOffer
    >[0];
    try {
      checkMakerOffer(makerTx, { give, want });
    } catch (e) {
      if (e instanceof TakeRefusal) throw new PublicError(`take-${e.code}`, e.message);
      throw e;
    }
    ctx.stage('offer-checked', { offerId: p.offerId });

    const offer = await callOf(deps, check);
    // R3-7: the taker's coin must be unspent BEFORE any proof (a spent coin still proves membership).
    if (deps.coins) {
      const coins = deps.coins;
      await withReplayRelease(deps, check.digestHex, () => assertCoinUnspent(coins, check.account, p.coin));
    }
    const prove = deps.prove ?? proveGuaranteedOffer;
    return withReplayRelease(deps, check.digestHex, () =>
      ctx.prove(() =>
        deps.sponsor.withWallet(async (w) => {
          const privateState = new MemoryPrivateStateProvider();
          try {
            const providers = await rt.providers(w as SponsorWalletHandle, privateState);
            ctx.stage('proving', { circuit: deps.arm.circuits.openSwap });
            const taker = await prove({
              rt,
              providers,
              account: check.account,
              offer,
              circuitId: deps.arm.circuits.openSwap,
            }).catch(proveError);
            const params = await (deps.ledgerParameters ?? defaultLedgerParameters)(rt, check.account);
            let settlement: ReturnType<typeof mergeForSettlement>;
            try {
              settlement = mergeForSettlement(makerTx, taker.tx as never, params);
            } catch (e) {
              if (e instanceof TakeRefusal) throw new PublicError(`take-${e.code}`, e.message);
              throw e;
            }
            ctx.stage('merged', { blockUsage: settlement.cost.enforced?.blockUsage ?? '' });
            const address = (
              w as { unshieldedKeystore?: { getBech32Address?(): { asString(): string } } }
            ).unshieldedKeystore
              ?.getBech32Address?.()
              ?.asString();
            if (!address) throw new PublicError('not-available', 'the relay wallet has no submitter address');
            const b = await submitSettlement({
              batcherUrl: deps.batcherUrl,
              merged: settlement.merged as unknown as { serialize(): Uint8Array },
              address,
              ...(deps.batcherTarget ? { target: deps.batcherTarget } : {}),
              ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
            }).catch((e: unknown) => {
              deps.log.warn('the batcher could not be reached', { error: e });
              throw new PublicError(
                'exchange-unavailable',
                "the exchange's settlement service could not be reached or did not answer in time. Refresh the book: if your take settled after all, your balances show it",
              );
            });
            if (!b.ok || !b.transactionHash) {
              deps.log.warn('the batcher refused a take', { status: b.httpStatus, error: b.error });
              deps.onBatcherRefusal?.(b.httpStatus);
              throw await attributeSettlementRefusal(deps, rt, check.account, p, b.httpStatus, b.error);
            }
            ctx.stage('settled', { tx: b.transactionHash, offerId: p.offerId });
            const result: TakeResult = {
              offerId: p.offerId,
              txHash: b.transactionHash,
              proveSeconds: seconds(taker.proveMs),
              cost: {
                blockUsage: settlement.cost.enforced!.blockUsage,
                computeTimePs: settlement.cost.enforced!.computeTime,
                readTimePs: settlement.cost.enforced!.readTime,
                feesSpecks: settlement.cost.feesSpecks,
              },
              path: 'batcher',
            };
            return result as unknown as Record<string, unknown>;
          } finally {
            privateState.wipe();
          }
        }),
      ),
    );
  };
}
