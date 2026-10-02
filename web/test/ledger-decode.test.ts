// AA 00047 P11.B (questions Q47 A): the page's own ledger-v9 decoder (../src/chain/ledger-decode.ts)
// on REAL stagenet data (test/fixtures/stagenet-p11b/: market accounts A and B of the P6 acceptance,
// read from the public indexer), on the serialised events the mocks build
// (packages/core/test/fixtures/ledger-events.ts), and on what it must refuse.

import { describe, expect, it } from 'vitest';

import {
  compactHex,
  zswapInputEventHex,
  zswapOutputEventHex,
} from '../../packages/core/test/fixtures/ledger-events.js';
import { LedgerDecodeError, decodeAccountTx, decodeEvent, decodeTransactionCalls } from '../src/chain/ledger-decode.js';
import { txsOfActions, type IndexerAction } from '../src/chain/history.js';
import accountA from '../../test/fixtures/stagenet-p11b/account-a-history.json';
import accountB from '../../test/fixtures/stagenet-p11b/account-b-history.json';
import tx4464 from '../../test/fixtures/stagenet-p11b/tx-4464f3f4.json';
import tx6ed6 from '../../test/fixtures/stagenet-p11b/tx-6ed69abc.json';
import tx9f64 from '../../test/fixtures/stagenet-p11b/tx-9f64780f.json';

const FIXTURES: Record<string, { data: Record<string, unknown> }> = {
  'account-a-history.json': accountA,
  'account-b-history.json': accountB,
  'tx-4464f3f4.json': tx4464,
  'tx-6ed69abc.json': tx6ed6,
  'tx-9f64780f.json': tx9f64,
};
const fixture = (name: string) => FIXTURES[name]!;

const A = '453b2b8d3fbf9900a562b5e29ebe517745e7b0a44c753c821d0e95503a763751';
const B = '57351491d79469efb1f170ae2a792c94a0cf41038f0c3d41a0572ff549c0412e';
const TAKE = '4464f3f4a8b35999350418c4741cc2c4aa4fce44913c8982e8bf137cb5b7620c';
const WITHDRAW = '6ed69abc2887d49eee7aa1d596aa33c2d8b92f8e4d7fde02a312513cbe97ac88';

const historyOf = (name: string) => txsOfActions((fixture(name).data.contract as { actions: IndexerAction[] }).actions);

describe('the page decodes real stagenet transactions of a market account (ledger-v9 in the page)', () => {
  it("account A: every leaf at the ledger's own position, every spend, nothing of account B", () => {
    const txs = historyOf('account-a-history.json').map((t) => decodeAccountTx(A, t));
    const byHash = Object.fromEntries(txs.map((t) => [t.hash.slice(0, 8), t]));
    expect(txs).toHaveLength(7);
    // The deploy, the maintenance update and the activation carry no Zswap event.
    expect(txs.filter((t) => t.outputs.length + t.inputs.length === 0)).toHaveLength(3);
    // Two deposits (demo tokens): one leaf each.
    expect(byHash['4002fc3e']!.outputs).toEqual([
      { commitment: '6e1a5a599d32f896b68b5cf31f10a4595380c8c5cd78cea1b50d13de80086f6b', mtIndex: '5179' },
    ]);
    expect(byHash['9f64780f']!.outputs).toEqual([
      { commitment: 'bddb1aa5155d4955c57d32d24da07818158d01f85421b63731d017dc9622e271', mtIndex: '5180' },
    ]);
    // The take that filled A's offer: A's two leaves (the wanted coin and the change) and A's spend;
    // B's leaves at 5183 and 5185 and B's spend, in the same transaction, are not A's.
    expect(byHash['4464f3f4']!.outputs).toEqual([
      { commitment: '4ea95a9ecbbc6cf61309939a7ab56599ec3d4a8b410637cacf282a51caebf49b', mtIndex: '5184' },
      { commitment: 'edc20df6f937d9d57b2c0ab6b922b579a82b7c06af3b1eb31a5990bc5b548e37', mtIndex: '5186' },
    ]);
    expect(byHash['4464f3f4']!.inputs).toEqual(['5af4437dfd239d35581358cc9aa1b91f83b4d00e075da643fde4d7e747eec2a2']);
    expect(byHash['4464f3f4']!.entryPoints).toEqual(['open_swap_shielded_with_ed25519']);
    // The withdrawal: A's spend; the withdrawn coin is the wallet's (no contract), not A's.
    expect(byHash['6ed69abc']!.inputs).toEqual(['aea3047d94bd83b666aae60683a4b6c3efb5cdc38e29eb06f58eebff9be12552']);
    expect(byHash['6ed69abc']!.outputs).toEqual([]);
  });

  it("account B: the same take, from B's side", () => {
    const take = historyOf('account-b-history.json')
      .map((t) => decodeAccountTx(B, t))
      .find((t) => t.hash === TAKE)!;
    expect(take.outputs.map((o) => o.mtIndex)).toEqual(['5183', '5185']);
    expect(take.inputs).toEqual(['db9640fdfc37ab2af41060a1caacf6742861b849394277ed0cb4db3829df66f8']);
  });

  it('the take, decoded from its raw bytes: each account’s own swap call with what it receives and spends', () => {
    const tx = (fixture('tx-4464f3f4.json').data.transactions as Array<{ raw: string }>)[0]!;
    const calls = decodeTransactionCalls(tx.raw);
    const ofA = calls.find((c) => c.address === A)!;
    const ofB = calls.find((c) => c.address === B)!;
    expect(calls).toHaveLength(2);
    expect(ofA.entryPoint).toBe('open_swap_shielded_with_ed25519');
    expect(ofA.receives).toEqual([
      '4ea95a9ecbbc6cf61309939a7ab56599ec3d4a8b410637cacf282a51caebf49b',
      'edc20df6f937d9d57b2c0ab6b922b579a82b7c06af3b1eb31a5990bc5b548e37',
    ]);
    expect(ofA.nullifiers).toEqual(['5af4437dfd239d35581358cc9aa1b91f83b4d00e075da643fde4d7e747eec2a2']);
    expect(ofB.entryPoint).toBe('open_swap_shielded_with_ed25519');
    expect(ofB.nullifiers).toEqual(['db9640fdfc37ab2af41060a1caacf6742861b849394277ed0cb4db3829df66f8']);
  });

  it('a withdrawal and a deposit, decoded from their raw bytes', () => {
    const w = decodeTransactionCalls((fixture('tx-6ed69abc.json').data.transactions as Array<{ raw: string }>)[0]!.raw);
    expect(w.map((c) => [c.address, c.entryPoint, c.nullifiers])).toEqual([
      [A, 'withdraw_shielded_with_ed25519', ['aea3047d94bd83b666aae60683a4b6c3efb5cdc38e29eb06f58eebff9be12552']],
    ]);
    const d = decodeTransactionCalls((fixture('tx-9f64780f.json').data.transactions as Array<{ raw: string }>)[0]!.raw);
    // The demo pack's `direct` path: the faucet's mint and the account's deposit, in one transaction.
    expect(d.map((c) => [c.address, c.entryPoint, c.receives])).toEqual([
      ['a112d24a943ae2344efabbb5b40cb15d931b489993440f917ce4498af063091a', 'mint', []],
      [A, 'deposit_shielded', ['bddb1aa5155d4955c57d32d24da07818158d01f85421b63731d017dc9622e271']],
    ]);
    expect(WITHDRAW).toHaveLength(64);
  });
});

describe('the serialised events the mocks build are what ledger-v9 reads', () => {
  const tx = 'ab'.repeat(32);
  for (const mtIndex of [0n, 63n, 64n, 5183n, 16383n, 16384n, (1n << 29n) + 7n]) {
    it(`a leaf at ${mtIndex} (compact ${compactHex(mtIndex)})`, () => {
      const raw = zswapOutputEventHex({ txHash: tx, contract: A, commitment: 'cd'.repeat(32), mtIndex });
      expect(decodeEvent(raw)).toEqual({
        kind: 'output',
        commitment: 'cd'.repeat(32),
        contract: A,
        mtIndex,
        source: tx,
      });
    });
  }
  it('a spend', () => {
    const raw = zswapInputEventHex({ txHash: tx, contract: B, nullifier: 'ef'.repeat(32) });
    expect(decodeEvent(raw)).toEqual({ kind: 'input', nullifier: 'ef'.repeat(32), contract: B, source: tx });
  });
  it('a real stagenet event is byte-identical to the one built from its decoded fields', () => {
    const real = (fixture('account-a-history.json').data.contract as { actions: IndexerAction[] }).actions.flatMap(
      (a) => a.transaction.zswapLedgerEvents ?? [],
    );
    const leaf = real.find((e) => e.raw.includes('6e1a5a599d32f896'))!;
    expect(
      zswapOutputEventHex({
        txHash: '4002fc3ef94cfdc68ad2d981b099559b68bf1945913cad83f17dd351e02baa15',
        contract: A,
        commitment: '6e1a5a599d32f896b68b5cf31f10a4595380c8c5cd78cea1b50d13de80086f6b',
        mtIndex: 5179,
      }),
    ).toBe(leaf.raw);
    const spend = real.find((e) => e.raw.includes('5af4437dfd239d35'))!;
    expect(
      zswapInputEventHex({
        txHash: TAKE,
        contract: A,
        nullifier: '5af4437dfd239d35581358cc9aa1b91f83b4d00e075da643fde4d7e747eec2a2',
      }),
    ).toBe(spend.raw);
  });
});

describe('the decoder refuses what the ledger did not emit as claimed', () => {
  const base = { id: 1, blockHeight: 10, entryPoints: ['deposit_shielded'], zswapStartIndex: 100, zswapEndIndex: 101 };
  const leaf = (txHash: string, mtIndex: number) => ({
    id: 1,
    raw: zswapOutputEventHex({ txHash, contract: A, commitment: '11'.repeat(32), mtIndex }),
  });
  it('an event that is not one', () => {
    expect(() => decodeEvent('00'.repeat(40))).toThrow(LedgerDecodeError);
    expect(() => decodeEvent('zz')).toThrow(LedgerDecodeError);
  });
  it('an event of another transaction served under this one', () => {
    expect(() => decodeAccountTx(A, { ...base, hash: 'aa'.repeat(32), events: [leaf('bb'.repeat(32), 100)] })).toThrow(
      /names another transaction/,
    );
  });
  it('a leaf outside its transaction’s range of the tree', () => {
    expect(() => decodeAccountTx(A, { ...base, hash: 'aa'.repeat(32), events: [leaf('aa'.repeat(32), 101)] })).toThrow(
      /outside its range/,
    );
    expect(
      decodeAccountTx(A, { ...base, hash: 'aa'.repeat(32), events: [leaf('aa'.repeat(32), 100)] }).outputs,
    ).toEqual([{ commitment: '11'.repeat(32), mtIndex: '100' }]);
  });
  it('a transaction that is not one', () => {
    expect(() => decodeTransactionCalls('00'.repeat(64))).toThrow(LedgerDecodeError);
  });
  it('a real transaction served under another hash', () => {
    const raw = (fixture('tx-4464f3f4.json').data.transactions as Array<{ raw: string }>)[0]!.raw;
    expect(decodeTransactionCalls(raw, TAKE)).toHaveLength(2);
    expect(() => decodeTransactionCalls(raw, WITHDRAW)).toThrow(/another transaction/);
  });
});
