// AA 00060 (audit C12 note 1, auditor A's oracle probe): Bridge out's paid-out coin prediction
// (../src/bridge/out.ts `paidOutNonce`) against the account contract's own generated standard library
// (compactc 0.35.0 `_sendShielded_0`): the nonce, colour and value tx1 pays the landing key.

import { createHash } from 'node:crypto';

import { createCircuitContext, createConstructorContext } from '@midnight-ntwrk/compact-runtime-0.20';
import { describe, expect, it } from 'vitest';

import { Contract } from '../../../vendor/passport/contract/src/wallet/contract.js';
import { landingCoinCommitment, paidOutNonce } from '../src/bridge/out.js';
import { bytesToHex } from '../src/hex.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
const det = (label: string) => new Uint8Array(createHash('sha256').update(`aa00060 ${label}`).digest());

describe('the paid-out nonce against the generated standard library', () => {
  it('paidOutNonce equals _sendShielded_0(...).sent.nonce of the account contract', async () => {
    const witnesses = new Proxy(
      {},
      {
        get: () => () => {
          throw new Error('no witness');
        },
      },
    );
    const contract = new Contract(witnesses as never) as any;
    const init = await contract.initialState(
      createConstructorContext({}, '11'.repeat(32)),
      det('boot'),
      det('enc'),
      det('salt'),
      { bytes: new Uint8Array(32) },
      { bytes: new Uint8Array(32) },
    );
    for (let i = 0; i < 6; i++) {
      const ctx = createCircuitContext({
        circuitId: 'withdraw_shielded_with_ed25519',
        contractAddress: bytesToHex(det('address')),
        coinPublicKeyOrZswapState: '11'.repeat(32),
        contractState: init.currentContractState.data as never,
        privateState: {},
      } as never);
      const pd = {
        input: { value: [], alignment: [] },
        output: undefined,
        publicTranscript: [],
        privateTranscriptOutputs: [],
      };
      const coin = {
        nonce: i === 5 ? new Uint8Array(32).fill(0xff) : det(`nonce ${i}`),
        color: det(`c ${i}`),
        value: 1_000_000n,
        mt_index: 3n,
      };
      const recipient = { is_left: true, left: { bytes: det(`r ${i}`) }, right: { bytes: new Uint8Array(32) } };
      const res = await contract._sendShielded_0(ctx, pd, coin, recipient, 400_000n);
      expect(paidOutNonce(bytesToHex(coin.nonce))).toBe(bytesToHex(res.sent.nonce));
      expect(bytesToHex(res.sent.color)).toBe(bytesToHex(coin.color));
      expect(res.sent.value).toBe(400_000n);
      expect(
        landingCoinCommitment(
          { nonce: bytesToHex(res.sent.nonce), color: bytesToHex(coin.color), value: '400000' },
          bytesToHex(det(`r ${i}`)),
        ),
      ).toMatch(/^[0-9a-f]{64}$/);
    }
  }, 60_000);
});
/* eslint-enable @typescript-eslint/no-explicit-any */
