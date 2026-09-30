// Plan L-TRD: the relay's two trade actions against a mocked kernel and batcher, with the proof
// and the ledger replaced by G-TAKE's fake transactions (the live check, L-TRD.0, runs the real ones).
//
//   - the `passport-call` authorisation of a swap call's signature (valid, tampered, replayed), through
//     the TEST device arm (./fake-arm.ts; the Ed25519 arm is lane B3's);
//   - open-swap: prove → publish (waiting out ROOT_UNKNOWN) → listed; a refusal is reported;
//   - take: the maker's offer is checked BEFORE any proof (whole, complementary, legs in segment 0,
//     still live), then merge → cost(params, true) → batcher; every refusal is specific.

import { describe, expect, it, vi } from 'vitest';

import { encodeOffer, type OpenSwapPayload, type TakePayload } from '@nightmarket/core';

import { accountOffer, walletOffer, type FakeTx } from '../../test/gates/take/fake-tx.js';
import { passportCallAuthoriser } from '../src/auth/passport-call.js';
import { DigestReplayGuard } from '../src/auth/verifiers.js';
import type { PassportRuntime } from '../src/passport/runtime.js';
import { PublicError, type JobContext } from '../src/queue/jobs.js';
import type { SponsorSession } from '../src/sponsor/session.js';
import type { ProvenAccountOffer } from '../src/trade/account-offer.js';
import { openSwapExecutor, takeExecutor, type TradeDeps } from '../src/trade/executors.js';
import { TakeRefusal, checkMakerOffer, mergeForSettlement } from '../src/trade/settle.js';
import { describeTx } from '../src/trade/tx-structure.js';
import { callSigner, fakeAccountRuntime, testArm } from './fake-arm.js';
import { silentLog } from './harness.js';

const ACCOUNT = '5e'.repeat(32);
// Any two tokens: no token is special.
const BASE = 'a1'.repeat(32);
const QUOTE = 'b2'.repeat(32);
const OFFER_ID = 'cd'.repeat(32);

/** A FakeTx that also answers the ledger's cost questions. */
function costly(tx: FakeTx, opts: { timeToDismiss?: boolean } = {}): FakeTx {
  return Object.assign(tx, {
    cost: (_p: unknown, enforce?: boolean) => {
      if (enforce && opts.timeToDismiss === false) throw new Error('OutsideTimeToDismiss');
      return { readTime: 1n, computeTime: 2n, blockUsage: 3n };
    },
    fees: () => 42n,
    serialize: () => new Uint8Array([1, 2, 3]),
    merge(other: FakeTx) {
      return costly(Object.getPrototypeOf(tx).merge.call(tx, other) as FakeTx, opts);
    },
  });
}

type Signer = ReturnType<typeof callSigner>;

/** The account `signer` controls, at auth nonce 2, with the providers the executors borrow. */
function fakeRuntime(signer: Signer, authNonce = 2n): PassportRuntime {
  return Object.assign(fakeAccountRuntime(ACCOUNT, [signer.deviceKey], authNonce), {
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

function ctx(): JobContext & { stages: string[] } {
  const stages: string[] = [];
  return {
    requestId: '00'.repeat(16),
    log: silentLog(),
    stage: (s: string) => stages.push(s),
    prove: <T>(fn: () => Promise<T>) => fn(),
    stages,
  };
}

const make: OpenSwapPayload = {
  giveColor: BASE,
  giveAmount: '2000000',
  wantColor: QUOTE,
  wantAmount: '2100000',
  wantNonce: '11'.repeat(32),
  wantEntry: '22'.repeat(192),
  changeEntry: '00'.repeat(192),
  validUntil: '0',
  coin: { nonce: '33'.repeat(32), color: BASE, value: '3000000', mtIndex: '9' },
  authNonce: '2',
};
/** B takes an ask "2 base for 2.10 quote": gives 2.10 quote, wants 2 base. */
const take: TakePayload = {
  ...make,
  giveColor: QUOTE,
  giveAmount: '2100000',
  wantColor: BASE,
  wantAmount: '2000000',
  coin: { nonce: '44'.repeat(32), color: QUOTE, value: '4000000', mtIndex: '12' },
  offerId: OFFER_ID,
};

function signed(w: Signer, action: 'open-swap' | 'take', payload: OpenSwapPayload) {
  return w.passportAuth(action, ACCOUNT, payload as unknown as Record<string, unknown>);
}

function proven(tx: FakeTx, id = 'ef'.repeat(32)): ProvenAccountOffer {
  return {
    tx: tx as never,
    bytes: new Uint8Array(30),
    blob: 'swapoffer1fake',
    offerId: id,
    proveMs: 35_000,
    structure: describeTx(tx),
    steering: { fromPs: '15000000000', toPs: '1099511627775' },
    expiresAt: 1_800_000_000_000,
  };
}

type Route = (url: string, init: RequestInit) => Response | Promise<Response>;
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
function fetchMock(route: Route) {
  const calls: Array<{ url: string; method: string; body: string }> = [];
  const f = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET', body: String(init?.body ?? '') });
    return route(String(url), init ?? {});
  });
  return { f: f as unknown as typeof fetch, calls };
}

function deps(rt: PassportRuntime, extra: Partial<TradeDeps>): TradeDeps {
  return {
    runtime: () => rt,
    arm: testArm,
    sponsor,
    kernelUrl: 'http://kernel.test',
    batcherUrl: 'http://batcher.test',
    batcherTarget: 'midnight-balancer',
    replay: new DigestReplayGuard(3600),
    log: silentLog(),
    timings: { publishRetryMs: 1, statusPollMs: 1, statusTimeoutMs: 50 },
    ...extra,
  };
}

describe('the passport-call authorisation of a trade', () => {
  it("accepts the device's swap signature once, and refuses tampered terms and replays", async () => {
    const w = callSigner();
    const rt = fakeRuntime(w);
    const replay = new DigestReplayGuard(3600);
    const authorise = passportCallAuthoriser(() => rt, testArm, replay);
    const auth = signed(w, 'open-swap', make);
    const req = { account: ACCOUNT, payload: make, passportAuth: auth };
    expect(await authorise({ action: 'open-swap' } as never, req as never)).toMatchObject({ ok: true });
    expect(await authorise({ action: 'open-swap' } as never, req as never)).toMatchObject({
      ok: false,
      code: 'replayed',
    });
    const tampered = { ...req, payload: { ...make, wantAmount: '2000000' } };
    expect(await authorise({ action: 'open-swap' } as never, tampered as never)).toMatchObject({
      ok: false,
      code: 'bad-signature',
    });
    const stale = passportCallAuthoriser(() => fakeRuntime(w, 3n), testArm, new DigestReplayGuard(3600));
    expect(await stale({ action: 'open-swap' } as never, req as never)).toMatchObject({ ok: false, code: 'expired' });
    // A take must name the offer.
    expect(await authorise({ action: 'take' } as never, req as never)).toMatchObject({
      ok: false,
      code: 'malformed',
    });
  });
});

describe('open-swap (make)', () => {
  it('proves, publishes (waiting out ROOT_UNKNOWN) and reports the offer once it is listed', async () => {
    const w = callSigner();
    let posts = 0;
    const { f, calls } = fetchMock((url, init) => {
      if (init.method === 'POST' && url.endsWith('/v1/offers')) {
        posts += 1;
        return posts === 1
          ? json(400, { error: 'ROOT_UNKNOWN', reason: 'not synced yet' })
          : json(200, { success: true, offerId: 'ef'.repeat(32) });
      }
      if (url.endsWith('/status')) return json(200, { offerId: 'ef'.repeat(32), status: 'live' });
      return json(404, {});
    });
    const prove = vi.fn(async () => proven(accountOffer(4711, 0, BASE, 2_000_000n, QUOTE, 2_100_000n)));
    const c = ctx();
    const auth = signed(w, 'open-swap', make);
    const r = await openSwapExecutor(deps(fakeRuntime(w), { fetchImpl: f, prove }))(
      { ...make, account: ACCOUNT, passportAuth: auth, signer: w.deviceKey },
      c,
    );
    expect(prove).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ offerId: 'ef'.repeat(32), legSegment: 0, kernel: { accepted: true, status: 'live' } });
    expect(c.stages).toEqual(['proving', 'proven', 'posted', 'listed']);
    expect(JSON.parse(calls.find((x) => x.method === 'POST')!.body)).toEqual({ offer: 'swapoffer1fake' });
    expect(posts).toBe(2);
  });

  it('reports the exchange’s refusal with its code', async () => {
    const w = callSigner();
    const { f } = fetchMock(() => json(400, { error: 'PROOF_INVALID', reason: 'wellFormed failed' }));
    const prove = async () => proven(accountOffer(4711, 0, BASE, 2_000_000n, QUOTE, 2_100_000n));
    const auth = signed(w, 'open-swap', make);
    await expect(
      openSwapExecutor(deps(fakeRuntime(w), { fetchImpl: f, prove }))(
        { ...make, account: ACCOUNT, passportAuth: auth },
        ctx(),
      ),
    ).rejects.toMatchObject({ code: 'offer-refused', message: expect.stringContaining('PROOF_INVALID') });
  });
});

describe('take', () => {
  const makerBlob = encodeOffer(new Uint8Array([9, 9, 9]));
  const kernel =
    (status = 'live') =>
    (url: string) =>
      url.endsWith(`/v1/offers/${OFFER_ID}`)
        ? json(200, {
            offerId: OFFER_ID,
            offerBech32: makerBlob,
            computed: { gives: [], wants: [], status },
          })
        : json(404, {});

  async function run(o: {
    maker?: FakeTx;
    taker?: FakeTx;
    kernelStatus?: string;
    batcher?: (body: unknown) => Response;
    payload?: TakePayload;
  }) {
    const w = callSigner();
    const payload = o.payload ?? take;
    const makerTx = o.maker ?? costly(walletOffer(BASE, 2_000_000n, QUOTE, 2_100_000n));
    const takerTx = o.taker ?? costly(accountOffer(62921, 0, QUOTE, 2_100_000n, BASE, 2_000_000n));
    const batcherBodies: unknown[] = [];
    const { f } = fetchMock((url, init) => {
      if (url.startsWith('http://batcher.test')) {
        const body = JSON.parse(String(init.body));
        batcherBodies.push(body);
        return (o.batcher ?? (() => json(200, { success: true, transactionHash: 'aa'.repeat(32) })))(body);
      }
      return kernel(o.kernelStatus)(url);
    });
    const prove = vi.fn(async () => proven(takerTx));
    const c = ctx();
    const auth = signed(w, 'take', payload);
    const exec = takeExecutor(
      deps(fakeRuntime(w), {
        fetchImpl: f,
        prove,
        deserialize: async () => makerTx,
        ledgerParameters: async () => ({ params: true }),
      }),
    );
    const result = exec({ ...payload, account: ACCOUNT, passportAuth: auth }, c);
    return { result, prove, stages: c.stages, batcherBodies };
  }

  it('settles a whole offer in one transaction through the batcher (midnight-balancer, finalized)', async () => {
    const r = await run({});
    await expect(r.result).resolves.toMatchObject({
      offerId: OFFER_ID,
      txHash: 'aa'.repeat(32),
      path: 'batcher',
      cost: { blockUsage: '3', computeTimePs: '2', readTimePs: '1', feesSpecks: '42' },
    });
    expect(r.stages).toEqual(['offer-checked', 'proving', 'merged', 'settled']);
    const body = r.batcherBodies[0] as { data: { target: string; input: string; address: string } };
    expect(body.data.target).toBe('midnight-balancer');
    expect(JSON.parse(body.data.input)).toEqual({ tx: '010203', txStage: 'finalized' });
    expect(body.data.address).toBe('mn_addr_stagenet1bank');
  });

  it('refuses before proving when the offer is gone, not whole, or not in segment 0', async () => {
    const gone = await run({ kernelStatus: 'consumed' });
    await expect(gone.result).rejects.toMatchObject({ code: 'offer-gone' });
    expect(gone.prove).not.toHaveBeenCalled();

    const partial = await run({ payload: { ...take, wantAmount: '1000000' } });
    await expect(partial.result).rejects.toMatchObject({ code: 'take-not-complementary' });
    expect(partial.prove).not.toHaveBeenCalled();

    // A default-proven account maker: its legs are in its own fallible segment (G-TAKE (c1)).
    const fallible = await run({ maker: costly(accountOffer(11204, 11204, BASE, 2_000_000n, QUOTE, 2_100_000n)) });
    await expect(fallible.result).rejects.toMatchObject({ code: 'take-maker-segment' });
    expect(fallible.prove).not.toHaveBeenCalled();
  });

  it('refuses a merge the node would refuse: time-to-dismiss, or the same intent segment', async () => {
    const slow = await run({
      maker: costly(walletOffer(BASE, 2_000_000n, QUOTE, 2_100_000n), { timeToDismiss: false }),
    });
    await expect(slow.result).rejects.toMatchObject({ code: 'take-time-to-dismiss' });
    const collide = await run({
      maker: costly(accountOffer(500, 0, BASE, 2_000_000n, QUOTE, 2_100_000n)),
      taker: costly(accountOffer(500, 0, QUOTE, 2_100_000n, BASE, 2_000_000n)),
    });
    await expect(collide.result).rejects.toMatchObject({ code: 'take-intent-collision' });
  });

  it('reports a batcher refusal (and the fallback is not run silently)', async () => {
    const r = await run({ batcher: () => json(400, { success: false, error: 'Custom error: 138' }) });
    await expect(r.result).rejects.toBeInstanceOf(PublicError);
    await expect(r.result).rejects.toMatchObject({ code: 'take-refused', message: expect.stringContaining('138') });
  });
});

describe('the settlement checks', () => {
  it('checkMakerOffer names what the offer gives and wants when it is not the one signed', () => {
    const maker = walletOffer(BASE, 2_000_000n, QUOTE, 2_100_000n);
    expect(
      checkMakerOffer(maker, {
        give: { colour: QUOTE, amount: 2_100_000n },
        want: { colour: BASE, amount: 2_000_000n },
      }),
    ).toEqual({ makerSegment: 0 });
    try {
      checkMakerOffer(maker, { give: { colour: QUOTE, amount: 2n }, want: { colour: BASE, amount: 2_000_000n } });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(TakeRefusal);
      expect((e as TakeRefusal).detail).toMatchObject({ offerGives: { colour: BASE, amount: '2000000' } });
    }
  });

  it('mergeForSettlement refuses an unbalanced merge and reads the cost of a balanced one', () => {
    const maker = costly(walletOffer(BASE, 2_000_000n, QUOTE, 2_100_000n));
    const short = costly(accountOffer(7, 0, QUOTE, 2_000_000n, BASE, 2_000_000n));
    expect(() => mergeForSettlement(maker, short, {})).toThrow(/not token-balanced/);
    const ok = mergeForSettlement(maker, costly(accountOffer(7, 0, QUOTE, 2_100_000n, BASE, 2_000_000n)), {});
    expect(ok.cost.enforced).toEqual({ readTime: '1', computeTime: '2', blockUsage: '3' });
    expect(ok.structure.legs).toEqual({});
  });
});
