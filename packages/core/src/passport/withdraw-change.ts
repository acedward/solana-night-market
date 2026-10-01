// A shielded withdrawal's CHANGE coin, computed in the browser (AA 00047 P9.S; audit C7 / F-A6;
// questions Q28 option A: "the browser recomputes the change coin and refuses a mismatch").
//
// `withdraw_shielded_with_ed25519` pays `amount` from one coin with the standard library's
// `sendShielded`, which returns what is left as a coin owned by the account. Everything about that
// coin follows from what the wallet signed (the coin and the amount are both in the challenge):
//
//   value  coin.value − amount (no change when it is zero)
//   colour coin.color
//   nonce  upgradeFromTransient(transientHash<Vector<2, Field>>(
//            ["midnight:kernel:nonce_evolve/2" as Field, degradeToTransient(coin.nonce)]))
//
// The nonce rule is the standard library's (compactc 0.35.0, `sendShielded`), NOT the account's
// `swap_change_nonce` (`evolveNonce(2, n)`, the offer's rule): the two differ. It is transcribed here
// call for call from the generated module (`_sendShielded_0`), and
// packages/core/test/withdraw-change.test.ts runs the generated `_sendShielded_0` itself to check it.
//
// So the relay's report of the change is never needed: the browser records the coin it computes,
// and before it seals an inbox entry for a change coin (`append_inbox`, one more signature) it checks
// that coin is exactly this one.

import {
  CompactTypeField,
  CompactTypeVector,
  MAX_FIELD,
  convertBytesToUint,
  degradeToTransient,
  transientHash,
  upgradeFromTransient,
} from '@midnight-ntwrk/compact-runtime-0.20';

import type { CoinInfo } from '../coins.js';
import { bytesToHex, hexToBytes, normaliseHex32 } from '../hex.js';

const SEPARATOR = 'midnight:kernel:nonce_evolve/2';

/** The standard library's change nonce for a spend of the coin with `nonce` (64 hex). */
export function sendShieldedChangeNonce(nonce: string): string {
  const sep = new TextEncoder().encode(SEPARATOR);
  const field = convertBytesToUint(MAX_FIELD, sep.length, sep, 'Field', '<standard library>');
  const h = transientHash(new CompactTypeVector(2, CompactTypeField), [
    field,
    degradeToTransient(hexToBytes(normaliseHex32(nonce), 32)),
  ]);
  return bytesToHex(upgradeFromTransient(h));
}

/** The change a withdrawal of `amount` from `coin` leaves in the account, or null when none. */
export function predictWithdrawChange(coin: CoinInfo, amount: bigint): CoinInfo | null {
  const value = BigInt(coin.value);
  if (amount < 0n || amount > value) throw new RangeError('the coin is smaller than the amount');
  if (value === amount) return null;
  return {
    nonce: sendShieldedChangeNonce(coin.nonce),
    color: normaliseHex32(coin.color),
    value: (value - amount).toString(10),
  };
}

/** Whether two coin descriptions are the same coin (nonce, colour and value). */
export const sameCoin = (a: CoinInfo | null | undefined, b: CoinInfo | null | undefined): boolean =>
  !!a &&
  !!b &&
  normaliseHex32(a.nonce) === normaliseHex32(b.nonce) &&
  normaliseHex32(a.color) === normaliseHex32(b.color) &&
  BigInt(a.value) === BigInt(b.value);
