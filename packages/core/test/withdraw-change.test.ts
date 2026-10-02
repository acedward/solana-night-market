// AA 00047 P9.S (audit C7, questions Q28 A): a shielded withdrawal's change, computed in the browser,
// must be exactly the coin the contract's `sendShielded` returns. The oracle is the generated module
// itself: its `_sendShielded_0` (the standard library's code, as compactc 0.35.0 emitted it) run on a
// real constructor state.

import { createHash } from 'node:crypto';

import { createCircuitContext, createConstructorContext } from '@midnight-ntwrk/compact-runtime-0.20';
import { describe, expect, it } from 'vitest';

import { Contract, pureCircuits } from '../../../vendor/passport/contract/src/wallet/contract.js';
import { bytesToHex, hexToBytes } from '../src/hex.js';
import { predictWithdrawChange, sameCoin, sendShieldedChangeNonce } from '../src/passport/withdraw-change.js';

const det = (label: string) => new Uint8Array(createHash('sha256').update(`aa00047 p9s change ${label}`).digest());
const witnesses = new Proxy(
  {},
  {
    get: () => () => {
      throw new Error('no witness');
    },
  },
);
const COIN_PK = '11'.repeat(32);

/** The generated `sendShielded` run on a real account state: the change it returns. */
async function contractChange(coin: { nonce: Uint8Array; color: Uint8Array; value: bigint }, amount: bigint) {
  const contract = new Contract(witnesses as never) as unknown as {
    initialState(ctx: unknown, ...a: unknown[]): Promise<{ currentContractState: { data: unknown } }>;
    _sendShielded_0(
      ctx: unknown,
      pd: unknown,
      input: unknown,
      recipient: unknown,
      value: bigint,
    ): Promise<{
      change: { is_some: boolean; value: { nonce: Uint8Array; color: Uint8Array; value: bigint } };
    }>;
  };
  const init = await contract.initialState(
    createConstructorContext({}, COIN_PK),
    det('boot'),
    det('enc'),
    det('salt'),
    { bytes: new Uint8Array(32) },
    { bytes: new Uint8Array(32) },
  );
  const ctx = createCircuitContext({
    circuitId: 'withdraw_shielded_with_ed25519',
    contractAddress: bytesToHex(det('address')),
    coinPublicKeyOrZswapState: COIN_PK,
    contractState: init.currentContractState.data as never,
    privateState: {},
  });
  const pd = {
    input: { value: [], alignment: [] },
    output: undefined,
    publicTranscript: [],
    privateTranscriptOutputs: [],
  };
  const res = await contract._sendShielded_0(
    ctx,
    pd,
    { ...coin, mt_index: 7n },
    { is_left: true, left: { bytes: det('recipient') }, right: { bytes: new Uint8Array(32) } },
    amount,
  );
  return res.change.is_some
    ? {
        nonce: bytesToHex(res.change.value.nonce),
        color: bytesToHex(res.change.value.color),
        value: res.change.value.value.toString(),
      }
    : null;
}

describe('predictWithdrawChange (Q28 A)', () => {
  it('equals the change the contract’s sendShielded returns, for any coin and amount', async () => {
    for (const [i, [value, amount]] of [
      [1_000n, 300n],
      [60_000_000n, 1n],
      [2n ** 64n - 1n, 2n ** 63n], // a coin's value is a u64 in its commitment
      [10n ** 18n, 10n ** 18n - 1n],
    ].entries()) {
      const coin = { nonce: det(`nonce ${i}`), color: det(`colour ${i}`), value };
      const ours = predictWithdrawChange(
        { nonce: bytesToHex(coin.nonce), color: bytesToHex(coin.color), value: value.toString() },
        amount,
      );
      expect(ours).toEqual(await contractChange(coin, amount));
    }
  });

  it('has no change when the whole coin is paid, and refuses more than the coin', async () => {
    const coin = { nonce: bytesToHex(det('n')), color: bytesToHex(det('c')), value: '500' };
    expect(predictWithdrawChange(coin, 500n)).toBeNull();
    expect(
      await contractChange({ nonce: hexToBytes(coin.nonce), color: hexToBytes(coin.color), value: 500n }, 500n),
    ).toBeNull();
    expect(() => predictWithdrawChange(coin, 501n)).toThrow(RangeError);
  });

  it('is NOT the offer’s change rule (swap_change_nonce): the two differ', () => {
    const n = det('either');
    expect(sendShieldedChangeNonce(bytesToHex(n))).not.toBe(
      bytesToHex((pureCircuits as { swap_change_nonce(x: Uint8Array): Uint8Array }).swap_change_nonce(n)),
    );
  });

  it('sameCoin compares nonce, colour and value', () => {
    const a = { nonce: 'AA'.repeat(32), color: '0x' + 'bb'.repeat(32), value: '10' };
    expect(sameCoin(a, { nonce: 'aa'.repeat(32), color: 'bb'.repeat(32), value: '10' })).toBe(true);
    expect(sameCoin(a, { ...a, value: '11' })).toBe(false);
    expect(sameCoin(a, null)).toBe(false);
  });
});
