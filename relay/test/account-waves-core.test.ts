// AA 00047 P11.A (audit round 3, R3-1): the browser checks a new account's ORIGIN against the waves
// the market deploys (@nightmarket/core/passport `MARKET_ACCOUNT_WAVES`: the deploy carries exactly
// wave 1, and the one maintenance update adds exactly wave 2 and retires the authority). Those waves
// must be exactly the ones this relay deploys (../src/passport/account-shape.ts `accountWaves`), in
// the same split, or every new account would be refused (or a wrong split accepted).

import { describe, expect, it } from 'vitest';

import { MARKET_ACCOUNT_WAVES } from '@nightmarket/core/passport';

import { accountWaves } from '../src/passport/account-shape.js';

describe('the waves the browser expects of a new account', () => {
  it('are exactly the waves this relay deploys', () => {
    const relay = accountWaves();
    expect([...MARKET_ACCOUNT_WAVES.waveOne]).toEqual(relay.waveOne);
    expect([...MARKET_ACCOUNT_WAVES.waveTwo]).toEqual(relay.waveTwo);
  });
});
