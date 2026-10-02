// A job's place class on the prover lane (AA 00047 P11.F, audit round 4 R4-1 / F-A4-1; ./prover-lock.ts).
//
// A take and a make each carry the deadline their device SIGNED (`validUntil`, Unix seconds; the
// circuit refuses the call after it, packages/core/src/offer-expiry.ts): a take must start within a few
// minutes, a make within the hour. Every other job can wait without failing. So takes go first, then
// makes, then the rest.

import type { JobActionName } from '@nightmarket/core';

import type { ProverRank } from './prover-lock.js';

export interface ProverPriority {
  rank: ProverRank;
  /** The signed deadline (Unix seconds), for a take or a make that names one. */
  deadline?: number;
}

/** The actions whose calls carry a signed deadline, and their rank. */
export const DEADLINE_RANKS: Partial<Record<JobActionName, ProverRank>> = { take: 0, 'open-swap': 1 };

/** The prover-lane rank and signed deadline of a job, from its action and payload. */
export function proverPriority(action: JobActionName, payload: unknown): ProverPriority {
  const rank = DEADLINE_RANKS[action] ?? 2;
  if (rank === 2) return { rank };
  const v = (payload as { validUntil?: unknown } | null | undefined)?.validUntil;
  const deadline = typeof v === 'string' && /^[0-9]{1,15}$/.test(v) ? Number(v) : undefined;
  return deadline !== undefined && deadline > 0 ? { rank, deadline } : { rank };
}
