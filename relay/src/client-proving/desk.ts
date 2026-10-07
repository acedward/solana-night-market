// The client-proof desk (AA 00062, interface I-62a v2, "prove first"), in `CLIENT_PROVING=required` mode.
//
// TICKETS. A k≥18 action's job prepares its call (./prove-first.ts: built and captured, nothing proven)
// and PARKS on a ticket here (`park`), holding only its account's one-job slot: no prover lane and no
// sponsor wallet. The page fetches the proof request (`GET /v1/jobs/:requestId/client-proof`), its prover
// proves it, and the page posts the proof back (`POST …`). The desk then FINALIZES the ticket, in order:
// the id, the size and tag, the check (`ClientProofVerifier.verify`, ./verifier.ts), the deadline, and the
// account's state unchanged since prepare (the ticket's `fresh`: `round` and `auth_nonce`, and for a take
// its maker's offer still live). Only then does it answer 200 and resume the parked job with the proof,
// which finalizes the call under the prover lane and hands it over (posts, settles or submits it).
//
// ONE TICKET PER JOB, ONE PROOF PER TICKET (`attempt` is always 1). A DUST race at finalize re-balances with
// the same proof: no second ticket ever opens. After a terminal failure (`client-proof-missing`, `-late`,
// `-invalid`, `-stale`) the job ends.
//
// THE DEADLINE: min(prepared + CLIENT_PROOF_TIMEOUT_SECONDS, intent TTL − 60 s, signed deadline − 60 s).
// The signed deadline is a make's or a take's `validUntil`; withdrawals and filings have none (their intent
// lives one hour). With less than 30 s left at prepare the job fails `client-proof-late` at once and
// nothing is handed out. When it passes: never fetched → `client-proof-missing`, fetched → `-late`.
//
// STALE CALLS. A call reads its account's `round` and `auth_nonce` by value. When either moved since prepare
// (a deposit, demo tokens, a take of the account's own offer, another gated call), or a take's maker offer
// is gone, the POST answers 409 `client-proof-stale` and the job fails with it: nothing was submitted, no
// DUST was spent, and the page may send the same signed request again (a new ticket, one more proof). A
// stale call the check misses is refused by the node at the mempool (code 104, `ReadMismatch`); the
// sponsored finalize maps it here (`submissionRefused`) to the same code, and never retries it.
//
// A PROOF THE NETWORK REFUSES (research R1/R3). With a verifier in place a bad proof never reaches the
// network. Should one still be refused at submission as an invalid proof (node codes 115 `InvalidProof`,
// 179 `UnsupportedProofVersion`), `submissionRefused` turns the failure into `client-proof-invalid`, and
// the sponsor wallet's pending spend is reverted (../passport/wallet-provider.ts).
//
// PRIVACY. A proof request carries the call's private inputs (coins, amounts): it is never logged, served
// only to the job's poller with `Cache-Control: no-store` (../app.ts), and dropped from memory as soon as
// its ticket ends. Tickets live in memory only: a relay restart drops them with their jobs. The relay never
// calls a URL a user gave it: the page alone talks to the user's prover (spec FR-003); nothing here makes
// any network request (the ticket's `fresh` is the executor's indexer and exchange read).

import { randomBytes } from 'node:crypto';

import {
  CLIENT_PROOF_MAX_BYTES,
  CLIENT_PROOF_MIN_WINDOW_SECONDS,
  CLIENT_PROOF_REQUEST_MAX_BYTES,
  CLIENT_PROOF_SETTLE_MARGIN_SECONDS,
  CLIENT_PROVEN_CIRCUITS,
  PROOF_REQUEST_TAG,
  PROOF_TAG,
  type ClientProofField,
  type ClientProofRequest,
  type ClientProofSubmission,
  type ClientProvenCircuit,
  type ClientProvingConfig,
  type JobActionName,
  type JobView,
  isClientProvenCircuit,
} from '@nightmarket/core';

import type { Logger } from '../log.js';
import { PublicError } from '../queue/jobs.js';
import type { ClientProofVerifier } from './verifier.js';

/** What the desk needs of the job queue. */
export interface ClientProofJobs {
  /** Record a stage (public details only) on a running job. */
  recordStage(requestId: string, name: string, detail?: Record<string, string>): void;
  /** A job's public view; undefined when there is no such job. */
  get(requestId: string): JobView | undefined;
}

/** The staleness check's answer. */
export type FreshVerdict = { ok: true } | { ok: false; reason: string };

/** What a parking job hands the desk: its prepared call's proof request and how to check it is fresh. */
export interface TicketRequest {
  /** The job's request id (its `ctx.requestId`). */
  requestId: string;
  action: JobActionName;
  circuit: string;
  /** The ledger's key-less `/prove` body: `createProvingPayload(preimage, bindingInput)`. */
  proofRequest: Uint8Array;
  /** The index of the key material's `None` (`0x00`) in `proofRequest`. */
  keyMaterialOffset: number;
  /** The pinned verifier key the key location names (its sha256 is the location's `?vk=`). */
  verifierKey: Uint8Array;
  /** Unix seconds: the call's intent TTL (null: unknown). */
  intentTtl: number | null;
  /** Unix seconds: a make's or a take's signed `validUntil`. */
  signedDeadline?: number;
  /** The account's state unchanged since prepare (and a take's offer still live). Throws when it cannot
   *  be read. */
  fresh: () => Promise<FreshVerdict>;
}

export interface ClientProofDeskOptions {
  jobs: ClientProofJobs;
  /** The check (questions Q3). Production: the built-in verifier; tests: a double, injected here only. */
  verifier: ClientProofVerifier;
  /** CLIENT_PROOF_TIMEOUT_SECONDS. */
  timeoutSeconds: number;
  /** The key set's fingerprint (64 hex) and the proof server version the user's prover must match. */
  keySet: string;
  proofServer: string;
  log: Logger;
  /** Unix seconds now (tests move it). */
  now?: () => number;
  /** Run `fn` after `ms` (tests replace it); returns a cancel. */
  schedule?: (fn: () => void, ms: number) => () => void;
  /** Ended jobs whose ticket history is kept to answer late posts (oldest dropped first). */
  maxEndedJobs?: number;
}

type TicketStatus = 'open' | 'received' | 'checked' | 'missing' | 'late' | 'invalid' | 'stale' | 'abandoned';

interface Ticket {
  proofId: string;
  circuit: ClientProvenCircuit;
  deadline: number;
  fetched: boolean;
  status: TicketStatus;
  /** Dropped (null) as soon as the ticket ends. */
  proofRequest: Uint8Array | null;
  keyMaterialOffset: number;
  verifierKey: Uint8Array | null;
  fresh: (() => Promise<FreshVerdict>) | null;
  settle: { resolve(proof: Uint8Array): void; reject(e: Error): void } | null;
  cancelTimer: (() => void) | null;
}

interface JobTicket {
  ticket: Ticket | null;
  /** The job's terminal client-proof failure: no ticket opens after it, and it is the job's error. */
  failure: PublicError | null;
  ended: boolean;
}

export type ServeOutcome = { ok: true; body: ClientProofRequest } | { ok: false; code: 'not-awaiting-client-proof' };

export type SubmitOutcome =
  | { ok: true; job: JobView }
  | {
      ok: false;
      status: 409 | 410 | 422 | 503;
      code:
        | 'client-proof-wrong-id'
        | 'client-proof-already-received'
        | 'client-proof-late'
        | 'client-proof-invalid'
        | 'client-proof-stale'
        | 'market-unavailable';
      message: string;
    };

const MESSAGES = {
  missing:
    'your proof server did not pick up this proof request before its deadline. Nothing was sent and no fee was spent; check that your proof server is running, then try again',
  late: 'the proof from your proof server did not arrive before its deadline. Nothing was sent and no fee was spent; try again (a faster machine, or one with more free memory, helps)',
  lateAtOpening:
    "there was not enough time left before this action's deadline for your proof server to prove it. Nothing was sent and no fee was spent; sign it again",
  invalid:
    'your proof server returned an invalid proof. Nothing was sent and no fee was spent; check that it runs the Night Market prover package for this key set, then try again',
  refusedByNetwork:
    'the network refused the proof your proof server returned. Nothing was paid; check that it runs the Night Market prover package for this key set, then try again',
  stale:
    'your account changed while your proof server was proving (for example a deposit or a trade landed), so this proof no longer fits it. Nothing was sent and no fee was spent; send the same request again and your proof server proves it once more',
  unreadable:
    'the market could not read your account on Midnight to finish this action right now. Nothing was sent and it does not count against you; try again shortly',
  verifierFailed:
    "the market could not check your proof server's proof right now. Nothing was sent and it does not count against you; try again shortly",
} as const;

/** Node errors that mean "the proof is invalid" (midnight-node `ledger/src/versions/common/types.rs`:
 *  115 `MalformedError::InvalidProof`, 179 `MalformedError::UnsupportedProofVersion`). */
const PROOF_REFUSAL = /\bCustom error: (?:115|179)\b|MalformedError::(?:InvalidProof|UnsupportedProofVersion)\b/;
/** The node error that means "the call read state that has moved" (R6: `guaranteed execution would fail:
 *  Transcript(Execution(ReadMismatch …))`, the RPC's `Invalid Transaction: Custom error: 104`). */
const STALE_REFUSAL = /\bCustom error: 104\b|\bReadMismatch\b/;

const ascii = (s: string) => Uint8Array.from(Buffer.from(s, 'ascii'));
const REQUEST_TAG_BYTES = ascii(PROOF_REQUEST_TAG);
const PROOF_TAG_BYTES = ascii(PROOF_TAG);
const startsWith = (b: Uint8Array, prefix: Uint8Array) =>
  b.length >= prefix.length && prefix.every((x, i) => b[i] === x);

/** The texts of an error and its causes (a submission error nests the node's answer). */
function errorTexts(error: unknown): string[] {
  const out: string[] = [];
  let e: unknown = error;
  for (let depth = 0; depth < 8 && e !== undefined && e !== null; depth++) {
    const o = e as { message?: unknown; cause?: unknown };
    if (typeof o.message === 'string') out.push(o.message);
    try {
      out.push(String(e));
    } catch {
      // an object without a usable toString
    }
    e = typeof e === 'object' ? o.cause : undefined;
  }
  return out;
}

/** Whether a submission failure is the network refusing a proof as invalid. */
export function isProofRefusal(error: unknown): boolean {
  return errorTexts(error).some((t) => PROOF_REFUSAL.test(t));
}

/** Whether a submission failure is the node refusing a stale call (code 104, `ReadMismatch`). */
export function isStaleRefusal(error: unknown): boolean {
  return errorTexts(error).some((t) => STALE_REFUSAL.test(t));
}

export class ClientProofDesk {
  private readonly jobs = new Map<string, JobTicket>();
  private readonly now: () => number;
  private readonly schedule: (fn: () => void, ms: number) => () => void;
  private readonly maxEnded: number;

  constructor(private readonly o: ClientProofDeskOptions) {
    this.now = o.now ?? (() => Math.floor(Date.now() / 1000));
    this.schedule =
      o.schedule ??
      ((fn, ms) => {
        const t = setTimeout(fn, ms);
        (t as { unref?: () => void }).unref?.();
        return () => clearTimeout(t);
      });
    this.maxEnded = o.maxEndedJobs ?? 10_000;
  }

  /** The circuits the user's prover proves. */
  get circuits(): ReadonlySet<string> {
    return new Set<string>(CLIENT_PROVEN_CIRCUITS);
  }

  /** `/v1/config`'s `clientProving`. */
  config(): ClientProvingConfig {
    return {
      mode: 'required',
      circuits: [...CLIENT_PROVEN_CIRCUITS],
      keySet: this.o.keySet,
      proofServer: this.o.proofServer,
      timeoutSeconds: this.o.timeoutSeconds,
    };
  }

  // ── prepare's end: the parked job ──────────────────────────────────────────

  /**
   * Open the job's ticket and wait for its proof: resolves with the proof once it has been checked and
   * the account found unchanged (I-62a v2). Rejects with the job's `client-proof-*` PublicError when the
   * proof is missing, late, invalid or stale, and with an internal error when the request cannot be handed
   * out (a second ticket for the job, a request that is not a key-less /prove body): nothing is handed out
   * then. The parked job holds nothing of the relay's while it waits.
   */
  park(req: TicketRequest): Promise<Uint8Array> {
    if (!isClientProvenCircuit(req.circuit)) throw new Error(`${req.circuit} is not proven by the client`);
    const { proofRequest, keyMaterialOffset } = req;
    if (
      proofRequest.length > CLIENT_PROOF_REQUEST_MAX_BYTES ||
      !startsWith(proofRequest, REQUEST_TAG_BYTES) ||
      !Number.isInteger(keyMaterialOffset) ||
      keyMaterialOffset < REQUEST_TAG_BYTES.length ||
      keyMaterialOffset >= proofRequest.length ||
      proofRequest[keyMaterialOffset] !== 0
    ) {
      throw new Error('the proof request is not a key-less /prove body within the ticket limits');
    }
    const id = req.requestId;
    let job = this.jobs.get(id);
    if (!job) {
      job = { ticket: null, failure: null, ended: false };
      this.jobs.set(id, job);
    }
    if (job.failure) return Promise.reject(job.failure);
    if (job.ended) throw new Error('a client proof was asked for by a job that has ended');
    if (job.ticket) throw new Error('a job asked for a second client proof (one ticket per job)');

    const now = this.now();
    let deadline = now + this.o.timeoutSeconds;
    if (req.signedDeadline !== undefined) {
      deadline = Math.min(deadline, req.signedDeadline - CLIENT_PROOF_SETTLE_MARGIN_SECONDS);
    }
    if (req.intentTtl !== null) deadline = Math.min(deadline, req.intentTtl - CLIENT_PROOF_SETTLE_MARGIN_SECONDS);
    if (deadline - now < CLIENT_PROOF_MIN_WINDOW_SECONDS) {
      job.failure = new PublicError('client-proof-late', MESSAGES.lateAtOpening);
      this.o.log.info('client proof refused at prepare: too little time left', {
        requestId: id,
        circuit: req.circuit,
        secondsLeft: deadline - now,
      });
      return Promise.reject(job.failure);
    }

    const t: Ticket = {
      proofId: randomBytes(16).toString('hex'),
      circuit: req.circuit,
      deadline,
      fetched: false,
      status: 'open',
      proofRequest: Uint8Array.from(proofRequest),
      keyMaterialOffset,
      verifierKey: Uint8Array.from(req.verifierKey),
      fresh: req.fresh,
      settle: null,
      cancelTimer: null,
    };
    const promise = new Promise<Uint8Array>((resolve, reject) => {
      t.settle = { resolve, reject };
    });
    job.ticket = t;
    const owner = job;
    t.cancelTimer = this.schedule(() => this.expire(owner, t), Math.max(0, (deadline - now) * 1000));
    this.o.jobs.recordStage(id, 'awaiting-client-proof', { circuit: t.circuit, proofId: t.proofId, attempt: '1' });
    this.o.log.info('client proof requested (the job is parked, holding nothing)', {
      requestId: id,
      action: req.action,
      circuit: t.circuit,
      secondsToDeadline: deadline - now,
      requestBytes: proofRequest.length,
    });
    return promise;
  }

  // ── the routes ────────────────────────────────────────────────────────────

  /** `GET /v1/jobs/:requestId/client-proof` (the route has checked the job exists): the open ticket's
   *  request; the first call marks it fetched. */
  serveRequest(requestId: string): ServeOutcome {
    const job = this.jobs.get(requestId);
    const t = job ? this.open(job) : undefined;
    if (!job || !t) return { ok: false, code: 'not-awaiting-client-proof' };
    if (this.now() >= t.deadline) {
      this.expire(job, t);
      return { ok: false, code: 'not-awaiting-client-proof' };
    }
    if (!t.fetched) {
      t.fetched = true;
      this.o.jobs.recordStage(requestId, 'client-proof-fetched', { proofId: t.proofId });
      this.o.log.info('client proof request fetched', { requestId });
    }
    return {
      ok: true,
      body: {
        proofId: t.proofId,
        circuit: t.circuit,
        proofRequest: Buffer.from(t.proofRequest!).toString('base64'),
        keyMaterialOffset: t.keyMaterialOffset,
        deadline: t.deadline,
        attempt: 1,
        keySet: this.o.keySet,
        proofServer: this.o.proofServer,
      },
    };
  }

  /** `POST /v1/jobs/:requestId/client-proof` (the route has checked the body's shape and the job):
   *  FINALIZE's checks, in I-62a v2's order. */
  async submit(requestId: string, body: ClientProofSubmission): Promise<SubmitOutcome> {
    const job = this.jobs.get(requestId);
    const t = job?.ticket;
    const wrongId = {
      ok: false,
      status: 409,
      code: 'client-proof-wrong-id',
      message: 'this proof is not for the proof request this job is waiting for',
    } as const;
    const late = {
      ok: false,
      status: 410,
      code: 'client-proof-late',
      message: 'this proof arrived after its deadline (or after the action ended) and was ignored',
    } as const;
    if (!job || !t || t.proofId !== body.proofId) return wrongId;
    // 1. The ticket is open (its deadline not passed).
    if (t.status === 'open' && this.now() >= t.deadline) this.expire(job, t);
    switch (t.status) {
      case 'open':
        break;
      case 'received':
      case 'checked':
      case 'invalid':
      case 'stale':
        return {
          ok: false,
          status: 409,
          code: 'client-proof-already-received',
          message: 'a proof for this request was already received; each request takes exactly one',
        };
      case 'missing':
      case 'late':
      case 'abandoned':
        return late;
    }

    // From here the ticket has its one proof: a second post is refused, whatever this one's verdict.
    t.status = 'received';
    t.cancelTimer?.();
    t.cancelTimer = null;
    this.o.jobs.recordStage(requestId, 'client-proof-received', { proofId: t.proofId });
    const proof = Uint8Array.from(Buffer.from(body.proof, 'base64'));
    const t0 = Date.now();
    // 2. The size and the tag; 3. the check.
    let verdict: { ok: true } | { ok: false; reason: string };
    if (proof.length === 0 || proof.length > CLIENT_PROOF_MAX_BYTES || !startsWith(proof, PROOF_TAG_BYTES)) {
      verdict = { ok: false, reason: `not a proof (${proof.length} bytes, or not tagged ${PROOF_TAG})` };
    } else {
      try {
        verdict = await this.o.verifier.verify({
          circuit: t.circuit,
          proofRequest: t.proofRequest!,
          proof,
          verifierKey: t.verifierKey!,
        });
      } catch (e) {
        // The relay could not check it: the market's failure, never the requester's (not charged).
        const failure = new PublicError('market-unavailable', MESSAGES.verifierFailed);
        this.o.log.warn('the client-proof verifier failed', { requestId, error: e });
        this.fail(job, t, 'invalid', failure);
        return { ok: false, status: 503, code: 'market-unavailable', message: failure.message };
      }
    }
    // The job ended while the proof was being checked (it cannot use it any more).
    if ((t.status as TicketStatus) !== 'received') return late;
    if (!verdict.ok) {
      const failure = new PublicError('client-proof-invalid', MESSAGES.invalid);
      this.o.log.info('client proof refused', {
        requestId,
        circuit: t.circuit,
        reason: verdict.reason,
        proofBytes: proof.length,
      });
      this.fail(job, t, 'invalid', failure);
      return { ok: false, status: 422, code: 'client-proof-invalid', message: failure.message };
    }
    const checkMs = Date.now() - t0;
    // 4. The deadline, again after the check.
    if (this.now() >= t.deadline) {
      this.o.log.info('client proof late (its deadline passed during the check)', { requestId, circuit: t.circuit });
      this.fail(job, t, 'late', new PublicError('client-proof-late', MESSAGES.late));
      return late;
    }
    // 5. Staleness: the account unchanged since prepare (and a take's offer still live).
    let fresh: FreshVerdict;
    try {
      fresh = await t.fresh!();
    } catch (e) {
      const failure = new PublicError('market-unavailable', MESSAGES.unreadable);
      this.o.log.warn('the staleness check could not read the chain', { requestId, error: e });
      if ((t.status as TicketStatus) !== 'received') return late;
      this.fail(job, t, 'invalid', failure);
      return { ok: false, status: 503, code: 'market-unavailable', message: failure.message };
    }
    if ((t.status as TicketStatus) !== 'received') return late;
    if (!fresh.ok) {
      const failure = this.staleFailure(requestId, fresh.reason);
      this.fail(job, t, 'stale', failure);
      return { ok: false, status: 409, code: 'client-proof-stale', message: failure.message };
    }
    // Checked and fresh: the stage is recorded and the view taken BEFORE the job resumes (on a later
    // tick), so the answer shows `client-proof-checked`.
    t.status = 'checked';
    this.o.jobs.recordStage(requestId, 'client-proof-checked', { proofId: t.proofId });
    const settle = t.settle;
    this.drop(t);
    const view = this.o.jobs.get(requestId);
    this.o.log.info('client proof checked; the job resumes', {
      requestId,
      circuit: t.circuit,
      checkMs,
      proofBytes: proof.length,
    });
    settle?.resolve(proof);
    if (!view) return wrongId;
    return { ok: true, job: view };
  }

  // ── the job queue's hooks ────────────────────────────────────────────────

  /** The job view's `clientProof`: only while the ticket is open. */
  view(requestId: string): ClientProofField | undefined {
    const job = this.jobs.get(requestId);
    const t = job ? this.open(job) : undefined;
    if (!t) return undefined;
    return { proofId: t.proofId, circuit: t.circuit, deadline: t.deadline, attempt: 1, fetched: t.fetched };
  }

  /** The job's terminal client-proof failure, if any: the job's error, whatever error it surfaced as. */
  failureOf(requestId: string): PublicError | undefined {
    return this.jobs.get(requestId)?.failure ?? undefined;
  }

  /** The job ended (whatever its outcome): an open ticket is abandoned, every request dropped. */
  jobEnded(requestId: string): void {
    const job = this.jobs.get(requestId);
    if (!job) return;
    job.ended = true;
    const t = job.ticket;
    if (t && (t.status === 'open' || t.status === 'received')) {
      t.status = 'abandoned';
      const settle = t.settle;
      this.drop(t);
      settle?.reject(new Error('the job ended before its client proof'));
    } else if (t) {
      this.drop(t);
    }
    // Re-insert: the map's order is the order jobs ended in; keep a bounded history for late posts.
    this.jobs.delete(requestId);
    this.jobs.set(requestId, job);
    let ended = 0;
    for (const j of this.jobs.values()) if (j.ended) ended++;
    for (const [id, j] of this.jobs) {
      if (ended <= this.maxEnded) break;
      if (!j.ended) continue;
      this.jobs.delete(id);
      ended--;
    }
  }

  // ── finalize's hooks ──────────────────────────────────────────────────────

  /** The job's call went stale after its proof was accepted (the check right before the hand-over): its
   *  `client-proof-stale` error, recorded as the job's failure, for the caller to throw. */
  stale(requestId: string, reason: string): PublicError {
    return this.staleFailure(requestId, reason);
  }

  /**
   * A finalize's submission failed. The network refusing the client's proof as invalid (115/179) fails the
   * job `client-proof-invalid`; the node refusing a stale call (104, `ReadMismatch`) fails it
   * `client-proof-stale`. Either is returned for the caller to throw after reverting the pending spend;
   * anything else (a DUST race, an outage) is returned unchanged.
   */
  submissionRefused(requestId: string, error: unknown): unknown {
    const job = this.jobs.get(requestId);
    if (!job) return error;
    if (isProofRefusal(error)) {
      if (job.ticket) job.ticket.status = 'invalid';
      job.failure ??= new PublicError('client-proof-invalid', MESSAGES.refusedByNetwork);
      this.o.log.warn('the network refused a client proof as invalid', { requestId });
      return job.failure;
    }
    if (isStaleRefusal(error)) {
      return this.staleFailure(requestId, 'the node refused the call: it read state that has moved (code 104)');
    }
    return error;
  }

  // ── internals ────────────────────────────────────────────────────────────

  private staleFailure(requestId: string, reason: string): PublicError {
    let job = this.jobs.get(requestId);
    if (!job) {
      job = { ticket: null, failure: null, ended: false };
      this.jobs.set(requestId, job);
    }
    if (job.ticket && job.ticket.status === 'checked') job.ticket.status = 'stale';
    job.failure ??= new PublicError('client-proof-stale', MESSAGES.stale);
    this.o.log.info('client proof stale: nothing submitted', { requestId, reason });
    return job.failure;
  }

  private open(job: JobTicket): Ticket | undefined {
    const t = job.ticket;
    return t && t.status === 'open' ? t : undefined;
  }

  /** The deadline passed: `client-proof-missing` (never fetched) or `client-proof-late`. */
  private expire(job: JobTicket, t: Ticket): void {
    if (t.status !== 'open') return;
    const code = t.fetched ? 'late' : 'missing';
    this.o.log.info(`client proof ${code}`, { circuit: t.circuit, fetched: t.fetched });
    this.fail(job, t, code, new PublicError(`client-proof-${code}`, MESSAGES[code]));
  }

  private fail(job: JobTicket, t: Ticket, status: TicketStatus, failure: PublicError): void {
    t.status = status;
    job.failure ??= failure;
    const settle = t.settle;
    this.drop(t);
    settle?.reject(job.failure);
  }

  /** Forget the ticket's private bytes, its timer, its check and its waiter. */
  private drop(t: Ticket): void {
    t.cancelTimer?.();
    t.cancelTimer = null;
    t.proofRequest = null;
    t.verifierKey = null;
    t.fresh = null;
    t.settle = null;
  }
}
