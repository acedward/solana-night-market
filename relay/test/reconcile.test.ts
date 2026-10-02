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

// AA 00047 P11.F2, audit round 4b R4b-1 (F-A4b-1 MAJOR, F-B4b-1): "settled" accepted ANY transaction of
// the account holding the take's wanted coin and a swap call, however old. A take that reuses an earlier
// wanted coin W (the ledger never inserts the same coin twice, so it can never settle) was judged settled
// by the OLD transaction every time: never charged, never capped. Now only the take's own settlement
// counts: a transaction after the job's pre-proof read that spends the take's coin AND pays its want.
describe('judgeTake: only the take’s OWN settlement is "settled" (R4b-1)', () => {
  const other = contractCoinNullifier({ nonce: '66'.repeat(32), color: 'b2'.repeat(32), value: '9' }, ACCOUNT);
  /** An earlier, real fill that paid the account W: auditor A's planted transaction. */
  const oldFill = tx({ hash: 'p1', blockHeight: 90, entryPoints: [SWAP], outputs: [wanted], inputs: [other] });

  it('auditor A’s scenario: a take reusing W, refused after the old fill of W, is NOT settled (the counterparty’s, capped)', () => {
    // The probe's numbers: the old fill at 100, the take's read at 500, its coin unspent, the nonce unmoved.
    const planted = { ...oldFill, blockHeight: 100 };
    expect(judgeTake({ account: ACCOUNT, take, txs: [planted], startedAt: 500, ledgerNonce: 2n })).toEqual({
      kind: 'counterparty',
    });
  });

  it('auditor B’s scenario: an old matching wanted output, a different current input, an unchanged nonce: not settled', () => {
    expect(judge([oldFill], 2n)).toEqual({ kind: 'counterparty' });
    // However many such transactions the history holds.
    expect(judge([oldFill, { ...oldFill, hash: 'p2', blockHeight: 95 }], 2n).kind).toBe('counterparty');
  });

  it('each condition is needed: later than the read, spending the take’s coin, paying its want, a swap call', () => {
    const own = tx({ hash: 's1', entryPoints: [SWAP], outputs: [wanted], inputs: [spent] });
    expect(judge([own], 3n)).toEqual({ kind: 'settled', txHash: 's1' });
    // Not later than the job's read: its coin was already spent then (a race at best), never "settled".
    expect(judge([{ ...own, blockHeight: 100 }], 3n).kind).not.toBe('settled');
    expect(judge([{ ...own, blockHeight: 100 }], 3n)).toEqual({ kind: 'raced', txHash: 's1', by: 'coin' });
    // Pays W after the read but spends ANOTHER coin (the account's own offer that wanted W, filled
    // meanwhile): it moved the nonce, a race, not this take's settlement.
    expect(judge([{ ...own, inputs: [other] }], 3n)).toEqual({ kind: 'raced', txHash: 's1', by: 'nonce' });
    // Spends the coin but does not pay W: a race (unchanged from P11.F).
    expect(judge([{ ...own, outputs: [] }], 3n)).toEqual({ kind: 'raced', txHash: 's1', by: 'coin' });
    // Spends the coin and holds W but no swap call of the account: never "settled".
    expect(judge([{ ...own, entryPoints: [] }], 3n).kind).toBe('unresolved');
  });

  it('an honest take whose settlement response was lost is still recognised: its own transaction, after the read', () => {
    const own = tx({
      hash: 'h1',
      blockHeight: 104,
      entryPoints: [SWAP],
      outputs: ['01'.repeat(32), wanted],
      inputs: [spent],
    });
    // Alongside older history that also paid the account (another want) and unrelated later deposits.
    const history = [oldFill, tx({ hash: 'd1', blockHeight: 103, entryPoints: ['deposit_shielded'] }), own];
    expect(judge(history, 3n)).toEqual({ kind: 'settled', txHash: 'h1' });
    // Even when the nonce read failed.
    expect(judge(history, null)).toEqual({ kind: 'settled', txHash: 'h1' });
  });
});
