// AA 00047 P11, audit round 3 R3-5 (F-B3-4): the relay reads an account's WHOLE history, past the
// indexer's 500-action page (`Contract.actions` answers the newest 500 only), through the
// `contractActions(address, offset: {height})` subscription (graphql-transport-ws), with a bounded
// per-account cache. Before, `/v1/accounts/:account/zswap` answered 501 `history-too-long` at 500
// actions, so such an account's coins could not be found and its spends not checked.

import { describe, expect, it } from 'vitest';

import { HISTORY_SUBSCRIPTION, IndexerClient, IndexerError, type DecodedEvent } from '../src/chain/indexer.js';
import { IndexerChainReader, type ChainReader } from '../src/chain/reader.js';
import {
  GRAPHQL_TRANSPORT_WS,
  SubscriptionError,
  subscribeUntil,
  type MinimalWebSocket,
} from '../src/chain/ws-subscription.js';
import { isInfrastructureFailure } from '../src/actions/failure-budget.js';
import { harness } from './harness.js';

const ME = 'aa'.repeat(32);
const OTHER = 'bb'.repeat(32);

interface Action {
  hash: string;
  height: number;
  events: Array<{ id: number; raw: string }>;
}

/**
 * An indexer with `actions` for ME (oldest first): the HTTP `contract.actions(limit)` answers the
 * newest `limit` (newest first, as the indexer does), and the WebSocket streams every action from a
 * block height on, in order, then stays open (live), as the indexer's subscription does.
 */
function fakeIndexer(initial: Action[], o: { onSubscribe?: (msg: unknown) => 'error' | 'complete' | void } = {}) {
  const actions = [...initial];
  const subscribes: Array<{ address: string; offset: { height: number } }> = [];
  const sent: string[] = [];
  let sockets = 0;
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { variables: { address: string; limit?: number } };
    const tip = actions.length ? actions[actions.length - 1]!.height + 1 : 1;
    if (body.variables.address !== ME) {
      return new Response(JSON.stringify({ data: { contract: null, block: { height: tip } } }));
    }
    const limit = Math.min(body.variables.limit ?? 100, 500);
    const newest = actions.slice(-limit).reverse();
    return new Response(
      JSON.stringify({
        data: {
          contract: {
            actions: newest.map((a) => ({
              transaction: { hash: a.hash, block: { height: a.height }, zswapLedgerEvents: a.events },
            })),
          },
          block: { height: tip },
        },
      }),
    );
  }) as unknown as typeof fetch;
  const webSocket = (url: string, protocols: string[]): MinimalWebSocket => {
    sockets++;
    const listeners: Record<string, Array<(e: unknown) => void>> = {};
    const emit = (type: string, e: unknown) => setTimeout(() => (listeners[type] ?? []).forEach((l) => l(e)), 0);
    const reply = (m: unknown) => emit('message', { data: JSON.stringify(m) });
    const sock: MinimalWebSocket & { readyState: number } = {
      readyState: 0,
      addEventListener: (type, l) => (listeners[type] ??= []).push(l),
      close: () => {
        sock.readyState = 3;
      },
      send: (data: string) => {
        sent.push(data);
        const msg = JSON.parse(data) as { type: string; id?: string; payload?: { query: string; variables: never } };
        if (msg.type === 'connection_init') {
          reply({ type: 'ping' });
          reply({ type: 'connection_ack' });
        } else if (msg.type === 'subscribe') {
          const vars = msg.payload!.variables as { address: string; offset: { height: number } };
          subscribes.push(vars);
          const verdict = o.onSubscribe?.(msg);
          if (verdict === 'error')
            return reply({ id: msg.id, type: 'error', payload: [{ message: 'subscription limit exceeded' }] });
          if (verdict === 'complete') return reply({ id: msg.id, type: 'complete' });
          for (const a of actions.filter((x) => x.height >= vars.offset.height)) {
            reply({
              id: msg.id,
              type: 'next',
              payload: {
                data: {
                  contractActions: {
                    transaction: { hash: a.hash, block: { height: a.height }, zswapLedgerEvents: a.events },
                  },
                },
              },
            });
          }
        }
      },
    };
    expect(url).toBe('ws://indexer.test/api/v4/graphql/ws');
    expect(protocols).toEqual([GRAPHQL_TRANSPORT_WS]);
    emit('open', {});
    return sock;
  };
  return {
    actions,
    subscribes,
    sent,
    sockets: () => sockets,
    client: (over: Partial<ConstructorParameters<typeof IndexerClient>[0]> = {}) =>
      new IndexerClient({
        indexerUrl: 'http://indexer.test/api/v4/graphql',
        indexerWsUrl: 'ws://indexer.test/api/v4/graphql/ws',
        fetchImpl,
        webSocket,
        ...over,
      }),
  };
}

/** `n` transactions, two per block, each with one leaf (event id 2k) and, every tenth, a spend. */
function history(n: number, from = 0): Action[] {
  return Array.from({ length: n }, (_, i) => {
    const k = from + i;
    return {
      hash: k.toString(16).padStart(64, '0'),
      height: 10 + Math.floor(k / 2),
      events: [{ id: 2 * k, raw: `out:${k}` }, ...(k % 10 === 3 ? [{ id: 2 * k + 1, raw: `in:${k}` }] : [])],
    };
  });
}

const decode = (raw: string): DecodedEvent => {
  const [kind, k] = raw.split(':');
  return kind === 'out'
    ? { tag: 'zswapOutput', commitment: Number(k).toString(16).padStart(64, 'c'), contract: ME, mtIndex: BigInt(k!) }
    : { tag: 'zswapInput', nullifier: Number(k).toString(16).padStart(64, 'f'), contract: ME };
};

describe('the relay reads an account’s whole history past 500 actions (R3-5)', () => {
  it('1,234 actions: the newest page is full, so the rest is read through the subscription from height 0', async () => {
    const f = fakeIndexer(history(1234));
    const r = await f.client().accountTransactions(ME);
    expect(r?.txs).toHaveLength(1234);
    expect(r?.txs[0]!.hash).toBe(f.actions[0]!.hash); // oldest first
    expect(r?.txs.at(-1)!.hash).toBe(f.actions.at(-1)!.hash);
    expect(f.subscribes).toEqual([{ address: ME, offset: { height: 0 } }]);
    // The protocol: init, (pong to the ping), subscribe with the history query, then complete.
    const types = f.sent.map((s) => (JSON.parse(s) as { type: string }).type);
    expect(types).toEqual(['connection_init', 'pong', 'subscribe', 'complete']);
    expect((JSON.parse(f.sent[2]!) as { payload: { query: string } }).payload.query).toBe(HISTORY_SUBSCRIPTION);
  });

  it('the Zswap activity it serves holds every leaf and spend, also those older than the newest 500', async () => {
    const f = fakeIndexer(history(1234));
    const reader: ChainReader = new IndexerChainReader(async () => null, f.client(), decode);
    const z = await reader.zswap(ME);
    expect(z?.outputs).toHaveLength(1234);
    expect(z?.inputs).toHaveLength(124);
    expect(z?.outputs[0]).toMatchObject({ mtIndex: '0', blockHeight: 10 });
    expect(z?.inputs[0]).toMatchObject({ nullifier: (3).toString(16).padStart(64, 'f') });
    expect(z?.transactions).toBe(1234);
    // The spent coins (R3-7 reads them) include a spend from the first 500.
    const spent = await (reader as IndexerChainReader).spentNullifiers(ME);
    expect(spent?.has((3).toString(16).padStart(64, 'f'))).toBe(true);
  });

  it('a history under one page is read over HTTP alone (no subscription)', async () => {
    const f = fakeIndexer(history(499));
    expect((await f.client().accountTransactions(ME))?.txs).toHaveLength(499);
    expect(f.sockets()).toBe(0);
  });

  it('a second read uses the cache: no subscription while the newest page overlaps it, then only the new blocks', async () => {
    const f = fakeIndexer(history(800));
    const c = f.client();
    expect((await c.accountTransactions(ME))?.txs).toHaveLength(800);
    expect(await c.accountTransactions(ME)).toMatchObject({ txs: { length: 800 } });
    expect(c.subscriptions).toBe(1);
    // 300 new actions: the newest 500 still overlap the cached history.
    f.actions.push(...history(300, 800));
    expect((await c.accountTransactions(ME))?.txs).toHaveLength(1100);
    expect(c.subscriptions).toBe(1);
    // 700 more: the newest page no longer reaches back; subscribe from the block after the cache.
    f.actions.push(...history(700, 1100));
    const r = await c.accountTransactions(ME);
    expect(r?.txs).toHaveLength(1800);
    expect(new Set(r!.txs.map((t) => t.hash)).size).toBe(1800);
    expect(c.subscriptions).toBe(2);
    expect(f.subscribes[1]).toEqual({ address: ME, offset: { height: 10 + Math.floor(1099 / 2) + 1 } });
  });

  it('a transaction with several actions of the account is kept once', async () => {
    const base = history(600);
    const f = fakeIndexer([...base.slice(0, 50), base[49]!, base[49]!, ...base.slice(50)]);
    expect((await f.client().accountTransactions(ME))?.txs).toHaveLength(600);
  });

  it('a refused or cut-off subscription is the indexer’s failure (infrastructure, never charged): 503 on the route', async () => {
    for (const verdict of ['error', 'complete'] as const) {
      const f = fakeIndexer(history(600), { onSubscribe: () => verdict });
      const e = await f
        .client()
        .accountTransactions(ME)
        .catch((x: unknown) => x);
      expect(e).toBeInstanceOf(SubscriptionError);
      expect(isInfrastructureFailure(e)).toBe(true);
    }
    const f = fakeIndexer(history(600), { onSubscribe: () => 'error' });
    const h = harness({ chain: new IndexerChainReader(async () => null, f.client(), decode) });
    const res = await h.app.request(`/v1/accounts/${ME}/zswap`);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('chain-unavailable');
  });

  it('a subscription that never reaches the newest page times out', async () => {
    const f = fakeIndexer(history(600));
    // The stream stops short of the newest action (the indexer lost it): never done.
    f.actions.splice(550, 1);
    const c = f.client({ historyTimeoutMs: 50 });
    // The page still names the lost action's hash: make the HTTP answer include it.
    const page = history(600);
    const httpOnly = new IndexerClient({
      indexerUrl: 'http://indexer.test/api/v4/graphql',
      indexerWsUrl: 'ws://indexer.test/api/v4/graphql/ws',
      historyTimeoutMs: 50,
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            data: {
              contract: {
                actions: page
                  .slice(-500)
                  .reverse()
                  .map((a) => ({ transaction: { hash: a.hash, block: { height: a.height }, zswapLedgerEvents: [] } })),
              },
              block: { height: 999 },
            },
          }),
        )) as unknown as typeof fetch,
      webSocket: (c as unknown as { options: { webSocket: never } }).options.webSocket,
    });
    await expect(httpOnly.accountTransactions(ME)).rejects.toThrow(/did not finish within 50 ms/);
  });

  it('a history past maxHistoryActions answers history-too-long (501 on the route)', async () => {
    const f = fakeIndexer(history(900));
    const e = await f
      .client({ maxHistoryActions: 600 })
      .accountTransactions(ME)
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(IndexerError);
    expect((e as { name: string }).name).toBe('AccountHistoryTooLongError');
    const h = harness({
      chain: new IndexerChainReader(async () => null, f.client({ maxHistoryActions: 600 }), decode),
    });
    const res = await h.app.request(`/v1/accounts/${ME}/zswap`);
    expect(res.status).toBe(501);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('history-too-long');
  });

  it('end to end on the route: a 1,000-action account’s Zswap activity is served (200), not 501', async () => {
    const f = fakeIndexer(history(1000));
    const h = harness({ chain: new IndexerChainReader(async () => null, f.client(), decode) });
    const res = await h.app.request(`/v1/accounts/${ME}/zswap`);
    expect(res.status).toBe(200);
    const z = (await res.json()) as { outputs: unknown[]; inputs: unknown[]; transactions: number };
    expect(z.outputs).toHaveLength(1000);
    expect(z.transactions).toBe(1000);
    expect((await h.app.request(`/v1/accounts/${OTHER}/zswap`)).status).toBe(404);
  });
});

describe('subscribeUntil (graphql-transport-ws)', () => {
  it('refuses a runtime without a WebSocket, and a socket that fails to open, as infrastructure errors', async () => {
    const e = await subscribeUntil({
      url: 'ws://x',
      query: 'subscription { x }',
      variables: {},
      onNext: () => true,
      timeoutMs: 1000,
      webSocket: () => {
        throw new Error('ECONNREFUSED');
      },
    }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(SubscriptionError);
    expect(isInfrastructureFailure(e)).toBe(true);
  });
});
