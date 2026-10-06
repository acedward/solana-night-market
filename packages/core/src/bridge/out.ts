// AA 00060 P6.1 (spec FR-004–FR-011): Bridge out's public facts and wire types. Browser-safe, no secret.
//
//   predictLandingCoin   the coin tx1 pays to the landing key: tx1 is the account's ordinary sponsored
//                        `withdraw_shielded_with_ed25519`, whose standard-library `sendShielded` gives the
//                        PAID-OUT coin the nonce upgradeFromTransient(transientHash<Vector<2, Field>>(
//                        ["midnight:kernel:nonce_evolve", degradeToTransient(input.nonce)])) (compactc
//                        0.35.0 `standard-library.compact:168`; the change uses "…/2", ../passport/
//                        withdraw-change.ts), the input's colour, and the amount
//   landingCoinCommitment  a user-owned coin's commitment: SHA-256("midnight:zswap-cc[v1]" ‖ nonce ‖
//                        colour ‖ value u128 LE ‖ 0x01 ‖ coin public key) (midnight-ledger coin.rs
//                        `Info::commitment`, Recipient::User): what "Find my transfers" looks for among
//                        tx1's outputs
//   the bridge-out wire  the relay's `bridge-out` and `bridge-out-entitle` bodies and results, the
//                        landing entitlement's format, and every refusal code (plan Interfaces)
//
// packages/core/test/bridge-out.test.ts runs the generated `_sendShielded_0` to check the nonce rule.

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
import { z } from 'zod';

import type { CoinInfo } from '../coins.js';
import { bytesToHex, hexToBytes, normaliseHex32 } from '../hex.js';

const PAID_OUT_SEPARATOR = 'midnight:kernel:nonce_evolve';
const COMMITMENT_DOMAIN = 'midnight:zswap-cc[v1]';
const NULLIFIER_DOMAIN = 'midnight:zswap-cn[v1]';
const PUBLIC_KEY_DOMAIN = 'midnight:zswap-pk[v1]';

/** The standard library's PAID-OUT coin nonce for a spend of the coin with `inputNonce` (64 hex). */
export function paidOutNonce(inputNonce: string): string {
  const sep = new TextEncoder().encode(PAID_OUT_SEPARATOR);
  const field = convertBytesToUint(MAX_FIELD, sep.length, sep, 'Field', '<standard library>');
  const h = transientHash(new CompactTypeVector(2, CompactTypeField), [
    field,
    degradeToTransient(hexToBytes(normaliseHex32(inputNonce), 32)),
  ]);
  return bytesToHex(upgradeFromTransient(h));
}

/** The coin a withdrawal of `amount` from `spent` pays out (to the landing key, for a bridge-out). */
export function predictLandingCoin(spent: Pick<CoinInfo, 'nonce' | 'color' | 'value'>, amount: bigint): CoinInfo {
  if (amount <= 0n || amount > BigInt(spent.value)) throw new RangeError('the amount must be within the coin');
  return { nonce: paidOutNonce(spent.nonce), color: normaliseHex32(spent.color), value: amount.toString(10) };
}

/** SHA-256 over domain ‖ nonce ‖ colour ‖ value (u128 LE) ‖ is_user = 1 ‖ key (midnight-ledger coin.rs). */
function userCoinHash(domain: string, coin: Pick<CoinInfo, 'nonce' | 'color' | 'value'>, key: string): string {
  const value = BigInt(coin.value);
  if (value < 0n || value >= 1n << 128n) throw new RangeError('a coin value is a u128');
  const v = new Uint8Array(16);
  for (let i = 0, x = value; i < 16; i++, x >>= 8n) v[i] = Number(x & 0xffn);
  const parts = [
    new TextEncoder().encode(domain),
    hexToBytes(normaliseHex32(coin.nonce), 32),
    hexToBytes(normaliseHex32(coin.color), 32),
    v,
    Uint8Array.of(1),
    hexToBytes(normaliseHex32(key), 32),
  ];
  const buf = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    buf.set(p, o);
    o += p.length;
  }
  return bytesToHex(sha256(buf));
}

/** A USER-owned coin's commitment (64 hex) for the coin public key `coinPublicKey` (64 hex). */
export function landingCoinCommitment(
  coin: Pick<CoinInfo, 'nonce' | 'color' | 'value'>,
  coinPublicKey: string,
): string {
  return userCoinHash(COMMITMENT_DOMAIN, coin, coinPublicKey);
}

/** A USER-owned coin's nullifier (64 hex) under the coin SECRET key `coinSecretKey` (32 bytes, 64 hex):
 *  what its spend publishes (ledger `coinNullifier`; relay/test/bridge-out-audit.test.ts checks them equal). */
export function landingCoinNullifier(coin: Pick<CoinInfo, 'nonce' | 'color' | 'value'>, coinSecretKey: string): string {
  return userCoinHash(NULLIFIER_DOMAIN, coin, coinSecretKey);
}

/** The coin public key (64 hex) of a coin secret key (32 bytes, 64 hex): SHA-256("midnight:zswap-pk[v1]" ‖ key). */
export function coinPublicKeyOfSecret(coinSecretKey: string): string {
  const sk = hexToBytes(normaliseHex32(coinSecretKey), 32);
  const d = new TextEncoder().encode(PUBLIC_KEY_DOMAIN);
  const buf = new Uint8Array(d.length + 32);
  buf.set(d, 0);
  buf.set(sk, d.length);
  return bytesToHex(sha256(buf));
}

// ── The relay's bridge-out wire (plan Interfaces "the relay's bridge-out API") ─────────────────────

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const decimal = z.string().regex(/^(0|[1-9][0-9]{0,39})$/);

/**
 * A single-use LANDING ENTITLEMENT (P6.3): `le1.<account>.<op>.<expiry>.<mac>`. The relay issues it with
 * tx1's result (`withdraw` with `purpose: 'bridge-out'`) or on `bridge-out-entitle`; it pays for ONE
 * sponsored tx2 (the lock, or the return) of that landing coin. The MAC binds the network, the account,
 * the device key, the landing coin public key, the colour, the amount, the operation and the expiry.
 */
export const LANDING_ENTITLEMENT_PATTERN = /^le1\.[0-9a-f]{64}\.[0-9a-f]{64}\.[1-9][0-9]{0,11}\.[0-9a-f]{64}$/;

/** What a landing entitlement binds besides the account (sent with every bridge-out request). */
export const LandingBindingSchema = z
  .object({
    /** The device (the Solana wallet's key, 64 hex): also the lock's Solana recipient. */
    deviceKey: hex64,
    /** keys_t's coin public key: the landing coin's owner. */
    coinPublicKey: hex64,
    colour: hex64,
    amount: decimal,
  })
  .strict();
export type LandingBinding = z.infer<typeof LandingBindingSchema>;

export const BRIDGE_OUT_KINDS = ['lock', 'return'] as const;
export type BridgeOutKind = (typeof BRIDGE_OUT_KINDS)[number];

/** The most a bridge-out transaction may be (hex characters): a few kilobytes in practice. */
export const BRIDGE_OUT_TX_MAX_HEX = 400_000;

/**
 * The landing coin a bridge-out spends (AA 00060 P10.3, audit C1): its nonce (public: the paid-out nonce of
 * tx1's spend) and keys_t's coin SECRET key. The relay recomputes the coin's commitment from the
 * entitlement's binding and this nonce (it must be the entitlement's op), the key's public key (it must
 * be the binding's), and the coin's nullifier (it must be the transaction's ONE input's). The key is the
 * one the unproven call's spend witness already carries for the relay to prove it (questions Q2 A): no
 * new exposure, and it opens only this transfer's landing key.
 */
export const LandingSpendSchema = z.object({ nonce: hex64, coinSecretKey: hex64 }).strict();
export type LandingSpend = z.infer<typeof LandingSpendSchema>;

/** `bridge-out`: one sponsored second transaction of a landing coin (no signature: the entitlement). */
export const BridgeOutPayloadSchema = z
  .object({
    kind: z.enum(BRIDGE_OUT_KINDS),
    entitlement: z.string().regex(LANDING_ENTITLEMENT_PATTERN),
    landing: LandingBindingSchema,
    /** The transaction: unproven (`proven: false`, the relay proves it: questions Q2 A) or proven
     *  (`proven: true`: options B and C need no relay change), not yet bound, serialized, hex. */
    tx: z
      .string()
      .regex(/^[0-9a-f]+$/)
      .max(BRIDGE_OUT_TX_MAX_HEX)
      .refine((s) => s.length % 2 === 0),
    proven: z.boolean(),
    /** The block whose state the call was built on (64 hex): the relay checks it against that state. */
    blockHash: hex64,
    /** The coin the transaction spends (required: the relay refuses a bridge-out without it). */
    spend: LandingSpendSchema.optional(),
  })
  .strict();
export type BridgeOutPayload = z.infer<typeof BridgeOutPayloadSchema>;

export interface BridgeOutResult {
  txId: string;
  /** For a lock: the bridge's withdrawal id (I-3 `m2s:<id>`; the release receipt PDA `["release", id]`). */
  withdrawalId?: string;
}

/** `bridge-out-entitle`: re-issue an entitlement (resume from an empty browser) after an indexer check. */
export const BridgeOutEntitlePayloadSchema = z
  .object({
    /** tx1's hash (64 hex), as the indexer reports it. */
    tx1Hash: hex64,
    /** The account coin tx1 spent (its paid-out coin is the landing coin). */
    spentCoin: z.object({ nonce: hex64, color: hex64, value: decimal }).strict(),
    amount: decimal,
    landingCoinPublicKey: hex64,
    deviceKey: hex64,
    /** The device's use counter on the account (its entry in `devices`). */
    useCounter: decimal,
  })
  .strict();
export type BridgeOutEntitlePayload = z.infer<typeof BridgeOutEntitlePayloadSchema>;

export interface BridgeOutEntitleResult {
  landingEntitlement: string;
}

/** Every named refusal of the bridge-out actions (spec FR-008: before any proof or DUST). */
export const BRIDGE_OUT_REFUSALS = {
  /** Not exactly one call of the expected entry point, a transaction that does not decode, outputs
   *  that are not the call's, or an unbalanced shielded side. */
  shape: 'bridge-out-shape',
  /** The lock's Solana recipient is not the device's wallet, or a return to another account. */
  destination: 'bridge-out-destination',
  /** The lock records another amount than the entitlement's. */
  amount: 'bridge-out-amount',
  /** A bridge of another colour than the landing coin's. */
  colour: 'bridge-out-colour',
  /** A contract that is not a bridge of the journey registry (I-1). */
  contract: 'bridge-out-contract',
  /** The transaction spends DUST (the sponsor adds it). */
  dust: 'bridge-out-dust',
  /** The transaction moves unshielded tokens. */
  unshielded: 'bridge-out-unshielded',
  /** The call no longer runs on the contract's current state (a concurrent lock): rebuild and resend. */
  stale: 'bridge-out-stale',
  /** The transaction does not spend exactly the entitled landing coin (audit C1). */
  input: 'bridge-out-input',
  /** A proven transaction: the relay cannot see which coin it spends (audit C1; the page sends it unproven). */
  proven: 'bridge-out-proven',
  /** This landing coin's second transaction failed after proving too many times (audit C1). */
  attempts: 'bridge-out-attempts',
  entitlementInvalid: 'entitlement-invalid',
  entitlementUsed: 'entitlement-used',
  entitleNotFound: 'entitle-not-found',
} as const;
export type BridgeOutRefusal = (typeof BRIDGE_OUT_REFUSALS)[keyof typeof BRIDGE_OUT_REFUSALS];
