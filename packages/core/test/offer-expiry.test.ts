// AA 00047 P9, audit C6 (F-A4, F-B4): the signed expiry of offers and takes. The relay admits a call
// only inside the expiry the wallet showed; "Expires never" (0) is refused.

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_EXPIRY_LIMITS,
  OFFER_LIFETIME_SECONDS,
  TAKE_LIFETIME_SECONDS,
  checkSignedExpiry,
} from '../src/index.js';

const NOW = 1_800_000_000;
const L = DEFAULT_EXPIRY_LIMITS;

describe('checkSignedExpiry', () => {
  it('refuses "Expires never" (0) for a make and a take', () => {
    expect(checkSignedExpiry('open-swap', '0', NOW)).toMatchObject({ code: 'no-expiry' });
    expect(checkSignedExpiry('take', 0n, NOW)).toMatchObject({ code: 'no-expiry' });
  });

  it('accepts what the page signs: a make an hour ahead, a take minutes ahead', () => {
    expect(checkSignedExpiry('open-swap', String(NOW + OFFER_LIFETIME_SECONDS), NOW)).toBeNull();
    expect(checkSignedExpiry('take', String(NOW + TAKE_LIFETIME_SECONDS), NOW)).toBeNull();
    expect(OFFER_LIFETIME_SECONDS).toBeLessThanOrEqual(L.offerMaxLifetimeSeconds);
    expect(TAKE_LIFETIME_SECONDS).toBeLessThanOrEqual(L.takeMaxLifetimeSeconds);
  });

  it('refuses an expiry already past, or too close to complete (the minimum left is inclusive)', () => {
    expect(checkSignedExpiry('open-swap', String(NOW - 1), NOW)).toMatchObject({
      code: 'expired',
      reason: expect.stringContaining('has expired'),
    });
    expect(checkSignedExpiry('open-swap', String(NOW), NOW)).toMatchObject({ code: 'expired' });
    expect(checkSignedExpiry('take', String(NOW + L.minRemainingSeconds - 1), NOW)).toMatchObject({
      code: 'expired',
      reason: expect.stringContaining('too soon'),
    });
    expect(checkSignedExpiry('take', String(NOW + L.minRemainingSeconds), NOW)).toBeNull();
  });

  it('refuses an expiry further ahead than the action allows, with the clock-skew tolerance', () => {
    const makeMax = NOW + L.offerMaxLifetimeSeconds + L.clockSkewSeconds;
    expect(checkSignedExpiry('open-swap', String(makeMax), NOW)).toBeNull();
    expect(checkSignedExpiry('open-swap', String(makeMax + 1), NOW)).toMatchObject({ code: 'expiry-too-far' });
    const takeMax = NOW + L.takeMaxLifetimeSeconds + L.clockSkewSeconds;
    expect(checkSignedExpiry('take', String(takeMax), NOW)).toBeNull();
    expect(checkSignedExpiry('take', String(takeMax + 1), NOW)).toMatchObject({ code: 'expiry-too-far' });
    // A take may not borrow a make's lifetime.
    expect(checkSignedExpiry('take', String(NOW + OFFER_LIFETIME_SECONDS), NOW)).toMatchObject({
      code: 'expiry-too-far',
    });
  });

  it('follows the limits it is given (a relay configured otherwise)', () => {
    const limits = { ...L, offerMaxLifetimeSeconds: 600, minRemainingSeconds: 0, clockSkewSeconds: 0 };
    expect(checkSignedExpiry('open-swap', String(NOW + 601), NOW, limits)).toMatchObject({ code: 'expiry-too-far' });
    expect(checkSignedExpiry('open-swap', String(NOW + 1), NOW, limits)).toBeNull();
  });
});
