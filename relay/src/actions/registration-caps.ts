// Registration caps (AA 00047 P9, audit C4 / F-A3). Opening an account deploys two waves and
// activates the device: about 60 s of the one prover lane and about 21 DUST of the sponsor's, and a
// Solana key costs nothing, so the per-minute rate limits alone let one client stall every customer
// and drain the sponsor. Four bounds, all configurable (deploy/RUNBOOK.md section 9):
//   - a GLOBAL cap: registrations admitted in any rolling 24 hours, across all clients;
//   - a PER-CLIENT cap: the same, per client address (the rate limits' key);
//   - a bounded share of the prover lane: at most `maxInFlight` registrations queued or running at
//     once, so any other action waits behind at most that many registrations (one, by default);
//   - a failure budget per owner and per account (./failure-budget.ts, every action).
//
// A registration is counted when it is ADMITTED (it will spend prover time and DUST whether or not
// it succeeds), and given back only when the route refuses it after admission (a full queue).
// The counters live in memory: a relay restart resets them (the RUNBOOK says so).

import type { AdmissionCheck } from './admission.js';

const DAY_SECONDS = 86_400;

export interface RegistrationCapsOptions {
  /** Registrations admitted in any rolling 24 hours, across all clients. */
  dailyCap: number;
  /** Registrations admitted in any rolling 24 hours from one client address. */
  perClientDailyCap: number;
  /** Registrations queued or running at once. */
  maxInFlight: number;
  now?: () => number;
}

export type RegistrationRefusal = {
  ok: false;
  status: 429 | 503;
  code: 'registration-daily-cap' | 'registration-client-cap' | 'registration-busy';
  reason: string;
  retryAfterSeconds: number;
};

export class RegistrationCaps {
  private readonly now: () => number;
  /** Admission times (Unix seconds), oldest first, of the last 24 hours. */
  private readonly all: number[] = [];
  private readonly byClient = new Map<string, number[]>();
  private inFlight = 0;

  constructor(private readonly o: RegistrationCapsOptions) {
    this.now = o.now ?? (() => Math.floor(Date.now() / 1000));
  }

  /** Registrations queued or running now. */
  get running(): number {
    return this.inFlight;
  }

  /** Registrations admitted in the last 24 hours (all clients, or one). */
  admittedToday(client?: string): number {
    this.sweep();
    return client === undefined ? this.all.length : (this.byClient.get(client)?.length ?? 0);
  }

  /**
   * Admit one registration from `client`, or say why not. Synchronous: two racing requests cannot
   * both take the last slot. On success, `release` gives everything back (the route refused the
   * request after all), and `finished` frees the in-flight slot when the job ends.
   */
  admit(client: string): { ok: true; release: () => void; finished: () => void } | RegistrationRefusal {
    this.sweep();
    const now = this.now();
    const mine = this.byClient.get(client) ?? [];
    if (this.all.length >= this.o.dailyCap) {
      return {
        ok: false,
        status: 429,
        code: 'registration-daily-cap',
        reason: "the market has opened today's maximum number of accounts; try again later",
        retryAfterSeconds: Math.max(1, this.all[0]! + DAY_SECONDS - now),
      };
    }
    if (mine.length >= this.o.perClientDailyCap) {
      return {
        ok: false,
        status: 429,
        code: 'registration-client-cap',
        reason: `this address has opened ${this.o.perClientDailyCap} accounts in the last 24 hours, the most the market allows`,
        retryAfterSeconds: Math.max(1, mine[0]! + DAY_SECONDS - now),
      };
    }
    if (this.inFlight >= this.o.maxInFlight) {
      return {
        ok: false,
        status: 503,
        code: 'registration-busy',
        reason: 'the market is opening another account right now; try again in a minute',
        retryAfterSeconds: 60,
      };
    }
    this.all.push(now);
    mine.push(now);
    this.byClient.set(client, mine);
    this.inFlight++;
    let released = false;
    let done = false;
    return {
      ok: true,
      release: () => {
        if (released || done) return;
        released = true;
        this.inFlight--;
        removeOne(this.all, now);
        const list = this.byClient.get(client);
        if (list) {
          removeOne(list, now);
          if (list.length === 0) this.byClient.delete(client);
        }
      },
      finished: () => {
        if (released || done) return;
        done = true;
        this.inFlight--;
      },
    };
  }

  private sweep(): void {
    const since = this.now() - DAY_SECONDS;
    while (this.all.length > 0 && this.all[0]! <= since) this.all.shift();
    for (const [client, list] of this.byClient) {
      while (list.length > 0 && list[0]! <= since) list.shift();
      if (list.length === 0) this.byClient.delete(client);
    }
  }
}

function removeOne(list: number[], value: number): void {
  const i = list.lastIndexOf(value);
  if (i !== -1) list.splice(i, 1);
}

/**
 * The `register` action's admission check over `caps`. The route calls the outcome's `finished` when
 * the job ends (success or failure), which frees its in-flight slot; `release` (a refusal after
 * admission) gives the daily counts back as well.
 */
export function registrationAdmission(caps: RegistrationCaps): AdmissionCheck {
  return async ({ client }) => {
    const r = caps.admit(client ?? 'unknown');
    if (!r.ok) return r;
    return { ok: true, release: r.release, finished: r.finished };
  };
}
