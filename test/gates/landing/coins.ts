// AA 00060 P3 (G-LANDING): the two public facts about a landing coin that the gate (and later L-OUT,
// P6.1's packages/core/src/bridge/out.ts) computes without any secret.
//
//   paidOutNonce   the standard library's `sendShielded` gives the PAID-OUT coin the nonce
//                  upgradeFromTransient(transientHash<Vector<2, Field>>(["midnight:kernel:nonce_evolve",
//                  degradeToTransient(input.nonce)])) (compactc 0.35.0 standard-library.compact:168; the
//                  change uses "…/2": packages/core/src/passport/withdraw-change.ts)
//   commitment     a USER-owned coin's commitment: SHA-256("midnight:zswap-cc[v1]" ‖ nonce ‖ colour ‖
//                  value u128 LE ‖ 0x01 ‖ coin public key) (midnight-ledger coin.rs `Info::commitment`,
//                  Recipient::User; packages/core/src/coins.ts has the contract-owned form). The gate checks
//                  it against the commitment the ledger reports for tx1's output.

import { sha256 } from '@noble/hashes/sha2.js';
import {
  CompactTypeField,
  CompactTypeVector,
  MAX_FIELD,
  convertBytesToUint,
  degradeToTransient,
  transientHash,
  upgradeFromTransient,
} from '@midnight-ntwrk/compact-runtime-0.20';

import { bytesToHex, hexToBytes, normaliseHex32 } from '../../../packages/core/src/hex.js';

export function paidOutNonce(inputNonce: string): string {
  const sep = new TextEncoder().encode('midnight:kernel:nonce_evolve');
  const field = convertBytesToUint(MAX_FIELD, sep.length, sep, 'Field', '<standard library>');
  const h = transientHash(new CompactTypeVector(2, CompactTypeField), [
    field,
    degradeToTransient(hexToBytes(normaliseHex32(inputNonce), 32)),
  ]);
  return bytesToHex(upgradeFromTransient(h));
}

export function landingCoinCommitment(
  coin: { nonce: string; color: string; value: string },
  coinPublicKey: string,
): string {
  const value = BigInt(coin.value);
  const v = new Uint8Array(16);
  for (let i = 0, x = value; i < 16; i++, x >>= 8n) v[i] = Number(x & 0xffn);
  const parts = [
    new TextEncoder().encode('midnight:zswap-cc[v1]'),
    hexToBytes(normaliseHex32(coin.nonce), 32),
    hexToBytes(normaliseHex32(coin.color), 32),
    v,
    Uint8Array.of(1),
    hexToBytes(normaliseHex32(coinPublicKey), 32),
  ];
  const buf = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    buf.set(p, o);
    o += p.length;
  }
  return bytesToHex(sha256(buf));
}
