// I-5, the keys of one transfer (AA 00060): `seed_t` (./landing-key.ts) through AA 00048's HD layout
// (acedward/evm-midnight-transparent @ e150574, packages/wallet/src/keys.ts:44-88):
//
//   HDWallet.fromSeed(seed_t) → account 0 → roles [Zswap, Dust] → deriveKeysAt(0)
//   ZswapSecretKeys.fromSeed(zswap), DustSecretKey.fromSeed(dust)
//
// so `seed_t` also restores the landing wallet in any Midnight tool that accepts a 32-byte seed (the
// page offers no export of it). The Dust key is never funded; the SDK's balancing calls take one.
//
// A separate entry from ./landing-key.ts because it loads ledger-v9's WASM and the HD wallet: the page
// loads it lazily, only for Bridge out. Everything here is SECRET except the two public keys; call
// `clear()` when the transfer ends.

import * as ledger from '@midnightntwrk/ledger-v9';
import { HDWallet, Roles } from '@midnightntwrk/wallet-sdk-hd';

import { landingSeed, wipe, type LandingMaster } from './landing-key.js';

export interface LandingKeys {
  /** SECRET: `seed_t`. */
  readonly seed: Uint8Array;
  /** SECRET. */
  readonly shieldedSecretKeys: ledger.ZswapSecretKeys;
  /** SECRET (never funded). */
  readonly dustSecretKey: ledger.DustSecretKey;
  /** Public: owns the landing coin (64 hex). */
  readonly coinPublicKey: string;
  /** Public: the landing coin is sealed to it (64 hex). */
  readonly encryptionPublicKey: string;
  /** Wipe the seed and the secret keys. */
  clear(): void;
}

/** The landing wallet's keys from `seed_t` (32 bytes). Takes ownership of `seed`: `clear()` wipes it. */
export function landingKeysFromSeed(seed: Uint8Array): LandingKeys {
  if (seed.length !== 32) throw new RangeError('a landing seed is 32 bytes');
  const created = HDWallet.fromSeed(seed);
  if (created.type !== 'seedOk') throw new Error('the landing seed is not a valid HD seed');
  const derived = created.hdWallet.selectAccount(0).selectRoles([Roles.Zswap, Roles.Dust]).deriveKeysAt(0);
  created.hdWallet.clear();
  if (derived.type !== 'keysDerived') throw new Error('the landing keys could not be derived');
  const zswap = derived.keys[Roles.Zswap];
  const dust = derived.keys[Roles.Dust];
  const shieldedSecretKeys = ledger.ZswapSecretKeys.fromSeed(zswap);
  const dustSecretKey = ledger.DustSecretKey.fromSeed(dust);
  wipe(zswap, dust);
  return {
    seed,
    shieldedSecretKeys,
    dustSecretKey,
    coinPublicKey: String(shieldedSecretKeys.coinPublicKey).toLowerCase(),
    encryptionPublicKey: String(shieldedSecretKeys.encryptionPublicKey).toLowerCase(),
    clear() {
      wipe(seed);
      shieldedSecretKeys.clear();
      dustSecretKey.clear();
    },
  };
}

/** The keys of the transfer whose tx1 is signed at `authNonce` on `account`. */
export function landingKeyFor(
  master: LandingMaster | Uint8Array,
  account: Uint8Array | string,
  authNonce: bigint,
): LandingKeys {
  const seed =
    master instanceof Uint8Array ? landingSeed(master, account, authNonce) : master.seedFor(account, authNonce);
  return landingKeysFromSeed(seed);
}

/**
 * AA 00060 P10.3 (audit C1): keys_t's coin SECRET key (32 bytes, 64 hex), which a bridge-out names so the
 * market can check that its one input is the entitled landing coin. The unproven call's spend witness,
 * which the market proves (questions Q2 A), already carries this key: naming it adds no exposure. It opens
 * only this transfer's landing key, never the master key or another transfer's.
 */
export function landingCoinSecretKeyHex(keys: Pick<LandingKeys, 'shieldedSecretKeys'>): string {
  const raw = (
    keys.shieldedSecretKeys.coinSecretKey as unknown as {
      yesIKnowTheSecurityImplicationsOfThis_serialize(): Uint8Array;
    }
  ).yesIKnowTheSecurityImplicationsOfThis_serialize();
  const key = raw.slice(-32);
  const hex = Array.from(key, (b) => b.toString(16).padStart(2, '0')).join('');
  wipe(raw, key);
  return hex;
}
