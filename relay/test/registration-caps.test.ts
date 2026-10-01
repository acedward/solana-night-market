// AA 00047 P9, audit C4 (F-A3): opening accounts is capped, and failing calls are not free to repeat.
//
//   - a global and a per-client daily cap on registrations, counted at admission, given back only when
//     the route refuses the request after admission (a full queue);
//   - a bounded share of the one prover lane: at most REGISTER_MAX_IN_FLIGHT registrations queued or
//     running at once, so other actions wait behind at most that many;
//   - a failure budget per owner and per account: jobs that fail after they started proving count,
//     and past the budget the owner or account is refused (429 failure-budget) for a day.
// Every refusal happens before any queue slot, proof or DUST.

import { describe, expect, it } from 'vitest';

import { API_PATHS, buildRelayActionMessage } from '@nightmarket/core';

import { testDevice, testScheme } from '../../packages/core/test/fixtures/test-signing.js';
import { defaultCatalogue, withRegistrationCaps } from '../src/actions/catalogue.js';
import { FailureBudget, countsAgainstBudget } from '../src/actions/failure-budget.js';
import { RegistrationCaps } from '../src/actions/registration-caps.js';
import { createApp, budgeted } from '../src/app.js';
import { NonceStore } from '../src/auth/nonces.js';
import { notImplementedChainReader } from '../src/chain/reader.js';
import { loadConfig } from '../src/config.js';
import { PublicError, JobQueue, type JobExecutor } from '../src/queue/jobs.js';
import { FakeSponsor, LOCAL_TOKENS, silentLog } from './harness.js';

const ACCOUNT = '5e'.repeat(32);
const DAY = 86_400;

/** A relay whose `register` and `demo-tokens` executors are the test's, behind the P9 caps. */
function relay(
  opts: {
    env?: Record<string, string>;
    register?: JobExecutor;
    demo?: JobExecutor;
    now?: () => number;
  } = {},
) {
  const config = loadConfig(
    {
      RELAY_NETWORK: 'undeployed',
      TOKENS_FILE: '/t',
      RATE_LIMIT_ACTIONS_PER_MIN: '1000',
      RATE_LIMIT_ACTIONS_PER_OWNER_PER_MIN: '1000',
      RATE_LIMIT_NONCES_PER_MIN: '1000',
      ...opts.env,
    },
    () => JSON.stringify(LOCAL_TOKENS),
  ).config;
  const log = silentLog();
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  const queue = new JobQueue({ ttlSeconds: 600, maxJobs: config.limits.maxJobs, log });
  const caps = new RegistrationCaps({ ...config.registration, now });
  const failures = new FailureBudget({ ...config.failureBudget, now });
  const catalogue = defaultCatalogue();
  catalogue.set('register', {
    ...catalogue.get('register')!,
    executor: opts.register ?? (async () => ({ account: ACCOUNT })),
  });
  catalogue.set('demo-tokens', {
    ...catalogue.get('demo-tokens')!,
    executor: opts.demo ?? (async () => ({})),
  });
  withRegistrationCaps(catalogue, caps);
  let client = '198.51.100.1';
  const app = createApp({
    config,
    version: 'test',
    log,
    nonces: new NonceStore(600, 10_000),
    queue,
    catalogue,
    failures,
    sponsor: new FakeSponsor(),
    health: async () => {
      throw new Error('unused');
    },
    chain: notImplementedChainReader,
    scheme: testScheme,
    clientAddress: () => client,
  });
  const send = async (
    action: 'register' | 'demo-tokens',
    from: string,
    device = testDevice(),
  ): Promise<{ status: number; code?: string; retryAfter: string | null; requestId?: string }> => {
    client = from;
    const { nonce } = (await (await app.request(API_PATHS.nonce)).json()) as { nonce: string };
    const payload = action === 'register' ? { encPublicKey: 'ab'.repeat(32) } : { useCounter: '0' };
    const account = action === 'register' ? undefined : ACCOUNT;
    const message = buildRelayActionMessage({
      action,
      network: config.network.name,
      owner: device.deviceKey,
      account,
      payload,
      nonce,
      expiry: Math.floor(Date.now() / 1000) + 120,
    });
    const res = await app.request(API_PATHS.action(action), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...(account ? { account } : {}),
        payload,
        auth: { message, signature: device.signEnvelope(message) },
      }),
    });
    const body = (await res.json()) as { job?: { requestId: string }; error?: { code: string } };
    return {
      status: res.status,
      ...(body.error ? { code: body.error.code } : {}),
      retryAfter: res.headers.get('retry-after'),
      ...(body.job ? { requestId: body.job.requestId } : {}),
    };
  };
  /** Wait for a job to end, and for the route's end-of-job hooks to run. */
  const settle = async (requestId?: string) => {
    if (requestId) await queue.settled(requestId);
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { app, config, queue, caps, failures, send, settle };
}

describe('registration caps (audit C4)', () => {
  it('a client address opens at most REGISTER_PER_CLIENT_DAILY_CAP accounts a day; others are not affected', async () => {
    const r = relay();
    for (let i = 0; i < 3; i++) {
      const ok = await r.send('register', '203.0.113.1');
      expect(ok.status).toBe(202);
      await r.settle(ok.requestId);
    }
    const fourth = await r.send('register', '203.0.113.1');
    expect(fourth).toMatchObject({ status: 429, code: 'registration-client-cap' });
    expect(Number(fourth.retryAfter)).toBeGreaterThan(DAY - 60);
    expect(r.queue.stats().jobs).toBe(3); // the refusal queued nothing
    expect((await r.send('register', '203.0.113.2')).status).toBe(202);
  });

  it('the market opens at most REGISTER_DAILY_CAP accounts in any rolling 24 hours, across clients', async () => {
    let now = 1_800_000_000;
    const r = relay({ env: { REGISTER_DAILY_CAP: '2' }, now: () => now });
    for (const ip of ['203.0.113.1', '203.0.113.2']) {
      const ok = await r.send('register', ip);
      expect(ok.status).toBe(202);
      await r.settle(ok.requestId);
    }
    expect(await r.send('register', '203.0.113.3')).toMatchObject({ status: 429, code: 'registration-daily-cap' });
    now += DAY; // the first two are a day old
    expect((await r.send('register', '203.0.113.3')).status).toBe(202);
  });

  it('at most REGISTER_MAX_IN_FLIGHT registrations queue or run at once; other actions are not held back', async () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const r = relay({
      register: async () => {
        await gate;
        return { account: ACCOUNT };
      },
    });
    const first = await r.send('register', '203.0.113.1');
    expect(first.status).toBe(202);
    const second = await r.send('register', '203.0.113.2');
    expect(second).toMatchObject({ status: 503, code: 'registration-busy', retryAfter: '60' });
    expect(r.caps.running).toBe(1);
    // A different action is admitted while the registration runs.
    expect((await r.send('demo-tokens', '203.0.113.2')).status).toBe(202);
    // The refused registration charged nothing to the second client's daily count.
    expect(r.caps.admittedToday('203.0.113.2')).toBe(0);
    open();
    await r.settle(first.requestId);
    expect(r.caps.running).toBe(0);
    expect((await r.send('register', '203.0.113.2')).status).toBe(202);
  });

  it('a registration the route refuses after admission (a full queue) is given back', async () => {
    const r = relay({ env: { JOB_MAX: '10', REGISTER_PER_CLIENT_DAILY_CAP: '1' } });
    const hold = () => new Promise<Record<string, unknown>>(() => {});
    for (let i = 0; i < 10; i++)
      r.queue.submit({
        action: 'demo-tokens',
        lane: 'account',
        account: (0x10 + i).toString(16).repeat(32),
        payload: {},
        executor: hold,
      });
    expect(await r.send('register', '203.0.113.9')).toMatchObject({ status: 503, code: 'busy' });
    expect(r.caps.admittedToday('203.0.113.9')).toBe(0);
    expect(r.caps.admittedToday()).toBe(0);
    expect(r.caps.running).toBe(0);
  });

  it('the caps are configurable, with the RUNBOOK defaults', () => {
    const d = relay().config;
    expect(d.registration).toEqual({ dailyCap: 100, perClientDailyCap: 3, maxInFlight: 1 });
    expect(d.failureBudget).toEqual({ perOwner: 5, perAccount: 5 });
    const c = relay({
      env: {
        REGISTER_DAILY_CAP: '7',
        REGISTER_PER_CLIENT_DAILY_CAP: '2',
        REGISTER_MAX_IN_FLIGHT: '3',
        FAILURE_BUDGET_PER_OWNER_PER_DAY: '9',
        FAILURE_BUDGET_PER_ACCOUNT_PER_DAY: '11',
      },
    }).config;
    expect(c.registration).toEqual({ dailyCap: 7, perClientDailyCap: 2, maxInFlight: 3 });
    expect(c.failureBudget).toEqual({ perOwner: 9, perAccount: 11 });
    expect(() => relay({ env: { REGISTER_MAX_IN_FLIGHT: '0' } })).toThrow(/REGISTER_MAX_IN_FLIGHT/);
  });
});

describe('RegistrationCaps (unit)', () => {
  it('counts at admission, frees the in-flight slot when finished, and gives everything back on release', () => {
    let now = 1000;
    const caps = new RegistrationCaps({ dailyCap: 2, perClientDailyCap: 2, maxInFlight: 1, now: () => now });
    const a = caps.admit('x');
    expect(a.ok).toBe(true);
    expect(caps.admit('y')).toMatchObject({ ok: false, code: 'registration-busy' });
    if (a.ok) a.finished();
    if (a.ok) a.finished(); // idempotent
    expect(caps.running).toBe(0);
    const b = caps.admit('y');
    expect(b.ok).toBe(true);
    if (b.ok) b.release();
    if (b.ok) b.release(); // idempotent
    expect(caps.admittedToday()).toBe(1);
    expect(caps.admittedToday('y')).toBe(0);
    now += 10;
    const c = caps.admit('x');
    if (c.ok) c.finished();
    expect(caps.admit('z')).toMatchObject({
      ok: false,
      code: 'registration-daily-cap',
      retryAfterSeconds: 86_400 - 10,
    });
    now += 86_400 - 10; // x's first admission (at 1000) is now exactly a day old
    const d = caps.admit('z');
    expect(d.ok).toBe(true);
  });
});

describe('the failure budget (audit C4)', () => {
  it('an owner whose jobs fail after proving started is refused after FAILURE_BUDGET_PER_OWNER_PER_DAY failures', async () => {
    const r = relay({
      demo: async (_p, ctx) =>
        ctx.prove(async () => {
          throw new PublicError('proof-failed', 'the proof failed');
        }),
    });
    const device = testDevice();
    for (let i = 0; i < 5; i++) {
      const s = await r.send('demo-tokens', '203.0.113.1', device);
      expect(s.status).toBe(202);
      await r.settle(s.requestId);
    }
    expect(r.failures.failures(device.deviceKey)).toBe(5);
    const sixth = await r.send('demo-tokens', '203.0.113.1', device);
    expect(sixth).toMatchObject({ status: 429, code: 'failure-budget' });
    expect(Number(sixth.retryAfter)).toBeGreaterThan(DAY - 60);
    expect(r.queue.stats().jobs).toBe(5);
  });

  it('an account whose jobs keep failing is refused for every key (FAILURE_BUDGET_PER_ACCOUNT_PER_DAY)', async () => {
    const r = relay({
      env: { FAILURE_BUDGET_PER_ACCOUNT_PER_DAY: '2' },
      demo: async (_p, ctx) =>
        ctx.prove(async () => {
          throw new Error('a coin that is not in the tree');
        }),
    });
    for (let i = 0; i < 2; i++) await r.settle((await r.send('demo-tokens', '203.0.113.1')).requestId);
    expect(await r.send('demo-tokens', '203.0.113.1')).toMatchObject({ status: 429, code: 'failure-budget' });
  });

  it("does not count failures before any proof, or the market's own failures", async () => {
    let mode: 'before' | 'market' = 'before';
    const r = relay({
      env: { FAILURE_BUDGET_PER_OWNER_PER_DAY: '1' },
      demo: async (_p, ctx) => {
        if (mode === 'before') throw new PublicError('offer-gone', 'refused before proving');
        return ctx.prove(async () => {
          throw new PublicError('exchange-unavailable', 'the exchange could not be reached');
        });
      },
    });
    const device = testDevice();
    for (const m of ['before', 'before', 'market', 'market'] as const) {
      mode = m;
      const s = await r.send('demo-tokens', '203.0.113.1', device);
      expect(s.status).toBe(202);
      await r.settle(s.requestId);
    }
    expect(r.failures.failures(device.deviceKey)).toBe(0);
  });

  it('a successful job costs nothing', async () => {
    const ok = relay();
    const device = testDevice();
    for (let i = 0; i < 8; i++) {
      const s = await ok.send('demo-tokens', '203.0.113.1', device);
      expect(s.status).toBe(202);
      await ok.settle(s.requestId);
    }
    expect(ok.failures.failures(device.deviceKey)).toBe(0);
  });

  it('countsAgainstBudget and budgeted (unit)', async () => {
    expect(countsAgainstBudget(new Error('x'), false)).toBe(false);
    expect(countsAgainstBudget(new Error('x'), true)).toBe(true);
    expect(countsAgainstBudget(new PublicError('not-available', 'x'), true)).toBe(false);
    const f = new FailureBudget({ perOwner: 1, perAccount: 1 });
    const exec = budgeted(
      async (_p, ctx) => ctx.prove(async () => Promise.reject(new Error('boom'))),
      f,
      'aa'.repeat(32),
      ACCOUNT,
    );
    const ctx = { requestId: '0', log: silentLog(), stage: () => {}, prove: <T>(fn: () => Promise<T>) => fn() };
    await expect(exec({}, ctx)).rejects.toThrow('boom');
    expect(f.check('aa'.repeat(32))).toMatchObject({ ok: false });
    expect(f.check('bb'.repeat(32), ACCOUNT)).toMatchObject({ ok: false });
    expect(f.check('bb'.repeat(32))).toEqual({ ok: true });
  });
});
