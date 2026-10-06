// The check of a client's proof (AA 00062, I-62a: `ClientProofVerifier.verify`), run inside the
// hand-off, before the ledger receives the proof: so before any fee proof, balance, `bind`,
// `POST /v1/offers` or submission (spec FR-002, SC-004).
//
// HOW the relay checks a proof is OPEN: questions Q3 of plan 00062 (UNRESOLVED-BLOCKER for this one
// part). The relay's ledger cannot do it (research R3: the published ledger-v9 WASM is built without
// the ledger's `proof-verifying` feature, so its `wellFormed` accepts any contract proof; no other JS
// or proof-server verifier exists). Until Q3 is answered there is NO implementation here, and on
// purpose no permissive one: `required` mode refuses to start (exit 78) unless a real verifier is
// built in (`builtInClientProofVerifier` returns one). Tests hand the hand-off a test double through
// dependency injection only (./desk.ts `ClientProofDeskOptions.verifier`); nothing in the
// configuration can enable a verifier that does not verify.

import type { ClientProvenCircuit, ClientProvingMode } from '@nightmarket/core';

export interface ClientProofVerifierInput {
  circuit: ClientProvenCircuit;
  /** The I-62a proof request the page was given (the ledger's key-less `/prove` body). */
  proofRequest: Uint8Array;
  /** The page's proof, decoded (`midnight:proof-versioned:` …). */
  proof: Uint8Array;
  /** The PINNED `keys/<circuit>.verifier` of the relay's key volume: its sha256 is the key location's
   *  `?vk=`, which FR-005 already pins against the chain. */
  verifierKey: Uint8Array;
}

/** `reason` is logged (never shown to customers): a short technical cause, never the request's or the
 *  proof's bytes (a proof request carries the call's private inputs). */
export type ClientProofVerdict = { ok: true } | { ok: false; reason: string };

export interface ClientProofVerifier {
  /** A short name for the log (never shown to customers). */
  readonly name: string;
  verify(input: ClientProofVerifierInput): Promise<ClientProofVerdict>;
}

/** Why `required` mode cannot start in this build. */
export const NO_CLIENT_PROOF_VERIFIER =
  'CLIENT_PROVING=required needs a client-proof verifier, and this relay has none yet: how the relay checks a ' +
  "client's proof is still open (AA 00062 questions Q3). Run with CLIENT_PROVING=off until a verifier is built in";

/**
 * The verifier compiled into this relay, or null. Null until questions Q3 is answered and its
 * implementation lands (recommendation A: a pinned verifier-only WASM built from midnight-ledger tag
 * `ledger-9.1.0.0-rc.3` with proof verification on). Never a verifier that accepts without checking.
 */
export function builtInClientProofVerifier(): ClientProofVerifier | null {
  return null;
}

/**
 * Whether the relay may start with this client-proving mode and verifier: null when it may, else the
 * reason it must not (main.ts exits 78 with it). `off` never needs a verifier.
 */
export function clientProvingStartProblem(
  mode: ClientProvingMode,
  verifier: ClientProofVerifier | null,
  keyVolume: { loaded: boolean; fingerprint: string | null },
): string | null {
  if (mode === 'off') return null;
  if (!verifier) return NO_CLIENT_PROOF_VERIFIER;
  if (!keyVolume.loaded || !keyVolume.fingerprint) {
    return 'CLIENT_PROVING=required needs the key volume (MIDNIGHT_MANAGED_PATH): a client proof is checked against its pinned verifier keys, and the page is told its key set';
  }
  return null;
}
