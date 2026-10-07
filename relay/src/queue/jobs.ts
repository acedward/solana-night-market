// The relay's job queue (plan P1.3). Jobs live in memory only (Q5: no per-user storage); the
// browser keeps the request id and resumes by polling GET /v1/jobs/:requestId.
//
// Three lanes:
//   - prover:  one job at a time across the relay. Every sponsor-paid call (register, withdraw,
//              append-inbox, take, cancel-offers, restore-enc-key, demo-tokens) holds it for its
//              whole run: the proof server proves one circuit at a time (a k=18 proof needs about
//              8 GB), and the one sponsor wallet balances one transaction at a time. AA 00062
//              (`CLIENT_PROVING=required`, I-62a v2 "prove first"): the k≥18 actions (take, withdraw,
//              withdraw-unshielded, append-inbox; open-swap already) run on their ACCOUNT's lane instead,
//              park while the user's prover proves (holding nothing else), and take the prover lane
//              through ctx.prove() only to finalize (../client-proving/prove-first.ts).
//   - account: one job at a time PER ACCOUNT, for long jobs that must not overlap on one account;
//   - relay:   one job at a time across the WHOLE relay, for long jobs that share one resource.
// A job on the account or relay lane holds it for its whole run and takes the prover lane only
// around its proofs, through ctx.prove(). `open-swap` runs there (AA 00047 P10, R2-1): it holds the
// prover only while it proves, not while the exchange lists the offer (up to 90 s).
//
// The prover lane is shared FAIRLY across accounts (AA 00047 P10, audit round 2 R2-1 / F-A2-1) and by
// DEADLINE and USAGE (P11.F, audit round 4 R4-1 / F-A4-1; ./prover-lock.ts): every job, and every
// ctx.prove() of an account- or relay-lane job, waits under its FAIR KEY (its account; a registration,
// which has none, under its action) and its RANK (./priority.ts: takes, then makes, which carry a
// signed deadline, then everything else; a lower rank still gets a turn after a few grants to higher
// ones). Within a rank the key with fewer recent grants goes first, and a job waits behind at most one
// job of each other key (with the route's one-job-per-account rule, ../actions/account-gate.ts: each
// other account). `estimateProverWaitSeconds` tells the route when a new job would start, so a take
// that would start too late is refused before it costs anything (../app.ts).
//
// When a job finishes, its payload (which can hold the coin it spends) is dropped at once; only
// the public outcome is kept, until the TTL.
//
// Capacity (security review F-B2): `maxJobs` bounds the jobs held in memory. Only queued and
// running jobs can fill it: when it is full, finished outcomes are dropped to make room (failed
// ones first, then succeeded ones, oldest first), so outcomes kept for their TTL never refuse new
// work. The relay answers "busy" only when `maxJobs` jobs are actually waiting or running.

import { randomBytes } from 'node:crypto';

import type { ClientProofField, JobActionName, JobLane, JobStage, JobState, JobView } from '@nightmarket/core';

import type { Logger } from '../log.js';
import { FifoLock } from './fifo-lock.js';
import { proverPriority } from './priority.js';
import { ProverLock, type ProverLockOptions, type ProverRank, type ProverTicket } from './prover-lock.js';

/** An error whose code and message may be shown to the customer. Anything else is reported as
 *  an internal error, and its details go to the (redacted) log only. */
export class PublicError extends Error {
  override name = 'PublicError';
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface JobContext {
  readonly requestId: string;
  readonly log: Logger;
  /** Record a stage with public details only (hashes, ids, heights). */
  stage(name: string, detail?: Record<string, string>): void;
  /** Run `fn` while holding the prover lane (re-entrant inside a prover-lane job). */
  prove<T>(fn: () => Promise<T>): Promise<T>;
}

export type JobExecutor = (payload: unknown, ctx: JobContext) => Promise<Record<string, unknown>>;

export interface JobSubmission {
  /** A route's action. */
  action: JobActionName;
  lane: JobLane;
  /** The account lane's account (64 hex); for the other lanes, the job's fair key on the prover. */
  account?: string;
  /** The key the job takes its turns on the prover lane under (default: its account; without one,
   *  its action). */
  fairKey?: string;
  payload: unknown;
  executor: JobExecutor;
}

interface JobRecord {
  requestId: string;
  action: JobActionName;
  lane: JobLane;
  laneKey: string;
  /** Its key on the prover lane. */
  fairKey: string;
  /** Its rank on the prover lane, and its signed deadline (./priority.ts). */
  rank: ProverRank;
  deadline?: number;
  /** A running account- or relay-lane job waiting for the prover inside ctx.prove(). */
  waitingForProver: boolean;
  state: JobState;
  stages: JobStage[];
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  payload: unknown;
  executor: JobExecutor | null;
  result?: Record<string, unknown>;
  error?: { code: string; message: string };
  settled: Promise<void>;
}

/** AA 00062 (I-62a v2): the client-proof tickets (../client-proving/desk.ts), when the relay runs with
 *  `CLIENT_PROVING=required`. */
export interface ClientProofHooks {
  /** The job view's `clientProof` while its ticket is open. */
  view(requestId: string): ClientProofField | undefined;
  /** The job's terminal client-proof failure: it becomes the job's error (it may surface through the
   *  ledger and midnight-js as another error). */
  failureOf(requestId: string): PublicError | undefined;
  /** The job ended: an open ticket is abandoned and its request dropped. */
  jobEnded(requestId: string): void;
}

export interface QueueStats {
  jobs: number;
  lanes: Record<JobLane, { running: number; waiting: number }>;
}

export interface JobQueueOptions {
  ttlSeconds: number;
  maxJobs: number;
  log: Logger;
  now?: () => number;
  /** Milliseconds now, for the prover lane's usage window and expected holds (tests scale it). */
  nowMs?: () => number;
  /** The prover lane's scheduling (./prover-lock.ts; RUNBOOK section 9). */
  prover?: Omit<ProverLockOptions, 'nowMs'>;
}

export class JobQueue {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly prover: ProverLock;
  private readonly relayLane = new FifoLock();
  private readonly accounts = new Map<string, FifoLock>();
  private readonly now: () => number;
  private clientProofs: ClientProofHooks | null = null;

  constructor(private readonly options: JobQueueOptions) {
    const nowMs = options.nowMs ?? (options.now ? () => options.now!() * 1000 : Date.now);
    this.now = options.now ?? (() => Math.floor(nowMs() / 1000));
    this.prover = new ProverLock({ ...options.prover, nowMs });
  }

  /** A submission's fair key on the prover lane. */
  private static fairKeyOf(sub: Pick<JobSubmission, 'action' | 'account' | 'fairKey'>): string {
    const account = sub.account?.replace(/^0x/, '').toLowerCase();
    return sub.fairKey ?? (account ? `account:${account}` : `action:${sub.action}`);
  }

  /**
   * About how many seconds until a job like `sub`, submitted now, would START on the prover lane (it
   * waits for the jobs ahead of it in the lane's order: ./prover-lock.ts `estimateWaitMs`). The route
   * refuses a take that would start after its signed deadline (AA 00047 P11.F, R4-1).
   */
  estimateProverWaitSeconds(sub: Pick<JobSubmission, 'action' | 'account' | 'fairKey' | 'payload'>): number {
    const p = proverPriority(sub.action, sub.payload);
    const ms = this.prover.estimateWaitMs({
      key: JobQueue.fairKeyOf(sub),
      rank: p.rank,
      ...(p.deadline !== undefined ? { deadline: p.deadline } : {}),
      action: sub.action,
    });
    return Math.ceil(ms / 1000);
  }

  /** Queue a job; null when `maxJobs` jobs are already queued or running (finished outcomes are
   *  dropped to make room, see the header). */
  submit(sub: JobSubmission): JobView | null {
    if (this.jobs.size >= this.options.maxJobs) this.sweep();
    if (this.jobs.size >= this.options.maxJobs) this.evictFinished(this.jobs.size - this.options.maxJobs + 1);
    if (this.jobs.size >= this.options.maxJobs) return null;
    if (sub.lane === 'account' && !sub.account) throw new Error('an account-lane job needs its account');
    const requestId = randomBytes(16).toString('hex');
    const now = this.now();
    let settle!: () => void;
    const account = sub.account?.replace(/^0x/, '').toLowerCase();
    const priority = proverPriority(sub.action, sub.payload);
    const rec: JobRecord = {
      requestId,
      action: sub.action,
      lane: sub.lane,
      laneKey: sub.lane === 'account' ? `account:${account!}` : sub.lane,
      fairKey: JobQueue.fairKeyOf(sub),
      rank: priority.rank,
      ...(priority.deadline !== undefined ? { deadline: priority.deadline } : {}),
      waitingForProver: false,
      state: 'queued',
      stages: [{ stage: 'queued', at: now }],
      createdAt: now,
      updatedAt: now,
      expiresAt: now + this.options.ttlSeconds,
      payload: sub.payload,
      executor: sub.executor,
      settled: new Promise((r) => (settle = r)),
    };
    this.jobs.set(requestId, rec);
    void this.run(rec).finally(settle);
    return this.view(rec);
  }

  /** AA 00062: attach the client-proof tickets (`CLIENT_PROVING=required`; main.ts). */
  useClientProofs(hooks: ClientProofHooks): void {
    this.clientProofs = hooks;
  }

  /** Record a stage on a RUNNING job from outside its executor (the client-proof ticket); a no-op for
   *  any other job. */
  recordStage(requestId: string, name: string, detail?: Record<string, string>): void {
    const rec = this.jobs.get(requestId);
    if (rec && rec.state === 'running') this.stage(rec, name, detail);
  }

  get(requestId: string): JobView | undefined {
    const rec = this.jobs.get(requestId);
    if (!rec) return undefined;
    if (rec.state !== 'queued' && rec.state !== 'running' && rec.expiresAt <= this.now()) {
      this.jobs.delete(requestId);
      return undefined;
    }
    return this.view(rec);
  }

  /** Resolves when the job has finished (tests and shutdown). */
  async settled(requestId: string): Promise<JobView | undefined> {
    await this.jobs.get(requestId)?.settled;
    return this.get(requestId);
  }

  stats(): QueueStats {
    let accRunning = 0;
    let accWaiting = 0;
    for (const lock of this.accounts.values()) {
      accRunning += lock.running;
      accWaiting += lock.waiting;
    }
    return {
      jobs: this.jobs.size,
      lanes: {
        prover: { running: this.prover.running, waiting: this.prover.waiting },
        account: { running: accRunning, waiting: accWaiting },
        relay: { running: this.relayLane.running, waiting: this.relayLane.waiting },
      },
    };
  }

  /** The jobs holding and waiting for one lane (the account lane is per account). */
  laneLoad(lane: JobLane, account?: string): { running: number; waiting: number } {
    const lock =
      lane === 'prover'
        ? this.prover
        : lane === 'relay'
          ? this.relayLane
          : this.accounts.get(`account:${(account ?? '').replace(/^0x/, '').toLowerCase()}`);
    return lock ? { running: lock.running, waiting: lock.waiting } : { running: 0, waiting: 0 };
  }

  /** Forget finished jobs past their TTL. Queued and running jobs are never dropped. */
  sweep(): void {
    const now = this.now();
    for (const [id, rec] of this.jobs) {
      if ((rec.state === 'succeeded' || rec.state === 'failed') && rec.expiresAt <= now) this.jobs.delete(id);
    }
  }

  /** Drop up to `count` finished outcomes before their TTL: failed ones first, then succeeded
   *  ones, oldest first (security review F-B2). Queued and running jobs are never dropped. */
  private evictFinished(count: number): void {
    let dropped = 0;
    for (const state of ['failed', 'succeeded'] as const) {
      for (const [id, rec] of this.jobs) {
        if (dropped >= count) break;
        if (rec.state !== state) continue;
        this.jobs.delete(id);
        dropped++;
      }
    }
    if (dropped > 0) this.options.log.warn('job outcomes dropped before their TTL to make room', { dropped });
  }

  private laneLock(rec: JobRecord): ProverLock | FifoLock {
    if (rec.lane === 'prover') return this.prover;
    if (rec.lane === 'relay') return this.relayLane;
    let lock = this.accounts.get(rec.laneKey);
    if (!lock) {
      lock = new FifoLock();
      this.accounts.set(rec.laneKey, lock);
    }
    return lock;
  }

  private stage(rec: JobRecord, name: string, detail?: Record<string, string>): void {
    const at = this.now();
    rec.stages.push(detail ? { stage: name, at, detail } : { stage: name, at });
    rec.updatedAt = at;
  }

  private async run(rec: JobRecord): Promise<void> {
    const log = this.options.log.child({ requestId: rec.requestId, action: rec.action, lane: rec.lane });
    const lane = this.laneLock(rec);
    const ticket: ProverTicket = {
      id: rec.requestId,
      key: rec.fairKey,
      rank: rec.rank,
      ...(rec.deadline !== undefined ? { deadline: rec.deadline } : {}),
      action: rec.action,
    };
    const releaseLane = lane instanceof ProverLock ? await lane.acquire(ticket) : await lane.acquire(rec.requestId);
    let holdsProver = rec.lane === 'prover';
    rec.state = 'running';
    this.stage(rec, 'running');
    // AA 00062: a failed client-proof ticket is the job's error, whatever error it surfaced as (the
    // ledger's WASM, midnight-js and Passport's offer builder may wrap it).
    const clientProofFailure = (e: unknown): unknown => this.clientProofs?.failureOf(rec.requestId) ?? e;
    const ctx: JobContext = {
      requestId: rec.requestId,
      log,
      stage: (name, detail) => this.stage(rec, name, detail),
      prove: async <T>(fn: () => Promise<T>): Promise<T> => {
        if (holdsProver) {
          if (!this.clientProofs) return fn();
          try {
            return await fn();
          } catch (e) {
            throw clientProofFailure(e);
          }
        }
        this.stage(rec, 'waiting-for-prover');
        rec.waitingForProver = true;
        const release = await this.prover.acquire(ticket);
        rec.waitingForProver = false;
        holdsProver = true;
        try {
          this.stage(rec, 'proving');
          return await fn();
        } catch (e) {
          throw clientProofFailure(e);
        } finally {
          holdsProver = false;
          release();
        }
      },
    };
    try {
      const executor = rec.executor;
      if (!executor) throw new Error('job has no executor');
      rec.result = await executor(rec.payload, ctx);
      rec.state = 'succeeded';
      this.stage(rec, 'succeeded');
      log.info('job succeeded');
    } catch (caught) {
      const e = clientProofFailure(caught);
      rec.state = 'failed';
      rec.error =
        e instanceof PublicError
          ? { code: e.code, message: e.message }
          : { code: 'internal-error', message: 'the relay could not complete this request' };
      this.stage(rec, 'failed');
      log.warn('job failed', { error: e });
    } finally {
      this.clientProofs?.jobEnded(rec.requestId);
      rec.payload = undefined;
      rec.executor = null;
      rec.expiresAt = this.now() + this.options.ttlSeconds;
      releaseLane();
      if (rec.lane === 'account' && lane.idle) this.accounts.delete(rec.laneKey);
    }
  }

  private view(rec: JobRecord): JobView {
    // A queued job's place in its lane; a running account-lane job waiting inside ctx.prove(), its
    // place on the prover lane.
    const position =
      rec.state === 'queued'
        ? this.laneLock(rec).position(rec.requestId)
        : rec.waitingForProver
          ? this.prover.position(rec.requestId)
          : undefined;
    const last = rec.stages[rec.stages.length - 1];
    const clientProof = rec.state === 'running' ? this.clientProofs?.view(rec.requestId) : undefined;
    return {
      requestId: rec.requestId,
      action: rec.action,
      lane: rec.lane,
      state: rec.state,
      stage: last?.stage ?? rec.state,
      stages: rec.stages.map((s) => ({ ...s, ...(s.detail ? { detail: { ...s.detail } } : {}) })),
      ...(position !== undefined && position > 0 ? { position } : {}),
      createdAt: rec.createdAt,
      updatedAt: rec.updatedAt,
      expiresAt: rec.expiresAt,
      ...(rec.result ? { result: { ...rec.result } } : {}),
      ...(rec.error ? { error: { ...rec.error } } : {}),
      ...(clientProof ? { clientProof } : {}),
    };
  }
}
