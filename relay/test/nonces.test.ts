// AA 00047 P9, audit C9 (F-A7.3): the relay's nonce store never evicts an unexpired nonce. A client
// spread over many addresses used to push other customers' nonces out once AUTH_MAX_NONCES were
// outstanding, so their registration or demo-token claim failed as `unknown-nonce`. Now each client
// address holds at most AUTH_MAX_NONCES_PER_CLIENT, and a full store refuses new nonces instead.

import { describe, expect, it } from 'vitest';

import { API_PATHS } from '@nightmarket/core';

import { testScheme } from '../../packages/core/test/fixtures/test-signing.js';
import { NonceStore } from '../src/auth/nonces.js';
import { createApp } from '../src/app.js';
import { defaultCatalogue } from '../src/actions/catalogue.js';
import { notImplementedChainReader } from '../src/chain/reader.js';
import { JobQueue } from '../src/queue/jobs.js';
import { FakeSponsor, newWallet, post, signedBody, silentLog, testConfig } from './harness.js';

describe('NonceStore (unit)', () => {
  it('caps outstanding nonces per client, refusing (not evicting) past the cap', () => {
    let now = 1000;
    const s = new NonceStore(60, 100, () => now, 2);
    const a1 = s.issue('a');
    const a2 = s.issue('a');
    expect(a1.ok && a2.ok).toBe(true);
    expect(s.issue('a')).toMatchObject({ ok: false, refused: 'client-cap', retryAfterSeconds: 60 });
    expect(s.issue('b').ok).toBe(true);
    // Both of a's nonces are still good.
    if (a1.ok) expect(s.consume(a1.nonce)).toBe('ok');
    // Using one frees a slot for that client.
    expect(s.issue('a').ok).toBe(true);
    expect(s.outstanding('a')).toBe(2);
    // Expiry frees the rest.
    now += 61;
    expect(s.issue('a').ok).toBe(true);
    expect(s.outstanding('a')).toBe(1);
  });

  it('a full store refuses every client, and never evicts an unexpired nonce', () => {
    let now = 1000;
    const s = new NonceStore(60, 3, () => now, 2);
    const victim = s.issue('victim');
    s.issue('attacker-1');
    s.issue('attacker-2');
    expect(s.issue('attacker-3')).toMatchObject({ ok: false, refused: 'full' });
    expect(s.size.issued).toBe(3);
    if (victim.ok) expect(s.consume(victim.nonce)).toBe('ok');
    now += 61;
    expect(s.issue('attacker-3').ok).toBe(true);
  });
});

describe('GET /v1/auth/nonce under a flood from many addresses (audit C9)', () => {
  function relay(env: Record<string, string>) {
    const config = testConfig({ RATE_LIMIT_NONCES_PER_MIN: '1000', ...env });
    let client = 'victim';
    const log = silentLog();
    const nonces = new NonceStore(
      config.limits.nonceTtlSeconds,
      config.limits.maxNonces,
      undefined,
      config.limits.maxNoncesPerClient,
    );
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
    return {
      app,
      config,
      log,
      nonces,
      queue,
      catalogue,
      as: (c: string) => (client = c),
    };
  }

  it('the victim’s nonce survives; the flood is refused, and the victim’s signed call is accepted', async () => {
    const r = relay({ AUTH_MAX_NONCES: '100', AUTH_MAX_NONCES_PER_CLIENT: '30' });
    r.as('victim');
    const h = { ...r, app: r.app } as unknown as Parameters<typeof signedBody>[0];
    const victim = newWallet();
    const body = await signedBody(h, 'register', victim); // takes the victim's nonce now
    // Address after address asks for 30 nonces, until the store is full and refuses.
    const statuses = new Map<number, number>();
    for (let ip = 0; ip < 1000 && (statuses.get(503) ?? 0) < 50; ip++) {
      r.as(`10.0.${ip >> 8}.${ip & 255}`);
      for (let i = 0; i < 30; i++) {
        const res = await r.app.request(API_PATHS.nonce);
        statuses.set(res.status, (statuses.get(res.status) ?? 0) + 1);
      }
    }
    expect(statuses.get(503)).toBeGreaterThan(0);
    expect(r.nonces.size.issued).toBe(100);
    r.as('victim');
    const res = await post(h, 'register', body);
    // The nonce was still known: the call passed authorisation (the stub executor is queued).
    expect(res.status).toBe(202);
  });

  it('one address past its own cap gets 429 with Retry-After; another address is served', async () => {
    const r = relay({ AUTH_MAX_NONCES_PER_CLIENT: '3' });
    r.as('203.0.113.5');
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) codes.push((await r.app.request(API_PATHS.nonce)).status);
    expect(codes).toEqual([200, 200, 200, 429]);
    const refused = await r.app.request(API_PATHS.nonce);
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe('rate-limited');
    r.as('203.0.113.6');
    expect((await r.app.request(API_PATHS.nonce)).status).toBe(200);
  });

  it('AUTH_MAX_NONCES_PER_CLIENT defaults to 30', () => {
    expect(testConfig().limits.maxNoncesPerClient).toBe(30);
  });
});
