// AA 00047 P11, audit round 3 R3-2 (F-B3-1 MAJOR, F-A3-4), owner decision Q46 A at 100: a per-account
// daily allowance of sponsored withdrawals (`WITHDRAWS_DAILY_CAP`, default 100; `withdraw` and
// `withdraw-unshielded` together), and past it one whole-coin (no change) withdrawal per listed token
// per rolling 24 hours, so funds never get stuck (../src/actions/account-caps.ts `admitWithdraw`).
// Before: withdrawals were uncapped, so one account could loop 1-unit withdrawals from its own change
// on the sponsor's DUST (auditor A's lane probe §3: 30 of 30 admitted).

import { describe, expect, it } from 'vitest';

import { AccountCaps } from '../src/actions/account-caps.js';
import type { AdmissionOutcome, JobEnd } from '../src/actions/admission.js';
import { PublicError } from '../src/queue/jobs.js';
import { testConfig } from './harness.js';
import { ATTACKER, ATTACKER_ACCOUNT, CUSTOMER, CUSTOMER_ACCOUNT, laneRelay } from './lane-relay.js';

const A = 'ab'.repeat(32);
const X = 'aa'.repeat(32); // a listed shielded token
const Y = 'bb'.repeat(32); // another listed token
const U = 'cc'.repeat(32); // a listed unshielded token
const JUNK = 'ee'.repeat(32); // a colour the market does not list
const DAY = 86_400;

const okEnd: JobEnd = { ok: true, proved: true, requesterFault: false };
const failEnd = (proved: boolean, requesterFault: boolean): JobEnd => ({ ok: false, proved, requesterFault });

function admitted(o: AdmissionOutcome) {
  if (!o.ok) throw new Error(`refused: ${o.code}`);
  return o;
}

function caps(over: Partial<ConstructorParameters<typeof AccountCaps>[0]> = {}) {
  let now = 1_800_000_000;
  const c = new AccountCaps({
    maxOpenOffers: 3,
    makesPerDay: 20,
    cancelsPerDay: 5,
    restoresPerDay: 3,
    withdrawsPerDay: 100,
    isListedColour: (colour) => colour !== JUNK,
    now: () => now,
    ...over,
  });
  return { c, now: () => now, advance: (s: number) => (now += s) };
}

describe('the sponsored-withdrawal allowance (unit)', () => {
  it('admits WITHDRAWS_DAILY_CAP withdrawals in any rolling 24 hours, then refuses a partial one with 429 withdraws-daily-cap / whole-coin-exit', () => {
    const t = caps();
    for (let i = 0; i < 100; i++) admitted(t.c.admitWithdraw(A, { colour: X, wholeCoin: false })).finished!(okEnd);
    expect(t.c.usedToday(A, 'withdraws')).toBe(100);
    t.advance(60);
    expect(t.c.admitWithdraw(A, { colour: X, wholeCoin: false })).toMatchObject({
      ok: false,
      status: 429,
      code: 'withdraws-daily-cap',
      detail: 'whole-coin-exit',
      retryAfterSeconds: DAY - 60,
    });
    // Another account is not affected.
    expect(t.c.admitWithdraw('cd'.repeat(32), { colour: X, wholeCoin: false }).ok).toBe(true);
    // A day after the first, the allowance frees up again.
    t.advance(DAY - 60);
    expect(t.c.admitWithdraw(A, { colour: X, wholeCoin: false }).ok).toBe(true);
  });

  it('past the allowance, ONE whole-coin withdrawal per listed token per day is still admitted', () => {
    const t = caps({ withdrawsPerDay: 2 });
    for (let i = 0; i < 2; i++) admitted(t.c.admitWithdraw(A, { colour: X, wholeCoin: true })).finished!(okEnd);
    // Whole-coin withdrawals under the allowance count against the allowance, not the exits.
    expect(t.c.exitsToday(A, X)).toBe(0);
    admitted(t.c.admitWithdraw(A, { colour: X, wholeCoin: true })).finished!(okEnd);
    expect(t.c.exitsToday(A, X)).toBe(1);
    t.advance(100);
    expect(t.c.admitWithdraw(A, { colour: X, wholeCoin: true })).toMatchObject({
      ok: false,
      code: 'withdraws-daily-cap',
      detail: 'whole-coin-exit-used',
      retryAfterSeconds: DAY - 100,
    });
    expect(t.c.admitWithdraw(A, { colour: X, wholeCoin: false })).toMatchObject({ detail: 'whole-coin-exit-used' });
    // Each token has its own exit (an unshielded withdrawal is always a whole-coin one).
    admitted(t.c.admitWithdraw(A, { colour: Y, wholeCoin: true })).finished!(okEnd);
    admitted(t.c.admitWithdraw(A, { colour: U, wholeCoin: true })).finished!(okEnd);
    expect(t.c.admitWithdraw(A, { colour: Y, wholeCoin: false })).toMatchObject({ detail: 'whole-coin-exit-used' });
    // A day after the exit, it is open again (and the allowance too).
    t.advance(DAY);
    expect(t.c.exitsToday(A, X)).toBe(0);
    expect(t.c.usedToday(A, 'withdraws')).toBe(0);
  });

  it('a token the market does not list has no exit (a junk colour would otherwise give an unbounded number)', () => {
    const t = caps({ withdrawsPerDay: 1 });
    admitted(t.c.admitWithdraw(A, { colour: X, wholeCoin: false })).finished!(okEnd);
    const r = t.c.admitWithdraw(A, { colour: JUNK, wholeCoin: true });
    expect(r).toMatchObject({ ok: false, code: 'withdraws-daily-cap', detail: 'whole-coin-exit-used' });
    expect(r.ok ? '' : r.reason).toMatch(/does not list this token/);
  });

  it('a withdrawal that failed before proving, or not by the requester, or was refused after admission, is given back; the requester’s own failure is not', () => {
    const t = caps({ withdrawsPerDay: 1 });
    admitted(t.c.admitWithdraw(A, { colour: X, wholeCoin: false })).finished!(failEnd(false, false)); // stale before proving
    admitted(t.c.admitWithdraw(A, { colour: X, wholeCoin: false })).finished!(failEnd(true, false)); // the prover crashed
    admitted(t.c.admitWithdraw(A, { colour: X, wholeCoin: false })).release!(); // a full queue
    expect(t.c.usedToday(A, 'withdraws')).toBe(0);
    admitted(t.c.admitWithdraw(A, { colour: X, wholeCoin: false })).finished!(failEnd(true, true)); // a spent coin, at the node
    expect(t.c.usedToday(A, 'withdraws')).toBe(1);
    // The exit's charge follows the same rule.
    admitted(t.c.admitWithdraw(A, { colour: X, wholeCoin: true })).finished!(failEnd(true, false));
    expect(t.c.exitsToday(A, X)).toBe(0);
    admitted(t.c.admitWithdraw(A, { colour: X, wholeCoin: true })).finished!(failEnd(true, true));
    expect(t.c.exitsToday(A, X)).toBe(1);
  });

  it('is configurable (WITHDRAWS_DAILY_CAP), 100 by default (owner, Q46)', () => {
    expect(testConfig().accountCaps.withdrawsPerDay).toBe(100);
    expect(testConfig({ WITHDRAWS_DAILY_CAP: '7' }).accountCaps.withdrawsPerDay).toBe(7);
    expect(() => testConfig({ WITHDRAWS_DAILY_CAP: '0' })).toThrow(/WITHDRAWS_DAILY_CAP/);
    // Without the option (older callers), the default applies.
    let now = 1_800_000_000;
    const c = new AccountCaps({
      maxOpenOffers: 1,
      makesPerDay: 1,
      cancelsPerDay: 1,
      restoresPerDay: 1,
      now: () => now,
    });
    for (let i = 0; i < 100; i++) admitted(c.admitWithdraw(A, { colour: X, wholeCoin: false })).finished!(okEnd);
    now += 1;
    expect(c.admitWithdraw(A, { colour: X, wholeCoin: false })).toMatchObject({ code: 'withdraws-daily-cap' });
  });
});

describe('the allowance on the route (as main.ts wires it)', () => {
  const shielded = (amount: string, value: string, color = X, i = 0) => ({
    recipient: 'dd'.repeat(32),
    color,
    amount,
    coin: { nonce: i.toString(16).padStart(64, '0'), color, value, mtIndex: String(i) },
    authNonce: String(i),
  });
  const unshielded = (amount: string, color = U, i = 0) => ({
    recipient: 'dd'.repeat(32),
    color,
    amount,
    authNonce: String(i),
  });

  it("auditor A's probe §3 (one account, withdrawals one after another): the 101st is refused; the whole-coin exit still works", async () => {
    const r = laneRelay({ proofMs: 1, listingMs: 1, withdrawMs: 1, caps: true });
    const codes: Record<string, number> = {};
    let i = 0;
    for (; i < 101; i++) {
      const s = await r.post('withdraw', ATTACKER_ACCOUNT, shielded('1', '1000', X, i), ATTACKER);
      codes[String(s.status)] = (codes[String(s.status)] ?? 0) + 1;
      await r.settle(s.id);
    }
    expect(codes).toEqual({ '202': 100, '429': 1 });
    const over = await r.post('withdraw', ATTACKER_ACCOUNT, shielded('1', '1000', X, ++i), ATTACKER);
    expect(over).toMatchObject({ status: 429, code: 'withdraws-daily-cap', detail: 'whole-coin-exit' });
    expect(Number(over.retryAfter)).toBeGreaterThan(DAY - 120);
    const exit = await r.post('withdraw', ATTACKER_ACCOUNT, shielded('1000', '1000', X, ++i), ATTACKER);
    expect(exit.status).toBe(202);
    await r.settle(exit.id);
    expect(await r.post('withdraw', ATTACKER_ACCOUNT, shielded('1000', '1000', X, i + 1), ATTACKER)).toMatchObject({
      status: 429,
      code: 'withdraws-daily-cap',
      detail: 'whole-coin-exit-used',
    });
    // Another account is not affected.
    expect((await r.post('withdraw', CUSTOMER_ACCOUNT, shielded('1', '1000', X, 999), CUSTOMER)).status).toBe(202);
  });

  it('shielded and unshielded withdrawals share the allowance; an unshielded one is its token’s exit', async () => {
    const r = laneRelay({ proofMs: 1, listingMs: 1, withdrawMs: 1, caps: true, env: { WITHDRAWS_DAILY_CAP: '2' } });
    const run = async (action: string, payload: unknown) => {
      const s = await r.post(action, ATTACKER_ACCOUNT, payload, ATTACKER);
      await r.settle(s.id);
      return s;
    };
    expect((await run('withdraw', shielded('1', '5', X, 1))).status).toBe(202);
    expect((await run('withdraw-unshielded', unshielded('1', U, 2))).status).toBe(202);
    expect(await run('withdraw', shielded('1', '5', X, 3))).toMatchObject({ status: 429, detail: 'whole-coin-exit' });
    expect((await run('withdraw-unshielded', unshielded('3', U, 4))).status).toBe(202); // U's exit
    expect(await run('withdraw-unshielded', unshielded('3', U, 5))).toMatchObject({
      status: 429,
      code: 'withdraws-daily-cap',
      detail: 'whole-coin-exit-used',
    });
  });

  it('the failure budget never refuses a withdrawal, but the allowance bounds a failing loop (auditor A’s relay probe §2)', async () => {
    const r = laneRelay({
      proofMs: 1,
      listingMs: 1,
      withdrawMs: 1,
      caps: true,
      failures: true,
      env: { WITHDRAWS_DAILY_CAP: '8' },
      executors: {
        withdraw: async (_p, ctx) =>
          ctx.prove(async () => {
            throw new Error('1010: Invalid Transaction: Custom error: 115'); // the node: a spent coin
          }),
      },
    });
    const statuses: number[] = [];
    for (let i = 0; i < 10; i++) {
      const s = await r.post('withdraw', ATTACKER_ACCOUNT, shielded('1', '1000', X, i), ATTACKER);
      statuses.push(s.status);
      await r.settle(s.id);
    }
    expect(statuses).toEqual([202, 202, 202, 202, 202, 202, 202, 202, 429, 429]);
    expect(r.caps!.usedToday(ATTACKER_ACCOUNT, 'withdraws')).toBe(8);
  });

  it('a withdrawal that fails for the market’s reason does not use up the allowance', async () => {
    const r = laneRelay({
      proofMs: 1,
      listingMs: 1,
      withdrawMs: 1,
      caps: true,
      env: { WITHDRAWS_DAILY_CAP: '1' },
      executors: {
        withdraw: async (_p, ctx) =>
          ctx.prove(async () => {
            throw new PublicError('sponsor-unavailable', 'the sponsor is not synced');
          }),
      },
    });
    for (let i = 0; i < 3; i++) {
      const s = await r.post('withdraw', CUSTOMER_ACCOUNT, shielded('1', '1000', X, i), CUSTOMER);
      expect(s.status).toBe(202);
      await r.settle(s.id);
    }
    expect(r.caps!.usedToday(CUSTOMER_ACCOUNT, 'withdraws')).toBe(0);
  });
});
