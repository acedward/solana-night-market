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

import {
  contractCoinCommitment,
  contractCoinNullifier,
  encodeOffer,
  type OpenSwapPayload,
  type TakePayload,
} from '@nightmarket/core';

import { accountOffer, walletOffer, type FakeTx } from '../../test/gates/take/fake-tx.js';
import { AccountCaps } from '../src/actions/account-caps.js';
import { defaultCatalogue, withTrade } from '../src/actions/catalogue.js';
import { FailureBudget, countsAgainstBudget, isCounterpartyCode } from '../src/actions/failure-budget.js';
import { withdrawExecutor } from '../src/actions/account-actions.js';
import { guarded } from '../src/app.js';
import { DigestReplayGuard } from '../src/auth/verifiers.js';
import { coinSpent, type SpendReader } from '../src/chain/coin-spend.js';
import type { AccountTxView } from '../src/chain/indexer.js';
import type { PassportRuntime } from '../src/passport/runtime.js';
import { PublicError, type JobContext } from '../src/queue/jobs.js';
import type { SponsorSession } from '../src/sponsor/session.js';
import type { ProvenAccountOffer } from '../src/trade/account-offer.js';
import {
  BatcherCooldown,
  attributeSettlementRefusal,
  cooldownAdmission,
  openSwapExecutor,
  takeExecutor,
  type TradeDeps,
} from '../src/trade/executors.js';
import { describeTx } from '../src/trade/tx-structure.js';
import { callSigner, fakeAccountRuntime, testArm } from './fake-arm.js';
import { silentLog, testConfig } from './harness.js';
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

// AA 00047 P11.F, audit round 4 R4-2 (F-B4-2, F-A4-3): round 3 charged the taker for ANY spent coin or
// moved nonce after a refusal, so an honest taker was charged when its take had landed after all, or
// when its own offer was taken at the same moment. Now the refusal is judged by the transaction.
/** A reader of the account's decoded history (entry points, leaves, spends); `txs` and `tip` can change
 *  between reads. */
function historyReader(txs: AccountTxView[] = [], tip = 100) {
  const r = {
    reads: 0,
    txs,
    tip,
    spentNullifiers: async (account: string) =>
      account === ACCOUNT ? new Set(r.txs.flatMap((t) => [...t.inputs])) : null,
    accountTxs: async (account: string) => {
      r.reads++;
      return account === ACCOUNT ? { txs: [...r.txs], tip: r.tip } : null;
    },
  };
  return r;
}
const SWAP = 'open_swap_shielded_with_ed25519';
const wantedLeaf = contractCoinCommitment(
  { nonce: take.wantNonce, color: take.wantColor, value: take.wantAmount },
  ACCOUNT,
);
const tx = (o: Partial<AccountTxView> & { hash: string }): AccountTxView => ({
  blockHeight: 101,
  entryPoints: [],
  outputs: [],
  inputs: [],
  ...o,
});

describe('take: a settlement refusal is reconciled against the chain before anyone is blamed (R4-2)', () => {
  async function run(o: Parameters<typeof takeRun>[0]) {
    const r = takeRun(o);
    const failures = new FailureBudget({ perOwner: 5, perAccount: 5 });
    const owner = r.signer.deviceKey;
    const ends: Array<{ code?: string; requesterFault: boolean }> = [];
    const out = await guarded(r.exec, {
      action: 'take',
      owner,
      account: ACCOUNT,
      failures,
      finished: (e) => ends.push({ requesterFault: e.requesterFault, ...(e.code ? { code: e.code } : {}) }),
    })(r.payload, r.c).then(
      (v) => ({ ok: true as const, v }),
      (e: unknown) => ({ ok: false as const, code: (e as PublicError).code }),
    );
    return { r, out, charged: failures.failures(owner), ends };
  }

  it('the take landed although the batcher failed: the job SUCCEEDS with its settlement, nothing charged', async () => {
    const coins = historyReader();
    const { r, out, charged } = await run({
      coins,
      batcher: () => json(500, { success: false, error: 'internal' }),
      onBatcher: () => {
        coins.txs.push(
          tx({ hash: 'ab'.repeat(32), entryPoints: [SWAP], outputs: [wantedLeaf], inputs: [nf(take.coin)] }),
        );
        coins.tip = 101;
      },
    });
    expect(out).toMatchObject({ ok: true, v: { txHash: 'ab'.repeat(32), offerId: OFFER_ID } });
    expect(r.c.stages).toContain('settled');
    expect(charged).toBe(0);
  });

  it('the coin spent by the account’s OWN offer being taken meanwhile: take-raced, not charged (but an unsettled take)', async () => {
    const coins = historyReader();
    const { out, charged, ends } = await run({
      coins,
      batcher: () => json(500, { success: false, error: 'internal' }),
      onBatcher: () =>
        coins.txs.push(
          tx({ hash: 'cc'.repeat(32), entryPoints: [SWAP], outputs: ['99'.repeat(32)], inputs: [nf(take.coin)] }),
        ),
    });
    expect(out).toEqual({ ok: false, code: 'take-raced' });
    expect(charged).toBe(0);
    expect(ends).toEqual([{ code: 'take-raced', requesterFault: false }]);
    expect(isCounterpartyCode('take-raced')).toBe(true); // bounded by takes-unsettled-cap
  });

  it('the coin spent by the account’s own WITHDRAWAL (sent elsewhere): coin-spent, charged to the taker', async () => {
    const coins = historyReader();
    const { out, charged } = await run({
      coins,
      batcher: () => json(500, { success: false, error: 'internal' }),
      onBatcher: () =>
        coins.txs.push(
          tx({ hash: 'dd'.repeat(32), entryPoints: ['withdraw_shielded_with_ed25519'], inputs: [nf(take.coin)] }),
        ),
    });
    expect(out).toEqual({ ok: false, code: 'coin-spent' });
    expect(charged).toBe(1);
  });

  it('the nonce moved by the account’s own offer being taken (another coin): take-raced, not charged', async () => {
    const coins = historyReader();
    const nonce = { value: 2n };
    const { out, charged } = await run({
      coins,
      nonce,
      batcher: () => json(400, { success: false, error: 'Custom error: 138' }),
      onBatcher: () => {
        nonce.value = 3n;
        coins.txs.push(
          tx({ hash: 'ee'.repeat(32), entryPoints: [SWAP], outputs: ['98'.repeat(32)], inputs: ['97'.repeat(32)] }),
        );
      },
    });
    expect(out).toEqual({ ok: false, code: 'take-raced' });
    expect(charged).toBe(0);
  });

  it('the nonce moved by the account’s own cancel or key change: stale-authorisation, charged to the taker', async () => {
    const coins = historyReader();
    const nonce = { value: 2n };
    const { out, charged } = await run({
      coins,
      nonce,
      batcher: () => json(400, { success: false, error: 'Custom error: 138' }),
      onBatcher: () => {
        nonce.value = 3n;
        coins.txs.push(tx({ hash: 'ef'.repeat(32), entryPoints: ['rotate_enc_key_with_ed25519'] }));
      },
    });
    expect(out).toEqual({ ok: false, code: 'stale-authorisation' });
    expect(charged).toBe(1);
  });

  it('UNRESOLVED is never the taker’s: a moved nonce no transaction explains yet, a deposit, or one from before the take', async () => {
    for (const later of [
      [] as AccountTxView[], // the indexer has not shown it yet
      [tx({ hash: 'f1'.repeat(32), entryPoints: ['deposit_shielded'] })], // a deposit does not move the nonce
      [tx({ hash: 'f2'.repeat(32), blockHeight: 100, entryPoints: ['rotate_enc_key_with_ed25519'] })], // before the job's read
    ]) {
      const coins = historyReader();
      const nonce = { value: 2n };
      const { out, charged } = await run({
        coins,
        nonce,
        batcher: () => json(500, { success: false, error: 'internal' }),
        onBatcher: () => {
          nonce.value = 3n;
          coins.txs.push(...later);
        },
      });
      expect(out).toEqual({ ok: false, code: 'exchange-error' });
      expect(charged).toBe(0);
    }
  });

  it('a reader that gives no history cannot name the spending transaction: never charged (round 3 charged coin-spent)', async () => {
    const coins = reader();
    const { out, charged } = await run({
      coins,
      batcher: () => json(500, { success: false, error: 'internal' }),
      onBatcher: () => coins.spent.add(nf(take.coin)),
    });
    expect(out).toEqual({ ok: false, code: 'exchange-error' });
    expect(charged).toBe(0);
  });

  it('a refusal with the coin unspent and the nonce unmoved stays the counterparty’s; a 429 the exchange’s', async () => {
    for (const [status, code] of [
      [500, 'exchange-error'],
      [400, 'take-refused'],
      [429, 'exchange-busy'],
    ] as const) {
      const { out, charged } = await run({
        coins: historyReader(),
        batcher: () => json(status, { success: false, error: 'x' }),
      });
      expect(out).toEqual({ ok: false, code });
      expect(charged).toBe(0);
    }
  });

  it('a chain read that fails while reconciling leaves the counterparty’s code (never charged on a guess)', async () => {
    let reads = 0;
    const err = await attributeSettlementRefusal(
      {
        log: silentLog(),
        coins: {
          spentNullifiers: async () => new Set<string>(),
          accountTxs: async () => {
            reads++;
            throw new Error('down');
          },
        },
      },
      { ledgerState: async () => null } as never,
      ACCOUNT,
      {
        coin: take.coin,
        wantColor: take.wantColor,
        wantAmount: take.wantAmount,
        wantNonce: take.wantNonce,
        authNonce: '2',
      },
      100,
      500,
      undefined,
    );
    expect(err).toBeInstanceOf(PublicError);
    expect((err as PublicError).code).toBe('exchange-error');
    expect(reads).toBe(1);
  });
});

// AA 00047 P11.F2, audit round 4b R4b-1 (F-A4b-1 MAJOR, F-B4b-1): a take that reused an earlier wanted
// coin W was proven, refused by the ledger (the same coin can never be inserted twice), and then judged
// "settled" by the OLD transaction that paid W: the job succeeded, nothing was charged and the
// unsettled-take cap never bound, so one account could spend the exchange's shared 1,000 settlements a
// day and trip the relay-wide 429 pause for everyone. Now such a take is refused BEFORE its proof
// (`want-reused`, charged: no honest page sends one), and a reconcile that does run counts only the take's
// own settlement (a transaction after the job's read that spends its coin and pays its want).
describe('take: a take that reuses a coin the account already received (R4b-1)', () => {
  const otherCoin = { nonce: '66'.repeat(32), color: QUOTE, value: '9' };
  /** An earlier, real fill that paid the account W (the wanted coin the take signs again). */
  const oldFill = (height = 90) =>
    tx({
      hash: 'a0'.repeat(32),
      blockHeight: height,
      entryPoints: [SWAP],
      outputs: [wantedLeaf],
      inputs: [nf(otherCoin)],
    });

  async function guardedRun(o: Parameters<typeof takeRun>[0], failures: FailureBudget, caps?: AccountCaps) {
    const r = takeRun(o);
    const owner = r.signer.deviceKey;
    const admitted = caps?.admitTake(ACCOUNT);
    if (admitted && !admitted.ok) return { r, out: { ok: false as const, code: admitted.code }, owner };
    const out = await guarded(r.exec, {
      action: 'take',
      owner,
      account: ACCOUNT,
      failures,
      ...(admitted?.ok && admitted.finished ? { finished: admitted.finished } : {}),
    })(r.payload, r.c).then(
      (v) => ({ ok: true as const, v }),
      (e: unknown) => ({ ok: false as const, code: (e as PublicError).code }),
    );
    return { r, out, owner };
  }

  it('auditor A’s scenario: refused BEFORE proving (want-reused), nothing sent to the exchange, the approval given back, charged; past the budget the account is refused', async () => {
    const failures = new FailureBudget({ perOwner: 5, perAccount: 5 });
    const codes: string[] = [];
    for (let i = 0; i < 6; i++) {
      const { r, out } = await guardedRun({ coins: historyReader([oldFill(100)], 500) }, failures);
      expect(out.ok).toBe(false);
      codes.push((out as { code: string }).code);
      expect(r.prove).not.toHaveBeenCalled();
      expect(r.batcher).not.toHaveBeenCalled();
      expect(r.c.proofs).toBe(0);
      if (i < 5) expect(r.release).toHaveBeenCalled();
    }
    expect(codes).toEqual([
      'want-reused',
      'want-reused',
      'want-reused',
      'want-reused',
      'want-reused',
      'failure-budget',
    ]);
    expect(failures.check('ff'.repeat(32), ACCOUNT).ok).toBe(false); // the account's budget is spent
    expect(countsAgainstBudget(new PublicError('want-reused', 'x'), false)).toBe(true);
    expect(countsAgainstBudget(new PublicError('coin-spent', 'x'), false)).toBe(false); // the rule stays for the rest
    expect(isCounterpartyCode('want-reused')).toBe(false);
  });

  it('auditor B’s scenario, reached by the reconcile (the indexer showed the old fill only after the job’s read): a batcher 500 is NOT a success, and counts toward the unsettled-take allowance', async () => {
    let now = 1_000_000;
    const caps = new AccountCaps({
      maxOpenOffers: 3,
      makesPerDay: 20,
      cancelsPerDay: 5,
      restoresPerDay: 3,
      unsettledTakesPerDay: 10,
      now: () => now,
    });
    const failures = new FailureBudget({ perOwner: 5, perAccount: 5, now: () => now });
    const outs: Array<string | true> = [];
    for (let i = 0; i < 11; i++) {
      const coins = historyReader([], 100);
      const { out, r } = await guardedRun(
        {
          coins,
          batcher: () => json(500, { success: false, error: 'internal' }),
          // The old matching wanted output, a different input, the nonce unchanged.
          onBatcher: () => coins.txs.push(oldFill(90)),
        },
        failures,
        caps,
      );
      outs.push(out.ok ? true : out.code);
      if (i < 10) expect(r.prove).toHaveBeenCalledOnce();
      now += 60;
    }
    expect(outs).toEqual([...Array.from({ length: 10 }, () => 'exchange-error'), 'takes-unsettled-cap']);
    expect(caps.usedToday(ACCOUNT, 'unsettled')).toBe(10);
  });

  it('an honest take whose settlement response was lost is still a success, by its own transaction', async () => {
    for (const batcher of [
      () => json(500, { success: false, error: 'internal' }),
      () => json(200, { success: true }), // answered without the transaction's hash
    ]) {
      // The account was paid ANOTHER coin before (so this take is not refused before proving).
      const coins = historyReader([tx({ ...oldFill(40), outputs: ['01'.repeat(32)] })], 100);
      const r = takeRun({
        coins,
        batcher,
        onBatcher: () => {
          coins.txs.push(tx({ hash: 'ab'.repeat(32), blockHeight: 102, entryPoints: [SWAP], outputs: [], inputs: [] }));
          coins.txs.push(
            tx({
              hash: 'ac'.repeat(32),
              blockHeight: 103,
              entryPoints: [SWAP],
              outputs: [wantedLeaf],
              inputs: [nf(take.coin)],
            }),
          );
          coins.tip = 104;
        },
      });
      await expect(r.exec(r.payload, r.c)).resolves.toMatchObject({ txHash: 'ac'.repeat(32), offerId: OFFER_ID });
      expect(r.c.stages).toContain('settled');
    }
  });

  it('an honest re-send of a take that landed meets coin-spent first, never want-reused (not charged)', async () => {
    const landed = tx({
      hash: 'ad'.repeat(32),
      blockHeight: 99,
      entryPoints: [SWAP],
      outputs: [wantedLeaf],
      inputs: [nf(take.coin)],
    });
    const failures = new FailureBudget({ perOwner: 5, perAccount: 5 });
    const { r, out, owner } = await guardedRun({ coins: historyReader([landed], 100) }, failures);
    expect(out).toEqual({ ok: false, code: 'coin-spent' });
    expect(r.prove).not.toHaveBeenCalled();
    expect(failures.failures(owner)).toBe(0);
  });

  it('a take with a fresh want proves and settles as before, whatever the account was paid earlier', async () => {
    const fresh = takeRun({ coins: historyReader([tx({ ...oldFill(90), outputs: ['02'.repeat(32)] })], 100) });
    await expect(fresh.exec(fresh.payload, fresh.c)).resolves.toMatchObject({ txHash: 'aa'.repeat(32) });
    expect(fresh.prove).toHaveBeenCalledOnce();
  });
});

// AA 00047 P11.F, audit round 4 R4-3 (F-B4-3): a proved take that met the exchange's 429 was charged to
// nobody and could be repeated; now a 429 starts a cooldown during which no take is proven.
describe('take: after the exchange’s 429, takes pause before proving (R4-3)', () => {
  it('the next take is refused before any proof (exchange-busy, the approval given back) until the cooldown ends', async () => {
    let now = 1_000_000;
    const cooldown = new BatcherCooldown(300, () => now);
    const first = takeRun({ coins: historyReader(), batcher: () => json(429, { success: false, error: 'cap' }) });
    first.deps.cooldown = cooldown;
    await expect(first.exec(first.payload, first.c)).rejects.toMatchObject({ code: 'exchange-busy' });
    expect(first.prove).toHaveBeenCalledOnce();
    expect(cooldown.remaining()).toBe(300);

    const again = takeRun({ coins: historyReader(), batcher: () => json(429, { success: false, error: 'cap' }) });
    again.deps.cooldown = cooldown;
    now += 100;
    await expect(again.exec(again.payload, again.c)).rejects.toMatchObject({ code: 'exchange-busy' });
    expect(again.prove).not.toHaveBeenCalled();
    expect(again.batcher).not.toHaveBeenCalled();
    expect(again.release).toHaveBeenCalled();

    now += 201; // the cooldown is over: takes are proven again
    const later = takeRun({ coins: historyReader() });
    later.deps.cooldown = cooldown;
    await expect(later.exec(later.payload, later.c)).resolves.toMatchObject({ txHash: 'aa'.repeat(32) });
  });

  it('the exchange’s own Retry-After lengthens the pause (up to a day); the route refuses takes meanwhile (503, Retry-After)', async () => {
    let now = 2_000_000;
    const cooldown = new BatcherCooldown(300, () => now);
    const r = takeRun({
      coins: historyReader(),
      batcher: () =>
        new Response(JSON.stringify({ success: false }), { status: 429, headers: { 'retry-after': '900' } }),
    });
    r.deps.cooldown = cooldown;
    await expect(r.exec(r.payload, r.c)).rejects.toMatchObject({ code: 'exchange-busy' });
    expect(cooldown.remaining()).toBe(900);
    const admit = withTrade(defaultCatalogue(), r.deps).get('take')!.admit!;
    const refused = await admit({
      account: ACCOUNT,
      payload: { validUntil: String(Math.floor(Date.now() / 1000) + 600) },
      signer: 'x',
    });
    expect(refused).toMatchObject({ ok: false, status: 503, code: 'exchange-busy', retryAfterSeconds: 900 });
    now += 901;
    expect(await cooldownAdmission(cooldown)({ payload: {}, signer: 'x' })).toEqual({ ok: true });
    expect(testConfig().batcherBusyCooldownSeconds).toBe(300);
    expect(testConfig({ BATCHER_BUSY_COOLDOWN_SECONDS: '60' }).batcherBusyCooldownSeconds).toBe(60);
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

  // AA 00047 P11.F, audit round 4 R4-5 (F-A4-4): an account whose history cannot be read in time (a
  // griefer's deposits) used to have every shielded withdrawal refused (`chain-unavailable`).
  it('a withdrawal whose history cannot be read goes ahead unchecked (the ledger refuses a double spend anyway)', async () => {
    const w = callSigner();
    const payload = {
      recipient: 'dd'.repeat(32),
      color: BASE,
      amount: '1',
      coin: { nonce: '56'.repeat(32), color: BASE, value: '9', mtIndex: '3' },
      authNonce: '2',
    };
    const withWallet = vi.fn(async () => {
      throw new Error('the proof would run here');
    });
    const exec = withdrawExecutor({
      runtime: () => fakeRuntime(w),
      arm: testArm,
      sponsor: { withWallet } as never,
      network: 'stagenet',
      replay: new DigestReplayGuard(3600),
      entitlements: {} as never,
      log: silentLog(),
      coins: {
        spentNullifiers: async () => {
          throw new Error('history stream timed out after 120 s');
        },
      },
    });
    const c = ctx();
    await expect(
      exec({ ...payload, account: ACCOUNT, passportAuth: w.passportAuth('withdraw', ACCOUNT, payload) }, c),
    ).rejects.toThrow('the proof would run here');
    expect(c.proofs).toBe(1);
    expect(withWallet).toHaveBeenCalledOnce();
    expect(c.stages).toContain('spend-check-skipped');
  });

  it('a trade whose history cannot be read is still refused for now (chain-unavailable, tried again later)', async () => {
    const w = callSigner();
    const prove = vi.fn();
    const exec = openSwapExecutor({
      runtime: () => fakeRuntime(w),
      arm: testArm,
      sponsor,
      kernelUrl: 'http://kernel.test',
      batcherUrl: 'http://batcher.test',
      replay: new DigestReplayGuard(3600),
      log: silentLog(),
      prove: prove as never,
      coins: {
        spentNullifiers: async () => {
          throw new Error('history stream timed out after 120 s');
        },
      },
    });
    await expect(
      exec({ ...make, account: ACCOUNT, passportAuth: w.passportAuth('open-swap', ACCOUNT, make as never) }, ctx()),
    ).rejects.toMatchObject({ code: 'chain-unavailable' });
    expect(prove).not.toHaveBeenCalled();
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
