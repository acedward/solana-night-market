// AA 00047 P11, audit round 3 R3-7 (F-B3-6): a taker's own spent coin was proven (a spent coin still
// has a valid membership path) and its settlement refusal read as the counterparty's (`exchange-error`,
// `take-refused`), so the failure budget never charged it and the take could be repeated for free.
// Now (../src/chain/coin-spend.ts, ../src/trade/executors.ts):
//   - the coin a make, a take or a shielded withdrawal spends is checked unspent BEFORE any proof
//     (`coin-spent`, nothing proven, the signature given back);
//   - a refused take is attributed: the taker's coin spent meanwhile (`coin-spent`) or its account's
//     nonce moved (`stale-authorisation`) are the taker's and charged; otherwise the maker's or the
//     exchange's, not charged, but bounded per account (`takes-unsettled-cap`).

import { describe, expect, it, vi } from 'vitest';

import { contractCoinNullifier, encodeOffer, type OpenSwapPayload, type TakePayload } from '@nightmarket/core';

import { accountOffer, walletOffer, type FakeTx } from '../../test/gates/take/fake-tx.js';
import { FailureBudget } from '../src/actions/failure-budget.js';
import { withdrawExecutor } from '../src/actions/account-actions.js';
import { guarded } from '../src/app.js';
import { DigestReplayGuard } from '../src/auth/verifiers.js';
import { coinSpent, type SpendReader } from '../src/chain/coin-spend.js';
import type { PassportRuntime } from '../src/passport/runtime.js';
import { PublicError, type JobContext } from '../src/queue/jobs.js';
import type { SponsorSession } from '../src/sponsor/session.js';
import type { ProvenAccountOffer } from '../src/trade/account-offer.js';
import { attributeSettlementRefusal, openSwapExecutor, takeExecutor, type TradeDeps } from '../src/trade/executors.js';
import { describeTx } from '../src/trade/tx-structure.js';
import { callSigner, fakeAccountRuntime, testArm } from './fake-arm.js';
import { silentLog } from './harness.js';
import { ATTACKER, ATTACKER_ACCOUNT, laneRelay } from './lane-relay.js';

const ACCOUNT = '5e'.repeat(32);
const BASE = 'a1'.repeat(32);
const QUOTE = 'b2'.repeat(32);
const OFFER_ID = 'cd'.repeat(32);

function costly(tx: FakeTx): FakeTx {
  return Object.assign(tx, {
    cost: () => ({ readTime: 1n, computeTime: 2n, blockUsage: 3n }),
    fees: () => 42n,
    serialize: () => new Uint8Array([1, 2, 3]),
    merge(other: FakeTx) {
      return costly(Object.getPrototypeOf(tx).merge.call(tx, other) as FakeTx);
    },
  });
}

type Signer = ReturnType<typeof callSigner>;

/** The account `signer` controls; its auth nonce can be moved by the test (another approval landed). */
function fakeRuntime(signer: Signer, nonce: { value: bigint } = { value: 2n }): PassportRuntime {
  const base = fakeAccountRuntime(ACCOUNT, [signer.deviceKey], nonce.value);
  return Object.assign(base, {
    ledgerState: async (a: string) => {
      const l = (await fakeAccountRuntime(ACCOUNT, [signer.deviceKey], nonce.value).ledgerState(a)) as unknown;
      return l;
    },
    providers: async () => ({}),
    compiledAccount: () => ({}),
  }) as unknown as PassportRuntime;
}

const sponsor = {
  withWallet: async <T>(fn: (w: unknown) => Promise<T>) =>
    fn({ unshieldedKeystore: { getBech32Address: () => ({ asString: () => 'mn_addr_stagenet1bank' }) } }),
  status: () => ({ configured: true, state: 'synced', synced: true, dustSpecks: 10n ** 18n }),
  start: async () => {},
  stop: async () => {},
} as unknown as SponsorSession;

function ctx(): JobContext & { stages: string[]; proofs: number } {
  const stages: string[] = [];
  const c = {
    requestId: '00'.repeat(16),
    log: silentLog(),
    stage: (s: string) => stages.push(s),
    proofs: 0,
    prove: <T>(fn: () => Promise<T>) => {
      c.proofs++;
      return fn();
    },
    stages,
  };
  return c;
}

const make: OpenSwapPayload = {
  giveColor: BASE,
  giveAmount: '2000000',
  wantColor: QUOTE,
  wantAmount: '2100000',
  wantNonce: '11'.repeat(32),
  wantEntry: '22'.repeat(192),
  changeEntry: '00'.repeat(192),
  validUntil: String(Math.floor(Date.now() / 1000) + 600),
  coin: { nonce: '33'.repeat(32), color: BASE, value: '3000000', mtIndex: '9' },
  authNonce: '2',
};
const take: TakePayload = {
  ...make,
  giveColor: QUOTE,
  giveAmount: '2100000',
  wantColor: BASE,
  wantAmount: '2000000',
  coin: { nonce: '44'.repeat(32), color: QUOTE, value: '4000000', mtIndex: '12' },
  offerId: OFFER_ID,
};

/** A reader of the account's spent coins; `spent` can change between reads. */
function reader(spent: Set<string> = new Set()) {
  const r = {
    reads: 0,
    spent,
    spentNullifiers: async (account: string) => {
      r.reads++;
      return account === ACCOUNT ? r.spent : null;
    },
  };
  return r;
}
const nf = (c: { nonce: string; color: string; value: string }) => contractCoinNullifier(c, ACCOUNT);

function proven(tx: FakeTx): ProvenAccountOffer {
  return {
    tx: tx as never,
    bytes: new Uint8Array(30),
    blob: 'swapoffer1fake',
    offerId: 'ef'.repeat(32),
    proveMs: 1,
    structure: describeTx(tx),
    steering: { fromPs: '15000000000', toPs: '1099511627775' },
    expiresAt: 1_800_000_000_000,
  };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function takeRun(o: {
  coins?: SpendReader;
  batcher?: () => Response;
  nonce?: { value: bigint };
  onBatcher?: () => void;
}) {
  const w = callSigner();
  const makerTx = costly(walletOffer(BASE, 2_000_000n, QUOTE, 2_100_000n));
  const takerTx = costly(accountOffer(62921, 0, QUOTE, 2_100_000n, BASE, 2_000_000n));
  const batcher = vi.fn(o.batcher ?? (() => json(200, { success: true, transactionHash: 'aa'.repeat(32) })));
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.startsWith('http://batcher.test')) {
      o.onBatcher?.();
      return batcher();
    }
    void init;
    return u.endsWith(`/v1/offers/${OFFER_ID}`)
      ? json(200, {
          offerId: OFFER_ID,
          offerBech32: encodeOffer(new Uint8Array([9, 9, 9])),
          computed: { gives: [], wants: [], status: 'live' },
        })
      : json(404, {});
  }) as unknown as typeof fetch;
  const prove = vi.fn(async () => proven(takerTx));
  const replay = new DigestReplayGuard(3600);
  const release = vi.spyOn(replay, 'release');
  const nonce = o.nonce ?? { value: 2n };
  const deps: TradeDeps = {
    runtime: () => fakeRuntime(w, nonce),
    arm: testArm,
    sponsor,
    kernelUrl: 'http://kernel.test',
    batcherUrl: 'http://batcher.test',
    batcherTarget: 'midnight-balancer',
    replay,
    log: silentLog(),
    fetchImpl: f,
    prove,
    deserialize: async () => makerTx,
    ledgerParameters: async () => ({ params: true }),
    timings: { publishRetryMs: 1, statusPollMs: 1, statusTimeoutMs: 50 },
    ...(o.coins ? { coins: o.coins } : {}),
  };
  const c = ctx();
  const payload = { ...take, account: ACCOUNT, passportAuth: w.passportAuth('take', ACCOUNT, take as never) };
  return { deps, exec: takeExecutor(deps), payload, c, prove, batcher, release, signer: w };
}

describe('coinSpent: the nullifier of the coin against the account’s spent coins', () => {
  it('is spent only when the account’s history shows the coin’s own nullifier', async () => {
    const coin = { nonce: '01'.repeat(32), color: BASE, value: '5' };
    expect(await coinSpent(reader(), ACCOUNT, coin)).toBe(false);
    expect(await coinSpent(reader(new Set([nf(coin)])), ACCOUNT, coin)).toBe(true);
    // Another coin's nullifier, or the same coin of another account, is not this coin.
    expect(await coinSpent(reader(new Set([nf({ ...coin, value: '6' })])), ACCOUNT, coin)).toBe(false);
    expect(await coinSpent(reader(new Set([contractCoinNullifier(coin, 'ff'.repeat(32))])), ACCOUNT, coin)).toBe(false);
    // No such account: nothing known spent.
    expect(await coinSpent(reader(), 'ab'.repeat(32), coin)).toBe(false);
  });
});

describe('take: the taker’s coin is checked unspent BEFORE any proof (F-B3-6)', () => {
  it('a taker’s spent coin is refused with coin-spent: nothing proven, nothing sent to the batcher, the signature given back', async () => {
    const r = takeRun({ coins: reader(new Set([nf(take.coin)])) });
    await expect(r.exec(r.payload, r.c)).rejects.toMatchObject({ code: 'coin-spent' });
    expect(r.prove).not.toHaveBeenCalled();
    expect(r.batcher).not.toHaveBeenCalled();
    expect(r.release).toHaveBeenCalled();
    expect(r.c.proofs).toBe(0);
  });

  it('an unspent coin is proven and settled as before', async () => {
    const coins = reader();
    const r = takeRun({ coins });
    await expect(r.exec(r.payload, r.c)).resolves.toMatchObject({ txHash: 'aa'.repeat(32) });
    expect(coins.reads).toBe(1);
  });

  it('a chain that cannot be read stops the take before proving, as the market’s failure (never charged)', async () => {
    const r = takeRun({
      coins: {
        spentNullifiers: async () => {
          throw new Error('indexer: 502');
        },
      },
    });
    await expect(r.exec(r.payload, r.c)).rejects.toMatchObject({ code: 'chain-unavailable' });
    expect(r.prove).not.toHaveBeenCalled();
  });

  it('through the route’s guard: a pre-proof coin-spent is not charged to the failure budget', async () => {
    const r = takeRun({ coins: reader(new Set([nf(take.coin)])) });
    const failures = new FailureBudget({ perOwner: 5, perAccount: 5 });
    const owner = r.signer.deviceKey;
    for (let i = 0; i < 6; i++) {
      await expect(
        guarded(r.exec, { action: 'take', owner, account: ACCOUNT, failures })(r.payload, r.c),
      ).rejects.toMatchObject({ code: 'coin-spent' });
    }
    expect(failures.failures(owner)).toBe(0);
    expect(r.prove).not.toHaveBeenCalled();
  });
});

describe('take: a settlement refusal is attributed to the right party (F-B3-6)', () => {
  it('the taker’s coin spent by the time the batcher refused → coin-spent, charged to the taker', async () => {
    const coins = reader();
    const r = takeRun({
      coins,
      batcher: () => json(500, { success: false, error: 'internal' }),
      onBatcher: () => coins.spent.add(nf(take.coin)), // spent meanwhile (e.g. its own offer was taken)
    });
    const failures = new FailureBudget({ perOwner: 5, perAccount: 5 });
    const owner = r.signer.deviceKey;
    await expect(
      guarded(r.exec, { action: 'take', owner, account: ACCOUNT, failures })(r.payload, r.c),
    ).rejects.toMatchObject({ code: 'coin-spent' });
    expect(r.prove).toHaveBeenCalledOnce();
    expect(failures.failures(owner)).toBe(1);
  });

  it('the taker’s account moved past the signed nonce → stale-authorisation, charged to the taker', async () => {
    const nonce = { value: 2n };
    const r = takeRun({
      coins: reader(),
      nonce,
      batcher: () => json(400, { success: false, error: 'Custom error: 138' }),
      onBatcher: () => (nonce.value = 3n),
    });
    const failures = new FailureBudget({ perOwner: 5, perAccount: 5 });
    const owner = r.signer.deviceKey;
    await expect(
      guarded(r.exec, { action: 'take', owner, account: ACCOUNT, failures })(r.payload, r.c),
    ).rejects.toMatchObject({ code: 'stale-authorisation' });
    expect(failures.failures(owner)).toBe(1);
  });

  it('otherwise the refusal stays the maker’s or the exchange’s: exchange-error / take-refused, never charged', async () => {
    for (const [status, code] of [
      [500, 'exchange-error'],
      [400, 'take-refused'],
      [429, 'exchange-busy'],
    ] as const) {
      const r = takeRun({ coins: reader(), batcher: () => json(status, { success: false, error: 'x' }) });
      const failures = new FailureBudget({ perOwner: 5, perAccount: 5 });
      const owner = r.signer.deviceKey;
      await expect(
        guarded(r.exec, { action: 'take', owner, account: ACCOUNT, failures })(r.payload, r.c),
      ).rejects.toMatchObject({ code });
      expect(failures.failures(owner)).toBe(0);
    }
  });

  it('a chain read that fails during attribution leaves the counterparty’s code (never charged on a guess)', async () => {
    let reads = 0;
    const err = await attributeSettlementRefusal(
      {
        log: silentLog(),
        coins: {
          spentNullifiers: async () => {
            reads++;
            throw new Error('down');
          },
        },
      },
      { ledgerState: async () => null } as never,
      ACCOUNT,
      { coin: take.coin, authNonce: '2' },
      500,
      undefined,
    );
    expect(err).toBeInstanceOf(PublicError);
    expect(err.code).toBe('exchange-error');
    expect(reads).toBe(1);
  });
});

describe('make and shielded withdrawal: the coin is checked unspent BEFORE any proof', () => {
  it('a make paid from a spent coin is refused with coin-spent (it could never settle)', async () => {
    const w = callSigner();
    const prove = vi.fn();
    const replay = new DigestReplayGuard(3600);
    const exec = openSwapExecutor({
      runtime: () => fakeRuntime(w),
      arm: testArm,
      sponsor,
      kernelUrl: 'http://kernel.test',
      batcherUrl: 'http://batcher.test',
      replay,
      log: silentLog(),
      prove: prove as never,
      coins: reader(new Set([nf(make.coin)])),
    });
    await expect(
      exec({ ...make, account: ACCOUNT, passportAuth: w.passportAuth('open-swap', ACCOUNT, make as never) }, ctx()),
    ).rejects.toMatchObject({ code: 'coin-spent' });
    expect(prove).not.toHaveBeenCalled();
  });

  it('a shielded withdrawal of a spent coin is refused with coin-spent: no proof, no DUST', async () => {
    const w = callSigner();
    const payload = {
      recipient: 'dd'.repeat(32),
      color: BASE,
      amount: '1',
      coin: { nonce: '55'.repeat(32), color: BASE, value: '9', mtIndex: '3' },
      authNonce: '2',
    };
    const withWallet = vi.fn();
    const replay = new DigestReplayGuard(3600);
    const release = vi.spyOn(replay, 'release');
    const exec = withdrawExecutor({
      runtime: () => fakeRuntime(w),
      arm: testArm,
      sponsor: { withWallet } as never,
      network: 'stagenet',
      replay,
      entitlements: {} as never,
      log: silentLog(),
      coins: reader(new Set([nf(payload.coin)])),
    });
    const c = ctx();
    await expect(
      exec({ ...payload, account: ACCOUNT, passportAuth: w.passportAuth('withdraw', ACCOUNT, payload) }, c),
    ).rejects.toMatchObject({ code: 'coin-spent' });
    expect(c.proofs).toBe(0);
    expect(withWallet).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalled();
  });
});

describe('takes refused for the maker’s or the exchange’s reason are bounded per account (takes-unsettled-cap)', () => {
  it('past TAKES_UNSETTLED_PER_ACCOUNT_PER_DAY such takes, the account’s takes wait; its other actions do not', async () => {
    const r = laneRelay({
      proofMs: 1,
      listingMs: 1,
      withdrawMs: 1,
      caps: true,
      failures: true,
      env: { TAKES_UNSETTLED_PER_ACCOUNT_PER_DAY: '3' },
      executors: {
        take: async (_p, ctx) =>
          ctx.prove(async () => {
            throw new PublicError('exchange-error', 'the batcher answered 500');
          }),
      },
    });
    const statuses: Array<number | string> = [];
    for (let i = 0; i < 5; i++) {
      const s = await r.post('take', ATTACKER_ACCOUNT, r.take(i), ATTACKER);
      statuses.push(s.code ?? s.status);
      await r.settle(s.id);
    }
    expect(statuses).toEqual([202, 202, 202, 'takes-unsettled-cap', 'takes-unsettled-cap']);
    expect(r.failures!.failures(ATTACKER)).toBe(0); // never charged to the failure budget
    expect(r.caps!.usedToday(ATTACKER_ACCOUNT, 'unsettled')).toBe(3);
    // A make still goes through.
    expect((await r.post('open-swap', ATTACKER_ACCOUNT, r.make(9), ATTACKER)).status).toBe(202);
  });

  it('a take that failed for the taker’s own reason, or for the market’s, is not an unsettled take', async () => {
    let n = 0;
    const r = laneRelay({
      proofMs: 1,
      listingMs: 1,
      withdrawMs: 1,
      caps: true,
      env: { TAKES_UNSETTLED_PER_ACCOUNT_PER_DAY: '1' },
      executors: {
        take: async (_p, ctx) =>
          ctx.prove(async () => {
            n++;
            throw n % 2 === 1
              ? new PublicError('coin-spent', 'the coin was spent')
              : new PublicError('exchange-unavailable', 'the exchange could not be reached');
          }),
      },
    });
    for (let i = 0; i < 4; i++) {
      const s = await r.post('take', ATTACKER_ACCOUNT, r.take(i), ATTACKER);
      expect(s.status).toBe(202);
      await r.settle(s.id);
    }
    expect(r.caps!.usedToday(ATTACKER_ACCOUNT, 'unsettled')).toBe(0);
  });
});
