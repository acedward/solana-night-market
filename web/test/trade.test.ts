// Plan L-TRD in the browser, against a fake relay, a fake exchange and a TEST Solana wallet
// (./fake-signing.ts): a make and a take are ONE signature each over the swap call; the browser
// seals the entries to the account's own key and picks one coin; a second offer is refused while one
// is live; an offer too big for any coin is not takeable; a taken or externally settled offer is
// reconciled from the inbox walk. The pair is any two tokens (no token is special).

import { ed25519 } from '@noble/curves/ed25519.js';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  bytesToHex,
  contractCoinCommitment,
  contractCoinNullifier,
  hexToBytes,
  orderLegs,
  parsePrice,
  type AccountStateView,
  type ActionRequest,
  type DecodedCall,
  type InboxPage,
  type JobView,
  type MarketPair,
  type RelayActionName,
  type TokenEntry,
  type ZswapActivity,
} from '@nightmarket/core';
import { openEntryPortable, sealEntryPortable } from '@nightmarket/core/passport';
import { x25519 } from '@noble/curves/ed25519.js';

import { syncAccount, type OperationEnv } from '../src/passport/operations.js';
import { readCoins, readRoster } from '../src/passport/records.js';
import type { RelayClient } from '../src/relay/client.js';
import { LocalStore } from '../src/store/store.js';
import {
  confirmCancelsOffer,
  guardFor,
  decideApproval,
  makeOffer,
  offerShown,
  reconcileFromChain,
  reconcileOffers,
  takeOffer,
} from '../src/trade/operations.js';
import { liveOffer, putTrade, readTrades } from '../src/trade/records.js';
import { FakeChain } from './fake-chain.js';
import { fakeCallMessage, fakeDeviceEntry, fakeSigning } from './fake-signing.js';
import { expectImportRoundTrip } from './roundtrip.js';

const ACCOUNT = 'ac'.repeat(32);
// Any two tokens: the pair twUSDM/twUSDC here, 6 decimals each.
const BASE = { midnightColour: 'a1'.repeat(32), decimals: 6, symbol: 'twUSDM' } as unknown as TokenEntry;
const QUOTE = { midnightColour: 'b2'.repeat(32), decimals: 6, symbol: 'twUSDC' } as unknown as TokenEntry;
const PAIR: MarketPair = { id: 'twUSDM/twUSDC', base: BASE, quote: QUOTE };
const U = 1_000_000n;
const unhex = (h: string) => hexToBytes(h, h.length / 2);

class FakeRelay {
  submitted: Array<{ action: RelayActionName; request: ActionRequest }> = [];
  results: Record<string, Record<string, unknown>> = {};
  failNext: string | null = null;
  failCode = 'x';
  /** Side effects of a job on the chain, by action (the fake chain reads `state`). */
  afterJob: Record<string, () => void | Promise<void>> = {};
  state!: AccountStateView;
  entries: Array<string | null> = [];
  zswapActivity: ZswapActivity = { account: ACCOUNT, outputs: [], inputs: [], transactions: 0, blockHeight: 0 };
  /** The decoded calls of the account's swap transactions (AA 00047 P11.B: the evidence of a fill). */
  txCalls = new Map<string, DecodedCall[]>();

  async submit(action: RelayActionName, request: ActionRequest): Promise<JobView> {
    this.submitted.push({ action, request });
    return this.view(`${this.submitted.length}`.padStart(32, '0'), action, 'queued');
  }
  private view(requestId: string, action: RelayActionName, state: JobView['state'], extra: Partial<JobView> = {}) {
    return {
      requestId,
      action,
      lane: 'prover' as const,
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
    const action = this.submitted[Number(requestId) - 1]!.action;
    const job =
      this.failNext !== null
        ? this.view(requestId, action, 'failed', { error: { code: this.failCode, message: this.failNext } })
        : this.view(requestId, action, 'succeeded', { result: this.results[action] ?? {} });
    if (job.state === 'succeeded') await this.afterJob[action]?.();
    this.failNext = null;
    onUpdate(job);
    return job;
  }
  // Never read by the page since AA 00047 P9.S (Q26): the fake chain serves the account.
  async accountState(): Promise<AccountStateView> {
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

/** An account holding 3 twUSDM (one coin) and 8 + 6 twUSDC (two coins), synced from its inbox. */
async function setup() {
  const relay = new FakeRelay();
  const { signing, calls: signed } = fakeSigning();
  const e: OperationEnv = {
    relay: relay as unknown as RelayClient,
    chain: new FakeChain(relay),
    store: new LocalStore(storage),
    scope: { network: 'undeployed', owner: signing.deviceKey },
    signing,
  };
  const sk = x25519.utils.randomSecretKey();
  const pk = x25519.getPublicKey(sk);
  e.store.put(e.scope, 'secret', { encSecretKey: bytesToHex(sk), encPublicKey: bytesToHex(pk) }, { account: ACCOUNT });
  e.store.put(e.scope, 'roster', { useCounter: '0' }, { account: ACCOUNT });
  relay.state = {
    account: ACCOUNT,
    booted: true,
    deviceCount: 1,
    deviceEpoch: '0',
    devices: [fakeDeviceEntry(ACCOUNT, signing.deviceKey, 0n, 2n)],
    authNonce: '4',
    inboxCount: '3',
    encKey: bytesToHex(pk),
    networkSalt: '5a'.repeat(32),
  };
  const coins = [
    { nonce: '01'.repeat(32), color: BASE.midnightColour, value: 3n * U },
    { nonce: '02'.repeat(32), color: QUOTE.midnightColour, value: 8n * U },
    { nonce: '03'.repeat(32), color: QUOTE.midnightColour, value: 6n * U },
  ];
  await addInbox(relay, pk, coins);
  await syncAccount(e, ACCOUNT);
  return { signing, relay, e, pk, sk, signed };
}

/** What the chain shows once a swap call of this account executes (the relay's fake doing it): the
 *  wanted coin's note and leaf in `txHash`, the paid coin spent, the nonce moved, and the transaction's
 *  decoded swap call (AA 00047 P11.B: the account's own call receiving the wanted coin). */
async function executeSwap(relay: FakeRelay, pk: Uint8Array, payload: Record<string, unknown>, txHash: string) {
  const p = payload as {
    wantNonce: string;
    wantColor: string;
    wantAmount: string;
    coin: { nonce: string; color: string; value: string };
  };
  await addInbox(relay, pk, [{ nonce: p.wantNonce, color: p.wantColor, value: BigInt(p.wantAmount) }]);
  relay.zswapActivity.outputs.at(-1)!.txHash = txHash;
  relay.zswapActivity.inputs.push({ nullifier: contractCoinNullifier(p.coin, ACCOUNT), txHash, blockHeight: 2 });
  relay.txCalls.set(txHash, [swapCall({ nonce: p.wantNonce, color: p.wantColor, value: p.wantAmount }, p.coin)]);
  relay.state.authNonce = String(BigInt(relay.state.authNonce) + 1n);
}

/** The account's own swap call, as the page decodes it from the transaction: it receives `want` and
 *  spends `coin`. */
function swapCall(
  want: { nonce: string; color: string; value: string },
  coin: { nonce: string; color: string; value: string },
): DecodedCall {
  return {
    address: ACCOUNT,
    entryPoint: 'open_swap_shielded_with_ed25519',
    receives: [contractCoinCommitment(want, ACCOUNT)],
    nullifiers: [contractCoinNullifier(coin, ACCOUNT)],
  };
}

async function addInbox(
  relay: FakeRelay,
  pk: Uint8Array,
  coins: Array<{ nonce: string; color: string; value: bigint }>,
) {
  for (const c of coins) {
    relay.entries.push(
      bytesToHex(
        await sealEntryPortable(pk, { nonce: hexToBytes(c.nonce), color: hexToBytes(c.color), value: c.value }),
      ),
    );
    relay.zswapActivity.outputs.push({
      commitment: contractCoinCommitment({ nonce: c.nonce, color: c.color, value: c.value.toString() }, ACCOUNT),
      mtIndex: String(relay.zswapActivity.outputs.length + 10),
      txHash: `tx-${c.nonce.slice(0, 4)}`,
      blockHeight: 1,
    });
  }
  relay.state.inboxCount = String(relay.entries.length);
}

describe('make an offer (L-TRD.1)', () => {
  it('sell 2 twUSDM at 1.05: ONE signature over the exact swap call, entries sealed to the account', async () => {
    const { signing, relay, e, sk, signed } = await setup();
    relay.results['open-swap'] = {
      offerId: 'f0'.repeat(32),
      kernel: { accepted: true, status: 'live', code: null, reason: null },
      legSegment: 0,
      proveSeconds: 35,
      expiresAt: Date.now() + 3_600_000,
      bytes: 20000,
    };
    const legs = orderLegs('sell', BASE, QUOTE, 2n * U, parsePrice('1.05', QUOTE));
    const before = Math.floor(Date.now() / 1000);
    const rec = await makeOffer(e, ACCOUNT, legs, PAIR);
    const after = Math.floor(Date.now() / 1000);

    expect(signed).toEqual(['authorise:open-swap']);
    const [sub] = relay.submitted;
    expect(sub!.action).toBe('open-swap');
    const p = sub!.request.payload as Record<string, string> & { coin: Record<string, string> };
    expect(p).toMatchObject({
      giveColor: BASE.midnightColour,
      giveAmount: '2000000',
      wantColor: QUOTE.midnightColour,
      wantAmount: '2100000',
      authNonce: '4',
    });
    // AA 00047 P9.S (audit C6): a REAL expiry is signed, now + one hour (Unix seconds), never "0".
    expect(Number(p.validUntil)).toBeGreaterThanOrEqual(before + 3600);
    expect(Number(p.validUntil)).toBeLessThanOrEqual(after + 3600);
    expect(rec.validUntil).toBe(p.validUntil);
    expect(rec.expiresAt).toBe(Number(p.validUntil) * 1000); // the signed expiry, not the relay's TTL
    expect(p.coin).toMatchObject({ nonce: '01'.repeat(32), value: '3000000' });
    // The device signed exactly this call (the payload the relay receives), at use counter 2.
    const pa = sub!.request.passportAuth as { owner: string; signature: string; useCounter: string };
    expect(pa).toMatchObject({ owner: signing.deviceKey, useCounter: '2' });
    const message = fakeCallMessage(
      { account: ACCOUNT, authNonce: 4n, networkSalt: '5a'.repeat(32), encKey: relay.state!.encKey },
      { kind: 'swap', action: 'open-swap', payload: p as never },
    );
    expect(ed25519.verify(unhex(pa.signature), message, unhex(signing.deviceKey))).toBe(true);
    // Both entries open with the account's secret: the 2.10 twUSDC wanted, and the 1 twUSDM change.
    const want = await openEntryPortable(sk, hexToBytes(p.wantEntry, 192));
    const change = await openEntryPortable(sk, hexToBytes(p.changeEntry, 192));
    expect(want).toMatchObject({ value: 2_100_000n });
    expect(bytesToHex(want!.nonce)).toBe(p.wantNonce);
    expect(change).toMatchObject({ value: 1_000_000n });
    // My offers holds it as live; the coin is NOT spent and the counter does not move.
    expect(rec).toMatchObject({
      role: 'make',
      status: 'live',
      pair: 'twUSDM/twUSDC',
      summary: 'sell 2.00 twUSDM at 1.05 twUSDC',
    });
    expect(readCoins(e.store, e.scope, ACCOUNT).every((c) => !c.spent)).toBe(true);
    expect(readRoster(e.store, e.scope, ACCOUNT)).toEqual({ useCounter: '0' });
    expectImportRoundTrip(e.store, e.scope);
  });

  it('refuses a second offer while one is live (Q9), without asking the wallet', async () => {
    const { relay, e, signed } = await setup();
    relay.results['open-swap'] = {
      offerId: 'f0'.repeat(32),
      kernel: { accepted: true, status: 'live', code: null, reason: null },
      legSegment: 0,
      proveSeconds: 35,
      expiresAt: Date.now() + 3_600_000,
      bytes: 1,
    };
    await makeOffer(e, ACCOUNT, orderLegs('sell', BASE, QUOTE, 2n * U, parsePrice('1.05', QUOTE)), PAIR);
    await expect(
      makeOffer(e, ACCOUNT, orderLegs('buy', BASE, QUOTE, 1n * U, parsePrice('1', QUOTE)), PAIR),
    ).rejects.toThrow(/one live offer at a time/);
    expect(signed).toHaveLength(1);
    expect(relay.submitted).toHaveLength(1);
    // And a withdrawal would warn that it cancels the offer (L-TRD.3).
    expect(guardFor(e, ACCOUNT, 'withdraw')).toMatchObject({ kind: 'warn' });
  });

  it('every other signed action asks first while an offer is live; declining stops it; an expired offer asks nothing', async () => {
    const { relay, e } = await setup();
    relay.results['open-swap'] = {
      offerId: 'f0'.repeat(32),
      kernel: { accepted: true, status: 'live', code: null, reason: null },
      legSegment: 0,
      proveSeconds: 1,
      expiresAt: Date.now() + 3_600_000,
      bytes: 1,
    };
    await makeOffer(e, ACCOUNT, orderLegs('sell', BASE, QUOTE, 2n * U, parsePrice('1.05', QUOTE)), PAIR);
    expect(liveOffer(readTrades(e.store, e.scope, ACCOUNT), Date.now())).not.toBeNull();
    // Every signed action asks first; declining stops it (L-TRD.3).
    const asked: string[] = [];
    for (const a of ['append-inbox', 'withdraw', 'take'] as const) {
      expect(confirmCancelsOffer(e, ACCOUNT, a, (m) => (asked.push(m), false))).toBe(false);
    }
    expect(asked).toHaveLength(3);
    const [rec] = readTrades(e.store, e.scope, ACCOUNT);
    e.store.put(
      e.scope,
      'offer',
      { ...rec!, expiresAt: Date.now() - 1 },
      { account: ACCOUNT, id: `make-${rec!.offerId}` },
    );
    expect(liveOffer(readTrades(e.store, e.scope, ACCOUNT), Date.now())).toBeNull();
    expect(confirmCancelsOffer(e, ACCOUNT, 'withdraw', () => false)).toBe(true);
  });

  it('refuses an offer bigger than any single coin, naming the largest payment', async () => {
    const { e, signed } = await setup();
    // 12 twUSDC: the account holds 8 + 6, but no single coin of 12.
    const legs = orderLegs('buy', BASE, QUOTE, 10n * U, parsePrice('1.2', QUOTE));
    await expect(makeOffer(e, ACCOUNT, legs, PAIR)).rejects.toThrow(
      'Not enough twUSDC in one coin. You hold 14.00 twUSDC; one payment can use at most 8.00.',
    );
    expect(signed).toHaveLength(0);
  });
});

describe('take an offer (L-TRD.2)', () => {
  it('buys a whole ask with ONE signature, pays from the smallest covering coin, and records the settlement', async () => {
    const { relay, e, signed, pk } = await setup();
    relay.afterJob.take = () =>
      executeSwap(relay, pk, relay.submitted.at(-1)!.request.payload as never, 'aa'.repeat(32));
    relay.results.take = {
      offerId: 'e1'.repeat(32),
      txHash: 'aa'.repeat(32),
      proveSeconds: 36,
      cost: { blockUsage: '1', computeTimePs: '1', readTimePs: '1', feesSpecks: '1' },
      path: 'batcher',
    };
    const rec = await takeOffer(
      e,
      ACCOUNT,
      { offerId: 'e1'.repeat(32), side: 'ask', baseRaw: 5n * U, quoteRaw: 5_250_000n },
      PAIR,
    );
    expect(signed).toEqual(['authorise:take']);
    const [sub] = relay.submitted;
    expect(sub!.action).toBe('take');
    // A take signs a SHORT expiry (ten minutes): nobody can hold it as a free option (audit C6).
    const nowS = Math.floor(Date.now() / 1000);
    const until = Number((sub!.request.payload as { validUntil: string }).validUntil);
    // Signed for TAKE_LIFETIME_SECONDS, 600 s since AA 00047 P11.F (R4-1; it was 300 s).
    expect(until).toBeGreaterThan(nowS + 590);
    expect(until).toBeLessThanOrEqual(nowS + 600);
    expect(sub!.request.payload).toMatchObject({
      offerId: 'e1'.repeat(32),
      giveColor: QUOTE.midnightColour,
      giveAmount: '5250000',
      wantColor: BASE.midnightColour,
      wantAmount: '5000000',
      coin: { nonce: '03'.repeat(32), value: '6000000' }, // 6 covers 5.25; 8 would leave more change
    });
    expect(rec).toMatchObject({ role: 'take', status: 'filled', settledTx: 'aa'.repeat(32), side: 'buy' });
    expect(readRoster(e.store, e.scope, ACCOUNT)).toEqual({ useCounter: '3' });
    expectImportRoundTrip(e.store, e.scope); // F-B4: what the page wrote imports unchanged
  });

  it('a take cancels this account’s live offer (once the chain shows the take)', async () => {
    const { relay, e, pk } = await setup();
    relay.afterJob.take = () =>
      executeSwap(relay, pk, relay.submitted.at(-1)!.request.payload as never, 'ab'.repeat(32));
    relay.results['open-swap'] = {
      offerId: 'f0'.repeat(32),
      kernel: { accepted: true, status: 'live', code: null, reason: null },
      legSegment: 0,
      proveSeconds: 1,
      expiresAt: Date.now() + 3_600_000,
      bytes: 1,
    };
    relay.results.take = {
      offerId: 'e1'.repeat(32),
      txHash: 'aa'.repeat(32),
      proveSeconds: 1,
      cost: {},
      path: 'batcher',
    };
    await makeOffer(e, ACCOUNT, orderLegs('sell', BASE, QUOTE, 2n * U, parsePrice('1.05', QUOTE)), PAIR);
    expect(guardFor(e, ACCOUNT, 'take')).toMatchObject({ kind: 'warn' });
    await takeOffer(e, ACCOUNT, { offerId: 'e1'.repeat(32), side: 'ask', baseRaw: U, quoteRaw: U }, PAIR);
    const own = readTrades(e.store, e.scope, ACCOUNT).find((t) => t.role === 'make')!;
    expect(own.status).toBe('cancelled');
  });

  it('an offer too big for any coin is refused before the wallet is asked', async () => {
    const { e, signed } = await setup();
    await expect(
      takeOffer(e, ACCOUNT, { offerId: 'e1'.repeat(32), side: 'ask', baseRaw: 9n * U, quoteRaw: 9n * U }, PAIR),
    ).rejects.toThrow('Not enough twUSDC in one coin. You hold 14.00 twUSDC; one payment can use at most 8.00.');
    expect(signed).toHaveLength(0);
  });
});

describe('reconciling My offers (FR-011: whoever settles it)', () => {
  it('marks the offer filled by the decoded swap transaction that paid its wanted coin, with that transaction', async () => {
    const { relay, e, pk } = await setup();
    relay.results['open-swap'] = {
      offerId: 'f0'.repeat(32),
      kernel: { accepted: true, status: 'live', code: null, reason: null },
      legSegment: 0,
      proveSeconds: 1,
      expiresAt: Date.now() + 3_600_000,
      bytes: 1,
    };
    const rec = await makeOffer(e, ACCOUNT, orderLegs('sell', BASE, QUOTE, 2n * U, parsePrice('1.05', QUOTE)), PAIR);
    const kernel = { offerStatus: async () => 'live' as const };
    expect(await reconcileOffers(e, ACCOUNT, kernel)).toEqual([]);

    // Someone takes it: the circuit files the wanted coin (and the change) in the inbox, and the
    // offer's coin is spent in the same transaction, by the account's own swap call.
    const payload = relay.submitted[0]!.request.payload as {
      wantNonce: string;
      coin: { nonce: string; color: string; value: string };
    };
    await addInbox(relay, pk, [
      { nonce: payload.wantNonce, color: QUOTE.midnightColour, value: 2_100_000n },
      { nonce: '09'.repeat(32), color: BASE.midnightColour, value: 1n * U },
    ]);
    relay.zswapActivity.outputs.at(-2)!.txHash = 'settle-tx';
    relay.zswapActivity.inputs.push({
      nullifier: contractCoinNullifier(payload.coin, ACCOUNT),
      txHash: 'settle-tx',
      blockHeight: 2,
    });
    relay.txCalls.set('settle-tx', [
      swapCall({ nonce: payload.wantNonce, color: QUOTE.midnightColour, value: '2100000' }, payload.coin),
    ]);
    relay.state.authNonce = '5';
    const changed = await reconcileOffers(e, ACCOUNT, { offerStatus: async () => 'consumed' as const });
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({ offerId: rec.offerId, status: 'filled', settledTx: 'settle-tx' });
    const quote = readCoins(e.store, e.scope, ACCOUNT).filter((c) => c.color === QUOTE.midnightColour && !c.spent);
    expect(quote.map((c) => c.value).sort()).toEqual(['2100000', '6000000', '8000000']);
  });

  it('shows "settling" when the exchange says consumed before the chain shows it, and Filled once it does (R2-4)', async () => {
    const { relay, e, pk } = await setup();
    relay.results['open-swap'] = {
      offerId: 'f0'.repeat(32),
      kernel: { accepted: true, status: 'live', code: null, reason: null },
      legSegment: 0,
      proveSeconds: 1,
      expiresAt: Date.now() + 3_600_000,
      bytes: 1,
    };
    await makeOffer(e, ACCOUNT, orderLegs('sell', BASE, QUOTE, 2n * U, parsePrice('1.05', QUOTE)), PAIR);
    const consumed = { offerStatus: async () => 'consumed' as const };
    // The exchange's word alone ends nothing: the approval may still execute.
    expect(await reconcileOffers(e, ACCOUNT, consumed)).toEqual([]);
    const [first] = readTrades(e.store, e.scope, ACCOUNT);
    expect(first).toMatchObject({ status: 'live', kernelStatus: 'consumed' });
    expect(offerShown(first!)).toEqual({ state: 'settling', listed: false });
    expect(liveOffer(readTrades(e.store, e.scope, ACCOUNT), Date.now())).not.toBeNull(); // still blocks a second
    await executeSwap(relay, pk, relay.submitted[0]!.request.payload as never, 'late-tx');
    const [second] = await reconcileOffers(e, ACCOUNT, consumed);
    expect(second).toMatchObject({ status: 'filled', settledTx: 'late-tx' });
  });

  it('marks it cancelled when another signed call moved the nonce, and expired after its TTL', async () => {
    const { relay, e } = await setup();
    relay.results['open-swap'] = {
      offerId: 'f0'.repeat(32),
      kernel: { accepted: true, status: 'live', code: null, reason: null },
      legSegment: 0,
      proveSeconds: 1,
      expiresAt: Date.now() + 3_600_000,
      bytes: 1,
    };
    await makeOffer(e, ACCOUNT, orderLegs('sell', BASE, QUOTE, 2n * U, parsePrice('1.05', QUOTE)), PAIR);
    relay.state.authNonce = '5';
    const [c] = await reconcileOffers(e, ACCOUNT, { offerStatus: async () => 'live' as const });
    expect(c).toMatchObject({ status: 'cancelled' });

    const second = await setup();
    second.relay.results['open-swap'] = {
      offerId: 'f1'.repeat(32),
      kernel: { accepted: true, status: 'live', code: null, reason: null },
      legSegment: 0,
      proveSeconds: 1,
      // The relay's transaction TTL says one second: the page does not go by it (audit C6).
      expiresAt: Date.now() + 1000,
      bytes: 1,
    };
    const rec = await makeOffer(
      second.e,
      ACCOUNT,
      orderLegs('sell', BASE, QUOTE, 2n * U, parsePrice('1.05', QUOTE)),
      PAIR,
    );
    const live = { offerStatus: async () => 'live' as const };
    expect(await reconcileOffers(second.e, ACCOUNT, live, Date.now() + 5000)).toEqual([]); // still live
    const [x] = await reconcileOffers(second.e, ACCOUNT, live, Number(rec.validUntil) * 1000);
    expect(x).toMatchObject({ status: 'expired' }); // at the SIGNED expiry
  });

  it('shows a live offer the exchange has not listed as not listed, never "Listed" (P8.2 follow-up)', async () => {
    const { relay, e } = await setup();
    relay.results['open-swap'] = {
      offerId: 'f2'.repeat(32),
      kernel: { accepted: true, status: 'not_found', code: null, reason: null },
      legSegment: 0,
      proveSeconds: 1,
      expiresAt: Date.now() + 3_600_000,
      bytes: 1,
    };
    const rec = await makeOffer(e, ACCOUNT, orderLegs('sell', BASE, QUOTE, 2n * U, parsePrice('1.05', QUOTE)), PAIR);
    expect(rec.status).toBe('live'); // still a valid approval: it blocks a second offer and can be cancelled
    expect(offerShown(rec)).toEqual({ state: 'unlisted', listed: false });
    // Once the exchange lists it, it shows as listed.
    await reconcileOffers(e, ACCOUNT, { offerStatus: async () => 'live' as const });
    const [now] = readTrades(e.store, e.scope, ACCOUNT);
    expect(offerShown(now!)).toEqual({ state: 'live', listed: true });
    expect(offerShown({ role: 'take', status: 'filled', kernelStatus: 'consumed' })).toEqual({
      state: 'filled',
      listed: false,
    });
  });
});

describe('an approval ends only on the chain’s word and its signed expiry (AA 00047 P10, audit round 2 R2-4)', () => {
  const listed = {
    offerId: 'f5'.repeat(32),
    kernel: { accepted: true, status: 'live', code: null, reason: null },
    legSegment: 0,
    proveSeconds: 1,
    expiresAt: Date.now() + 3_600_000,
    bytes: 1,
  };

  it('another call the relay reports done does not cancel a live offer; the chain’s nonce does', async () => {
    const { relay, e } = await setup();
    relay.results['open-swap'] = listed;
    await makeOffer(e, ACCOUNT, orderLegs('sell', BASE, QUOTE, 2n * U, parsePrice('1.05', QUOTE)), PAIR);
    // A take the relay reports settled, while the chain shows nothing (it holds it, or lies).
    relay.results.take = {
      offerId: 'e1'.repeat(32),
      txHash: 'aa'.repeat(32),
      proveSeconds: 1,
      cost: {},
      path: 'batcher',
    };
    const take = await takeOffer(e, ACCOUNT, { offerId: 'e1'.repeat(32), side: 'ask', baseRaw: U, quoteRaw: U }, PAIR);
    expect(take).toMatchObject({ role: 'take', status: 'live', kernelStatus: 'consumed' }); // settling, not Filled
    expect(take.settledTx).toBeUndefined();
    const make = () => readTrades(e.store, e.scope, ACCOUNT).find((t) => t.role === 'make')!;
    expect(make().status).toBe('live');
    // Once the chain shows the nonce moved (and no fill of the make), the make is cancelled.
    relay.state.authNonce = '5';
    await reconcileFromChain(e, ACCOUNT);
    expect(make().status).toBe('cancelled');
  });

  it('an offer someone settled shows Filled from the chain, never Cancelled', async () => {
    const { relay, e, pk } = await setup();
    relay.results['open-swap'] = listed;
    await makeOffer(e, ACCOUNT, orderLegs('sell', BASE, QUOTE, 2n * U, parsePrice('1.05', QUOTE)), PAIR);
    // AA 00060 FR-028: the page cancels nothing; the offer was settled by someone.
    await executeSwap(relay, pk, relay.submitted[0]!.request.payload as never, 'settled-instead');
    relay.state.authNonce = String(BigInt(relay.state.authNonce) + 1n);
    await reconcileFromChain(e, ACCOUNT);
    expect(readTrades(e.store, e.scope, ACCOUNT)[0]).toMatchObject({ status: 'filled', settledTx: 'settled-instead' });
  });

  it('the exchange’s "expired" is the listing’s, not the approval’s: only the SIGNED expiry ends it', async () => {
    const { relay, e } = await setup();
    relay.results['open-swap'] = listed;
    const rec = await makeOffer(e, ACCOUNT, orderLegs('sell', BASE, QUOTE, 2n * U, parsePrice('1.05', QUOTE)), PAIR);
    const expired = { offerStatus: async () => 'expired' as const };
    expect(await reconcileOffers(e, ACCOUNT, expired)).toEqual([]);
    expect(readTrades(e.store, e.scope, ACCOUNT)[0]).toMatchObject({ status: 'live', kernelStatus: 'expired' });
    const [x] = await reconcileOffers(e, ACCOUNT, expired, Number(rec.validUntil) * 1000);
    expect(x).toMatchObject({ status: 'expired' });
  });

  it('records an older page ended too early (on a relay’s or the exchange’s word) are decided again', async () => {
    const { relay, e } = await setup();
    relay.results['open-swap'] = listed;
    const rec = await makeOffer(e, ACCOUNT, orderLegs('sell', BASE, QUOTE, 2n * U, parsePrice('1.05', QUOTE)), PAIR);
    for (const early of ['cancelled', 'expired', 'filled'] as const) {
      putTrade(e.store, e.scope, ACCOUNT, { ...rec, status: early });
      const [back] = await reconcileOffers(e, ACCOUNT, { offerStatus: async () => 'live' as const });
      expect(back).toMatchObject({ status: 'live' }); // the nonce has not moved; its signed expiry is ahead
    }
  });

  it('decideApproval: filled needs the decoded swap call and the moved nonce; a note alone proves nothing', () => {
    const t = {
      offerId: 'f6'.repeat(32),
      role: 'make' as const,
      side: 'sell' as const,
      pair: PAIR.id,
      base: BASE.midnightColour,
      quote: QUOTE.midnightColour,
      baseRaw: '1',
      quoteRaw: '1',
      summary: 's',
      coin: contractCoinCommitment({ nonce: '01'.repeat(32), color: BASE.midnightColour, value: '1' }, ACCOUNT),
      authNonce: '4',
      wantNonce: '0d'.repeat(32),
      createdAt: 0,
      expiresAt: 2_000_000_000_000,
      validUntil: '2000000000',
      status: 'live' as const,
    };
    const want = { nonce: '0d'.repeat(32), color: QUOTE.midnightColour, value: '1' };
    const give = { nonce: '01'.repeat(32), color: BASE.midnightColour, value: '1' };
    const W = contractCoinCommitment(want, ACCOUNT);
    const note = {
      ...want,
      mtIndex: '7',
      commitment: W,
      origin: 'inbox' as const,
      inInbox: true,
      spent: false,
      createdTx: 'dep',
    };
    const tx = (hash: string, entryPoints: string[]) => ({
      hash,
      blockHeight: 5,
      id: 1,
      entryPoints,
      outputs: [{ commitment: W, mtIndex: '7' }],
      inputs: [],
    });
    const view = (o: {
      authNonce: bigint;
      txs?: ReturnType<typeof tx>[];
      complete?: boolean;
      calls?: Record<string, DecodedCall[]>;
    }) => ({
      authNonce: o.authNonce,
      coins: [note],
      history: { account: ACCOUNT, txs: o.txs ?? [], complete: o.complete ?? true, throughHeight: 100 },
      stateHeight: 9,
      calls: (h: string) => o.calls?.[h],
    });
    // A note (and even a real coin) filed by anyone while the nonce has not moved: still live.
    expect(decideApproval(t, view({ authNonce: 4n, txs: [tx('dep', ['deposit_shielded'])] }), 0).status).toBe('live');
    // The nonce moved, and the wanted coin's leaf and note are there, but from a DEPOSIT: cancelled.
    expect(decideApproval(t, view({ authNonce: 5n, txs: [tx('dep', ['deposit_shielded'])] }), 0).status).toBe(
      'cancelled',
    );
    // The account's own swap call received it (and spent the offer's coin): filled, by that transaction.
    const swap = view({
      authNonce: 5n,
      txs: [tx('swap', ['open_swap_shielded_with_ed25519'])],
      calls: { swap: [swapCall(want, give)] },
    });
    expect(decideApproval(t, swap, 0)).toMatchObject({ status: 'filled', settledTx: 'swap', fillVerified: true });
    // A swap call of the account that received ANOTHER coin, with the wanted one deposited by another
    // call in the same transaction: not this offer's fill.
    const bundled = view({
      authNonce: 5n,
      txs: [tx('swap2', ['open_swap_shielded_with_ed25519', 'deposit_shielded'])],
      calls: {
        swap2: [
          swapCall({ ...want, nonce: '0e'.repeat(32) }, give),
          { address: ACCOUNT, entryPoint: 'deposit_shielded', receives: [W], nullifiers: [] },
        ],
      },
    });
    expect(decideApproval(t, bundled, 0).status).toBe('cancelled');
    // The swap call received the wanted coin but paid from another coin: not this approval's call.
    const otherCoin = view({
      authNonce: 5n,
      txs: [tx('swap3', ['open_swap_shielded_with_ed25519'])],
      calls: { swap3: [swapCall(want, { ...give, nonce: '02'.repeat(32) })] },
    });
    expect(
      decideApproval({ ...t }, { ...otherCoin, coins: [note, { ...note, ...give, commitment: t.coin }] }, 0).status,
    ).toBe('cancelled');
    // The nonce moved, nothing proves a fill, and the history is NOT complete: ended, neither claimed.
    expect(decideApproval(t, view({ authNonce: 5n, txs: [], complete: false }), 0).status).toBe('ended');
    // A transaction whose raw bytes were not read proves nothing either.
    expect(
      decideApproval(
        t,
        view({ authNonce: 5n, txs: [tx('swap', ['open_swap_shielded_with_ed25519'])], complete: false }),
        0,
      ).status,
    ).toBe('ended');
    // R4-4 (AA 00047 P11.F): even with the history COMPLETE, a candidate swap whose raw calls were not
    // read may be this approval's own fill: ended, never cancelled.
    expect(
      decideApproval(t, view({ authNonce: 5n, txs: [tx('swap', ['open_swap_shielded_with_ed25519'])] }), 0).status,
    ).toBe('ended');
    // Signed "never" (an older record): no expiry from time.
    const { validUntil: _v, ...never } = t;
    expect(decideApproval(never, view({ authNonce: 4n }), 9e15).status).toBe('live');
  });

  it('R3-6: a REAL coin someone deposits with the wanted nonce never turns an ended offer into Filled', async () => {
    const { relay, e, pk } = await setup();
    relay.results['open-swap'] = listed;
    await makeOffer(e, ACCOUNT, orderLegs('sell', BASE, QUOTE, 2n * U, parsePrice('1.05', QUOTE)), PAIR);
    const payload = relay.submitted[0]!.request.payload as { wantNonce: string; wantColor: string; wantAmount: string };
    // The attacker knows the wanted coin (the relay saw the payload) and pays for it: a real leaf and a
    // note, filed by `deposit_shielded`, in a transaction of its own.
    await addInbox(relay, pk, [
      { nonce: payload.wantNonce, color: payload.wantColor, value: BigInt(payload.wantAmount) },
    ]);
    relay.zswapActivity.outputs.at(-1)!.txHash = 'planted';
    relay.txCalls.set('planted', [
      {
        address: ACCOUNT,
        entryPoint: 'deposit_shielded',
        receives: [relay.zswapActivity.outputs.at(-1)!.commitment],
        nullifiers: [],
      },
    ]);
    // Another call of the owner lands (the nonce moves; offers cannot be cancelled, AA 00060 FR-028).
    relay.state.authNonce = String(BigInt(relay.state.authNonce) + 1n);
    await reconcileFromChain(e, ACCOUNT);
    const [rec] = readTrades(e.store, e.scope, ACCOUNT);
    expect(rec).toMatchObject({ status: 'cancelled' });
    expect(rec!.settledTx).toBeUndefined();
  });

  it('R3-6: a "Filled" an older page decided from a note alone is decided again', async () => {
    const { relay, e, pk } = await setup();
    relay.results['open-swap'] = listed;
    const rec = await makeOffer(e, ACCOUNT, orderLegs('sell', BASE, QUOTE, 2n * U, parsePrice('1.05', QUOTE)), PAIR);
    const payload = relay.submitted[0]!.request.payload as { wantNonce: string; wantColor: string; wantAmount: string };
    await addInbox(relay, pk, [
      { nonce: payload.wantNonce, color: payload.wantColor, value: BigInt(payload.wantAmount) },
    ]);
    relay.zswapActivity.outputs.at(-1)!.txHash = 'planted';
    relay.state.authNonce = '5';
    // P10's page called it filled, settled by the planted deposit.
    putTrade(e.store, e.scope, ACCOUNT, { ...rec, status: 'filled', settledTx: 'planted' });
    const [back] = await reconcileOffers(e, ACCOUNT, null);
    expect(back).toMatchObject({ status: 'cancelled' });
    expect(back!.settledTx).toBeUndefined();
  });

  it('R3-6: with the history incomplete, a moved nonce shows Ended, never Filled or Cancelled; decided once it is complete', async () => {
    const { relay, e, pk } = await setup();
    relay.results['open-swap'] = listed;
    await makeOffer(e, ACCOUNT, orderLegs('sell', BASE, QUOTE, 2n * U, parsePrice('1.05', QUOTE)), PAIR);
    (e.chain as FakeChain).complete = false;
    relay.state.authNonce = '5';
    const [ended] = await reconcileOffers(e, ACCOUNT, null);
    expect(ended).toMatchObject({ status: 'ended' });
    expect(offerShown(ended!)).toEqual({ state: 'ended', listed: false });
    expect(liveOffer(readTrades(e.store, e.scope, ACCOUNT), Date.now())).toBeNull(); // it never blocks a new offer
    // The complete history shows the swap that filled it.
    await executeSwap(relay, pk, relay.submitted[0]!.request.payload as never, 'swap-tx');
    relay.state.authNonce = '5';
    (e.chain as FakeChain).complete = true;
    const [filled] = await reconcileOffers(e, ACCOUNT, null);
    expect(filled).toMatchObject({ status: 'filled', settledTx: 'swap-tx' });
  });

  // R4-4 (AA 00047 P11.F, F-B4-1): a fill candidate whose raw calls could not be decoded.
  it('R4-4: shows Ended, never Cancelled, though the history is complete; decided Filled once its calls are read', async () => {
    const { relay, e, pk } = await setup();
    relay.results['open-swap'] = listed;
    await makeOffer(e, ACCOUNT, orderLegs('sell', BASE, QUOTE, 2n * U, parsePrice('1.05', QUOTE)), PAIR);
    await executeSwap(relay, pk, relay.submitted[0]!.request.payload as never, 'swap-tx');
    const chain = e.chain as FakeChain;
    chain.failCalls.add('swap-tx'); // the raw read fails (or the bytes do not decode)
    const [ended] = await reconcileOffers(e, ACCOUNT, null);
    expect(ended).toMatchObject({ status: 'ended' });
    expect(ended!.settledTx).toBeUndefined();
    chain.failCalls.delete('swap-tx');
    const [filled] = await reconcileOffers(e, ACCOUNT, null);
    expect(filled).toMatchObject({ status: 'filled', settledTx: 'swap-tx', fillVerified: true });
  });

  it('R4-4: a moved nonce with no unread candidate is still Cancelled (ended)', async () => {
    const { relay, e } = await setup();
    relay.results['open-swap'] = listed;
    await makeOffer(e, ACCOUNT, orderLegs('sell', BASE, QUOTE, 2n * U, parsePrice('1.05', QUOTE)), PAIR);
    relay.state.authNonce = String(BigInt(relay.state.authNonce) + 1n);
    (e.chain as FakeChain).failCalls.add('unrelated-tx'); // a failing read of a non-candidate changes nothing
    const changed = await reconcileFromChain(e, ACCOUNT);
    expect(changed.filter((t) => t.status === 'cancelled')).toHaveLength(1);
  });
});

// AA 00060 spec FR-028 (owner, 2026-10-05; supersedes 00047 Q30): Night Market does not cancel offers.
describe('offers cannot be cancelled (FR-028)', () => {
  it('the page has no cancel operation left', async () => {
    const trade = (await import('../src/trade/operations.js')) as Record<string, unknown>;
    const passport = (await import('../src/passport/operations.js')) as Record<string, unknown>;
    expect(trade.cancelOffers).toBeUndefined();
    expect(passport.cancelOpenApprovals).toBeUndefined();
    expect(passport.CANCEL_UNAVAILABLE).toBeUndefined();
  });
});
