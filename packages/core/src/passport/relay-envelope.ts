// The Solana wallet's RelayAction scheme (AA 00047, lane B2; lane B3 wires it into the relay's
// routes): the exact bytes a Solana wallet signs for a relay ENVELOPE (../auth.ts), and the check of
// that signature.
//
// An envelope asks the market's relay to spend its sponsor's DUST on an action (opening an account,
// claiming demo tokens) or binds what a call's own signature cannot cover (a withdrawal's recipient
// encryption key, security review F-B6). It never authorises a move of the account's funds: every
// account call carries its own F3 message, rendered and verified in the circuit.
//
// The bytes are Track A's proof-of-possession message (`ed25519PossessionMessage`,
// vendor/passport/contract/src/wallet/ed25519-message.ts; docs/ED25519-ARM.md "Deploy and
// activate"), which the arm designed for exactly this ("before deploying an account for it, or before
// a once-per-key faucet claim"):
//
//   Night Market - stagenet
//   Prove you hold this key
//   Key <the wallet's Solana address>
//   For opening a Night Market account
//   Nonce <SHA-256 of the envelope's canonical JSON, 64 hex>
//   This signature authorises nothing and moves no funds.
//
//   - the first line is the market's label for the network (`marketLabel`, the same one every
//     account call shows), and the network is bound again inside the digest;
//   - "For …" names the action in words (RELAY_ACTION_PURPOSE);
//   - the nonce line is the digest of the WHOLE envelope (action, network, owner, account, payload
//     hash, the relay's single-use nonce, expiry), so the signature covers every field and a change
//     to any of them fails the check;
//   - it is printable ASCII, starts with the label, and passes `assertSafeEd25519Message` (never a
//     Solana transaction, an off-chain message or a Sign-In With Solana request), which the builder
//     itself asserts.
//
// `verify` is strict: the owner key must decode as the arm's device key (prime order, not the
// identity), the signature's R must decode strictly and its s be below L (never reduced), and
// tweetnacl must accept it over exactly these bytes. A Ledger-wrapped signature (the wallet signed
// `\xff"solana offchain"` ‖ … instead) fails, as it does for every account call (Ledger accounts are
// refused in v1, spec FR-004).

import { sha256 } from '@noble/hashes/sha2.js';
import nacl from 'tweetnacl';

import { canonicalJson, type RelayActionMessage, type RelayActionName, type RelayActionScheme } from '../auth.js';
import { bytesToHex, hexToBytes } from '../hex.js';
import { isNetworkName } from '../network.js';
import { solanaAddressOf } from '../signing.js';
import { assertDeviceKeyDecodes, decodeEd25519Signature, ed25519PossessionMessage, marketLabel } from './ed25519.js';

/** The scheme's id, for logs and errors. */
export const SOLANA_RELAY_SCHEME_ID = 'solana-possession-v1';

/** What each envelope is for, in the words the wallet shows after "For " (<= 64 printable ASCII). */
export const RELAY_ACTION_PURPOSE: Readonly<Record<RelayActionName, string>> = {
  register: 'opening a Night Market account',
  withdraw: "confirming a withdrawal's recipient",
  'append-inbox': 'filing an inbox note',
  'open-swap': 'making an offer',
  take: 'taking an offer',
  'demo-tokens': 'claiming demo tokens',
  'withdraw-unshielded': 'an unshielded withdrawal',
};

/** SHA-256 of the envelope's canonical JSON, 64 lowercase hex: the message's "Nonce" line. */
export function relayEnvelopeDigest(message: RelayActionMessage): string {
  return bytesToHex(sha256(new TextEncoder().encode(canonicalJson(message))));
}

/** The exact bytes the wallet signs for `message` (printable ASCII; throws for an unknown network). */
export function relayEnvelopeBytes(message: RelayActionMessage): Uint8Array {
  if (!isNetworkName(message.network)) throw new RangeError(`no market label for network "${message.network}"`);
  return ed25519PossessionMessage({
    label: marketLabel(message.network),
    publicKeyBase58: solanaAddressOf(message.owner),
    purpose: RELAY_ACTION_PURPOSE[message.action],
    nonce: relayEnvelopeDigest(message),
  });
}

/** The same message as text (what the page shows beside the wallet's prompt). */
export const relayEnvelopeText = (message: RelayActionMessage): string =>
  String.fromCharCode(...relayEnvelopeBytes(message));

/** Whether `signature` (64 bytes) is the envelope owner's over `relayEnvelopeBytes(message)`, strictly. */
export function verifyRelayEnvelope(message: RelayActionMessage, signature: Uint8Array): boolean {
  try {
    if (signature.length !== 64) return false;
    assertDeviceKeyDecodes(message.owner);
    decodeEd25519Signature(signature); // strict R (canonical, prime order, not the identity), s < L
    return nacl.sign.detached.verify(relayEnvelopeBytes(message), signature, hexToBytes(message.owner, 32));
  } catch {
    return false;
  }
}

/** The Solana wallet's RelayAction scheme: the one both the browser and the relay use. */
export const solanaRelayActionScheme: RelayActionScheme = {
  id: SOLANA_RELAY_SCHEME_ID,
  messageBytes: relayEnvelopeBytes,
  verify: verifyRelayEnvelope,
};
