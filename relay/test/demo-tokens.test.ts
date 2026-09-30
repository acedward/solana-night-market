// B3, spec FR-007: the demo-token endpoint's limits and its claims store. Once per Solana key, a
// rolling daily cap, safe under concurrent requests, persistent across restarts; the admission
// checks (the key is a live device of an active account) run before any queue slot; a failed pack
// releases the claim; the pack is resolved against the registry.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ed25519 } from '@noble/curves/ed25519.js';
import { afterEach, describe, expect, it } from 'vitest';

import { API_PATHS, buildRelayActionMessage, registryFor, type DemoTokensInfo } from '@nightmarket/core';

import { testDevice, testScheme } from '../../packages/core/test/fixtures/test-signing.js';
import { defaultCatalogue, withDemoTokens } from '../src/actions/catalogue.js';
import { createApp } from '../src/app.js';
import { NonceStore } from '../src/auth/nonces.js';
import { notImplementedChainReader } from '../src/chain/reader.js';
import { DEFAULT_DEMO_PACK, loadConfig, parseDemoPack } from '../src/config.js';
import { demoTokens, demoTokensInfo, type DemoMint } from '../src/demo/action.js';
import { DemoTokenClaims } from '../src/demo/claims.js';
import { DemoPackError, resolvePack } from '../src/demo/pack.js';
import { JobQueue } from '../src/queue/jobs.js';
import { fakeAccountRuntime, testArm } from './fake-arm.js';
import { FakeSponsor, LOCAL_TOKENS, silentLog } from './harness.js';

const ACCOUNT = '5e'.repeat(32);
const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'nm-claims-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const key = (n: number) => n.toString(16).padStart(2, '0').repeat(32);

describe('the claims store', () => {
  it('reserves once per key, ever; a confirmed claim stays; a released one can be claimed again', () => {
    const c = new DemoTokenClaims({ file: null, dailyCap: 10 });
    const r = c.reserve(key(1), ACCOUNT);
    expect(r.ok).toBe(true);
    expect(c.reserve(key(1), ACCOUNT)).toMatchObject({ ok: false, code: 'already-claimed' });
    if (r.ok) r.release();
    const again = c.reserve(key(1), ACCOUNT);
    expect(again.ok).toBe(true);
    if (again.ok) again.confirm(['aa'.repeat(32)]);
    expect(c.reserve(key(1), ACCOUNT)).toMatchObject({ ok: false, code: 'already-claimed' });
    // Another account does not help: the limit is the key's.
    expect(c.reserve(key(1), 'cd'.repeat(32))).toMatchObject({ ok: false, code: 'already-claimed' });
    expect(c.hasClaimed(key(1))).toBe(true);
    expect(c.hasClaimed(key(2))).toBe(false);
  });

  it('caps claims in any rolling 24 hours, across keys', () => {
    let now = 1_000_000;
    const c = new DemoTokenClaims({ file: null, dailyCap: 2, now: () => now });
    expect(c.reserve(key(1), ACCOUNT).ok).toBe(true);
    now += 3600;
    expect(c.reserve(key(2), ACCOUNT).ok).toBe(true);
    expect(c.reserve(key(3), ACCOUNT)).toMatchObject({ ok: false, code: 'daily-cap' });
    expect(c.remainingToday()).toBe(0);
    now += 86_400 - 3600 + 1; // the first claim is now older than 24 h
    expect(c.remainingToday()).toBe(1);
    expect(c.reserve(key(3), ACCOUNT).ok).toBe(true);
    // Key 1 still cannot claim again, whatever the day.
    expect(c.reserve(key(1), ACCOUNT)).toMatchObject({ ok: false, code: 'already-claimed' });
  });

  it('is safe under concurrent requests: many racing claims, exactly the cap and one per key pass', async () => {
    const c = new DemoTokenClaims({ file: join(tmp(), 'claims.json'), dailyCap: 5 });
    const outcomes = await Promise.all(
      Array.from({ length: 40 }, (_, i) => Promise.resolve().then(() => c.reserve(key(1 + (i % 10)), ACCOUNT))),
    );
    expect(outcomes.filter((o) => o.ok)).toHaveLength(5);
    expect(outcomes.filter((o) => !o.ok && o.code === 'daily-cap').length).toBeGreaterThan(0);
    expect(outcomes.filter((o) => !o.ok && o.code === 'already-claimed').length).toBeGreaterThan(0);
  });

  it('persists claims across restarts, and releases a reservation a stopped relay left behind', () => {
    const file = join(tmp(), 'claims.json');
    const a = new DemoTokenClaims({ file, dailyCap: 10 });
    const done = a.reserve(key(1), ACCOUNT);
    if (done.ok) done.confirm(['t1', 't2']);
    a.reserve(key(2), ACCOUNT); // left reserved: the relay "stopped mid-job"
    const onDisk = JSON.parse(readFileSync(file, 'utf8')) as { format: string; claims: unknown[] };
    expect(onDisk.format).toBe('night-market-demo-token-claims/1');
    expect(onDisk.claims).toHaveLength(2);
    let recovered = 0;
    const b = new DemoTokenClaims({ file, dailyCap: 10, onRecovered: (n) => (recovered = n) });
    expect(recovered).toBe(1);
    expect(b.hasClaimed(key(1))).toBe(true);
    expect(b.hasClaimed(key(2))).toBe(false);
    expect(b.reserve(key(1), ACCOUNT)).toMatchObject({ ok: false, code: 'already-claimed' });
    expect(b.reserve(key(2), ACCOUNT).ok).toBe(true);
  });

  it('refuses a claims file in use by another live relay, and takes over a stale lock', () => {
    const file = join(tmp(), 'claims.json');
    writeFileSync(`${file}.lock`, `${process.ppid}\n`); // a live process that is not us
    expect(() => new DemoTokenClaims({ file, dailyCap: 1 }).lock()).toThrow(/in use by another relay/);
    writeFileSync(`${file}.lock`, '999999999\n'); // no such process: a crash left it
    const c = new DemoTokenClaims({ file, dailyCap: 1 });
    c.lock();
    expect(readFileSync(`${file}.lock`, 'utf8').trim()).toBe(String(process.pid));
    c.unlock();
  });
});

describe('the pack', () => {
  const stagenet = registryFor('stagenet');

  it('defaults to 1,000 twUSDC, 0.1 twBTC and 1 twETH, in base units, with each faucet', () => {
    const pack = resolvePack(parseDemoPack(DEFAULT_DEMO_PACK), stagenet);
    expect(pack.map((p) => [p.symbol, p.amount])).toEqual([
      ['twUSDC', '1000000000'],
      ['twBTC', '10000000'],
      ['twETH', '1000000000000000000'],
    ]);
    for (const p of pack) {
      expect(p.faucet).toMatch(/^[0-9a-f]{64}$/);
      expect(p.domainSeparator).toBe(`mint-test-tokens:${p.symbol}`);
      expect(p.colour).toBe(stagenet.bySymbol(p.symbol)!.midnightColour);
    }
  });

  it('refuses unknown or unshielded tokens, zero, more than a u64, and bad syntax', () => {
    expect(() => resolvePack([{ symbol: 'twXYZ', amount: '1' }], stagenet)).toThrow(DemoPackError);
    expect(() => resolvePack([{ symbol: 'utwUSDC', amount: '1' }], stagenet)).toThrow(/not a shielded/);
    expect(() => resolvePack([{ symbol: 'twUSDC', amount: '0' }], stagenet)).toThrow(
      /greater than zero|not a mintable/,
    );
    expect(() => resolvePack([{ symbol: 'twETH', amount: '19' }], stagenet)).toThrow(/not a mintable/);
    expect(() => parseDemoPack('twUSDC=5')).toThrow(/SYMBOL:AMOUNT/);
    expect(() => parseDemoPack('twUSDC:1,twusdc:2')).toThrow(/twice/);
    const local = loadConfig({ RELAY_NETWORK: 'undeployed', TOKENS_FILE: '/t' }, () =>
      JSON.stringify(LOCAL_TOKENS),
    ).config;
    // A local registry without faucet contracts cannot mint.
    expect(() => resolvePack([{ symbol: 'tA', amount: '1' }], local.tokens)).toThrow(/no faucet contract/);
  });

  it('needs a data dir when enabled (the claims store)', () => {
    const env = { RELAY_NETWORK: 'stagenet', DEMO_TOKENS_ENABLED: 'true' };
    expect(() => loadConfig(env, () => '')).toThrow(/RELAY_DATA_DIR/);
    const { config } = loadConfig({ ...env, RELAY_DATA_DIR: '/var/lib/nm/' }, () => '');
    expect(config.demoTokens).toMatchObject({
      enabled: true,
      dailyCap: 100,
      path: 'direct',
      claimsFile: '/var/lib/nm/demo-token-claims.json',
    });
    expect(() => loadConfig({ ...env, RELAY_DATA_DIR: '/d', DEMO_TOKENS_PATH: 'magic' }, () => '')).toThrow(
      /DEMO_TOKENS_PATH/,
    );
  });
});

// ── The route: POST /v1/actions/demo-tokens ─────────────────────────────────

function relay(opts: { dailyCap?: number; devices?: string[]; mint?: DemoMint } = {}) {
  const secrets = Array.from({ length: 4 }, () => ed25519.utils.randomSecretKey());
  const devices = secrets.map((s) => testDevice(s));
  const config = loadConfig({ RELAY_NETWORK: 'undeployed', TOKENS_FILE: '/t' }, () =>
    JSON.stringify(LOCAL_TOKENS),
  ).config;
  const log = silentLog();
  const rt = fakeAccountRuntime(ACCOUNT, opts.devices ?? devices.map((d) => d.deviceKey));
  const sponsor = new FakeSponsor();
  const claims = new DemoTokenClaims({ file: null, dailyCap: opts.dailyCap ?? 100 });
  const minted: string[] = [];
  const pack = [
    {
      symbol: 'tA',
      colour: 'aa'.repeat(32),
      decimals: 6,
      amount: '1000000',
      faucet: 'fa'.repeat(32),
      domainSeparator: 'x',
    },
  ];
  const demo = demoTokens({
    runtime: () => rt,
    sponsor,
    claims,
    pack,
    path: 'via-sponsor',
    arm: testArm,
    mint:
      opts.mint ??
      (async ({ item, account }) => {
        minted.push(`${item.symbol}->${account}`);
        return { mint: 'm1'.repeat(32), deposit: 'd1'.repeat(32) };
      }),
    log,
  });
  const nonces = new NonceStore(600, 1000);
  const queue = new JobQueue({ ttlSeconds: 600, maxJobs: 100, log });
  const catalogue = withDemoTokens(defaultCatalogue(), demo);
  const app = createApp({
    config: { ...config, limits: { ...config.limits, actionsPerMinute: 1000, actionsPerOwnerPerMinute: 1000 } },
    version: 'test',
    log,
    nonces,
    queue,
    catalogue,
    sponsor,
    health: async () => {
      throw new Error('unused');
    },
    chain: notImplementedChainReader,
    scheme: testScheme,
    demoTokens: demoTokensInfo({ claims, pack, enabled: true, dailyCap: opts.dailyCap ?? 100 }),
    clientAddress: () => '198.51.100.9',
  });
  const claim = async (d: (typeof devices)[number], account = ACCOUNT) => {
    const { nonce } = (await (await app.request(API_PATHS.nonce)).json()) as { nonce: string };
    const message = buildRelayActionMessage({
      action: 'demo-tokens',
      network: config.network.name,
      owner: d.deviceKey,
      account,
      payload: {},
      nonce,
      expiry: Math.floor(Date.now() / 1000) + 120,
    });
    return app.request(API_PATHS.action('demo-tokens'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account, payload: {}, auth: { message, signature: d.signEnvelope(message) } }),
    });
  };
  return { app, devices, claim, queue, claims, minted, sponsor };
}

const errorOf = async (res: Response) => ((await res.json()) as { error: { code: string; detail?: string } }).error;

describe('POST /v1/actions/demo-tokens', () => {
  it('mints the pack into the account for a device of it, then refuses the same key forever', async () => {
    const r = relay();
    const res = await r.claim(r.devices[0]!);
    expect(res.status).toBe(202);
    const { job } = (await res.json()) as { job: { requestId: string } };
    await r.queue.settled(job.requestId);
    const view = r.queue.get(job.requestId)!;
    expect(view.state).toBe('succeeded');
    expect(view.result).toMatchObject({ account: ACCOUNT, path: 'via-sponsor', minted: [{ symbol: 'tA' }] });
    expect(r.minted).toEqual([`tA->${ACCOUNT}`]);
    const again = await r.claim(r.devices[0]!);
    expect(again.status).toBe(429);
    expect((await errorOf(again)).code).toBe('already-claimed');
    // GET /v1/demo-tokens shows it.
    const info = (await (
      await r.app.request(`${API_PATHS.demoTokens}?owner=${r.devices[0]!.deviceKey}`)
    ).json()) as DemoTokensInfo;
    expect(info).toMatchObject({ enabled: true, perKey: 1, claimed: true });
    expect(info.pack[0]).toEqual({ symbol: 'tA', colour: 'aa'.repeat(32), decimals: 6, amount: '1000000' });
  });

  it('refuses a key that is not a device of the account, before any queue slot', async () => {
    const r = relay({ devices: [key(9)] });
    const res = await r.claim(r.devices[0]!);
    expect(res.status).toBe(401);
    expect(await errorOf(res)).toMatchObject({ code: 'unauthorised', detail: 'wrong-signer' });
    expect(r.queue.stats().jobs).toBe(0);
    expect(r.claims.hasClaimed(r.devices[0]!.deviceKey)).toBe(false);
  });

  it('refuses an account that does not exist', async () => {
    const r = relay();
    const res = await r.claim(r.devices[0]!, 'cd'.repeat(32));
    expect(res.status).toBe(403);
    expect((await errorOf(res)).code).toBe('wrong-account');
  });

  it('applies the daily cap across keys', async () => {
    const r = relay({ dailyCap: 2 });
    expect((await r.claim(r.devices[0]!)).status).toBe(202);
    expect((await r.claim(r.devices[1]!)).status).toBe(202);
    const third = await r.claim(r.devices[2]!);
    expect(third.status).toBe(429);
    expect((await errorOf(third)).code).toBe('daily-cap');
  });

  it('admits exactly one of many concurrent claims by the same key', async () => {
    const r = relay();
    const results = await Promise.all(Array.from({ length: 6 }, () => r.claim(r.devices[1]!)));
    const statuses = results.map((x) => x.status).sort();
    expect(statuses).toEqual([202, 429, 429, 429, 429, 429]);
  });

  it('releases the claim when the pack fails, so the key can claim again', async () => {
    let fail = true;
    const r = relay({
      mint: async () => {
        if (fail) throw new Error('the faucet was unreachable');
        return { mintAndDeposit: 'ee'.repeat(32) };
      },
    });
    const first = (await (await r.claim(r.devices[0]!)).json()) as { job: { requestId: string } };
    await r.queue.settled(first.job.requestId);
    expect(r.queue.get(first.job.requestId)!.state).toBe('failed');
    expect(r.claims.hasClaimed(r.devices[0]!.deviceKey)).toBe(false);
    fail = false;
    const second = (await (await r.claim(r.devices[0]!)).json()) as { job: { requestId: string } };
    await r.queue.settled(second.job.requestId);
    expect(r.queue.get(second.job.requestId)!.state).toBe('succeeded');
    expect(r.claims.hasClaimed(r.devices[0]!.deviceKey)).toBe(true);
  });

  it('reports the endpoint as off when no pack is configured', async () => {
    const config = loadConfig({ RELAY_NETWORK: 'undeployed', TOKENS_FILE: '/t' }, () =>
      JSON.stringify(LOCAL_TOKENS),
    ).config;
    const app = createApp({
      config,
      version: 'test',
      log: silentLog(),
      nonces: new NonceStore(600, 10),
      queue: new JobQueue({ ttlSeconds: 60, maxJobs: 10, log: silentLog() }),
      catalogue: defaultCatalogue(),
      sponsor: new FakeSponsor(),
      health: async () => {
        throw new Error('unused');
      },
      chain: notImplementedChainReader,
    });
    const info = (await (await app.request(API_PATHS.demoTokens)).json()) as DemoTokensInfo;
    expect(info).toMatchObject({ enabled: false, pack: [] });
    expect((await app.request(`${API_PATHS.demoTokens}?owner=xyz`)).status).toBe(400);
  });
});
