// The signed expiry of a make or a take (AA 00047 P9, audit C6: F-A4, F-B4), on the relay.
//
// Every offer and take signs a real `validUntil` (Unix seconds; packages/core/src/offer-expiry.ts),
// which the circuit enforces (`blockTimeLt`). The relay follows it everywhere it decides time:
//   - ADMISSION (`expiryAdmission`): a call with no expiry ("Expires never"), with less than the
//     minimum time left, or further ahead than the action's maximum lifetime is refused before any
//     queue slot, proof or DUST;
//   - RUN TIME (`assertSignedExpiryOpen`): the same check again when the job starts (a queue can be
//     long), before any proving time is spent;
//   - THE TRANSACTION (./account-offer.ts `withProofDeadline`): every intent's TTL is capped at it,
//     and the reported `expiresAt` is the earlier of the two;
//   - REPLAY (../auth/verifiers.ts `DigestReplayGuard.claim`): an accepted approval's digest is
//     remembered at least until its expiry.

import { checkSignedExpiry, DEFAULT_EXPIRY_LIMITS, type ExpiryLimits, type ExpiryProblem } from '@nightmarket/core';

import type { AdmissionCheck } from '../actions/admission.js';
import { PublicError } from '../queue/jobs.js';
import type { TradeAction } from '../passport/arm.js';

const nowSeconds = () => Math.floor(Date.now() / 1000);

/** The error code a refusal answers with (`expired` alone would read like a stale auth nonce). */
export function expiryCode(p: ExpiryProblem): 'no-expiry' | 'approval-expired' | 'expiry-too-far' {
  return p.code === 'expired' ? 'approval-expired' : p.code;
}

/** The admission check of `open-swap` and `take`: the signed `validUntil` must be usable now. */
export function expiryAdmission(
  action: TradeAction,
  limits: ExpiryLimits = DEFAULT_EXPIRY_LIMITS,
  now: () => number = nowSeconds,
): AdmissionCheck {
  return async ({ payload }) => {
    const validUntil = typeof payload.validUntil === 'string' ? payload.validUntil : '0';
    const problem = checkSignedExpiry(action, validUntil, now(), limits);
    if (!problem) return { ok: true };
    return { ok: false, status: 400, code: expiryCode(problem), reason: problem.reason };
  };
}

/** The same check when the job starts; throws the customer's error before any proof. */
export function assertSignedExpiryOpen(
  action: TradeAction,
  validUntil: string,
  limits: ExpiryLimits = DEFAULT_EXPIRY_LIMITS,
  now: () => number = nowSeconds,
): void {
  const problem = checkSignedExpiry(action, validUntil, now(), limits);
  if (problem) throw new PublicError(expiryCode(problem), problem.reason);
}
