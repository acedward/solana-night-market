// AA 00047 P10, audit round 2 R2-1 (F-A2-1, MAJOR for a public site): one registered account could
// hold the single prover lane. Makes were unlimited per account and each held the lane for its proof
// AND the exchange's listing wait (up to 90 s); cancels were free and sponsor-paid. Auditor A's probe
// (evidence/00047-mn-bank-solana/audit/round2/auditor-A/audit-a2-probe-lane.ts): five makes of one
// account queued, and a customer's withdrawal sent after them waited for all five (about 314 s at
// stagenet scale). Now:
//   - one queued-or-running job per account (`429 account-busy`: ../src/actions/account-gate.ts);
//   - the prover lane is shared round-robin across accounts (../src/queue/fair-lock.ts);
//   - a make waits for its listing on its account's lane, not holding the prover;
// so another account's withdrawal waits behind at most ONE job of an account that loops makes and
// cancels. The per-account caps (open offers, makes, cancels a day) are ./account-caps.test.ts.

import { describe, expect, it } from 'vitest';

import { defaultCatalogue, withTrade } from '../src/actions/catalogue.js';
import { AccountGate } from '../src/actions/account-gate.js';
import { FairLock } from '../src/queue/fair-lock.js';
import { JobQueue, type JobExecutor } from '../src/queue/jobs.js';
import { silentLog, testConfig } from './harness.js';
import { ATTACKER, ATTACKER_ACCOUNT, CUSTOMER, CUSTOMER_ACCOUNT, laneRelay, sleep } from './lane-relay.js';

describe('FairLock (unit)', () => {
  it('serves keys round-robin, each key first in first out', async () => {
    const lock = new FairLock();
    const order: string[] = [];
    const release = await lock.acquire('holder', 'h');
    const waits = [
      ['a1', 'A'],
      ['a2', 'A'],
      ['a3', 'A'],
      ['b1', 'B'],
      ['c1', 'C'],
      ['b2', 'B'],
    ].map(([id, key]) =>
      lock.acquire(id!, key!).then((r) => {
        order.push(id!);
        r();
      }),
    );
    expect(lock.position('a1')).toBe(1);
    expect(lock.position('b1')).toBe(2);
    expect(lock.position('c1')).toBe(3);
    expect(lock.position('a2')).toBe(4);
    expect(lock.position('b2')).toBe(5);
    expect(lock.position('a3')).toBe(6);
    expect(lock.position('holder')).toBe(0);
    expect(lock.position('nobody')).toBeUndefined();
    expect(lock.waiting).toBe(6);
    release();
    await Promise.all(waits);
    expect(order).toEqual(['a1', 'b1', 'c1', 'a2', 'b2', 'a3']);
    expect(lock.idle).toBe(true);
  });

  it('with one key it is a plain FIFO lock', async () => {
    const lock = new FairLock();
    const order: string[] = [];
    const release = await lock.acquire('x');
    const all = ['1', '2', '3'].map((id) => lock.acquire(id).then((r) => (order.push(id), r())));
    release();
    await Promise.all(all);
    expect(order).toEqual(['1', '2', '3']);
  });
});

describe('the prover lane takes turns per account (JobQueue)', () => {
  it("another account's job runs after at most one job of an account that queued several", async () => {
    const queue = new JobQueue({ ttlSeconds: 600, maxJobs: 100, log: silentLog() });
    const order: string[] = [];
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const job =
      (name: string, wait?: Promise<void>): JobExecutor =>
      async () => {
        order.push(name);
        await wait;
        return {};
      };
    const A = 'aa'.repeat(32);
    const B = 'bb'.repeat(32);
    queue.submit({ action: 'register', lane: 'prover', payload: {}, executor: job('holder', gate) });
    const ids = [
      queue.submit({ action: 'open-swap', lane: 'prover', account: A, payload: {}, executor: job('a1') })!,
      queue.submit({ action: 'cancel-offers', lane: 'prover', account: A, payload: {}, executor: job('a2') })!,
      queue.submit({ action: 'open-swap', lane: 'prover', account: A, payload: {}, executor: job('a3') })!,
      queue.submit({ action: 'withdraw', lane: 'prover', account: B, payload: {}, executor: job('b1') })!,
    ];
    await sleep(0);
    expect(queue.get(ids[3]!.requestId)?.position).toBe(2); // behind a1 only
    open();
    await Promise.all(ids.map((j) => queue.settled(j.requestId)));
    expect(order).toEqual(['holder', 'a1', 'b1', 'a2', 'a3']);
  });

  it('a make waits for its listing OFF the prover lane: another account proves meanwhile', async () => {
    const order: string[] = [];
    const catalogue = withTrade(defaultCatalogue(), {} as never);
    const def = catalogue.get('open-swap')!;
    // The make: its proof on the prover, then the exchange's listing wait (here 200 ms).
    const make: JobExecutor = async (_p, ctx) => {
      await ctx.prove(async () => {
        order.push('make-proof');
        await sleep(20);
      });
      order.push('make-listing-wait');
      await sleep(200);
      order.push('make-listed');
      return {};
    };
    const queue = new JobQueue({ ttlSeconds: 600, maxJobs: 100, log: silentLog() });
    const m = queue.submit({
      action: 'open-swap',
      lane: def.lane,
      account: 'aa'.repeat(32),
      payload: {},
      executor: make,
    })!;
    await sleep(60); // the make proved and is waiting for its listing
    const w = queue.submit({
      action: 'withdraw',
      lane: 'prover',
      account: 'cc'.repeat(32),
      payload: {},
      executor: async (_p, ctx) => ctx.prove(async () => (order.push('withdraw'), {})),
    })!;
    await queue.settled(w.requestId);
    expect(def.lane).toBe('account');
    expect(order).toEqual(['make-proof', 'make-listing-wait', 'withdraw']);
    await queue.settled(m.requestId);
    expect(order.at(-1)).toBe('make-listed');
  });
});

// ── the route: one queued-or-running job per account ─────────────────────────

describe('one queued-or-running job per account (route, R2-1)', () => {
  it('a second request of a busy account is refused (429 account-busy, Retry-After) before any work; another account is not', async () => {
    const r = laneRelay({ proofMs: 30, listingMs: 30, withdrawMs: 10 });
    const first = await r.post('open-swap', ATTACKER_ACCOUNT, r.make(0), ATTACKER);
    expect(first.status).toBe(202);
    const second = await r.post('cancel-offers', ATTACKER_ACCOUNT, r.cancel(1), ATTACKER);
    expect(second).toMatchObject({ status: 429, code: 'account-busy', retryAfter: '30' });
    expect(r.h.queue.stats().jobs).toBe(1);
    expect((await r.post('withdraw', CUSTOMER_ACCOUNT, { n: 1 }, CUSTOMER)).status).toBe(202);
    // The refused cancel's approval was given back: once the make is done, the SAME request is admitted.
    await r.h.queue.settled(first.id!);
    await sleep(0);
    expect((await r.post('cancel-offers', ATTACKER_ACCOUNT, r.cancel(1), ATTACKER)).status).toBe(202);
  });

  it('JOBS_PER_ACCOUNT is configurable (default 1)', () => {
    expect(testConfig().limits.jobsPerAccount).toBe(1);
    expect(testConfig({ JOBS_PER_ACCOUNT: '2' }).limits.jobsPerAccount).toBe(2);
    const g = new AccountGate(2);
    const a = g.take('AB'.repeat(32));
    const b = g.take(`0x${'ab'.repeat(32)}`);
    expect(a && b).toBeTruthy();
    expect(g.take('ab'.repeat(32))).toBeNull();
    a!();
    a!(); // idempotent
    expect(g.inFlight('ab'.repeat(32))).toBe(1);
    expect(g.take('ab'.repeat(32))).not.toBeNull();
  });
});

describe('the R2-1 fairness probe: one account looping makes and cancels vs another account’s withdrawal', () => {
  it("the withdrawal waits behind at most ONE of the looping account's jobs", async () => {
    // Stagenet scale ÷ 1000: a proof 30 s → 30 ms, the listing wait 24 s → 24 ms, a withdrawal 40 s → 40 ms.
    const r = laneRelay({ proofMs: 30, listingMs: 24, withdrawMs: 40 });
    let stop = false;
    const tried = new Map<number, number>();
    const attacker = (async () => {
      for (let i = 0; !stop; i++) {
        const s =
          i % 3 === 2
            ? await r.post('cancel-offers', ATTACKER_ACCOUNT, r.cancel(i), ATTACKER)
            : await r.post('open-swap', ATTACKER_ACCOUNT, r.make(i), ATTACKER);
        tried.set(s.status, (tried.get(s.status) ?? 0) + 1);
        await sleep(2);
      }
    })();
    await sleep(80); // the attacker is busy looping
    const queuedAt = r.proofs.length;
    const t0 = Date.now();
    const w = await r.post('withdraw', CUSTOMER_ACCOUNT, { n: 1 }, CUSTOMER);
    expect(w.status).toBe(202);
    await r.h.queue.settled(w.id!);
    const waitedMs = Date.now() - t0;
    stop = true;
    await attacker;
    const ahead = r.proofs.slice(queuedAt, r.proofs.indexOf('customer-withdraw'));
    expect(ahead.every((p) => p.startsWith('attacker'))).toBe(true);
    expect(ahead.length).toBeLessThanOrEqual(1);
    // At stagenet scale: about one proof (≈30 s) plus the withdrawal itself; generous for slow CI
    // (without the fix the loop queued dozens of 54 ms jobs ahead of it).
    expect(waitedMs).toBeLessThan(400);
    expect(tried.get(429) ?? 0).toBeGreaterThan(0); // the loop was refused while its job ran
  });
});
