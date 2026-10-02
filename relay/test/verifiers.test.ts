// The passport-call authoriser (a gated call's own signature, one prompt per action) through a
// device arm (here the TEST arm, ./fake-arm.ts; the Ed25519 arm is lane B3's), the replay guard,
// and the sponsor key derivation over the pinned wallet SDK (no network).

import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';
import type { ActionRequest, WithdrawPayload } from '@nightmarket/core';

import { defaultCatalogue } from '../src/actions/catalogue.js';
import { passportCallAuthoriser } from '../src/auth/passport-call.js';
import { DigestReplayGuard } from '../src/auth/verifiers.js';
import { deriveSponsorKeys } from '../src/sponsor/facade.js';
import { callSigner, fakeAccountRuntime, testArm } from './fake-arm.js';

const ACCOUNT = 'cd'.repeat(32);
const payload: WithdrawPayload = {
  recipient: '11'.repeat(32),
  color: '22'.repeat(32),
  amount: '1500000',
  coin: { nonce: '33'.repeat(32), color: '22'.repeat(32), value: '5000000', mtIndex: '42' },
  authNonce: '7',
};
const withdraw = defaultCatalogue().get('withdraw')!;

function setup(opts: { liveDevice?: boolean; authNonce?: bigint } = {}) {
  const device = callSigner();
  const other = callSigner();
  const rt = fakeAccountRuntime(
    ACCOUNT,
    [opts.liveDevice === false ? other.deviceKey : device.deviceKey],
    opts.authNonce ?? 7n,
  );
  const replay = new DigestReplayGuard(600);
  const authorise = passportCallAuthoriser(() => rt, testArm, replay);
  const request = (over: Partial<ActionRequest> = {}): ActionRequest => ({
    account: ACCOUNT,
    payload: payload as unknown as Record<string, unknown>,
    passportAuth: device.passportAuth('withdraw', ACCOUNT, payload as unknown as Record<string, unknown>),
    ...over,
  });
  return { device, rt, replay, authorise, request };
}

describe('the passport-call authoriser', () => {
  it('accepts a live device signing the current auth nonce, once', async () => {
    const s = setup();
    const r = await s.authorise(withdraw, s.request());
    expect(r).toMatchObject({ ok: true, signer: s.device.deviceKey, kind: 'passport-call', account: ACCOUNT });
    expect(await s.authorise(withdraw, s.request())).toMatchObject({ ok: false, code: 'replayed' });
    // A refused request gives its digest back, so the same signature can be sent again later.
    if (r.ok) r.release?.();
    expect(await s.authorise(withdraw, s.request())).toMatchObject({ ok: true });
  });

  it('refuses a signer that is not a live device of the account', async () => {
    const s = setup({ liveDevice: false });
    expect(await s.authorise(withdraw, s.request())).toMatchObject({ ok: false, code: 'wrong-signer' });
  });

  it('refuses a stale authorisation (the account moved on)', async () => {
    const s = setup({ authNonce: 8n });
    expect(await s.authorise(withdraw, s.request())).toMatchObject({ ok: false, code: 'expired' });
  });

  it('refuses missing or garbage signatures, changed arguments and another account', async () => {
    const s = setup();
    expect(await s.authorise(withdraw, s.request({ passportAuth: undefined }))).toMatchObject({ code: 'malformed' });
    const auth = s.request().passportAuth as { owner: string; useCounter: string };
    expect(
      await s.authorise(withdraw, s.request({ passportAuth: { ...auth, signature: '00'.repeat(64) } })),
    ).toMatchObject({ code: 'bad-signature' });
    expect(
      await s.authorise(withdraw, s.request({ payload: { ...payload, amount: '1500001' } as never })),
    ).toMatchObject({ code: 'bad-signature' });
    expect(await s.authorise(withdraw, s.request({ payload: { nope: 1 } }))).toMatchObject({ code: 'malformed' });
    expect(await s.authorise(withdraw, s.request({ account: 'ef'.repeat(32) }))).toMatchObject({
      code: 'wrong-account',
    });
  });

  it('refuses actions a Passport signature does not authorise, and says so while no runtime is loaded', async () => {
    const s = setup();
    const register = defaultCatalogue().get('register')!;
    expect(await s.authorise(register, s.request())).toMatchObject({ ok: false, code: 'not-supported' });
    const noRuntime = passportCallAuthoriser(() => null, testArm, s.replay);
    expect(await noRuntime(withdraw, s.request())).toMatchObject({ ok: false, code: 'not-supported' });
  });
});

describe('sponsor keys', () => {
  it('derive three 32-byte role keys from a seed with the pinned HD wallet, deterministically', async () => {
    const hd = await import('@midnightntwrk/wallet-sdk-hd');
    const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
    const seed = randomBytes(64).toString('hex');
    const a = deriveSponsorKeys(hd, seed);
    const b = deriveSponsorKeys(hd, seed);
    expect(a.zswap).toHaveLength(32);
    expect(a.night).toHaveLength(32);
    expect(a.dust).toHaveLength(32);
    expect(hex(a.zswap)).toBe(hex(b.zswap));
    expect(hex(a.zswap)).not.toBe(hex(a.dust));
  });
});
