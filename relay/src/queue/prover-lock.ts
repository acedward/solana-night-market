// The prover lane's lock: deadline- and usage-aware (AA 00047 P11.F, audit round 4 R4-1 / F-A4-1).
//
// Round 4 found that about 6 accounts, each with ONE queued withdrawal, made every customer's take
// expire before its job started. A take is signed for a few minutes, and the round-robin lane of P10
// (R2-1) put it behind one job of every other account that had work waiting (a stagenet withdrawal
// holds the lane for about 44 s). The lock now picks the next job in three steps:
//
//   1. RANK. Jobs that carry a SIGNED deadline go first: takes (rank 0), then makes (rank 1), then the
//      jobs without one (rank 2: withdrawals, inbox filings, cancels, key restores, registrations, demo
//      tokens). So that a flood of deadline-bound jobs can never starve the rest, a lower rank that has
//      waited through `burst` grants in a row to higher ranks gets the next turn: withdrawals always
//      move (at least one turn in `burst + 1` under any flood).
//   2. FAIRNESS within a rank (kept from P10): each key's jobs run in order, and the job at the head of
//      a key's queue is passed by each other key's job OF ITS RANK at most ONCE while it waits. So within
//      its rank a job waits behind at most one job of each other key, exactly the round-robin bound of
//      P10. (Passes across ranks are bounded by step 1's `burst` instead: a customer's take that went
//      ahead of the withdrawals does not put the customer's next withdrawal behind all of them.)
//   3. USAGE within a rank: among the heads step 2 allows, the key that was granted the lane FEWER times
//      in the last `usageWindowSeconds` goes first; then the earlier signed deadline; then the earlier
//      arrival. A customer who rarely uses the market goes ahead of accounts that keep the lane busy.
//      (Not the deadline first: a requester chooses its own deadline, so an earliest-deadline order
//      would let anyone jump the queue by signing a short one.)
//
// The lock also ESTIMATES when a job would start (`estimateWaitMs`): it runs the same choice over the
// current waiters, adding each one's expected hold (an average of that action's recent holds, seeded
// with `defaultHoldSeconds`) after what is left of the holder's. The route refuses a take whose signed
// deadline the queue cannot reach, before it costs anything (../app.ts, `prover-busy`), and the job
// view's `position` is the place in that same order. An expected hold never drops below
// `holdFloorSeconds` (AA 00047 P11.F2, audit round 4b R4b-3 / F-A4b-3, questions Q64): a few very short
// holds (a take refused before its proof holds the lane for a moment) would otherwise pull the average
// down, so that a crowd of takes looked short and a take was admitted only to expire in the queue.
//
// The keys are the jobs' fair keys (`account:<address>`, or `action:<name>` without an account,
// ./jobs.ts). With the route's one-job-per-account rule (../actions/account-gate.ts) a key has at most
// one job waiting, so "each other key" is "each other account".

/** 0: a take (signed deadline, short); 1: a make (signed deadline, an hour); 2: no deadline. */
export type ProverRank = 0 | 1 | 2;

export const PROVER_RANKS: readonly ProverRank[] = [0, 1, 2];

/** What the lock knows of a job that wants the prover. */
export interface ProverTicket {
  /** The job's request id. */
  id: string;
  /** Its fair key. */
  key: string;
  rank: ProverRank;
  /** Its signed deadline (Unix seconds), when it has one (shown only; never the order's first key). */
  deadline?: number;
  /** Its action, for the expected hold. */
  action: string;
}

export interface ProverLockOptions {
  /** Milliseconds now (tests scale it). Default Date.now. */
  nowMs?: () => number;
  /** How far back "recent" use counts (seconds; default 3600). */
  usageWindowSeconds?: number;
  /** Grants in a row to higher ranks after which a waiting lower rank gets a turn (default 4). */
  burst?: number;
  /** The expected hold of an action never seen yet (seconds; default 60). */
  defaultHoldSeconds?: number;
  /** The least expected hold of any action, whatever its recent holds (seconds; default
   *  `DEFAULT_HOLD_FLOOR_SECONDS`, 45: a stagenet take or withdrawal; R4b-3). */
  holdFloorSeconds?: number;
  /** Keys whose use is remembered (least recently granted forgotten first; default 100,000). */
  maxKeys?: number;
}

interface Waiter extends ProverTicket {
  /** Arrival order. */
  seq: number;
  grant: () => void;
}

/** The job at the head of a key's queue. */
interface Head {
  w: Waiter;
  /** When it became its key's head (the board's counter). */
  since: number;
  /** The keys granted the lane for a job of this head's rank since it became its key's head: none
   *  may pass it again within the rank. */
  passedBy: Set<string>;
}

/** The part of the lock's state the choice reads; copied for an estimate. */
interface Board {
  heads: Map<string, Head>;
  /** Each key's waiters behind its head, oldest first. */
  tails: Map<string, Waiter[]>;
  /** Per rank: how many of that rank's heads each key has passed (a key is blocked in a rank while > 0). */
  blocked: Array<Map<string, number>>;
  /** Per rank: grants in a row to higher ranks while this rank had heads. */
  starved: number[];
  /** Grants per key in the usage window. */
  usage: Map<string, number>;
  /** Counts heads as they become heads. */
  clock: number;
}

const EWMA_WEIGHT = 0.3;

/** The default floor under every expected hold (seconds): a take or a withdrawal on stagenet holds the
 *  lane about 44–45 s (AA 00047 P11.F2, R4b-3; RUNBOOK section 9 `PROVER_JOB_ESTIMATE_FLOOR_SECONDS`). */
export const DEFAULT_HOLD_FLOOR_SECONDS = 45;

export class ProverLock {
  private readonly nowMs: () => number;
  private readonly windowMs: number;
  private readonly burst: number;
  private readonly defaultHoldMs: number;
  private readonly holdFloorMs: number;
  private readonly maxKeys: number;
  private holder: { id: string; key: string; action: string; since: number; deadline?: number } | null = null;
  private readonly board: Board = {
    heads: new Map(),
    tails: new Map(),
    blocked: [new Map(), new Map(), new Map()],
    starved: [0, 0, 0],
    usage: new Map(),
    clock: 0,
  };
  /** Grant times per key, oldest first (the usage window). */
  private readonly grants = new Map<string, number[]>();
  /** Expected hold per action (ms; a moving average of observed holds). */
  private readonly holds = new Map<string, number>();
  private seq = 0;

  constructor(options: ProverLockOptions = {}) {
    this.nowMs = options.nowMs ?? Date.now;
    this.windowMs = (options.usageWindowSeconds ?? 3600) * 1000;
    this.burst = Math.max(1, options.burst ?? 4);
    this.defaultHoldMs = (options.defaultHoldSeconds ?? 60) * 1000;
    this.holdFloorMs = Math.max(0, options.holdFloorSeconds ?? DEFAULT_HOLD_FLOOR_SECONDS) * 1000;
    this.maxKeys = options.maxKeys ?? 100_000;
  }

  /** Wait for the lock; resolves to its release function. */
  acquire(ticket: ProverTicket): Promise<() => void> {
    return new Promise((resolve) => {
      const w: Waiter = {
        ...ticket,
        seq: this.seq++,
        grant: () => {
          let released = false;
          resolve(() => {
            if (released) return;
            released = true;
            this.release(w.id);
          });
        },
      };
      if (this.holder === null && this.board.heads.size === 0) {
        this.start(w);
        return;
      }
      enqueue(this.board, w);
    });
  }

  private start(w: Waiter): void {
    const now = this.nowMs();
    this.holder = {
      id: w.id,
      key: w.key,
      action: w.action,
      since: now,
      ...(w.deadline !== undefined ? { deadline: w.deadline } : {}),
    };
    this.noteGrant(w.key, now);
    w.grant();
  }

  private release(id: string): void {
    if (this.holder?.id !== id) return;
    const held = this.nowMs() - this.holder.since;
    const prev = this.holds.get(this.holder.action) ?? this.defaultHoldMs;
    this.holds.set(this.holder.action, prev + EWMA_WEIGHT * (Math.max(0, held) - prev));
    this.holder = null;
    if (this.board.heads.size === 0) return;
    this.refreshUsage();
    const next = choose(this.board, this.burst);
    granted(this.board, next);
    this.start(next);
  }

  /** Record a grant of `key` (its usage window). */
  private noteGrant(key: string, now: number): void {
    const list = this.grants.get(key) ?? [];
    list.push(now);
    this.grants.delete(key); // re-insert: Map order doubles as least-recently-granted order
    this.grants.set(key, list);
    while (this.grants.size > this.maxKeys) {
      const oldest = this.grants.keys().next().value;
      if (oldest === undefined) break;
      this.grants.delete(oldest);
    }
  }

  /** Bring the board's usage counts to now (old grants leave the window). */
  private refreshUsage(): void {
    const since = this.nowMs() - this.windowMs;
    this.board.usage.clear();
    for (const [key, list] of this.grants) {
      while (list.length > 0 && list[0]! <= since) list.shift();
      if (list.length === 0) this.grants.delete(key);
      else this.board.usage.set(key, list.length);
    }
  }

  /** The expected hold of `action` (ms): its moving average (the seed until measured), never below the
   *  floor (R4b-3). */
  expectedHoldMs(action: string): number {
    return Math.max(this.holdFloorMs, this.holds.get(action) ?? this.defaultHoldMs);
  }

  /** Grants of `key` in the usage window (for operators and tests). */
  usage(key: string): number {
    this.refreshUsage();
    return this.board.usage.get(key) ?? 0;
  }

  /**
   * About how long until a job would START (ms): what is left of the holder's expected hold, plus the
   * expected holds of every job the lock would choose before it, if nothing else arrived. `ticket` is a
   * waiting job (by id), or a job not queued yet (it would join its key's queue now).
   */
  estimateWaitMs(ticket: Omit<ProverTicket, 'id'> & { id?: string }): number {
    const order = this.simulate(ticket);
    return order === null ? 0 : order.waitMs;
  }

  /**
   * 1-based place of a waiter in the order the lock would serve the CURRENT waiters; 0 for the holder;
   * undefined if unknown.
   */
  position(id: string): number | undefined {
    if (this.holder?.id === id) return 0;
    let found = false;
    for (const h of this.board.heads.values()) if (h.w.id === id) found = true;
    if (!found) for (const t of this.board.tails.values()) if (t.some((w) => w.id === id)) found = true;
    if (!found) return undefined;
    const r = this.simulate({ id });
    return r === null ? undefined : r.place;
  }

  /** Run the choice over a copy of the board until `target` is chosen. */
  private simulate(
    target: { id: string } | (Omit<ProverTicket, 'id'> & { id?: string }),
  ): { place: number; waitMs: number } | null {
    this.refreshUsage();
    const b = copyBoard(this.board);
    let id = target.id;
    if (id === undefined || !isWaiting(b, id)) {
      if (!('key' in target)) return null;
      id = id ?? `estimate:${this.seq}`;
      enqueue(b, { ...target, id, seq: this.seq, grant: () => {} });
    }
    let waitMs = this.holder
      ? Math.max(0, this.expectedHoldMs(this.holder.action) - (this.nowMs() - this.holder.since))
      : 0;
    for (let place = 1; b.heads.size > 0; place++) {
      const next = choose(b, this.burst);
      if (next.id === id) return { place, waitMs };
      waitMs += this.expectedHoldMs(next.action);
      granted(b, next);
      b.usage.set(next.key, (b.usage.get(next.key) ?? 0) + 1);
    }
    return null;
  }

  get running(): number {
    return this.holder === null ? 0 : 1;
  }

  get waiting(): number {
    let n = this.board.heads.size;
    for (const t of this.board.tails.values()) n += t.length;
    return n;
  }

  get idle(): boolean {
    return this.holder === null && this.board.heads.size === 0;
  }
}

// ── the choice (pure over a board; the lock and its estimates share it) ─────────────────────────

function enqueue(b: Board, w: Waiter): void {
  if (!b.heads.has(w.key)) {
    b.heads.set(w.key, { w, since: b.clock++, passedBy: new Set() });
    return;
  }
  const tail = b.tails.get(w.key);
  if (tail) tail.push(w);
  else b.tails.set(w.key, [w]);
}

function isWaiting(b: Board, id: string): boolean {
  for (const h of b.heads.values()) if (h.w.id === id) return true;
  for (const t of b.tails.values()) if (t.some((w) => w.id === id)) return true;
  return false;
}

/** The waiter to grant next (the board has at least one head). */
function choose(b: Board, burst: number): Waiter {
  const ranks = new Set<ProverRank>();
  for (const h of b.heads.values()) ranks.add(h.w.rank);
  // 1. The rank: the highest with heads, unless a lower one waited through `burst` grants in a row.
  let rank: ProverRank = ranks.has(0) ? 0 : ranks.has(1) ? 1 : 2;
  for (const r of [2, 1] as const) {
    if (r > rank && ranks.has(r) && b.starved[r]! >= burst) {
      rank = r;
      break;
    }
  }
  // 2 and 3. Among this rank's heads that no other head of the rank has been passed by already: the
  // fewest recent grants, then the earlier deadline, then the earlier arrival.
  let best: Head | null = null;
  let oldest: Head | null = null;
  const blocked = b.blocked[rank]!;
  for (const h of b.heads.values()) {
    if (h.w.rank !== rank) continue;
    if (!oldest || h.since < oldest.since) oldest = h;
    if ((blocked.get(h.w.key) ?? 0) > 0) continue;
    if (!best || before(b, h, best)) best = h;
  }
  // The longest-standing head is never blocked (a key that passed a head was granted after that head
  // became a head, and its own head came after that grant); `oldest` is only a guard.
  return (best ?? oldest)!.w;
}

function before(b: Board, x: Head, y: Head): boolean {
  const ux = b.usage.get(x.w.key) ?? 0;
  const uy = b.usage.get(y.w.key) ?? 0;
  if (ux !== uy) return ux < uy;
  const dx = x.w.deadline ?? Number.POSITIVE_INFINITY;
  const dy = y.w.deadline ?? Number.POSITIVE_INFINITY;
  if (dx !== dy) return dx < dy;
  return x.w.seq < y.w.seq;
}

/** Update the board for a grant of `w` (a head): it leaves, its key's next job becomes the head, every
 *  other head of its rank records that `w`'s key passed it, and the lower ranks count the grant. */
function granted(b: Board, w: Waiter): void {
  const head = b.heads.get(w.key)!;
  for (const k of head.passedBy) decrement(b.blocked[w.rank]!, k);
  b.heads.delete(w.key);
  const tail = b.tails.get(w.key);
  if (tail && tail.length > 0) {
    b.heads.set(w.key, { w: tail.shift()!, since: b.clock++, passedBy: new Set() });
    if (tail.length === 0) b.tails.delete(w.key);
  }
  const waitingRanks = new Set<ProverRank>();
  for (const [key, h] of b.heads) {
    waitingRanks.add(h.w.rank);
    if (key === w.key || h.w.rank !== w.rank || h.passedBy.has(w.key)) continue;
    h.passedBy.add(w.key);
    const m = b.blocked[h.w.rank]!;
    m.set(w.key, (m.get(w.key) ?? 0) + 1);
  }
  for (const r of PROVER_RANKS) {
    if (r === w.rank) b.starved[r] = 0;
    else if (r > w.rank && waitingRanks.has(r)) b.starved[r] = b.starved[r]! + 1;
  }
}

function decrement(m: Map<string, number>, k: string): void {
  const n = (m.get(k) ?? 0) - 1;
  if (n > 0) m.set(k, n);
  else m.delete(k);
}

function copyBoard(b: Board): Board {
  const heads = new Map<string, Head>();
  for (const [k, h] of b.heads) heads.set(k, { w: h.w, since: h.since, passedBy: new Set(h.passedBy) });
  const tails = new Map<string, Waiter[]>();
  for (const [k, t] of b.tails) tails.set(k, [...t]);
  return {
    heads,
    tails,
    blocked: b.blocked.map((m) => new Map(m)),
    starved: [...b.starved],
    usage: new Map(b.usage),
    clock: b.clock,
  };
}
