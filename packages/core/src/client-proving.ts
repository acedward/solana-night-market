// Client proving (AA 00062, interface I-62a v2, "prove first"): the relay hands the page the proof request
// of ONE k≥18 account call, the page has the user's own prover (the "Night Market prover" package, I-62b)
// prove it, and posts the proof back. The relay checks it, then finishes the transaction as it does today.
//
// The relay's mode is `CLIENT_PROVING=off|required` (default `off`). In `off` nothing here appears on
// the wire: the two client-proof routes answer 404 `client-proving-off`, a job view never carries
// `clientProof`, and `/v1/config` and `/health` carry no `clientProving` (a missing one means `off`,
// as it does for an older relay).
//
// Prove first (owner, questions Q4 → D): the action's route PREPARES the call (built and captured, nothing
// proven) and the job PARKS with a ticket, holding only its account's one-job slot (no prover lane, no
// sponsor wallet) while the user proves. The proof posted back FINALIZES it: checked, then the account's
// state is checked unchanged (`client-proof-stale` otherwise), then the relay finishes the call.
//
// The ticket, as a job sees it:
//   - `state` stays `running`; the stages `awaiting-client-proof` {circuit, proofId, attempt},
//     `client-proof-fetched` {proofId}, `client-proof-received` {proofId}, `client-proof-checked`
//     {proofId} come in order, then the action's own stages;
//   - `clientProof` {proofId, circuit, deadline, attempt, fetched} is present exactly while the ticket
//     is open (waiting for its one proof);
//   - one ticket per job (`attempt` is always 1): a DUST race at finalize re-balances with the same proof.
//
// Encodings: bytes as standard base64 with padding (RFC 4648 §4), times as Unix seconds, ids as 32
// lowercase hex characters.

import { z } from 'zod';

/** The k≥18 account circuits the user's prover proves in `required` mode (sorted). Everything else
 *  stays proved by the relay. */
export const CLIENT_PROVEN_CIRCUITS = [
  'append_inbox_with_ed25519',
  'open_swap_shielded_with_ed25519',
  'withdraw_shielded_with_ed25519',
  'withdraw_unshielded_with_ed25519',
] as const;
export type ClientProvenCircuit = (typeof CLIENT_PROVEN_CIRCUITS)[number];

export function isClientProvenCircuit(circuit: string): circuit is ClientProvenCircuit {
  return (CLIENT_PROVEN_CIRCUITS as readonly string[]).includes(circuit);
}

export const CLIENT_PROVING_MODES = ['off', 'required'] as const;
export type ClientProvingMode = (typeof CLIENT_PROVING_MODES)[number];

/** The ASCII tag every proof request starts with: the ledger's key-less `/prove` body. */
export const PROOF_REQUEST_TAG = 'midnight:(proof-preimage-versioned,option(proving-data),option(fr-bls)):';
/** The ASCII tag every proof starts with: proof server 9.0.0-rc.8's `/prove` answer (`ProofVersioned`). */
export const PROOF_TAG = 'midnight:proof-versioned:';

/** The largest proof request and the largest proof (decoded bytes). */
export const CLIENT_PROOF_REQUEST_MAX_BYTES = 64 * 1024;
export const CLIENT_PROOF_MAX_BYTES = 64 * 1024;
/** The largest `POST /v1/jobs/:requestId/client-proof` body. */
export const CLIENT_PROOF_POST_MAX_BYTES = 128 * 1024;

/** How long a ticket waits for its proof by default, and the range an operator may set. Nothing is held
 *  while the user proves (I-62a v2), so it may be long; the call's intent lives one hour. */
export const CLIENT_PROOF_TIMEOUT_DEFAULT_SECONDS = 600;
export const CLIENT_PROOF_TIMEOUT_MIN_SECONDS = 60;
export const CLIENT_PROOF_TIMEOUT_MAX_SECONDS = 3000;
/** The time a call keeps after its proof, before its signed deadline (a make, a take) and its intent's
 *  TTL: to finalize, merge, settle, list or submit. */
export const CLIENT_PROOF_SETTLE_MARGIN_SECONDS = 60;
/** A ticket with less than this left at prepare fails `client-proof-late` at once. */
export const CLIENT_PROOF_MIN_WINDOW_SECONDS = 30;
/** Tickets one job may open (I-62a v2): exactly one. A DUST race at finalize re-balances with the same
 *  proof; a stale call is a new job (the page sends the same signed request again). */
export const CLIENT_PROOF_MAX_ATTEMPTS = 1;

/** The job errors of client proving: nothing was submitted, no fee was proven, no DUST was spent and
 *  no offer was posted. `client-proof-stale` (I-62a v2): the account changed between prepare and finalize
 *  (or a take's maker offer is gone); the page may send the same signed request again. */
export const CLIENT_PROOF_JOB_ERRORS = [
  'client-proof-missing',
  'client-proof-late',
  'client-proof-invalid',
  'client-proof-stale',
] as const;
export type ClientProofJobError = (typeof CLIENT_PROOF_JOB_ERRORS)[number];

/** The route errors of `GET`/`POST /v1/jobs/:requestId/client-proof` (beside `bad-request`, `not-found`). */
export const CLIENT_PROOF_ROUTE_ERRORS = [
  'client-proving-off',
  'not-awaiting-client-proof',
  'client-proof-wrong-id',
  'client-proof-already-received',
  'client-proof-late',
  'client-proof-invalid',
  'client-proof-stale',
] as const;

/** The job stages of a hand-off, in order. */
export const CLIENT_PROOF_STAGES = [
  'awaiting-client-proof',
  'client-proof-fetched',
  'client-proof-received',
  'client-proof-checked',
] as const;

const hex32 = z.string().regex(/^[0-9a-f]{32}$/);
const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
/** Standard base64 with padding (RFC 4648 §4); no line breaks, no URL alphabet. */
export const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const base64 = z.string().regex(BASE64_PATTERN);

/** The job view's `clientProof`: present exactly while the job's ticket is open. */
export const ClientProofFieldSchema = z.object({
  proofId: hex32,
  circuit: z.enum(CLIENT_PROVEN_CIRCUITS),
  /** Unix seconds: the proof must arrive before it. */
  deadline: z.number().int(),
  /** 1-based within the job (I-62a v2: always 1). */
  attempt: z.number().int().min(1).max(CLIENT_PROOF_MAX_ATTEMPTS),
  /** Whether the page has fetched the proof request. */
  fetched: z.boolean(),
});
export type ClientProofField = z.infer<typeof ClientProofFieldSchema>;

/** `GET /v1/jobs/:requestId/client-proof` → 200 (served `Cache-Control: no-store`). The request carries
 *  the call's private inputs: never log it, drop it once the proof is in. */
export const ClientProofRequestSchema = z.object({
  proofId: hex32,
  circuit: z.enum(CLIENT_PROVEN_CIRCUITS),
  /** The ledger's key-less `/prove` body for this one proof, `HEAD | 0x00 | TAIL`, base64. */
  proofRequest: base64,
  /** The index of the `0x00` (the key material's `None`) in the decoded `proofRequest`. */
  keyMaterialOffset: z.number().int().min(0),
  deadline: z.number().int(),
  attempt: z.number().int().min(1).max(CLIENT_PROOF_MAX_ATTEMPTS),
  /** The key set's fingerprint (64 hex): the prover must hold the same. */
  keySet: hex64,
  /** The proof server version the prover must run (e.g. `9.0.0-rc.8`). */
  proofServer: z.string().min(1),
});
export type ClientProofRequest = z.infer<typeof ClientProofRequestSchema>;

/** `POST /v1/jobs/:requestId/client-proof` body: exactly these two fields (nothing else, never a URL). */
export const ClientProofSubmissionSchema = z
  .object({
    proofId: hex32,
    /** The prover's answer, verbatim (`midnight:proof-versioned:` …), base64. */
    proof: base64,
  })
  .strict();
export type ClientProofSubmission = z.infer<typeof ClientProofSubmissionSchema>;

/** `/v1/config`'s `clientProving` (only in `required` mode; absent means `off`). */
export const ClientProvingConfigSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('off') }),
  z.object({
    mode: z.literal('required'),
    /** The circuits the user's prover proves (sorted). */
    circuits: z.array(z.enum(CLIENT_PROVEN_CIRCUITS)),
    keySet: hex64,
    proofServer: z.string().min(1),
    /** How long a ticket waits at most (the action's own deadline can make it shorter). */
    timeoutSeconds: z.number().int(),
  }),
]);
export type ClientProvingConfig = z.infer<typeof ClientProvingConfigSchema>;

/** `/health`'s `clientProving` (only in `required` mode; absent means `off`). */
export const ClientProvingHealthSchema = z.object({ mode: z.enum(CLIENT_PROVING_MODES) });
export type ClientProvingHealth = z.infer<typeof ClientProvingHealthSchema>;
