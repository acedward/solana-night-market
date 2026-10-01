// A failure budget per owner and per account (AA 00047 P9, audit C4 / F-A3).
//
// A job that fails gives its authorisation back (the replay guard forgets a gated call's digest), so
// an honest customer can send the same approval again after a transient failure. That also made a
// failing call free to repeat: a signed call that fails at proving time (a coin not in the tree, a
// take of an offer that cannot settle) costs the relay its one prover lane every time. So every job
// that FAILS AFTER IT STARTED PROVING counts against its owner (the signing device key) and its
// account, in a rolling 24 hours, and an owner or account past its budget is refused at admission
// (429 `failure-budget`) until the oldest failure is a day old. Failures that are the market's own
// (no prover keys, the exchange unreachable or at its cap) do not count, and neither do refusals
// before any proof (they cost nothing).

const DAY_SECONDS = 86_400;

/** Job errors that are the market's own doing, never the caller's. */
export const MARKET_SIDE_FAILURES: ReadonlySet<string> = new Set([
  'not-available',
  'exchange-unavailable',
  'exchange-busy',
  'sponsor-unavailable',
]);

export interface FailureBudgetOptions {
  /** Failures allowed per owner (device key) in any rolling 24 hours. */
  perOwner: number;
  /** Failures allowed per account in any rolling 24 hours. */
  perAccount: number;
  now?: () => number;
  /** Bound on the keys remembered (oldest forgotten first). */
  maxKeys?: number;
}

export class FailureBudget {
  private readonly now: () => number;
  private readonly owners = new Map<string, number[]>();
  private readonly accounts = new Map<string, number[]>();

  constructor(private readonly o: FailureBudgetOptions) {
    this.now = o.now ?? (() => Math.floor(Date.now() / 1000));
  }

  /** Record one failure of a job by `owner` on `account`. */
  record(owner: string, account?: string): void {
    const now = this.now();
    this.add(this.owners, owner.toLowerCase(), now);
    if (account) this.add(this.accounts, account.toLowerCase(), now);
  }

  /** Whether `owner` (and `account`) may still run a job; when not, how long until they may. */
  check(owner: string, account?: string): { ok: true } | { ok: false; retryAfterSeconds: number; reason: string } {
    const now = this.now();
    const o = this.recent(this.owners, owner.toLowerCase(), now);
    if (o.length >= this.o.perOwner) {
      return {
        ok: false,
        retryAfterSeconds: Math.max(1, o[0]! + DAY_SECONDS - now),
        reason: `this wallet's requests failed ${o.length} times in the last 24 hours, the most the market allows; try again later`,
      };
    }
    if (account) {
      const a = this.recent(this.accounts, account.toLowerCase(), now);
      if (a.length >= this.o.perAccount) {
        return {
          ok: false,
          retryAfterSeconds: Math.max(1, a[0]! + DAY_SECONDS - now),
          reason: `this account's requests failed ${a.length} times in the last 24 hours, the most the market allows; try again later`,
        };
      }
    }
    return { ok: true };
  }

  /** Failures of `owner` in the last 24 hours. */
  failures(owner: string): number {
    return this.recent(this.owners, owner.toLowerCase(), this.now()).length;
  }

  private recent(map: Map<string, number[]>, key: string, now: number): number[] {
    const list = map.get(key);
    if (!list) return [];
    while (list.length > 0 && list[0]! <= now - DAY_SECONDS) list.shift();
    if (list.length === 0) map.delete(key);
    return list;
  }

  private add(map: Map<string, number[]>, key: string, now: number): void {
    const list = this.recent(map, key, now);
    list.push(now);
    map.delete(key); // re-insert: Map order doubles as least-recently-used order
    map.set(key, list);
    const max = this.o.maxKeys ?? 100_000;
    while (map.size > max) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }
}

/** Whether a job's error counts against the caller's budget (see the header). */
export function countsAgainstBudget(error: unknown, proved: boolean): boolean {
  if (!proved) return false;
  const code = (error as { code?: unknown } | null)?.code;
  return !(typeof code === 'string' && MARKET_SIDE_FAILURES.has(code));
}
