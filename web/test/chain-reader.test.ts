// AA 00047 P9.S (questions Q26 A): the browser's own reader of the public indexer
// (../src/chain/indexer.ts), against a stub indexer that serves a REAL serialised account state
// (packages/core/test/fixtures/account-state.ts): the GraphQL it sends, the decoding, the check with
// this build's pinned keys and this network's salt, the errors, and reads shared while in flight.

import nacl from 'tweetnacl';
import { x25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@nightmarket/core';
import { networkSaltFor } from '@nightmarket/core/passport';
import { describe, expect, it } from 'vitest';

import { accountStateHex } from '../../packages/core/test/fixtures/account-state.js';
import { ChainReadError, ChainReader, TX_PAGE } from '../src/chain/indexer.js';

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
    const { calls, fetchImpl } = stubIndexer(() => ({ data: { contract: { state }, block: { height: 77 } } }));
    const chain = new ChainReader({ indexerUrl: URL_, networkId: 'stagenet', fetchImpl });
    const { state: s, check } = await chain.checkAccount(`0x${ACCOUNT.toUpperCase()}`, {
      deviceKey: DEVICE,
      encPublicKey: ENC,
    });
    expect(check).toEqual({ ok: true, problems: [], useCounter: 2n });
    expect(s?.blockHeight).toBe(77);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(URL_);
    expect(calls[0]!.body.query).toMatch(/contract\(address: \$address\) \{ state \}/);
    expect(calls[0]!.body.variables).toEqual({ address: ACCOUNT });
    // Another network's page refuses the same account.
    const other = new ChainReader({ indexerUrl: URL_, networkId: 'undeployed', fetchImpl });
    const r = await other.checkAccount(ACCOUNT, { deviceKey: DEVICE, encPublicKey: ENC });
    expect(r.check.problems.map((p) => p.code)).toEqual(['network-salt']);
  });

  // AA 00047 P10 (R2-6, questions Q42): a just-opened account must start empty AS DEPLOYED: the page
  // reads its state at the deploy's block, so a deposit by anyone since does not get it refused.
  it('checks a fresh account’s emptiness on its deploy-time state, read once', async () => {
    const base = { account: ACCOUNT, deviceKey: DEVICE, encKey: ENC, salt: networkSaltFor('stagenet') };
    const now = await accountStateHex({ ...base, inbox: ['ab'.repeat(192)] }); // someone deposited since
    let asDeployed = await accountStateHex({ ...base, noDevice: true, booted: false });
    const { calls, fetchImpl } = stubIndexer((b) => {
      if (b.query.includes('type: DEPLOY'))
        return { data: { contract: { actions: [{ transaction: { block: { height: 41 } } }] } } };
      if (b.query.includes('offset: { height')) return { data: { contract: { state: asDeployed } } };
      return { data: { contract: { state: now }, block: { height: 77 } } };
    });
    const chain = new ChainReader({ indexerUrl: URL_, networkId: 'stagenet', fetchImpl });
    const ok = await chain.checkAccount(ACCOUNT, { deviceKey: DEVICE, encPublicKey: ENC, fresh: true });
    expect(ok.check).toEqual({ ok: true, problems: [], useCounter: 0n });
    expect(calls.map((c) => c.body.variables)).toContainEqual({ address: ACCOUNT, height: 41 });
    // Not fresh: the deploy is not read.
    const n = calls.length;
    await chain.checkAccount(ACCOUNT, { deviceKey: DEVICE, encPublicKey: ENC });
    expect(calls).toHaveLength(n + 1);
    // Seeded at the deploy (the relay's doing): refused. (Another reader: the deploy state is kept.)
    asDeployed = await accountStateHex({ ...base, noDevice: true, booted: false, inbox: ['cd'.repeat(192)] });
    const other = new ChainReader({ indexerUrl: URL_, networkId: 'stagenet', fetchImpl });
    const seeded = await other.checkAccount(ACCOUNT, { deviceKey: DEVICE, encPublicKey: ENC, fresh: true });
    expect(seeded.check.problems.map((p) => p.code)).toEqual(['not-empty']);
    await other.checkAccount(ACCOUNT, { deviceKey: DEVICE, encPublicKey: ENC, fresh: true });
    expect(calls.filter((c) => c.body.query.includes('type: DEPLOY'))).toHaveLength(2); // once per reader
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

  it('reads the account’s transactions with their raw events', async () => {
    const tx = (hash: string, height: number) => ({
      transaction: { hash, block: { height }, zswapLedgerEvents: [{ id: height, raw: `${hash}00` }] },
    });
    const { calls, fetchImpl } = stubIndexer(() => ({
      data: { contract: { actions: [tx('bb', 2), tx('aa', 1), tx('bb', 2)] } },
    }));
    const chain = new ChainReader({ indexerUrl: URL_, networkId: 'stagenet', fetchImpl, maxActions: 10 });
    expect((await chain.accountTransactions(ACCOUNT)).map((t) => [t.hash, t.blockHeight])).toEqual([
      ['aa', 1],
      ['bb', 2],
    ]);
    expect(calls[0]!.body.query).toMatch(/zswapLedgerEvents \{ id raw \}/);
    expect(calls[0]!.body.variables).toEqual({ address: ACCOUNT, limit: 10 });
    // A page that is not full is the whole history: nothing is read by hash.
    const more = await chain.accountTransactions(ACCOUNT, ['ee'.repeat(32)]);
    expect(more.map((t) => t.hash)).toEqual(['aa', 'bb']);
    expect(calls).toHaveLength(2);
  });

  // AA 00047 P10 (audit round 2, R2-6 / F-A2-4): from 500 actions on, every sync used to throw, so new
  // coins never got a position. A griefer could force it with ~500 one-unit deposits. The indexer
  // serves only the newest 500 (no offset): the page reads the older transactions it needs by hash.
  it('reads past a full page by transaction hash, keeping only the account’s own transactions', async () => {
    const h = (n: number) => n.toString(16).padStart(64, '0');
    const OTHER = '3c'.repeat(32);
    // The newest page: 500 recent actions (the griefer's), none of them the ones the report needs.
    const page = Array.from({ length: 500 }, (_, i) => ({
      transaction: { hash: h(10_000 + i), block: { height: 10_000 + i }, zswapLedgerEvents: [] },
    }));
    // Older transactions, served by hash: 120 of the account's, one that is NOT the account's.
    const older = new Map<string, unknown>();
    for (let i = 0; i < 120; i++)
      older.set(h(i), {
        hash: h(i),
        block: { height: i },
        contractActions: [{ address: ACCOUNT }],
        zswapLedgerEvents: [{ id: i, raw: `${ACCOUNT}${h(i)}` }],
      });
    older.set(h(999), {
      hash: h(999),
      block: { height: 999 },
      contractActions: [{ address: OTHER }],
      zswapLedgerEvents: [],
    });
    const { calls, fetchImpl } = stubIndexer((b) => {
      if (b.query.includes('contract(address')) return { data: { contract: { actions: page } } };
      const data: Record<string, unknown[]> = {};
      for (const [k, v] of Object.entries(b.variables)) {
        const t = older.get(String(v));
        data[k.replace(/^h/, 't')] = t ? [t] : [];
      }
      return { data };
    });
    const chain = new ChainReader({ indexerUrl: URL_, networkId: 'stagenet', fetchImpl });
    const need = [...Array.from({ length: 120 }, (_, i) => h(i)), h(999), h(10_001), 'nonsense', h(5)];
    const txs = await chain.accountTransactions(`0x${ACCOUNT}`, need);
    expect(txs).toHaveLength(620); // the page, plus the 120 older ones; never the other contract's
    expect(txs[0]!.hash).toBe(h(0)); // oldest first
    expect(txs.some((t) => t.hash === h(999))).toBe(false);
    expect(txs.find((t) => t.hash === h(7))!.events).toEqual([{ id: 7, raw: `${ACCOUNT}${h(7)}` }]);
    // One page read, then the by-hash pages: 121 hashes (deduplicated, valid, not on the page).
    const byHash = calls.slice(1);
    expect(byHash).toHaveLength(Math.ceil(121 / TX_PAGE));
    expect(byHash[0]!.body.query).toMatch(
      /t0: transactions\(offset: \{ hash: \$h0 \}\) \{ hash block \{ height \} contractActions \{ address \}/,
    );
    expect(Object.keys(byHash[0]!.body.variables)).toHaveLength(TX_PAGE);
    // Final transactions are not read twice.
    await chain.accountTransactions(ACCOUNT, need);
    expect(calls).toHaveLength(1 + byHash.length + 1);
  });
});
