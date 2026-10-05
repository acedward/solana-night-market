// Plan P4-A, route tests: auth and rate limits on EVERY state-changing route, with the catalogue
// the relay runs once a device arm is wired (main.ts with `wiredArm()`: register, the gated account
// calls, trading), not the stubs. For each route: an unsigned call, a wrong signer, an expired
// authorisation, a replay, and an unknown nonce are all refused BEFORE any work (no job queued, no
// sponsor wallet opened); the per-client and per-owner rate limits apply; a sponsor that is low
// refuses before any authorisation is used up. Read routes leak nothing secret.
//
// Two authorisations exist (relay/src/auth/verifiers.ts):
//   relay-action   register, demo-tokens: a RelayAction envelope with a relay-issued nonce;
//   passport-call  withdraw, withdraw-unshielded, append-inbox, cancel-offers, open-swap, take: the
//                  call's own Passport signature; its "nonce" is the account's on-chain auth nonce.
// The arm and the envelope scheme are the TEST ones (./fake-arm.ts, the core test scheme): the route
// rules do not depend on them. The Ed25519 arm's own checks are relay/test/ed25519-arm.test.ts, the
// Solana scheme's packages/core/test/solana-auth.test.ts.

import { randomBytes } from 'node:crypto';

import { ed25519 } from '@noble/curves/ed25519.js';
import { describe, expect, it } from 'vitest';

import {
  API_PATHS,
  RELAY_ACTIONS,
  buildRelayActionMessage,
  type AppendInboxPayload,
  type CancelOffersPayload,
  type RestoreEncKeyPayload,
  type HealthResponse,
  type OpenSwapPayload,
  type RelayActionName,
  type TakePayload,
  type WithdrawPayload,
  type WithdrawUnshieldedPayload,
} from '@nightmarket/core';

import { BridgeRegistry } from '@nightmarket/core/bridge';

import { testDevice, testScheme } from '../../packages/core/test/fixtures/test-signing.js';
import { AccountCaps } from '../src/actions/account-caps.js';
import {
  accountCatalogue,
  withAccountCaps,
  withDemoTokens,
  withRegistrationCaps,
  withTrade,
} from '../src/actions/catalogue.js';
import { FailureBudget } from '../src/actions/failure-budget.js';
import { withBridgeOut } from '../src/actions/catalogue.js';
import { LandingEntitlements, landingEntitlementKey } from '../src/bridge/out-actions.js';
import { RegistrationCaps } from '../src/actions/registration-caps.js';
import { demoTokens } from '../src/demo/action.js';
import { DemoTokenClaims } from '../src/demo/claims.js';
import { createApp } from '../src/app.js';
import { NonceStore } from '../src/auth/nonces.js';
import { passportCallAuthoriser } from '../src/auth/passport-call.js';
import { DigestReplayGuard } from '../src/auth/verifiers.js';
import { notImplementedChainReader } from '../src/chain/reader.js';
import { healthCollector, httpProbes } from '../src/health.js';
import { loadConfig } from '../src/config.js';
import { ProofServerClient } from '../src/prover/client.js';
import { JobQueue } from '../src/queue/jobs.js';
import type { SponsorStatus } from '../src/sponsor/session.js';
import { callSigner, fakeAccountRuntime, testArm } from './fake-arm.js';
import { FakeSponsor, LOCAL_TOKENS, silentLog, testEntitlements } from './harness.js';

const ACCOUNT = '5e'.repeat(32);
const AUTH_NONCE = 3n;
const COLOUR_A = 'a1'.repeat(32);

type Kind = 'relay-action' | 'passport-call' | 'entitlement';
const KIND: Record<RelayActionName, Kind> = {
  register: 'relay-action',
  withdraw: 'passport-call',
  'append-inbox': 'passport-call',
  'open-swap': 'passport-call',
  take: 'passport-call',
  'withdraw-unshielded': 'passport-call',
  'demo-tokens': 'relay-action',
  'cancel-offers': 'passport-call',
  // AA 00047 P10.R: "Restore my encryption key", authorised by its own signature (R2-3).
  'restore-enc-key': 'passport-call',
  // AA 00060 P6.3: authorised by a landing entitlement (relay/test/bridge-out.test.ts tests them).
  'bridge-out': 'entitlement',
  'bridge-out-entitle': 'entitlement',
};
/** The signed actions this file walks through (the entitlement ones have their own test). */
const SIGNED_ACTIONS = RELAY_ACTIONS.filter((a) => KIND[a] !== 'entitlement');

/** A sponsor that records every time a job borrows its wallet (that would be work). */
class CountingSponsor extends FakeSponsor {
  walletCalls = 0;
  override async withWallet<T>(fn: (w: unknown) => Promise<T>): Promise<T> {
    this.walletCalls++;
    return fn({ fake: true });
  }
}

/** One device (one Ed25519 key, as a Solana wallet holds): it signs relay envelopes (the test
 *  scheme) and account calls (the test arm). */
function newDevice() {
  const secret = ed25519.utils.randomSecretKey();
  return { envelope: testDevice(secret), calls: callSigner(secret) };
}
type Device = ReturnType<typeof newDevice>;

/** The relay as main.ts wires it once an arm is wired, with fakes at the edges (runtime, sponsor). */
function productionRelay(
  opts: {
    env?: Record<string, string>;
    sponsor?: CountingSponsor;
    appendsPerDay?: number;
    /** F-B6's second signature for a withdrawal's encryption key (questions Q13; off by default). */
    fb6?: boolean;
    /** AA 00060 P10.3 C2: Bridge out's two unsigned actions, with fakes at the edges. */
    bridgeOut?: boolean;
  } = {},
) {
  const device = newDevice();
  // These route tests send several calls for the one test account; the one-job-per-account rule
  // (AA 00047 P10, R2-1) has its own tests (relay/test/fairness.test.ts).
  const config = loadConfig(
    { RELAY_NETWORK: 'undeployed', TOKENS_FILE: '/t', JOBS_PER_ACCOUNT: '100', ...opts.env },
    () => JSON.stringify(LOCAL_TOKENS),
  ).config;
  const log = silentLog();
  const rt = fakeAccountRuntime(ACCOUNT, [device.calls.deviceKey], AUTH_NONCE);
  const sponsor = opts.sponsor ?? new CountingSponsor();
  const replay = new DigestReplayGuard(config.limits.authMaxTtlSeconds * 6);
  const nonces = new NonceStore(config.limits.nonceTtlSeconds, config.limits.maxUsedNonces);
  const queue = new JobQueue({ ttlSeconds: config.limits.jobTtlSeconds, maxJobs: config.limits.maxJobs, log });
  const entitlements = testEntitlements({ maxPerAccountPerDay: opts.appendsPerDay ?? 20 });
  const catalogue = withTrade(
    accountCatalogue({
      runtime: () => rt,
      arm: testArm,
      scheme: testScheme,
      sponsor,
      network: 'undeployed',
      withdrawRecipientEnvelope: opts.fb6 ?? false,
      replay,
      entitlements,
      log,
    }),
    {
      runtime: () => rt,
      arm: testArm,
      sponsor,
      kernelUrl: 'http://kernel.test',
      batcherUrl: 'http://batcher.test',
      replay,
      expiry: config.expiry,
      log,
    },
  );
  // As main.ts (AA 00047 P9, audit C4): registration caps and the failure budget; (P10, R2-1) the
  // per-account caps.
  withRegistrationCaps(catalogue, new RegistrationCaps(config.registration));
  withAccountCaps(catalogue, new AccountCaps(config.accountCaps));
  const claims = new DemoTokenClaims({ file: null, dailyCap: 100 });
  withDemoTokens(
    catalogue,
    demoTokens({
      runtime: () => rt,
      sponsor,
      claims,
      pack: [],
      path: 'via-sponsor',
      arm: testArm,
      mint: async () => ({}),
      log,
    }),
  );
  // AA 00060 P10.3 C2: Bridge out wired as main.ts wires it, its chain reads faked (tx1 is never found).
  const entitleReads = { tx1: 0 };
  if (opts.bridgeOut) {
    withBridgeOut(catalogue, {
      bridges: new BridgeRegistry('undeployed', '11111111111111111111111111111111', []),
      entitlements: new LandingEntitlements({ key: landingEntitlementKey('11'.repeat(32)), network: 'undeployed' }),
      ledger: async () => {
        throw new Error('not used here');
      },
      transcripts: async () => {
        throw new Error('not used here');
      },
      prove: async () => {
        throw new Error('not used here');
      },
      submitWithDust: async () => {
        throw new Error('not used here');
      },
      awaitLanded: async () => false,
      log,
      tx1: async () => {
        entitleReads.tx1 += 1;
        return null;
      },
      liveDevice: async () => true,
    });
  }
  const health = async (): Promise<HealthResponse> => {
    throw new Error('not used here');
  };
  const app = createApp({
    config,
    version: 'test',
    log,
    nonces,
    queue,
    catalogue,
    failures: new FailureBudget(config.failureBudget),
    sponsor,
    health,
    chain: notImplementedChainReader,
    scheme: testScheme,
    passportCall: passportCallAuthoriser(() => rt, testArm, replay),
    // Tests may name the client (AA 00060 P10.3 C2: an attacker beside the account's own browser).
    clientAddress: (c) => c.req.header('x-test-client') ?? '198.51.100.7',
  });
  // Hold the prover lane with a job that never ends, so an accepted call stays QUEUED: it has done
  // no work, and its authorisation stays claimed (the replay test needs that).
  const hold = () => new Promise<Record<string, unknown>>(() => {});
  queue.submit({ action: 'register', lane: 'prover', payload: {}, executor: hold });
  const HELD = 1;
  return {
    app,
    config,
    device,
    rt,
    sponsor,
    queue,
    nonces,
    log,
    catalogue,
    entitlements,
    held: HELD,
    queued: () => queue.stats().jobs - HELD,
    entitleReads,
  };
}
type Relay = ReturnType<typeof productionRelay>;

/** A valid body for each action, before its authorisation; `n` varies it (a distinct call). */
function payloadFor(action: RelayActionName, n = 0, authNonce = AUTH_NONCE): Record<string, unknown> {
  const a = String(authNonce);
  const amount = String(1_000_000 + n);
  switch (action) {
    case 'register':
      return { encPublicKey: (n % 2 ? 'cd' : 'ab').repeat(32) };
    case 'withdraw':
      return {
        recipient: '11'.repeat(32),
        color: COLOUR_A,
        amount,
        coin: { nonce: '33'.repeat(32), color: COLOUR_A, value: '5000000', mtIndex: '42' },
        authNonce: a,
      } satisfies WithdrawPayload;
    case 'append-inbox':
      return { entry: (0xcd + (n % 16)).toString(16).repeat(192), authNonce: a } satisfies AppendInboxPayload;
    case 'withdraw-unshielded':
      return { recipient: '44'.repeat(32), color: COLOUR_A, amount, authNonce: a } satisfies WithdrawUnshieldedPayload;
    case 'demo-tokens':
      // The device's live use counter (AA 00047 P9, audit C8 / F-B10): the fake account's is 0.
      return { useCounter: '0' };
    case 'cancel-offers':
      return { newKey: (0xe0 + (n % 16)).toString(16).repeat(32), authNonce: a } satisfies CancelOffersPayload;
    case 'restore-enc-key':
      return { newKey: (0xb0 + (n % 16)).toString(16).repeat(32), authNonce: a } satisfies RestoreEncKeyPayload;
    case 'open-swap':
    case 'take': {
      const make: OpenSwapPayload = {
        giveColor: COLOUR_A,
        giveAmount: amount,
        wantColor: 'b2'.repeat(32),
        wantAmount: '2100000',
        wantNonce: '11'.repeat(32),
        wantEntry: '22'.repeat(192),
        changeEntry: '00'.repeat(192),
        // A real signed expiry (AA 00047 P9, audit C6): a make an hour ahead at most, a take minutes.
        validUntil: String(Math.floor(Date.now() / 1000) + (action === 'take' ? 300 : 1800)),
        coin: { nonce: '33'.repeat(32), color: COLOUR_A, value: '3000000', mtIndex: '9' },
        authNonce: a,
      };
      return action === 'take' ? ({ ...make, offerId: 'cd'.repeat(32) } satisfies TakePayload) : make;
    }
    default:
      throw new Error(`${action} is not a signed action`);
  }
}

interface Tamper {
  /** Who signs (default: the account's device). */
  signer?: Device;
  /** The owner the authorisation names (default: the signer). */
  owner?: Device;
  /** relay-action: a nonce of our choosing; passport-call: the auth nonce signed and sent. */
  nonce?: string | bigint;
  /** relay-action: the expiry. */
  expiry?: number;
  n?: number;
  /** append-inbox: the entitlement sent (default: a fresh valid one; null: none). */
  entitlement?: string | null;
}

/** A body for `action`, signed as the route requires (or broken as `t` says). */
async function body(r: Relay, action: RelayActionName, t: Tamper = {}) {
  const signer = t.signer ?? r.device;
  const owner = t.owner ?? signer;
  const account = action === 'register' ? undefined : ACCOUNT;
  // demo-tokens is claimed once per key: a variant `n` is a different key's claim in these tests
  // only where the test says so; its body always names the device's use counter.
  if (KIND[action] === 'relay-action') {
    const payload = payloadFor(action, t.n);
    const nonce =
      typeof t.nonce === 'string'
        ? t.nonce
        : ((await (await r.app.request(API_PATHS.nonce)).json()) as { nonce: string }).nonce;
    const message = buildRelayActionMessage({
      action,
      network: r.config.network.name,
      owner: owner.envelope.deviceKey,
      account,
      payload,
      nonce,
      expiry: t.expiry ?? Math.floor(Date.now() / 1000) + 120,
    });
    const signature = signer.envelope.signEnvelope(message);
    return { ...(account ? { account } : {}), payload, auth: { message, signature } };
  }
  const authNonce = typeof t.nonce === 'bigint' ? t.nonce : AUTH_NONCE;
  const payload = payloadFor(action, t.n, authNonce);
  // An append is sponsored only against the market's entitlement for a change (F-B3); it is not signed.
  if (action === 'append-inbox' && t.entitlement !== null)
    payload.entitlement = t.entitlement ?? r.entitlements.issue(ACCOUNT, `withdraw:test-${t.n ?? 0}`);
  const { entitlement: _e, ...signed } = payload;
  const passportAuth = { ...signer.calls.passportAuth(action, ACCOUNT, signed), owner: owner.calls.deviceKey };
  return { account, payload, passportAuth };
}

const post = (r: Relay, action: string, b: unknown, client?: string) =>
  r.app.request(`/v1/actions/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(client ? { 'x-test-client': client } : {}) },
    body: JSON.stringify(b),
  });

async function refused(r: Relay, res: Response, status: number, detail?: string) {
  expect(res.status).toBe(status);
  const b = (await res.json()) as { error: { code: string; detail?: string } };
  if (detail) expect(b.error.detail).toBe(detail);
  // Before any work: nothing queued, the sponsor wallet never opened.
  expect(r.queued()).toBe(0);
  expect(r.sponsor.walletCalls).toBe(0);
  return b;
}

describe('the production catalogue', () => {
  it('authorises each action the way the relay runs it', () => {
    const r = productionRelay();
    for (const a of RELAY_ACTIONS) expect([a, r.catalogue.get(a)!.auth]).toEqual([a, KIND[a]]);
  });
});

describe.each(SIGNED_ACTIONS)('POST /v1/actions/%s (production catalogue)', (action) => {
  const kind = KIND[action];

  it('accepts a correct call, and queues exactly one job', async () => {
    const r = productionRelay();
    const res = await post(r, action, await body(r, action));
    expect(res.status).toBe(202);
    expect(r.queued()).toBe(1);
  });

  it('refuses an unsigned call before any work', async () => {
    const r = productionRelay();
    const b = await body(r, action);
    const { auth: _a, passportAuth: _p, ...unsigned } = b as Record<string, unknown>;
    await refused(r, await post(r, action, unsigned), 401, 'malformed');
  });

  it('refuses a call signed by someone who is not the owner, or not a device of the account', async () => {
    const r = productionRelay();
    const stranger = newDevice();
    // Signed by a stranger in the device's name.
    await refused(
      r,
      await post(r, action, await body(r, action, { signer: stranger, owner: r.device })),
      401,
      'bad-signature',
    );
    if (kind === 'passport-call') {
      // Signed by a stranger in their own name: not a device of this account.
      await refused(r, await post(r, action, await body(r, action, { signer: stranger })), 401, 'wrong-signer');
    }
  });

  it('refuses an expired authorisation', async () => {
    const r = productionRelay();
    const b =
      kind === 'relay-action'
        ? await body(r, action, { expiry: Math.floor(Date.now() / 1000) - 5 })
        : await body(r, action, { nonce: AUTH_NONCE - 1n }); // signed for an older account state
    await refused(r, await post(r, action, b), 401, 'expired');
  });

  it('refuses an unknown nonce', async () => {
    const r = productionRelay();
    const b =
      kind === 'relay-action'
        ? await body(r, action, { nonce: `0x${'42'.repeat(32)}` }) // never issued by this relay
        : await body(r, action, { nonce: AUTH_NONCE + 7n }); // not the account's auth nonce
    await refused(r, await post(r, action, b), 401, kind === 'relay-action' ? 'unknown-nonce' : 'expired');
  });

  it('refuses a replay, queuing nothing more', async () => {
    const r = productionRelay();
    const b = await body(r, action);
    expect((await post(r, action, b)).status).toBe(202);
    const res = await post(r, action, b);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { detail: string } }).error.detail).toBe('replayed');
    expect(r.queued()).toBe(1);
  });

  it('rate-limits per client address, before looking at the authorisation', async () => {
    const r = productionRelay({ env: { RATE_LIMIT_ACTIONS_PER_MIN: '2' } });
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) statuses.push((await post(r, action, { payload: {} })).status);
    expect(statuses).toEqual([400, 400, 429]);
    const res = await post(r, action, await body(r, action));
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(r.queued()).toBe(0);
  });

  it('rate-limits per owner, and a call refused that way can be sent again later', async () => {
    const r = productionRelay({ env: { RATE_LIMIT_ACTIONS_PER_OWNER_PER_MIN: '1' } });
    expect((await post(r, action, await body(r, action, { n: 0 }))).status).toBe(202);
    const second = await body(r, action, { n: 1 });
    const res = await post(r, action, second);
    expect(res.status).toBe(429);
    expect(r.queued()).toBe(1);
    if (kind === 'passport-call') {
      // The digest was released: after the window, the SAME signature is not a "replay".
      const later = await post(r, action, second);
      expect([429]).toContain(later.status); // still inside the window here
      expect(((await later.json()) as { error: { code: string } }).error.code).toBe('rate-limited');
    }
  });

  it('refuses while the sponsor is low, before any authorisation is used up', async () => {
    const sponsor = new CountingSponsor({
      configured: true,
      state: 'synced',
      synced: true,
      dustSpecks: 1n,
    } as SponsorStatus);
    const r = productionRelay({ sponsor });
    const b = await body(r, action);
    const res = await post(r, action, b);
    const e = await refused(r, res, 503);
    expect(e.error.code).toBe('sponsor-low');
    sponsor.current = { ...sponsor.current, dustSpecks: 10n ** 20n };
    expect((await post(r, action, b)).status).toBe(202); // the same authorisation still works
  });
});

describe('one prompt per withdrawal by default (questions Q13 option B)', () => {
  it('accepts a withdrawal to a wallet with its encryption key and no second signature', async () => {
    const r = productionRelay();
    const b = await body(r, 'withdraw');
    const res = await post(r, 'withdraw', { ...b, payload: { ...b.payload, recipientEncryptionKey: '55'.repeat(32) } });
    expect(res.status).toBe(202);
    expect(r.queued()).toBe(1);
  });
});

describe('a withdrawal to a wallet binds its encryption key when F-B6 is on (RELAY_WITHDRAW_RECIPIENT_ENVELOPE)', () => {
  const KEY = '55'.repeat(32);
  /** A withdraw to a wallet: the Passport call (which cannot cover the key) and, optionally, a
   *  RelayAction envelope over the whole body by `envelopeSigner`, for `signedKey`. */
  async function withdrawTo(
    r: Relay,
    opts: { sentKey?: string; signedKey?: string; envelopeSigner?: Device | null } = {},
  ) {
    const b = await body(r, 'withdraw');
    const signedPayload = { ...b.payload, recipientEncryptionKey: opts.signedKey ?? KEY };
    const payload = { ...b.payload, recipientEncryptionKey: opts.sentKey ?? opts.signedKey ?? KEY };
    const envelopeSigner = opts.envelopeSigner === undefined ? r.device : opts.envelopeSigner;
    if (!envelopeSigner) return { ...b, payload };
    const nonce = ((await (await r.app.request(API_PATHS.nonce)).json()) as { nonce: string }).nonce;
    const message = buildRelayActionMessage({
      action: 'withdraw',
      network: r.config.network.name,
      owner: envelopeSigner.envelope.deviceKey,
      account: ACCOUNT,
      payload: signedPayload,
      nonce,
      expiry: Math.floor(Date.now() / 1000) + 120,
    });
    const signature = envelopeSigner.envelope.signEnvelope(message);
    return { ...b, payload, auth: { message, signature } };
  }

  it('accepts the call with an envelope over the whole body, by the same device', async () => {
    const r = productionRelay({ fb6: true });
    expect((await post(r, 'withdraw', await withdrawTo(r))).status).toBe(202);
    expect(r.queued()).toBe(1);
  });

  it('refuses a changed encryption key after signing, a missing envelope, or another signer, before any work', async () => {
    let r = productionRelay({ fb6: true });
    await refused(
      r,
      await post(r, 'withdraw', await withdrawTo(r, { sentKey: '66'.repeat(32) })),
      401,
      'payload-mismatch',
    );
    r = productionRelay({ fb6: true });
    await refused(r, await post(r, 'withdraw', await withdrawTo(r, { envelopeSigner: null })), 401, 'malformed');
    r = productionRelay({ fb6: true });
    await refused(
      r,
      await post(r, 'withdraw', await withdrawTo(r, { envelopeSigner: newDevice() })),
      401,
      'wrong-signer',
    );
    // The Passport signature was given back each time: the honest call still goes through.
    expect((await post(r, 'withdraw', await withdrawTo(r))).status).toBe(202);
  });
});

describe('append-inbox entitlements (security review F-B3)', () => {
  const code = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;

  it('refuses an append without a valid entitlement before any proof or spend', async () => {
    const r = productionRelay();
    // none
    let e = await refused(r, await post(r, 'append-inbox', await body(r, 'append-inbox', { entitlement: null })), 403);
    expect(e.error.code).toBe('no-entitlement');
    // forged: right shape, wrong MAC
    const forged = r.entitlements.issue(ACCOUNT, 'withdraw:x').replace(/[0-9a-f]{64}$/, '0'.repeat(64));
    e = await refused(
      r,
      await post(r, 'append-inbox', await body(r, 'append-inbox', { entitlement: forged, n: 1 })),
      403,
    );
    expect(e.error.code).toBe('no-entitlement');
    // another account's
    const theirs = r.entitlements.issue('77'.repeat(32), 'withdraw:y');
    e = await refused(
      r,
      await post(r, 'append-inbox', await body(r, 'append-inbox', { entitlement: theirs, n: 2 })),
      403,
    );
    expect((e.error as { message?: string }).message).toContain('another account');
    // issued by another relay (another key)
    const other = testEntitlements({ key: new Uint8Array(32).fill(9) }).issue(ACCOUNT, 'withdraw:z');
    e = await refused(
      r,
      await post(r, 'append-inbox', await body(r, 'append-inbox', { entitlement: other, n: 3 })),
      403,
    );
    expect(e.error.code).toBe('no-entitlement');
    expect(r.rt.reads).toBeGreaterThan(0); // the signature was checked; only then the entitlement
  });

  it('accepts a valid entitlement once: a second append with it is refused', async () => {
    const r = productionRelay();
    const token = r.entitlements.issue(ACCOUNT, 'withdraw:tx-1');
    expect((await post(r, 'append-inbox', await body(r, 'append-inbox', { entitlement: token, n: 0 }))).status).toBe(
      202,
    );
    // Another entry (a new signature), the same entitlement: refused while the first is queued …
    const again = await post(r, 'append-inbox', await body(r, 'append-inbox', { entitlement: token, n: 1 }));
    expect(again.status).toBe(403);
    expect(await code(again)).toBe('no-entitlement');
    // … and for good once the first landed.
    r.entitlements.spend(token);
    const later = await post(r, 'append-inbox', await body(r, 'append-inbox', { entitlement: token, n: 2 }));
    expect(later.status).toBe(403);
    expect(r.queued()).toBe(1);
  });

  it('caps appends per account per day as a backstop', async () => {
    const r = productionRelay({ appendsPerDay: 2 });
    const statuses: number[] = [];
    for (let n = 0; n < 3; n++)
      statuses.push((await post(r, 'append-inbox', await body(r, 'append-inbox', { n }))).status);
    expect(statuses).toEqual([202, 202, 429]);
    expect(r.queued()).toBe(2);
  });
});

describe('append-inbox daily allowance on refusals (security review F-B7)', () => {
  it('full-queue refusals charge nothing: once capacity returns, the whole allowance is there', async () => {
    const r = productionRelay({
      appendsPerDay: 3,
      env: { JOB_MAX: '10', RATE_LIMIT_ACTIONS_PER_MIN: '1000', RATE_LIMIT_ACTIONS_PER_OWNER_PER_MIN: '1000' },
    });
    // Fill the relay: nine jobs of other customers (each in its own account lane, so each runs)
    // beside the prover-lane holder, all held until `open`.
    let open!: () => void;
    const gate = new Promise<Record<string, unknown>>((resolve) => (open = () => resolve({})));
    const fillers = Array.from({ length: 9 }, (_, i) =>
      r.queue.submit({
        action: 'append-inbox',
        lane: 'account',
        account: (0x10 + i).toString(16).repeat(32),
        payload: {},
        executor: () => gate,
      })!,
    );
    expect(r.queue.stats().jobs).toBe(10);

    // The customer retries the same change's append while the relay is full: twice the allowance.
    const token = r.entitlements.issue(ACCOUNT, 'withdraw:tx-busy');
    const busy: Array<[number, string]> = [];
    for (let n = 0; n < 6; n++) {
      const res = await post(r, 'append-inbox', await body(r, 'append-inbox', { entitlement: token, n }));
      busy.push([res.status, ((await res.json()) as { error: { code: string } }).error.code]);
    }
    expect(busy).toEqual(Array.from({ length: 6 }, () => [503, 'busy']));
    expect(r.queue.stats().jobs).toBe(10);
    expect(r.sponsor.walletCalls).toBe(0);

    // Capacity returns.
    open();
    await Promise.all(fillers.map((f) => r.queue.settled(f.requestId)));

    // The retried append is admitted, and so is the rest of the day's allowance (3) …
    const statuses = [
      (await post(r, 'append-inbox', await body(r, 'append-inbox', { entitlement: token, n: 6 }))).status,
    ];
    for (let n = 7; n < 9; n++)
      statuses.push((await post(r, 'append-inbox', await body(r, 'append-inbox', { n }))).status);
    expect(statuses).toEqual([202, 202, 202]);
    // Room was made by dropping three of the finished fillers: full again, with the three appends.
    expect(r.queue.stats().jobs).toBe(10);

    // … and only then is the allowance used up. The refusal says what was counted: appends the
    // market queued, not entries filed (a queued append can still fail).
    const over = await post(r, 'append-inbox', await body(r, 'append-inbox', { n: 9 }));
    expect(over.status).toBe(429);
    const e = (await over.json()) as { error: { code: string; message: string } };
    expect(e.error.code).toBe('append-budget');
    expect(e.error.message).toContain('3 inbox appends queued');
    expect(e.error.message).not.toMatch(/filed/);
  });

  it('an error while queuing gives back the entitlement and the charge as well', async () => {
    const r = productionRelay({ appendsPerDay: 1 });
    const submit = r.queue.submit.bind(r.queue);
    r.queue.submit = () => {
      throw new Error('the queue failed');
    };
    const token = r.entitlements.issue(ACCOUNT, 'withdraw:tx-error');
    const failed = await post(r, 'append-inbox', await body(r, 'append-inbox', { entitlement: token, n: 0 }));
    expect(failed.status).toBe(500);
    r.queue.submit = submit;
    // Neither the entitlement (403) nor the only append of the day (429) was used up.
    expect((await post(r, 'append-inbox', await body(r, 'append-inbox', { entitlement: token, n: 1 }))).status).toBe(
      202,
    );
  });
});

describe('read routes leak nothing secret', () => {
  it('health, config, nonces, jobs and the queue carry no secret and no job input', async () => {
    const seed = 'fa'.repeat(32);
    const files: Record<string, string> = { '/t': JSON.stringify(LOCAL_TOKENS), '/seed': `SEED=${seed}\n` };
    const { config, secrets } = loadConfig(
      { RELAY_NETWORK: 'undeployed', TOKENS_FILE: '/t', SPONSOR_SEED_FILE: '/seed' },
      (p) => files[p]!,
    );
    expect(secrets.sponsorSeedHex).toBe(seed);
    const r = productionRelay();
    const health = healthCollector({
      network: config.network.name,
      version: 'test',
      startedAt: 0,
      sponsor: r.sponsor,
      dustLowSpecks: config.sponsor.dustLowSpecks,
      prover: new ProofServerClient('http://prover.test', '9.0.0-rc.8', (async () => {
        throw new TypeError('down');
      }) as unknown as typeof fetch),
      dustProver: new ProofServerClient('http://dust-prover.test', '9.0.0-rc.6', (async () => {
        throw new TypeError('down');
      }) as unknown as typeof fetch),
      keys: () => ({
        present: false,
        fingerprint: null,
        pinned: false,
        matchesPin: null,
        missingProverKeys: [],
        missingVerifierKeys: [],
        missingZkir: [],
        mismatchedVerifierKeys: [],
      }),
      queue: r.queue,
      probes: httpProbes({
        kernelUrl: 'http://kernel.test',
        batcherUrl: 'http://batcher.test',
        log: r.log,
        fetchImpl: (async () => new Response(JSON.stringify({ status: 'ok' }))) as unknown as typeof fetch,
      }),
      cacheSeconds: 0,
    });
    const texts: string[] = [JSON.stringify(await health())];

    // A job carrying a coin and a signature: its view shows neither.
    const b = await body(r, 'withdraw');
    const posted = (await (await post(r, 'withdraw', b)).json()) as { job: { requestId: string } };
    for (const path of ['/v1/config', API_PATHS.nonce, API_PATHS.queue, API_PATHS.job(posted.job.requestId)]) {
      const res = await r.app.request(path);
      expect(res.status, path).toBeLessThan(500);
      texts.push(await res.text());
    }
    const all = texts.join('\n');
    expect(all).not.toContain(seed);
    const signature = b.passportAuth!.signature;
    for (const input of [signature, '33'.repeat(32), 'passportAuth', '"payload"', '"auth"']) {
      expect(all).not.toContain(input);
    }
    // The log never saw the body either.
    expect(r.log.lines.join('\n')).not.toContain(signature);
    // A random secret-looking value never appears either (no echo of arbitrary input).
    expect(all).not.toContain(randomBytes(16).toString('hex'));
  });
});

// AA 00060 P10.3 C2 (F-A2, F-B2): Bridge out's two unsigned actions name an account and a device key. An
// INVALID one must cost the named victim nothing: not its per-owner allowance, not its one-job gate.
describe('C2: unsigned Bridge-out requests cannot spend a named victim’s allowance or gate', () => {
  const ATTACKER = '203.0.113.9';
  const randHex = () => randomBytes(32).toString('hex');
  const entitleBody = (deviceKey: string) => ({
    account: ACCOUNT,
    payload: {
      tx1Hash: randHex(),
      spentCoin: { nonce: randHex(), color: COLOUR_A, value: '5000000' },
      amount: '1000000',
      landingCoinPublicKey: randHex(),
      deviceKey,
      useCounter: '0',
    },
  });
  const bridgeOutBody = (deviceKey: string) => ({
    account: ACCOUNT,
    payload: {
      kind: 'lock',
      entitlement: `le1.${ACCOUNT}.${'11'.repeat(32)}.9999999999.${'22'.repeat(32)}`,
      landing: { deviceKey, coinPublicKey: 'cc'.repeat(32), colour: COLOUR_A, amount: '1000000' },
      tx: '00',
      proven: false,
      blockHash: 'ab'.repeat(32),
    },
  });

  it('invalid bridge-out-entitle requests naming the victim: refused before the queue; the victim still withdraws', async () => {
    const r = productionRelay({ env: { JOBS_PER_ACCOUNT: '1' }, bridgeOut: true });
    const victim = r.device.calls.deviceKey;
    for (let i = 0; i < 5; i++) {
      const res = await post(r, 'bridge-out-entitle', entitleBody(victim), ATTACKER);
      expect(res.status, `request ${i + 1}`).toBe(403);
    }
    expect(r.queued()).toBe(0);
    const w = await post(r, 'withdraw', await body(r, 'withdraw'));
    expect(w.status).toBe(202);
  });

  it('bridge-out with a forged entitlement naming the victim: refused before the owner allowance is charged', async () => {
    const r = productionRelay({ env: { JOBS_PER_ACCOUNT: '1' }, bridgeOut: true });
    const victim = r.device.calls.deviceKey;
    for (let i = 0; i < 5; i++) {
      const res = await post(r, 'bridge-out', bridgeOutBody(victim), ATTACKER);
      expect(res.status, `request ${i + 1}`).toBe(403);
    }
    const w = await post(r, 'withdraw', await body(r, 'withdraw'));
    expect(w.status).toBe(202);
  });

  it('unauthenticated requests have their own per-client budget (each naming a fresh device)', async () => {
    const r = productionRelay({ bridgeOut: true, env: { RATE_LIMIT_UNAUTHENTICATED_PER_MIN: '4' } });
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++)
      statuses.push((await post(r, 'bridge-out-entitle', entitleBody(randHex()), ATTACKER)).status);
    expect(statuses.slice(0, 4).every((s) => s === 403)).toBe(true);
    expect(statuses.slice(4)).toEqual([429, 429]);
    // Another client is not affected.
    expect((await post(r, 'bridge-out-entitle', entitleBody(randHex()), '198.51.100.99')).status).toBe(403);
  });
});
