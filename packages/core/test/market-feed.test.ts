// Plan L-MKT.1/.2: the live markets feed against a mock kernel over real HTTP: the snapshot
// equals the hand computation, an offer event refreshes it, a stopped kernel is "exchange
// unavailable" (and recovers), and a refused stream falls back to polling.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  NETWORK_DEFAULT_PAIRS,
  type FeedState,
  KernelClient,
  MarketFeed,
  type Market,
  formatPrice,
  resolvePairs,
  stagenetRegistry,
} from '../src/index.js';
import { COLOUR, EXPECTED, PAIR_IDS, leg, offerRow } from './fixtures/kernel/book.js';
import { startMockKernel, type MockKernelServer } from './mock-kernel-server.js';

const registry = stagenetRegistry();
const pairs = resolvePairs(registry, undefined, NETWORK_DEFAULT_PAIRS.stagenet).pairs;
let kernel: MockKernelServer;
let feed: MarketFeed | null = null;

const newFeed = (opts: { useStream?: boolean } = {}) => {
  const client = new KernelClient({ baseUrl: kernel.url, timeoutMs: 300, retries: 0, backoffMs: 20, random: () => 1 });
  feed = new MarketFeed({
    client,
    registry,
    pairs,
    useStream: opts.useStream ?? true,
    pollMs: 150,
    safetyRefreshMs: 400,
    debounceMs: 30,
    reconnectMs: 100,
    maxReconnectMs: 200,
  });
  return feed;
};

async function until<T>(get: () => T | undefined | false | null, ms = 5_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = get();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const ready = (f: MarketFeed) => {
  const s = f.getState();
  return s.status === 'ready' ? s : undefined;
};
const m = (s: Extract<FeedState, { status: 'ready' }>, id: string) => s.snapshot.markets.find((x) => x.pair.id === id)!;
const view = (x: Market) => ({
  bestBid: x.bids.best ? formatPrice(x.bids.best.price, { round: 'down' }).text : null,
  bestAsk: x.asks.best ? formatPrice(x.asks.best.price, { round: 'up' }).text : null,
  bids: x.bids.count,
  asks: x.asks.count,
  last: x.lastTrade.state === 'trade' ? formatPrice(x.lastTrade.price, { round: 'nearest' }).text : null,
});

beforeEach(async () => {
  kernel = await startMockKernel();
});
afterEach(async () => {
  feed?.stop();
  feed = null;
  await kernel.close();
});

describe('the markets feed', () => {
  it('reads the book once per refresh and equals the hand computation (SC-002)', async () => {
    const f = newFeed({ useStream: false });
    f.start();
    const s = await until(() => ready(f));
    const log = [...kernel.log];
    expect(f.refreshes).toBe(1);
    for (const id of PAIR_IDS) expect(view(m(s, id)), id).toEqual(EXPECTED[id]);
    expect(m(s, 'twETH/twUSDC').status).toBe('no-liquidity');
    expect(s).toMatchObject({ complete: true, skipped: 0, tradeDataOk: true });
    // The book is read once per DISTINCT quote token of the listed pairs (twUSDC and twBTC here);
    // prices never come from /v1/prices.
    const offersReqs = kernel.fixture.requests.filter((r) => r.path === '/v1/offers');
    expect(offersReqs.map((r) => r.query.get('token')).sort()).toEqual([COLOUR.twBTC, COLOUR.twUSDC].sort());
    expect(kernel.log.some((p) => p.startsWith('/v1/prices') || p.startsWith('/v1/quote'))).toBe(false);
    // One refresh = one book page per quote token, the pairs, and one stats request per pair.
    expect(log.sort()).toEqual([
      '/v1/chart/stats',
      '/v1/chart/stats',
      '/v1/chart/stats',
      '/v1/chart/stats',
      '/v1/offers',
      '/v1/offers',
      '/v1/pairs',
    ]);
    // Each stats request names the pair's own base and quote.
    const statsReqs = kernel.fixture.requests.filter((r) => r.path === '/v1/chart/stats');
    expect(statsReqs.map((r) => `${r.query.get('base')}|${r.query.get('quote')}`).sort()).toEqual(
      pairs.map((p) => `${p.base.midnightColour}|${p.quote.midnightColour}`).sort(),
    );
  });

  it('follows the offer stream: a new offer refreshes the market', async () => {
    const f = newFeed();
    f.start();
    await until(() => ready(f) && f.getState().stream === 'live');
    const before = f.refreshes;
    // A bid for twBTC appears: 1,000 twUSDC for 0.02 twBTC (50,000 each).
    kernel.fixture.book.unshift(offerRow(50, [leg(COLOUR.twUSDC, 1_000_000_000)], [leg(COLOUR.twBTC, 2_000_000)]));
    kernel.broadcast({ type: 'offer_indexed', offerId: 50, offerHash: 'ab'.repeat(32), blockHeight: '900050' });
    const s = await until(() => {
      const r = ready(f);
      return r && f.refreshes > before && m(r, 'twBTC/twUSDC').bids.count === 1 ? r : undefined;
    });
    expect(view(m(s, 'twBTC/twUSDC'))).toMatchObject({ bestBid: '50,000.00', bids: 1 });
    // A consumed offer leaves the book.
    kernel.fixture.book = kernel.fixture.book.filter((o) => o.offerId !== offerRow(50, [], []).offerId);
    kernel.broadcast({ type: 'offer_consumed', offerId: 50 });
    await until(() => {
      const r = ready(f);
      return r && m(r, 'twBTC/twUSDC').bids.count === 0;
    });
  });

  it('a stopped kernel is "exchange unavailable" without stale prices, and it recovers', async () => {
    const f = newFeed();
    f.start();
    await until(() => ready(f));
    await kernel.stop();
    const down = await until(() => {
      const s = f.getState();
      return s.status === 'unavailable' ? s : undefined;
    });
    expect(down.reason).toBe('the exchange did not answer');
    expect(down.lastUpdatedAt).not.toBeNull();
    expect('snapshot' in down).toBe(false);
    expect(f.getState().stream).not.toBe('live');
    await kernel.resume();
    await until(() => ready(f) && f.getState().stream === 'live');
  });

  it('polls when the stream is refused (503 SSE_CAPACITY)', async () => {
    kernel.fault('/v1/offers/stream', { status: 503, headers: { 'retry-after': '60' } }, 1000);
    const f = newFeed();
    f.start();
    await until(() => ready(f));
    await until(() => f.getState().stream === 'polling');
    const n = f.refreshes;
    await until(() => f.refreshes >= n + 2); // the 150 ms poll keeps it fresh
    // 2,000 twUSDC for 1 twETH: a bid at 2,000.
    kernel.fixture.book.unshift(offerRow(60, [leg(COLOUR.twUSDC, 2_000_000_000)], [leg(COLOUR.twETH, 10n ** 18n)]));
    const s = await until(() => {
      const r = ready(f);
      return r && m(r, 'twETH/twUSDC').bids.count === 1 ? r : undefined;
    });
    expect(view(m(s, 'twETH/twUSDC')).bestBid).toBe('2,000.00');
  });

  it('without the stream at all, polls', async () => {
    const f = newFeed({ useStream: false });
    f.start();
    await until(() => ready(f));
    expect(f.getState().stream).toBe('polling');
    expect(kernel.log).not.toContain('/v1/offers/stream');
  });

  it('a failed pair list or stats request only makes the last trade unknown', async () => {
    kernel.fault('/v1/pairs', { status: 500 }, 1);
    kernel.fault('/v1/chart/stats', { status: 500 }, 4);
    const f = newFeed({ useStream: false });
    f.start();
    const s = await until(() => ready(f));
    expect(s.tradeDataOk).toBe(false);
    expect(m(s, 'twUSDM/twUSDC').lastTrade).toEqual({ state: 'unknown' });
    expect(view(m(s, 'twUSDM/twUSDC')).bestAsk).toBe('1.05');
    // The next poll reads them again.
    const s2 = await until(() => {
      const r = ready(f);
      return r && r.tradeDataOk ? r : undefined;
    });
    expect(view(m(s2, 'twUSDM/twUSDC')).last).toBe('1.02');
  });

  it('stop() ends every request and timer', async () => {
    const f = newFeed();
    f.start();
    await until(() => ready(f) && f.getState().stream === 'live');
    f.stop();
    expect(f.getState().stream).toBe('off');
    const n = kernel.log.length;
    await new Promise((r) => setTimeout(r, 500));
    expect(kernel.log.length).toBe(n);
    await until(() => kernel.streams.size === 0);
  });
});
