// I-5, the landing key (AA 00060; owned here, consumed by 00057's scripted journey, which must call
// these functions and never re-implement them). Browser-safe: no Node built-ins, no compiled contract,
// no wallet SDK. The keys of one transfer (wallet-sdk-hd + ledger-v9) are in ./landing-wallet.ts.
//
// Bridge out takes two Midnight transactions (00057 Q2 A): tx1 withdraws one coin from the account to a
// key only this browser can derive (the LANDING key), and tx2 spends it into the bridge's
// `lockForSolana` with the connected wallet as the Solana recipient. The landing key comes from a
// signature over a FIXED message (00060 Q3 A), so an interrupted transfer can be resumed with no stored
// secret, in any browser:
//
//   M       = landingMessage(origin, Midnight network, Solana genesis hash, wallet address)   (below)
//   sig1    = wallet.signMessage(M); sig2 = wallet.signMessage(M)     (two prompts; each must verify
//             over exactly M with the connected key: verdict 'ok', else 'hardware' / 'bad-signature')
//   sig1 != sig2                                    → refuse 'not-deterministic' (both wiped, nothing derived)
//   master  = HKDF-SHA-256(IKM = sig1, salt = "night-market/landing-key/v1", info = "master", L = 32)
//   check   = hex(SHA-256("night-market/landing-key/v1/check" ‖ master)[0..16])   NOT secret; kept per
//             (origin, network, wallet); a later derivation that gives another check → 'landing-key-changed'
//   seed_t  = HKDF-SHA-256(IKM = master, salt = "night-market/landing-key/v1/transfer",
//                          info = account (32 bytes) ‖ u64be(authNonce of tx1), L = 32)
//   keys_t  = AA 00048's HD layout over seed_t (./landing-wallet.ts)
//
// SECRETS: the two signatures, `master`, every `seed_t` and the keys live only in memory and are wiped
// (`fill(0)`) when done. Nothing here logs, stores or sends them. The one place a per-transfer key
// leaves the browser is tx2's proof request (00060 Q2 A: the relay proves tx2).
//
// DOMAIN SEPARATION (spec FR-017): the first line `Night Market landing key v1` is reserved for I-5. Every
// F3 v3 account-call message starts with the circuit-fixed `Site: `, every relay envelope with a market
// label (`Night Market - stagenet` / `Night Market - local`), and I-4 (00059) with
// `solana-token-injector`, so no other message the market signs can equal an I-5 message. The text says
// in its own words that its signature is a secret key and where to sign it (00060 Q3 A).
//
// A change to anything in this file's message or derivation is a NEW version (`... v2`), with v1 kept for
// resuming old transfers.

import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { base58 } from '@scure/base';

import { assertSafeEd25519Message } from '../../../../vendor/passport/contract/src/wallet/ed25519-message.js';
import { bytesToHex, hexToBytes } from '../hex.js';
import { classifyWalletSignature, type SignatureVerdict } from '../solana-signature.js';

/** The reserved first line of every I-5 v1 message. */
export const LANDING_KEY_FIRST_LINE = 'Night Market landing key v1';
/** The fixed lines between the origin line and the network lines (the warning, Q3 A). */
export const LANDING_KEY_WARNING_LINES: readonly string[] = Object.freeze([
  'WARNING: this signature is a secret key. Whoever gets it can',
  'take your tokens while they move from Night Market to Solana.',
  'It is not a transaction and costs nothing. Sign it again to',
  'resume a transfer.',
]);
export const LANDING_KEY_SALT = 'night-market/landing-key/v1';
export const LANDING_KEY_MASTER_INFO = 'master';
export const LANDING_KEY_CHECK_DOMAIN = 'night-market/landing-key/v1/check';
export const LANDING_KEY_TRANSFER_SALT = 'night-market/landing-key/v1/transfer';
/** The longest origin the message carries. */
export const LANDING_ORIGIN_MAX = 100;

const ascii = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0));

export type LandingKeyErrorCode =
  /** The wallet signed the same message twice with different signatures (MPC, hedged signing). */
  | 'not-deterministic'
  /** A signature that does not verify over the message with the connected key. */
  | 'bad-signature'
  /** A signature over a Solana off-chain-message wrapping: a Ledger (hardware) account. */
  | 'hardware'
  /** The derivation gave another master key than the one recorded for this wallet on this site. */
  | 'landing-key-changed'
  /** A message field outside its rule (the message is never built). */
  | 'bad-field';

export class LandingKeyError extends Error {
  override name = 'LandingKeyError';
  constructor(
    readonly code: LandingKeyErrorCode,
    message: string,
    readonly field?: keyof LandingMessageParams,
  ) {
    super(message);
  }
}

// ── The message ──────────────────────────────────────────────────────────────

export interface LandingMessageParams {
  /** The page's `location.origin`. */
  origin: string;
  /** I-1 `midnightNetwork`. */
  midnightNetwork: string;
  /** I-1 `solanaGenesisHash` (base58 of 32 bytes). */
  solanaGenesisHash: string;
  /** The connected wallet's address (base58 of its 32-byte key). */
  walletAddress: string;
}

/** What the caller knows independently; each one given must equal the message's field. */
export interface LandingMessageExpect {
  /** The site's own Midnight network. */
  siteNetwork?: string;
  /** The Solana RPC's `getGenesisHash`. */
  rpcGenesisHash?: string;
  /** The connected wallet's 32-byte key. */
  publicKey?: Uint8Array;
}

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const HOST_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const NETWORK_RE = /^[a-z0-9-]{1,32}$/;

const bad = (field: keyof LandingMessageParams, why: string): never => {
  throw new LandingKeyError('bad-field', `the landing-key ${field} ${why}`, field);
};

/** base58 of exactly 32 bytes, in its canonical spelling; the bytes, or null. */
export function base58Key32(text: string): Uint8Array | null {
  if (typeof text !== 'string' || text.length < 32 || text.length > 44) return null;
  try {
    const bytes = base58.decode(text);
    if (bytes.length !== 32 || base58.encode(bytes) !== text) return null;
    return bytes;
  } catch {
    return null;
  }
}

/** The origin rule: lowercase `https://<host>[:port]`, or `http://` only for the local stack's hosts;
 *  canonical (no default port, no leading zero), printable ASCII, at most 100 characters. */
export function isLandingOrigin(origin: string): boolean {
  if (typeof origin !== 'string' || origin.length === 0 || origin.length > LANDING_ORIGIN_MAX) return false;
  if (!/^[\x21-\x7e]+$/.test(origin)) return false;
  const m = /^(https?):\/\/(\[::1\]|[^/:[\]]+)(?::([1-9][0-9]{0,4}))?$/.exec(origin);
  if (!m) return false;
  const [, scheme, host, port] = m as unknown as [string, string, string, string | undefined];
  if (port !== undefined) {
    const n = Number(port);
    if (n > 65535) return false;
    if ((scheme === 'https' && n === 443) || (scheme === 'http' && n === 80)) return false;
  }
  if (scheme === 'http') return LOCAL_HOSTS.has(host);
  return host !== '[::1]' && HOST_RE.test(host);
}

/** The message's text; throws `bad-field` for a field outside its rule (or unequal to `expect`). */
export function landingMessageText(p: LandingMessageParams, expect: LandingMessageExpect = {}): string {
  if (!isLandingOrigin(p.origin)) {
    bad(
      'origin',
      'must be a lowercase https origin (http only for 127.0.0.1, localhost or [::1]), at most 100 characters',
    );
  }
  if (typeof p.midnightNetwork !== 'string' || !NETWORK_RE.test(p.midnightNetwork)) {
    bad('midnightNetwork', 'must be 1 to 32 characters of a-z, 0-9 and -');
  }
  if (expect.siteNetwork !== undefined && p.midnightNetwork !== expect.siteNetwork) {
    bad('midnightNetwork', `is ${p.midnightNetwork}, not the site's network ${expect.siteNetwork}`);
  }
  if (!base58Key32(p.solanaGenesisHash)) bad('solanaGenesisHash', 'must be the base58 of 32 bytes');
  if (expect.rpcGenesisHash !== undefined && p.solanaGenesisHash !== expect.rpcGenesisHash) {
    bad('solanaGenesisHash', "differs from the Solana RPC's genesis hash");
  }
  const key = base58Key32(p.walletAddress);
  if (!key) bad('walletAddress', 'must be the base58 of a 32-byte key');
  if (expect.publicKey !== undefined && bytesToHex(key!) !== bytesToHex(expect.publicKey)) {
    bad('walletAddress', 'is not the connected key');
  }
  return [
    LANDING_KEY_FIRST_LINE,
    `Sign this only on: ${p.origin}`,
    ...LANDING_KEY_WARNING_LINES,
    `Midnight: ${p.midnightNetwork}`,
    `Solana: ${p.solanaGenesisHash}`,
    `Key: ${p.walletAddress}`,
  ].join('\n');
}

/** The exact bytes the wallet signs (ASCII), after the arm's wallet-safety guard. */
export function landingMessage(p: LandingMessageParams, expect: LandingMessageExpect = {}): Uint8Array {
  const bytes = ascii(landingMessageText(p, expect));
  assertSafeEd25519Message(bytes);
  return bytes;
}

/** Whether a message is an I-5 message (by its reserved first line). */
export const isLandingMessage = (text: string): boolean => text.split('\n', 1)[0] === LANDING_KEY_FIRST_LINE;

// ── The derivation ───────────────────────────────────────────────────────────

/** `master` from the derivation signature (64 bytes). SECRET in, SECRET out. */
export function landingMasterFromSignature(signature: Uint8Array): Uint8Array {
  if (signature.length !== 64) throw new RangeError('an Ed25519 signature is 64 bytes');
  return hkdf(sha256, signature, ascii(LANDING_KEY_SALT), ascii(LANDING_KEY_MASTER_INFO), 32);
}

/** The NON-secret check value of a master key: 32 hex (16 bytes). */
export function landingCheck(master: Uint8Array): string {
  if (master.length !== 32) throw new RangeError('a landing master key is 32 bytes');
  const domain = ascii(LANDING_KEY_CHECK_DOMAIN);
  const input = new Uint8Array(domain.length + 32);
  input.set(domain);
  input.set(master, domain.length);
  const digest = sha256(input);
  input.fill(0);
  return bytesToHex(digest.subarray(0, 16));
}

const U64_MAX = (1n << 64n) - 1n;

/** HKDF's `info` for one transfer: the account's 32 bytes ‖ u64 big-endian of tx1's auth nonce. */
export function landingTransferInfo(account: Uint8Array | string, authNonce: bigint): Uint8Array {
  const acc = typeof account === 'string' ? hexToBytes(account.replace(/^0x/, ''), 32) : account;
  if (acc.length !== 32) throw new RangeError('an account address is 32 bytes');
  if (authNonce < 0n || authNonce > U64_MAX) throw new RangeError(`${authNonce} is not a u64`);
  const info = new Uint8Array(40);
  info.set(acc);
  new DataView(info.buffer).setBigUint64(32, authNonce, false);
  return info;
}

/** `seed_t` of one transfer. SECRET. */
export function landingSeed(master: Uint8Array, account: Uint8Array | string, authNonce: bigint): Uint8Array {
  if (master.length !== 32) throw new RangeError('a landing master key is 32 bytes');
  return hkdf(sha256, master, ascii(LANDING_KEY_TRANSFER_SALT), landingTransferInfo(account, authNonce), 32);
}

/** Zero every buffer given (a no-op for null/undefined). */
export function wipe(...buffers: (Uint8Array | null | undefined)[]): void {
  for (const b of buffers) b?.fill(0);
}

/** The derived master key of one (origin, network, wallet), held in the tab's memory. */
export interface LandingMaster {
  readonly params: Readonly<LandingMessageParams>;
  /** The NON-secret check value (32 hex), to record beside the wallet. */
  readonly check: string;
  /** False once wiped. */
  readonly live: boolean;
  /** `seed_t` for one transfer (SECRET; the caller wipes it). Throws once wiped. */
  seedFor(account: Uint8Array | string, authNonce: bigint): Uint8Array;
  /** Zero the master key. */
  wipe(): void;
}

/** What the wallet returns: the signature, or `{signature, signedMessage?}` (Wallet Standard). */
export type LandingSignResult = Uint8Array | { signature: Uint8Array; signedMessage?: Uint8Array };
export type LandingSignFn = (message: Uint8Array) => Promise<LandingSignResult> | LandingSignResult;
export type LandingSignatureClassifier = (
  message: Uint8Array,
  signature: Uint8Array,
  publicKey: Uint8Array,
  signedMessage?: Uint8Array,
) => SignatureVerdict;

export interface DeriveLandingOptions {
  /** Independent values the message's fields must equal (the connected key is always checked). */
  expect?: Omit<LandingMessageExpect, 'publicKey'>;
  /** The check value recorded earlier for this wallet on this site and network, if any. */
  storedCheck?: string | null;
  /** The signature check (default: the page's own, which tells a Ledger wrapping from a mismatch). */
  classify?: LandingSignatureClassifier;
}

const signatureOf = (r: LandingSignResult): { signature: Uint8Array; signedMessage?: Uint8Array } =>
  r instanceof Uint8Array ? { signature: r } : r;

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/**
 * Asks the wallet to sign the I-5 message twice, one prompt after the other; checks each signature
 * over exactly the message with the connected key; refuses a wallet whose two signatures differ;
 * derives the master key from the first; wipes both signatures; and refuses a master key whose
 * check value differs from `storedCheck`. Nothing is derived (and every signature is wiped) on any
 * refusal. The second prompt is never shown when the first signature is refused.
 */
export async function deriveLandingMaster(
  signMessage: LandingSignFn,
  params: LandingMessageParams,
  publicKey: Uint8Array,
  options: DeriveLandingOptions = {},
): Promise<LandingMaster> {
  const message = landingMessage(params, { ...options.expect, publicKey });
  const classify = options.classify ?? classifyWalletSignature;
  const held: Uint8Array[] = [];
  const ask = async (): Promise<Uint8Array> => {
    const { signature, signedMessage } = signatureOf(await signMessage(message));
    held.push(signature);
    const verdict = classify(message, signature, publicKey, signedMessage);
    if (verdict === 'hardware') {
      throw new LandingKeyError('hardware', 'Hardware (Ledger) accounts cannot derive a landing key.');
    }
    if (verdict !== 'ok') {
      throw new LandingKeyError('bad-signature', 'The wallet signature does not match the landing-key message.');
    }
    return signature;
  };
  try {
    const sig1 = await ask();
    const sig2 = await ask();
    if (!equalBytes(sig1, sig2)) {
      throw new LandingKeyError(
        'not-deterministic',
        'This wallet signs the same message differently each time, so it cannot hold a landing key.',
      );
    }
    let key: Uint8Array | null = landingMasterFromSignature(sig1);
    const check = landingCheck(key);
    if (options.storedCheck && options.storedCheck !== check) {
      wipe(key);
      throw new LandingKeyError(
        'landing-key-changed',
        'This wallet no longer signs the landing-key message the same way as before.',
      );
    }
    return {
      params: Object.freeze({ ...params }),
      check,
      get live() {
        return key !== null;
      },
      seedFor(account, authNonce) {
        if (!key) throw new Error('The landing key was forgotten; derive it again.');
        return landingSeed(key, account, authNonce);
      },
      wipe() {
        wipe(key);
        key = null;
      },
    };
  } finally {
    wipe(...held);
  }
}
