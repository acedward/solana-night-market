// The demo-token claims store (spec FR-007): the relay's ONLY persistent state. One record per
// Solana key that claimed, so a key gets the pack once, ever, and a rolling 24-hour count of claims
// for the daily cap.
//
// A JSON file under RELAY_DATA_DIR (`demo-token-claims.json`), rewritten atomically on every change
// (a temporary file, fsync, rename), so a crash leaves either the old or the new file, never a torn
// one. Concurrency: every decision (`reserve`) is synchronous, and the relay is one process, so two
// requests racing for the same key or the last slot of the day cannot both pass; a second relay on
// the same data dir is refused at start by an exclusive lock file. Only a lock file that already
// exists means "held"; any other failure (a data dir the relay's user cannot write, a read-only or
// full disk) is reported as what it is, with the path, the error code, the relay's uid/gid and the
// fix (a data dir owned by another uid once looked like a lock conflict: AA 00047 P7.4).
//
// The claim's life (AA 00047 P9, audit C8: F-B7, F-B8, F-B9):
//   - RESERVED at admission (before any queue slot). The reservation is the day's charge: the record
//     keeps its time `at` for good, so the daily cap counts it whatever happens next;
//   - each pack token that lands is recorded at once (`delivered`, by colour, with its transaction
//     ids), so a pack that fails part-way never erases the quota of the tokens already minted, and
//     resuming it never mints those again;
//   - CONFIRMED (`claimed`) when every token landed;
//   - when the job fails, the record stays as `partial` (resumable: the same key may claim again to
//     get the REST of the pack, to the same account, without a new daily charge), and its failure is
//     counted; after `maxAttempts` failures the key is refused. Only a reservation the route refused
//     before any job ran (a full queue) is RELEASED: nothing was spent;
//   - a reservation found on disk at start (the relay stopped mid-job) is kept as `partial`: its
//     tokens may have landed, so its charge is kept and the rest can be resumed.
// A token is never minted twice (AA 00047 P10, audit round 2 R2-7 / F-B2-4; F-A2-7's lost progress
// write): BEFORE a token's transaction is submitted, the claim records it as PENDING (durably, with
// the 192-byte inbox entry the transaction files into the account and the time after which it can no
// longer land); only then is it submitted. A pending token, whether the job failed, the response was
// lost or the relay stopped (the crash-recovery path keeps it), is RECONCILED against the chain before
// anything is minted again (../demo/action.ts): its entry in the account's inbox means it landed
// (delivered); no entry after its last possible landing time means it did not (minted again); no
// entry before that time means "still settling" (the claim waits, nothing is minted). A pending token
// that cannot be reconciled (no entry to look for) is QUARANTINED: never minted again by the relay;
// an operator decides (deploy/RUNBOOK.md section 7).
//
// The lock (F-A2-7): the lock file names its holder's pid, host and a random token, and the live
// relay touches it every `heartbeatSeconds`. A lock is stale (taken over) when it is older than
// `staleSeconds`, or when it was written on THIS host by a pid that is gone, or by this very pid
// with another token (a restarted container). A fresh lock of another host (another container on the
// same data volume, even with the same pid 1) is held. A relay whose lock was taken over stops
// writing (claims answer `store-unavailable`), so two relays never write one file.
// Every change is written to disk FIRST and only then applied in memory: a write that fails leaves
// memory as it was (a reservation that could not be written is refused, not kept as a phantom). The
// store reads and recovers its file only AFTER it holds the lock (`lock()`), so a second relay
// refused the lock never rewrites a live relay's file.
//
// What it holds is public: the owner key (its Solana address is public), the account, the times and
// the transaction ids.

import { randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';

const DAY_SECONDS = 86_400;
const FORMAT = 'night-market-demo-token-claims/1';

/** The transaction ids of one pack token that landed (the faucet path's `MintOutcome`). */
export interface DeliveredToken {
  mintAndDeposit?: string;
  mint?: string;
  deposit?: string;
  /** Found on chain by reconciling a pending token (its transaction id was never reported). */
  reconciled?: true;
}

/** A token whose transaction is (or was) being submitted: written BEFORE the submission (P10, R2-7). */
export interface PendingToken {
  /** Unix seconds when it was written. */
  since: number;
  /** Unix seconds after which the transaction can no longer land (its TTL, plus a margin). */
  notAfter: number;
  /** `direct`: the one mint-and-deposit transaction; `via-sponsor`: the mint to the sponsor, then the
   *  deposit into the account. */
  stage: 'mint-and-deposit' | 'mint' | 'deposit';
  /** The 192-byte inbox entry (hex) the transaction files into the account: how it is found on chain. */
  entry?: string;
  /** The account's inbox count when it was written (decimal): where to start looking. */
  inboxFrom?: string;
}

/** A pending token the relay could not reconcile and will not mint again. */
export interface QuarantinedToken extends PendingToken {
  /** Unix seconds when it was quarantined. */
  at: number;
  reason: string;
}

export interface ClaimRecord {
  /** The owner's device key (64 lowercase hex). */
  owner: string;
  /** The account the pack went to (64 lowercase hex). */
  account: string;
  /** `reserved`: a job is (or was, when found at start) delivering it; `partial`: a job failed
   *  part-way (resumable); `claimed`: every token landed. */
  state: 'reserved' | 'partial' | 'claimed';
  /** Unix seconds of the FIRST reservation: the day's charge, kept for good. */
  at: number;
  /** Unix seconds of the confirmation. */
  claimedAt?: number;
  /** Public transaction ids of the pack. */
  txs?: string[];
  /** The pack tokens that landed so far, by colour (64 hex) (audit C8 / F-B7). */
  delivered?: Record<string, DeliveredToken>;
  /** Attempts that failed while minting (a relay stopped mid-job does not count). */
  failures?: number;
  /** Pack tokens being submitted, by colour: reconciled before anything is minted again (P10, R2-7). */
  pending?: Record<string, PendingToken>;
  /** Pack tokens the relay will not mint again, by colour (an operator decides). */
  quarantined?: Record<string, QuarantinedToken>;
}

/** A reservation the executor drives: record each token as it lands, then confirm or fail. */
export interface ClaimHandle {
  /** The tokens that already landed (a resumed claim), by colour. */
  readonly delivered: Readonly<Record<string, DeliveredToken>>;
  /** The tokens whose submission is uncertain, by colour (reconcile them before minting). */
  readonly pending: Readonly<Record<string, PendingToken>>;
  /** The tokens the relay will not mint again, by colour. */
  readonly quarantined: Readonly<Record<string, QuarantinedToken>>;
  /** Whether this reservation resumes an earlier partial claim. */
  readonly resumed: boolean;
  /** Record that a token's transaction is about to be submitted (BEFORE the submission). Throws
   *  when the store cannot write: then nothing may be submitted. */
  submitting(colour: string, pending: PendingToken): void;
  /** A pending token was reconciled: it landed (`landed`: its record) or it did not (null: it may be
   *  minted again). Throws when the store cannot write. */
  settle(colour: string, landed: DeliveredToken | null): void;
  /** A pending token cannot be reconciled: never mint it again. Throws when the store cannot write. */
  quarantine(colour: string, reason: string): void;
  /** Record one token that landed (it leaves `pending`). Throws when the store cannot write (the job
   *  must stop; the token stays pending, and is reconciled before anything is minted again). */
  progress(colour: string, txs: DeliveredToken): void;
  /** Every token landed. Throws when the store cannot write. */
  confirm(txs: string[]): void;
  /** The job failed: keep the record (resumable); count the failure when `counted` (a token was
   *  being minted: the attempt spent DUST and prover time). Never throws. */
  fail(counted?: boolean): void;
  /** The route refused the request before any job ran: undo the reservation. Never throws. */
  release(): void;
}

export type ReserveOutcome =
  | ({ ok: true } & ClaimHandle)
  | {
      ok: false;
      code: 'already-claimed' | 'daily-cap' | 'attempts-exhausted' | 'store-unavailable';
      reason: string;
    };

/**
 * Why the claims store cannot start: its lock is `held` by another live relay, or the data dir
 * cannot be used (`filesystem`: `code` is the errno name, e.g. EACCES, EROFS, ENOSPC).
 */
export class ClaimsStoreError extends Error {
  constructor(
    message: string,
    readonly kind: 'held' | 'filesystem',
    readonly path: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'ClaimsStoreError';
  }
}

export interface ClaimsOptions {
  /** The JSON file (null: in memory only, for tests and keyless development). */
  file: string | null;
  dailyCap: number;
  /** Failed attempts after which a key's partial claim is not resumed (default 3). */
  maxAttempts?: number;
  now?: () => number;
  /** Told about reservations found at start (kept as resumable partial claims). */
  onRecovered?: (count: number) => void;
  /** Told when a failure could not be written (memory and disk then differ until the next write). */
  onWriteFailed?: (what: string, error: unknown) => void;
  /** How often the live relay touches its lock (seconds; 0: never, for tests). Default 30. */
  heartbeatSeconds?: number;
  /** A lock untouched for this long is stale, whoever wrote it (seconds). Default 120. */
  staleSeconds?: number;
  /** This relay's host name, as the lock names it (default: the OS host name; a container's id). */
  hostname?: string;
  /** Told when another relay took the lock over: this store stops writing. */
  onLockLost?: () => void;
}

/** What a lock file says about its holder. */
interface LockHolder {
  raw: string;
  pid: number | null;
  host?: string;
  token?: string;
  /** Milliseconds since the file was last touched. */
  ageMs: number;
}

export class DemoTokenClaims {
  private readonly now: () => number;
  private readonly byOwner = new Map<string, ClaimRecord>();
  /** Owners with a reservation admitted and not yet finished (memory only). */
  private readonly active = new Set<string>();
  private lockFile: string | null = null;
  /** This store's lock token (random per instance). */
  private readonly token = randomBytes(16).toString('hex');
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  /** Another relay took the lock over: nothing is written any more. */
  private lost = false;

  constructor(private readonly o: ClaimsOptions) {
    this.now = o.now ?? (() => Math.floor(Date.now() / 1000));
    // Nothing is read here: a file-backed store loads (and recovers) its file in `lock()`, once it
    // holds the data dir's lock (audit C8 / F-B8).
  }

  private get maxAttempts(): number {
    return this.o.maxAttempts ?? 3;
  }

  /**
   * Take the data dir's lock (one relay per claims file), THEN read the claims file and recover it.
   * Throws a ClaimsStoreError: `held` when another live process holds the lock (the file is not
   * touched), `filesystem` when the lock or the file cannot be used.
   */
  lock(): void {
    if (!this.o.file || this.lockFile) return;
    this.takeLock(this.o.file);
    try {
      this.load(this.o.file);
    } catch (e) {
      this.unlock();
      throw e;
    }
  }

  private takeLock(file: string): void {
    const path = `${file}.lock`;
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    } catch (e) {
      throw filesystemProblem('create its data dir', dirname(path), e, dirname(path));
    }
    // A few rounds: a stale lock is removed and taken again, and a lock released between our
    // attempt and our read is simply taken again. Losing every round to other relays is "held".
    for (let round = 0; round < 3; round++) {
      const fd = createExclusive(path);
      if (fd !== null) {
        try {
          writeSync(fd, `${JSON.stringify({ pid: process.pid, host: this.host, token: this.token })}\n`);
        } catch (e) {
          closeSync(fd);
          rmSync(path, { force: true });
          throw filesystemProblem('write its lock file', path, e);
        }
        closeSync(fd);
        this.lockFile = path;
        this.lost = false;
        this.startHeartbeat();
        return;
      }
      // The lock file exists (EEXIST): who holds it?
      const holder = readHolder(path);
      if (holder === null) continue; // released meanwhile
      if (this.isStale(holder)) {
        try {
          rmSync(path, { force: true });
        } catch (e) {
          throw filesystemProblem('remove a stale lock file', path, e);
        }
        continue;
      }
      throw held(path, describeHolder(holder));
    }
    const last = readHolder(path);
    throw held(path, last ? describeHolder(last) : '');
  }

  private get host(): string {
    return this.o.hostname ?? hostname();
  }

  /**
   * Whether a lock can be taken over (see the header). A lock untouched for `staleSeconds` is stale.
   * A lock that names its host: on THIS host it is stale when its pid is gone, or is this very pid
   * with another token (a restarted container); on another host it is held while it is fresh (a
   * second container on the same data volume). A lock of an older relay (a bare pid): stale when the
   * pid is gone or is ours.
   */
  private isStale(h: LockHolder): boolean {
    if (h.ageMs > (this.o.staleSeconds ?? 120) * 1000) return true;
    if (h.pid === null || h.pid <= 0) return false;
    if (h.host === undefined) return h.pid === process.pid || !processAlive(h.pid);
    if (h.host !== this.host) return false;
    return (h.pid === process.pid && h.token !== this.token) || !processAlive(h.pid);
  }

  private startHeartbeat(): void {
    const seconds = this.o.heartbeatSeconds ?? 30;
    if (seconds <= 0 || this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => this.heartbeat(), seconds * 1000);
    this.heartbeatTimer.unref?.();
  }

  /**
   * Touch the lock, after checking it is still ours. When another relay took it over, stop: nothing
   * is written any more (claims answer `store-unavailable`). Returns whether the lock is held.
   */
  heartbeat(): boolean {
    if (!this.lockFile || this.lost) return false;
    if (!this.lockStillOurs()) return false;
    try {
      const now = new Date();
      utimesSync(this.lockFile, now, now);
    } catch {
      /* a failed touch only makes the lock look older */
    }
    return true;
  }

  /** Whether the lock file still carries this store's token; when not, the store stops writing. */
  private lockStillOurs(): boolean {
    if (!this.lockFile || this.lost) return false;
    let h: LockHolder | null;
    try {
      h = readHolder(this.lockFile);
    } catch {
      return true; // cannot read it: keep going (the next write reports the file system)
    }
    if (h?.token === this.token) return true;
    this.lost = true;
    this.stopHeartbeat();
    this.o.onLockLost?.();
    return false;
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  unlock(): void {
    this.stopHeartbeat();
    // Only our own lock is removed: one taken over by another relay is theirs.
    if (this.lockFile && !this.lost && this.lockStillOurs()) rmSync(this.lockFile, { force: true });
    this.lockFile = null;
  }

  /** Whether the store can be used: in memory, or file-backed, opened by `lock()` and still ours. */
  get open(): boolean {
    return !this.o.file || (this.lockFile !== null && !this.lost);
  }

  private load(file: string): void {
    this.byOwner.clear();
    this.active.clear();
    if (!existsSync(file)) return;
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch (e) {
      throw filesystemProblem('read its claims file', file, e);
    }
    const parsed = JSON.parse(text) as { format?: string; claims?: ClaimRecord[] };
    if (parsed.format !== FORMAT || !Array.isArray(parsed.claims)) {
      throw new Error(`${file} is not a ${FORMAT} file`);
    }
    const records = new Map<string, ClaimRecord>();
    let recovered = 0;
    for (const c of parsed.claims) {
      if (!/^[0-9a-f]{64}$/.test(c.owner) || !/^[0-9a-f]{64}$/.test(c.account)) continue;
      if (c.state === 'reserved') {
        // The relay stopped mid-job: tokens may have landed. Keep the charge; resume the rest.
        recovered++;
        records.set(c.owner, { ...c, state: 'partial' });
        continue;
      }
      records.set(c.owner, c);
    }
    if (recovered > 0) {
      try {
        this.writeFile([...records.values()]);
      } catch (e) {
        throw filesystemProblem('rewrite its claims file', file, e);
      }
      this.o.onRecovered?.(recovered);
    }
    for (const [k, v] of records) this.byOwner.set(k, v);
  }

  private writeFile(claims: ClaimRecord[]): void {
    const file = this.o.file;
    if (!file) return;
    // Never write a file another relay holds (it took the lock over: F-A2-7).
    if (this.lockFile && !this.lockStillOurs()) {
      throw new ClaimsStoreError('the demo-token claims lock was taken over by another relay', 'held', file, 'EEXIST');
    }
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const body = `${JSON.stringify({ format: FORMAT, claims }, null, 1)}\n`;
    const tmp = join(dirname(file), `.${process.pid}.${Date.now()}.claims.tmp`);
    const fd = openSync(tmp, 'w', 0o600);
    try {
      try {
        writeSync(fd, body);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, file);
    } catch (e) {
      rmSync(tmp, { force: true });
      throw e;
    }
  }

  /**
   * Write the store with `owner`'s record replaced by `next` (null: removed), and only when that
   * succeeded apply it in memory (audit C8 / F-B9). Throws when the write fails; memory is unchanged.
   */
  private put(owner: string, next: ClaimRecord | null): void {
    if (this.o.file) {
      const claims: ClaimRecord[] = [];
      let seen = false;
      for (const [k, v] of this.byOwner) {
        if (k !== owner) claims.push(v);
        else {
          seen = true;
          if (next) claims.push(next);
        }
      }
      if (!seen && next) claims.push(next);
      this.writeFile(claims);
    }
    if (next) this.byOwner.set(owner, next);
    else this.byOwner.delete(owner);
  }

  /** Claims (in any state) first reserved in the last 24 hours: the day's charges. */
  claimedToday(): number {
    const since = this.now() - DAY_SECONDS;
    let n = 0;
    for (const c of this.byOwner.values()) if (c.at > since) n++;
    return n;
  }

  remainingToday(): number {
    return Math.max(0, this.o.dailyCap - this.claimedToday());
  }

  /** Whether a key has claimed, is claiming, or may not claim again (its attempts are spent). A
   *  partial claim that can still be resumed is not "claimed": its owner may ask for the rest. */
  hasClaimed(ownerRaw: string): boolean {
    const owner = ownerRaw.replace(/^0x/, '').toLowerCase();
    const r = this.byOwner.get(owner);
    if (!r) return false;
    return r.state === 'claimed' || this.active.has(owner) || (r.failures ?? 0) >= this.maxAttempts;
  }

  /** Whether a key has a partial claim it may resume (already charged: the daily cap does not apply). */
  isResumable(ownerRaw: string): boolean {
    const owner = ownerRaw.replace(/^0x/, '').toLowerCase();
    const r = this.byOwner.get(owner);
    return !!r && r.state !== 'claimed' && !this.active.has(owner) && (r.failures ?? 0) < this.maxAttempts;
  }

  /** The record of a key (a copy), for operators and tests. */
  record(ownerRaw: string): ClaimRecord | undefined {
    const r = this.byOwner.get(ownerRaw.replace(/^0x/, '').toLowerCase());
    return r ? structuredClone(r) : undefined;
  }

  /**
   * Reserve the pack for `owner` → `account`: once per key, within the daily cap, or resume the
   * key's partial claim (same account, no new charge). Synchronous. Nothing is kept unless it was
   * written.
   */
  reserve(ownerRaw: string, accountRaw: string): ReserveOutcome {
    if (this.lost) {
      return {
        ok: false,
        code: 'store-unavailable',
        reason: 'the market cannot record demo-token claims right now; try again later',
      };
    }
    if (!this.open) throw new Error('the demo-token claims store is not open: call lock() first');
    const owner = ownerRaw.replace(/^0x/, '').toLowerCase();
    const account = accountRaw.replace(/^0x/, '').toLowerCase();
    const prior = this.byOwner.get(owner);
    if (prior && (prior.state === 'claimed' || this.active.has(owner))) {
      return {
        ok: false,
        code: 'already-claimed',
        reason:
          prior.state === 'claimed'
            ? 'this wallet has already received its demo tokens'
            : 'this wallet is already receiving its demo tokens',
      };
    }
    if (prior && prior.account !== account) {
      return {
        ok: false,
        code: 'already-claimed',
        reason: "this wallet's demo tokens went to another account; claim the rest there",
      };
    }
    if (prior && (prior.failures ?? 0) >= this.maxAttempts) {
      return {
        ok: false,
        code: 'attempts-exhausted',
        reason: `delivering this wallet's demo tokens failed ${prior.failures} times; the market will not try again`,
      };
    }
    if (!prior && this.claimedToday() >= this.o.dailyCap) {
      return {
        ok: false,
        code: 'daily-cap',
        reason: "the market has given out today's demo tokens; try again tomorrow",
      };
    }
    const reserved: ClaimRecord = prior
      ? { ...prior, state: 'reserved' }
      : { owner, account, state: 'reserved', at: this.now() };
    try {
      this.put(owner, reserved);
    } catch (e) {
      this.o.onWriteFailed?.('reserve', e);
      return {
        ok: false,
        code: 'store-unavailable',
        reason: 'the market cannot record demo-token claims right now; try again later',
      };
    }
    this.active.add(owner);
    return this.handle(owner, prior ?? null);
  }

  private handle(owner: string, prior: ClaimRecord | null): { ok: true } & ClaimHandle {
    let finished = false;
    const current = () => this.byOwner.get(owner)!;
    const end = () => {
      finished = true;
      this.active.delete(owner);
    };
    const without = <T>(m: Record<string, T> | undefined, k: string): Record<string, T> | undefined => {
      if (!m) return undefined;
      const { [k]: _gone, ...rest } = m;
      return Object.keys(rest).length > 0 ? rest : undefined;
    };
    const withPending = (r: ClaimRecord, pending: Record<string, PendingToken> | undefined): ClaimRecord => {
      const { pending: _p, ...rest } = r;
      return pending ? { ...rest, pending } : rest;
    };
    return {
      ok: true,
      resumed: prior !== null,
      get delivered() {
        return { ...(current()?.delivered ?? {}) };
      },
      get pending() {
        return { ...(current()?.pending ?? {}) };
      },
      get quarantined() {
        return { ...(current()?.quarantined ?? {}) };
      },
      submitting: (colour: string, pending: PendingToken) => {
        if (finished) throw new Error('this demo-token claim has ended');
        const r = current();
        this.put(owner, { ...r, pending: { ...(r.pending ?? {}), [colour.toLowerCase()]: { ...pending } } });
      },
      settle: (colour: string, landed: DeliveredToken | null) => {
        if (finished) throw new Error('this demo-token claim has ended');
        const c = colour.toLowerCase();
        const r = withPending(current(), without(current().pending, c));
        this.put(owner, landed ? { ...r, delivered: { ...(r.delivered ?? {}), [c]: { ...landed } } } : r);
      },
      quarantine: (colour: string, reason: string) => {
        if (finished) throw new Error('this demo-token claim has ended');
        const c = colour.toLowerCase();
        const was = current().pending?.[c];
        const r = withPending(current(), without(current().pending, c));
        const q: QuarantinedToken = {
          ...(was ?? { since: this.now(), notAfter: this.now(), stage: 'mint' }),
          at: this.now(),
          reason,
        };
        this.put(owner, { ...r, quarantined: { ...(r.quarantined ?? {}), [c]: q } });
      },
      progress: (colour: string, txs: DeliveredToken) => {
        if (finished) return;
        const c = colour.toLowerCase();
        const r = withPending(current(), without(current().pending, c));
        this.put(owner, { ...r, delivered: { ...(r.delivered ?? {}), [c]: { ...txs } } });
      },
      confirm: (txs: string[]) => {
        if (finished) return;
        const r = current();
        this.put(owner, { ...r, state: 'claimed', claimedAt: this.now(), txs: [...txs] });
        end();
      },
      fail: (counted = true) => {
        if (finished) return;
        const r = current();
        try {
          this.put(owner, { ...r, state: 'partial', failures: (r.failures ?? 0) + (counted ? 1 : 0) });
        } catch (e) {
          // Memory keeps the record (it was written as reserved); a restart turns it partial.
          this.o.onWriteFailed?.('fail', e);
        }
        end();
      },
      release: () => {
        if (finished) return;
        try {
          // A new reservation goes; a resumed one returns to what it was. Nothing ran, nothing landed.
          this.put(owner, prior);
        } catch (e) {
          // Memory keeps the reservation as written; it is resumable (not active) until a restart.
          this.o.onWriteFailed?.('release', e);
        }
        end();
      },
    };
  }
}

/** Create the lock file exclusively: its descriptor, or null when it already exists (EEXIST). */
function createExclusive(path: string): number | null {
  try {
    return openSync(path, 'wx', 0o600);
  } catch (e) {
    if (errnoCode(e) === 'EEXIST') return null;
    throw filesystemProblem('create its lock file', path, e);
  }
}

/** What an existing lock file says (its holder, and how long since it was touched), or null when it
 *  has gone meanwhile. A lock of an older relay holds a bare pid; this one's holds JSON. */
function readHolder(path: string): LockHolder | null {
  let raw: string;
  let ageMs: number;
  try {
    raw = readFileSync(path, 'utf8').trim();
    ageMs = Math.max(0, Date.now() - statSync(path).mtimeMs);
  } catch (e) {
    if (errnoCode(e) === 'ENOENT') return null;
    throw filesystemProblem('read its lock file', path, e);
  }
  if (raw.startsWith('{')) {
    try {
      const j = JSON.parse(raw) as { pid?: unknown; host?: unknown; token?: unknown };
      return {
        raw,
        pid: Number.isInteger(j.pid) ? (j.pid as number) : null,
        ...(typeof j.host === 'string' ? { host: j.host } : {}),
        ...(typeof j.token === 'string' ? { token: j.token } : {}),
        ageMs,
      };
    } catch {
      return { raw, pid: null, ageMs };
    }
  }
  const pid = Number(raw);
  return { raw, pid: raw !== '' && Number.isInteger(pid) ? pid : null, ageMs };
}

/** A lock's holder for the error message: "1 on host abc" for this relay's locks, else the text. */
function describeHolder(h: LockHolder): string {
  if (h.host !== undefined && h.pid !== null) return `${h.pid} on host ${h.host}`;
  return h.raw;
}

function held(path: string, holder: string): ClaimsStoreError {
  return new ClaimsStoreError(
    `the demo-token claims file is in use by another relay (lock ${path}, holder ${holder || 'unknown'}). ` +
      'One relay per data dir: stop the other relay or give this one its own RELAY_DATA_DIR. ' +
      `If no other relay uses this data dir, the lock is left over: remove ${path} and start again.`,
    'held',
    path,
    'EEXIST',
  );
}

function errnoCode(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'unknown';
}

/** The relay's own uid and gid, as the kernel sees them. */
function relayIds(): { uid: number | null; gid: number | null } {
  return { uid: process.getuid?.() ?? null, gid: process.getgid?.() ?? null };
}

/** Who owns a path, and its mode ("owned by uid 1000 gid 1000, mode 700"), or why it is unknown. */
function ownership(path: string): string {
  try {
    const st = statSync(path);
    return `${path} is owned by uid ${st.uid} gid ${st.gid}, mode ${(st.mode & 0o7777).toString(8)}`;
  } catch (e) {
    return `${path} cannot be inspected (${errnoCode(e)})`;
  }
}

/**
 * A data-dir failure described as what it is: what the store was doing, the path, the errno, the
 * relay's uid/gid, who owns the directory, and the fix for the usual causes.
 */
function filesystemProblem(action: string, path: string, e: unknown, dir = dirname(path)): ClaimsStoreError {
  const code = errnoCode(e);
  // Node's text repeats the code ("EACCES: permission denied, open '…'"): keep what follows it.
  const detail = (e instanceof Error ? e.message : String(e)).replace(`${code}: `, '');
  const { uid, gid } = relayIds();
  const who = uid === null ? 'the relay' : `uid ${uid} gid ${gid}`;
  let fix: string;
  switch (code) {
    case 'EACCES':
    case 'EPERM':
      fix =
        `make ${dir} writable by ${who}. With deploy/compose.yml, set RELAY_USER to the relay's uid:gid; the ` +
        'relay-data-init service hands the relay-data volume to that user at every start (deploy/RUNBOOK.md ' +
        `section 3). On a host, chown -R ${uid ?? '<uid>'}:${gid ?? '<gid>'} ${dir} (deploy/SYSTEMD.md).`;
      break;
    case 'EROFS':
      fix =
        `${dir} is on a read-only file system: mount a writable volume at RELAY_DATA_DIR (compose.yml mounts ` +
        'relay-data there; under systemd, list it in ReadWritePaths).';
      break;
    case 'ENOSPC':
    case 'EDQUOT':
      fix = `free space on the file system that holds ${dir}.`;
      break;
    case 'ENOTDIR':
    case 'ENOENT':
    case 'EEXIST':
      fix = `set RELAY_DATA_DIR to a directory (${dir} is not one, or cannot be created).`;
      break;
    default:
      fix = `check RELAY_DATA_DIR (${dir}) and its file system.`;
  }
  return new ClaimsStoreError(
    `the demo-token claims store cannot ${action} (${path}): ${code} (${detail}). ` +
      `The relay runs as ${who}; ${ownership(dir)}. Fix: ${fix}`,
    'filesystem',
    path,
    code,
  );
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as { code?: string }).code === 'EPERM';
  }
}
