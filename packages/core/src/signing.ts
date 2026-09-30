// The seam where a Solana wallet signs for the market (plan lanes B2 and B3, on Track A's Ed25519
// arm: acedward/passport branch `00047-solana-ed25519-arm`).
//
// A Night Market account is controlled by ONE device: a Solana wallet's Ed25519 key. The wallet
// never sends a Solana transaction; it only signs messages (Phantom's `signMessage`), so it needs no
// SOL. This module holds what every side agrees on already:
//   - a DEVICE KEY is the wallet's 32-byte Ed25519 public key, written as 64 lowercase hex on the
//     wire and in local data; the same bytes in base58 are the wallet's Solana address;
//   - a DeviceSigner is anything that signs bytes with that key and returns the 64-byte signature
//     (in the browser: Phantom's `signMessage`, lane B2; in tests: tweetnacl or noble).
//
// What it does NOT hold yet, on purpose: the exact bytes the wallet is asked to sign for an account
// call (the readable F3 action text, or the F1 prefix and digest; plan A3), which Track A's message
// builder defines, and the relay envelope's message format, which lane B3 defines with it
// (`RelayActionScheme` in ./auth.ts).

import { base58 } from '@scure/base';

/** A device key: the Ed25519 public key, 64 lowercase hex characters. */
export const DEVICE_KEY_PATTERN = /^[0-9a-f]{64}$/;

export class DeviceKeyError extends Error {
  override name = 'DeviceKeyError';
}

export function isDeviceKey(value: unknown): value is string {
  return typeof value === 'string' && DEVICE_KEY_PATTERN.test(value);
}

/** A Solana address (base58 of 32 bytes) → its device key (64 lowercase hex). */
export function deviceKeyFromSolanaAddress(address: string): string {
  let bytes: Uint8Array;
  try {
    bytes = base58.decode(address.trim());
  } catch {
    throw new DeviceKeyError('not a Solana address (base58)');
  }
  if (bytes.length !== 32) throw new DeviceKeyError(`a Solana address is 32 bytes, not ${bytes.length}`);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** A device key (64 hex, any case, optional 0x) → the Solana address that shows it. */
export function solanaAddressOf(deviceKey: string): string {
  const hex = deviceKey.replace(/^0x/, '').toLowerCase();
  if (!DEVICE_KEY_PATTERN.test(hex)) throw new DeviceKeyError('a device key is 64 hex characters');
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return base58.encode(bytes);
}

/** "7xKX…AsU" for display (the whole address stays in a title). */
export function shortSolanaAddress(address: string, head = 4, tail = 4): string {
  return address.length <= head + tail + 1 ? address : `${address.slice(0, head)}…${address.slice(-tail)}`;
}

/**
 * Something that signs with a device key: the connected Solana wallet in the browser (lane B2),
 * a test key in tests. `signMessage` returns the raw 64-byte Ed25519 signature over exactly
 * `message` (RFC 8032, as Phantom's `signMessage` does).
 */
export interface DeviceSigner {
  /** The device key, 64 lowercase hex. */
  readonly deviceKey: string;
  /** The same key as a Solana address (base58). */
  readonly address: string;
  signMessage(message: Uint8Array): Promise<Uint8Array>;
}
