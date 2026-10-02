// The browser computes a contract-owned coin's commitment with SHA-256 over the ledger's binary
// layout (packages/core/src/coins.ts). This checks it against the ledger's own WASM (ledger-v9
// 1.0.0-rc.3, the pinned stagenet ledger): the commitment of an output a contract owns.

import { ZswapChainState, ZswapInput, ZswapOffer, ZswapOutput } from '@midnightntwrk/ledger-v9';
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { contractCoinCommitment, contractCoinNullifier } from '@nightmarket/core';

const hex = (n: number) => randomBytes(n).toString('hex');

describe('contract-owned coin commitment', () => {
  it('equals ledger-v9 ZswapOutput.newContractOwned(...).commitment for random coins', () => {
    const values = [0n, 1n, 1_000_000n, 2n ** 63n - 1n, 2n ** 64n - 1n, 123_456_789_012n];
    for (const value of values) {
      const coin = { nonce: hex(32), type: hex(32), value };
      const contract = hex(32);
      const ledger = ZswapOutput.newContractOwned(coin, undefined, contract).commitment;
      const ours = contractCoinCommitment({ nonce: coin.nonce, color: coin.type, value: value.toString() }, contract);
      expect(ours).toBe(String(ledger).replace(/^0x/, '').toLowerCase());
    }
  });

  it('changes with the owner, the value, the nonce and the colour', () => {
    const base = { nonce: '11'.repeat(32), color: '22'.repeat(32), value: '5' };
    const a = contractCoinCommitment(base, '33'.repeat(32));
    expect(contractCoinCommitment(base, '34'.repeat(32))).not.toBe(a);
    expect(contractCoinCommitment({ ...base, value: '6' }, '33'.repeat(32))).not.toBe(a);
    expect(contractCoinCommitment({ ...base, nonce: '12'.repeat(32) }, '33'.repeat(32))).not.toBe(a);
    expect(contractCoinCommitment({ ...base, color: '23'.repeat(32) }, '33'.repeat(32))).not.toBe(a);
  });
});

// AA 00047 P11 (audit round 3 R3-7): the relay refuses a coin whose nullifier the account's history
// shows BEFORE proving (../src/chain/coin-spend.ts). The nullifier it computes must be the ledger's.
describe('contract-owned coin nullifier', () => {
  it('equals ledger-v9 ZswapInput.newContractOwned(...).nullifier for random coins', () => {
    for (const value of [1n, 1_000_000n, 2n ** 64n - 1n]) {
      const coin = { nonce: hex(32), type: hex(32), value };
      const contract = hex(32);
      const output = ZswapOutput.newContractOwned(coin, undefined, contract);
      const [applied] = new ZswapChainState().tryApply(ZswapOffer.fromOutput(output, coin.type, coin.value));
      const state = applied.postBlockUpdate(new Date(), 3600n);
      const input = ZswapInput.newContractOwned({ ...coin, mt_index: 0n } as never, undefined, contract, state);
      const ours = contractCoinNullifier({ nonce: coin.nonce, color: coin.type, value: value.toString() }, contract);
      expect(ours).toBe(String(input.nullifier).replace(/^0x/, '').toLowerCase());
    }
  });
});
