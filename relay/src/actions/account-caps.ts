// Per-account caps on offers, cancels and key restores (AA 00047 P10, audit round 2 R2-1 / F-A2-1).
//
// A make costs nothing to its maker (no DUST: a taker's batcher pays at settlement) and does not move
// the account's auth nonce, so one account with one coin could post offer after offer; a cancel and a
// key restore are sponsor-paid transactions that need no funds. So, per account, all configurable
// (deploy/RUNBOOK.md section 9):
//   - OPEN OFFERS: at most `OFFERS_MAX_OPEN_PER_ACCOUNT` offers this relay made for the account and
//     that may still settle. An offer stops counting when its signed expiry passes, when the account's
//     auth nonce moves past the one it was signed at (a cancel, a withdrawal: the chain then refuses
//     it), when its job fails, or when the exchange says it was taken or ended (asked only when the
//     account is at the cap). A make in flight counts;
//   - MAKES a day: `MAKES_PER_ACCOUNT_PER_DAY` admitted in any rolling 24 hours;
//   - CANCELS a day: `CANCELS_PER_ACCOUNT_PER_DAY` (`cancel-offers`, sponsor-paid);
//   - KEY RESTORES a day: `RESTORES_PER_ACCOUNT_PER_DAY` (`restore-enc-key`, sponsor-paid; its own
//     count: a restore never uses up the cancels).
// A charge is taken at admission (before any queue slot, proof or DUST) and given back when the route
// refuses the request after all, or when the job ends without the requester being at fault: it
// failed before proving, or for the market's, a counterparty's or the infrastructure's reason
// (./failure-budget.ts). The counters live in memory: a relay restart resets them (RUNBOOK).

import type { KernelOfferStatus } from '@nightmarket/core';

import type { AdmissionCheck, AdmissionOutcome, JobEnd } from './admission.js';

const DAY_SECONDS = 86_400;

export interface AccountCapsOptions {
  /** Offers that may still settle, per account. */
  maxOpenOffers: number;
  /** Makes admitted per account in any rolling 24 hours. */
  makesPerDay: number;
  /** Cancels admitted per account in any rolling 24 hours. */
  cancelsPerDay: number;
  /** Key restores admitted per account in any rolling 24 hours. */
  restoresPerDay: number;
  now?: () => number;
  /** The exchange's word on an offer (asked only when an account is at its open-offer cap). */
  offerStatus?: (offerId: string) => Promise<KernelOfferStatus>;
  /** Bound on the accounts remembered (least recently used forgotten first). */
  maxAccounts?: number;
}

interface OpenOffer {
  /** Unique per admitted make. */
  ticket: number;
  validUntil: bigint;
  authNonce: bigint;
  offerId?: string;
}

interface AccountRecord {
  offers: OpenOffer[];
  makes: number[];
  cancels: number[];
  restores: number[];
}

type DailyKind = 'cancels' | 'restores';

const ENDED: ReadonlySet<KernelOfferStatus> = new Set(['consumed', 'expired', 'cancelled', 'not_found']);

/** A daily charge is given back when the job ended without the requester being at fault. */
const refunded = (end: JobEnd) => !end.ok && (!end.proved || !end.requesterFault);

export class AccountCaps {
  private readonly now: () => number;
  private readonly accounts = new Map<string, AccountRecord>();
  private tickets = 0;

  constructor(private readonly o: AccountCapsOptions) {
    this.now = o.now ?? (() => Math.floor(Date.now() / 1000));
  }

  private record(account: string): AccountRecord {
    let r = this.accounts.get(account);
    if (r) {
      this.accounts.delete(account); // re-insert: Map order doubles as least-recently-used order
    } else {
      r = { offers: [], makes: [], cancels: [], restores: [] };
      const max = this.o.maxAccounts ?? 100_000;
      while (this.accounts.size >= max) {
        const oldest = this.accounts.keys().next().value;
        if (oldest === undefined) break;
        this.accounts.delete(oldest);
      }
    }
    this.accounts.set(account, r);
    return r;
  }

  private sweep(r: AccountRecord, now: number, currentNonce?: bigint): void {
    const since = now - DAY_SECONDS;
    for (const list of [r.makes, r.cancels, r.restores]) while (list.length > 0 && list[0]! <= since) list.shift();
    r.offers = r.offers.filter(
      (o) => o.validUntil > BigInt(now) && (currentNonce === undefined || o.authNonce >= currentNonce),
    );
  }

  /** Offers of `account` that may still settle (for operators and tests). */
  openOffers(accountRaw: string): number {
    const r = this.accounts.get(norm(accountRaw));
    if (!r) return 0;
    this.sweep(r, this.now());
    return r.offers.length;
  }

  /** Charges of `kind` for `account` in the last 24 hours (for operators and tests). */
  usedToday(accountRaw: string, kind: 'makes' | DailyKind): number {
    const r = this.accounts.get(norm(accountRaw));
    if (!r) return 0;
    this.sweep(r, this.now());
    return r[kind].length;
  }

  /**
   * Admit one make for `account`, signed at `authNonce` (the account's CURRENT nonce: the arm checked
   * it) and valid until `validUntil` (Unix seconds).
   */
  async admitMake(accountRaw: string, signed: { authNonce: string; validUntil: string }): Promise<AdmissionOutcome> {
    const account = norm(accountRaw);
    const now = this.now();
    const r = this.record(account);
    const authNonce = BigInt(signed.authNonce);
    this.sweep(r, now, authNonce);
    if (r.makes.length >= this.o.makesPerDay) {
      return refusal(
        'makes-daily-cap',
        `this account has made ${r.makes.length} offers in the last 24 hours, the most the market allows`,
        r.makes[0]! + DAY_SECONDS - now,
      );
    }
    if (r.offers.length >= this.o.maxOpenOffers && this.o.offerStatus) {
      // At the cap: ask the exchange which of the listed ones were taken or ended meanwhile.
      const listed = r.offers.filter((o) => o.offerId !== undefined);
      const ended = new Set<number>();
      await Promise.all(
        listed.map(async (o) => {
          try {
            if (ENDED.has(await this.o.offerStatus!(o.offerId!))) ended.add(o.ticket);
          } catch {
            /* the exchange could not be asked: the offer still counts */
          }
        }),
      );
      r.offers = r.offers.filter((o) => !ended.has(o.ticket));
    }
    if (r.offers.length >= this.o.maxOpenOffers) {
      const first = r.offers.reduce((m, o) => (o.validUntil < m ? o.validUntil : m), r.offers[0]!.validUntil);
      return refusal(
        'open-offers-cap',
        `this account has ${r.offers.length} open offers, the most the market lists at once; cancel them, or wait until one is taken or expires`,
        Number(first - BigInt(now)),
      );
    }
    const at = now;
    const offer: OpenOffer = { ticket: ++this.tickets, validUntil: BigInt(signed.validUntil), authNonce };
    r.makes.push(at);
    r.offers.push(offer);
    let done = false;
    const dropOffer = () => {
      r.offers = r.offers.filter((o) => o.ticket !== offer.ticket);
    };
    const refundMake = () => removeOne(r.makes, at);
    return {
      ok: true,
      release: () => {
        if (done) return;
        done = true;
        dropOffer();
        refundMake();
      },
      finished: (end) => {
        if (done) return;
        done = true;
        const offerId = end.ok ? end.result?.offerId : undefined;
        if (typeof offerId === 'string') offer.offerId = offerId;
        else dropOffer();
        if (refunded(end)) refundMake();
      },
    };
  }

  /** Admit one cancel or key restore for `account`. A cancel that lands ends every open offer. */
  admitDaily(kind: DailyKind, accountRaw: string): AdmissionOutcome {
    const account = norm(accountRaw);
    const now = this.now();
    const r = this.record(account);
    this.sweep(r, now);
    const cap = kind === 'cancels' ? this.o.cancelsPerDay : this.o.restoresPerDay;
    const list = r[kind];
    if (list.length >= cap) {
      return refusal(
        kind === 'cancels' ? 'cancels-daily-cap' : 'restores-daily-cap',
        kind === 'cancels'
          ? `this account has cancelled ${list.length} times in the last 24 hours, the most the market pays for; open offers still end at their expiry`
          : `this account's encryption key was restored ${list.length} times in the last 24 hours, the most the market pays for`,
        list[0]! + DAY_SECONDS - now,
      );
    }
    const at = now;
    list.push(at);
    let done = false;
    return {
      ok: true,
      release: () => {
        if (done) return;
        done = true;
        removeOne(list, at);
      },
      finished: (end) => {
        if (done) return;
        done = true;
        // The account's auth nonce moved: every offer signed before can no longer settle.
        if (end.ok) r.offers = [];
        if (refunded(end)) removeOne(list, at);
      },
    };
  }
}

const norm = (a: string) => a.replace(/^0x/, '').toLowerCase();

function removeOne(list: number[], value: number): void {
  const i = list.lastIndexOf(value);
  if (i !== -1) list.splice(i, 1);
}

function refusal(code: string, reason: string, retryAfterSeconds: number): AdmissionOutcome {
  return { ok: false, status: 429, code, reason, retryAfterSeconds: Math.max(1, Math.ceil(retryAfterSeconds)) };
}

/** The admission checks over `caps`: a make's (after its expiry check), a cancel's, a restore's. */
export function makeAdmission(caps: AccountCaps): AdmissionCheck {
  return async ({ account, payload }) => {
    const authNonce = typeof payload.authNonce === 'string' ? payload.authNonce : '0';
    const validUntil = typeof payload.validUntil === 'string' ? payload.validUntil : '0';
    return caps.admitMake(account ?? '', { authNonce, validUntil });
  };
}

export function dailyAdmission(caps: AccountCaps, kind: DailyKind): AdmissionCheck {
  return async ({ account }) => caps.admitDaily(kind, account ?? '');
}
