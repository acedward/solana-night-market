// AA 00047 P10, audit round 2 R2-8 (F-A2-6; round 1 C9 / F-A7.3): the relay's authorisation nonces.
//
// Round 1: a client spread over many addresses pushed other customers' outstanding nonces out.
// Round 2: nothing was evicted any more, but the 50,000-nonce store filled from 1,667 addresses of
// ONE IPv6 /64, and then every client was refused (503) for the nonce TTL. Now:
//   - nonces are STATELESS (an HMAC over their expiry and randomness): issuing one stores nothing, so
//     no flood from any number of addresses can fill anything or lock anyone out;
//   - issuance is bounded by the per-client rate limit, and an IPv6 client is keyed by its /64;
//   - only USED nonces are remembered (until they expire), so a replay is still refused; past
//     AUTH_MAX_USED_NONCES the oldest is forgotten, never a refusal.

import { describe, expect, it } from 'vitest';

import { API_PATHS } from '@nightmarket/core';

import { testScheme } from '../../packages/core/test/fixtures/test-signing.js';
import { NonceStore } from '../src/auth/nonces.js';
import { createApp } from '../src/app.js';
import { defaultCatalogue } from '../src/actions/catalogue.js';
import { notImplementedChainReader } from '../src/chain/reader.js';
import { JobQueue } from '../src/queue/jobs.js';
import { FakeSponsor, newWallet, post, signedBody, silentLog, testConfig } from './harness.js';

/** The store as main.ts builds it from `config` (the old store's settings, when they exist). */
function storeFor(config: ReturnType<typeof testConfig>): NonceStore {
  const l = config.limits as unknown as Record<string, number | undefined>;
  return new (NonceStore as unknown as new (...a: unknown[]) => NonceStore)(
    config.limits.nonceTtlSeconds,
    l.maxUsedNonces ?? l.maxNonces,
    undefined,
    l.maxNoncesPerClient,
  );
}

describe('NonceStore (unit, stateless)', () => {
  const ok = (r: ReturnType<NonceStore['issue']>) => {
    if (!r.ok) throw new Error(`refused: ${r.refused}`);
    return r;
  };

  it('issuing stores nothing and never refuses, however many clients ask', () => {
    const s = new NonceStore(60, 100, () => 1000);
    for (let i = 0; i < 5000; i++) ok(s.issue(`2001:db8:${i.toString(16)}::1`));
    expect(s.size).toEqual({ issued: 0, used: 0 });
  });

  it('a nonce is accepted once; a replay is "used"; a forged, altered or expired one is "unknown"', () => {
    let now = 1000;
    const s = new NonceStore(60, 100, () => now);
    const { nonce, expiresAt } = ok(s.issue());
    expect(nonce).toMatch(/^0x[0-9a-f]{64}$/);
    expect(expiresAt).toBe(1060);
    // Altered: any byte (the expiry, the randomness, the MAC).
    for (const i of [2, 15, 40, 65]) {
      const flipped = nonce.slice(0, i) + (nonce[i] === '0' ? '1' : '0') + nonce.slice(i + 1);
      expect(s.consume(flipped)).toBe('unknown');
    }
    expect(s.consume(`0x${'42'.repeat(32)}`)).toBe('unknown');
    expect(s.consume(nonce)).toBe('ok');
    expect(s.consume(nonce)).toBe('used');
    const late = ok(s.issue()).nonce;
    now = 1061;
    expect(s.consume(late)).toBe('unknown');
  });

  it('a nonce issued by another process (a restart: a new key) is unknown', () => {
    const a = new NonceStore(60, 100, () => 1000);
    const b = new NonceStore(60, 100, () => 1000);
    expect(b.consume(ok(a.issue()).nonce)).toBe('unknown');
  });

  it('a full used set forgets its oldest entry to make room: never a refusal', () => {
    const s = new NonceStore(60, 3, () => 1000);
    const used = Array.from({ length: 5 }, () => ok(s.issue()).nonce);
    for (const n of used) expect(s.consume(n)).toBe('ok');
    expect(s.size.used).toBe(3);
    expect(s.evicted).toBe(2);
    // The newest are still refused as replays.
    expect(s.consume(used[4]!)).toBe('used');
  });
});

describe('GET /v1/auth/nonce under a flood (audit round 2 R2-8)', () => {
  function relay(env: Record<string, string>) {
    const config = testConfig(env);
    let client = '198.51.100.7';
    const log = silentLog();
    const nonces = storeFor(config);
    const queue = new JobQueue({ ttlSeconds: 600, maxJobs: 100, log });
    const catalogue = defaultCatalogue();
    const app = createApp({
      config,
      version: 'test',
      log,
      nonces,
      queue,
      catalogue,
      sponsor: new FakeSponsor(),
      health: async () => {
        throw new Error('unused');
      },
      chain: notImplementedChainReader,
      scheme: testScheme,
      clientAddress: () => client,
    });
    return { app, config, log, nonces, queue, catalogue, as: (c: string) => (client = c) };
  }

  it('a flood from many networks fills nothing: an honest client is served and its signed call accepted', async () => {
    // (The old store held at most AUTH_MAX_NONCES outstanding and refused everyone past it.)
    const r = relay({ RATE_LIMIT_NONCES_PER_MIN: '1000', AUTH_MAX_NONCES: '300' });
    const h = { ...r, app: r.app } as unknown as Parameters<typeof signedBody>[0];
    const victim = newWallet();
    const body = await signedBody(h, 'register', victim); // the victim's nonce, taken now
    const statuses = new Map<number, number>();
    for (let net = 0; net < 20; net++) {
      r.as(`2001:db8:${net.toString(16)}::1`); // twenty different /64s
      for (let i = 0; i < 30; i++) {
        const res = await r.app.request(API_PATHS.nonce);
        statuses.set(res.status, (statuses.get(res.status) ?? 0) + 1);
      }
    }
    expect([...statuses.entries()]).toEqual([[200, 600]]);
    r.as('198.51.100.7');
    expect((await r.app.request(API_PATHS.nonce)).status).toBe(200);
    // The victim's nonce is still good: the call passes authorisation (the stub executor is queued).
    expect((await post(h, 'register', body)).status).toBe(202);
  });

  it('every address of one IPv6 /64 shares one nonce rate limit; another network is served', async () => {
    const r = relay({});
    const codes: number[] = [];
    for (let i = 0; i < 40; i++) {
      r.as(`2001:db8:0:1::${(i + 1).toString(16)}`); // 40 addresses, one /64
      codes.push((await r.app.request(API_PATHS.nonce)).status);
    }
    expect(codes.filter((c) => c === 200)).toHaveLength(r.config.limits.noncesPerMinute);
    expect(codes.slice(r.config.limits.noncesPerMinute).every((c) => c === 429)).toBe(true);
    r.as('2001:db8:0:2::1'); // the next /64
    expect((await r.app.request(API_PATHS.nonce)).status).toBe(200);
    r.as('198.51.100.7');
    expect((await r.app.request(API_PATHS.nonce)).status).toBe(200);
  });

  it('AUTH_MAX_USED_NONCES defaults to 200,000 and is configurable', () => {
    const l = testConfig().limits as unknown as Record<string, unknown>;
    expect(l.maxUsedNonces).toBe(200_000);
    expect(
      (testConfig({ AUTH_MAX_USED_NONCES: '5000' }).limits as unknown as Record<string, unknown>).maxUsedNonces,
    ).toBe(5000);
  });
});
