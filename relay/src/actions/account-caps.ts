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
//     count: a restore never uses up the cancels);
//   - WITHDRAWALS a day (AA 00047 P11, audit round 3 R3-2 / F-B3-1, F-A3-4; owner decision Q46 A at
//     100): `WITHDRAWS_DAILY_CAP` sponsored withdrawals (`withdraw` and `withdraw-unshielded`
//     together: every withdrawal the market pays for). Past it, ONE whole-coin withdrawal per listed
//     token is still admitted in any rolling 24 hours (a shielded one spending its coin whole, no
//     change; any unshielded one), so funds never get stuck; the refusal says which
//     (`withdraws-daily-cap`, detail `whole-coin-exit` / `whole-coin-exit-used`,
//     packages/core/src/withdraw-allowance.ts). A withdrawal used to be uncapped: one account could
//     loop 1-unit withdrawals from its own change, each on the sponsor's DUST;
//   - UNSETTLED TAKES a day (AA 00047 P11, audit round 3 R3-7 / F-B3-6): `TAKES_UNSETTLED_PER_ACCOUNT_PER_DAY`
//     takes that were proven and then refused for a reason the relay could not pin on the taker (the
//     maker's or the exchange's: `exchange-error`, `take-refused`, `take-*`, `offer-gone`; never
//     charged to the failure budget). Each costs a proof and one of the batcher's daily settlements
//     (1,000 for all clients), so one account cannot repeat them without end; past the cap, its takes
//     wait (429 `takes-unsettled-cap`). Its other actions are not affected.
// A charge is taken at admission (before any queue slot, proof or DUST) and given back when the route
// refuses the request after all, or when the job ends without the requester being at fault: it
// failed before proving, or for the market's, a counterparty's or the infrastructure's reason
// (./failure-budget.ts). The counters live in memory: a relay restart resets them (RUNBOOK).

import { isCounterpartyCode } from './failure-budget.js';
import {
  WHOLE_COIN_EXIT,
  WITHDRAWS_DAILY_CAP_CODE,
  WITHDRAWS_DAILY_CAP_DEFAULT,
  isWholeCoinWithdrawal,
  type KernelOfferStatus,
} from '@nightmarket/core';

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
  /** Sponsored withdrawals admitted per account in any rolling 24 hours (default 100, Q46). */
  withdrawsPerDay?: number;
  /** Whether the market lists a colour (64 hex): only a listed token has a whole-coin exit. Absent:
   *  every colour does (tests). */
  isListedColour?: (colour: string) => boolean;
  /** Takes per account in any rolling 24 hours that may fail at settlement for a reason not pinned
   *  on the taker (default 10; R3-7). */
  unsettledTakesPerDay?: number;
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
  /** Sponsored withdrawals admitted under the allowance (Q46). */
  withdraws: number[];
  /** Whole-coin exits admitted past the allowance, by colour (Q46). */
  exits: Map<string, number[]>;
  /** Takes proven and then refused, not by the taker's fault (R3-7). */
  unsettled: number[];
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
      r = { offers: [], makes: [], cancels: [], restores: [], withdraws: [], exits: new Map(), unsettled: [] };
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
    for (const list of [r.makes, r.cancels, r.restores, r.withdraws, r.unsettled]) {
      while (list.length > 0 && list[0]! <= since) list.shift();
    }
    for (const [colour, list] of r.exits) {
      while (list.length > 0 && list[0]! <= since) list.shift();
      if (list.length === 0) r.exits.delete(colour);
    }
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
  usedToday(accountRaw: string, kind: 'makes' | 'withdraws' | 'unsettled' | DailyKind): number {
    const r = this.accounts.get(norm(accountRaw));
    if (!r) return 0;
    this.sweep(r, this.now());
    return r[kind].length;
  }

  /** Whole-coin exits of `colour` used by `account` in the last 24 hours (for operators and tests). */
  exitsToday(accountRaw: string, colour: string): number {
    const r = this.accounts.get(norm(accountRaw));
    if (!r) return 0;
    this.sweep(r, this.now());
    return r.exits.get(norm(colour))?.length ?? 0;
  }

  /**
   * Admit one sponsored withdrawal of `colour` for `account` (Q46): under the day's allowance, or,
   * once it is used up, as the token's one whole-coin exit of the day (`wholeCoin`: a shielded
   * withdrawal with no change, or any unshielded one; packages/core `isWholeCoinWithdrawal`).
   */
  admitWithdraw(accountRaw: string, w: { colour: string; wholeCoin: boolean }): AdmissionOutcome {
    const account = norm(accountRaw);
    const colour = norm(w.colour);
    const now = this.now();
    const r = this.record(account);
    this.sweep(r, now);
    const cap = this.o.withdrawsPerDay ?? WITHDRAWS_DAILY_CAP_DEFAULT;
    if (r.withdraws.length < cap) return this.charge(r.withdraws, now);
    // The allowance is used up: only the token's whole-coin exit is left.
    const allowanceBack = r.withdraws[0]! + DAY_SECONDS - now;
    const listed = this.o.isListedColour ? this.o.isListedColour(colour) : true;
    const exits = r.exits.get(colour) ?? [];
    const exitOpen = listed && exits.length === 0;
    if (exitOpen && w.wholeCoin) {
      r.exits.set(colour, exits);
      return this.charge(exits, now);
    }
    const used = `this account has used the ${r.withdraws.length} withdrawals the market pays for in 24 hours`;
    if (exitOpen) {
      return refusal(
        WITHDRAWS_DAILY_CAP_CODE,
        `${used}; one withdrawal of a whole coin of this token (no change) is still accepted today`,
        allowanceBack,
        WHOLE_COIN_EXIT.open,
      );
    }
    const exitBack = exits.length > 0 ? exits[0]! + DAY_SECONDS - now : allowanceBack;
    return refusal(
      WITHDRAWS_DAILY_CAP_CODE,
      listed
        ? `${used}, and today's whole-coin withdrawal of this token`
        : `${used}; the market does not list this token, so it has no whole-coin withdrawal`,
      Math.min(allowanceBack, exitBack),
      WHOLE_COIN_EXIT.used,
    );
  }

  /**
   * Admit one take for `account` (R3-7): refused while the account had `unsettledTakesPerDay` takes in
   * the last 24 hours that were proven and then refused for the maker's or the exchange's reason.
   * Counted when such a take ends; nothing is charged at admission.
   */
  admitTake(accountRaw: string): AdmissionOutcome {
    const account = norm(accountRaw);
    const now = this.now();
    const r = this.record(account);
    this.sweep(r, now);
    const cap = this.o.unsettledTakesPerDay ?? 10;
    if (r.unsettled.length >= cap) {
      return refusal(
        'takes-unsettled-cap',
        `this account's takes were refused at settlement ${r.unsettled.length} times in the last 24 hours for reasons the market could not trace to the offer's maker or to your account; take again later`,
        r.unsettled[0]! + DAY_SECONDS - now,
      );
    }
    return {
      ok: true,
      finished: (end) => {
        if (!end.ok && end.proved && !end.requesterFault && end.code && isCounterpartyCode(end.code)) {
          r.unsettled.push(this.now());
        }
      },
    };
  }

  /** Take one charge in `list` at `now`, given back when the job ends without the requester's fault. */
  private charge(list: number[], at: number): AdmissionOutcome {
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
        if (refunded(end)) removeOne(list, at);
      },
    };
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

function refusal(code: string, reason: string, retryAfterSeconds: number, detail?: string): AdmissionOutcome {
  return {
    ok: false,
    status: 429,
    code,
    reason,
    retryAfterSeconds: Math.max(1, Math.ceil(retryAfterSeconds)),
    ...(detail ? { detail } : {}),
  };
}

/** The admission checks over `caps`: a make's (after its expiry check), a cancel's, a restore's. */
export function makeAdmission(caps: AccountCaps): AdmissionCheck {
  return async ({ account, payload }) => {
    const authNonce = typeof payload.authNonce === 'string' ? payload.authNonce : '0';
    const validUntil = typeof payload.validUntil === 'string' ? payload.validUntil : '0';
    return caps.admitMake(account ?? '', { authNonce, validUntil });
  };
}

/** A take's admission: the unsettled-take cap (R3-7). */
export function takeAdmission(caps: AccountCaps): AdmissionCheck {
  return async ({ account }) => caps.admitTake(account ?? '');
}

export function dailyAdmission(caps: AccountCaps, kind: DailyKind): AdmissionCheck {
  return async ({ account }) => caps.admitDaily(kind, account ?? '');
}

/** A sponsored withdrawal's admission (`withdraw`, `withdraw-unshielded`): the Q46 allowance. */
export function withdrawAdmission(caps: AccountCaps, action: 'withdraw' | 'withdraw-unshielded'): AdmissionCheck {
  return async ({ account, payload }) =>
    caps.admitWithdraw(account ?? '', {
      colour: typeof payload.color === 'string' ? payload.color : '',
      wholeCoin: isWholeCoinWithdrawal(action, payload),
    });
}
