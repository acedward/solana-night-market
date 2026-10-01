// AA 00047 P10, audit round 2 R2-1 / R2-8 (F-A2-1, F-A2-6): every per-client cap keys an IPv6 client
// by its /64. Round 2's probes: one /64 was 34 "clients" to the registration cap (100 accounts in 102
// minutes, then every newcomer refused for a day) and 1,667 to the nonce store.

import { describe, expect, it } from 'vitest';

import { API_PATHS, buildRelayActionMessage } from '@nightmarket/core';

import { testDevice, testScheme } from '../../packages/core/test/fixtures/test-signing.js';
import { defaultCatalogue, withRegistrationCaps } from '../src/actions/catalogue.js';
import { RegistrationCaps } from '../src/actions/registration-caps.js';
import { createApp } from '../src/app.js';
import { NonceStore } from '../src/auth/nonces.js';
import { notImplementedChainReader } from '../src/chain/reader.js';
import { DEFAULT_CLIENT_PREFIXES, clientKey } from '../src/client-key.js';
import { loadConfig } from '../src/config.js';
import { JobQueue } from '../src/queue/jobs.js';
import { FakeSponsor, LOCAL_TOKENS, silentLog } from './harness.js';

describe('clientKey (unit)', () => {
  it('keys an IPv6 client by its /64, whatever the spelling', () => {
    const k = clientKey('2001:db8:0:1::1');
    expect(k).toBe('v6:20010db8000000010000000000000000/64');
    for (const same of [
      '2001:db8:0:1::ffff',
      '2001:0db8:0000:0001:aaaa:bbbb:cccc:dddd',
      '[2001:db8:0:1::7]',
      '2001:DB8:0:1::2',
    ])
      expect(clientKey(same)).toBe(k);
    expect(clientKey('2001:db8:0:2::1')).not.toBe(k);
    expect(clientKey('fe80::1%eth0')).toBe(clientKey('fe80::2'));
  });

  it('keys an IPv4 client by its whole address (and an IPv4-mapped IPv6 address as IPv4)', () => {
    expect(clientKey('198.51.100.7')).toBe('v4:198.51.100.7/32');
    expect(clientKey('::ffff:198.51.100.7')).toBe('v4:198.51.100.7/32');
    expect(clientKey('198.51.100.8')).not.toBe(clientKey('198.51.100.7'));
  });

  it('takes the prefixes from the configuration', () => {
    expect(clientKey('198.51.100.7', { ipv6: 64, ipv4: 24 })).toBe('v4:198.51.100.0/24');
    expect(clientKey('198.51.100.200', { ipv6: 64, ipv4: 24 })).toBe(clientKey('198.51.100.7', { ipv6: 64, ipv4: 24 }));
    expect(clientKey('2001:db8:aaaa:bbbb::1', { ipv6: 48, ipv4: 32 })).toBe(
      clientKey('2001:db8:aaaa:cccc::1', { ipv6: 48, ipv4: 32 }),
    );
    expect(clientKey('2001:db8:0:1::1', { ipv6: 128, ipv4: 32 })).not.toBe(
      clientKey('2001:db8:0:1::2', { ipv6: 128, ipv4: 32 }),
    );
    expect(DEFAULT_CLIENT_PREFIXES).toEqual({ ipv6: 64, ipv4: 32 });
  });

  it('leaves anything that is not an address as it is', () => {
    for (const s of ['unknown', 'abc', '1.2.3', '1.2.3.256', '2001:db8::1::2', 'gggg::1']) expect(clientKey(s)).toBe(s);
  });

  it('CLIENT_IPV6_PREFIX and CLIENT_IPV4_PREFIX are configurable, with the RUNBOOK defaults', () => {
    const cfg = (env: Record<string, string> = {}) =>
      loadConfig({ RELAY_NETWORK: 'undeployed', TOKENS_FILE: '/t', ...env }, () => JSON.stringify(LOCAL_TOKENS)).config;
    expect(cfg().clientPrefixes).toEqual({ ipv6: 64, ipv4: 32 });
    expect(cfg({ CLIENT_IPV6_PREFIX: '56', CLIENT_IPV4_PREFIX: '24' }).clientPrefixes).toEqual({ ipv6: 56, ipv4: 24 });
    expect(() => cfg({ CLIENT_IPV6_PREFIX: '200' })).toThrow(/CLIENT_IPV6_PREFIX/);
  });
});

describe('the per-client caps key an IPv6 client by its /64 (routes)', () => {
  function relay(env: Record<string, string> = {}) {
    const config = loadConfig(
      { RELAY_NETWORK: 'undeployed', TOKENS_FILE: '/t', RATE_LIMIT_NONCES_PER_MIN: '1000', ...env },
      () => JSON.stringify(LOCAL_TOKENS),
    ).config;
    const log = silentLog();
    const queue = new JobQueue({ ttlSeconds: 600, maxJobs: 1000, log });
    const caps = new RegistrationCaps(config.registration);
    const catalogue = defaultCatalogue();
    catalogue.set('register', { ...catalogue.get('register')!, executor: async () => ({}) });
    withRegistrationCaps(catalogue, caps);
    let client = '198.51.100.1';
    const app = createApp({
      config,
      version: 'test',
      log,
      nonces: new NonceStore(600, 10_000),
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
    const register = async (from: string) => {
      client = from;
      const device = testDevice();
      const { nonce } = (await (await app.request(API_PATHS.nonce)).json()) as { nonce: string };
      const payload = { encPublicKey: 'ab'.repeat(32) };
      const message = buildRelayActionMessage({
        action: 'register',
        network: config.network.name,
        owner: device.deviceKey,
        payload,
        nonce,
        expiry: Math.floor(Date.now() / 1000) + 120,
      });
      const res = await app.request(API_PATHS.action('register'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ payload, auth: { message, signature: device.signEnvelope(message) } }),
      });
      const body = (await res.json()) as { job?: { requestId: string }; error?: { code: string } };
      if (body.job) await queue.settled(body.job.requestId);
      await new Promise((r) => setTimeout(r, 0));
      return { status: res.status, code: body.error?.code };
    };
    return { app, caps, register, as: (c: string) => (client = c) };
  }

  it('one /64 opens at most REGISTER_PER_CLIENT_DAILY_CAP accounts a day, however many addresses it uses', async () => {
    const r = relay({ RATE_LIMIT_ACTIONS_PER_MIN: '1000' });
    const results = [];
    for (let i = 1; i <= 6; i++) results.push(await r.register(`2001:db8:0:1::${i.toString(16)}`));
    expect(results.map((x) => x.status)).toEqual([202, 202, 202, 429, 429, 429]);
    expect(results[3]!.code).toBe('registration-client-cap');
    // Another /64, and an IPv4 client, are not affected.
    expect((await r.register('2001:db8:0:2::1')).status).toBe(202);
    expect((await r.register('203.0.113.9')).status).toBe(202);
  });

  it('the per-client action rate limit counts one /64 as one client', async () => {
    const r = relay({ RATE_LIMIT_ACTIONS_PER_MIN: '2', REGISTER_PER_CLIENT_DAILY_CAP: '100' });
    const statuses = [];
    for (let i = 1; i <= 4; i++) {
      r.as(`2001:db8:0:1::${i.toString(16)}`);
      statuses.push(
        (
          await r.app.request(API_PATHS.action('register'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          })
        ).status,
      );
    }
    expect(statuses).toEqual([400, 400, 429, 429]);
  });
});
