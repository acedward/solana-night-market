// AA 00047 P9, audit C6 (F-A4, F-B4): offers and takes sign a real expiry, and the relay follows it.
//
//   - admission: "Expires never" (0), an expiry too close or past, or too far ahead is refused before
//     any queue slot, proof or DUST, and the approval is given back (it can be fixed and sent again);
//   - run time: an approval that expired while its job waited is refused before any proof;
//   - the transaction: every intent's TTL is capped at the expiry before proving (midnight-js gives
//     a call one hour), on a real ledger-v9 transaction, and the offer reports the earlier end;
//   - replay: an accepted approval's digest is remembered at least until its expiry.

import * as ledger from '@midnightntwrk/ledger-v9';
import { describe, expect, it, vi } from 'vitest';

import { API_PATHS, type OpenSwapPayload } from '@nightmarket/core';

import { accountOffer } from '../../test/gates/take/fake-tx.js';
import { accountCatalogue, withTrade } from '../src/actions/catalogue.js';
import { createApp } from '../src/app.js';
import { NonceStore } from '../src/auth/nonces.js';
import { passportCallAuthoriser } from '../src/auth/passport-call.js';
import { DigestReplayGuard } from '../src/auth/verifiers.js';
import { notImplementedChainReader } from '../src/chain/reader.js';
import { loadConfig } from '../src/config.js';
import type { PassportProviders, PassportRuntime } from '../src/passport/runtime.js';
import { JobQueue, type JobContext } from '../src/queue/jobs.js';
import { capIntentTtls, offerExpiry, proveGuaranteedOffer, withProofDeadline } from '../src/trade/account-offer.js';
import { openSwapExecutor, takeExecutor } from '../src/trade/executors.js';
import { callSigner, fakeAccountRuntime, testArm } from './fake-arm.js';
import { FakeSponsor, LOCAL_TOKENS, silentLog, testEntitlements } from './harness.js';

const ACCOUNT = '5e'.repeat(32);
const AUTH_NONCE = 2n;
const nowS = () => Math.floor(Date.now() / 1000);

function makePayload(validUntil: string): OpenSwapPayload {
  return {
    giveColor: 'a1'.repeat(32),
    giveAmount: '2000000',
    wantColor: 'b2'.repeat(32),
    wantAmount: '2100000',
    wantNonce: '11'.repeat(32),
    wantEntry: '22'.repeat(192),
    changeEntry: '00'.repeat(192),
    validUntil,
    coin: { nonce: '33'.repeat(32), color: 'a1'.repeat(32), value: '3000000', mtIndex: '9' },
    authNonce: String(AUTH_NONCE),
  };
}

/** The relay as main.ts wires trading (test arm, fakes at the edges). */
function relay() {
  const w = callSigner();
  const config = loadConfig({ RELAY_NETWORK: 'undeployed', TOKENS_FILE: '/t' }, () =>
    JSON.stringify(LOCAL_TOKENS),
  ).config;
  const log = silentLog();
  const rt = fakeAccountRuntime(ACCOUNT, [w.deviceKey], AUTH_NONCE);
  const sponsor = new FakeSponsor();
  const replay = new DigestReplayGuard(config.limits.authMaxTtlSeconds * 6);
  const queue = new JobQueue({ ttlSeconds: 600, maxJobs: 100, log });
  const catalogue = withTrade(
    accountCatalogue({
      runtime: () => rt,
      arm: testArm,
      sponsor,
      network: 'undeployed',
      replay,
      entitlements: testEntitlements(),
      log,
    }),
    {
      runtime: () => rt,
      arm: testArm,
      sponsor,
      kernelUrl: 'http://kernel.test',
      batcherUrl: 'http://batcher.test',
      replay,
      expiry: config.expiry,
      log,
    },
  );
  const app = createApp({
    config,
    version: 'test',
    log,
    nonces: new NonceStore(600, 100),
    queue,
    catalogue,
    sponsor,
    health: async () => {
      throw new Error('unused');
    },
    chain: notImplementedChainReader,
    passportCall: passportCallAuthoriser(() => rt, testArm, replay),
    clientAddress: () => '198.51.100.7',
  });
  // Hold the prover lane so an admitted call stays queued (no work).
  queue.submit({ action: 'register', lane: 'prover', payload: {}, executor: () => new Promise(() => {}) });
  const post = async (action: 'open-swap' | 'take', payload: Record<string, unknown>) => {
    const res = await app.request(API_PATHS.action(action), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account: ACCOUNT, payload, passportAuth: w.passportAuth(action, ACCOUNT, payload) }),
    });
    const body = (await res.json()) as { error?: { code: string; detail?: string } };
    return { status: res.status, code: body.error?.code, detail: body.error?.detail };
  };
  return { app, post, queue, config, w };
}

describe('admission follows the signed expiry (audit C6)', () => {
  it('refuses "Expires never" before any work, and gives the approval back', async () => {
    const r = relay();
    const never = makePayload('0');
    expect(await r.post('open-swap', never)).toMatchObject({ status: 400, code: 'no-expiry' });
    expect(await r.post('take', { ...never, offerId: 'cd'.repeat(32) })).toMatchObject({
      status: 400,
      code: 'no-expiry',
    });
    expect(r.queue.stats().jobs).toBe(1); // only the holder
    // Not burnt as a replay: the same (refused) approval is refused for the same reason again.
    expect(await r.post('open-swap', never)).toMatchObject({ status: 400, code: 'no-expiry' });
  });

  it('refuses an approval that has expired or expires too soon to complete', async () => {
    const r = relay();
    expect(await r.post('open-swap', makePayload(String(nowS() - 10)))).toMatchObject({
      status: 400,
      code: 'approval-expired',
    });
    expect(await r.post('open-swap', makePayload(String(nowS() + 20)))).toMatchObject({
      status: 400,
      code: 'approval-expired',
    });
    expect(r.queue.stats().jobs).toBe(1);
  });

  it('refuses an expiry further ahead than an offer (one hour) or a take (minutes) may live', async () => {
    const r = relay();
    expect(await r.post('open-swap', makePayload(String(nowS() + 2 * 3600)))).toMatchObject({
      status: 400,
      code: 'expiry-too-far',
    });
    expect(await r.post('take', { ...makePayload(String(nowS() + 1800)), offerId: 'cd'.repeat(32) })).toMatchObject({
      status: 400,
      code: 'expiry-too-far',
    });
  });

  it('admits what the page signs: a make an hour ahead, a take five minutes ahead', async () => {
    const r = relay();
    expect((await r.post('open-swap', makePayload(String(nowS() + 3600)))).status).toBe(202);
    expect((await r.post('take', { ...makePayload(String(nowS() + 300)), offerId: 'cd'.repeat(32) })).status).toBe(202);
    expect(r.queue.stats().jobs).toBe(3);
  });

  it('publishes the limits in /v1/config', async () => {
    const r = relay();
    const cfg = (await (await r.app.request(API_PATHS.config)).json()) as { limits: Record<string, number> };
    expect(cfg.limits).toMatchObject({ offerMaxLifetimeSeconds: 3600, takeMaxLifetimeSeconds: 600 });
  });
});

describe('the replay guard remembers an approval until its signed expiry (audit C6 / F-B4)', () => {
  it('a make accepted once cannot be queued again after the guard TTL while its expiry is ahead', async () => {
    let now = 1_800_000_000;
    const w = callSigner();
    const rt = fakeAccountRuntime(ACCOUNT, [w.deviceKey], AUTH_NONCE);
    const replay = new DigestReplayGuard(60, () => now);
    const authorise = passportCallAuthoriser(() => rt, testArm, replay);
    const payload = makePayload(String(now + 3600));
    const req = { account: ACCOUNT, payload, passportAuth: w.passportAuth('open-swap', ACCOUNT, payload) };
    expect((await authorise({ action: 'open-swap' } as never, req as never)).ok).toBe(true);
    now += 600; // ten times the guard's own TTL, still before the signed expiry
    expect(await authorise({ action: 'open-swap' } as never, req as never)).toMatchObject({
      ok: false,
      code: 'replayed',
    });
    now += 3000 + 1; // past the expiry: the guard may forget it (admission refuses it as expired)
    expect((await authorise({ action: 'open-swap' } as never, req as never)).ok).toBe(true);
  });

  it('DigestReplayGuard.claim keeps the longer of its TTL and the expiry', () => {
    let now = 100;
    const g = new DigestReplayGuard(60, () => now);
    expect(g.claim('a', 1000)).toBe(true);
    expect(g.claim('b')).toBe(true);
    now = 500;
    expect(g.claim('a')).toBe(false);
    expect(g.claim('b')).toBe(true); // b had only the TTL
  });
});

function jobCtx(): JobContext & { stages: string[] } {
  const stages: string[] = [];
  return {
    requestId: '00'.repeat(16),
    log: silentLog(),
    stage: (s: string) => stages.push(s),
    prove: <T>(fn: () => Promise<T>) => fn(),
    stages,
  };
}

describe('run time: an approval that expired while queued is refused before any proof (audit C6)', () => {
  it('open-swap and take', async () => {
    let now = nowS();
    const w = callSigner();
    const rt = Object.assign(fakeAccountRuntime(ACCOUNT, [w.deviceKey], AUTH_NONCE), {
      providers: async () => ({}),
      compiledAccount: () => ({}),
    }) as unknown as PassportRuntime;
    const prove = vi.fn();
    const deps = {
      runtime: () => rt,
      arm: testArm,
      sponsor: new FakeSponsor(),
      kernelUrl: 'http://kernel.test',
      batcherUrl: 'http://batcher.test',
      replay: new DigestReplayGuard(3600),
      log: silentLog(),
      prove,
      now: () => now,
    };
    const payload = makePayload(String(now + 300));
    now += 290; // the queue was long: 10 s left, less than the 60 s a call needs
    const make = openSwapExecutor(deps)(
      { ...payload, account: ACCOUNT, passportAuth: w.passportAuth('open-swap', ACCOUNT, payload) },
      jobCtx(),
    );
    await expect(make).rejects.toMatchObject({ code: 'approval-expired' });
    const take = { ...payload, offerId: 'cd'.repeat(32) };
    await expect(
      takeExecutor(deps)({ ...take, account: ACCOUNT, passportAuth: w.passportAuth('take', ACCOUNT, take) }, jobCtx()),
    ).rejects.toMatchObject({ code: 'approval-expired' });
    expect(prove).not.toHaveBeenCalled();
  });
});

describe('the transaction TTL follows the signed expiry (audit C6)', () => {
  it('proveGuaranteedOffer proves the call with its intent TTL capped at validUntil, and reports that end', async () => {
    const hourMs = Math.floor(Date.now() / 1000) * 1000 + 3600_000;
    const validUntil = BigInt(nowS() + 300);
    // Upstream's builder, as it behaves: it hands the relay's proof provider an unproven ledger-v9
    // transaction whose intent has midnight-js's one-hour TTL, and returns a proven artefact whose
    // legs are in segment 0.
    const buildOffer = async (spec: Record<string, unknown>) => {
      const p = spec.providers as { proofProvider: { proveTx(tx: unknown): Promise<unknown> } };
      const tx = ledger.Transaction.fromParts('undeployed', undefined, undefined, ledger.Intent.new(new Date(hourMs)));
      await p.proofProvider.proveTx(tx);
      const proven = Object.assign(accountOffer(4711, 0, 'a1'.repeat(32), 2_000_000n, 'b2'.repeat(32), 2_100_000n), {
        serialize: () => new Uint8Array([1, 2, 3]),
      });
      return { proven: proven as never, proveMs: 1 };
    };
    const proved: unknown[] = [];
    const providers = {
      publicDataProvider: {},
      proofProvider: {
        proveTx: async (tx: unknown) => {
          proved.push(tx);
          return tx;
        },
      },
    } as unknown as PassportProviders;
    const rt = {
      client: {
        account: { CustodyAccount: { connect: async () => ({ privateStateId: 'p' }) } },
        witnesses: { withCoin: () => ({}), emptyCoinStore: () => ({}) },
      },
      compiledAccount: () => ({}),
    } as unknown as PassportRuntime;
    const out = await proveGuaranteedOffer({
      rt,
      providers,
      account: ACCOUNT,
      circuitId: 'open_swap_shielded_with_ed25519',
      buildOffer,
      offer: {
        call: {
          giveColor: new Uint8Array(32),
          giveAmount: 1n,
          recipientKind: 0n,
          recipient: new Uint8Array(32),
          want: { nonce: new Uint8Array(32), color: new Uint8Array(32), value: 1n },
          wantEntry: new Uint8Array(192),
          changeEntry: new Uint8Array(192),
          validUntil,
        },
        coin: { nonce: new Uint8Array(32), color: new Uint8Array(32), value: 1n, mt_index: 0n },
        authArgs: [],
      },
    });
    expect(proved).toHaveLength(1);
    const intents = (proved[0] as ledger.UnprovenTransaction).intents!;
    expect([...intents.values()].map((i) => i.ttl.getTime())).toEqual([Number(validUntil) * 1000]);
    expect(out.expiresAt).toBe(Number(validUntil) * 1000);
  });

  it('capIntentTtls caps a real ledger-v9 intent, and leaves an earlier TTL alone', () => {
    const t0 = Math.floor(Date.now() / 1000) * 1000;
    const tx = ledger.Transaction.fromParts(
      'undeployed',
      undefined,
      undefined,
      ledger.Intent.new(new Date(t0 + 3600_000)),
    );
    capIntentTtls(tx, new Date(t0 + 300_000));
    expect([...tx.intents!.values()][0]!.ttl.getTime()).toBe(t0 + 300_000);
    capIntentTtls(tx, new Date(t0 + 900_000)); // later than the TTL: unchanged
    expect([...tx.intents!.values()][0]!.ttl.getTime()).toBe(t0 + 300_000);
    // A transaction without intents is returned as it is.
    expect(capIntentTtls({}, new Date(t0))).toEqual({});
  });

  it('withProofDeadline caps before the inner provider proves; offerExpiry takes the earlier end', async () => {
    const seen: number[] = [];
    const inner = {
      proveTx: async (tx: ledger.UnprovenTransaction) => {
        seen.push([...tx.intents!.values()][0]!.ttl.getTime());
        return tx;
      },
      provingProvider: () => 'kept',
    };
    const t0 = Math.floor(Date.now() / 1000) * 1000;
    const p = withProofDeadline({ proofProvider: inner } as unknown as PassportProviders, new Date(t0 + 60_000));
    const tx = ledger.Transaction.fromParts(
      'undeployed',
      undefined,
      undefined,
      ledger.Intent.new(new Date(t0 + 3600_000)),
    );
    await (p.proofProvider as typeof inner).proveTx(tx);
    expect(seen).toEqual([t0 + 60_000]);
    expect((p.proofProvider as typeof inner).provingProvider()).toBe('kept'); // the rest delegates
    expect(offerExpiry(t0 + 3600_000, new Date(t0 + 60_000))).toBe(t0 + 60_000);
    expect(offerExpiry(t0 + 60_000, new Date(t0 + 3600_000))).toBe(t0 + 60_000);
    expect(offerExpiry(t0 + 60_000, null)).toBe(t0 + 60_000);
  });
});
