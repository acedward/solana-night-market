// AA 00047 P9.S (questions Q26 A): the browser's own reader of the public indexer
// (../src/chain/indexer.ts), against a stub indexer that serves a REAL serialised account state
// (packages/core/test/fixtures/account-state.ts): the GraphQL it sends, the decoding, the check with
// this build's pinned keys and this network's salt, the errors, and reads shared while in flight.

import nacl from 'tweetnacl';
import { x25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@nightmarket/core';
import { networkSaltFor } from '@nightmarket/core/passport';
import { describe, expect, it } from 'vitest';

import { originIndexer } from '../../packages/core/test/fixtures/account-origin.js';
import { accountStateHex } from '../../packages/core/test/fixtures/account-state.js';
import { zswapInputEventHex, zswapOutputEventHex } from '../../packages/core/test/fixtures/ledger-events.js';
import { ChainReadError, ChainReader, indexerWsUrlFor, indexerWsUrlOf } from '../src/chain/indexer.js';
import accountA from '../../test/fixtures/stagenet-p11b/account-a-history.json';
import take4464 from '../../test/fixtures/stagenet-p11b/tx-4464f3f4.json';

const ACCOUNT = '7e'.repeat(32);
const DEVICE = bytesToHex(nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(4)).publicKey);
const ENC = bytesToHex(x25519.getPublicKey(new Uint8Array(32).fill(6)));
const URL_ = 'https://indexer.example/api/v4/graphql';

function stubIndexer(answer: (body: { query: string; variables: Record<string, unknown> }) => unknown, status = 200) {
  const calls: Array<{ url: string; body: { query: string; variables: Record<string, unknown> } }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
    calls.push({ url, body });
    await new Promise((r) => setTimeout(r, 5));
    return new Response(JSON.stringify(answer(body)), { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe('ChainReader (the page reads the public indexer itself)', () => {
  it('reads and decodes the account, checks it with the pinned keys and the network salt', async () => {
    const state = await accountStateHex({
      account: ACCOUNT,
      deviceKey: DEVICE,
      encKey: ENC,
      salt: networkSaltFor('stagenet'),
      authNonce: 2n,
      useCounter: 2n,
    });
    // Its origin (AA 00047 P11, R3-1): an honest deploy and retirement, as the market's relay does.
    const origin = await originIndexer({
      account: ACCOUNT,
      deviceKey: DEVICE,
      encKey: ENC,
      salt: networkSaltFor('stagenet'),
    });
    const { calls, fetchImpl } = stubIndexer((b) => {
      const o = origin.answer(b.query, b.variables);
      return o !== undefined ? { data: o } : { data: { contract: { state }, block: { height: 77 } } };
    });
    const chain = new ChainReader({ indexerUrl: URL_, networkId: 'stagenet', fetchImpl });
    const { state: s, check } = await chain.checkAccount(`0x${ACCOUNT.toUpperCase()}`, {
      deviceKey: DEVICE,
      encPublicKey: ENC,
    });
    expect(check).toEqual({ ok: true, problems: [], useCounter: 2n });
    expect(s?.blockHeight).toBe(77);
    expect(calls).toHaveLength(3); // the state, then the origin: its deploy and update, its window
    expect(calls[0]!.url).toBe(URL_);
    expect(calls[0]!.body.query).toMatch(/contract\(address: \$address\) \{ state \}/);
    expect(calls[0]!.body.variables).toEqual({ address: ACCOUNT });
    // Another network's page refuses the same account: its salt, and an origin it did not create.
    const other = new ChainReader({ indexerUrl: URL_, networkId: 'undeployed', fetchImpl });
    const r = await other.checkAccount(ACCOUNT, { deviceKey: DEVICE, encPublicKey: ENC });
    expect(r.check.problems.map((p) => p.code)).toEqual(['network-salt', 'provenance']);
  });

  // AA 00047 P10 (R2-6, questions Q42): a just-opened account must start empty AS DEPLOYED: the page
  // judges the state its deploy TRANSACTION created (AA 00047 P11: part of its origin, read once per
  // page, on every check), so a deposit by anyone since does not get it refused.
  it('checks an account’s emptiness on its deploy-time state, read once per page', async () => {
    const base = { account: ACCOUNT, deviceKey: DEVICE, encKey: ENC, salt: networkSaltFor('stagenet') };
    const now = await accountStateHex({ ...base, inbox: ['ab'.repeat(192)] }); // someone deposited since
    let origin = await originIndexer(base);
    const { calls, fetchImpl } = stubIndexer((b) => {
      const o = origin.answer(b.query, b.variables);
      return o !== undefined ? { data: o } : { data: { contract: { state: now }, block: { height: 77 } } };
    });
    const chain = new ChainReader({ indexerUrl: URL_, networkId: 'stagenet', fetchImpl });
    const ok = await chain.checkAccount(ACCOUNT, { deviceKey: DEVICE, encPublicKey: ENC, fresh: true });
    expect(ok.check).toEqual({ ok: true, problems: [], useCounter: 0n });
    const originReads = () => calls.filter((c) => c.body.query.includes('AccountOrigin(')).length;
    expect(originReads()).toBe(1);
    // Not fresh, again: the origin is known, not read again.
    await chain.checkAccount(ACCOUNT, { deviceKey: DEVICE, encPublicKey: ENC });
    expect(originReads()).toBe(1);
    // Seeded at the deploy (the relay's doing): refused, fresh or not. (Another reader.)
    origin = await originIndexer({ ...base, deploy: { inbox: ['cd'.repeat(192)] } });
    const other = new ChainReader({ indexerUrl: URL_, networkId: 'stagenet', fetchImpl });
    const seeded = await other.checkAccount(ACCOUNT, { deviceKey: DEVICE, encPublicKey: ENC, fresh: true });
    expect(seeded.check.problems.map((p) => p.code)).toEqual(['not-empty']);
    const later = await other.checkAccount(ACCOUNT, { deviceKey: DEVICE, encPublicKey: ENC });
    expect(later.check.problems.map((p) => p.code)).toEqual(['not-empty']);
    expect(originReads()).toBe(2); // once per reader
  });

  it('shares reads already on their way, and reads again after', async () => {
    const state = await accountStateHex({
      account: ACCOUNT,
      deviceKey: DEVICE,
      encKey: ENC,
      salt: networkSaltFor('stagenet'),
    });
    const { calls, fetchImpl } = stubIndexer(() => ({ data: { contract: { state }, block: { height: 1 } } }));
    const chain = new ChainReader({ indexerUrl: URL_, networkId: 'stagenet', fetchImpl });
    const [a, b, c] = await Promise.all([chain.account(ACCOUNT), chain.accountState(ACCOUNT), chain.account(ACCOUNT)]);
    expect(calls).toHaveLength(1);
    expect(a?.view).toEqual(b);
    expect(c).toBe(a);
    await chain.account(ACCOUNT);
    expect(calls).toHaveLength(2);
  });

  it('says there is no account, and names an indexer that fails or refuses', async () => {
    const none = stubIndexer(() => ({ data: { contract: null, block: { height: 1 } } }));
    const chain = new ChainReader({ indexerUrl: URL_, networkId: 'stagenet', fetchImpl: none.fetchImpl });
    expect(await chain.account(ACCOUNT)).toBeNull();
    const { check } = await chain.checkAccount(ACCOUNT, { deviceKey: DEVICE, encPublicKey: ENC });
    expect(check.ok).toBe(false);
    const down = stubIndexer(() => ({}), 503);
    await expect(
      new ChainReader({ indexerUrl: URL_, networkId: 'stagenet', fetchImpl: down.fetchImpl }).account(ACCOUNT),
    ).rejects.toThrow(ChainReadError);
    const refusing = stubIndexer(() => ({ errors: [{ message: 'no such field' }] }));
    await expect(
      new ChainReader({ indexerUrl: URL_, networkId: 'stagenet', fetchImpl: refusing.fetchImpl }).account(ACCOUNT),
    ).rejects.toThrow(/refused the read: no such field/);
    await expect(chain.account('nope')).rejects.toThrow(/not an account address/);
  });

  // ── AA 00047 P11.B (questions Q47 A, Q52): the account's COMPLETE history, decoded in the page ──

  it('reads a short history over HTTP, decodes its ledger events itself, and calls it complete', async () => {
    const A = accountA.account;
    const { calls, fetchImpl } = stubIndexer((b) =>
      b.query.includes('AccountHistoryTip') ? { data: { block: { height: 777_000 } } } : { data: accountA.data },
    );
    const chain = new ChainReader({ indexerUrl: URL_, networkId: 'stagenet', fetchImpl });
    const h = await chain.accountHistory(`0x${A.toUpperCase()}`);
    // Complete through the tip read BEFORE the actions (not a tip read beside them).
    expect(h).toMatchObject({ account: A, complete: true, throughHeight: 777_000 });
    expect(h.txs.map((t) => t.blockHeight)).toEqual([685597, 685600, 685604, 685608, 685612, 685773, 685786]);
    expect(h.txs.flatMap((t) => t.outputs.map((o) => o.mtIndex))).toEqual(['5179', '5180', '5184', '5186']);
    expect(h.txs.find((t) => t.hash.startsWith('4464f3f4'))!.entryPoints).toEqual(['open_swap_shielded_with_ed25519']);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.body.query).toMatch(/query AccountHistoryTip \{ block \{ height \} \}/);
    expect(calls[1]!.body.query).toMatch(/actions\(limit: \$limit\)/);
    expect(calls[1]!.body.query).toMatch(/zswapLedgerEvents \{ id raw \}/);
    expect(calls[1]!.body.variables).toEqual({ address: A, limit: 500 });
  });

  it('decodes a swap transaction’s calls from its raw bytes, by hash, and refuses bytes of another transaction', async () => {
    const take = take4464.data.transactions[0]!;
    let served = take.hash;
    const { calls, fetchImpl } = stubIndexer(() => ({ data: { transactions: [{ hash: served, raw: take.raw }] } }));
    const chain = new ChainReader({ indexerUrl: URL_, networkId: 'stagenet', fetchImpl });
    const decoded = await chain.transactionCalls(take.hash);
    expect(decoded!.map((c) => c.entryPoint)).toEqual([
      'open_swap_shielded_with_ed25519',
      'open_swap_shielded_with_ed25519',
    ]);
    expect(calls[0]!.body.query).toMatch(
      /transactions\(offset: \{ hash: \$hash \}\) \{ hash \.\.\. on RegularTransaction \{ raw \} \}/,
    );
    expect(await chain.transactionCalls(take.hash)).toBe(decoded); // final: kept
    expect(calls).toHaveLength(1);
    // The indexer serves the take's bytes under another transaction's hash: refused.
    served = 'ab'.repeat(32);
    await expect(chain.transactionCalls('ab'.repeat(32))).rejects.toThrow(/another transaction/);
  });

  it('derives the indexer’s WebSocket endpoint from a moved HTTP one, and keeps the profile’s otherwise', () => {
    expect(indexerWsUrlFor('https://indexer.example/api/v4/graphql')).toBe('wss://indexer.example/api/v4/graphql/ws');
    expect(indexerWsUrlFor('http://indexer.test/api/v4/graphql/')).toBe('ws://indexer.test/api/v4/graphql/ws');
    expect(
      indexerWsUrlOf({
        indexerUrl: 'https://indexer.stagenet.shielded.tools/api/v4/graphql',
        indexerWsUrl: 'wss://indexer.stagenet.shielded.tools/api/v4/graphql/ws',
      }),
    ).toBe('wss://indexer.stagenet.shielded.tools/api/v4/graphql/ws');
    expect(
      indexerWsUrlOf({
        indexerUrl: 'http://indexer.test/api/v4/graphql',
        indexerWsUrl: 'wss://indexer.stagenet.shielded.tools/api/v4/graphql/ws',
      }),
    ).toBe('ws://indexer.test/api/v4/graphql/ws');
  });

  // R3-5 (browser side) and Q52: an account with more than 500 actions (an active one, or a griefer's
  // 600 one-unit deposits) is read in FULL from the indexer, never by the hashes the relay names.
  describe('a history longer than the indexer’s newest page', () => {
    const h = (n: number) => n.toString(16).padStart(64, '0');
    const leaf = (tx: string, mtIndex: number, commitment = h(0xc000 + mtIndex)) => ({
      id: mtIndex,
      raw: zswapOutputEventHex({ txHash: tx, contract: ACCOUNT, commitment, mtIndex }),
    });
    /** One action of the account at `height`, with one leaf. */
    const action = (n: number, height: number) => ({
      __typename: 'ContractCall',
      entryPoint: 'deposit_shielded',
      transaction: {
        hash: h(n),
        id: n,
        block: { height },
        zswapStartIndex: n,
        zswapEndIndex: n + 1,
        transactionResult: { status: 'SUCCESS' },
        zswapLedgerEvents: [leaf(h(n), n)],
      },
    });
    // The account's 120 own transactions (heights 10..129), then 600 newer one-unit deposits.
    const own = Array.from({ length: 120 }, (_, i) => action(i + 1, 10 + i));
    const pad = Array.from({ length: 600 }, (_, i) => action(1_000 + i, 1_000 + i));
    const all = [...own, ...pad];
    const spendTx = own[7]!.transaction;
    spendTx.zswapLedgerEvents.push({
      id: 99_999,
      raw: zswapInputEventHex({ txHash: spendTx.hash, contract: ACCOUNT, nullifier: 'ee'.repeat(32) }),
    });

    /** The indexer's WebSocket (graphql-transport-ws): every action from the offset, oldest first, then
     *  nothing (the indexer's stream waits for new actions). */
    function fakeWs(opts: { refuse?: boolean; actions?: typeof all } = {}) {
      const subscriptions: Array<Record<string, unknown>> = [];
      class FakeWebSocket {
        static CONNECTING = 0;
        static OPEN = 1;
        readyState = 0;
        onopen: (() => void) | null = null;
        onmessage: ((m: { data: string }) => void) | null = null;
        onerror: (() => void) | null = null;
        onclose: (() => void) | null = null;
        sent: string[] = [];
        constructor(
          readonly url: string,
          readonly protocol: string,
        ) {
          setTimeout(() => {
            if (opts.refuse) {
              this.readyState = 3;
              this.onerror?.();
              return;
            }
            this.readyState = 1;
            this.onopen?.();
          }, 1);
        }
        send(text: string) {
          const msg = JSON.parse(text) as {
            type: string;
            id?: string;
            payload?: { variables: Record<string, unknown> };
          };
          const reply = (m: unknown) => setTimeout(() => this.onmessage?.({ data: JSON.stringify(m) }), 0);
          if (msg.type === 'connection_init') reply({ type: 'connection_ack' });
          if (msg.type === 'subscribe') {
            subscriptions.push(msg.payload!.variables);
            const from = (msg.payload!.variables.offset as { height: number }).height;
            for (const a of opts.actions ?? all)
              if (a.transaction.block.height >= from)
                reply({ id: msg.id, type: 'next', payload: { data: { contractActions: a } } });
          }
        }
        close() {
          this.readyState = 3;
        }
      }
      return { FakeWebSocket: FakeWebSocket as unknown as typeof WebSocket, subscriptions };
    }

    const indexer = (actions: typeof all, tip: number) =>
      stubIndexer((b) => {
        if (b.query.includes('AccountHistoryTip')) return { data: { block: { height: tip } } };
        if (b.query.includes('type: DEPLOY'))
          return { data: { contract: { actions: [{ transaction: { block: { height: 10 } } }] } } };
        const limit = Number(b.variables.limit);
        return { data: { contract: { actions: [...actions].reverse().slice(0, limit) } } };
      });

    it('streams the older actions over the indexer’s WebSocket from the deploy’s block, and calls it complete', async () => {
      const { calls, fetchImpl } = indexer(all, 2_000);
      const ws = fakeWs();
      const chain = new ChainReader({
        indexerUrl: URL_,
        networkId: 'stagenet',
        fetchImpl,
        WebSocketImpl: ws.FakeWebSocket,
      });
      const hist = await chain.accountHistory(ACCOUNT);
      expect(hist.complete).toBe(true);
      expect(hist.throughHeight).toBe(2_000);
      expect(hist.txs).toHaveLength(720);
      expect(hist.txs[0]!.hash).toBe(h(1)); // oldest first
      expect(hist.txs.find((t) => t.hash === h(8))!.inputs).toEqual(['ee'.repeat(32)]);
      expect(ws.subscriptions).toEqual([{ address: ACCOUNT, offset: { height: 10 } }]);
      // One page read, one deploy read; nothing by a hash anyone named.
      expect(
        calls.map((c) => (c.body.query.includes('DEPLOY') ? 'deploy' : c.body.query.includes('Tip') ? 'tip' : 'page')),
      ).toEqual(['tip', 'page', 'deploy']);
      // The next read: the page reaches back to what this session already holds, so no stream.
      const again = await chain.accountHistory(ACCOUNT);
      expect(again.complete).toBe(true);
      expect(again.txs).toHaveLength(720);
      expect(ws.subscriptions).toHaveLength(1);
    });

    it('a stream that is refused, or ends before the page, leaves the history INCOMPLETE (with the reason)', async () => {
      const { fetchImpl } = indexer(all, 2_000);
      const refused = new ChainReader({
        indexerUrl: URL_,
        networkId: 'stagenet',
        fetchImpl,
        WebSocketImpl: fakeWs({ refuse: true }).FakeWebSocket,
      });
      const r = await refused.accountHistory(ACCOUNT);
      expect(r.complete).toBe(false);
      expect(r.gap).toMatch(/stream failed/);
      expect(r.txs).toHaveLength(500); // only the newest page: nothing older invented
      // The indexer's stream serves only part of the gap, then waits (a lagging replica): the read gives up.
      const lagging = new ChainReader({
        indexerUrl: URL_,
        networkId: 'stagenet',
        fetchImpl,
        WebSocketImpl: fakeWs({ actions: own.slice(0, 50) }).FakeWebSocket,
      });
      (lagging as unknown as { histories: { o: { streamTimeoutMs: number } } }).histories.o.streamTimeoutMs = 300;
      const l = await lagging.accountHistory(ACCOUNT);
      expect(l.complete).toBe(false);
      expect(l.gap).toMatch(/too long/);
    });

    it('a page that is not full is the whole history: no stream', async () => {
      const { fetchImpl } = indexer(own, 200);
      const ws = fakeWs();
      const chain = new ChainReader({
        indexerUrl: URL_,
        networkId: 'stagenet',
        fetchImpl,
        WebSocketImpl: ws.FakeWebSocket,
      });
      const hist = await chain.accountHistory(ACCOUNT);
      expect(hist).toMatchObject({ complete: true, throughHeight: 200 });
      expect(hist.txs).toHaveLength(120);
      expect(ws.subscriptions).toEqual([]);
    });

    it('an event the ledger does not accept leaves its transaction out and the history incomplete', async () => {
      const broken = own.map((a, i) =>
        i === 3 ? { ...a, transaction: { ...a.transaction, zswapLedgerEvents: [{ id: 1, raw: 'abcd' }] } } : a,
      );
      const { fetchImpl } = indexer(broken, 200);
      const hist = await new ChainReader({ indexerUrl: URL_, networkId: 'stagenet', fetchImpl }).accountHistory(
        ACCOUNT,
      );
      expect(hist.complete).toBe(false);
      expect(hist.gap).toMatch(/could not be read/);
      expect(hist.txs).toHaveLength(119);
    });
  });
});
