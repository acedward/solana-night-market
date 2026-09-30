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
// A claim is RESERVED at admission (before any queue slot), CONFIRMED when its job succeeds and
// RELEASED when the route refuses it after admission or its job fails, so a failed pack can be
// claimed again. A reservation found on disk at start (the relay stopped mid-job) is released, with
// a warning: faucet tokens cost nothing, so a second attempt is harmless, and a stuck reservation
// would lock the key out for good.
//
// What it holds is public: the owner key (its Solana address is public), the account, the times and
// the transaction ids.

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
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

const DAY_SECONDS = 86_400;
const FORMAT = 'night-market-demo-token-claims/1';

export interface ClaimRecord {
  /** The owner's device key (64 lowercase hex). */
  owner: string;
  /** The account the pack went to (64 lowercase hex). */
  account: string;
  state: 'reserved' | 'claimed';
  /** Unix seconds of the reservation. */
  at: number;
  /** Unix seconds of the confirmation. */
  claimedAt?: number;
  /** Public transaction ids of the pack. */
  txs?: string[];
}

export type ReserveOutcome =
  | { ok: true; release: () => void; confirm: (txs: string[]) => void }
  | { ok: false; code: 'already-claimed' | 'daily-cap'; reason: string };

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
  now?: () => number;
  /** Told about a reservation released at start. */
  onRecovered?: (count: number) => void;
}

export class DemoTokenClaims {
  private readonly now: () => number;
  private readonly byOwner = new Map<string, ClaimRecord>();
  private lockFile: string | null = null;

  constructor(private readonly o: ClaimsOptions) {
    this.now = o.now ?? (() => Math.floor(Date.now() / 1000));
    if (o.file) this.load(o.file);
  }

  /**
   * Take the data dir's lock (one relay per claims file). Throws a ClaimsStoreError: `held` when
   * another live process holds it, `filesystem` when the lock cannot be created at all.
   */
  lock(): void {
    if (!this.o.file || this.lockFile) return;
    const path = `${this.o.file}.lock`;
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
          writeSync(fd, `${process.pid}\n`);
        } catch (e) {
          closeSync(fd);
          rmSync(path, { force: true });
          throw filesystemProblem('write its lock file', path, e);
        }
        closeSync(fd);
        this.lockFile = path;
        return;
      }
      // The lock file exists (EEXIST): who holds it?
      const holder = readHolder(path);
      if (holder === null) continue; // released meanwhile
      // A lock left by a process that no longer exists is stale (a crash), and so is one holding our
      // own pid (a restarted container: the relay has the same pid again): take it over. The lock
      // guards against a second relay on this host; relays in separate containers sharing one data
      // volume cannot see each other's pids, so the RUNBOOK says one relay per data dir.
      const pid = Number(holder);
      if (Number.isInteger(pid) && pid > 0 && (pid === process.pid || !processAlive(pid))) {
        try {
          rmSync(path, { force: true });
        } catch (e) {
          throw filesystemProblem('remove a stale lock file', path, e);
        }
        continue;
      }
      throw held(path, holder);
    }
    throw held(path, readHolder(path) ?? '');
  }

  unlock(): void {
    if (this.lockFile) rmSync(this.lockFile, { force: true });
    this.lockFile = null;
  }

  private load(file: string): void {
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
    let recovered = 0;
    for (const c of parsed.claims) {
      if (!/^[0-9a-f]{64}$/.test(c.owner) || !/^[0-9a-f]{64}$/.test(c.account)) continue;
      if (c.state === 'reserved') {
        recovered++;
        continue;
      }
      this.byOwner.set(c.owner, c);
    }
    if (recovered > 0) {
      this.o.onRecovered?.(recovered);
      try {
        this.persist();
      } catch (e) {
        throw filesystemProblem('rewrite its claims file', file, e);
      }
    }
  }

  private persist(): void {
    const file = this.o.file;
    if (!file) return;
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const body = `${JSON.stringify({ format: FORMAT, claims: [...this.byOwner.values()] }, null, 1)}\n`;
    const tmp = join(dirname(file), `.${process.pid}.${Date.now()}.claims.tmp`);
    const fd = openSync(tmp, 'w', 0o600);
    try {
      writeSync(fd, body);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, file);
  }

  /** Claims (reserved or confirmed) in the last 24 hours. */
  claimedToday(): number {
    const since = this.now() - DAY_SECONDS;
    let n = 0;
    for (const c of this.byOwner.values()) if (c.at > since) n++;
    return n;
  }

  remainingToday(): number {
    return Math.max(0, this.o.dailyCap - this.claimedToday());
  }

  /** Whether a key has claimed (or is claiming). */
  hasClaimed(owner: string): boolean {
    return this.byOwner.has(owner.toLowerCase());
  }

  /** Reserve the pack for `owner` → `account`: once per key, within the daily cap. Synchronous. */
  reserve(ownerRaw: string, accountRaw: string): ReserveOutcome {
    const owner = ownerRaw.replace(/^0x/, '').toLowerCase();
    const account = accountRaw.replace(/^0x/, '').toLowerCase();
    const prior = this.byOwner.get(owner);
    if (prior) {
      return {
        ok: false,
        code: 'already-claimed',
        reason:
          prior.state === 'claimed'
            ? 'this wallet has already received its demo tokens'
            : 'this wallet is already receiving its demo tokens',
      };
    }
    if (this.claimedToday() >= this.o.dailyCap) {
      return {
        ok: false,
        code: 'daily-cap',
        reason: "the market has given out today's demo tokens; try again tomorrow",
      };
    }
    const record: ClaimRecord = { owner, account, state: 'reserved', at: this.now() };
    this.byOwner.set(owner, record);
    this.persist();
    let settled = false;
    return {
      ok: true,
      release: () => {
        if (settled) return;
        settled = true;
        if (this.byOwner.get(owner) === record) {
          this.byOwner.delete(owner);
          this.persist();
        }
      },
      confirm: (txs: string[]) => {
        if (settled) return;
        settled = true;
        record.state = 'claimed';
        record.claimedAt = this.now();
        record.txs = [...txs];
        this.persist();
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

/** The pid written in an existing lock file ('' when empty), or null when it has gone meanwhile. */
function readHolder(path: string): string | null {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch (e) {
    if (errnoCode(e) === 'ENOENT') return null;
    throw filesystemProblem('read its lock file', path, e);
  }
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
