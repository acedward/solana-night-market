// AA 00047 P11.B (questions Q47 A, Q53; audit round 3 R3-4, R3-6): the rules over the account's history
// as the browser decoded it (../src/zswap-check.ts). The decode itself, on real stagenet transactions,
// is tested in web/test/ledger-decode.test.ts and in the browser (test/e2e/zswap-decode.spec.ts).

import { describe, expect, it } from 'vitest';

import { contractCoinCommitment, contractCoinNullifier } from '../src/coins.js';
import {
  activityOf,
  fillCandidates,
  fillEvidence,
  historyCovers,
  leafOf,
  mergeAccountTxs,
  spendOf,
  type AccountHistory,
  type DecodedAccountTx,
  type DecodedCall,
} from '../src/zswap-check.js';

const ACCOUNT = 'ac'.repeat(32);
const OTHER = 'bd'.repeat(32);
const want = { nonce: '0d'.repeat(32), color: 'b2'.repeat(32), value: '2100000' };
const give = { nonce: '01'.repeat(32), color: 'a1'.repeat(32), value: '3000000' };
const W = contractCoinCommitment(want, ACCOUNT);
const G = contractCoinNullifier(give, ACCOUNT);
const SWAP = 'open_swap_shielded_with_ed25519';

const tx = (hash: string, o: Partial<DecodedAccountTx> = {}): DecodedAccountTx => ({
  hash,
  blockHeight: 10,
  id: 1,
  entryPoints: [],
  outputs: [],
  inputs: [],
  ...o,
});
const history = (txs: DecodedAccountTx[], complete = true, throughHeight = 100): AccountHistory => ({
  account: ACCOUNT,
  txs,
  complete,
  throughHeight,
});
const call = (o: Partial<DecodedCall> = {}): DecodedCall => ({
  address: ACCOUNT,
  entryPoint: SWAP,
  receives: [W],
  nullifiers: [G],
  ...o,
});

describe('the decoded history’s facts', () => {
  const h = history([
    tx('d1', { blockHeight: 3, outputs: [{ commitment: 'aa'.repeat(32), mtIndex: '5' }] }),
    tx('s1', { blockHeight: 7, inputs: [G], outputs: [{ commitment: W, mtIndex: '9' }], entryPoints: [SWAP] }),
  ]);

  it('activityOf: every leaf and spend with its transaction and height', () => {
    expect(activityOf(h)).toEqual({
      account: ACCOUNT,
      outputs: [
        { commitment: 'aa'.repeat(32), mtIndex: '5', txHash: 'd1', blockHeight: 3 },
        { commitment: W, mtIndex: '9', txHash: 's1', blockHeight: 7 },
      ],
      inputs: [{ nullifier: G, txHash: 's1', blockHeight: 7 }],
      transactions: 2,
      blockHeight: 100,
    });
  });

  it('spendOf and leafOf find the transaction from the coin itself', () => {
    expect(spendOf(h, give)?.hash).toBe('s1');
    expect(spendOf(h, want)).toBeNull();
    expect(leafOf(h, W)).toMatchObject({ mtIndex: '9', tx: { hash: 's1' } });
    expect(leafOf(h, 'cc'.repeat(32))).toBeNull();
  });

  it('historyCovers: only a COMPLETE history through the height may prove an absence', () => {
    expect(historyCovers(history([], true, 100), 100)).toBe(true);
    expect(historyCovers(history([], true, 99), 100)).toBe(false);
    expect(historyCovers(history([], false, 1_000), 100)).toBe(false);
  });

  it('mergeAccountTxs: one record per transaction, entry points united, oldest first', () => {
    const merged = mergeAccountTxs(
      [tx('B', { blockHeight: 9, entryPoints: ['deposit_shielded'] }), tx('A', { blockHeight: 2 })],
      [tx('b', { blockHeight: 9, entryPoints: [SWAP] })],
    );
    expect(merged.map((t) => [t.hash, t.entryPoints])).toEqual([
      ['a', []],
      ['b', ['deposit_shielded', SWAP]],
    ]);
  });
});

describe('fillEvidence: Filled only by the decoded swap that consumed the approval (R3-6)', () => {
  const swapTx = tx('s1', { outputs: [{ commitment: W, mtIndex: '9' }], inputs: [G], entryPoints: [SWAP] });
  const calls = (m: Record<string, DecodedCall[]>) => (h: string) => m[h];

  it('the account’s own swap call received the wanted coin and spent the approval’s coin: filled, by it', () => {
    expect(fillEvidence({ history: history([swapTx]), want, give, calls: calls({ s1: [call()] }) })).toEqual({
      txHash: 's1',
      blockHeight: 10,
    });
    // Without the paying coin known (an older record), the receive alone decides.
    expect(
      fillEvidence({ history: history([swapTx]), want, give: null, calls: calls({ s1: [call({ nullifiers: [] })] }) }),
    ).not.toBeNull();
  });

  it('a candidate needs the wanted coin’s leaf AND a swap call of the account in the transaction', () => {
    expect(fillCandidates(history([swapTx]), want)).toEqual(['s1']);
    expect(
      fillCandidates(
        history([tx('d', { outputs: [{ commitment: W, mtIndex: '9' }], entryPoints: ['deposit_shielded'] })]),
        want,
      ),
    ).toEqual([]);
    expect(fillCandidates(history([tx('s', { entryPoints: [SWAP] })]), want)).toEqual([]);
  });

  const NOT_A_FILL: Array<[string, DecodedAccountTx, DecodedCall[] | undefined]> = [
    ['its raw bytes were not read', swapTx, undefined],
    ['another contract’s swap call received it', swapTx, [call({ address: OTHER })]],
    ['a deposit call in the same transaction received it', swapTx, [call({ entryPoint: 'deposit_shielded' })]],
    ['the swap call received another coin', swapTx, [call({ receives: ['cc'.repeat(32)] })]],
    ['the swap call spent another coin (another approval)', swapTx, [call({ nullifiers: ['ee'.repeat(32)] })]],
    [
      'the swap received another coin and a deposit the wanted one',
      swapTx,
      [call({ receives: ['cc'.repeat(32)] }), call({ entryPoint: 'deposit_shielded', nullifiers: [] })],
    ],
    [
      'the wanted coin with another value',
      tx('s1', {
        outputs: [{ commitment: contractCoinCommitment({ ...want, value: '1' }, ACCOUNT), mtIndex: '9' }],
        entryPoints: [SWAP],
      }),
      [call()],
    ],
  ];
  for (const [what, t, cs] of NOT_A_FILL)
    it(`not a fill: ${what}`, () => {
      expect(fillEvidence({ history: history([t]), want, give, calls: calls(cs ? { s1: cs } : {}) })).toBeNull();
    });
});
