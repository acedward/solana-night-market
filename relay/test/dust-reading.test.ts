// Issue 00049 (plan P7.5, questions Q24): the sponsor's DUST reading must not dip while a
// transaction is in flight, and must still flag a genuinely low balance at once.
//
// 1. The tracker on simulated wallet readings (before a spend, in flight, confirmed, dropped,
//    expired, genuinely low).
// 2. The sponsor session, /health and the relay's admission check on the same kind of sequence.
// 3. The pinned SDK (ledger-v9 1.0.0-rc.3, dust-wallet 5.0.0-beta.2): the root cause reproduced on
//    a real `DustLocalState`, and the adapter's readings of real SDK objects.

import * as L from '@midnightntwrk/ledger-v9';
import { CoinsAndBalances, CoreWallet } from '@midnightntwrk/wallet-sdk-dust-wallet/v1';
import { HealthResponseSchema } from '@nightmarket/core';
import { describe, expect, it } from 'vitest';

import { healthCollector } from '../src/health.js';
import type { ProofServerClient } from '../src/prover/client.js';
import { JobQueue } from '../src/queue/jobs.js';
import {
  DEFAULT_DUST_GRACE_SECONDS,
  type DustOutputView,
  type DustWalletView,
  LOCK_EXPIRY_MARGIN_MS,
  nullifierKey,
  SettledDustTracker,
} from '../src/sponsor/dust-reading.js';
import {
  type DustStateView,
  dustOutputsOf,
  FacadeSponsorSession,
  type PendingTransactionsView,
  pendingSpendsOf,
  type WalletFactory,
} from '../src/sponsor/facade.js';
import { harness, newWallet, post, signedBody, silentLog } from './harness.js';

const DUST = 10n ** 15n;
const out = (lineage: string, seq: number, dust: bigint, nullifier?: string): DustOutputView => ({
  lineage,
  seq,
  specks: dust * DUST,
  ...(nullifier ? { nullifier } : {}),
});
/** A synced reading whose wallet balance is the sum of its spendable outputs (as the ledger's). */
const reading = (outputs: DustOutputView[], extra: Partial<DustWalletView> = {}): DustWalletView => ({
  synced: true,
  dustSpecks: outputs.reduce((sum, o) => sum + o.specks, 0n),
  outputs,
  ...extra,
});
const fee = (nullifier: string, dust: bigint) => ({ pendingSpends: [{ nullifier, feeSpecks: dust * DUST }] });

// P6's numbers: a 9,678-DUST output pays a 12-DUST fee next to a 39,972-DUST one (49,650 in all).
const A3 = out('night-a', 3, 9_678n, 'a3');
const A4 = out('night-a', 4, 9_666n, 'a4'); // A3's change: 9,678 − 12
const B0 = out('night-b', 0, 39_972n, 'b0');

describe('the settled DUST reading (issue 00049)', () => {
  it('does not dip while a spend is in flight, and drops by exactly the fee when the change arrives', () => {
    const t = new SettledDustTracker(() => 0);
    const seen: bigint[] = [];
    const step = (v: DustWalletView) => {
      const r = t.observe(v);
      seen.push(r.specks);
      return r;
    };
    // Before: nothing in flight.
    expect(step(reading([A3, B0]))).toEqual({
      specks: 49_650n * DUST,
      inFlightSpecks: 0n,
      inFlightFeeSpecks: 0n,
      lockedOutputs: 0,
    });
    // Balanced: the ledger locks A3, and the wallet's own balance loses all of it (the bug).
    const balanced = reading([B0]);
    expect(balanced.dustSpecks).toBe(39_972n * DUST);
    expect(step(balanced)).toEqual({
      specks: 49_650n * DUST,
      inFlightSpecks: 9_678n * DUST,
      inFlightFeeSpecks: 0n,
      lockedOutputs: 1,
    });
    // Finalised: the wallet holds the transaction; its DUST spend names A3 and pays 12.
    expect(step(reading([B0], fee('a3', 12n)))).toMatchObject({
      specks: 49_638n * DUST,
      inFlightSpecks: 9_666n * DUST,
      inFlightFeeSpecks: 12n * DUST,
    });
    // Sync updates while it waits for a block (the SDK has already forgotten its pending coin).
    for (let i = 0; i < 5; i++) expect(step(reading([B0], fee('a3', 12n))).specks).toBe(49_638n * DUST);
    // The indexer confirms it: the wallet forgets the transaction before its change arrives.
    expect(step(reading([B0])).specks).toBe(49_638n * DUST);
    // The change arrives: the same lineage, seq + 1, worth 9,678 − 12.
    expect(step(reading([A4, B0]))).toEqual({
      specks: 49_638n * DUST,
      inFlightSpecks: 0n,
      inFlightFeeSpecks: 0n,
      lockedOutputs: 0,
    });
    expect(Math.min(...seen.map(Number))).toBe(Number(49_638n * DUST));
    expect(seen[0]! - seen.at(-1)!).toBe(12n * DUST);
  });

  it('counts a locked output in full until its fee is known', () => {
    const t = new SettledDustTracker(() => 0);
    t.observe(reading([A3, B0]));
    expect(t.observe(reading([B0])).specks).toBe(49_650n * DUST);
    // A change that arrives before the transaction was ever seen pending: exact again.
    expect(t.observe(reading([A4, B0])).specks).toBe(49_638n * DUST);
  });

  it('still flags a genuinely low balance: nothing in flight, or once the change arrives', () => {
    const t = new SettledDustTracker(() => 0);
    // Genuinely low with nothing in flight: reported as is, at once.
    expect(t.observe(reading([out('n', 0, 5n, 'n0')])).specks).toBe(5n * DUST);

    // 20 DUST paying a 12-DUST fee: 20 while unknown, 8 once the fee is known and after.
    const t2 = new SettledDustTracker(() => 0);
    t2.observe(reading([out('n', 0, 20n, 'n0')]));
    expect(t2.observe(reading([])).specks).toBe(20n * DUST);
    expect(t2.observe(reading([], fee('n0', 12n))).specks).toBe(8n * DUST);
    expect(t2.observe(reading([out('n', 1, 8n, 'n1')])).specks).toBe(8n * DUST);
  });

  it('releases a spend that was dropped: the same output is back, and nothing is counted twice', () => {
    const t = new SettledDustTracker(() => 0);
    t.observe(reading([A3, B0]));
    t.observe(reading([B0], fee('a3', 12n)));
    // Reverted (the facade's revert, or the ledger's grace period): A3 itself is spendable again.
    expect(t.observe(reading([A3, B0]))).toMatchObject({ specks: 49_650n * DUST, lockedOutputs: 0 });
  });

  it('gives up a lock the wallet never resolves once the ledger has certainly released it', () => {
    let now = 0;
    const t = new SettledDustTracker(() => now);
    t.observe(reading([A3, B0], { graceSeconds: 600 }));
    expect(t.observe(reading([B0], { graceSeconds: 600 })).lockedOutputs).toBe(1);
    now = 600_000 + LOCK_EXPIRY_MARGIN_MS;
    expect(t.observe(reading([B0], { graceSeconds: 600 })).lockedOutputs).toBe(1);
    now += 1;
    expect(t.observe(reading([B0], { graceSeconds: 600 }))).toMatchObject({
      specks: 39_972n * DUST,
      lockedOutputs: 0,
    });
    // and does not lock it again
    expect(t.observe(reading([B0], { graceSeconds: 600 })).lockedOutputs).toBe(0);
    expect(DEFAULT_DUST_GRACE_SECONDS).toBe(10_800);
  });

  it('locks only between two synced readings, never an output worth nothing, and tracks several', () => {
    const t = new SettledDustTracker(() => 0);
    // Catching up: outputs come and go (one decays to zero); nothing is locked.
    t.observe(reading([A3, B0], { synced: false }));
    expect(t.observe(reading([B0], { synced: false })).lockedOutputs).toBe(0);
    expect(t.observe(reading([B0])).lockedOutputs).toBe(0);
    // An output worth nothing that disappears is not locked.
    t.observe(reading([B0, out('dead', 2, 0n)]));
    expect(t.observe(reading([B0])).lockedOutputs).toBe(0);
    // Two outputs spent by one transaction; each change arrives on its own.
    t.observe(reading([A3, B0]));
    expect(t.observe(reading([], { pendingSpends: [] }))).toMatchObject({
      specks: 49_650n * DUST,
      lockedOutputs: 2,
    });
    const both = {
      pendingSpends: [
        { nullifier: 'a3', feeSpecks: 7n * DUST },
        { nullifier: 'b0', feeSpecks: 5n * DUST },
      ],
    };
    expect(t.observe(reading([], both))).toMatchObject({ specks: 49_638n * DUST, inFlightFeeSpecks: 12n * DUST });
    expect(t.observe(reading([out('night-a', 4, 9_671n)]))).toMatchObject({
      specks: 49_638n * DUST,
      lockedOutputs: 1,
    });
    expect(t.observe(reading([out('night-a', 4, 9_671n), out('night-b', 1, 39_967n)]))).toMatchObject({
      specks: 49_638n * DUST,
      lockedOutputs: 0,
    });
  });

  it('reports the wallet balance as is when the wallet lists no outputs, and forgets its locks', () => {
    const t = new SettledDustTracker(() => 0);
    t.observe(reading([A3, B0]));
    t.observe(reading([B0]));
    expect(t.observe({ synced: true, dustSpecks: 7n })).toEqual({
      specks: 7n,
      inFlightSpecks: 0n,
      inFlightFeeSpecks: 0n,
      lockedOutputs: 0,
    });
    expect(t.observe(reading([B0])).lockedOutputs).toBe(0);
  });
});

// ── The session, /health and the admission check ────────────────────────────

function drivenSession() {
  let emit: (v: DustWalletView) => void = () => {};
  const factory: WalletFactory = async () => ({
    handle: { fake: true },
    subscribe: (onState) => {
      emit = onState;
      return () => {};
    },
    stop: async () => {},
  });
  const log = silentLog();
  const session = new FacadeSponsorSession(
    {
      seedHex: '00'.repeat(32),
      endpoints: {
        networkId: 'undeployed',
        indexerUrl: 'http://i',
        indexerWsUrl: 'ws://i',
        nodeWsUrl: 'ws://n',
        dustProofServerUrl: 'http://p',
      },
      feeBlocksMargin: 5,
      fundingLockFile: null,
      purpose: 'test',
    },
    factory,
    log,
  );
  return { session, emit: (v: DustWalletView) => emit(v), log };
}

const prover = (version: string) =>
  ({
    probe: async () => ({ reachable: true, version, jobCapacity: 10, versionMatches: true }),
  }) as unknown as ProofServerClient;

const healthOf = (session: FacadeSponsorSession) =>
  healthCollector({
    network: 'undeployed',
    version: 'test',
    startedAt: 0,
    sponsor: session,
    dustLowSpecks: 10n * DUST,
    prover: prover('9.0.0-rc.8'),
    dustProver: prover('9.0.0-rc.6'),
    keys: () => ({
      present: true,
      fingerprint: 'f'.repeat(64),
      pinned: true,
      matchesPin: true,
      missingProverKeys: [],
      missingVerifierKeys: [],
      missingZkir: [],
      mismatchedVerifierKeys: [],
    }),
    queue: new JobQueue({ ttlSeconds: 60, maxJobs: 10, log: silentLog() }),
    probes: { kernel: async () => ({ reachable: true, synced: true }), batcher: async () => ({ reachable: true }) },
    cacheSeconds: 15,
    now: () => 100,
  });

describe('the sponsor session and /health (issue 00049)', () => {
  it('keeps sponsor.dustSpecks and dustLow steady through a transaction, and reports what is in flight', async () => {
    const { session, emit, log } = drivenSession();
    await session.start();
    const health = healthOf(session);
    const sponsorOf = async () => {
      const h = await health();
      expect(HealthResponseSchema.parse(h)).toBeTruthy();
      return { status: h.status, ...h.sponsor };
    };

    emit(reading([A3, B0]));
    expect(await sponsorOf()).toEqual({
      status: 'ok',
      configured: true,
      state: 'synced',
      synced: true,
      dustSpecks: (49_650n * DUST).toString(),
      dustInFlightSpecks: '0',
      dustLow: false,
    });
    emit(reading([B0]));
    expect(await sponsorOf()).toMatchObject({
      status: 'ok',
      dustSpecks: (49_650n * DUST).toString(),
      dustInFlightSpecks: (9_678n * DUST).toString(),
      dustLow: false,
    });
    emit(reading([B0], fee('a3', 12n)));
    expect(await sponsorOf()).toMatchObject({
      dustSpecks: (49_638n * DUST).toString(),
      dustInFlightSpecks: (9_666n * DUST).toString(),
    });
    emit(reading([A4, B0]));
    expect(await sponsorOf()).toMatchObject({
      status: 'ok',
      dustSpecks: (49_638n * DUST).toString(),
      dustInFlightSpecks: '0',
      dustLow: false,
    });
    // The lock and its release are logged (no secrets: amounts only).
    const lines = log.lines.filter((l) => l.includes('locked by transactions in flight'));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('"outputs":1');
    expect(lines[1]).toContain('"outputs":0');

    await session.stop();
    expect(session.status()).toMatchObject({ state: 'stopped', synced: false });
    expect(session.status().dustInFlightSpecks).toBeUndefined();
  });

  it('flags a genuinely low sponsor at once: degraded, dustLow, and actions refused', async () => {
    const { session, emit } = drivenSession();
    await session.start();
    const health = healthOf(session);
    emit(reading([out('n', 0, 5n, 'n0')]));
    const h = await health();
    expect(h.status).toBe('degraded');
    expect(h.sponsor).toMatchObject({ dustSpecks: (5n * DUST).toString(), dustInFlightSpecks: '0', dustLow: true });
  });

  it('admits actions mid-transaction that the raw reading would refuse as sponsor-low; refuses when really low', async () => {
    const { session, emit } = drivenSession();
    await session.start();
    const h = harness({ sponsor: session }); // the relay's low level: 10 DUST (the default)
    expect(h.config.sponsor.dustLowSpecks).toBe(10n * DUST);
    const code = async () => {
      const res = await post(h, 'register', await signedBody(h, 'register', newWallet()));
      return res.status === 202 ? 'admitted' : ((await res.json()) as { error: { code: string } }).error.code;
    };
    // 25 DUST in two outputs; the 20-DUST one pays a 12-DUST fee.
    emit(reading([out('n', 0, 20n, 'n0'), out('m', 0, 5n, 'm0')]));
    expect(await code()).toBe('admitted');
    const inFlight = reading([out('m', 0, 5n, 'm0')], fee('n0', 12n));
    expect(inFlight.dustSpecks).toBe(5n * DUST); // what the relay used to read: below 10
    emit(inFlight);
    expect(session.status().dustSpecks).toBe(13n * DUST);
    expect(await code()).toBe('admitted');
    emit(reading([out('n', 1, 8n, 'n1'), out('m', 0, 5n, 'm0')]));
    expect(await code()).toBe('admitted');
    // A later 6-DUST fee from the 8-DUST output: 7 DUST left, genuinely low.
    emit(reading([out('m', 0, 5n, 'm0')], fee('n1', 6n)));
    expect(await code()).toBe('sponsor-low');
    emit(reading([out('n', 2, 2n, 'n2'), out('m', 0, 5n, 'm0')]));
    expect(await code()).toBe('sponsor-low');
  });
});

// ── The pinned SDK ───────────────────────────────────────────────────────────

describe('on the pinned SDK (ledger-v9 1.0.0-rc.3, dust-wallet 5.0.0-beta.2)', () => {
  const params = L.LedgerParameters.initialParameters().dust;
  const sk = L.DustSecretKey.fromSeed(new Uint8Array(32).fill(7));
  const night = 'ab'.repeat(32);
  const t0 = new Date('2026-09-01T00:00:00Z');
  const later = new Date(t0.getTime() + 30 * 86_400_000); // long past the time to cap
  const FEE = 12n * DUST;
  const caps = CoinsAndBalances.makeDefaultCoinsAndBalancesCapability({}, () => ({ keysCapability: {} as never }));
  type Core = ReturnType<typeof CoreWallet.init>;

  /** A wallet with one DUST output backed by 2,000 NIGHT (10,000 DUST at its cap). */
  const walletWithOneOutput = (): Core => {
    const gen = { value: 2_000n * 10n ** 6n, owner: sk.publicKey, nonce: night, dtime: undefined };
    const qdo = {
      initialValue: 0n,
      owner: sk.publicKey,
      nonce: 123n,
      seq: 0,
      ctime: t0,
      backingNight: night,
      mtIndex: 0n,
    };
    const st = new L.DustLocalState(params)
      .insertGenerationInfo(0n, gen, night)
      .insertCommitment(0n, qdo, true)
      .addUtxo(L.dustNullifier(qdo, sk), qdo);
    return CoreWallet.init(st, sk, 'undeployed');
  };
  /** What the facade's `state().dust` offers the adapter, for this wallet at `at`. */
  const dustState = (w: Core, at: Date): DustStateView => ({
    balance: (d: Date) => w.state.walletBalance(d),
    availableCoins: caps.getAvailableCoins(w, at),
    state: w,
  });
  const viewOf = (w: Core, pending?: PendingTransactionsView): DustWalletView => ({
    synced: true,
    dustSpecks: w.state.walletBalance(later),
    ...dustOutputsOf(dustState(w, later), (token) => nullifierKey(L.dustNullifier(token as never, sk))),
    ...pendingSpendsOf(pending),
  });

  it('reproduces the root cause: a spend hides the whole output, and the SDK forgets it at the next replay', () => {
    const w0 = walletWithOneOutput();
    expect(w0.state.walletBalance(later)).toBe(10_000n * DUST);
    const coin = w0.state.utxos[0]!;
    const [spends, w1] = CoreWallet.spendCoins(w0, sk, [{ token: coin, value: FEE }], later);
    expect(spends[0]!.vFee).toBe(FEE);
    // The whole 10,000 DUST is gone from the balance for a 12-DUST fee.
    expect(w1.state.walletBalance(later)).toBe(0n);
    expect(w1.state.utxos).toHaveLength(0);
    expect(w1.pendingDust).toHaveLength(1);
    // The next event replay (even an empty one) drops the SDK's pending coin; the ledger still locks it.
    const [w2] = CoreWallet.applyEventsWithChanges(w1, sk, [], new Date(later.getTime() + 6_000));
    expect(w2.pendingDust).toHaveLength(0);
    expect(w2.state.walletBalance(later)).toBe(0n);
    // Only the grace period (3 h) gives it back if the spend never lands.
    expect(Number(params.dustGracePeriodSeconds)).toBe(DEFAULT_DUST_GRACE_SECONDS);
    const released = w2.state.processTtls(new Date(later.getTime() + (DEFAULT_DUST_GRACE_SECONDS + 1) * 1000));
    expect(released.walletBalance(later)).toBe(10_000n * DUST);
  });

  it('reads real SDK objects into a steady reading: before, in flight, confirmed', () => {
    const w0 = walletWithOneOutput();
    const v0 = viewOf(w0);
    expect(v0.outputs).toEqual([
      {
        lineage: night,
        seq: 0,
        specks: 10_000n * DUST,
        nullifier: nullifierKey(L.dustNullifier(w0.state.utxos[0]!, sk)),
      },
    ]);
    expect(v0.graceSeconds).toBe(DEFAULT_DUST_GRACE_SECONDS);

    const [spends, w1] = CoreWallet.spendCoins(w0, sk, [{ token: w0.state.utxos[0]!, value: FEE }], later);
    const spend = spends[0]!;
    // The spend names the output by the nullifier the adapter computes: that is how a lock learns its fee.
    expect(nullifierKey(spend.oldNullifier)).toBe(v0.outputs![0]!.nullifier);
    // The facade's pending transactions, as the adapter reads them (a finalized transaction's intents).
    const pending: PendingTransactionsView = {
      all: [{ tx: { intents: new Map([[1, { dustActions: { spends: [spend] } }]]) } }],
    };
    expect(pendingSpendsOf(pending)).toEqual({
      pendingSpends: [{ nullifier: nullifierKey(spend.oldNullifier), feeSpecks: FEE }],
    });
    const [w2] = CoreWallet.applyEventsWithChanges(w1, sk, [], new Date(later.getTime() + 6_000));

    // The change as the ledger's `DustSpendProcessed` replay leaves it: the old output removed, and
    // the same backing NIGHT at seq 1, worth the value at the spend minus the fee.
    const change = {
      initialValue: 10_000n * DUST - FEE,
      owner: sk.publicKey,
      nonce: 456n,
      seq: 1,
      ctime: later,
      backingNight: night,
      mtIndex: 1n,
    };
    const confirmedState = w2.state
      .removeUtxo(spend.oldNullifier)
      .insertCommitment(1n, change, true)
      .addUtxo(L.dustNullifier(change, sk), change);
    const w3: Core = { ...w2, state: confirmedState };

    const t = new SettledDustTracker(() => 0);
    const reported = [
      t.observe(v0),
      t.observe(viewOf(w1)),
      t.observe(viewOf(w1, pending)),
      t.observe(viewOf(w2, pending)),
      t.observe(viewOf(w2)),
      t.observe(viewOf(w3)),
    ].map((r) => r.specks);
    // The wallet's own readings dip to zero; the reported one never does.
    expect([viewOf(w1).dustSpecks, viewOf(w2).dustSpecks, viewOf(w3).dustSpecks]).toEqual([
      0n,
      0n,
      10_000n * DUST - FEE,
    ]);
    expect(reported).toEqual([
      10_000n * DUST,
      10_000n * DUST, // fee not known yet
      10_000n * DUST - FEE,
      10_000n * DUST - FEE,
      10_000n * DUST - FEE, // the wallet forgot the transaction; the fee stays known
      10_000n * DUST - FEE, // the change arrived
    ]);
  });

  it('falls back to the wallet balance when the SDK objects do not have the expected shape', () => {
    expect(dustOutputsOf({ balance: () => 0n })).toEqual({});
    expect(
      dustOutputsOf({ balance: () => 0n, availableCoins: [{ token: { backingNight: 1, seq: 0 }, generatedNow: 1n }] }),
    ).toEqual({});
    expect(pendingSpendsOf(undefined)).toEqual({});
    expect(pendingSpendsOf({ all: [{ tx: {} }] })).toEqual({ pendingSpends: [] });
  });
});
