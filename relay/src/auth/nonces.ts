// Relay-issued, single-use nonces for RelayAction authorisations (packages/core/src/auth.ts).
//
// STATELESS (AA 00047 P10, audit round 2 R2-8 / F-A2-6). A nonce is 32 bytes the relay can check
// without having stored it: its expiry (6 bytes, Unix seconds), 10 random bytes, and the first 16
// bytes of an HMAC-SHA256 over both under a key the relay draws at start. Issuing one stores
// NOTHING, so no number of clients, from any number of addresses, can fill a store and lock other
// customers out (round 1's eviction attack, then round 2's "full store" refusal). Issuance is
// bounded only by the per-client rate limit (`RATE_LIMIT_NONCES_PER_MIN`, an IPv6 client counted per
// /64: ../client-key.ts).
//
// A nonce is accepted once, ever:
//   - one with a wrong MAC (not issued by this process: forged, or issued before a restart, since the
//     key is new at every start) or past its expiry is `unknown`;
//   - a used nonce is remembered until its expiry, so a replay is reported as `used`.
// The used set is the only state. It holds at most `maxUsed` entries (`AUTH_MAX_USED_NONCES`); each
// entry needs a signed request that passed the per-client action rate limit. If it is ever full, the
// OLDEST used nonce is forgotten to make room (never a refusal). A forgotten nonce could be accepted
// again only with its signed envelope, which only its signer holds (it travels over TLS), and only
// until the envelope's own expiry (at most `AUTH_MAX_TTL_SECONDS`); every cap still applies to it
// (questions Q37).

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export type NonceIssue =
  | { ok: true; nonce: string; expiresAt: number }
  | {
      ok: false;
      /** Kept for the route's shape: the stateless store never refuses. */
      refused: 'client-cap' | 'full';
      retryAfterSeconds: number;
    };

const MAC_LABEL = 'night-market relay: auth nonce v1';

export class NonceStore {
  /** Used nonces (lowercase hex, no 0x) → their expiry; insertion order = age order. */
  private readonly used = new Map<string, number>();
  private readonly key: Uint8Array;
  /** Used nonces forgotten before their expiry to make room (operators, tests). */
  evicted = 0;

  constructor(
    private readonly ttlSeconds: number,
    private readonly maxUsed: number,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
    key?: Uint8Array,
  ) {
    this.key = key ?? randomBytes(32);
  }

  private mac(head: Uint8Array): Buffer {
    return createHmac('sha256', this.key).update(MAC_LABEL).update(head).digest().subarray(0, 16);
  }

  /** A new nonce. `_client` is not stored (the per-client limit is the route's rate limiter). */
  issue(_client = 'unknown'): NonceIssue {
    const expiresAt = this.now() + this.ttlSeconds;
    const head = Buffer.alloc(16);
    head.writeUIntBE(expiresAt, 0, 6);
    randomBytes(10).copy(head, 6);
    return { ok: true, nonce: `0x${head.toString('hex')}${this.mac(head).toString('hex')}`, expiresAt };
  }

  consume(nonce: string): 'ok' | 'unknown' | 'used' {
    const hex = nonce.toLowerCase().replace(/^0x/, '');
    if (!/^[0-9a-f]{64}$/.test(hex)) return 'unknown';
    const bytes = Buffer.from(hex, 'hex');
    const head = bytes.subarray(0, 16);
    if (!timingSafeEqual(bytes.subarray(16), this.mac(head))) return 'unknown';
    const expiresAt = head.readUIntBE(0, 6);
    const now = this.now();
    if (expiresAt <= now || expiresAt > now + this.ttlSeconds) return 'unknown';
    if (this.used.has(hex)) return 'used';
    if (this.used.size >= this.maxUsed) this.sweep();
    while (this.used.size >= this.maxUsed) {
      const oldest = this.used.keys().next().value;
      if (oldest === undefined) break;
      this.used.delete(oldest);
      this.evicted++;
    }
    this.used.set(hex, expiresAt);
    return 'ok';
  }

  get size(): { issued: number; used: number } {
    return { issued: 0, used: this.used.size };
  }

  /** Outstanding nonces of a client: none are stored (kept for callers of the old store). */
  outstanding(_client: string): number {
    return 0;
  }

  sweep(): void {
    const now = this.now();
    for (const [n, exp] of this.used) if (exp <= now) this.used.delete(n);
  }
}
