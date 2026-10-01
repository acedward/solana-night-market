// A failure budget per owner and per account (AA 00047 P9, audit C4 / F-A3; P10, audit round 2
// R2-2: F-A2-2, F-B2-3).
//
// A job that fails gives its authorisation back (the replay guard forgets a gated call's digest), so
// an honest customer can send the same approval again after a transient failure. That also made a
// failing call free to repeat: a signed call that fails at proving time (a coin not in the tree, a
// spent coin) costs the relay its one prover lane every time. So every job that FAILS AFTER IT
// STARTED PROVING, FOR A REASON THE REQUESTER CAUSED, counts against its owner (the signing device
// key) and its account, in a rolling 24 hours, and an owner or account past its budget is refused
// (429 `failure-budget`) until the oldest failure is a day old. What does NOT count (round 2):
//   - the market's own failures (no prover keys, the exchange unreachable or at its cap, no sponsor);
//   - a COUNTERPARTY's: a take whose maker cancelled the offer or let it expire is refused by the
//     batcher (`exchange-error`, `take-refused`), or the merge refuses the maker's offer (`take-*`),
//     or the offer is gone (F-A2-2: a maker who cancels must not lock takers out);
//   - an INFRASTRUCTURE crash: the proof server, the node or the indexer failed or was unreachable
//     (plan R7: the prover is restarted when its memory runs out), which the relay reports to the
//     customer as `market-unavailable`;
//   - refusals before any proof (they cost nothing).
// The budget is checked at admission AND again when the job reaches its lane (F-B2-3: jobs queued
// before the fifth failure must not still run after it; the refused job's reservations are given
// back). Withdrawals, unshielded withdrawals, cancels and key restores are NEVER refused by it
// (`BUDGET_EXEMPT_ACTIONS`): a customer can always take their funds out and end their approvals.
// Their failures still count against the owner and the account, for the other actions.

import type { RelayActionName } from '@nightmarket/core';

const DAY_SECONDS = 86_400;

/** Job errors that are the market's own doing, never the caller's. */
export const MARKET_SIDE_FAILURES: ReadonlySet<string> = new Set([
  'not-available',
  'exchange-unavailable',
  'exchange-busy',
  'sponsor-unavailable',
  'market-unavailable',
  'chain-unavailable',
  'demo-tokens-settling',
]);

/** Job errors caused by the other side of a trade (a maker who cancelled, an offer that expired or
 *  was taken), never the requester's (AA 00047 P10, F-A2-2). Every `take-*` code is one too: the merge
 *  refusing the maker's offer. */
export const COUNTERPARTY_FAILURES: ReadonlySet<string> = new Set(['exchange-error', 'take-refused', 'offer-gone']);

/** The actions the budget never refuses (AA 00047 P10, R2-2): taking funds out and ending approvals. */
export const BUDGET_EXEMPT_ACTIONS: ReadonlySet<RelayActionName> = new Set<RelayActionName>([
  'withdraw',
  'withdraw-unshielded',
  'cancel-offers',
  'restore-enc-key',
]);

/**
 * An infrastructure error: thrown where the relay talks to the proof server, the node or the indexer
 * and the other side failed or could not be reached. Never the requester's doing.
 */
export class InfrastructureError extends Error {
  override name = 'InfrastructureError';
  readonly infrastructure = true;
}

/** What an infrastructure failure's text looks like when a library reports it (the proof server's
 *  HTTP failure or a dropped connection, through midnight-js or the ledger's WASM). */
const INFRASTRUCTURE_TEXT =
  /Failed Proof Server response: .*code="5\d\d"|proof server could not be reached|fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE|EAI_AGAIN|socket hang up|socket connection was closed|Unable to connect|network error|WebSocket (is )?(closed|not open)|The operation timed out|AbortError|TimeoutError/i;

/** Whether `error` (or any error in its `cause` chain) is an infrastructure failure. */
export function isInfrastructureFailure(error: unknown): boolean {
  let e: unknown = error;
  for (let depth = 0; depth < 8 && e; depth++) {
    const o = e as { infrastructure?: unknown; name?: unknown; message?: unknown; code?: unknown; cause?: unknown };
    if (o.infrastructure === true) return true;
    if (
      typeof o.code === 'string' &&
      /^(ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE|EAI_AGAIN|ConnectionRefused)$/.test(o.code)
    )
      return true;
    if (typeof o.message === 'string' && INFRASTRUCTURE_TEXT.test(o.message)) return true;
    e = o.cause;
  }
  return false;
}

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

/** Whether a job error code is the market's, a counterparty's, or an infrastructure failure's. */
export function isNotRequesterCode(code: string): boolean {
  return MARKET_SIDE_FAILURES.has(code) || COUNTERPARTY_FAILURES.has(code) || code.startsWith('take-');
}

/** Whether a job's error counts against the caller's budget (see the header). */
export function countsAgainstBudget(error: unknown, proved: boolean): boolean {
  if (!proved) return false;
  const e = error as { name?: unknown; code?: unknown } | null;
  // A PublicError is the relay's own verdict: its code says whose failure it is.
  if (e?.name === 'PublicError' && typeof e.code === 'string') return !isNotRequesterCode(e.code);
  return !isInfrastructureFailure(error);
}
