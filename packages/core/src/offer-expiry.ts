// An offer's and a take's SIGNED expiry (AA 00047 P9, audit C6: F-A4, F-B4). Shared by the page
// (which signs it, shows it and derives the offer's status from it) and the relay (which admits a
// call only inside it, and caps the transaction's TTL at it).
//
// `validUntil` is the swap circuit's own deadline, bound in the challenge and shown in the wallet's
// message: Unix SECONDS, checked by the ledger as `blockTimeLt(validUntil)` (the account's
// `assert_offer_live`). The contract reads 0 as "no deadline"; the relay refuses 0 since P9, so every
// offer and take carries a real expiry the customer saw, and an approval can never be exercised after
// it, by anyone, through any relay.

/** A make: the page signs now + this. One hour: the ledger intent TTL midnight-js gives a call, so the
 *  exchange's listing and the signed expiry end together. */
export const OFFER_LIFETIME_SECONDS = 3600;

/** A take: the page signs now + this (a take settles at once or not at all). The relay's maximum
 *  (`DEFAULT_EXPIRY_LIMITS.takeMaxLifetimeSeconds`) is the same value, so the page and the relay agree.
 *  It was 300 s until AA 00047 P11.F (audit round 4 R4-1 / F-A4-1): a take's job must start with
 *  `minRemainingSeconds` left, and a queue of a few minutes made every take expire before it started;
 *  600 s leaves 540 s to reach it (and the prover lane now serves takes first). */
export const TAKE_LIFETIME_SECONDS = 600;

/** The relay's limits on a signed expiry (its configuration; these are the defaults). */
export interface ExpiryLimits {
  /** The furthest ahead a make's `validUntil` may be (seconds from now). */
  offerMaxLifetimeSeconds: number;
  /** The furthest ahead a take's `validUntil` may be (seconds from now). */
  takeMaxLifetimeSeconds: number;
  /** The least time a call must have left when it is admitted, and again when its job starts: a
   *  proof takes about 20 s on stagenet, and the transaction must land before the expiry. */
  minRemainingSeconds: number;
  /** Tolerance for the browser's clock running ahead of the relay's (added to the maxima only). */
  clockSkewSeconds: number;
}

export const DEFAULT_EXPIRY_LIMITS: ExpiryLimits = {
  offerMaxLifetimeSeconds: OFFER_LIFETIME_SECONDS,
  takeMaxLifetimeSeconds: TAKE_LIFETIME_SECONDS,
  minRemainingSeconds: 60,
  clockSkewSeconds: 120,
};

export type ExpiryProblem =
  | { code: 'no-expiry'; reason: string }
  | { code: 'expired'; reason: string }
  | { code: 'expiry-too-far'; reason: string };

/**
 * Why a signed `validUntil` cannot be accepted now (null: it can). `now` is Unix seconds.
 *   - 0 ("Expires never") is refused: the approval would stay exercisable for as long as the account's
 *     nonce does not move;
 *   - less than `minRemainingSeconds` left (or already past) is refused as expired;
 *   - further ahead than the action's maximum lifetime (plus the clock-skew tolerance) is refused.
 */
export function checkSignedExpiry(
  action: 'open-swap' | 'take',
  validUntil: bigint | string,
  now: number,
  limits: ExpiryLimits = DEFAULT_EXPIRY_LIMITS,
): ExpiryProblem | null {
  const until = BigInt(validUntil);
  if (until === 0n) {
    return {
      code: 'no-expiry',
      reason: 'the approval has no expiry ("Expires never"); sign it again with an expiry',
    };
  }
  const nowB = BigInt(Math.floor(now));
  if (until < nowB + BigInt(limits.minRemainingSeconds)) {
    return {
      code: 'expired',
      reason:
        until <= nowB
          ? 'the approval has expired; sign it again'
          : `the approval expires in less than ${limits.minRemainingSeconds} s, too soon to complete; sign it again`,
    };
  }
  const max = action === 'take' ? limits.takeMaxLifetimeSeconds : limits.offerMaxLifetimeSeconds;
  if (until > nowB + BigInt(max + limits.clockSkewSeconds)) {
    return {
      code: 'expiry-too-far',
      reason: `the approval's expiry is more than ${max} s ahead (the market's limit for ${action === 'take' ? 'a take' : 'an offer'}); check this device's clock`,
    };
  }
  return null;
}
