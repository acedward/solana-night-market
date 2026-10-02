// AA 00047 P11.F, audit round 4 R4-2 (F-B4-2, F-A4-3): a take the exchange did not settle is judged by
// the transaction that spent its coin or moved its account's nonce (../src/trade/reconcile.ts). The
// executor-level cases are in ./coin-spend.test.ts.

import { describe, expect, it } from 'vitest';

import { contractCoinCommitment, contractCoinNullifier } from '@nightmarket/core';

import type { AccountTxView } from '../src/chain/indexer.js';
import { isNonceMoving, judgeTake } from '../src/trade/reconcile.js';

const ACCOUNT = '5e'.repeat(32);
const take = {
  coin: { nonce: '44'.repeat(32), color: 'b2'.repeat(32), value: '4000000' },
  want: { nonce: '11'.repeat(32), color: 'a1'.repeat(32), value: '2000000' },
  authNonce: '2',
};
const SWAP = 'open_swap_shielded_with_ed25519';
const spent = contractCoinNullifier(take.coin, ACCOUNT);
const wanted = contractCoinCommitment(take.want, ACCOUNT);
const tx = (o: Partial<AccountTxView> & { hash: string }): AccountTxView => ({
  blockHeight: 101,
  entryPoints: [],
  outputs: [],
  inputs: [],
  ...o,
});
const judge = (txs: AccountTxView[], ledgerNonce: bigint | null = 2n, startedAt = 100) =>
  judgeTake({ account: ACCOUNT, take, txs, startedAt, ledgerNonce });

describe('judgeTake', () => {
  it('settled: the wanted coin’s leaf in a swap of the account, whatever the nonce says', () => {
    expect(judge([tx({ hash: 'a1', entryPoints: [SWAP], outputs: [wanted], inputs: [spent] })], 3n)).toEqual({
      kind: 'settled',
      txHash: 'a1',
    });
    // The wanted leaf without a swap call (a deposit of that coin) is not a settlement.
    expect(judge([tx({ hash: 'a2', entryPoints: ['deposit_shielded'], outputs: [wanted] })]).kind).toBe('counterparty');
  });

  it('the coin’s spender decides: another swap → raced; a gated non-swap call → the taker; no call → unresolved', () => {
    expect(judge([tx({ hash: 'b1', entryPoints: [SWAP], inputs: [spent] })])).toEqual({
      kind: 'raced',
      txHash: 'b1',
      by: 'coin',
    });
    expect(judge([tx({ hash: 'b2', entryPoints: ['withdraw_shielded_with_ed25519'], inputs: [spent] })])).toEqual({
      kind: 'taker',
      code: 'coin-spent',
      txHash: 'b2',
    });
    expect(judge([tx({ hash: 'b3', inputs: [spent] })]).kind).toBe('unresolved');
  });

  it('a moved nonce: the first gated call after the job’s read decides; a swap in that block wins', () => {
    const rotate = tx({ hash: 'c1', blockHeight: 102, entryPoints: ['rotate_enc_key_with_ed25519'] });
    const swap = tx({ hash: 'c2', blockHeight: 103, entryPoints: [SWAP] });
    expect(judge([rotate, swap], 4n)).toEqual({ kind: 'taker', code: 'stale-authorisation', txHash: 'c1' });
    expect(judge([{ ...swap, blockHeight: 102 }, rotate], 4n)).toEqual({ kind: 'raced', txHash: 'c2', by: 'nonce' });
    expect(judge([rotate, { ...swap, blockHeight: 102 }], 4n)).toEqual({ kind: 'raced', txHash: 'c2', by: 'nonce' });
  });

  it('unresolved, never the taker’s: nothing after the read, only deposits or the activation, or the nonce unreadable', () => {
    expect(judge([], 3n).kind).toBe('unresolved');
    expect(judge([tx({ hash: 'd1', entryPoints: ['deposit_shielded', 'deposit_unshielded'] })], 3n).kind).toBe(
      'unresolved',
    );
    expect(judge([tx({ hash: 'd2', blockHeight: 100, entryPoints: ['rotate_enc_key_with_ed25519'] })], 3n).kind).toBe(
      'unresolved',
    );
    expect(judge([], null).kind).toBe('unresolved');
    expect(isNonceMoving('activate_initial_device_with_ed25519')).toBe(false);
    expect(isNonceMoving('withdraw_unshielded_with_ed25519')).toBe(true);
  });

  it('counterparty: the coin unspent and the nonce unmoved', () => {
    expect(judge([tx({ hash: 'e1', entryPoints: ['rotate_enc_key_with_ed25519'], blockHeight: 90 })], 2n)).toEqual({
      kind: 'counterparty',
    });
  });
});
