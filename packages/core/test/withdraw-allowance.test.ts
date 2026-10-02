// AA 00047 P11 (audit round 3 R3-2, owner decision Q46 A at 100): the withdrawal allowance's wire
// contract (../src/withdraw-allowance.ts), shared by the relay and the page.

import { describe, expect, it } from 'vitest';

import { RELAY_ACTIONS } from '../src/auth.js';
import {
  SPONSORED_WITHDRAW_ACTIONS,
  WHOLE_COIN_EXIT,
  WITHDRAWS_DAILY_CAP_CODE,
  WITHDRAWS_DAILY_CAP_DEFAULT,
  isWholeCoinWithdrawal,
} from '../src/withdraw-allowance.js';

const coin = (value: string) => ({ nonce: 'aa'.repeat(32), color: 'bb'.repeat(32), value, mtIndex: '7' });

describe('the withdrawal allowance wire contract (Q46)', () => {
  it('names the code, the default and the two details the page reads', () => {
    expect(WITHDRAWS_DAILY_CAP_CODE).toBe('withdraws-daily-cap');
    expect(WITHDRAWS_DAILY_CAP_DEFAULT).toBe(100);
    expect(WHOLE_COIN_EXIT).toEqual({ open: 'whole-coin-exit', used: 'whole-coin-exit-used' });
  });

  it('covers every withdrawal the relay offers (a new withdrawal action must join the allowance)', () => {
    const withdrawals = RELAY_ACTIONS.filter((a) => /withdraw/.test(a));
    expect([...withdrawals].sort()).toEqual([...SPONSORED_WITHDRAW_ACTIONS].sort());
  });

  it('a shielded withdrawal is a whole-coin exit only when it spends its coin whole (no change)', () => {
    expect(isWholeCoinWithdrawal('withdraw', { amount: '500', coin: coin('500') })).toBe(true);
    expect(isWholeCoinWithdrawal('withdraw', { amount: '499', coin: coin('500') })).toBe(false);
    expect(isWholeCoinWithdrawal('withdraw', { amount: '0', coin: coin('0') })).toBe(false);
    expect(isWholeCoinWithdrawal('withdraw', { amount: '0500', coin: coin('500') })).toBe(true); // same value
    expect(isWholeCoinWithdrawal('withdraw', { amount: 500, coin: coin('500') })).toBe(false); // not the wire shape
    expect(isWholeCoinWithdrawal('withdraw', { amount: '500' })).toBe(false);
    expect(isWholeCoinWithdrawal('withdraw', { amount: '1e3', coin: coin('1000') })).toBe(false);
  });

  it('an unshielded withdrawal never makes change: any one is its token’s exit; other actions never are', () => {
    expect(isWholeCoinWithdrawal('withdraw-unshielded', { amount: '1', color: 'cc'.repeat(32) })).toBe(true);
    expect(isWholeCoinWithdrawal('cancel-offers', { amount: '1', coin: coin('1') })).toBe(false);
    expect(isWholeCoinWithdrawal('append-inbox', {})).toBe(false);
  });
});
