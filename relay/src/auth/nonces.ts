// Relay-issued, single-use nonces for RelayAction authorisations (packages/core/src/auth.ts).
//
// The store lives in memory only. A nonce the relay did not issue, or issued before a restart,
// is unknown and refused, so a signature can be accepted at most once, ever. A used nonce is
// remembered until it would have expired, so a replay is reported as a replay.
//
// An outstanding (issued, unused, unexpired) nonce is NEVER evicted to make room (AA 00047 P9, audit
// C9 / F-A7.3): evicting the oldest let a client spread over many addresses push other customers'
// nonces out, and their registration or demo-token claim then failed as `unknown-nonce`. Instead:
//   - each client address may hold at most `maxPerClient` outstanding nonces; past that its own
//     requests are refused (`client-cap`) until one is used or expires;
//   - the whole store holds at most `maxIssued`; past that every request is refused (`full`) until
//     nonces are used or expire.

import { randomBytes } from 'node:crypto';

export type NonceIssue =
  | { ok: true; nonce: string; expiresAt: number }
  | {
      ok: false;
      /** `client-cap`: this client holds its maximum; `full`: the store holds its maximum. */
      refused: 'client-cap' | 'full';
      /** Seconds until the oldest nonce blocking this request expires. */
      retryAfterSeconds: number;
    };

export class NonceStore {
  /** Outstanding nonces: their expiry and the client they were issued to (insertion = age order). */
  private readonly issued = new Map<string, { expiresAt: number; client: string }>();
  /** Outstanding nonces per client. */
  private readonly perClient = new Map<string, number>();
  private readonly used = new Map<string, number>();

  constructor(
    private readonly ttlSeconds: number,
    private readonly maxIssued: number,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
    private readonly maxPerClient: number = maxIssued,
  ) {}

  issue(client = 'unknown'): NonceIssue {
    this.sweep();
    const now = this.now();
    if (this.issued.size >= this.maxIssued) {
      return { ok: false, refused: 'full', retryAfterSeconds: this.oldestExpiry(undefined, now) };
    }
    if ((this.perClient.get(client) ?? 0) >= this.maxPerClient) {
      return { ok: false, refused: 'client-cap', retryAfterSeconds: this.oldestExpiry(client, now) };
    }
    const nonce = `0x${randomBytes(32).toString('hex')}`;
    const expiresAt = now + this.ttlSeconds;
    this.issued.set(nonce, { expiresAt, client });
    this.perClient.set(client, (this.perClient.get(client) ?? 0) + 1);
    return { ok: true, nonce, expiresAt };
  }

  consume(nonce: string): 'ok' | 'unknown' | 'used' {
    const key = nonce.toLowerCase();
    const now = this.now();
    if (this.used.has(key)) return 'used';
    const rec = this.issued.get(key);
    if (rec === undefined) return 'unknown';
    this.forget(key, rec.client);
    if (rec.expiresAt <= now) return 'unknown';
    this.used.set(key, rec.expiresAt);
    return 'ok';
  }

  get size(): { issued: number; used: number } {
    return { issued: this.issued.size, used: this.used.size };
  }

  /** Outstanding nonces issued to `client`. */
  outstanding(client: string): number {
    return this.perClient.get(client) ?? 0;
  }

  sweep(): void {
    const now = this.now();
    for (const [n, rec] of this.issued) if (rec.expiresAt <= now) this.forget(n, rec.client);
    for (const [n, exp] of this.used) if (exp <= now) this.used.delete(n);
  }

  private forget(nonce: string, client: string): void {
    this.issued.delete(nonce);
    const left = (this.perClient.get(client) ?? 1) - 1;
    if (left > 0) this.perClient.set(client, left);
    else this.perClient.delete(client);
  }

  /** Seconds until the oldest outstanding nonce (of `client`, or of anyone) expires; at least 1. */
  private oldestExpiry(client: string | undefined, now: number): number {
    for (const rec of this.issued.values()) {
      if (client === undefined || rec.client === client) return Math.max(1, rec.expiresAt - now);
    }
    return 1;
  }
}
