// AA 00047 P10, audit round 2 R2-2 (F-A2-2, F-B2-3): the failure budget charges only failures the
// requester caused, never blocks withdrawals, cancels or key restores, and is checked again when a
// job reaches its lane (a refused job runs nothing and gives back what its request claimed).
//
// Round 2's probes: five takes of an offer its maker cancelled (or let expire) charged the TAKER,
// who was then refused every action, withdrawals included, for 24 h (auditor A, probe `relay` §1);
// a prover crash (plan R7) was charged to the customer; jobs queued before the fifth failure still
// ran after it (auditor B).

import { describe, expect, it } from 'vitest';

import {
  BUDGET_EXEMPT_ACTIONS,
  FailureBudget,
  InfrastructureError,
  countsAgainstBudget,
  isInfrastructureFailure,
} from '../src/actions/failure-budget.js';
import { PublicError, type JobExecutor } from '../src/queue/jobs.js';
import { ATTACKER, ATTACKER_ACCOUNT, CUSTOMER, CUSTOMER_ACCOUNT, laneRelay, sleep } from './lane-relay.js';

const failingTake =
  (error: () => unknown): JobExecutor =>
  async (_p, ctx) =>
    ctx.prove(async () => {
      throw error();
    });

describe('what counts against the budget (unit)', () => {
  it("a counterparty's failure (a cancelled, expired or taken offer) never counts", () => {
    for (const code of ['exchange-error', 'take-refused', 'take-unbalanced', 'take-fee-too-high', 'offer-gone'])
      expect([code, countsAgainstBudget(new PublicError(code, 'x'), true)]).toEqual([code, false]);
  });

  it('an infrastructure failure never counts: the proof server, the node or the indexer failed', () => {
    const infra = [
      new InfrastructureError('the proof server could not be reached: fetch failed'),
      new Error('Failed Proof Server response: url="http://p:6300/prove", code="502", status="Bad Gateway"'),
      new TypeError('fetch failed'),
      Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }),
      new Error('the call failed', { cause: new Error('socket hang up') }),
      new Error('WebSocket is closed'),
    ];
    for (const e of infra) {
      expect([e.message, isInfrastructureFailure(e)]).toEqual([e.message, true]);
      expect([e.message, countsAgainstBudget(e, true)]).toEqual([e.message, false]);
    }
  });

  it("the requester's own failures still count: a circuit refusal, the node refusing the transaction, a 4xx", () => {
    for (const e of [
      new Error('failed assert: held coin colour does not match the withdrawn colour'),
      new Error('1010: Invalid Transaction: Custom error: 115'),
      new Error('Failed Proof Server response: url="http://p:6300/prove", code="400", status="Bad Request"'),
      new PublicError('offer-refused', 'the exchange refused the offer: it timed out'),
    ])
      expect([e.message, countsAgainstBudget(e, true)]).toEqual([e.message, true]);
    expect(countsAgainstBudget(new Error('anything'), false)).toBe(false); // before any proof
  });

  it('withdrawals, unshielded withdrawals, cancels and key restores are exempt', () => {
    expect([...BUDGET_EXEMPT_ACTIONS].sort()).toEqual([
      'cancel-offers',
      'restore-enc-key',
      'withdraw',
      'withdraw-unshielded',
    ]);
  });
});

describe('the budget on the route (R2-2)', () => {
  it('auditor A’s probe §1: five takes of a dead offer do not lock the taker out', async () => {
    const r = laneRelay({
      proofMs: 1,
      listingMs: 1,
      withdrawMs: 1,
      failures: true,
      executors: {
        take: failingTake(
          () => new PublicError('exchange-error', "the exchange's settlement service failed (HTTP 500)"),
        ),
      },
    });
    for (let i = 0; i < 5; i++) {
      const s = await r.post('take', CUSTOMER_ACCOUNT, r.take(i), CUSTOMER);
      expect(s.status).toBe(202);
      await r.settle(s.id);
    }
    expect(r.failures!.failures(CUSTOMER)).toBe(0);
    expect((await r.post('take', CUSTOMER_ACCOUNT, r.take(9), CUSTOMER)).status).toBe(202);
  });

  it('a prover crash is not charged, and the customer is told the market failed (market-unavailable)', async () => {
    const r = laneRelay({
      proofMs: 1,
      listingMs: 1,
      withdrawMs: 1,
      failures: true,
      env: { FAILURE_BUDGET_PER_OWNER_PER_DAY: '1' },
      executors: {
        take: failingTake(
          () => new Error('Failed Proof Server response: url="http://p:6300/prove", code="502", status="x"'),
        ),
      },
    });
    const s = await r.post('take', CUSTOMER_ACCOUNT, r.take(0), CUSTOMER);
    await r.settle(s.id);
    expect(r.h.queue.get(s.id!)?.error?.code).toBe('market-unavailable');
    expect(r.failures!.failures(CUSTOMER)).toBe(0);
    expect((await r.post('take', CUSTOMER_ACCOUNT, r.take(1), CUSTOMER)).status).toBe(202);
  });

  it('an owner past the budget may still withdraw, withdraw unshielded, cancel and restore its key; nothing else', async () => {
    const r = laneRelay({ proofMs: 1, listingMs: 1, withdrawMs: 1, failures: true });
    for (let i = 0; i < 5; i++) r.failures!.record(ATTACKER, ATTACKER_ACCOUNT);
    expect(await r.post('open-swap', ATTACKER_ACCOUNT, r.make(1), ATTACKER)).toMatchObject({
      status: 429,
      code: 'failure-budget',
    });
    for (const [action, payload] of [
      ['withdraw', { n: 1 }],
      ['withdraw-unshielded', { n: 2 }],
      ['cancel-offers', r.cancel(3)],
      ['restore-enc-key', r.restore(4)],
    ] as const) {
      const s = await r.post(action, ATTACKER_ACCOUNT, payload, ATTACKER);
      expect([action, s.status]).toEqual([action, 202]);
      await r.settle(s.id);
      expect([action, r.h.queue.get(s.id!)?.state]).toEqual([action, 'succeeded']);
    }
  });

  it('auditor B (F-B2-3): jobs queued before the budget ran out are refused when they reach the lane, run nothing, and give back what they claimed', async () => {
    const OWNER = 'ee'.repeat(32);
    const accounts = ['01', '02', '03', '04'].map((x) => x.repeat(32));
    const ran: string[] = [];
    const r = laneRelay({
      proofMs: 1,
      listingMs: 1,
      withdrawMs: 1,
      failures: true,
      caps: true,
      env: { FAILURE_BUDGET_PER_OWNER_PER_DAY: '2' },
      signerOf: () => OWNER,
      executors: {
        'open-swap': async (p, ctx) =>
          ctx.prove(async () => {
            ran.push((p as { account: string }).account); // proving time spent
            throw new Error('failed assert: a coin that is not in the tree');
          }),
      },
    });
    // The lane is busy: the owner queues one make per account (one job per account at a time).
    let open!: () => void;
    const busy = new Promise<Record<string, unknown>>((resolve) => (open = () => resolve({})));
    const holder = r.h.queue.submit({ action: 'register', lane: 'prover', payload: {}, executor: () => busy })!;
    const posted = [];
    for (const [i, account] of accounts.entries()) posted.push(await r.post('open-swap', account, r.make(i), OWNER));
    expect(posted.map((p) => p.status)).toEqual([202, 202, 202, 202]);
    open();
    await r.settle(holder.requestId);
    for (const p of posted) await r.settle(p.id);
    // Two failed (the budget), two never proved.
    expect(ran).toEqual(accounts.slice(0, 2));
    expect(r.failures!.failures(OWNER)).toBe(2);
    for (const p of posted.slice(2)) expect(r.h.queue.get(p.id!)?.error?.code).toBe('failure-budget');
    // Their reservations were given back: no open-offer slot, no daily make; the approval is not burnt
    // (sent again, it meets the budget, not the replay guard).
    expect(r.caps!.usedToday(accounts[2]!, 'makes')).toBe(0);
    expect(r.caps!.openOffers(accounts[2]!)).toBe(0);
    expect(await r.post('open-swap', accounts[2]!, r.make(2), OWNER)).toMatchObject({
      status: 429,
      code: 'failure-budget',
    });
  });

  it('a queued withdrawal of an owner whose budget ran out meanwhile still runs', async () => {
    const r = laneRelay({ proofMs: 1, listingMs: 1, withdrawMs: 1, failures: true });
    let open!: () => void;
    const busy = new Promise<Record<string, unknown>>((resolve) => (open = () => resolve({})));
    const holder = r.h.queue.submit({ action: 'register', lane: 'prover', payload: {}, executor: () => busy })!;
    const w = await r.post('withdraw', ATTACKER_ACCOUNT, { n: 7 }, ATTACKER);
    for (let i = 0; i < 5; i++) r.failures!.record(ATTACKER, ATTACKER_ACCOUNT);
    open();
    await r.settle(holder.requestId);
    await r.settle(w.id);
    await sleep(0);
    expect(r.h.queue.get(w.id!)?.state).toBe('succeeded');
  });
});

describe('FailureBudget (unit)', () => {
  it('still bounds an owner and an account per rolling day', () => {
    let now = 1000;
    const f = new FailureBudget({ perOwner: 2, perAccount: 3, now: () => now });
    f.record('a');
    f.record('a');
    expect(f.check('a')).toMatchObject({ ok: false, retryAfterSeconds: 86_400 });
    now += 86_400;
    expect(f.check('a')).toEqual({ ok: true });
  });
});
