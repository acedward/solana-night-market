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
import { AccountHistoryTooLongError, ChainReadError, ChainReader } from '../src/chain/indexer.js';

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

  it('reads the account’s transactions with their raw events, and refuses a history it cannot page', async () => {
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
    const full = stubIndexer(() => ({
      data: { contract: { actions: Array.from({ length: 3 }, (_, i) => tx(`c${i}`, i)) } },
    }));
    await expect(
      new ChainReader({
        indexerUrl: URL_,
        networkId: 'stagenet',
        fetchImpl: full.fetchImpl,
        maxActions: 3,
      }).accountTransactions(ACCOUNT),
    ).rejects.toThrow(AccountHistoryTooLongError);
  });
});
