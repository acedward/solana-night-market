// Checking the Solana wallet's signature the moment it comes back (spec FR-004; AA 00047 lane B2;
// moved here unchanged from web/src/wallet/solana-signature.ts in AA 00060 P1, so the landing-key
// library uses the same check):
// a software Phantom account signs EXACTLY the bytes the page passes (RFC 8032 Ed25519, no prefix,
// no pre-hash), so the signature must verify with tweetnacl over those bytes and the connected key.
//
// A Ledger account behind a wallet cannot sign raw bytes: the Ledger Solana app signs only Solana
// OFF-CHAIN messages, which wrap the text in a header that starts with the 16-byte signing domain
// `\xff"solana offchain"` (evidence/00047-mn-bank-solana/phantom-solana-signing.md §3). Its signature
// therefore does not verify over the page's bytes, and the account circuit (which rebuilds the plain
// message) would refuse it. v1 refuses Ledger accounts (spec US1 scenario 2): when the signature
// fails over the plain bytes but verifies over one of the wrapped forms, the page says "hardware
// (Ledger) accounts aren't supported yet" instead of a generic error.
//
// The wrapped forms tried (the signer is the connected key; the body is the page's bytes):
//   - the wallet's own `signedMessage` (Wallet Standard `solana:signMessage` returns it), when it
//     starts with the signing domain;
//   - v0 (Solana's off-chain message proposal, Ledger app >= 1.3): domain ‖ 0x00 ‖ application
//     domain (32 zero bytes) ‖ format (0, 1 or 2) ‖ signer count 1 ‖ signer ‖ length (u16 LE) ‖ body;
//   - the short v0 header of earlier Ledger releases: domain ‖ 0x00 ‖ format ‖ length ‖ body;
//   - v1 (sRFC 38): domain ‖ 0x01 ‖ signer count 1 ‖ signer ‖ body.
// Any other mismatch (another key, other bytes, not 64 bytes) is a bad signature.

import nacl from 'tweetnacl';

/** `\xff` then "solana offchain": the off-chain message signing domain (16 bytes). */
export const OFFCHAIN_SIGNING_DOMAIN = Uint8Array.from([
  0xff,
  ...Array.from('solana offchain', (c) => c.charCodeAt(0)),
]);

const concat = (...parts: ArrayLike<number>[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

const startsWith = (bytes: Uint8Array, prefix: Uint8Array) =>
  bytes.length >= prefix.length && prefix.every((b, i) => bytes[i] === b);

/** The off-chain-message forms a Ledger may have signed instead of `message` (see the header). */
export function offchainWrappings(message: Uint8Array, signer: Uint8Array): Uint8Array[] {
  const length = [message.length & 0xff, (message.length >> 8) & 0xff];
  const out: Uint8Array[] = [];
  for (const format of [0, 1, 2]) {
    out.push(concat(OFFCHAIN_SIGNING_DOMAIN, [0], new Uint8Array(32), [format], [1], signer, length, message));
  }
  for (const format of [0, 1]) out.push(concat(OFFCHAIN_SIGNING_DOMAIN, [0], [format], length, message));
  out.push(concat(OFFCHAIN_SIGNING_DOMAIN, [1], [1], signer, message));
  return out;
}

export type SignatureVerdict =
  /** Verifies over exactly `message`: a software account, as the arm needs. */
  | 'ok'
  /** Verifies only over an off-chain-message wrapping: a Ledger (hardware) account. */
  | 'hardware'
  /** Neither: another key, other bytes, or not an Ed25519 signature. */
  | 'mismatch';

export function classifyWalletSignature(
  message: Uint8Array,
  signature: Uint8Array,
  publicKey: Uint8Array,
  signedMessage?: Uint8Array,
): SignatureVerdict {
  if (signature.length !== nacl.sign.signatureLength || publicKey.length !== nacl.sign.publicKeyLength)
    return 'mismatch';
  const verifies = (bytes: Uint8Array) => {
    try {
      return nacl.sign.detached.verify(bytes, signature, publicKey);
    } catch {
      return false;
    }
  };
  if (verifies(message)) return 'ok';
  if (signedMessage && startsWith(signedMessage, OFFCHAIN_SIGNING_DOMAIN) && verifies(signedMessage)) return 'hardware';
  for (const wrapped of offchainWrappings(message, publicKey)) if (verifies(wrapped)) return 'hardware';
  return 'mismatch';
}
