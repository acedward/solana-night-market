// AA 00047 P11.A (audit round 3: R3-1 / F-A3-1 MAJOR, R3-10 / F-A3-6.3): the page's chain reader
// (../src/chain/indexer.ts) judges every account's ORIGIN on the public indexer, and the opening flow
// (../src/passport/operations.ts) waits for it without ever keeping "not known yet" as a refusal.
//
// The stub indexer below answers both the reads of this version and the P10 ones (the deploy's
// block, the state at that block), so these tests also run against the page before P11: there the
// time-bombed account and the account written to before its authority retired pass (fail-before).

import nacl from 'tweetnacl';
import { x25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, type ActionRequest, type JobView, type RelayActionName } from '@nightmarket/core';
import { networkSaltFor } from '@nightmarket/core/passport';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEPLOY_TX_IDENTIFIER,
  originIndexer,
  type OriginSpec,
} from '../../packages/core/test/fixtures/account-origin.js';
import { accountStateHex, type AccountStateSpec } from '../../packages/core/test/fixtures/account-state.js';
import { ChainReader } from '../src/chain/indexer.js';
import {
  AccountCheckError,
  NEW_ACCOUNT_POLL_MS,
  NEW_ACCOUNT_WAIT_MS,
  openAccount,
  verifiedAccount,
  type OperationEnv,
} from '../src/passport/operations.js';
import { readAccount } from '../src/passport/records.js';
import type { RelayClient } from '../src/relay/client.js';
import { LocalStore } from '../src/store/store.js';
import { FakeChain } from './fake-chain.js';
import { fakeSigning } from './fake-signing.js';

const ACCOUNT = '7e'.repeat(32);
const DEVICE = bytesToHex(nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(4)).publicKey);
const ENC = bytesToHex(x25519.getPublicKey(new Uint8Array(32).fill(6)));
const SALT = networkSaltFor('stagenet');
const URL_ = 'https://indexer.example/api/v4/graphql';
const base = { account: ACCOUNT, deviceKey: DEVICE, encKey: ENC, salt: SALT };
const codes = (c: { problems: Array<{ code: string }> }) => c.problems.map((p) => p.code);

/** A stub public indexer: the account's current state, and its origin (both P11's reads and P10's). */
async function indexer(now: Partial<AccountStateSpec>, origin: Partial<OriginSpec> = {}) {
  let spec: Partial<OriginSpec> = origin;
  let o = await originIndexer({ ...base, ...spec });
  const queries: string[] = [];
  const state = await accountStateHex({ ...base, ...now });
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
    queries.push(body.query.match(/query (\w+)/)?.[1] ?? '?');
    let data = o.answer(body.query, body.variables);
    // P10's reads: the deploy's block, then the state at that block.
    if (data === undefined && body.query.includes('AccountDeploy('))
      data = { contract: { actions: spec.noDeployRecord ? [] : [{ transaction: { block: { height: 100 } } }] } };
    if (data === undefined && body.query.includes('AccountStateAt(')) data = { contract: { state: o.deployState } };
    if (data === undefined) data = { contract: { state }, block: { height: 120 } };
    return new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return {
    chain: new ChainReader({ indexerUrl: URL_, networkId: 'stagenet', fetchImpl }),
    queries,
    /** The indexer's view of the origin changes (it catches up). */
    async set(next: Partial<OriginSpec>) {
      spec = next;
      o = await originIndexer({ ...base, ...spec });
    },
  };
}

describe('the page refuses a relay-made account it did not see created honestly (R3-1)', () => {
  // Auditor A's probe (audit-a3-probe-round.ts): the honest constructor's state but for `round` set
  // to 2^64 - 4. Just activated, it is at 2^64 - 3: three more calls and it freezes, funds included.
  it('auditor A’s `round` time bomb is refused at opening, and on every later check', async () => {
    const { chain } = await indexer({ round: (1n << 64n) - 3n }, { deploy: { round: (1n << 64n) - 4n } });
    const fresh = await chain.checkAccount(ACCOUNT, { deviceKey: DEVICE, encPublicKey: ENC, fresh: true });
    expect(fresh.check.ok).toBe(false);
    expect(codes(fresh.check)).toEqual(['counters', 'provenance']);
    expect(fresh.check.problems.map((p) => p.detail)).toEqual(['round 18446744073709551613', 'deploy-time round']);
    const later = await chain.checkAccount(ACCOUNT, { deviceKey: DEVICE, encPublicKey: ENC });
    expect(codes(later.check)).toEqual(['counters', 'provenance']);
  });

  it('the bomb set low enough to pass the counter bound is still refused by its origin', async () => {
    const { chain } = await indexer({ round: 3n }, { deploy: { round: 2n } });
    const { check } = await chain.checkAccount(ACCOUNT, { deviceKey: DEVICE, encPublicKey: ENC, fresh: true });
    expect(codes(check)).toEqual(['provenance']);
  });

  it('an account written to before its authority retired is refused (the temporary-key route)', async () => {
    const { chain } = await indexer({}, { windowExtra: [{ kind: 'call', entryPoint: 'deposit_unshielded' }] });
    const { check } = await chain.checkAccount(ACCOUNT, { deviceKey: DEVICE, encPublicKey: ENC });
    expect(codes(check)).toEqual(['provenance']);
    expect(check.problems[0]!.message).toMatch(/before its contract was locked/);
  });

  it('an honest account passes, and its origin is read once per page', async () => {
    const { chain, queries } = await indexer({});
    for (let i = 0; i < 3; i++)
      expect((await chain.checkAccount(ACCOUNT, { deviceKey: DEVICE, encPublicKey: ENC })).check.ok).toBe(true);
    expect(queries.filter((q) => q === 'AccountOrigin')).toHaveLength(1);
    expect(queries.filter((q) => q === 'AccountState')).toHaveLength(3);
  });
});

describe('a deploy the indexer does not show is not judged on the current state (R3-10)', () => {
  it('"not known yet": only that, not kept, and read again until the indexer shows it', async () => {
    // A deposit by anyone since the deploy is in the current state: never a reason to refuse.
    const ix = await indexer(
      { inbox: ['ab'.repeat(192)], unshielded: [['ef'.repeat(32), 1n]] },
      { noDeployRecord: true },
    );
    const first = await ix.chain.checkAccount(ACCOUNT, { deviceKey: DEVICE, encPublicKey: ENC, fresh: true });
    expect(codes(first.check)).toEqual(['provenance-unknown']);
    await ix.set({});
    const next = await ix.chain.checkAccount(ACCOUNT, { deviceKey: DEVICE, encPublicKey: ENC, fresh: true });
    expect(next.check).toEqual({ ok: true, problems: [], useCounter: 0n });
  });

  it('reads the deploy transaction the browser recorded at opening when there is no deploy record', async () => {
    const { chain, queries } = await indexer({}, { noDeployRecord: true });
    const { check } = await chain.checkAccount(ACCOUNT, {
      deviceKey: DEVICE,
      encPublicKey: ENC,
      deployTx: DEPLOY_TX_IDENTIFIER,
    });
    expect(check.ok).toBe(true);
    expect(queries).toContain('AccountDeployTx');
  });
});

// ── The opening flow ────────────────────────────────────────────────────────────────────

class MiniRelay {
  submitted: Array<{ action: RelayActionName; request: ActionRequest }> = [];
  async nonce() {
    return { nonce: `0x${'12'.repeat(32)}`, expiresAt: 0, maxTtlSeconds: 600 };
  }
  async submit(action: RelayActionName, request: ActionRequest): Promise<JobView> {
    this.submitted.push({ action, request });
    return {
      requestId: '1'.padStart(32, '0'),
      action,
      lane: 'prover',
      state: 'queued',
      stage: 'queued',
      stages: [],
      createdAt: 0,
      updatedAt: 0,
      expiresAt: 0,
    };
  }
  async waitForJob(requestId: string): Promise<JobView> {
    return {
      requestId,
      action: 'register',
      lane: 'prover',
      state: 'succeeded',
      stage: 'succeeded',
      stages: [],
      createdAt: 0,
      updatedAt: 0,
      expiresAt: 0,
      result: {
        account: ACCOUNT,
        device: 'ee'.repeat(32),
        txs: { waveOne: DEPLOY_TX_IDENTIFIER, waveTwo: 'w2', activation: 'a' },
        seconds: {},
      },
    };
  }
}

describe('opening an account: the origin is waited for, and "not known yet" is never kept (R3-10)', () => {
  let storage: Storage;
  beforeEach(() => {
    window.localStorage.clear();
    storage = window.localStorage;
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
  });
  afterEach(() => vi.useRealTimers());

  const setUp = () => {
    const { signing } = fakeSigning();
    const chain = new FakeChain({
      state: {
        account: ACCOUNT,
        booted: true,
        deviceCount: 1,
        deviceEpoch: '0',
        devices: [],
        authNonce: '0',
        inboxCount: '0',
        encKey: '00'.repeat(32),
        networkSalt: '5a'.repeat(32),
      },
      entries: [],
      zswapActivity: { account: ACCOUNT, outputs: [], inputs: [], transactions: 0, blockHeight: 0 },
    });
    const e: OperationEnv = {
      relay: new MiniRelay() as unknown as RelayClient,
      chain,
      store: new LocalStore(storage),
      scope: { network: 'undeployed', owner: signing.deviceKey },
      signing,
    };
    return { e, chain };
  };
  const UNKNOWN = {
    ok: false,
    useCounter: null,
    problems: [{ code: 'provenance-unknown' as const, message: 'not yet' }],
  };

  it('waits while the indexer does not show the deploy, then opens', async () => {
    const { e, chain } = setUp();
    chain.check = UNKNOWN;
    const p = openAccount(e);
    await vi.advanceTimersByTimeAsync(NEW_ACCOUNT_POLL_MS * 2 + 10);
    expect(chain.expectations.length).toBeGreaterThanOrEqual(2);
    expect(chain.expectations[0]).toMatchObject({ fresh: true, deployTx: DEPLOY_TX_IDENTIFIER });
    chain.check = null; // the indexer caught up
    await vi.advanceTimersByTimeAsync(NEW_ACCOUNT_POLL_MS + 10);
    await expect(p).resolves.toMatchObject({ address: ACCOUNT });
    expect(readAccount(e.store, e.scope, ACCOUNT)?.refusedAtOpen).toBeUndefined();
  });

  it('still unknown at the deadline: refused for now, never kept, usable once the chain shows it', async () => {
    const { e, chain } = setUp();
    chain.check = UNKNOWN;
    const p = openAccount(e).catch((x: unknown) => x);
    await vi.advanceTimersByTimeAsync(NEW_ACCOUNT_WAIT_MS + NEW_ACCOUNT_POLL_MS * 2);
    expect(await p).toBeInstanceOf(AccountCheckError);
    expect(readAccount(e.store, e.scope, ACCOUNT)?.refusedAtOpen).toBeUndefined();
    await expect(verifiedAccount(e, ACCOUNT)).rejects.toBeInstanceOf(AccountCheckError);
    chain.check = null;
    await expect(verifiedAccount(e, ACCOUNT)).resolves.toMatchObject({ account: ACCOUNT });
    // Every later check passes the deploy transaction recorded at opening (R3-10's fallback).
    expect(chain.expectations.at(-1)).toMatchObject({ deployTx: DEPLOY_TX_IDENTIFIER });
  });

  it('a refusal of its origin at opening (it did not start empty) is kept, as before', async () => {
    const { e, chain } = setUp();
    chain.check = { ok: false, useCounter: null, problems: [{ code: 'not-empty', message: 'seeded' }] };
    await expect(openAccount(e)).rejects.toBeInstanceOf(AccountCheckError);
    expect(readAccount(e.store, e.scope, ACCOUNT)?.refusedAtOpen).toEqual([{ code: 'not-empty', message: 'seeded' }]);
  });
});
