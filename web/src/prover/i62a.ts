// AA 00062 P4.3: the page's copy of the I-62a wire shapes (plan "Interfaces", FROZEN 2026-10-06): the
// relay's `clientProving` advertisement, the job view's `clientProof` field, and the two hand-off
// routes. They are declared here, on the page's side, while the relay lane (P3) builds the relay's
// half against the same frozen text; plan P5.1 folds them into @nightmarket/core if P3 puts them there.

import { z } from 'zod';

import { JobViewSchema, type JobView } from '@nightmarket/core';

import { CLIENT_CIRCUITS, MAX_BASE64_CHARS } from './constants.js';

const HEX32 = /^[0-9a-f]{32}$/;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** `GET /v1/config` `clientProving` (I-62a "Advertising"): `{mode: "off"}`, or the required mode's pins. */
export const ClientProvingConfigSchema = z.union([
  z.object({
    mode: z.literal('required'),
    circuits: z.array(z.string()).max(16),
    keySet: z.string().max(80),
    proofServer: z.string().max(64),
    timeoutSeconds: z.number().int().positive(),
  }),
  z.object({ mode: z.literal('off') }),
]);
export type ClientProvingConfig = z.infer<typeof ClientProvingConfigSchema>;

export const CLIENT_PROVING_OFF: ClientProvingConfig = { mode: 'off' };

/** Read `clientProving` from a `/v1/config` body: absent (an older relay) or unreadable is "off". */
export function clientProvingOf(config: unknown): ClientProvingConfig {
  const raw = (config as { clientProving?: unknown } | null)?.clientProving;
  const parsed = ClientProvingConfigSchema.safeParse(raw);
  return parsed.success ? parsed.data : CLIENT_PROVING_OFF;
}

/** The job view's `clientProof` (present exactly while a hand-off is open). */
export const ClientProofViewSchema = z.object({
  proofId: z.string().regex(HEX32),
  circuit: z.string(),
  /** Unix seconds. */
  deadline: z.number().int(),
  attempt: z.number().int().positive(),
  fetched: z.boolean(),
});
export type ClientProofView = z.infer<typeof ClientProofViewSchema>;

/** `JobViewSchema` plus the hand-off field (a relay in `off` mode never sends it). */
export const HandOffJobViewSchema = JobViewSchema.extend({ clientProof: ClientProofViewSchema.optional() });
export type HandOffJobView = JobView & { clientProof?: ClientProofView };

/** `GET /v1/jobs/:requestId/client-proof` 200. */
export const ClientProofRequestSchema = z.object({
  proofId: z.string().regex(HEX32),
  circuit: z.enum(CLIENT_CIRCUITS),
  proofRequest: z.string().max(MAX_BASE64_CHARS).regex(BASE64_RE),
  keyMaterialOffset: z.number().int().nonnegative(),
  deadline: z.number().int(),
  attempt: z.number().int().positive(),
  keySet: z.string().max(80),
  proofServer: z.string().max(64),
});
export type ClientProofRequest = z.infer<typeof ClientProofRequestSchema>;

/** The hand-off routes (I-62a). */
export const clientProofPath = (requestId: string) => `/v1/jobs/${requestId}/client-proof`;

/** The relay's new stages (I-62a "The job view"), in the customer's words. */
export const CLIENT_PROOF_STAGE_WORDS: Record<string, string> = {
  'awaiting-client-proof': 'Waiting for your prover',
  'client-proof-fetched': 'Proving on your prover…',
  'client-proof-received': 'Your proof reached the market',
  'client-proof-checked': 'The market checked your proof',
};
