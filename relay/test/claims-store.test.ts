// AA 00047 P9, audit C8 (F-B7, F-B8, F-B9, F-B10): the demo-token claims store and its admission.
//
//   F-B7  a pack that fails part-way keeps the daily charge and the tokens that landed; the key may
//         claim the REST (never a token twice); failed deliveries are bounded;
//   F-B8  the store reads and recovers its file only once it holds the lock: a relay refused the
//         lock never rewrites a live relay's file;
//   F-B9  every change is written before memory changes: a write that fails leaves no phantom
//         reservation, and a confirmation that could not be written is not lost on restart;
//   F-B10 membership is the device's entry at the use counter the claim names: no 0..255 scan.

import * as fs from 'node:fs';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ed25519 } from '@noble/curves/ed25519.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { API_PATHS, buildRelayActionMessage } from '@nightmarket/core';

import { testDevice, testScheme } from '../../packages/core/test/fixtures/test-signing.js';
import { defaultCatalogue, withDemoTokens } from '../src/actions/catalogue.js';
import { createApp } from '../src/app.js';
import { NonceStore } from '../src/auth/nonces.js';
import { notImplementedChainReader } from '../src/chain/reader.js';
import { loadConfig } from '../src/config.js';
import { demoTokens, type DemoMint } from '../src/demo/action.js';
import { ClaimsStoreError, DemoTokenClaims } from '../src/demo/claims.js';
import type { ResolvedPackItem } from '../src/demo/pack.js';
import type { PassportRuntime } from '../src/passport/runtime.js';
import { JobQueue } from '../src/queue/jobs.js';
import { testArm, testDeviceEntry } from './fake-arm.js';
import { FakeSponsor, LOCAL_TOKENS, silentLog } from './harness.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, renameSync: vi.fn(actual.renameSync) };
});

const ACCOUNT = '5e'.repeat(32);
const key = (n: number) => n.toString(16).padStart(2, '0').repeat(32);
const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'nm-claims-p9-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  vi.mocked(fs.renameSync).mockReset();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const enospc = () => Object.assign(new Error('ENOSPC: no space left on device, rename'), { code: 'ENOSPC' });

const PACK: ResolvedPackItem[] = ['tA', 'tB', 'tC'].map((symbol, i) => ({
  symbol,
  colour: (0xa0 + i).toString(16).repeat(32),
  decimals: 6,
  amount: '1000000',
  faucet: 'fa'.repeat(32),
  domainSeparator: `x:${symbol}`,
}));

/** A runtime whose one account has the given devices live at the given use counters. */
function runtimeWith(devices: Array<{ key: string; counter: bigint }>): PassportRuntime {
  const live = new Set(devices.map((d) => testDeviceEntry(ACCOUNT, d.key, 0n, d.counter)));
  const ledger = {
    booted: true,
    device_count: BigInt(devices.length),
    device_epoch: 0n,
    auth_nonce: 3n,
    inbox_count: 0n,
    enc_key: new Uint8Array(32),
    devices: { member: (e: Uint8Array) => live.has(Buffer.from(e).toString('hex')) },
  };
  return { ledgerState: async (a: string) => (a === ACCOUNT ? ledger : null) } as unknown as PassportRuntime;
}

/** The demo-token route as main.ts wires it, with a file-backed store and the test's mint. */
function relay(opts: {
  file?: string | null;
  mint: DemoMint;
  dailyCap?: number;
  devices?: Array<{ key: string; counter: bigint }>;
  signer?: ReturnType<typeof testDevice>;
}) {
  const signer = opts.signer ?? testDevice(ed25519.utils.randomSecretKey());
  const config = loadConfig({ RELAY_NETWORK: 'undeployed', TOKENS_FILE: '/t' }, () =>
    JSON.stringify(LOCAL_TOKENS),
  ).config;
  const log = silentLog();
  const claims = new DemoTokenClaims({ file: opts.file ?? null, dailyCap: opts.dailyCap ?? 10 });
  claims.lock();
  const rt = runtimeWith(opts.devices ?? [{ key: signer.deviceKey, counter: 0n }]);
  const queue = new JobQueue({ ttlSeconds: 600, maxJobs: 100, log });
  const catalogue = withDemoTokens(
    defaultCatalogue(),
    demoTokens({
      runtime: () => rt,
      sponsor: new FakeSponsor(),
      claims,
      pack: PACK,
      path: 'direct',
      arm: testArm,
      mint: opts.mint,
      log,
    }),
  );
  const app = createApp({
    config: { ...config, limits: { ...config.limits, actionsPerMinute: 1000, actionsPerOwnerPerMinute: 1000 } },
    version: 'test',
    log,
    nonces: new NonceStore(600, 1000),
    queue,
    catalogue,
    sponsor: new FakeSponsor(),
    health: async () => {
      throw new Error('unused');
    },
    chain: notImplementedChainReader,
    scheme: testScheme,
    clientAddress: () => '198.51.100.9',
  });
  const claim = async (useCounter = '0') => {
    const { nonce } = (await (await app.request(API_PATHS.nonce)).json()) as { nonce: string };
    const payload = { useCounter };
    const message = buildRelayActionMessage({
      action: 'demo-tokens',
      network: config.network.name,
      owner: signer.deviceKey,
      account: ACCOUNT,
      payload,
      nonce,
      expiry: Math.floor(Date.now() / 1000) + 120,
    });
    const res = await app.request(API_PATHS.action('demo-tokens'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account: ACCOUNT, payload, auth: { message, signature: signer.signEnvelope(message) } }),
    });
    const body = (await res.json()) as { job?: { requestId: string }; error?: { code: string; detail?: string } };
    if (body.job) await queue.settled(body.job.requestId);
    const job = body.job ? queue.get(body.job.requestId) : undefined;
    return { status: res.status, error: body.error, job };
  };
  return { claim, claims, signer, queue };
}

describe('F-B7: a pack that fails part-way keeps its charge and what landed; the rest can be claimed', () => {
  it('records each token as it lands, keeps the daily charge, and resumes without minting twice', async () => {
    const minted: string[] = [];
    let failOn: string | null = 'tB';
    const r = relay({
      dailyCap: 1,
      mint: async ({ item }) => {
        if (item.symbol === failOn) throw new Error('the faucet was unreachable');
        minted.push(item.symbol);
        return { mintAndDeposit: `${item.symbol}-tx`.padEnd(64, '0') };
      },
    });
    const first = await r.claim();
    expect(first.status).toBe(202);
    expect(first.job?.state).toBe('failed');
    expect(minted).toEqual(['tA']);
    // The completed mint's quota is NOT erased: still charged today, the record kept with tA delivered.
    expect(r.claims.remainingToday()).toBe(0);
    expect(r.claims.record(r.signer.deviceKey)).toMatchObject({
      state: 'partial',
      failures: 1,
      delivered: { [PACK[0]!.colour]: { mintAndDeposit: expect.stringMatching(/^tA-tx/) } },
    });
    // The key may claim the rest, even with the day's cap used (it was charged once).
    failOn = null;
    const second = await r.claim();
    expect(second.status).toBe(202);
    expect(second.job?.state).toBe('succeeded');
    expect(minted).toEqual(['tA', 'tB', 'tC']); // tA was not minted again
    expect(second.job?.result).toMatchObject({ minted: [{ symbol: 'tA' }, { symbol: 'tB' }, { symbol: 'tC' }] });
    expect(r.claims.record(r.signer.deviceKey)).toMatchObject({ state: 'claimed' });
    expect(r.claims.record(r.signer.deviceKey)!.txs).toHaveLength(3);
    // And then never again.
    expect((await r.claim()).error?.code).toBe('already-claimed');
  });

  it('bounds failed deliveries: after DEMO_TOKENS_MAX_ATTEMPTS (3) the key is refused', async () => {
    let calls = 0;
    const r = relay({
      mint: async () => {
        calls++;
        throw new Error('the faucet keeps failing');
      },
    });
    for (let i = 0; i < 3; i++) expect((await r.claim()).job?.state).toBe('failed');
    const fourth = await r.claim();
    expect(fourth.status).toBe(429);
    expect(fourth.error?.code).toBe('attempts-exhausted');
    expect(calls).toBe(3);
    expect(r.claims.hasClaimed(r.signer.deviceKey)).toBe(true);
  });

  it('a failure before any mint (the market had no wallet) does not count against the key', async () => {
    const c = new DemoTokenClaims({ file: null, dailyCap: 10 });
    for (let i = 0; i < 5; i++) {
      const r = c.reserve(key(1), ACCOUNT);
      expect(r.ok).toBe(true);
      if (r.ok) r.fail(false);
    }
    expect(c.record(key(1))).toMatchObject({ state: 'partial', failures: 0 });
    expect(c.claimedToday()).toBe(1);
  });

  it('a resumed claim must go to the same account', () => {
    const c = new DemoTokenClaims({ file: null, dailyCap: 10 });
    const r = c.reserve(key(1), ACCOUNT);
    if (r.ok) r.fail();
    expect(c.reserve(key(1), 'cd'.repeat(32))).toMatchObject({ ok: false, code: 'already-claimed' });
    expect(c.reserve(key(1), ACCOUNT)).toMatchObject({ ok: true, resumed: true });
  });
});

describe('F-B8: the file is read and recovered only under the lock', () => {
  it('a relay refused the lock leaves a live relay’s file untouched (its reservation stays)', () => {
    const file = join(tmp(), 'claims.json');
    const live = `${JSON.stringify(
      {
        format: 'night-market-demo-token-claims/1',
        claims: [{ owner: key(1), account: ACCOUNT, state: 'reserved', at: 1_800_000_000 }],
      },
      null,
      1,
    )}\n`;
    writeFileSync(file, live);
    writeFileSync(`${file}.lock`, `${process.ppid}\n`); // another live relay holds it
    const second = new DemoTokenClaims({ file, dailyCap: 10 });
    expect(() => second.lock()).toThrow(ClaimsStoreError);
    expect(readFileSync(file, 'utf8')).toBe(live);
    expect(readFileSync(`${file}.lock`, 'utf8').trim()).toBe(String(process.ppid));
  });

  it('constructing a store reads nothing; lock() loads and recovers, then the store can be used', () => {
    const file = join(tmp(), 'claims.json');
    writeFileSync(
      file,
      JSON.stringify({
        format: 'night-market-demo-token-claims/1',
        claims: [{ owner: key(2), account: ACCOUNT, state: 'reserved', at: Math.floor(Date.now() / 1000) }],
      }),
    );
    const before = readFileSync(file, 'utf8');
    let recovered = 0;
    const c = new DemoTokenClaims({ file, dailyCap: 10, onRecovered: (n) => (recovered = n) });
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(recovered).toBe(0);
    expect(() => c.reserve(key(3), ACCOUNT)).toThrow(/not open/);
    c.lock();
    expect(recovered).toBe(1);
    expect(c.record(key(2))).toMatchObject({ state: 'partial' });
    expect(c.claimedToday()).toBe(1);
    c.unlock();
  });
});

describe('F-B9: written first, then applied in memory', () => {
  it('a reservation that cannot be written is refused, and leaves no phantom behind', () => {
    const file = join(tmp(), 'claims.json');
    const c = new DemoTokenClaims({ file, dailyCap: 1 });
    c.lock();
    vi.mocked(fs.renameSync).mockImplementationOnce(() => {
      throw enospc();
    });
    expect(c.reserve(key(1), ACCOUNT)).toMatchObject({ ok: false, code: 'store-unavailable' });
    expect(c.hasClaimed(key(1))).toBe(false);
    expect(c.claimedToday()).toBe(0);
    // The disk is fine again: the same key gets the day's only slot.
    expect(c.reserve(key(1), ACCOUNT).ok).toBe(true);
    c.unlock();
  });

  it('the route answers 503 store-unavailable, and the next claim goes through', async () => {
    const file = join(tmp(), 'claims.json');
    const r = relay({ file, mint: async () => ({ mintAndDeposit: 'ee'.repeat(32) }) });
    vi.mocked(fs.renameSync).mockImplementationOnce(() => {
      throw enospc();
    });
    const refused = await r.claim();
    expect(refused.status).toBe(503);
    expect(refused.error?.code).toBe('store-unavailable');
    expect((await r.claim()).job?.state).toBe('succeeded');
  });

  it('a confirmation that cannot be written is not lost: after a restart the pack is complete, nothing re-minted', async () => {
    const file = join(tmp(), 'claims.json');
    const minted: string[] = [];
    const mint: DemoMint = async ({ item }) => {
      minted.push(item.symbol);
      return { mintAndDeposit: `${item.symbol}`.padEnd(64, '0') };
    };
    const r = relay({ file, mint });
    // Writes: reserve (1), tA (2), tB (3), tC (4), confirm (5) fails; then the failure is recorded.
    const actual = await vi.importActual<typeof fs>('node:fs');
    let writes = 0;
    vi.mocked(fs.renameSync).mockImplementation((from, to) => {
      writes++;
      if (writes === 5) throw enospc();
      return actual.renameSync(from, to);
    });
    const first = await r.claim();
    expect(first.job?.state).toBe('failed');
    expect(minted).toEqual(['tA', 'tB', 'tC']);
    vi.mocked(fs.renameSync).mockReset();
    vi.mocked(fs.renameSync).mockImplementation(actual.renameSync);
    // Memory was not marked claimed without the disk; the record still holds every token.
    r.claims.unlock();
    // A restart: the same file, a new store.
    const restarted = relay({ file, mint, signer: r.signer });
    expect(restarted.claims.record(r.signer.deviceKey)).toMatchObject({ state: 'partial' });
    expect(Object.keys(restarted.claims.record(r.signer.deviceKey)!.delivered ?? {})).toHaveLength(3);
    const again = await restarted.claim();
    expect(again.job?.state).toBe('succeeded');
    expect(minted).toEqual(['tA', 'tB', 'tC']); // nothing minted twice
    expect(restarted.claims.record(r.signer.deviceKey)).toMatchObject({ state: 'claimed' });
    restarted.claims.unlock();
  });
});

describe('F-B10: membership at the claimed use counter, not a 0..255 scan', () => {
  it('a device past counter 255 can claim at its counter', async () => {
    const signer = testDevice();
    const r = relay({
      signer,
      devices: [{ key: signer.deviceKey, counter: 300n }],
      mint: async () => ({ mintAndDeposit: 'ee'.repeat(32) }),
    });
    const res = await r.claim('300');
    expect(res.status).toBe(202);
    expect(res.job?.state).toBe('succeeded');
  });

  it('a claim naming another counter than the live one, or none, is refused before any reservation', async () => {
    const signer = testDevice();
    const r = relay({
      signer,
      devices: [{ key: signer.deviceKey, counter: 300n }],
      mint: async () => ({ mintAndDeposit: 'ee'.repeat(32) }),
    });
    const wrong = await r.claim('299');
    expect(wrong.status).toBe(401);
    expect(wrong.error).toMatchObject({ code: 'unauthorised', detail: 'wrong-signer' });
    expect(r.claims.hasClaimed(signer.deviceKey)).toBe(false);
    expect(r.claims.claimedToday()).toBe(0);
    expect(r.queue.stats().jobs).toBe(0);
  });
});
