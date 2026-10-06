// The client-proof hand-off (AA 00062, interface I-62a), in `CLIENT_PROVING=required` mode.
//
// THE SEAM (research R1). Every account call is proven inside the ledger's `Transaction.prove`, which
// calls the relay's `LedgerProvingProvider.prove(preimage, keyLocation, bindingInput)` once per proof
// (../prover/proving-provider.ts). For a key location of one of the four k≥18 circuits, the provider
// never calls a proof server: it calls `handOff`, which opens a hand-off on the job that holds the
// prover lane and returns the ledger a promise. The page fetches the proof request
// (`GET /v1/jobs/:requestId/client-proof`), its prover proves it, and the page posts the proof back
// (`POST …`): the relay checks it (`ClientProofVerifier.verify`, ./verifier.ts) and only then resolves
// the ledger's promise with the bytes, so the ledger inserts them itself. The binding input, the Zswap
// proofs, `check`, the fee, balancing, `bind`, the exchange calls and the submission are unchanged.
//
// WHICH JOB. Every proof runs inside a prover-lane hold (../queue/jobs.ts: a prover-lane job holds the
// lane for its whole run, an account- or relay-lane job inside ctx.prove), and the lane has ONE holder,
// so the job a hand-off belongs to is the lane's holder. A k≥18 proof asked for outside a hold fails
// closed (an internal error; nothing is handed out, nothing is proven).
//
// ONE PROOF PER HAND-OFF, AT MOST ONE OPEN PER JOB. Passport's `submitWithDustRetry` rebuilds a call
// after a DUST race (a new preimage), which opens a NEW hand-off (`attempt + 1`, at most 4 per job).
// After a terminal failure (`client-proof-missing`, `-late`, `-invalid`) no hand-off opens again for
// the job, so nothing can ask the page for another proof.
//
// THE DEADLINE: min(opened + CLIENT_PROOF_TIMEOUT_SECONDS, signed deadline − 60 s). The signed deadline
// is a make's or a take's `validUntil`; withdrawals and filings have none. With less than 30 s left at
// opening the job fails `client-proof-late` at once and nothing is handed out. When it passes: never
// fetched → `client-proof-missing`, fetched → `client-proof-late`.
//
// A PROOF THE NETWORK REFUSES (research R1/R3). With a verifier in place a bad proof never reaches the
// network. Should one still be refused at submission as an invalid proof (node codes 115 `InvalidProof`,
// 179 `UnsupportedProofVersion`), `submissionRefused` turns the failure into `client-proof-invalid`: its
// message cannot match Passport's DUST-race retry, so the call is not rebuilt (no more proofs are asked
// for), and the sponsor wallet's pending spend is reverted (../passport/wallet-provider.ts).
//
// PRIVACY. A proof request carries the call's private inputs (coins, amounts): it is never logged,
// served only to the job's poller with `Cache-Control: no-store` (../app.ts), and dropped from memory
// as soon as its hand-off ends. The relay never calls a URL a user gave it: the page alone talks to
// the user's prover (spec FR-003); nothing here makes any network request.

import { randomBytes } from 'node:crypto';

import {
  CLIENT_PROOF_MAX_ATTEMPTS,
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

/** The job holding the prover lane. */
export interface ProverHolder {
  requestId: string;
  action: JobActionName;
  /** Its signed deadline (Unix seconds): a make's or a take's `validUntil`. */
  signedDeadline?: number;
}

/** What the desk needs of the job queue. */
export interface ClientProofJobs {
  /** The job holding the prover lane now, or null. */
  proverHolder(): ProverHolder | null;
  /** Record a stage (public details only) on a running job. */
  recordStage(requestId: string, name: string, detail?: Record<string, string>): void;
  /** A job's public view; undefined when there is no such job. */
  get(requestId: string): JobView | undefined;
}

/** What the proving provider hands the desk for one k≥18 proof. */
export interface HandOffRequest {
  circuit: string;
  /** The ledger's key-less `/prove` body: `createProvingPayload(preimage, bindingInput)`. */
  proofRequest: Uint8Array;
  /** The index of the key material's `None` (`0x00`) in `proofRequest`. */
  keyMaterialOffset: number;
  /** The pinned verifier key the key location names (its sha256 is the location's `?vk=`). */
  verifierKey: Uint8Array;
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
  /** Ended jobs whose hand-off history is kept to answer late posts (oldest dropped first). */
  maxEndedJobs?: number;
}

type HandOffStatus = 'open' | 'received' | 'checked' | 'missing' | 'late' | 'invalid' | 'abandoned';

interface HandOff {
  proofId: string;
  circuit: ClientProvenCircuit;
  attempt: number;
  deadline: number;
  fetched: boolean;
  status: HandOffStatus;
  /** Dropped (null) as soon as the hand-off ends. */
  proofRequest: Uint8Array | null;
  keyMaterialOffset: number;
  verifierKey: Uint8Array | null;
  settle: { resolve(proof: Uint8Array): void; reject(e: Error): void } | null;
  cancelTimer: (() => void) | null;
}

interface JobHandOffs {
  attempts: HandOff[];
  /** The job's terminal client-proof failure: no hand-off opens after it. */
  failure: PublicError | null;
  /** The last hand-off's checked proof rides the transaction being submitted. */
  delivered: HandOff | null;
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
} as const;

/** Node errors that mean "the proof is invalid" (midnight-node `ledger/src/versions/common/types.rs`:
 *  115 `MalformedError::InvalidProof`, 179 `MalformedError::UnsupportedProofVersion`). */
const PROOF_REFUSAL = /\bCustom error: (?:115|179)\b|MalformedError::(?:InvalidProof|UnsupportedProofVersion)\b/;

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

export class ClientProofDesk {
  private readonly jobs = new Map<string, JobHandOffs>();
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

  // ── the seam (the proving provider) ───────────────────────────────────────

  /**
   * Open a hand-off for the prover lane's holder and wait for its checked proof (I-62a). Rejects with
   * the job's `client-proof-*` PublicError when the proof is missing, late or invalid, and with an
   * internal error when the request cannot be handed out (no holder, a second open hand-off, too many
   * attempts, a request that is not a key-less /prove body): nothing is proven then.
   */
  handOff(req: HandOffRequest): Promise<Uint8Array> {
    const holder = this.o.jobs.proverHolder();
    if (!holder) throw new Error('a client proof was asked for outside a prover-lane hold');
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
      throw new Error('the proof request is not a key-less /prove body within the hand-off limits');
    }
    const id = holder.requestId;
    let job = this.jobs.get(id);
    if (!job) {
      job = { attempts: [], failure: null, delivered: null, ended: false };
      this.jobs.set(id, job);
    }
    if (job.failure) return Promise.reject(job.failure);
    if (job.ended) throw new Error('a client proof was asked for by a job that has ended');
    if (job.attempts.some((h) => h.status === 'open' || h.status === 'received')) {
      throw new Error('a job asked for a second client proof while one is open');
    }
    const attempt = job.attempts.length + 1;
    if (attempt > CLIENT_PROOF_MAX_ATTEMPTS) throw new Error('a job asked for more client proofs than it may');
    job.delivered = null;

    const now = this.now();
    let deadline = now + this.o.timeoutSeconds;
    if (holder.signedDeadline !== undefined) {
      deadline = Math.min(deadline, holder.signedDeadline - CLIENT_PROOF_SETTLE_MARGIN_SECONDS);
    }
    if (deadline - now < CLIENT_PROOF_MIN_WINDOW_SECONDS) {
      job.failure = new PublicError('client-proof-late', MESSAGES.lateAtOpening);
      this.o.log.info('client proof refused at opening: too little time left', {
        requestId: id,
        circuit: req.circuit,
        secondsLeft: deadline - now,
      });
      return Promise.reject(job.failure);
    }

    const h: HandOff = {
      proofId: randomBytes(16).toString('hex'),
      circuit: req.circuit,
      attempt,
      deadline,
      fetched: false,
      status: 'open',
      proofRequest: Uint8Array.from(proofRequest),
      keyMaterialOffset,
      verifierKey: Uint8Array.from(req.verifierKey),
      settle: null,
      cancelTimer: null,
    };
    const promise = new Promise<Uint8Array>((resolve, reject) => {
      h.settle = { resolve, reject };
    });
    job.attempts.push(h);
    h.cancelTimer = this.schedule(() => this.expire(job, h), Math.max(0, (deadline - now) * 1000));
    this.o.jobs.recordStage(id, 'awaiting-client-proof', {
      circuit: h.circuit,
      proofId: h.proofId,
      attempt: String(attempt),
    });
    this.o.log.info('client proof requested', {
      requestId: id,
      circuit: h.circuit,
      attempt,
      secondsToDeadline: deadline - now,
      requestBytes: proofRequest.length,
    });
    return promise;
  }

  // ── the routes ────────────────────────────────────────────────────────────

  /** `GET /v1/jobs/:requestId/client-proof` (the route has checked the job exists): the open hand-off's
   *  request; the first call marks it fetched. */
  serveRequest(requestId: string): ServeOutcome {
    const job = this.jobs.get(requestId);
    const h = job ? this.open(job) : undefined;
    if (!job || !h) return { ok: false, code: 'not-awaiting-client-proof' };
    if (this.now() >= h.deadline) {
      this.expire(job, h);
      return { ok: false, code: 'not-awaiting-client-proof' };
    }
    if (!h.fetched) {
      h.fetched = true;
      this.o.jobs.recordStage(requestId, 'client-proof-fetched', { proofId: h.proofId });
      this.o.log.info('client proof request fetched', { requestId, attempt: h.attempt });
    }
    return {
      ok: true,
      body: {
        proofId: h.proofId,
        circuit: h.circuit,
        proofRequest: Buffer.from(h.proofRequest!).toString('base64'),
        keyMaterialOffset: h.keyMaterialOffset,
        deadline: h.deadline,
        attempt: h.attempt,
        keySet: this.o.keySet,
        proofServer: this.o.proofServer,
      },
    };
  }

  /** `POST /v1/jobs/:requestId/client-proof` (the route has checked the body's shape and the job). */
  async submit(requestId: string, body: ClientProofSubmission): Promise<SubmitOutcome> {
    const job = this.jobs.get(requestId);
    const latest = job?.attempts[job.attempts.length - 1];
    const wrongId = {
      ok: false,
      status: 409,
      code: 'client-proof-wrong-id',
      message: 'this proof is not for the proof request this job is waiting for (it may be for an earlier attempt)',
    } as const;
    if (!job || !latest || latest.proofId !== body.proofId) return wrongId;
    const h = latest;
    if (h.status === 'open' && this.now() >= h.deadline) this.expire(job, h);
    switch (h.status) {
      case 'open':
        break;
      case 'received':
      case 'checked':
      case 'invalid':
        return {
          ok: false,
          status: 409,
          code: 'client-proof-already-received',
          message: 'a proof for this request was already received; each request takes exactly one',
        };
      case 'missing':
      case 'late':
      case 'abandoned':
        return {
          ok: false,
          status: 410,
          code: 'client-proof-late',
          message: 'this proof arrived after its deadline (or after the action ended) and was ignored',
        };
    }

    // From here the hand-off has its one proof: a second post is refused, whatever this one's verdict.
    h.status = 'received';
    h.cancelTimer?.();
    h.cancelTimer = null;
    this.o.jobs.recordStage(requestId, 'client-proof-received', { proofId: h.proofId });
    const proof = Uint8Array.from(Buffer.from(body.proof, 'base64'));
    const t0 = Date.now();
    let verdict: { ok: true } | { ok: false; reason: string };
    if (proof.length === 0 || proof.length > CLIENT_PROOF_MAX_BYTES || !startsWith(proof, PROOF_TAG_BYTES)) {
      verdict = { ok: false, reason: `not a proof (${proof.length} bytes, or not tagged ${PROOF_TAG})` };
    } else {
      try {
        verdict = await this.o.verifier.verify({
          circuit: h.circuit,
          proofRequest: h.proofRequest!,
          proof,
          verifierKey: h.verifierKey!,
        });
      } catch (e) {
        // The relay could not check it: the market's failure, never the requester's (not charged).
        const failure = new PublicError(
          'market-unavailable',
          "the market could not check your proof server's proof right now. Nothing was sent and it does not count against you; try again shortly",
        );
        this.o.log.warn('the client-proof verifier failed', { requestId, error: e });
        this.fail(job, h, 'invalid', failure);
        return { ok: false, status: 503, code: 'market-unavailable', message: failure.message };
      }
    }
    // The job ended while the proof was being checked (it cannot use it any more).
    if ((h.status as HandOffStatus) !== 'received') {
      return {
        ok: false,
        status: 410,
        code: 'client-proof-late',
        message: 'this proof arrived after its deadline (or after the action ended) and was ignored',
      };
    }
    if (!verdict.ok) {
      const failure = new PublicError('client-proof-invalid', MESSAGES.invalid);
      this.o.log.info('client proof refused', {
        requestId,
        circuit: h.circuit,
        attempt: h.attempt,
        reason: verdict.reason,
        proofBytes: proof.length,
      });
      this.fail(job, h, 'invalid', failure);
      return { ok: false, status: 422, code: 'client-proof-invalid', message: failure.message };
    }
    // Checked: the stage is recorded and the view taken BEFORE the ledger continues (it resumes on a
    // later tick), so the answer shows `client-proof-checked`.
    h.status = 'checked';
    job.delivered = h;
    this.o.jobs.recordStage(requestId, 'client-proof-checked', { proofId: h.proofId });
    const settle = h.settle;
    this.drop(h);
    const view = this.o.jobs.get(requestId);
    this.o.log.info('client proof checked', {
      requestId,
      circuit: h.circuit,
      attempt: h.attempt,
      checkMs: Date.now() - t0,
      proofBytes: proof.length,
    });
    settle?.resolve(proof);
    if (!view) return wrongId;
    return { ok: true, job: view };
  }

  // ── the job queue's hooks ────────────────────────────────────────────────

  /** The job view's `clientProof`: only while a hand-off is open. */
  view(requestId: string): ClientProofField | undefined {
    const job = this.jobs.get(requestId);
    const h = job ? this.open(job) : undefined;
    if (!h) return undefined;
    return { proofId: h.proofId, circuit: h.circuit, deadline: h.deadline, attempt: h.attempt, fetched: h.fetched };
  }

  /** The job's terminal client-proof failure, if any: the job's error, whatever error its proof
   *  surfaced as through the ledger and midnight-js. */
  failureOf(requestId: string): PublicError | undefined {
    return this.jobs.get(requestId)?.failure ?? undefined;
  }

  /** The job ended (whatever its outcome): an open hand-off is abandoned, every request dropped. */
  jobEnded(requestId: string): void {
    const job = this.jobs.get(requestId);
    if (!job) return;
    job.ended = true;
    job.delivered = null;
    for (const h of job.attempts) {
      if (h.status === 'open' || h.status === 'received') {
        h.status = 'abandoned';
        const settle = h.settle;
        this.drop(h);
        settle?.reject(new Error('the job ended before its client proof'));
      } else {
        this.drop(h);
      }
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

  // ── the wallet provider's hook ───────────────────────────────────────────

  /**
   * A submission failed. When the prover lane's holder submitted a client proof and the network
   * refused it as an invalid proof, the job fails `client-proof-invalid` (returned, for the caller to
   * throw after reverting the pending spend); anything else (a DUST race, an outage) is returned
   * unchanged, and Passport may rebuild the call, which opens a new hand-off.
   */
  submissionRefused(error: unknown): unknown {
    const holder = this.o.jobs.proverHolder();
    const job = holder ? this.jobs.get(holder.requestId) : undefined;
    const delivered = job?.delivered;
    if (!job || !delivered) return error;
    job.delivered = null;
    if (!isProofRefusal(error)) return error;
    delivered.status = 'invalid';
    job.failure = new PublicError('client-proof-invalid', MESSAGES.refusedByNetwork);
    this.o.log.warn('the network refused a client proof as invalid', {
      requestId: holder!.requestId,
      circuit: delivered.circuit,
      attempt: delivered.attempt,
    });
    return job.failure;
  }

  // ── internals ────────────────────────────────────────────────────────────

  private open(job: JobHandOffs): HandOff | undefined {
    const h = job.attempts[job.attempts.length - 1];
    return h && h.status === 'open' ? h : undefined;
  }

  /** The deadline passed: `client-proof-missing` (never fetched) or `client-proof-late`. */
  private expire(job: JobHandOffs, h: HandOff): void {
    if (h.status !== 'open') return;
    const code = h.fetched ? 'late' : 'missing';
    this.o.log.info(`client proof ${code}`, { circuit: h.circuit, attempt: h.attempt, fetched: h.fetched });
    this.fail(job, h, code, new PublicError(`client-proof-${code}`, MESSAGES[code]));
  }

  private fail(job: JobHandOffs, h: HandOff, status: HandOffStatus, failure: PublicError): void {
    h.status = status;
    job.failure ??= failure;
    const settle = h.settle;
    this.drop(h);
    settle?.reject(job.failure);
  }

  /** Forget the hand-off's private bytes, its timer and its waiter. */
  private drop(h: HandOff): void {
    h.cancelTimer?.();
    h.cancelTimer = null;
    h.proofRequest = null;
    h.verifierKey = null;
    h.settle = null;
  }
}
