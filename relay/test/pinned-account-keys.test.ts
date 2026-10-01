// AA 00047 P9.S (questions Q26): the web build pins the verifier keys of a Night Market account
// (packages/core/src/passport/pinned-account-keys.ts, written by scripts/pin-account-keys.ts from the
// relay key volume). The browser refuses any account whose on-chain operations are not exactly these,
// so the pinned circuits must be exactly the market shape this relay deploys: a change of the shape
// (plan P9.C drops the device pair, Q27) fails here until the pin is regenerated (plan P9.I).

import { describe, expect, it } from 'vitest';

import { PINNED_ACCOUNT_KEYS } from '@nightmarket/core/passport';

import { accountCircuitIds } from '../src/passport/account-shape.js';

describe('the web build’s pinned account verifier keys', () => {
  it('cover exactly the circuits the relay deploys in a market account', () => {
    expect(Object.keys(PINNED_ACCOUNT_KEYS.circuits).sort()).toEqual([...accountCircuitIds()].sort());
  });

  it('name the key set and the passport commit they were taken from', () => {
    expect(PINNED_ACCOUNT_KEYS.keySet).toMatch(/^[0-9a-f]{64}$/);
    expect(PINNED_ACCOUNT_KEYS.passportCommit).toMatch(/^[0-9a-f]{40}$/);
  });
});
