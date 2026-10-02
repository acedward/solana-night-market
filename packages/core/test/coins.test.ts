// Plan L-ACC.2/.4/.5: the browser's coin list. Exact positions come from the ledger's own leaves
// (never a guess), spends from its nullifiers, coins only the browser knows are kept, and a
// payment uses ONE coin (Q9).

import { describe, expect, it } from 'vitest';

import {
  CoinChoiceError,
  chooseCoin,
  contractCoinCommitment,
  contractCoinNullifier,
  holdingsByColour,
  confirmedOnChain,
  unconfirmedCoins,
  localCoin,
  reconcileCoins,
  type OwnedInput,
  type OwnedOutput,
} from '../src/coins.js';

const ACCOUNT = 'ac'.repeat(32);
const USDC = 'a1'.repeat(32);
const STK = 'b2'.repeat(32);
const coin = (n: number, color: string, value: bigint) => ({
  nonce: n.toString(16).padStart(64, '0'),
  color,
  value: value.toString(),
});
const leaf = (c: ReturnType<typeof coin>, mtIndex: number, tx = `tx${mtIndex}`): OwnedOutput => ({
  commitment: contractCoinCommitment(c, ACCOUNT),
  mtIndex: String(mtIndex),
  txHash: tx,
  blockHeight: mtIndex,
});
const spend = (c: ReturnType<typeof coin>, tx = 'spend'): OwnedInput => ({
  nullifier: contractCoinNullifier(c, ACCOUNT),
  txHash: tx,
  blockHeight: 99,
});

describe('commitment and nullifier', () => {
  it('are 32-byte hex, distinct, and bound to the account', () => {
    const c = coin(1, USDC, 5n);
    const cm = contractCoinCommitment(c, ACCOUNT);
    const nf = contractCoinNullifier(c, ACCOUNT);
    expect(cm).toMatch(/^[0-9a-f]{64}$/);
    expect(nf).toMatch(/^[0-9a-f]{64}$/);
    expect(cm).not.toBe(nf);
    expect(contractCoinCommitment(c, 'ad'.repeat(32))).not.toBe(cm);
  });

  it('accepts 0x prefixes and upper case', () => {
    const c = coin(7, USDC, 9n);
    expect(contractCoinCommitment({ ...c, nonce: `0x${c.nonce.toUpperCase()}` }, `0x${ACCOUNT}`)).toBe(
      contractCoinCommitment(c, ACCOUNT),
    );
  });

  it('refuses a value beyond 128 bits', () => {
    expect(() => contractCoinCommitment(coin(1, USDC, 1n << 128n), ACCOUNT)).toThrow(RangeError);
  });
});

describe('reconcileCoins', () => {
  const a = coin(1, USDC, 60_000_000n);
  const b = coin(2, USDC, 40_000_000n);
  const s = coin(3, STK, 5_000_000n);

  it('gives each inbox coin its exact position from the matching leaf', () => {
    const coins = reconcileCoins({
      account: ACCOUNT,
      inbox: [
        { ...a, inboxIndex: '0' },
        { ...b, inboxIndex: '1' },
      ],
      outputs: [leaf(b, 17), leaf(coin(9, USDC, 1n), 16), leaf(a, 12)],
      inputs: [],
      previous: [],
    });
    expect(coins.map((c) => [c.value, c.mtIndex, c.inInbox, c.spent])).toEqual([
      ['60000000', '12', true, false],
      ['40000000', '17', true, false],
    ]);
    expect(coins[0]!.createdTx).toBe('tx12');
  });

  it('leaves the position unknown when no leaf matches (never a guess)', () => {
    const coins = reconcileCoins({
      account: ACCOUNT,
      inbox: [{ ...a, inboxIndex: '0' }],
      outputs: [],
      inputs: [],
      previous: [],
    });
    expect(coins[0]!.mtIndex).toBeNull();
  });

  it('marks coins spent from the ledger nullifiers', () => {
    const coins = reconcileCoins({
      account: ACCOUNT,
      inbox: [
        { ...a, inboxIndex: '0' },
        { ...b, inboxIndex: '1' },
      ],
      outputs: [leaf(a, 1), leaf(b, 2)],
      inputs: [spend(a, 'wd')],
      previous: [],
    });
    expect(coins.find((c) => c.value === a.value)).toMatchObject({ spent: true, spentTx: 'wd' });
    expect(coins.find((c) => c.value === b.value)).toMatchObject({ spent: false });
  });

  it('keeps a coin only this browser knows (a change with no inbox entry, Q13), and positions it', () => {
    const change = localCoin(coin(4, USDC, 10_000_000n), ACCOUNT, 'change', 'wd');
    expect(change).toMatchObject({ inInbox: false, mtIndex: null, origin: 'change' });
    const coins = reconcileCoins({
      account: ACCOUNT,
      inbox: [],
      outputs: [leaf(coin(4, USDC, 10_000_000n), 30)],
      inputs: [],
      previous: [change],
    });
    expect(coins).toEqual([expect.objectContaining({ mtIndex: '30', inInbox: false, origin: 'change' })]);
    // Once its entry is filed, the next walk marks it recoverable from the chain.
    const later = reconcileCoins({
      account: ACCOUNT,
      inbox: [{ ...coin(4, USDC, 10_000_000n), inboxIndex: '5' }],
      outputs: [leaf(coin(4, USDC, 10_000_000n), 30)],
      inputs: [],
      previous: coins,
    });
    expect(later).toEqual([
      expect.objectContaining({ mtIndex: '30', inInbox: true, origin: 'change', inboxIndex: '5' }),
    ]);
  });

  it('does not duplicate a coin found both locally and in the inbox', () => {
    const prev = reconcileCoins({
      account: ACCOUNT,
      inbox: [{ ...s, inboxIndex: '0' }],
      outputs: [leaf(s, 3)],
      inputs: [],
      previous: [],
    });
    const again = reconcileCoins({
      account: ACCOUNT,
      inbox: [{ ...s, inboxIndex: '0' }],
      outputs: [leaf(s, 3)],
      inputs: [],
      previous: prev,
    });
    expect(again).toHaveLength(1);
  });
});

// AA 00047 P11.B (audit round 3 R3-3 / F-B3-2, questions Q47 A, Q53): coins are keyed by their FULL
// commitment, and a position comes only from a leaf with exactly that commitment.
describe('reconcileCoins keys every coin by its full commitment (R3-3)', () => {
  // Auditor A's probe `evidence/00047-mn-bank-solana/audit/round3/auditor-A/audit-a3-probe-coins.ts`,
  // as a test: a genuine 1-unit coin at position 7, then a second note with the SAME colour and nonce
  // claiming 10^12. Before P11.B the note took over the coin, its position and its confirmation.
  it('auditor A’s probe: a counterfeit note never inherits the genuine coin’s position, nor replaces it', () => {
    const colour = 'e934b965a454ed6857080e9956ea83fb5542e0a860e96ce91daf35f5d7b02c9f';
    const nonce = '22'.repeat(32);
    const genuine = { nonce, color: colour, value: '1' };
    const commitment = contractCoinCommitment(genuine, ACCOUNT);
    const outputs = [{ commitment, mtIndex: '7', txHash: 'aa'.repeat(32), blockHeight: 1 }];
    const walk1 = reconcileCoins({
      account: ACCOUNT,
      inbox: [{ ...genuine, inboxIndex: '0' }],
      outputs,
      inputs: [],
      previous: [],
    });
    expect(walk1.map((c) => [c.value, c.mtIndex])).toEqual([['1', '7']]);
    const walk2 = reconcileCoins({
      account: ACCOUNT,
      inbox: [
        { ...genuine, inboxIndex: '0' },
        { nonce, color: colour, value: '1000000000000', inboxIndex: '1' },
      ],
      outputs,
      inputs: [],
      previous: walk1,
    });
    expect(walk2.map((c) => [c.value, c.mtIndex, c.commitment === commitment])).toEqual([
      ['1000000000000', null, false],
      ['1', '7', true],
    ]);
    const [h] = holdingsByColour(walk2);
    expect(h).toMatchObject({ total: 1n, largest: 1n, coins: 1, unpositioned: 1 });
    expect(() => chooseCoin(walk2, colour, 500_000_000_000n)).toThrow(CoinChoiceError);
    expect(chooseCoin(walk2, colour, 1n)).toMatchObject({ value: '1', mtIndex: '7' });
    // The same with the counterfeit FIRST in the inbox: the order does not matter.
    const swapped = reconcileCoins({
      account: ACCOUNT,
      inbox: [
        { nonce, color: colour, value: '1000000000000', inboxIndex: '0' },
        { ...genuine, inboxIndex: '1' },
      ],
      outputs,
      inputs: [],
      previous: [],
    });
    expect(holdingsByColour(swapped)[0]).toMatchObject({ total: 1n });
  });

  it('a stored position (an older page’s, or a relay’s) is never taken on trust: no leaf, no position', () => {
    const a = coin(1, USDC, 60_000_000n);
    const stored = { ...localCoin(a, ACCOUNT, 'change', 'relay-said'), mtIndex: '12' };
    const [c] = reconcileCoins({ account: ACCOUNT, inbox: [], outputs: [], inputs: [], previous: [stored] });
    expect(c).toMatchObject({ mtIndex: null });
    expect(c!.createdTx).toBeUndefined();
    expect(confirmedOnChain(c!)).toBe(false);
    // A stored record whose `commitment` field lies about the coin is recomputed from the coin itself.
    const lying = { ...stored, commitment: 'ff'.repeat(32) };
    const [d] = reconcileCoins({ account: ACCOUNT, inbox: [], outputs: [leaf(a, 12)], inputs: [], previous: [lying] });
    expect(d).toMatchObject({ commitment: contractCoinCommitment(a, ACCOUNT), mtIndex: '12' });
  });

  it('two notes describing the same coin are one coin; another value is another coin', () => {
    const a = coin(1, USDC, 60_000_000n);
    const coins = reconcileCoins({
      account: ACCOUNT,
      inbox: [
        { ...a, inboxIndex: '0' },
        { ...a, inboxIndex: '4' },
        { ...a, value: '60000001', inboxIndex: '5' },
      ],
      outputs: [leaf(a, 3)],
      inputs: [],
      previous: [],
    });
    expect(coins.map((c) => [c.value, c.inboxIndex, c.mtIndex])).toEqual([
      ['60000001', '5', null],
      ['60000000', '0', '3'],
    ]);
  });

  it('a coin set aside by this browser stays set aside until released; a chain spend names its transaction', () => {
    const a = coin(1, USDC, 60_000_000n);
    const aside = {
      ...localCoin(a, ACCOUNT, 'inbox'),
      inInbox: true,
      inboxIndex: '0',
      spent: true,
      spentTx: 'relay-tx',
    };
    const [kept] = reconcileCoins({
      account: ACCOUNT,
      inbox: [{ ...a, inboxIndex: '0' }],
      outputs: [leaf(a, 1)],
      inputs: [],
      previous: [aside],
    });
    expect(kept).toMatchObject({ spent: true, mtIndex: '1' });
    const [spentOnChain] = reconcileCoins({
      account: ACCOUNT,
      inbox: [{ ...a, inboxIndex: '0' }],
      outputs: [leaf(a, 1)],
      inputs: [spend(a, 'chain-tx')],
      previous: [aside],
    });
    expect(spentOnChain).toMatchObject({ spent: true, spentTx: 'chain-tx' });
  });
});

describe('holdings and the coin a payment uses (Q9)', () => {
  const coins = reconcileCoins({
    account: ACCOUNT,
    inbox: [
      { ...coin(1, USDC, 60_000_000n), inboxIndex: '0' },
      { ...coin(2, USDC, 40_000_000n), inboxIndex: '1' },
      { ...coin(3, USDC, 90_000_000n), inboxIndex: '2' }, // spent
      { ...coin(5, USDC, 99_000_000n), inboxIndex: '3' }, // no leaf yet
    ],
    outputs: [
      leaf(coin(1, USDC, 60_000_000n), 1),
      leaf(coin(2, USDC, 40_000_000n), 2),
      leaf(coin(3, USDC, 90_000_000n), 3),
    ],
    inputs: [spend(coin(3, USDC, 90_000_000n))],
    previous: [],
  });

  it('adds the unspent coins the chain confirms and names the largest single payment', () => {
    // 100 wUSDC as 60 + 40 shows "largest single payment 60" (spec US2 scenario 1); the spent
    // coin is out. The coin without a position is NOT in the total (AA 00047 P10, R2-6): only
    // counted as unconfirmed, since an inbox note alone proves nothing.
    expect(holdingsByColour(coins)).toEqual([
      { color: USDC, total: 100_000_000n, largest: 60_000_000n, coins: 2, unpositioned: 1, notInInbox: 0 },
    ]);
    expect(unconfirmedCoins(coins).map((c) => c.value)).toEqual(['99000000']);
  });

  // AA 00047 P10 (audit round 2, R2-6 / F-A2-4): anyone can file an inbox note with
  // `deposit_shielded`, describing a coin that exists nowhere. It must never show as a coin.
  it('never counts an inbox note whose coin the chain does not confirm (a fake deposit note)', () => {
    const fake = reconcileCoins({
      account: ACCOUNT,
      inbox: [{ ...coin(9, STK, 1_000_000_000_000n), inboxIndex: '0' }],
      outputs: [], // no leaf anywhere: the note describes nothing on chain
      inputs: [],
      previous: [],
    });
    expect(fake).toHaveLength(1);
    expect(confirmedOnChain(fake[0]!)).toBe(false);
    expect(holdingsByColour(fake)).toEqual([]); // no row, no total
    expect(unconfirmedCoins(fake)).toHaveLength(1);
    expect(() => chooseCoin(fake, STK, 1n)).toThrow(/no spendable coin/);
  });

  it('pays from the smallest single coin that covers the amount', () => {
    expect(chooseCoin(coins, USDC, 30_000_000n).value).toBe('40000000');
    expect(chooseCoin(coins, USDC, 41_000_000n).value).toBe('60000000');
    expect(chooseCoin(coins, `0x${USDC.toUpperCase()}`, 60_000_000n).mtIndex).toBe('1');
  });

  it('refuses an amount no single coin covers, naming the largest', () => {
    expect(() => chooseCoin(coins, USDC, 80_000_000n)).toThrow(CoinChoiceError);
    expect(() => chooseCoin(coins, USDC, 80_000_000n)).toThrow(/largest single payment is 60000000/);
    expect(() => chooseCoin(coins, STK, 1n)).toThrow(/no spendable coin/);
  });
});
