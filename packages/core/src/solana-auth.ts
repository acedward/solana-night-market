// The relay envelope's Solana signature scheme (AA 00047 lane B3, questions Q14): what a Solana
// wallet (Phantom's `signMessage`, shown as UTF-8) signs to ask the relay for an action that has no
// account call of its own to sign: opening an account and claiming demo tokens (and, only when a
// deployment turns F-B6's switch on, a withdrawal's recipient, Q13). Every account CALL is
// authorised by its own F3 message instead (one prompt per action; relay/src/passport/ed25519-arm.ts).
//
// The bytes are Track A's proof-of-key-possession message (`ed25519PossessionMessage`, acedward/
// passport `contract/src/wallet/ed25519-message.ts`): the market's label for the network, the
// wallet's Solana address, a readable purpose, and in its nonce field the SHA-256 of the canonical
// envelope (action, network, owner, account, body hash, the relay's single-use nonce, expiry), so
// one signature binds all of them. The message states that it authorises nothing and moves no funds
// (true: the relay pays, activation is permissionless, demo tokens are given, never taken), and
// Track A's guard refuses anything a wallet could read as a Solana transaction, an off-chain
// message or a Sign-In With Solana request.
//
// Verification is strict (spec FR-004): the owner key decodes as a prime-order Ed25519 point (not
// the identity, not small- or mixed-order, canonical); the signature verifies under noble's strict
// RFC 8032 rules (canonical R, s < L) AND under tweetnacl (the arm's pre-check); R is not the
// identity. Browser-safe: no compiled contract, no Node built-ins.

import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import nacl from 'tweetnacl';

import { ed25519PossessionMessage } from '../../../vendor/passport/contract/src/wallet/ed25519-message.js';
import { canonicalJson, type RelayActionMessage, type RelayActionName, type RelayActionScheme } from './auth.js';
import { bytesToHex, hexToBytes } from './hex.js';
import { marketLabel } from './market-label.js';
import { isNetworkName } from './network.js';
import { DEVICE_KEY_PATTERN, solanaAddressOf } from './signing.js';

/** The scheme's id (logs, errors, the public config). */
export const SOLANA_RELAY_SCHEME_ID = 'solana-ed25519-possession-v1';

/** The domain of the envelope digest the wallet signs (in the message's nonce field). */
export const SOLANA_ENVELOPE_DOMAIN = 'night-market relay-action v1';

/** The purpose line the wallet shows for each envelope action (at most 64 printable characters). */
export const SOLANA_ENVELOPE_PURPOSES: Readonly<Record<RelayActionName, string>> = {
  register: 'Open a Night Market account',
  'demo-tokens': 'Claim demo tokens for my Night Market account',
  // Only with RELAY_WITHDRAW_RECIPIENT_ENVELOPE=true (Q13 option A): the recipient's encryption key.
  withdraw: "Confirm my withdrawal's recipient",
  // Never signed as envelopes (their own F3 message authorises them); listed so every action has one.
  'withdraw-unshielded': 'Approve a Night Market request',
  'append-inbox': 'Approve a Night Market request',
  'open-swap': 'Approve a Night Market request',
  take: 'Approve a Night Market request',
  'cancel-offers': 'Approve a Night Market request',
};

/** The envelope digest: SHA-256 over the domain and the envelope's canonical JSON, 64 hex. */
export function solanaEnvelopeDigest(message: RelayActionMessage): string {
  return bytesToHex(sha256(new TextEncoder().encode(`${SOLANA_ENVELOPE_DOMAIN}\n${canonicalJson(message)}`)));
}

/** The exact bytes the wallet signs for an envelope (throws for an unknown network or action). */
export function solanaEnvelopeMessage(message: RelayActionMessage): Uint8Array {
  if (!isNetworkName(message.network)) throw new RangeError(`unknown network ${JSON.stringify(message.network)}`);
  const purpose = SOLANA_ENVELOPE_PURPOSES[message.action];
  if (!purpose) throw new RangeError(`no purpose line for action ${JSON.stringify(message.action)}`);
  return ed25519PossessionMessage({
    label: marketLabel(message.network),
    publicKeyBase58: solanaAddressOf(message.owner),
    purpose,
    nonce: solanaEnvelopeDigest(message),
  });
}

/** The same bytes as the text the wallet displays. */
export const solanaEnvelopeText = (message: RelayActionMessage): string =>
  new TextDecoder().decode(solanaEnvelopeMessage(message));

const L = ed25519.Point.Fn.ORDER;

const leBigInt = (bytes: Uint8Array): bigint => {
  let v = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i]!);
  return v;
};

/** Whether a device key (64 hex) is a key the Ed25519 arm accepts: a canonical encoding of a
 *  prime-order point that is not the identity (the same rule as Track A's strict decoder). */
export function isStrictEd25519Key(deviceKey: string): boolean {
  if (!DEVICE_KEY_PATTERN.test(deviceKey)) return false;
  try {
    const p = ed25519.Point.fromBytes(hexToBytes(deviceKey, 32), false);
    return !p.is0() && !p.isSmallOrder() && p.isTorsionFree();
  } catch {
    return false;
  }
}

/** Strict verification of a 64-byte Ed25519 signature over `message` by `deviceKey` (64 hex). */
export function verifyEd25519Strict(deviceKey: string, message: Uint8Array, signature: Uint8Array): boolean {
  if (signature.length !== 64 || !isStrictEd25519Key(deviceKey)) return false;
  const publicKey = hexToBytes(deviceKey, 32);
  try {
    // s must be canonical (never reduced), R must decode strictly and must not be the identity.
    if (leBigInt(signature.subarray(32)) >= L) return false;
    const r = ed25519.Point.fromBytes(signature.slice(0, 32), false);
    if (r.is0()) return false;
    if (!ed25519.verify(signature, message, publicKey, { zip215: false })) return false;
    return nacl.sign.detached.verify(message, signature, publicKey);
  } catch {
    return false;
  }
}

/** The Solana wallet's RelayAction scheme (the relay verifies with it; the browser signs its bytes). */
export const solanaRelayActionScheme: RelayActionScheme = {
  id: SOLANA_RELAY_SCHEME_ID,
  messageBytes: solanaEnvelopeMessage,
  verify(message: RelayActionMessage, signature: Uint8Array): boolean {
    let bytes: Uint8Array;
    try {
      bytes = solanaEnvelopeMessage(message);
    } catch {
      return false;
    }
    return verifyEd25519Strict(message.owner, bytes, signature);
  },
};
