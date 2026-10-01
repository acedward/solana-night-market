// Plan L-ACC in the browser, against a fake relay and a TEST Solana wallet (./fake-signing.ts; the
// Phantom one is lane B2's): one signature per action, the secret stored before anything leaves the
// page, the inbox decrypted here, the coin chosen here and passed as the call's private state, the
// change kept here until re-filed (Q13).

import { ed25519 } from '@noble/curves/ed25519.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  NO_ACCOUNT,
  bytesToHex,
  contractCoinCommitment,
  contractCoinNullifier,
  formatShieldedAddress,
  formatUnshieldedAddress,
  hexToBytes,
  payloadHash,
  type AccountStateView,
  type ActionRequest,
  type InboxPage,
  type JobView,
  type RelayActionName,
  type SignedRelayAction,
  type ZswapActivity,
} from '@nightmarket/core';
import {
  openEntryPortable,
  predictWithdrawChange,
  sealEntryPortable,
  sendShieldedChangeNonce,
  withdrawRequest,
} from '@nightmarket/core/passport';
import { x25519 } from '@noble/curves/ed25519.js';

import { testScheme } from '../../packages/core/test/fixtures/test-signing.js';

import { exportFileText, importFile } from '../src/pages/LocalData.js';
import {
  AccountCheckError,
  NEW_ACCOUNT_POLL_MS,
  openAccount,
  secureChange,
  syncAccount,
  unsecuredCoins,
  withdrawToWallet,
  withdrawUnshieldedToWallet,
  type OperationEnv,
} from '../src/passport/operations.js';
import { claimDemoTokens, claimState, packText } from '../src/demo/operations.js';
import { readCoins, readRoster, readSecret } from '../src/passport/records.js';
import type { RelayClient } from '../src/relay/client.js';
import { MAX_IMPORT_READ_BYTES, recordKey } from '../src/store/schema.js';
import { LocalStore } from '../src/store/store.js';
import { FakeChain } from './fake-chain.js';
import { fakeCallMessage, fakeDeviceEntry, fakeSigning } from './fake-signing.js';
import { expectImportRoundTrip } from './roundtrip.js';

const ACCOUNT = 'ac'.repeat(32);
const COLOUR = 'c0'.repeat(32);

class FakeRelay {
  submitted: Array<{ action: RelayActionName; request: ActionRequest }> = [];
  results: Record<string, Record<string, unknown>> = {};
  failNext: string | null = null;
  failCode = 'x';
  state: AccountStateView | null = null;
  entries: Array<string | null> = [];
  zswapActivity: ZswapActivity = { account: ACCOUNT, outputs: [], inputs: [], transactions: 0, blockHeight: 0 };

  async nonce() {
    return { nonce: `0x${'12'.repeat(32)}`, expiresAt: 0, maxTtlSeconds: 600 };
  }
  async submit(action: RelayActionName, request: ActionRequest): Promise<JobView> {
    this.submitted.push({ action, request });
    return this.view(`${this.submitted.length}`.padStart(32, '0'), action, 'queued');
  }
  private view(
    requestId: string,
    action: RelayActionName,
    state: JobView['state'],
    extra: Partial<JobView> = {},
  ): JobView {
    return {
      requestId,
      action,
      lane: 'prover',
      state,
      stage: state,
      stages: [{ stage: state, at: 0 }],
      createdAt: 0,
      updatedAt: 0,
      expiresAt: 0,
      ...extra,
    };
  }
  async waitForJob(requestId: string, onUpdate: (j: JobView) => void): Promise<JobView> {
    const sub = this.submitted[Number(requestId) - 1]!;
    const action = sub.action;
    const job =
      this.failNext !== null
        ? this.view(requestId, action, 'failed', { error: { code: this.failCode, message: this.failNext } })
        : this.view(requestId, action, 'succeeded', { result: this.results[action] ?? {} });
    // A registration that succeeded is on chain: the fresh account, as the indexer then shows it.
    if (action === 'register' && job.state === 'succeeded' && !this.state) {
      const owner = (sub.request.auth as SignedRelayAction).message.owner;
      this.state = {
        account: ACCOUNT,
        booted: true,
        deviceCount: 1,
        deviceEpoch: '0',
        devices: [fakeDeviceEntry(ACCOUNT, owner, 0n, 0n)],
        authNonce: '0',
        inboxCount: '0',
        encKey: (sub.request.payload as { encPublicKey: string }).encPublicKey,
        networkSalt: '5a'.repeat(32),
      };
    }
    this.failNext = null;
    this.failCode = 'x';
    onUpdate(job);
    return job;
  }
  // The relay's own reads of the account are NOT used by the page any more (AA 00047 P9.S, Q26): the
  // fake chain serves the account from the same fields. They fail here, so a test that passes proves
  // the page read the chain.
  async accountState(): Promise<AccountStateView | null> {
    throw new Error('the page must not read the account state from the relay');
  }
  async inbox(): Promise<InboxPage> {
    throw new Error('the page must not read the inbox from the relay');
  }
  async zswap() {
    return this.zswapActivity;
  }
}

let storage: Storage;
beforeEach(() => {
  window.localStorage.clear();
  storage = window.localStorage;
});

function env(signing: OperationEnv['signing'], relay: FakeRelay, chain = new FakeChain(relay)): OperationEnv {
  return {
    relay: relay as unknown as RelayClient,
    chain,
    store: new LocalStore(storage),
    scope: { network: 'undeployed', owner: signing.deviceKey },
    signing,
  };
}

const unhex = (h: string) => hexToBytes(h, h.length / 2);

describe('openAccount (L-ACC.1)', () => {
  it('stores the secret first, asks for ONE signature, and keeps the account record on success', async () => {
    const relay = new FakeRelay();
    let secretAtSigning: unknown = null;
    const at: { env?: OperationEnv } = {};
    const { signing, calls } = fakeSigning({
      onSign: () => {
        secretAtSigning = readSecret(at.env!.store, at.env!.scope, null);
      },
    });
    const e = env(signing, relay);
    at.env = e;
    relay.results.register = {
      account: ACCOUNT,
      device: signing.deviceKey,
      txs: { waveOne: 'w1', waveTwo: 'w2', activation: 'act' },
      seconds: { waveOne: 1, waveTwo: 1, activation: 1, total: 3 },
    };
    const rec = await openAccount(e);

    expect(calls).toEqual(['relayAction']);
    expect(secretAtSigning).toMatchObject({ pending: true });
    const [sub] = relay.submitted;
    expect(sub!.action).toBe('register');
    const secret = readSecret(e.store, e.scope, ACCOUNT)!;
    expect(bytesToHex(x25519.getPublicKey(hexToBytes(secret.encSecretKey, 32)))).toBe(secret.encPublicKey);
    expect(sub!.request.payload).toEqual({ encPublicKey: secret.encPublicKey }); // only the PUBLIC key leaves
    const auth = sub!.request.auth as SignedRelayAction;
    expect(auth.message.account).toBe(NO_ACCOUNT);
    expect(auth.message.owner).toBe(signing.deviceKey);
    expect(testScheme.verify(auth.message, unhex(auth.signature))).toBe(true);
    expect(rec).toMatchObject({ address: ACCOUNT, device: signing.deviceKey });
    expect(readSecret(e.store, e.scope, null)).toBeNull();
    expect(readRoster(e.store, e.scope, ACCOUNT)).toEqual({ useCounter: '0' });
    expect(JSON.stringify(Object.keys(localStorage))).not.toContain('/job/');
    expectImportRoundTrip(e.store, e.scope); // F-B4: what the page wrote imports unchanged
  });

  it('keeps the key pair for a retry when the relay fails, and reuses it', async () => {
    const relay = new FakeRelay();
    relay.failNext = 'the market is busy';
    const { signing } = fakeSigning();
    const e = env(signing, relay);
    await expect(openAccount(e)).rejects.toThrow('The market is busy.');
    const pending = readSecret(e.store, e.scope, null)!;
    expect(pending.pending).toBe(true);
    relay.results.register = { account: ACCOUNT, device: signing.deviceKey, txs: {}, seconds: {} };
    await openAccount(e);
    expect(relay.submitted[1]!.request.payload).toEqual({ encPublicKey: pending.encPublicKey });
  });

  // AA 00047 P9.S (audit C3, questions Q26): the relay's "succeeded" is not taken on trust.
  it('checks the new account on the CHAIN as a fresh account of this wallet and this browser key', async () => {
    const relay = new FakeRelay();
    const { signing } = fakeSigning();
    const chain = new FakeChain(relay);
    const e = env(signing, relay, chain);
    relay.results.register = { account: ACCOUNT, device: 'ee'.repeat(32), txs: {}, seconds: {} };
    const rec = await openAccount(e);
    const secret = readSecret(e.store, e.scope, ACCOUNT)!;
    expect(chain.expectations).toEqual([
      { deviceKey: signing.deviceKey, encPublicKey: secret.encPublicKey, fresh: true },
    ]);
    expect(chain.reads).toContain(`state:${ACCOUNT}`);
    // The record names THIS wallet as the device, whatever the relay reported.
    expect(rec.device).toBe(signing.deviceKey);
  });

  it('refuses a new account that fails the check, keeping its records so nothing is lost', async () => {
    const relay = new FakeRelay();
    const { signing, calls } = fakeSigning();
    const chain = new FakeChain(relay);
    chain.check = {
      ok: false,
      useCounter: null,
      problems: [
        { code: 'devices', message: 'It has 2 devices; a Night Market account has exactly one, your wallet.' },
      ],
    };
    const e = env(signing, relay, chain);
    relay.results.register = { account: ACCOUNT, device: signing.deviceKey, txs: {}, seconds: {} };
    const err = await openAccount(e).catch((x: unknown) => x);
    expect(err).toBeInstanceOf(AccountCheckError);
    expect((err as Error).message).toMatch(/does not pass this site's checks on Midnight: It has 2 devices/);
    expect((err as Error).message).toMatch(/Do not send tokens to it/);
    expect(readSecret(e.store, e.scope, ACCOUNT)).not.toBeNull();
    // And nothing can be signed for it afterwards: every gated call checks again, before the wallet.
    await expect(
      withdrawUnshieldedToWallet(e, ACCOUNT, {
        color: COLOUR,
        amount: 1n,
        recipient: formatUnshieldedAddress('66'.repeat(32), 'undeployed'),
      }),
    ).rejects.toBeInstanceOf(AccountCheckError);
    await expect(claimDemoTokens(e, ACCOUNT)).rejects.toBeInstanceOf(AccountCheckError);
    expect(calls).toEqual(['relayAction']); // only the registration's signature, ever
    expect(relay.submitted.map((x) => x.action)).toEqual(['register']);
  });

  it('waits for the indexer to show the new account before checking it', async () => {
    const relay = new FakeRelay();
    const { signing } = fakeSigning();
    const chain = new FakeChain(relay);
    const e = env(signing, relay, chain);
    relay.results.register = { account: ACCOUNT, device: signing.deviceKey, txs: {}, seconds: {} };
    // The indexer lags: the first read finds no contract, the next one finds it activated.
    const real = chain.checkAccount.bind(chain);
    let first = true;
    chain.checkAccount = async (a, x) => {
      if (first) {
        first = false;
        return { state: null, check: { ok: false, useCounter: null, problems: [] } };
      }
      return real(a, x);
    };
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      const p = openAccount(e);
      await vi.advanceTimersByTimeAsync(NEW_ACCOUNT_POLL_MS + 10);
      await expect(p).resolves.toMatchObject({ address: ACCOUNT });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the inbox walk and the gated calls (L-ACC.2 to L-ACC.5)', () => {
  async function fundedAccount() {
    const relay = new FakeRelay();
    const { signing, calls } = fakeSigning();
    const e = env(signing, relay);
    const sk = x25519.utils.randomSecretKey();
    const pk = x25519.getPublicKey(sk);
    e.store.put(
      e.scope,
      'secret',
      { encSecretKey: bytesToHex(sk), encPublicKey: bytesToHex(pk) },
      { account: ACCOUNT },
    );
    e.store.put(e.scope, 'roster', { useCounter: '0' }, { account: ACCOUNT });
    relay.state = {
      account: ACCOUNT,
      booted: true,
      deviceCount: 1,
      deviceEpoch: '0',
      devices: [fakeDeviceEntry(ACCOUNT, signing.deviceKey, 0n, 1n)],
      authNonce: '7',
      inboxCount: '3',
      encKey: bytesToHex(pk),
      networkSalt: '5a'.repeat(32),
    };
    const c60 = { nonce: '01'.repeat(32), color: COLOUR, value: 60_000_000n };
    const c40 = { nonce: '02'.repeat(32), color: COLOUR, value: 40_000_000n };
    const seal = async (c: typeof c60) =>
      bytesToHex(
        await sealEntryPortable(pk, { nonce: hexToBytes(c.nonce), color: hexToBytes(c.color), value: c.value }),
      );
    relay.entries = [await seal(c60), 'ff'.repeat(192), await seal(c40)];
    const info = (c: typeof c60) => ({ nonce: c.nonce, color: c.color, value: c.value.toString() });
    relay.zswapActivity = {
      account: ACCOUNT,
      outputs: [
        { commitment: contractCoinCommitment(info(c60), ACCOUNT), mtIndex: '100', txHash: 'd1', blockHeight: 1 },
        { commitment: contractCoinCommitment(info(c40), ACCOUNT), mtIndex: '205', txHash: 'd2', blockHeight: 2 },
      ],
      inputs: [],
      transactions: 2,
      blockHeight: 3,
    };
    return { signing, relay, e, calls, sk, pk, c60, c40 };
  }

  it('decrypts the inbox here and positions every coin exactly', async () => {
    const { relay, e, calls } = await fundedAccount();
    const r = await syncAccount(e, ACCOUNT);
    expect(r.unreadable).toBe(1); // the poisoned entry is skipped, never an error
    expect(readCoins(e.store, e.scope, ACCOUNT).map((c) => [c.value, c.mtIndex, c.inInbox])).toEqual([
      ['60000000', '100', true],
      ['40000000', '205', true],
    ]);
    expect(calls).toEqual([]); // reading needs no signature
    expect(relay.submitted).toEqual([]);
  });

  it('withdraws from the smallest covering coin with ONE signature, and keeps the change', async () => {
    const { signing, relay, e, calls } = await fundedAccount();
    await syncAccount(e, ACCOUNT);
    const changeEntitlement = `ae1.${ACCOUNT}.${'0e'.repeat(32)}.99999999999.${'ac'.repeat(32)}`;
    // The change of 30 paid from the 40 coin, as the contract's `sendShielded` makes it (Q28 A).
    const expectedChange = { nonce: sendShieldedChangeNonce('02'.repeat(32)), color: COLOUR, value: '10000000' };
    relay.results.withdraw = { txId: 'wd1', change: expectedChange, changeEntitlement };
    const out = await withdrawToWallet(e, ACCOUNT, {
      color: COLOUR,
      amount: 30_000_000n,
      recipient: '0x' + '44'.repeat(32),
    });

    expect(calls).toEqual(['authorise:withdrawShielded']);
    const sub = relay.submitted[0]!;
    expect(sub.action).toBe('withdraw');
    expect(sub.request.account).toBe(ACCOUNT);
    const payload = sub.request.payload as { coin: { value: string; mtIndex: string }; authNonce: string };
    expect(payload.coin).toMatchObject({ value: '40000000', mtIndex: '205' }); // the 40 covers 30; least change
    expect(payload.authNonce).toBe('7');
    const pa = sub.request.passportAuth as { owner: string; signature: string; useCounter: string };
    expect(pa.useCounter).toBe('1'); // resolved from the live device set, not the stale hint 0
    // The device signed exactly this call: the account, its auth nonce and the withdrawal's request.
    expect(pa.owner).toBe(signing.deviceKey);
    const message = fakeCallMessage(
      { account: ACCOUNT, authNonce: 7n, networkSalt: '5a'.repeat(32) },
      { kind: 'gated', request: withdrawRequest(sub.request.payload as never) },
    );
    expect(ed25519.verify(unhex(pa.signature), message, unhex(signing.deviceKey))).toBe(true);

    expect(out.change).toMatchObject({ ...expectedChange, inInbox: false, origin: 'change', mtIndex: null });
    expect(out.changeMismatch).toBe(false);
    // Where it came from, so the browser can recompute it before sealing an entry for it.
    expect(out.change?.changeOf).toEqual({
      spent: contractCoinCommitment({ nonce: '02'.repeat(32), color: COLOUR, value: '40000000' }, ACCOUNT),
      amount: '30000000',
    });
    // The market's entitlement to file the change (security review F-B3) is kept with it.
    expect(out.change?.appendEntitlement).toBe(changeEntitlement);
    const coins = readCoins(e.store, e.scope, ACCOUNT);
    expect(coins.find((c) => c.value === '40000000')).toMatchObject({ spent: true, spentTx: 'wd1' });
    expect(coins.find((c) => c.value === '10000000')).toMatchObject({ inInbox: false });
    expect(readRoster(e.store, e.scope, ACCOUNT)).toEqual({ useCounter: '2' });

    // The next walk confirms the spend from the ledger's nullifier and positions the change.
    relay.zswapActivity = {
      ...relay.zswapActivity,
      outputs: [
        ...relay.zswapActivity.outputs,
        { commitment: out.change!.commitment, mtIndex: '300', txHash: 'wd1', blockHeight: 4 },
      ],
      inputs: [
        {
          nullifier: contractCoinNullifier({ nonce: '02'.repeat(32), color: COLOUR, value: '40000000' }, ACCOUNT),
          txHash: 'wd1',
          blockHeight: 4,
        },
      ],
    };
    await syncAccount(e, ACCOUNT);
    expect(readCoins(e.store, e.scope, ACCOUNT).find((c) => c.value === '10000000')).toMatchObject({
      mtIndex: '300',
      inInbox: false,
    });
    expectImportRoundTrip(e.store, e.scope);
  });

  // Security review F-B6: the recipient's encryption key is outside the contract's challenge, so a
  // payment to a wallet address carries a RelayAction envelope over the whole body, same device.
  it('pays a wallet address with ONE signature by default (questions Q13 option B)', async () => {
    const { relay, e, calls } = await fundedAccount();
    await syncAccount(e, ACCOUNT);
    relay.results.withdraw = { txId: 'wd3', change: null };
    const recipient = { coinPublicKey: '44'.repeat(32), encryptionPublicKey: '55'.repeat(32) };
    await withdrawToWallet(e, ACCOUNT, {
      color: COLOUR,
      amount: 40_000_000n,
      recipient: formatShieldedAddress(recipient, 'undeployed'),
    });
    expect(calls).toEqual(['authorise:withdrawShielded']);
    const sub = relay.submitted[0]!;
    expect(sub.request.payload).toMatchObject({ recipient: '44'.repeat(32), recipientEncryptionKey: '55'.repeat(32) });
    expect(sub.request.auth).toBeUndefined();
  });

  it("pays a wallet address with a second signature that binds its encryption key, when the relay's policy asks", async () => {
    const { signing, relay, e, calls } = await fundedAccount();
    await syncAccount(e, ACCOUNT);
    relay.results.withdraw = { txId: 'wd2', change: null };
    const recipient = { coinPublicKey: '44'.repeat(32), encryptionPublicKey: '55'.repeat(32) };
    await withdrawToWallet(
      e,
      ACCOUNT,
      {
        color: COLOUR,
        amount: 40_000_000n,
        recipient: formatShieldedAddress(recipient, 'undeployed'),
      },
      { recipientEnvelope: true },
    );
    expect(calls).toEqual(['authorise:withdrawShielded', 'relayAction']);
    const sub = relay.submitted[0]!;
    const payload = sub.request.payload as Record<string, unknown>;
    expect(payload).toMatchObject({ recipient: '44'.repeat(32), recipientEncryptionKey: '55'.repeat(32) });
    const auth = sub.request.auth as SignedRelayAction;
    expect(auth.message).toMatchObject({
      action: 'withdraw',
      network: 'undeployed',
      account: `0x${ACCOUNT}`,
      payloadHash: payloadHash(payload), // the WHOLE body, encryption key included
    });
    expect(auth.message.owner).toBe(signing.deviceKey);
    expect(testScheme.verify(auth.message, unhex(auth.signature))).toBe(true);
  });

  // AA 00047 P9.S, audit C7, questions Q28 A: the change comes from the signed coin and amount, never
  // from the relay's word.
  it('keeps the change it COMPUTES when the relay reports another one, and says so', async () => {
    const { relay, e } = await fundedAccount();
    await syncAccount(e, ACCOUNT);
    relay.results.withdraw = {
      txId: 'wd4',
      change: { nonce: '09'.repeat(32), color: COLOUR, value: '10000000' }, // a fabricated nonce
      changeEntitlement: `ae1.${ACCOUNT}.${'0e'.repeat(32)}.99999999999.${'ac'.repeat(32)}`,
    };
    const out = await withdrawToWallet(e, ACCOUNT, { color: COLOUR, amount: 30_000_000n, recipient: '44'.repeat(32) });
    expect(out.changeMismatch).toBe(true);
    const expected = predictWithdrawChange({ nonce: '02'.repeat(32), color: COLOUR, value: '40000000' }, 30_000_000n)!;
    expect(out.change).toMatchObject(expected);
    expect(readCoins(e.store, e.scope, ACCOUNT).some((c) => c.nonce === '09'.repeat(32))).toBe(false);
    // A relay that reports change where there is none is a mismatch too (the whole coin was paid).
    relay.results.withdraw = { txId: 'wd5', change: { nonce: '0a'.repeat(32), color: COLOUR, value: '1' } };
    const whole = await withdrawToWallet(e, ACCOUNT, {
      color: COLOUR,
      amount: 60_000_000n,
      recipient: '44'.repeat(32),
    });
    expect(whole).toMatchObject({ change: null, changeMismatch: true });
  });

  it('reads the nonce, the device counter and the inbox from the CHAIN, never the relay (Q26)', async () => {
    const { relay, e } = await fundedAccount();
    const chain = e.chain as FakeChain;
    // The relay's own account reads throw (FakeRelay above): the walk and the call still work.
    await syncAccount(e, ACCOUNT);
    expect(chain.reads).toEqual([`state:${ACCOUNT}`, `txs:${ACCOUNT}`]);
    relay.results['withdraw-unshielded'] = { txId: 'wu9' };
    await withdrawUnshieldedToWallet(e, ACCOUNT, {
      color: COLOUR,
      amount: 1n,
      recipient: formatUnshieldedAddress('66'.repeat(32), 'undeployed'),
    });
    // The signed call binds the CHAIN's nonce (7) and the counter found among the CHAIN's devices (1).
    const sub = relay.submitted[0]!;
    expect(sub.request.payload).toMatchObject({ authNonce: '7' });
    expect(sub.request.passportAuth).toMatchObject({ useCounter: '1' });
    // Every check names this wallet and this browser's key.
    const secret = readSecret(e.store, e.scope, ACCOUNT)!;
    expect(chain.expectations.every((x) => x.encPublicKey === secret.encPublicKey && !x.fresh)).toBe(true);
  });

  it('drops coin facts the relay reports but the indexer does not carry (Q31)', async () => {
    const { e } = await fundedAccount();
    const chain = e.chain as FakeChain;
    // The indexer shows only the first output's transaction: the second coin's position is unsupported.
    chain.txs = [
      {
        hash: 'd1',
        blockHeight: 1,
        events: [
          {
            id: 1,
            raw: `00${ACCOUNT}${contractCoinCommitment({ nonce: '01'.repeat(32), color: COLOUR, value: '60000000' }, ACCOUNT)}`,
          },
        ],
      },
    ];
    const r = await syncAccount(e, ACCOUNT);
    expect(r.unsupported).toBe(1);
    expect(readCoins(e.store, e.scope, ACCOUNT).map((c) => [c.value, c.mtIndex])).toEqual([
      ['60000000', '100'],
      ['40000000', null], // not positioned: not spendable until an honest report positions it
    ]);
  });

  it('refuses an amount no single coin covers before asking the wallet', async () => {
    const { e, calls } = await fundedAccount();
    await syncAccount(e, ACCOUNT);
    await expect(
      withdrawToWallet(e, ACCOUNT, { color: COLOUR, amount: 70_000_000n, recipient: '44'.repeat(32) }),
    ).rejects.toThrow(/largest single payment is 60000000/);
    expect(calls).toEqual([]);
  });

  it('withdraws from the unshielded balance to an mn_addr wallet with ONE signature (AA 00047)', async () => {
    const { signing, relay, e, calls } = await fundedAccount();
    relay.results['withdraw-unshielded'] = { txId: 'wu1' };
    const user = '66'.repeat(32);
    const r = await withdrawUnshieldedToWallet(e, ACCOUNT, {
      color: COLOUR,
      amount: 2_500_000n,
      recipient: formatUnshieldedAddress(user, 'undeployed'),
      balance: 10_000_000n,
    });
    expect(r.txId).toBe('wu1');
    expect(calls).toEqual(['authorise:withdrawUnshielded']);
    const sub = relay.submitted[0]!;
    expect(sub.action).toBe('withdraw-unshielded');
    expect(sub.request.payload).toEqual({ recipient: user, color: COLOUR, amount: '2500000', authNonce: '7' });
    expect(sub.request.auth).toBeUndefined();
    expect(sub.request.passportAuth).toMatchObject({ owner: signing.deviceKey, useCounter: '1' });
    expect(readRoster(e.store, e.scope, ACCOUNT)).toEqual({ useCounter: '2' });
  });

  it('refuses an unshielded withdrawal to a bad address, another network, or above the balance, before the wallet', async () => {
    const { e, calls } = await fundedAccount();
    const user = '66'.repeat(32);
    await expect(
      withdrawUnshieldedToWallet(e, ACCOUNT, { color: COLOUR, amount: 1n, recipient: 'mn_addr_nonsense' }),
    ).rejects.toThrow(/not a Midnight address/);
    await expect(
      withdrawUnshieldedToWallet(e, ACCOUNT, {
        color: COLOUR,
        amount: 1n,
        recipient: formatUnshieldedAddress(user, 'stagenet'),
      }),
    ).rejects.toThrow(/for the stagenet network, not undeployed/);
    await expect(
      withdrawUnshieldedToWallet(e, ACCOUNT, {
        color: COLOUR,
        amount: 11n,
        recipient: formatUnshieldedAddress(user, 'undeployed'),
        balance: 10n,
      }),
    ).rejects.toThrow(/does not hold that much/);
    await expect(
      withdrawUnshieldedToWallet(e, ACCOUNT, {
        color: COLOUR,
        amount: 1n,
        recipient: formatShieldedAddress(
          { coinPublicKey: '44'.repeat(32), encryptionPublicKey: '55'.repeat(32) },
          'undeployed',
        ),
      }),
    ).rejects.toThrow(/not an unshielded wallet address/);
    expect(calls).toEqual([]);
  });

  it('claims demo tokens with ONE envelope signature for the account, then walks the inbox (AA 00047)', async () => {
    const { signing, relay, e, calls } = await fundedAccount();
    expect(readCoins(e.store, e.scope, ACCOUNT)).toEqual([]);
    relay.results['demo-tokens'] = { account: ACCOUNT, path: 'direct', minted: [] };
    await claimDemoTokens(e, ACCOUNT);
    expect(calls).toEqual(['relayAction']);
    const sub = relay.submitted[0]!;
    expect(sub.action).toBe('demo-tokens');
    expect(sub.request).toMatchObject({ account: ACCOUNT, payload: {} });
    const auth = sub.request.auth as SignedRelayAction;
    expect(auth.message).toMatchObject({
      action: 'demo-tokens',
      network: 'undeployed',
      account: `0x${ACCOUNT}`,
      owner: signing.deviceKey,
      payloadHash: payloadHash({}),
    });
    expect(testScheme.verify(auth.message, unhex(auth.signature))).toBe(true);
    // The deposit's inbox entries were read after the job (nothing was synced before the claim).
    expect(readCoins(e.store, e.scope, ACCOUNT).filter((c) => !c.spent).length).toBeGreaterThan(0);
    // A failed claim says why, in the relay's words.
    relay.failNext = 'this key has already claimed';
    await expect(claimDemoTokens(e, ACCOUNT)).rejects.toThrow('This key has already claimed.');
  });

  it('says whether this wallet may claim, and what the pack is', () => {
    const base = {
      enabled: true,
      pack: [
        { symbol: 'twUSDC', colour: '11'.repeat(32), decimals: 6, amount: '1000000000' },
        { symbol: 'twBTC', colour: '22'.repeat(32), decimals: 8, amount: '10000000' },
        { symbol: 'twETH', colour: '33'.repeat(32), decimals: 18, amount: '1000000000000000000' },
      ],
      perKey: 1,
      dailyCap: 50,
      remainingToday: 12,
    };
    expect(packText(base.pack)).toBe('1,000.00 twUSDC · 0.10 twBTC · 1.00 twETH');
    expect(claimState(base)).toEqual({ ok: true });
    expect(claimState(null)).toMatchObject({ ok: false, code: 'unavailable' });
    expect(claimState({ ...base, enabled: false })).toMatchObject({ ok: false, code: 'disabled' });
    expect(claimState({ ...base, claimed: true })).toMatchObject({ ok: false, code: 'claimed' });
    expect(claimState({ ...base, remainingToday: 0 })).toMatchObject({ ok: false, code: 'cap' });
  });

  it("re-files the change in the inbox, sealed to the account's key, with ONE signature (Q13)", async () => {
    const { relay, e, calls, sk } = await fundedAccount();
    await syncAccount(e, ACCOUNT); // the 40 coin the change was paid from is known here
    relay.results['append-inbox'] = { txId: 'ai1' };
    const paidFrom = { nonce: '02'.repeat(32), color: COLOUR, value: '40000000' };
    const change = predictWithdrawChange(paidFrom, 30_000_000n)!;
    const { localCoin } = await import('@nightmarket/core');
    const appendEntitlement = `ae1.${ACCOUNT}.${'0e'.repeat(32)}.99999999999.${'ac'.repeat(32)}`;
    const changeOf = { spent: contractCoinCommitment(paidFrom, ACCOUNT), amount: '30000000' };
    const r = await secureChange(e, ACCOUNT, { ...localCoin(change, ACCOUNT), appendEntitlement, changeOf });
    expect(r.txId).toBe('ai1');
    expect(calls).toEqual(['authorise:appendInbox']);
    const payload = relay.submitted[0]!.request.payload as { entry: string; entitlement?: string };
    expect(payload.entitlement).toBe(appendEntitlement); // security review F-B3
    const opened = await openEntryPortable(sk, hexToBytes(payload.entry, 192));
    expect(
      opened && { nonce: bytesToHex(opened.nonce), color: bytesToHex(opened.color), value: opened.value.toString() },
    ).toEqual(change);
    expect(recordKey(e.scope, 'job', { account: ACCOUNT, id: '1'.padStart(32, '0') })).toBeTruthy();
  });

  // AA 00047 P9.S, questions Q28 A: an entry is sealed only for the coin the withdrawal creates.
  it('refuses to seal a coin that is not the recomputed change, before asking the wallet', async () => {
    const { relay, e, calls } = await fundedAccount();
    await syncAccount(e, ACCOUNT);
    const { localCoin } = await import('@nightmarket/core');
    const paidFrom = { nonce: '02'.repeat(32), color: COLOUR, value: '40000000' };
    const appendEntitlement = `ae1.${ACCOUNT}.${'0e'.repeat(32)}.99999999999.${'ac'.repeat(32)}`;
    const changeOf = { spent: contractCoinCommitment(paidFrom, ACCOUNT), amount: '30000000' };
    const right = predictWithdrawChange(paidFrom, 30_000_000n)!;
    for (const wrong of [
      { ...right, nonce: '09'.repeat(32) }, // another nonce (a relay's fabrication)
      { ...right, value: '10000001' }, // another value
    ]) {
      await expect(
        secureChange(e, ACCOUNT, { ...localCoin(wrong, ACCOUNT), appendEntitlement, changeOf }),
      ).rejects.toThrow(/not the change its withdrawal creates/);
    }
    // A coin with no record of what it is the change of cannot be checked, so it is refused too.
    await expect(secureChange(e, ACCOUNT, { ...localCoin(right, ACCOUNT), appendEntitlement })).rejects.toThrow(
      /not the change its withdrawal creates/,
    );
    expect(calls).toEqual([]);
    expect(relay.submitted).toEqual([]);
  });

  it('says a coin the market gave no entitlement for cannot be secured, before asking the wallet (F-B3)', async () => {
    const { relay, e, calls } = await fundedAccount();
    const { localCoin } = await import('@nightmarket/core');
    const coin = localCoin({ nonce: '09'.repeat(32), color: COLOUR, value: '10000000' }, ACCOUNT);
    await expect(secureChange(e, ACCOUNT, coin)).rejects.toThrow(/no record of this coin as change/);
    expect(calls).toEqual([]);
    expect(relay.submitted).toEqual([]);
  });

  // Security review F-B8: the coin list only grows (spent coins are kept), and Import refused a
  // list of more than 5,000, so a long-used account's own export could not be restored.
  it('restores an export with more than 5,000 coins, and its unsecured coins survive Import and the next walk (F-B8)', async () => {
    const { e } = await fundedAccount();
    await syncAccount(e, ACCOUNT); // the two inbox coins, positioned
    const { localCoin } = await import('@nightmarket/core');
    const hex = (n: number, width = 64) => n.toString(16).padStart(width, '0');
    // A long history: 5,100 spent coins the account's inbox described (kept for the record).
    const history = Array.from({ length: 5_100 }, (_, i) => ({
      ...localCoin({ nonce: hex(0x10_0000 + i), color: COLOUR, value: String(1_000 + i) }, ACCOUNT, 'inbox', `tx${i}`),
      mtIndex: String(1_000 + i),
      inInbox: true,
      inboxIndex: String(3 + i),
      spent: true,
      spentTx: `sp${i}`,
    }));
    // Change coins only this browser knows (not yet in the inbox), each with the market's
    // entitlement to file it: one positioned (spendable), one whose leaf is not reported yet.
    const unsecured = [0, 1].map((i) => ({
      ...localCoin(
        { nonce: hex(0xc0_0000 + i), color: COLOUR, value: String(7_000_000 + i) },
        ACCOUNT,
        'change',
        `wd${i}`,
      ),
      ...(i === 0 ? { mtIndex: '400' } : {}),
      appendEntitlement: `ae1.${ACCOUNT}.${hex(0xe0 + i)}.99999999999.${'ac'.repeat(32)}`,
    }));
    e.store.put(e.scope, 'coins', [...readCoins(e.store, e.scope, ACCOUNT), ...unsecured, ...history], {
      account: ACCOUNT,
    });
    const before = readCoins(e.store, e.scope, ACCOUNT);
    expect(before).toHaveLength(5_104);

    // Export as the page downloads it, CLEAR ALL, then Import through the page's own function.
    const text = exportFileText(e.store.exportWallet(e.scope));
    expect(new TextEncoder().encode(text).length).toBeLessThan(MAX_IMPORT_READ_BYTES);
    e.store.clearAll();
    const r = await importFile(e.store, e.chain, JSON.parse(text), e.scope);
    expect(r.imported).toBeGreaterThanOrEqual(3); // secret, roster, coins
    expect(readCoins(e.store, e.scope, ACCOUNT)).toEqual(before);
    expect(unsecuredCoins(readCoins(e.store, e.scope, ACCOUNT))).toEqual(unsecured);

    // The next inbox walk (the chain knows nothing of the unsecured coins) keeps every coin.
    await syncAccount(e, ACCOUNT);
    const after = readCoins(e.store, e.scope, ACCOUNT);
    expect(after).toHaveLength(5_104);
    const kept = unsecuredCoins(after);
    expect(kept.map((c) => c.nonce).sort()).toEqual(unsecured.map((c) => c.nonce).sort());
    for (const c of unsecured) expect(kept.find((k) => k.nonce === c.nonce)).toEqual(c);
  });
});
