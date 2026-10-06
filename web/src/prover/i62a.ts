// AA 00062 P4.3: the I-62a wire shapes as the page reads them (plan "Interfaces", FROZEN 2026-10-06).
// The schemas are @nightmarket/core's (packages/core/src/client-proving.ts, built by the relay lane P3
// against the same frozen text); this file adds only what the page needs on top: reading
// `clientProving` from `/v1/config` ("absent or unreadable" is `off`, as for an older relay), the
// route, a page-side bound on the request's size, and the stages in the customer's words.

import { z } from 'zod';

import {
  API_PATHS,
  BASE64_PATTERN,
  ClientProofRequestSchema as CoreClientProofRequestSchema,
  ClientProvingConfigSchema,
  JobViewSchema,
  type ClientProofField,
  type ClientProvingConfig,
  type JobView,
} from '@nightmarket/core';

import { MAX_BASE64_CHARS } from './constants.js';

export type { ClientProvingConfig };

export const CLIENT_PROVING_OFF: ClientProvingConfig = { mode: 'off' };

/** Read `clientProving` from a `/v1/config` body: absent (an older relay, or `off`) or unreadable is "off". */
export function clientProvingOf(config: unknown): ClientProvingConfig {
  const raw = (config as { clientProving?: unknown } | null)?.clientProving;
  const parsed = ClientProvingConfigSchema.safeParse(raw);
  return parsed.success ? parsed.data : CLIENT_PROVING_OFF;
}

/** The job view's `clientProof` (present exactly while a hand-off is open). */
export type ClientProofView = ClientProofField;

/** The job view, with `clientProof` (core's `JobViewSchema` carries it since AA 00062 P3). */
export const HandOffJobViewSchema = JobViewSchema;
export type HandOffJobView = JobView;

/** `GET /v1/jobs/:requestId/client-proof` 200, with the page's own bound on the request's size. */
export const ClientProofRequestSchema = CoreClientProofRequestSchema.extend({
  proofRequest: z.string().max(MAX_BASE64_CHARS).regex(BASE64_PATTERN),
});
export type ClientProofRequest = z.infer<typeof ClientProofRequestSchema>;

/** The hand-off route (I-62a). */
export const clientProofPath = (requestId: string) => API_PATHS.clientProof(requestId);

/** The relay's new stages (I-62a "The job view"), in the customer's words. */
export const CLIENT_PROOF_STAGE_WORDS: Record<string, string> = {
  'awaiting-client-proof': 'Waiting for your prover',
  'client-proof-fetched': 'Proving on your prover…',
  'client-proof-received': 'Your proof reached the market',
  'client-proof-checked': 'The market checked your proof',
};
