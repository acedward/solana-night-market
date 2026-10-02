// AA 00047 P10, audit round 2 R2-1 (F-A2-1): per-account caps on open offers, makes a day, cancels a
// day and key restores a day (../src/actions/account-caps.ts), all configurable, with RUNBOOK numbers.
// A make costs its maker nothing and does not move the auth nonce, and a cancel or a restore is a
// free sponsor-paid transaction: without caps one account could post offers without end and loop
// cancels on the sponsor's DUST.

import { describe, expect, it } from 'vitest';

import { AccountCaps } from '../src/actions/account-caps.js';
import type { AdmissionOutcome, JobEnd } from '../src/actions/admission.js';
import { PublicError } from '../src/queue/jobs.js';
import { testConfig } from './harness.js';
import { ATTACKER, ATTACKER_ACCOUNT, CUSTOMER, CUSTOMER_ACCOUNT, laneRelay } from './lane-relay.js';

const A = 'ab'.repeat(32);
const DAY = 86_400;

const okEnd = (offerId?: string): JobEnd => ({
  ok: true,
  proved: true,
  requesterFault: false,
  ...(offerId ? { result: { offerId } } : {}),
});
const failEnd = (proved: boolean, requesterFault: boolean): JobEnd => ({ ok: false, proved, requesterFault });

function admitted(o: AdmissionOutcome) {
  if (!o.ok) throw new Error(`refused: ${o.code}`);
  return o;
}

describe('AccountCaps (unit)', () => {
  const caps = (over: Partial<ConstructorParameters<typeof AccountCaps>[0]> = {}) => {
    let now = 1_800_000_000;
    const c = new AccountCaps({
      maxOpenOffers: 3,
      makesPerDay: 20,
      cancelsPerDay: 5,
      restoresPerDay: 3,
      now: () => now,
      ...over,
    });
    return { c, now: () => now, advance: (s: number) => (now += s) };
  };
  const signed = (t: { now: () => number }, authNonce = '4', ttl = 1800) => ({
    authNonce,
    validUntil: String(t.now() + ttl),
  });

  it('at most OFFERS_MAX_OPEN_PER_ACCOUNT offers that may still settle; then 429 open-offers-cap until one ends', async () => {
    const t = caps();
    for (let i = 0; i < 3; i++) admitted(await t.c.admitMake(A, signed(t))).finished!(okEnd(`${i}`.repeat(64)));
    const fourth = await t.c.admitMake(A, signed(t));
    expect(fourth).toMatchObject({ ok: false, status: 429, code: 'open-offers-cap', retryAfterSeconds: 1800 });
    expect(t.c.openOffers(A)).toBe(3);
    // Another account is not affected.
    expect((await t.c.admitMake('cd'.repeat(32), signed(t))).ok).toBe(true);
  });

  it('an offer stops counting when its signed expiry passes, or when the account’s nonce moves past it', async () => {
    const t = caps();
    for (let i = 0; i < 3; i++)
      admitted(await t.c.admitMake(A, signed(t, '4', 100 * (i + 1)))).finished!(okEnd('11'.repeat(32)));
    t.advance(101); // the first expired
    expect((await t.c.admitMake(A, signed(t))).ok).toBe(true);
    expect(t.c.openOffers(A)).toBe(3);
    // A cancel (or a withdrawal) landed: the nonce is 5 now; every offer signed at 4 is dead.
    expect((await t.c.admitMake(A, signed(t, '5'))).ok).toBe(true);
    expect(t.c.openOffers(A)).toBe(1);
  });

  it('at the cap, the exchange is asked which offers were taken or ended (and a failed answer keeps them)', async () => {
    const statuses = new Map<string, string>();
    const t = caps({ offerStatus: async (id) => (statuses.get(id) as never) ?? Promise.reject(new Error('down')) });
    const ids = ['01', '02', '03'].map((x) => x.repeat(32));
    for (const id of ids) admitted(await t.c.admitMake(A, signed(t))).finished!(okEnd(id));
    expect(await t.c.admitMake(A, signed(t))).toMatchObject({ ok: false, code: 'open-offers-cap' }); // exchange down
    statuses.set(ids[0]!, 'live');
    statuses.set(ids[1]!, 'consumed'); // taken
    statuses.set(ids[2]!, 'live');
    expect((await t.c.admitMake(A, signed(t))).ok).toBe(true);
  });

  it('a make that fails frees its open slot; a make refused after admission gives everything back', async () => {
    const t = caps({ maxOpenOffers: 1, makesPerDay: 2 });
    admitted(await t.c.admitMake(A, signed(t))).finished!(failEnd(true, true)); // offer refused after proving
    expect(t.c.openOffers(A)).toBe(0);
    expect(t.c.usedToday(A, 'makes')).toBe(1); // the requester's fault: the charge stays
    admitted(await t.c.admitMake(A, signed(t))).release!(); // a full queue
    expect(t.c.usedToday(A, 'makes')).toBe(1);
    expect(t.c.openOffers(A)).toBe(0);
  });

  it('at most MAKES_PER_ACCOUNT_PER_DAY makes in any rolling 24 hours; a make that failed before proving, or not by the requester, is given back', async () => {
    const t = caps({ maxOpenOffers: 100, makesPerDay: 3 });
    admitted(await t.c.admitMake(A, signed(t))).finished!(failEnd(false, false)); // stale before proving
    admitted(await t.c.admitMake(A, signed(t))).finished!(failEnd(true, false)); // the prover crashed
    expect(t.c.usedToday(A, 'makes')).toBe(0);
    for (let i = 0; i < 3; i++) admitted(await t.c.admitMake(A, signed(t))).finished!(okEnd('22'.repeat(32)));
    const over = await t.c.admitMake(A, signed(t));
    expect(over).toMatchObject({ ok: false, status: 429, code: 'makes-daily-cap', retryAfterSeconds: DAY });
    t.advance(DAY);
    expect((await t.c.admitMake(A, signed(t, '4', 1800))).ok).toBe(true);
  });

  it('cancels and key restores have daily caps of their own: a restore never uses up the cancels', () => {
    const t = caps();
    for (let i = 0; i < 5; i++) admitted(t.c.admitDaily('cancels', A)).finished!(okEnd());
    expect(t.c.admitDaily('cancels', A)).toMatchObject({ ok: false, status: 429, code: 'cancels-daily-cap' });
    for (let i = 0; i < 3; i++) admitted(t.c.admitDaily('restores', A)).finished!(okEnd());
    expect(t.c.admitDaily('restores', A)).toMatchObject({ ok: false, status: 429, code: 'restores-daily-cap' });
    expect(t.c.usedToday(A, 'cancels')).toBe(5);
    // A refused-after-admission or a market-side failure gives the charge back; the requester's own failure does not.
    const t2 = caps({ cancelsPerDay: 1 });
    admitted(t2.c.admitDaily('cancels', A)).release!();
    admitted(t2.c.admitDaily('cancels', A)).finished!(failEnd(true, false));
    admitted(t2.c.admitDaily('cancels', A)).finished!(failEnd(true, true));
    expect(t2.c.admitDaily('cancels', A)).toMatchObject({ ok: false, code: 'cancels-daily-cap' });
  });

  it('a cancel that lands ends every open offer of the account', async () => {
    const t = caps({ maxOpenOffers: 1 });
    admitted(await t.c.admitMake(A, signed(t))).finished!(okEnd('33'.repeat(32)));
    expect(await t.c.admitMake(A, signed(t))).toMatchObject({ ok: false, code: 'open-offers-cap' });
    admitted(t.c.admitDaily('cancels', A)).finished!(okEnd());
    expect(t.c.openOffers(A)).toBe(0);
  });

  it('the caps are configurable, with the RUNBOOK defaults', () => {
    expect(testConfig().accountCaps).toEqual({
      maxOpenOffers: 3,
      makesPerDay: 20,
      cancelsPerDay: 5,
      restoresPerDay: 3,
      withdrawsPerDay: 100,
      unsettledTakesPerDay: 10,
    });
    expect(
      testConfig({
        OFFERS_MAX_OPEN_PER_ACCOUNT: '1',
        MAKES_PER_ACCOUNT_PER_DAY: '7',
        CANCELS_PER_ACCOUNT_PER_DAY: '2',
        RESTORES_PER_ACCOUNT_PER_DAY: '9',
      }).accountCaps,
    ).toEqual({
      maxOpenOffers: 1,
      makesPerDay: 7,
      cancelsPerDay: 2,
      restoresPerDay: 9,
      withdrawsPerDay: 100,
      unsettledTakesPerDay: 10,
    });
    expect(() => testConfig({ CANCELS_PER_ACCOUNT_PER_DAY: '0' })).toThrow(/CANCELS_PER_ACCOUNT_PER_DAY/);
  });
});

describe('the per-account caps on the route (as main.ts wires them)', () => {
  it('a looping account is stopped by its open-offer and cancel caps; restores keep their own count', async () => {
    const r = laneRelay({ proofMs: 1, listingMs: 1, withdrawMs: 1, caps: true });
    const run = async (action: string, payload: unknown) => {
      const s = await r.post(action, ATTACKER_ACCOUNT, payload, ATTACKER);
      await r.settle(s.id);
      return s;
    };
    const makes = [];
    for (let i = 0; i < 4; i++) makes.push(await run('open-swap', r.make(i)));
    expect(makes.map((m) => m.status)).toEqual([202, 202, 202, 429]);
    expect(makes[3]).toMatchObject({ code: 'open-offers-cap' });
    const cancels = [];
    for (let i = 0; i < 6; i++) cancels.push(await run('cancel-offers', r.cancel(i, String(i))));
    expect(cancels.map((c) => c.status)).toEqual([202, 202, 202, 202, 202, 429]);
    expect(cancels[5]).toMatchObject({ code: 'cancels-daily-cap' });
    expect(Number(cancels[5]!.retryAfter)).toBeGreaterThan(DAY - 60);
    // A restore is not a cancel: it has its own count.
    expect((await run('restore-enc-key', r.restore(1, '9'))).status).toBe(202);
    // Another account is not affected.
    expect((await r.post('cancel-offers', CUSTOMER_ACCOUNT, r.cancel(1), CUSTOMER)).status).toBe(202);
  });

  it('a make that fails for a reason the requester did not cause gives its daily charge back', async () => {
    const r = laneRelay({
      proofMs: 1,
      listingMs: 1,
      withdrawMs: 1,
      caps: true,
      env: { MAKES_PER_ACCOUNT_PER_DAY: '1' },
      executors: {
        'open-swap': async (_p, ctx) =>
          ctx.prove(async () => {
            throw new PublicError('exchange-unavailable', 'the exchange could not be reached');
          }),
      },
    });
    for (let i = 0; i < 3; i++) {
      const s = await r.post('open-swap', ATTACKER_ACCOUNT, r.make(i), ATTACKER);
      expect(s.status).toBe(202);
      await r.settle(s.id);
    }
    expect(r.caps!.usedToday(ATTACKER_ACCOUNT, 'makes')).toBe(0);
  });
});
