// Reproduces plan 00039 P0.4's recorded (arm-agnostic) outputs through what the dApp actually
// ships: the light-compiled contracts (scripts/compile-contracts.sh), the submodule's browser-safe
// modules and the vendored offer shim. Any drift in the compile, the pin or the shim fails here.

import { sha256 } from '@noble/hashes/sha2.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { describe, expect, it } from 'vitest';

import { bytesToHex as hex } from '../src/hex.js';
import {
  generateEncKeyPairPortable,
  inboxWalkPortable,
  openEntryPortable,
  predictChangeCoin,
  sealEntryPortable,
} from '../src/passport/index.js';
import { EXPECTED, F, withSeededRandom } from './fixtures/p04-vectors.js';

const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

describe('encryption keys and inbox entries (browser-held secret)', () => {
  const fixedPub = x25519.getPublicKey(F.encSecretFixed);

  it('derives the same X25519 key pair as the spike', async () => {
    expect(hex(fixedPub)).toBe(EXPECTED.fixedEncPublicKey);
    const kp = await withSeededRandom('keypair', () => generateEncKeyPairPortable());
    expect(hex(kp.publicKey)).toBe(EXPECTED.seededKeyPairPublicKey);
    expect(hex(x25519.getPublicKey(kp.secretKey))).toBe(hex(kp.publicKey));
  });

  it('seals byte-identical 192-byte entries and opens them again', async () => {
    const entries: Uint8Array[] = [];
    for (let i = 0; i < F.plainCoins.length; i++) {
      entries.push(await withSeededRandom(`seal-${i}`, () => sealEntryPortable(fixedPub, F.plainCoins[i]!)));
    }
    expect(entries.every((e) => e.length === 192)).toBe(true);
    expect(hex(sha256(concat(entries)))).toBe(EXPECTED.sealedEntriesSha256);
    for (let i = 0; i < entries.length; i++) {
      const coin = await openEntryPortable(F.encSecretFixed, entries[i]!);
      expect(coin && { ...coin, nonce: hex(coin.nonce), color: hex(coin.color) }).toEqual({
        nonce: hex(F.plainCoins[i]!.nonce),
        color: hex(F.plainCoins[i]!.color),
        value: F.plainCoins[i]!.value,
      });
    }
  });

  it('opens nothing it should not', async () => {
    const good = await withSeededRandom('neg', () => sealEntryPortable(fixedPub, F.plainCoins[1]!));
    const tampered = Uint8Array.from(good);
    tampered[100]! ^= 1;
    expect(await openEntryPortable(F.encSecretFixed, tampered)).toBeNull();
    expect(await openEntryPortable(F.coin.nonce, good)).toBeNull();
    expect(await openEntryPortable(F.encSecretFixed, new Uint8Array(192))).toBeNull();
    expect(await openEntryPortable(F.encSecretFixed, good.slice(0, 191))).toBeNull();
  });

  it('walks an inbox and finds only its own entries', async () => {
    const otherPub = x25519.getPublicKey(F.coin.nonce);
    const entries = [
      await sealEntryPortable(fixedPub, F.plainCoins[0]!),
      await sealEntryPortable(otherPub, F.plainCoins[1]!),
      new Uint8Array(192),
      await sealEntryPortable(fixedPub, F.plainCoins[3]!),
    ];
    const ledger = {
      inbox_count: BigInt(entries.length),
      inbox: { member: (i: bigint) => i < BigInt(entries.length), lookup: (i: bigint) => entries[Number(i)]! },
    };
    const found = await inboxWalkPortable(ledger as never, F.encSecretFixed);
    expect(found.map((c) => c.value)).toEqual([F.plainCoins[0]!.value, F.plainCoins[3]!.value]);
  });
});

describe("the offer's client-side pieces through the light-compiled account", () => {
  it("predicts the change coin with the contract's own pure circuit", () => {
    const change = predictChangeCoin(F.coin, F.giveAmount);
    expect(change && hex(change.nonce)).toBe(EXPECTED.openSwap.changeNonce);
    expect(change?.value).toBe(2_500_000n);
    expect(predictChangeCoin(F.coin, F.coin.value)).toBeNull();
  });
});
