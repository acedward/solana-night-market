// B1.5: the browser's `ActionSigning` over Track A's Ed25519 arm (../src/wallet/signing.ts), with a
// tweetnacl key in the place of Phantom's `signMessage`. Everything here runs the compiled account's
// pure circuits on compact-runtime 0.20.0, the only runtime the browser bundle carries.

import nacl from 'tweetnacl';
import {
  buildRelayActionMessage,
  bytesToHex,
  hexToBytes,
  registryFor,
  type DeviceSigner,
  type OpenSwapPayload,
} from '@nightmarket/core';
import { solanaRelayActionScheme } from '@nightmarket/core/solana-auth';
import { ed25519DeviceForCheck, withdrawRequest, callContext } from '@nightmarket/core/passport';
import { describe, expect, it } from 'vitest';

import { EnvelopeSignatureError, ed25519ActionSigning, type CallToAuthorise } from '../src/wallet/signing.js';

const tokens = registryFor('stagenet');
const display = { network: 'stagenet', tokens } as const;
const twUSDC = tokens.bySymbol('twUSDC')!.midnightColour;
const twETH = tokens.bySymbol('twETH')!.midnightColour;
const ACCOUNT = 'c0'.repeat(32);
const ctx = { account: ACCOUNT, authNonce: 5n, networkSalt: '71'.repeat(32) };

/** A Solana-style wallet: tweetnacl over a fixed seed; records every message it is asked to sign. */
function naclWallet(seedByte = 1) {
  const kp = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(seedByte));
  const asked: Uint8Array[] = [];
  const signer: DeviceSigner = {
    deviceKey: bytesToHex(kp.publicKey),
    address: 'unused-in-these-tests',
    signMessage: async (m) => (asked.push(m), nacl.sign.detached(m, kp.secretKey)),
  };
  return { signer, asked };
}

const gated: CallToAuthorise = {
  kind: 'gated',
  request: withdrawRequest({
    recipient: '22'.repeat(32),
    color: twUSDC,
    amount: '1500000',
    coin: { nonce: '33'.repeat(32), color: twUSDC, value: '5000000', mtIndex: '9' },
    authNonce: '5',
  }),
};

const swapPayload: OpenSwapPayload = {
  giveColor: twUSDC,
  giveAmount: '2000000',
  wantColor: twETH,
  wantAmount: '1000000000000000',
  wantNonce: '44'.repeat(32),
  wantEntry: '55'.repeat(192),
  changeEntry: '66'.repeat(192),
  validUntil: '1900000000',
  coin: { nonce: '77'.repeat(32), color: twUSDC, value: '3000000', mtIndex: '12' },
  authNonce: '5',
};

describe('ed25519ActionSigning (the browser side of the arm)', () => {
  it('previews exactly the text the wallet then signs, once per call', async () => {
    const { signer, asked } = naclWallet();
    const signing = ed25519ActionSigning(signer, display);
    expect(signing.deviceKey).toBe(signer.deviceKey);
    const { text } = signing.preview(ctx, gated);
    expect(text.startsWith('Night Market - stagenet \nWithdraw shielded\n')).toBe(true);
    expect(asked).toHaveLength(0);
    const auth = await signing.authorise(ctx, gated, 4n);
    expect(asked).toHaveLength(1);
    expect(new TextDecoder().decode(asked[0])).toBe(text);
    expect(auth).toMatchObject({ owner: signer.deviceKey, useCounter: '4' });
    expect(nacl.sign.detached.verify(asked[0]!, hexToBytes(auth.signature), hexToBytes(signer.deviceKey))).toBe(true);
    // What the relay does with it: rebuild from the same call, verify the same signature.
    await expect(ed25519DeviceForCheck(auth, display).sign(callContext(ctx), gated.request, 4n)).resolves.toBeTruthy();
  });

  it('signs a swap (make or take) over its readable terms', async () => {
    const { signer, asked } = naclWallet(2);
    const signing = ed25519ActionSigning(signer, display);
    const call: CallToAuthorise = { kind: 'swap', action: 'open-swap', payload: swapPayload };
    const { text } = signing.preview(ctx, call);
    const lines = text.split('\n');
    expect(lines[1]).toBe('Swap offer');
    expect(lines[2]).toContain(' 2.000000 twUSDC ');
    expect(lines[3]).toContain(' 0.001000000000000000 twETH ');
    expect(lines[5]).toBe(`Expires ${'1900000000'.padStart(20)}`);
    const auth = await signing.authorise(ctx, { ...call, action: 'take' }, 0n);
    expect(new TextDecoder().decode(asked[0])).toBe(text);
    expect(auth.useCounter).toBe('0');
  });

  it("finds the device's use counter with the arm's own entry derivation", async () => {
    const { signer } = naclWallet(3);
    const signing = ed25519ActionSigning(signer, display);
    const { ed25519DeviceForKey } = await import('@nightmarket/core/passport');
    const device = ed25519DeviceForKey(signer.deviceKey);
    const entry = (k: bigint) => bytesToHex(device.entryAt(hexToBytes(ACCOUNT, 32), 2n, k));
    const state = {
      account: ACCOUNT,
      booted: true,
      deviceCount: 1,
      deviceEpoch: '2',
      devices: [entry(6n)],
      authNonce: '5',
      inboxCount: '0',
      encKey: '00'.repeat(32),
      networkSalt: '71'.repeat(32),
    };
    expect(signing.useCounter(state, 0n)).toBe(6n);
    expect(signing.useCounter(state, 6n)).toBe(6n);
    expect(signing.useCounter({ ...state, devices: [] }, 0n)).toBeNull();
  });

  it('refuses before any proof: a wallet that signs something else', async () => {
    const { signer } = naclWallet(4);
    const other = naclWallet(5).signer;
    const wrongKey = ed25519ActionSigning({ ...signer, signMessage: other.signMessage }, display);
    await expect(wrongKey.authorise(ctx, gated, 0n)).rejects.toThrow(/tweetnacl pre-check/);
  });

  it("signs the relay envelope in lane B3's Solana scheme (Track A's proof-of-key text), checked before it is sent", async () => {
    const { signer, asked } = naclWallet(6);
    const signing = ed25519ActionSigning(signer, display);
    const message = buildRelayActionMessage({
      action: 'register',
      network: 'stagenet',
      owner: signer.deviceKey,
      payload: { encPublicKey: 'ab'.repeat(32) },
      nonce: `0x${'12'.repeat(32)}`,
      expiry: 1_900_000_000,
    });
    const signature = await signing.relayAction(message);
    expect(asked).toHaveLength(1);
    const text = new TextDecoder().decode(asked[0]);
    expect(text.split('\n').slice(0, 2)).toEqual(['Night Market - stagenet', 'Prove you hold this key']);
    expect(text).toContain('This signature authorises nothing and moves no funds.');
    expect(solanaRelayActionScheme.verify(message, hexToBytes(signature))).toBe(true);
    // Another key's signature, or an envelope for another owner, never leaves the page.
    const other = naclWallet(7).signer;
    const wrong = ed25519ActionSigning({ ...signer, signMessage: other.signMessage }, display);
    await expect(wrong.relayAction(message)).rejects.toBeInstanceOf(EnvelopeSignatureError);
    await expect(signing.relayAction({ ...message, owner: other.deviceKey })).rejects.toBeInstanceOf(
      EnvelopeSignatureError,
    );
  });
});
