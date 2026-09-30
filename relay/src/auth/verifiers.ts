// How a state-changing request proves who asked for it. Every action route declares one of two
// kinds, and the route refuses the request unless it verifies.
//
// 1. `relay-action`: a RelayAction envelope (packages/core/src/auth.ts) over the action, network,
//    owner (the device key), account, a hash of the body, a relay-issued single-use nonce and an
//    expiry, signed by the device. Registration uses it, and it doubles as the enrolment (the owner
//    IS the device key), so registering is one prompt. Its signature scheme is the seam lane B3 fills
//    (`RelayActionScheme`); without one every envelope is refused as `not-supported`.
//
// 2. `passport-call`: the gated call's OWN Passport signature (a withdrawal, an inbox append, an
//    offer), which the contract verifies anyway. Accepting it here keeps every gated action to ONE
//    wallet prompt. Its replay protection is the account's on-chain `auth_nonce`: the device arm
//    (../passport/arm.ts) checks that the signed nonce is the current one and that the signer is a
//    live device of the account, before the relay spends a proof on the call, and the replay guard
//    below remembers digests it has accepted until they are consumed.

import {
  verifyRelayAction,
  type AuthFailureCode,
  type RelayActionName,
  type RelayActionScheme,
} from '@nightmarket/core';

import type { NonceStore } from './nonces.js';

export type AuthKind = 'relay-action' | 'passport-call';

export type VerifyOutcome =
  | {
      ok: true;
      signer: string;
      kind: AuthKind;
      account?: string;
      /** Undo what accepting the authorisation claimed (a passport-call's digest in the replay
       *  guard), when the route refuses the request after all (a rate limit, a full queue), so the
       *  customer can send the same signature again later. */
      release?: () => void;
    }
  | { ok: false; code: AuthFailureCode; reason: string };

export interface RelayActionContext {
  action: RelayActionName;
  network: string;
  /** The envelope's signature scheme; absent until a wallet arm is wired. */
  scheme?: RelayActionScheme;
  account?: string;
  payload: unknown;
  maxTtlSeconds: number;
  nonces: NonceStore;
  now?: number;
}

export function verifyRelayActionRequest(auth: unknown, ctx: RelayActionContext): VerifyOutcome {
  const r = verifyRelayAction(auth, {
    expectedAction: ctx.action,
    network: ctx.network,
    ...(ctx.scheme ? { scheme: ctx.scheme } : {}),
    expectedAccount: ctx.account,
    payload: ctx.payload,
    maxTtlSeconds: ctx.maxTtlSeconds,
    now: ctx.now,
    consumeNonce: (nonce) => ctx.nonces.consume(nonce),
  });
  if (!r.ok) return r;
  return { ok: true, signer: r.signer, kind: 'relay-action', account: ctx.account };
}

// ── passport-call ───────────────────────────────────────────────────────────

/** Remembers accepted digests until their call lands (or a TTL), so a replay cannot queue a
 *  second proof of the same call. */
export class DigestReplayGuard {
  private readonly seen = new Map<string, number>();
  constructor(
    private readonly ttlSeconds: number,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {}
  /** Forget a digest whose call did not land (a failed job), so the customer can retry. */
  release(digestHex: string): void {
    this.seen.delete(digestHex);
  }

  /** True if the digest was new (and is now remembered). */
  claim(digestHex: string): boolean {
    const now = this.now();
    for (const [d, exp] of this.seen) if (exp <= now) this.seen.delete(d);
    if (this.seen.has(digestHex)) return false;
    this.seen.set(digestHex, now + this.ttlSeconds);
    return true;
  }
}
