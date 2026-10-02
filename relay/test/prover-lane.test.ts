// AA 00047 P11.F, audit round 4 R4-1 (F-A4-1, MAJOR for a public site): a take is signed for a few
// minutes and must start with 60 s left, and the round-robin prover lane of P10 put it behind one job of
// every other account with work waiting. Auditor A's probe
// (evidence/00047-mn-bank-solana/audit/round4/auditor-A/audit-a4-probe-lane.ts): six accounts with one
// queued withdrawal each (44 s apiece on stagenet) made every customer's take expire before it started.
// Now (../src/queue/prover-lock.ts, ../src/queue/priority.ts, ../src/app.ts):
//   - takes go first, then makes (both carry a signed deadline), then everything else; a waiting lower
//     rank still gets a turn after `PROVER_PRIORITY_BURST` grants in a row to higher ranks;
//   - within a rank the account with fewer recent grants goes first, and a job is still passed by each
//     other account at most once (P10's bound, ./fairness.test.ts);
//   - a take is signed for 600 s, the relay's maximum (packages/core TAKE_LIFETIME_SECONDS);
//   - a take the queue cannot reach before its deadline is refused up front (`prover-busy`), before any
//     queue slot, proof or DUST.

import { describe, expect, it } from 'vitest';

import { TAKE_LIFETIME_SECONDS } from '@nightmarket/core';

import { ProverLock, type ProverRank } from '../src/queue/prover-lock.js';
import { proverPriority } from '../src/queue/priority.js';
import { testConfig } from './harness.js';
import { CUSTOMER, CUSTOMER_ACCOUNT, laneRelay, sleep } from './lane-relay.js';

const t = (id: string, key: string, rank: ProverRank, extra: { deadline?: number; action?: string } = {}) => ({
  id,
  key,
  rank,
  action: extra.action ?? (rank === 0 ? 'take' : rank === 1 ? 'open-swap' : 'withdraw'),
  ...(extra.deadline !== undefined ? { deadline: extra.deadline } : {}),
});

/** Queue `tickets` behind a holder, release it, and return the order they were served in. */
async function served(lock: ProverLock, tickets: ReturnType<typeof t>[], before?: () => void): Promise<string[]> {
  const order: string[] = [];
  const release = await lock.acquire(t('holder', 'holder', 2));
  const all = tickets.map((x) =>
    lock.acquire(x).then((r) => {
      order.push(x.id);
      r();
    }),
  );
  before?.();
  release();
  await Promise.all(all);
  return order;
}

/** Grant `key` the lane `n` times (its recent use). */
async function use(lock: ProverLock, key: string, n: number) {
  for (let i = 0; i < n; i++) (await lock.acquire(t(`${key}-use-${i}`, key, 2, { action: 'use' })))();
}

describe('the prover lane serves by rank: takes, then makes, then the rest (R4-1)', () => {
  it('a take goes before queued withdrawals, and a make before them too', async () => {
    const lock = new ProverLock();
    const order = await served(lock, [
      t('w1', 'W1', 2),
      t('w2', 'W2', 2),
      t('m1', 'M1', 1, { deadline: 2e9 }),
      t('t1', 'T1', 0, { deadline: 2e9 }),
      t('w3', 'W3', 2),
    ]);
    expect(order).toEqual(['t1', 'm1', 'w1', 'w2', 'w3']);
  });

  it('a lower rank is never starved: after `burst` grants in a row to higher ranks it gets a turn', async () => {
    const lock = new ProverLock({ burst: 2 });
    const order = await served(lock, [
      t('w', 'W', 2),
      t('m', 'M', 1),
      ...[1, 2, 3, 4, 5].map((i) => t(`t${i}`, `T${i}`, 0)),
    ]);
    // Two takes, then the most starved lower rank (the withdrawal), then the make (starved too), …
    expect(order).toEqual(['t1', 't2', 'w', 'm', 't3', 't4', 't5']);
  });

  it('the job ranks follow the action and its signed deadline', () => {
    expect(proverPriority('take', { validUntil: '2000000000' })).toEqual({ rank: 0, deadline: 2_000_000_000 });
    expect(proverPriority('open-swap', { validUntil: '2000000600' })).toEqual({ rank: 1, deadline: 2_000_000_600 });
    expect(proverPriority('take', { validUntil: '0' })).toEqual({ rank: 0 });
    expect(proverPriority('take', {})).toEqual({ rank: 0 });
    for (const a of [
      'withdraw',
      'withdraw-unshielded',
      'append-inbox',
      'cancel-offers',
      'restore-enc-key',
      'register',
      'demo-tokens',
    ] as const) {
      expect(proverPriority(a, { validUntil: '2000000000' })).toEqual({ rank: 2 });
    }
  });
});

describe('within a rank, accounts with fewer recent jobs go first (R4-1)', () => {
  it('a customer who rarely uses the lane goes before accounts that keep it busy', async () => {
    const lock = new ProverLock();
    await use(lock, 'A1', 3);
    await use(lock, 'A2', 2);
    const order = await served(lock, [t('a1', 'A1', 2), t('a2', 'A2', 2), t('c', 'C', 2)]);
    expect(order).toEqual(['c', 'a2', 'a1']);
  });

  it('a short signed deadline does not jump the queue: recent use decides first', async () => {
    const lock = new ProverLock();
    await use(lock, 'X', 2);
    const order = await served(lock, [t('x', 'X', 0, { deadline: 1000 }), t('y', 'Y', 0, { deadline: 9000 })]);
    expect(order).toEqual(['y', 'x']);
    // With equal use, the earlier signed deadline goes first, then arrival.
    const fresh = new ProverLock();
    expect(
      await served(fresh, [
        t('late', 'L', 0, { deadline: 9000 }),
        t('soon', 'S', 0, { deadline: 1000 }),
        t('none', 'N', 0),
      ]),
    ).toEqual(['soon', 'late', 'none']);
  });

  it('use is counted over a window: older grants are forgotten', async () => {
    let now = 1_000_000;
    const lock = new ProverLock({ nowMs: () => now, usageWindowSeconds: 60 });
    await use(lock, 'A', 3);
    expect(lock.usage('A')).toBe(3);
    now += 61_000;
    expect(lock.usage('A')).toBe(0);
    // Now equal use: arrival order.
    expect(await served(lock, [t('a', 'A', 2), t('b', 'B', 2)])).toEqual(['a', 'b']);
  });

  it('each other key passes a waiting job at most once: a light user does not starve a heavy one', async () => {
    const lock = new ProverLock();
    await use(lock, 'H', 5); // a heavy (honest) user
    const order: string[] = [];
    const hold = (id: string) => async (r: () => void) => {
      order.push(id);
      await sleep(5);
      r();
    };
    const release = await lock.acquire(t('holder', 'holder', 2));
    const heavy = lock.acquire(t('h', 'H', 2)).then(hold('h'));
    // Light users keep arriving: each may pass H's job once, never twice.
    const light: Promise<void>[] = [];
    for (const k of ['L1', 'L2', 'L3']) light.push(lock.acquire(t(`${k}-1`, k, 2)).then(hold(`${k}-1`)));
    release();
    await sleep(1);
    for (const k of ['L1', 'L2', 'L3']) light.push(lock.acquire(t(`${k}-2`, k, 2)).then(hold(`${k}-2`)));
    await Promise.all([heavy, ...light]);
    expect(order.slice(0, 1)).toEqual(['L1-1']); // the light users first …
    const h = order.indexOf('h');
    for (const k of ['L1', 'L2', 'L3'])
      expect(order.slice(0, h).filter((x) => x.startsWith(k)).length).toBeLessThanOrEqual(1);
  });
});

describe('passes across ranks do not count against a job (R4-1)', () => {
  it('a customer whose take went ahead of the attackers’ withdrawals is not then put behind all of them', async () => {
    const lock = new ProverLock();
    for (const k of ['A1', 'A2', 'A3']) await use(lock, k, 2);
    const order: string[] = [];
    const hold = (id: string) => async (r: () => void) => {
      order.push(id);
      await sleep(3);
      r();
    };
    const release = await lock.acquire(t('holder', 'holder', 2));
    const jobs = ['A1', 'A2', 'A3'].map((k) => lock.acquire(t(k.toLowerCase(), k, 2)).then(hold(k.toLowerCase())));
    jobs.push(lock.acquire(t('take', 'C', 0)).then(hold('take')));
    release();
    await sleep(1); // the take holds the lane: the customer's withdrawal arrives now
    jobs.push(lock.acquire(t('withdraw', 'C', 2)).then(hold('withdraw')));
    await Promise.all(jobs);
    expect(order).toEqual(['take', 'withdraw', 'a1', 'a2', 'a3']);
  });
});

describe('when would a job start? (estimate and position, R4-1)', () => {
  it('a take behind queued withdrawals is estimated to start when the holder ends; a withdrawal after them all', async () => {
    let now = 5_000_000;
    const lock = new ProverLock({ nowMs: () => now, defaultHoldSeconds: 44 });
    for (let i = 0; i < 20; i++) await use(lock, `W${i}`, 1); // the attackers have used the lane
    const release = await lock.acquire(t('holder', 'holder', 2));
    const waits = Array.from({ length: 20 }, (_, i) => lock.acquire(t(`w${i}`, `W${i}`, 2)));
    now += 4_000; // the holder has held for 4 s
    expect(lock.estimateWaitMs({ key: 'C', rank: 0, action: 'take', deadline: 1 })).toBe(40_000);
    expect(lock.estimateWaitMs({ key: 'C', rank: 2, action: 'withdraw' })).toBe(40_000); // C has used nothing: first
    expect(lock.estimateWaitMs({ key: 'W0', rank: 2, action: 'withdraw' })).toBe(40_000 + 20 * 44_000); // behind its own
    expect(lock.position('w0')).toBe(1);
    expect(lock.position('w19')).toBe(20);
    expect(lock.position('holder')).toBe(0);
    expect(lock.position('nobody')).toBeUndefined();
    const take = lock.acquire(t('take', 'C', 0));
    expect(lock.position('take')).toBe(1);
    expect(lock.position('w0')).toBe(2);
    release();
    await take.then((r) => r());
    await Promise.all(waits.map((p) => p.then((r) => r())));
    expect(lock.idle).toBe(true);
  });

  it('the expected hold of an action follows what its jobs actually held', async () => {
    let now = 0;
    const lock = new ProverLock({ nowMs: () => now, defaultHoldSeconds: 60 });
    expect(lock.expectedHoldMs('withdraw')).toBe(60_000);
    for (let i = 0; i < 20; i++) {
      const r = await lock.acquire(t(`w${i}`, `K${i}`, 2));
      now += 10_000;
      r();
    }
    expect(lock.expectedHoldMs('withdraw')).toBeGreaterThan(10_000);
    expect(lock.expectedHoldMs('withdraw')).toBeLessThan(10_100);
    expect(lock.expectedHoldMs('take')).toBe(60_000);
  });
});

describe('a take is signed for the relay’s maximum (R4-1)', () => {
  it('TAKE_LIFETIME_SECONDS is the relay’s default maximum, 600 s', () => {
    expect(TAKE_LIFETIME_SECONDS).toBe(600);
    expect(testConfig().expiry.takeMaxLifetimeSeconds).toBe(600);
  });

  it('the prover lane settings are configurable, with their defaults', () => {
    expect(testConfig().proverLane).toEqual({ usageWindowSeconds: 3600, burst: 4, defaultHoldSeconds: 60 });
    expect(
      testConfig({ PROVER_USAGE_WINDOW_SECONDS: '600', PROVER_PRIORITY_BURST: '2', PROVER_JOB_ESTIMATE_SECONDS: '45' })
        .proverLane,
    ).toEqual({ usageWindowSeconds: 600, burst: 2, defaultHoldSeconds: 45 });
    expect(() => testConfig({ PROVER_PRIORITY_BURST: '0' })).toThrow(/PROVER_PRIORITY_BURST/);
  });
});

// ── A's lane probe at the route: N accounts saturate the lane with withdrawals ──────────────────────

const account = (i: number) => (0x7000 + i).toString(16).padStart(64, '0');

describe('auditor A’s lane probe (R4-1 acceptance, scaled): a customer’s take starts in time', () => {
  for (const n of [10, 20]) {
    it(`${n} attacker accounts with one queued withdrawal each: the take starts after at most the running one, and every withdrawal is still served`, async () => {
      const order: string[] = [];
      const r = laneRelay({
        proofMs: 1,
        listingMs: 1,
        withdrawMs: 1,
        signerOf: () => CUSTOMER,
        executors: {
          'withdraw-unshielded': async (p, ctx) =>
            ctx.prove(async () => {
              order.push(`w:${(p as { account: string }).account.slice(-4)}`);
              await sleep(15);
              return { txId: 'u' };
            }),
          take: async (_p, ctx) => ctx.prove(async () => (order.push('take'), { txHash: 't' })),
        },
      });
      const ids: string[] = [];
      for (let i = 0; i < n; i++) {
        const s = await r.post(
          'withdraw-unshielded',
          account(i),
          { recipient: 'aa'.repeat(32), color: 'bb'.repeat(32), amount: String(i + 1), authNonce: '0' },
          CUSTOMER,
        );
        expect(s.status).toBe(202);
        ids.push(s.id!);
      }
      const take = await r.post('take', CUSTOMER_ACCOUNT, r.take(42), CUSTOMER);
      expect(take.status).toBe(202);
      await r.h.queue.settled(take.id!);
      for (const id of ids) await r.h.queue.settled(id);
      // Behind at most the withdrawal that held the prover when it arrived (P10's lane: behind all n).
      expect(order.indexOf('take')).toBeLessThanOrEqual(1);
      expect(order.filter((x) => x.startsWith('w:'))).toHaveLength(n);
      for (const id of ids) expect(r.h.queue.get(id)?.state).toBe('succeeded');
    });
  }

  it('a customer’s withdrawal goes before accounts that keep the lane busy (usage), not behind all of them', async () => {
    const order: string[] = [];
    const r = laneRelay({
      proofMs: 1,
      listingMs: 1,
      withdrawMs: 1,
      signerOf: () => CUSTOMER,
      executors: {
        'withdraw-unshielded': async (p, ctx) =>
          ctx.prove(async () => {
            order.push((p as { account: string }).account === CUSTOMER_ACCOUNT ? 'customer' : 'attacker');
            await sleep(5);
            return { txId: 'u' };
          }),
      },
    });
    const body = { recipient: 'aa'.repeat(32), color: 'bb'.repeat(32), amount: '1', authNonce: '0' };
    // Ten attacker accounts loop withdrawals (each refills its one slot as soon as its job ends; every
    // request a fresh signature: a fresh amount).
    let stop = false;
    let seq = 1;
    const loops = Array.from({ length: 10 }, (_, i) =>
      (async () => {
        while (!stop) {
          const s = await r.post('withdraw-unshielded', account(i), { ...body, amount: String(++seq) }, CUSTOMER);
          if (s.id) await r.h.queue.settled(s.id);
          else await sleep(1);
        }
      })(),
    );
    await sleep(150); // every attacker has used the lane by now
    const at = order.length;
    const c = await r.post('withdraw-unshielded', CUSTOMER_ACCOUNT, { ...body, recipient: 'cc'.repeat(32) }, CUSTOMER);
    expect(c.status).toBe(202);
    await r.h.queue.settled(c.id!);
    stop = true;
    await Promise.all(loops);
    // At most the job holding the prover ran before it (P10's lane: up to one job of each of the ten).
    expect(order.indexOf('customer') - at).toBeLessThanOrEqual(1);
  });
});

describe('a take the queue cannot reach before its deadline is refused up front (R4-1)', () => {
  const longTake = (id: string) => async (_p: unknown, ctx: { prove<T>(fn: () => Promise<T>): Promise<T> }) =>
    ctx.prove(async () => {
      await sleep(30);
      return { txHash: id };
    });

  it('prover-busy (503, Retry-After) before any queue slot; nothing is charged and the same approval can be sent again', async () => {
    // The default expected hold is 60 s a job; a take signed for now + 100 s must start by now + 40 s.
    const r = laneRelay({ proofMs: 1, listingMs: 1, withdrawMs: 1, caps: true, executors: { take: longTake('t') } });
    const now = Math.floor(Date.now() / 1000);
    const first = await r.post('take', '44'.repeat(32), r.take(1), CUSTOMER);
    expect(first.status).toBe(202); // holds the prover (expected: 60 s)
    const late = { ...r.take(2), validUntil: String(now + 100) };
    const refused = await r.post('take', CUSTOMER_ACCOUNT, late, CUSTOMER);
    expect(refused).toMatchObject({ status: 503, code: 'prover-busy' });
    expect(Number(refused.retryAfter)).toBeGreaterThanOrEqual(1);
    expect(r.h.queue.stats().jobs).toBe(1); // nothing queued
    // A take signed for the full lifetime is admitted behind it.
    const inTime = await r.post('take', CUSTOMER_ACCOUNT, { ...r.take(2), validUntil: String(now + 600) }, CUSTOMER);
    expect(inTime.status).toBe(202);
    await r.settle(first.id);
    await r.settle(inTime.id);
    // The refused approval was given back: once the lane is free, the SAME request is admitted.
    expect((await r.post('take', CUSTOMER_ACCOUNT, late, CUSTOMER)).status).toBe(202);
  });

  it('withdrawals and other deadline-free jobs are never refused for the queue', async () => {
    const r = laneRelay({ proofMs: 1, listingMs: 1, withdrawMs: 50 });
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) {
      const s = await r.post('withdraw', account(i), { n: i }, CUSTOMER);
      expect(s.status).toBe(202);
      ids.push(s.id!);
    }
    for (const id of ids) await r.settle(id);
  });
});
