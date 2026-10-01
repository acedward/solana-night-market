// A relay for the lane and per-account-cap tests (AA 00047 P10, audit round 2 R2-1): the relay's real
// route, queue, trade admission (the signed expiry) and passport-call authoriser (the replay guard),
// with the arm's signature check accepting (as it would for each account's own genuine signatures:
// each make carries a fresh want nonce, each cancel a fresh nonce, so fresh digests). Rate limits are
// off (the worst case) unless `env` sets them. The executors stand for the stagenet jobs, scaled down.

import { createHash } from 'node:crypto';

import { CancelOffersPayloadSchema, RestoreEncKeyPayloadSchema } from '@nightmarket/core';

import { AccountCaps } from '../src/actions/account-caps.js';
import { FailureBudget } from '../src/actions/failure-budget.js';
import { defaultCatalogue, withAccountCaps, withTrade } from '../src/actions/catalogue.js';
import { passportCallAuthoriser } from '../src/auth/passport-call.js';
import { DigestReplayGuard } from '../src/auth/verifiers.js';
import type { DeviceArm } from '../src/passport/arm.js';
import type { JobExecutor } from '../src/queue/jobs.js';
import { harness, testConfig } from './harness.js';

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const ATTACKER_ACCOUNT = '11'.repeat(32);
export const CUSTOMER_ACCOUNT = '33'.repeat(32);
export const ATTACKER = 'a7'.repeat(32);
export const CUSTOMER = 'c5'.repeat(32);

export function laneRelay(o: {
  proofMs: number;
  listingMs: number;
  withdrawMs: number;
  env?: Record<string, string>;
  /** Wire the per-account caps (as main.ts does). */
  caps?: AccountCaps | true;
  /** Replace an executor (e.g. a failing make). */
  executors?: Partial<
    Record<'open-swap' | 'take' | 'cancel-offers' | 'restore-enc-key' | 'withdraw' | 'withdraw-unshielded', JobExecutor>
  >;
  /** Wire the failure budget (as main.ts does). */
  failures?: FailureBudget | true;
  /** Who signs for an account (default: the attacker for the attacker's account, else the customer). */
  signerOf?: (account: string | undefined) => string;
}) {
  const proofs: string[] = [];
  const catalogue = withTrade(defaultCatalogue(), {} as never);
  catalogue.set('open-swap', {
    ...catalogue.get('open-swap')!,
    executor:
      o.executors?.['open-swap'] ??
      (async (_p, ctx) => {
        await ctx.prove(async () => {
          proofs.push('attacker-make');
          await sleep(o.proofMs);
        });
        await sleep(o.listingMs); // the kernel's listing wait
        return { offerId: `${proofs.length}`.padStart(64, '0') };
      }),
  });
  catalogue.set('cancel-offers', {
    ...catalogue.get('cancel-offers')!,
    auth: 'passport-call',
    payload: CancelOffersPayloadSchema,
    executor:
      o.executors?.['cancel-offers'] ??
      (async (_p, ctx) =>
        ctx.prove(async () => {
          proofs.push('attacker-cancel');
          await sleep(o.proofMs);
          return { txId: 'c' };
        })),
  });
  catalogue.set('restore-enc-key', {
    ...catalogue.get('restore-enc-key')!,
    auth: 'passport-call',
    payload: RestoreEncKeyPayloadSchema,
    executor:
      o.executors?.['restore-enc-key'] ??
      (async (_p, ctx) =>
        ctx.prove(async () => {
          proofs.push('restore');
          await sleep(o.proofMs);
          return { txId: 'r' };
        })),
  });
  catalogue.set('take', {
    ...catalogue.get('take')!,
    executor: o.executors?.take ?? (async (_p, ctx) => ctx.prove(async () => ({ txHash: 't' }))),
  });
  catalogue.set('withdraw-unshielded', {
    ...catalogue.get('withdraw-unshielded')!,
    auth: 'passport-call',
    payload: { safeParse: (d: unknown) => ({ success: true, data: d }) } as never,
    executor: o.executors?.['withdraw-unshielded'] ?? (async (_p, ctx) => ctx.prove(async () => ({ txId: 'u' }))),
  });
  catalogue.set('withdraw', {
    ...catalogue.get('withdraw')!,
    auth: 'passport-call',
    payload: { safeParse: (d: unknown) => ({ success: true, data: d }) } as never,
    executor:
      o.executors?.withdraw ??
      (async (_p, ctx) =>
        ctx.prove(async () => {
          proofs.push('customer-withdraw');
          await sleep(o.withdrawMs);
          return { txId: 'w' };
        })),
  });
  const config = testConfig({
    RATE_LIMIT_ACTIONS_PER_MIN: '100000',
    RATE_LIMIT_ACTIONS_PER_OWNER_PER_MIN: '100000',
    ...o.env,
  });
  const caps = o.caps === true ? new AccountCaps(config.accountCaps) : o.caps;
  if (caps) withAccountCaps(catalogue, caps);
  const failures = o.failures === true ? new FailureBudget(config.failureBudget) : o.failures;
  const signerOf =
    o.signerOf ?? ((account: string | undefined) => (account === ATTACKER_ACCOUNT ? ATTACKER : CUSTOMER));
  const ok = (action: string, account: string | undefined, payload: unknown) => ({
    ok: true,
    account,
    signer: signerOf(account),
    payload,
    passport: {},
    auth: {},
    ledger: {},
    digestHex: createHash('sha256')
      .update(`${action}|${JSON.stringify(payload)}`)
      .digest('hex'),
  });
  const arm = {
    checkTradeCall: async (_rt: unknown, a: string, account: string, payload: unknown) => ok(a, account, payload),
    checkGatedCall: async (_rt: unknown, a: string, account: string, payload: unknown) => ok(a, account, payload),
  } as unknown as DeviceArm;
  const replay = new DigestReplayGuard(3600);
  const h = harness({
    config,
    catalogue,
    passportCall: passportCallAuthoriser(() => ({}) as never, arm, replay),
    ...(failures ? { failures } : {}),
  });
  const post = async (action: string, account: string, payload: unknown, owner: string) => {
    const res = await h.app.request(`/v1/actions/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account, payload, passportAuth: { owner, signature: '00'.repeat(64), useCounter: '0' } }),
    });
    const body = (await res.json()) as { job?: { requestId: string }; error?: { code: string } };
    return {
      status: res.status,
      code: body.error?.code,
      retryAfter: res.headers.get('retry-after'),
      id: body.job?.requestId,
    };
  };
  /** Wait for a job, and for the route's end-of-job hooks to run. */
  const settle = async (id?: string) => {
    if (id) await h.queue.settled(id);
    await sleep(0);
  };
  const now = Math.floor(Date.now() / 1000);
  const make = (i: number, over: { authNonce?: string; validUntil?: string } = {}) => ({
    giveColor: 'aa'.repeat(32),
    giveAmount: String(1000 + i),
    wantColor: 'bb'.repeat(32),
    wantAmount: '1',
    wantNonce: i.toString(16).padStart(64, '0'),
    wantEntry: '00'.repeat(192),
    changeEntry: '00'.repeat(192),
    validUntil: over.validUntil ?? String(now + 1800),
    coin: { nonce: 'cc'.repeat(32), color: 'aa'.repeat(32), value: '100000', mtIndex: '0' },
    authNonce: over.authNonce ?? '0',
  });
  const cancel = (i: number, authNonce = '0') => ({
    newKey: (i % 256).toString(16).padStart(2, '0').repeat(32),
    authNonce,
  });
  const restore = (i: number, authNonce = '0') => ({
    newKey: ((i + 7) % 256).toString(16).padStart(2, '0').repeat(32),
    authNonce,
  });
  const take = (i: number, authNonce = '0') => ({
    ...make(i, { authNonce, validUntil: String(now + 300) }),
    offerId: (i % 256).toString(16).padStart(2, '0').repeat(32),
  });
  return { h, config, caps, failures, post, settle, proofs, make, take, cancel, restore };
}
