// AA 00060 P1.2: the I-5 (landing key v1) test vectors, computed from the INTERFACE TEXT with the
// primitives directly (tweetnacl, @noble/hashes HKDF and SHA-256, wallet-sdk-hd, ledger-v9), never
// through packages/core/src/bridge/landing-key.ts, so the unit tests hold the library to an
// independent statement of the derivation (plan "Interfaces", I-5). 00057's journey can check its
// own calls against the same file.
//
//   bun scripts/landing-key-vectors.ts                  print the vectors as JSON
//   bun scripts/landing-key-vectors.ts --out <file>     write them
//   bun scripts/landing-key-vectors.ts --check <file>   exit 1 unless equal byte for byte
//
// Every value here is public test material: the signing key is the fixed seed 0x01..0x20.

import { readFileSync, writeFileSync } from 'node:fs';

import * as ledger from '@midnightntwrk/ledger-v9';
import { HDWallet, Roles } from '@midnightntwrk/wallet-sdk-hd';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { base58 } from '@scure/base';
import nacl from 'tweetnacl';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const ascii = (s: string) => new Uint8Array(Buffer.from(s, 'latin1'));

const SEED = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const ORIGIN = 'http://127.0.0.1:5173';
const NETWORK = 'undeployed';
/** Solana devnet's genesis hash (a fixed, public value). */
const GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';

const kp = nacl.sign.keyPair.fromSeed(SEED);
const wallet = base58.encode(kp.publicKey);

// The message, line by line from the interface text.
const M = ascii(
  [
    'Night Market landing key v1',
    `Sign this only on: ${ORIGIN}`,
    'WARNING: this signature is a secret key. Whoever gets it can',
    'take your tokens while they move from Night Market to Solana.',
    'It is not a transaction and costs nothing. Sign it again to',
    'resume a transfer.',
    `Midnight: ${NETWORK}`,
    `Solana: ${GENESIS}`,
    `Key: ${wallet}`,
  ].join('\n'),
);
const sig = nacl.sign.detached(M, kp.secretKey);
const master = hkdf(sha256, sig, ascii('night-market/landing-key/v1'), ascii('master'), 32);
const check = hex(sha256(new Uint8Array([...ascii('night-market/landing-key/v1/check'), ...master])).subarray(0, 16));

function transfer(accountHex: string, authNonce: bigint) {
  const info = new Uint8Array(40);
  info.set(Buffer.from(accountHex, 'hex'));
  const n = Buffer.alloc(8);
  n.writeBigUInt64BE(authNonce);
  info.set(n, 32);
  const seed = hkdf(sha256, master, ascii('night-market/landing-key/v1/transfer'), info, 32);
  const created = HDWallet.fromSeed(seed);
  if (created.type !== 'seedOk') throw new Error('seed');
  const derived = created.hdWallet.selectAccount(0).selectRoles([Roles.Zswap, Roles.Dust]).deriveKeysAt(0);
  if (derived.type !== 'keysDerived') throw new Error('keys');
  const zk = ledger.ZswapSecretKeys.fromSeed(derived.keys[Roles.Zswap]);
  const dk = ledger.DustSecretKey.fromSeed(derived.keys[Roles.Dust]);
  const out = {
    account: accountHex,
    authNonce: authNonce.toString(),
    info: hex(info),
    seed: hex(seed),
    coinPublicKey: String(zk.coinPublicKey).toLowerCase(),
    encryptionPublicKey: String(zk.encryptionPublicKey).toLowerCase(),
    dustPublicKey: String(dk.publicKey),
  };
  zk.clear();
  dk.clear();
  return out;
}

const vectors = {
  format: 'night-market-landing-key-vectors/v1',
  interface: 'I-5 v1 (plans/00060-night-market-bridge-wallet.md, Interfaces)',
  note: 'Public test material only: the signing key is the fixed seed 0x01..0x20.',
  inputs: {
    signingKeySeed: hex(SEED),
    origin: ORIGIN,
    midnightNetwork: NETWORK,
    solanaGenesisHash: GENESIS,
    walletAddress: wallet,
  },
  message: { text: Buffer.from(M).toString('latin1'), hex: hex(M), bytes: M.length, sha256: hex(sha256(M)) },
  signature: hex(sig),
  master: hex(master),
  check,
  transfers: [transfer('11'.repeat(32), 7n), transfer('11'.repeat(32), 8n), transfer('22'.repeat(32), 7n)],
};

const text = `${JSON.stringify(vectors, null, 2)}\n`;
const args = process.argv.slice(2);
const outAt = args.indexOf('--out');
const checkAt = args.indexOf('--check');
if (checkAt >= 0) {
  const file = args[checkAt + 1]!;
  if (readFileSync(file, 'utf8') !== text) {
    console.error(`landing-key-vectors: ${file} differs`);
    process.exit(1);
  }
  console.log(`landing-key-vectors: ${file} matches`);
} else if (outAt >= 0) {
  writeFileSync(args[outAt + 1]!, text);
  console.log(`landing-key-vectors: wrote ${args[outAt + 1]}`);
} else process.stdout.write(text);
