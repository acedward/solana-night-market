// The relay's HTTP API: paths, request and response shapes. The browser and the relay both
// import these, so a change here is a change of the wire contract for both.
//
// State-changing requests are `POST /v1/actions/:action`, each carrying a signed
// authorisation (see ./auth.ts). The relay keeps no per-user data (Q5): a job lives in the
// relay's memory until its TTL, and the browser keeps the request id to resume it.

import { z } from 'zod';

import { RELAY_ACTIONS, type RelayActionName, SignedRelayActionSchema } from './auth.js';

export const API_PATHS = {
  health: '/health',
  config: '/v1/config',
  nonce: '/v1/auth/nonce',
  action: (action: RelayActionName) => `/v1/actions/${action}`,
  job: (requestId: string) => `/v1/jobs/${requestId}`,
  queue: '/v1/queue',
  accountState: (account: string) => `/v1/accounts/${account}/state`,
  accountInbox: (account: string) => `/v1/accounts/${account}/inbox`,
  accountZswap: (account: string) => `/v1/accounts/${account}/zswap`,
  /** The demo-token pack and limits (AA 00047 B3, ./demo-tokens.ts). */
  demoTokens: '/v1/demo-tokens',
  /** The test SPL faucet: what a claim mints, and a wallet's last claim (AA 00060 P13, ./spl-faucet.ts). */
  splFaucet: '/v1/spl-faucet',
} as const;

// ── Errors ──────────────────────────────────────────────────────────────────

export const ApiErrorSchema = z.object({
  error: z.object({
    /** Machine-readable: `unauthorised`, `rate-limited`, `not-found`, `bad-request`, … */
    code: z.string(),
    message: z.string(),
    /** For auth failures, the precise reason (see AuthFailureCode). */
    detail: z.string().optional(),
  }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

// ── Nonces ──────────────────────────────────────────────────────────────────

export const NonceResponseSchema = z.object({
  nonce: z.string().regex(/^0x[0-9a-f]{64}$/),
  /** Unix seconds after which the relay forgets the nonce. */
  expiresAt: z.number().int(),
  /** The furthest ahead an authorisation's expiry may be, in seconds. */
  maxTtlSeconds: z.number().int(),
});
export type NonceResponse = z.infer<typeof NonceResponseSchema>;

// ── Actions and jobs ────────────────────────────────────────────────────────

/** A lane is the queue a job waits in: `prover`, one job at a time across the relay (every
 *  sponsor-paid call holds it); `account`, one job at a time PER ACCOUNT, proving through the
 *  prover lane only around its proofs; `relay`, one job at a time across the relay, also proving
 *  only around its proofs. Every action today runs on the prover lane. */
export const JOB_LANES = ['prover', 'account', 'relay'] as const;
export type JobLane = (typeof JOB_LANES)[number];

export const JOB_STATES = ['queued', 'running', 'succeeded', 'failed'] as const;
export type JobState = (typeof JOB_STATES)[number];

export const JobStageSchema = z.object({
  /** A short stable id, e.g. `queued`, `proving`, `submitted`, `settled`. */
  stage: z.string(),
  at: z.number().int(),
  /** Public details only: transaction hashes, request ids, heights. Never a secret. */
  detail: z.record(z.string(), z.string()).optional(),
});
export type JobStage = z.infer<typeof JobStageSchema>;

/** The actions a job can run (every one is requested through a route). */
export type JobActionName = RelayActionName;

export const JobViewSchema = z.object({
  requestId: z.string().regex(/^[0-9a-f]{32}$/),
  action: z.enum(RELAY_ACTIONS),
  lane: z.enum(JOB_LANES),
  state: z.enum(JOB_STATES),
  /** The newest stage. */
  stage: z.string(),
  stages: z.array(JobStageSchema),
  /** 1-based position among the jobs waiting in the same queue, while queued. */
  position: z.number().int().positive().optional(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  /** Unix seconds after which the relay forgets this job. */
  expiresAt: z.number().int(),
  /** Public outcome (addresses, hashes, the new coin's public data). */
  result: z.record(z.string(), z.unknown()).optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});
export type JobView = z.infer<typeof JobViewSchema>;

export const ActionRequestSchema = z.object({
  /** The Passport account the action is for; absent for registration. */
  account: z
    .string()
    .regex(/^(0x)?[0-9a-f]{64}$/)
    .optional(),
  /** The action's arguments. Bytes are hex strings, amounts decimal strings. */
  payload: z.record(z.string(), z.unknown()),
  /** The relay authorisation (a RelayAction envelope, signed by the device). */
  auth: SignedRelayActionSchema.optional(),
  /** A gated call's own Passport authorisation, for routes that accept it instead. */
  passportAuth: z.record(z.string(), z.unknown()).optional(),
});
export type ActionRequest = z.infer<typeof ActionRequestSchema>;

export const ActionResponseSchema = z.object({ job: JobViewSchema });
export type ActionResponse = z.infer<typeof ActionResponseSchema>;

// ── Health ─────────────────────────────────────────────────────────

export const HEALTH_STATUSES = ['ok', 'degraded', 'down'] as const;

export const HealthResponseSchema = z.object({
  status: z.enum(HEALTH_STATUSES),
  network: z.string(),
  version: z.string(),
  uptimeSeconds: z.number().int(),
  sponsor: z.object({
    configured: z.boolean(),
    state: z.string(),
    synced: z.boolean(),
    /** DUST balance in specks (10^-15 DUST), decimal string; null when unknown. The settled
     *  balance (issue 00049): a DUST output locked by one of the sponsor's transactions in flight
     *  counts at its value minus that transaction's fee (in full until the fee is known), so the
     *  balance does not dip mid-transaction. */
    dustSpecks: z.string().nullable(),
    /** The part of `dustSpecks` held by transactions in flight, decimal string ("0" when idle).
     *  Optional so a page tolerates an older relay. */
    dustInFlightSpecks: z.string().optional(),
    dustLow: z.boolean(),
  }),
  /** The CONTRACT prover (proof server 9.0.0-rc.8): the account's circuits, with the key volume. */
  proofServer: z.object({
    reachable: z.boolean(),
    version: z.string().nullable(),
    jobCapacity: z.number().nullable(),
    keys: z.object({
      present: z.boolean(),
      fingerprint: z.string().nullable(),
      pinned: z.boolean(),
      matchesPin: z.boolean().nullable(),
      /** Every circuit the relay proves has its keys, as deployed (plan P4-A). */
      complete: z.boolean().optional(),
      /** How many circuits the relay proves lack a key or do not match the deployed contract. */
      problems: z.number().int().optional(),
    }),
  }),
  /** The DUST prover (proof server 9.0.0-rc.6 while stagenet requires dust/9): the sponsor wallet's
   *  fee payments. Every paid action needs both provers (AA 00047 spike 3 §6). Optional only so a
   *  page tolerates an older relay; this relay always reports it. */
  dustProofServer: z
    .object({
      reachable: z.boolean(),
      version: z.string().nullable(),
      jobCapacity: z.number().nullable(),
    })
    .optional(),
  queue: z.object({
    jobs: z.number().int(),
    lanes: z.record(z.string(), z.object({ running: z.number().int(), waiting: z.number().int() })),
  }),
  kernel: z.object({ reachable: z.boolean(), synced: z.boolean().nullable() }),
  batcher: z.object({
    reachable: z.boolean(),
    /** The batcher's last refusal of a take this relay submitted (plan P4-A): 429 = its request cap,
     *  500 = a generic failure (a replayed settlement answers 500 too). Null when none. */
    lastRefusal: z.object({ httpStatus: z.number().int(), at: z.number().int() }).nullable().optional(),
  }),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

// ── Public configuration ────────────────────────────────────────────────────

export const PublicConfigSchema = z.object({
  network: z.string(),
  relayVersion: z.string(),
  limits: z.object({
    authMaxTtlSeconds: z.number().int(),
    jobTtlSeconds: z.number().int(),
    /** AA 00047 P9 (audit C6, ./offer-expiry.ts): the furthest ahead a make's / a take's signed
     *  `validUntil` may be, in seconds. Optional so a page tolerates an older relay. */
    offerMaxLifetimeSeconds: z.number().int().optional(),
    takeMaxLifetimeSeconds: z.number().int().optional(),
  }),
  /** Security review F-B6 (AA 00047 questions Q13): true when the relay requires a SECOND signature
   *  (a Solana envelope over the whole body) for a shielded withdrawal that names a recipient
   *  encryption key. False by default: one wallet prompt per action. */
  withdrawRecipientEnvelope: z.boolean().optional(),
  /** AA 00060 P4.2 (spec FR-014): the relay's token list digest (./tokens/digest.ts). Optional so a page
   *  tolerates an older relay (it then has nothing to compare). */
  tokensDigest: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
});
export type PublicConfig = z.infer<typeof PublicConfigSchema>;
