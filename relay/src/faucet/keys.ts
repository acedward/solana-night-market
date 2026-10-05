// AA 00060 P13: the test SPL faucet's mint authority keys, from SPL_FAUCET_KEYS_FILE.
//
// The file is JSON, mode 600 (no group or other bits), one entry per mint:
//
//   { "<SPL mint, base58>": [64 numbers: a Solana CLI keypair file's content], … }
//
// Every mint must be in the journey registry (I-1): the faucet mints only the bridged test tokens. Each
// keypair must be consistent (its last 32 bytes are the public key of its first 32). Nothing here ever
// puts a key, or the file's text, in an error message; the caller registers every form of every key with
// the log redactor (`secretForms`) before it logs anything.

import nacl from 'tweetnacl';

import { decodeKey, encodeKey } from '@nightmarket/core/solana';

export class FaucetKeysError extends Error {
  override name = 'FaucetKeysError';
}

export interface FaucetKey {
  /** The authority's public key (base58). */
  publicKey: string;
  /** The 64-byte secret key (seed ‖ public key). */
  secretKey: Uint8Array;
}

const isBase58Key = (s: string): boolean => {
  try {
    return encodeKey(decodeKey(s)) === s;
  } catch {
    return false;
  }
};

/** Whether a file mode allows group or other access (anything beyond 600 / 400). */
export const modeTooOpen = (mode: number): boolean => (mode & 0o077) !== 0;

/**
 * Parse the keys file's text. `allowed` is the registry's SPL mints: any other mint is refused. Errors
 * name the mint (public) and the rule, never a key.
 */
export function parseFaucetKeys(text: string, allowed: ReadonlySet<string>): Map<string, FaucetKey> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new FaucetKeysError('SPL_FAUCET_KEYS_FILE is not JSON');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new FaucetKeysError('SPL_FAUCET_KEYS_FILE must be an object of SPL mint → keypair (64 numbers)');
  const out = new Map<string, FaucetKey>();
  for (const [mint, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isBase58Key(mint)) throw new FaucetKeysError('SPL_FAUCET_KEYS_FILE names a mint that is not a base58 key');
    if (!allowed.has(mint))
      throw new FaucetKeysError(
        `SPL_FAUCET_KEYS_FILE names the mint ${mint}, which is not in the journey registry (BRIDGE_REGISTRY_FILE): the faucet mints only the registry's tokens`,
      );
    if (
      !Array.isArray(value) ||
      value.length !== 64 ||
      !value.every((b) => Number.isInteger(b) && (b as number) >= 0 && (b as number) <= 255)
    )
      throw new FaucetKeysError(`SPL_FAUCET_KEYS_FILE: the key of ${mint} is not a keypair of 64 bytes`);
    const secretKey = Uint8Array.from(value as number[]);
    const derived = nacl.sign.keyPair.fromSeed(secretKey.slice(0, 32)).publicKey;
    if (!derived.every((b, i) => b === secretKey[32 + i]))
      throw new FaucetKeysError(
        `SPL_FAUCET_KEYS_FILE: the keypair of ${mint} is inconsistent (its public half is not its seed's)`,
      );
    out.set(mint, { publicKey: encodeKey(derived), secretKey });
  }
  if (out.size === 0) throw new FaucetKeysError('SPL_FAUCET_KEYS_FILE names no mint');
  return out;
}

/** Every text form of a secret key the log redactor must cut out: hex, the seed's hex, base58, and the
 *  keypair file's JSON array (with and without spaces). */
export function secretForms(key: FaucetKey): string[] {
  const hex = Buffer.from(key.secretKey).toString('hex');
  const arr = Array.from(key.secretKey);
  return [
    hex,
    hex.toUpperCase(),
    hex.slice(0, 64),
    encodeKey(key.secretKey),
    encodeKey(key.secretKey.slice(0, 32)),
    Buffer.from(key.secretKey).toString('base64'),
    JSON.stringify(arr),
    arr.join(','),
    arr.join(', '),
  ];
}
