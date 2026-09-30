// The demo-token claims store (spec FR-007): the relay's ONLY persistent state. One record per
// Solana key that claimed, so a key gets the pack once, ever, and a rolling 24-hour count of claims
// for the daily cap.
//
// A JSON file under RELAY_DATA_DIR (`demo-token-claims.json`), rewritten atomically on every change
// (a temporary file, fsync, rename), so a crash leaves either the old or the new file, never a torn
// one. Concurrency: every decision (`reserve`) is synchronous, and the relay is one process, so two
// requests racing for the same key or the last slot of the day cannot both pass; a second relay on
// the same data dir is refused at start by an exclusive lock file.
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

  /** Take the data dir's lock (one relay per claims file). Throws when another process holds it. */
  lock(): void {
    if (!this.o.file || this.lockFile) return;
    const path = `${this.o.file}.lock`;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    let fd: number;
    try {
      fd = openSync(path, 'wx', 0o600);
    } catch {
      let holder = 'unknown';
      try {
        holder = readFileSync(path, 'utf8').trim();
      } catch {
        /* unreadable */
      }
      // A lock left by a process that no longer exists is stale (a crash), and so is one holding our
      // own pid (a restarted container: the relay is pid 1 again): take it over. The lock guards
      // against a second relay on this host; relays in separate containers sharing one data volume
      // cannot see each other's pids, so the RUNBOOK says one relay per data dir.
      const pid = Number(holder);
      if (Number.isInteger(pid) && pid > 0 && (pid === process.pid || !processAlive(pid))) {
        rmSync(path, { force: true });
        fd = openSync(path, 'wx', 0o600);
      } else {
        throw new Error(`the demo-token claims file is in use by another relay (lock ${path}, holder ${holder})`);
      }
    }
    writeSync(fd, `${process.pid}\n`);
    closeSync(fd);
    this.lockFile = path;
  }

  unlock(): void {
    if (this.lockFile) rmSync(this.lockFile, { force: true });
    this.lockFile = null;
  }

  private load(file: string): void {
    if (!existsSync(file)) return;
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { format?: string; claims?: ClaimRecord[] };
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
      this.persist();
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

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as { code?: string }).code === 'EPERM';
  }
}
