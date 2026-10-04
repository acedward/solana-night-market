// The token list's DIGEST (AA 00060 P4, spec FR-014): what the relay publishes in `GET /v1/config`
// (`tokensDigest`) and the site compares with its own. Two lists with the same digest render the same
// bytes for every account call (each message labels a colour with its symbol and decimals; Q12) and list
// the same tradeable tokens. A list that differs anywhere in those makes the relay refuse the site's
// signatures; the site then disables every signed action instead of letting the wallet sign in vain.
//
//   tokensDigest = SHA-256( canonicalJson( [ {colour, symbol, decimals, privacy} for each entry, sorted
//                  by colour ] ) ), 64 lowercase hex
//
// Only those four fields: a name, an issuer contract or a source record change nothing a wallet signs.

import { sha256 } from '@noble/hashes/sha2.js';

import { canonicalJson } from '../auth.js';
import { bytesToHex } from '../hex.js';
import type { TokenRegistry } from './registry.js';

export function tokensDigest(registry: Pick<TokenRegistry, 'tokens'>): string {
  const entries = [...registry.tokens]
    .map((t) => ({ colour: t.midnightColour, symbol: t.symbol, decimals: t.decimals, privacy: t.privacy }))
    .sort((a, b) => (a.colour < b.colour ? -1 : a.colour > b.colour ? 1 : 0));
  return bytesToHex(sha256(new TextEncoder().encode(canonicalJson(entries))));
}
