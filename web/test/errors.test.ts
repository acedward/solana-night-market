// Plan P4-A, error states, the browser half: every way the market, the exchange, the wallet or the
// browser can stop an action has one clear, specific sentence. The walkthroughs in the browser are
// test/e2e/errors.spec.ts.

import { describe, expect, it } from 'vitest';

import type { HealthResponse } from '@nightmarket/core';

import { RelayClient, RelayError } from '../src/relay/client.js';
import { jobErrorText, relayErrorText, sentence } from '../src/relay/messages.js';
import { relayNotices, spendingPaused, type RelayState } from '../src/relay/status.js';
import { storageText } from '../src/store/messages.js';
import { LocalStore, StoreFullError } from '../src/store/store.js';

function health(over: Partial<HealthResponse> = {}): HealthResponse {
  return {
    status: 'ok',
    network: 'stagenet',
    version: 'v',
    uptimeSeconds: 1,
    sponsor: { configured: true, state: 'synced', synced: true, dustSpecks: '1', dustLow: false },
    proofServer: {
      reachable: true,
      version: '9.0.0-rc.6',
      jobCapacity: 10,
      keys: { present: true, fingerprint: null, pinned: false, matchesPin: null },
    },
    queue: { jobs: 0, lanes: {} },
    kernel: { reachable: true, synced: true },
    batcher: { reachable: true, lastRefusal: null },
    ...over,
  };
}
const ok = (h: HealthResponse): RelayState => ({ health: h, reachable: true, checkedAt: 1 });

describe('the relay’s refusals, in words', () => {
  it('says what happened and what to do, for each code', () => {
    const t = (code: string, extra: Partial<Parameters<typeof relayErrorText>[0]> = {}) =>
      relayErrorText({ status: 400, code, message: 'raw', ...extra });
    expect(t('unreachable')).toMatch(/could not be reached.*nothing was sent/);
    expect(t('rate-limited', { status: 429, retryAfterSeconds: 12 })).toBe(
      'The market is getting too many requests from this connection. Wait 12 s and try again; nothing was sent.',
    );
    expect(t('rate-limited', { status: 429 })).toMatch(/Wait a minute/);
    expect(t('sponsor-low', { status: 503 })).toMatch(/low on the network-fee funds \(DUST\).*paused new actions/);
    expect(t('sponsor-unavailable', { status: 503 })).toMatch(/still starting up/);
    expect(t('busy', { status: 503 })).toMatch(/at capacity/);
    // Q27: a known limit, not an outage; it does not say "try again shortly".
    const history = t('history-too-long', { status: 501 });
    expect(history).toMatch(/more history than this version of Night Market can read \(500 or more actions/);
    expect(history).toMatch(/Nothing is lost/);
    expect(history).not.toMatch(/try again shortly/i);
    expect(history).not.toBe(t('chain-unavailable', { status: 503 }));
    expect(t('unauthorised', { status: 401, detail: 'expired' })).toMatch(/older state of your account/);
    expect(t('unauthorised', { status: 401, detail: 'replayed' })).toMatch(/already used/);
    expect(t('unauthorised', { status: 401, detail: 'wrong-signer' })).toMatch(/not from a device of this account/);
    expect(t('unauthorised', { status: 401, detail: 'unknown-nonce' })).toMatch(/restarted since this was signed/);
    // Until a Solana wallet arm is wired (lanes B2/B3), the relay refuses every action as not supported.
    expect(t('unauthorised', { status: 401, detail: 'not-supported' })).toMatch(/not accepting wallet signatures/);
    expect(t('unauthorised', { status: 401, detail: 'bad-signature' })).toMatch(/could not verify your wallet/);
    // The demo-token claim's refusals (AA 00047).
    expect(t('demo-already-claimed', { status: 409 })).toMatch(/one pack per wallet/);
    expect(t('demo-daily-cap', { status: 429 })).toMatch(/all given out/);
    expect(t('demo-disabled', { status: 503 })).toMatch(/not handing out demo tokens/);
    expect(relayErrorText({ status: 502, code: 'error', message: '' })).toBe(
      'The market answered with an error (HTTP 502). Try again later.',
    );
    expect(t('not-found', { message: 'no such job' })).toBe('No such job.');
    expect(sentence('the exchange refused it')).toBe('The exchange refused it.');
  });

  it('the relay client carries the sentence, the code and Retry-After', async () => {
    const client = new RelayClient(
      'http://relay.test',
      (async () =>
        new Response(
          JSON.stringify({ error: { code: 'rate-limited', message: 'too many requests; try again shortly' } }),
          {
            status: 429,
            headers: { 'retry-after': '7' },
          },
        )) as unknown as typeof fetch,
    );
    const e = await client.nonce().catch((x: unknown) => x);
    expect(e).toBeInstanceOf(RelayError);
    expect((e as RelayError).code).toBe('rate-limited');
    expect((e as RelayError).retryAfterSeconds).toBe(7);
    expect((e as RelayError).message).toMatch(/Wait 7 s/);
    expect((e as RelayError).relayMessage).toBe('too many requests; try again shortly');
    const down = new RelayClient('http://relay.test', (async () => {
      throw new TypeError('failed to fetch');
    }) as unknown as typeof fetch);
    await expect(down.health()).rejects.toMatchObject({ code: 'unreachable' });
  });

  it('reads /health, whether the relay says ok or down', async () => {
    const h = health({ status: 'down' });
    const client = new RelayClient(
      'http://relay.test',
      (async () => new Response(JSON.stringify(h), { status: 503 })) as unknown as typeof fetch,
    );
    expect((await client.health()).status).toBe('down');
  });

  it('words failed jobs of the exchange and the internal error', () => {
    expect(
      jobErrorText(
        {
          code: 'exchange-busy',
          message: "the exchange's settlement service is not taking more settlements right now",
        },
        'x',
      ),
    ).toBe("The exchange's settlement service is not taking more settlements right now.");
    expect(jobErrorText({ code: 'internal-error', message: 'the relay could not complete this request' }, 'x')).toMatch(
      /could not complete this.*ask the market/,
    );
    expect(jobErrorText(undefined, 'Fallback.')).toBe('Fallback.');
  });
});

describe('what /health pauses, and says', () => {
  it('nothing when all is well', () => {
    expect(relayNotices(ok(health()))).toEqual([]);
    expect(spendingPaused(ok(health()))).toBeNull();
    expect(relayNotices({ health: null, reachable: null, checkedAt: null })).toEqual([]);
  });

  it('the market unreachable, its prover down, its fee wallet low or syncing: every paid action pauses', () => {
    const down = relayNotices({ health: null, reachable: false, checkedAt: 1 });
    expect(down.map((n) => [n.id, n.place])).toEqual([['relay-down', 'shell']]);
    expect(spendingPaused({ health: null, reachable: false, checkedAt: 1 })).toMatch(/cannot be reached/);

    const prover = health({ proofServer: { ...health().proofServer, reachable: false } });
    expect(relayNotices(ok(prover)).map((n) => n.id)).toEqual(['prover-down']);
    expect(spendingPaused(ok(prover))).toMatch(/prover is not available/);
    // The DUST prover (the fee payment) down pauses them the same way (AA 00047: two provers).
    const dust = health({ dustProofServer: { reachable: false, version: null, jobCapacity: null } });
    expect(relayNotices(ok(dust)).map((n) => n.id)).toEqual(['prover-down']);
    expect(
      relayNotices(ok(health({ dustProofServer: { reachable: true, version: '9.0.0-rc.6', jobCapacity: 1 } }))),
    ).toEqual([]);

    const low = health({ sponsor: { ...health().sponsor, dustLow: true } });
    expect(relayNotices(ok(low))[0]).toMatchObject({ id: 'sponsor-low', place: 'shell', tone: 'danger' });
    expect(spendingPaused(ok(low))).toMatch(/low on network-fee funds.*DUST/);

    const syncing = health({ sponsor: { ...health().sponsor, synced: false, state: 'syncing' } });
    expect(relayNotices(ok(syncing)).map((n) => n.id)).toEqual(['sponsor-syncing']);
    expect(spendingPaused(ok(syncing))).toMatch(/starting up/);
  });

  it('the exchange’s settlement service down, at its limit (429) or failing (500)', () => {
    expect(relayNotices(ok(health({ batcher: { reachable: false } })))[0]).toMatchObject({
      id: 'batcher-down',
      place: 'trade',
    });
    const now = 10_000;
    const busy = ok(health({ batcher: { reachable: true, lastRefusal: { httpStatus: 429, at: now - 60 } } }));
    expect(relayNotices(busy, now)[0]).toMatchObject({ id: 'batcher-refusing' });
    expect(relayNotices(busy, now)[0]!.text).toMatch(/HTTP 429/);
    const failing = ok(health({ batcher: { reachable: true, lastRefusal: { httpStatus: 500, at: now - 60 } } }));
    expect(relayNotices(failing, now)[0]!.title).toMatch(/failing/);
    expect(relayNotices(failing, now)[0]!.text).toMatch(/HTTP 500/);
    // An old refusal is not news.
    expect(relayNotices(failing, now + 7_200)).toEqual([]);
  });
});

describe('local storage blocked or full', () => {
  it('has one wording per cause', () => {
    expect(storageText('blocked').text).toMatch(/private window/);
    expect(storageText('full').title).toMatch(/no room left/);
    expect(storageText('unavailable').title).toMatch(/no local storage/);
  });

  it('a write that finds the storage full says so, and what to do', () => {
    const map = new Map<string, string>();
    const full = {
      get length() {
        return map.size;
      },
      key: (i: number) => [...map.keys()][i] ?? null,
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => {
        if (k !== 'night-market/schema') {
          const e = new Error('quota');
          e.name = 'QuotaExceededError';
          throw e;
        }
        map.set(k, v);
      },
      removeItem: (k: string) => void map.delete(k),
      clear: () => map.clear(),
    } as Storage;
    const store = new LocalStore(full);
    const scope = { network: 'stagenet', owner: '48'.repeat(32) };
    expect(() => store.put(scope, 'profile', { firstSeen: 1 })).toThrow(StoreFullError);
    expect(() => store.put(scope, 'profile', { firstSeen: 1 })).toThrow(/no room left.*Export your data/);
  });
});
