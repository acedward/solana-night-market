// The bridge colour of an SPL mint at a bridge contract (AA 00060), recomputed exactly as the bridge
// contract's compiled module does it (effectstream PR #936 @ f460da1, `bridge.compact` sha256
// b6150529…, compactc 0.35.0; managed/contract/index.js `_domainSep_0`, `_tokenType_0`):
//
//   domainSep(mint)          = persistentHash<Vector<2, Bytes<32>>>([pad(32, "effectstream:bridge:sol:v1"), mint])
//   tokenType(sep, contract) = persistentCommit<Vector<2, Bytes<32>>>([sep, contract], pad(32, "midnight:derive_token"))
//   tokenColor(mint, bridge) = tokenType(domainSep(mint), bridge)
//
// A unit test holds this equal to the compiled contract's own `pureCircuits.tokenColor`
// (packages/core/test/bridge-registry.test.ts, over fixtures/bridge-colour.json), and P3 equals it to the
// colour of the coins the deployed contract mints.

import {
  CompactTypeBytes,
  CompactTypeVector,
  persistentCommit,
  persistentHash,
} from '@midnight-ntwrk/compact-runtime-0.20';

import { bytesToHex, hexToBytes } from '../hex.js';
import { base58Key32 } from './landing-key.js';

const pad32 = (text: string): Uint8Array => {
  const out = new Uint8Array(32);
  out.set(Uint8Array.from(text, (c) => c.charCodeAt(0)));
  return out;
};

const PAIR = new CompactTypeVector(2, new CompactTypeBytes(32));
const SEP_DOMAIN = pad32('effectstream:bridge:sol:v1');
const DERIVE_TOKEN = pad32('midnight:derive_token');

/** `domainSep(mint)` (32 bytes). */
export function bridgeDomainSep(mint: Uint8Array): Uint8Array {
  if (mint.length !== 32) throw new RangeError('an SPL mint is 32 bytes');
  return persistentHash(PAIR, [SEP_DOMAIN, mint]);
}

/** The bridge colour (64 lowercase hex) of an SPL mint (base58 or 32 bytes) at a bridge contract (64 hex or 32 bytes). */
export function bridgeColourOf(mint: string | Uint8Array, bridgeContract: string | Uint8Array): string {
  const m = typeof mint === 'string' ? base58Key32(mint) : mint;
  if (!m) throw new RangeError('the SPL mint is not the base58 of 32 bytes');
  const c = typeof bridgeContract === 'string' ? hexToBytes(bridgeContract.replace(/^0x/, ''), 32) : bridgeContract;
  if (c.length !== 32) throw new RangeError('a contract address is 32 bytes');
  return bytesToHex(persistentCommit(PAIR, [bridgeDomainSep(m), c], DERIVE_TOKEN));
}
