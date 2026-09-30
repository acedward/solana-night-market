// Fixed inputs of plan 00039's P0.4 browser spike, so its recorded outputs can be reproduced
// here (evidence/00039-passport-evm-dapp/p0.4-browser-spike.md). Every "fixed" byte string is
// sha256 of a public label: nothing here is a secret.

import { sha256 } from '@noble/hashes/sha2.js';

import { hexToBytes as unhex } from '../../src/hex.js';

export const LABEL = 'aa00039-p0.4-spike';
const utf8 = (s: string) => new TextEncoder().encode(s);
export const fixed = (name: string): Uint8Array => sha256(utf8(`${LABEL}:${name}`));

/** The colour the spike's coins carry (MN Bank's bridged wStkA): any 32 bytes would do, but the
 *  recorded sealed-entry digest below was made with this one. */
export const SPIKE_COLOUR = '5eb2a3cebb2ebe7ba910c78f62c9e28e0d74acbd00c810730def3578860e6a02';

export const F = {
  account: fixed('account-address'),
  authNonce: 5n,
  colour: unhex(SPIKE_COLOUR),
  coin: { nonce: fixed('held-coin-nonce'), color: unhex(SPIKE_COLOUR), value: 10_000_000n, mt_index: 12345n },
  wantNonce: fixed('want-nonce'),
  wantColour: fixed('want-colour'),
  wantAmount: 10_500_000n,
  giveAmount: 10_000_000n - 2_500_000n,
  validUntil: 1_800_000_000n,
  encSecretFixed: fixed('enc-secret'),
  plainCoins: [0, 1, 2, 3].map((i) => ({
    nonce: fixed(`inbox-coin-nonce-${i}`),
    color: i % 2 === 0 ? unhex(SPIKE_COLOUR) : fixed('other-colour'),
    value: [1n, 1_000_000n, 2n ** 64n + 7n, 2n ** 128n - 1n][i]!,
  })),
};

/** The spike's outputs (evidence p0.4; `out/node.json`), identical in Node, Bun and Chromium: the
 *  arm-agnostic ones (the EVM arm's typed data, challenges and signatures went with the arm). */
export const EXPECTED = {
  fixedEncPublicKey: '489ee6fc8ffb2044bc1c63052bf746bf7936e5418c0e3c7c17fd8bb09c9c2f02',
  seededKeyPairPublicKey: '4bc6f7e4809961380972a7e1e1dacfaa74c6db2cb68bb571b00634b6e9cbf805',
  sealedEntriesSha256: '0409ce1590d2b2e7d8573008985e14ea2d6d0cc102b64fe51dccec6756efca5d',
  openSwap: {
    changeNonce: '5c58fa8b82e798b9fc8e3b80b8df90c8afb77a320a289bb4b8ec92d454add700',
  },
};

/** Replace crypto.getRandomValues with a seeded SHA-256 counter stream while `fn` runs, so
 *  sealing and key generation are byte-reproducible (the spike's technique). */
export async function withSeededRandom<T>(seed: string, fn: () => Promise<T> | T): Promise<T> {
  const c = globalThis.crypto as unknown as Record<string, unknown>;
  const seedBytes = utf8(`${LABEL}:drbg:${seed}`);
  let counter = 0;
  let pool = new Uint8Array(0);
  const next = (n: number): Uint8Array => {
    while (pool.length < n) {
      const block = new Uint8Array(seedBytes.length + 4);
      block.set(seedBytes, 0);
      new DataView(block.buffer).setUint32(seedBytes.length, counter++);
      const h = sha256(block);
      const merged = new Uint8Array(pool.length + h.length);
      merged.set(pool, 0);
      merged.set(h, pool.length);
      pool = merged;
    }
    const out = pool.slice(0, n);
    pool = pool.slice(n);
    return out;
  };
  const drbg = (arr: ArrayBufferView) => {
    new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength).set(next(arr.byteLength));
    return arr;
  };
  const own = Object.prototype.hasOwnProperty.call(c, 'getRandomValues');
  const prev = c.getRandomValues;
  Object.defineProperty(c, 'getRandomValues', { value: drbg, configurable: true, writable: true });
  try {
    return await fn();
  } finally {
    if (own) Object.defineProperty(c, 'getRandomValues', { value: prev, configurable: true, writable: true });
    else delete c.getRandomValues;
  }
}
