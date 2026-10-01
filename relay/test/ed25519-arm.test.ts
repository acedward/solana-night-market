// The relay's Ed25519 arm (../src/passport/ed25519-arm.ts, B1.5 seam, B3 checks) on Track A's client,
// and the relay's runtime split (spike 3 §6): the SDK (compact-js, midnight-js) resolves
// compact-runtime 0.19.0, the compiled account module 0.20.0, over one onchain-runtime-v4.
//
// B3 REQUEST AUTH: the browser signs a call's F3 message with the wallet (here tweetnacl, Phantom's
// scheme), and the relay accepts the request only when that signature verifies over the message it
// REBUILDS from the call's arguments and the account's state: valid → ok; another key, another
// account, another network (label or salt), an older nonce (a replay), a changed argument → refused,
// before any proving time; the same approval twice → refused by the replay guard.

import { createRequire } from 'node:module';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createHash, randomBytes } from 'node:crypto';

import {
  registryFor,
  type AppendInboxPayload,
  type CancelOffersPayload,
  type OpenSwapPayload,
  type RestoreEncKeyPayload,
  type WithdrawPayload,
  type WithdrawUnshieldedPayload,
} from '@nightmarket/core';
import {
  appendInboxRequest,
  callContext,
  cancelOffersRequest,
  ed25519DeviceOf,
  openSwapArgs,
  passportAuthOf,
  restoreEncKeyRequest,
  withdrawRequest,
  withdrawUnshieldedRequest,
} from '@nightmarket/core/passport';
import nacl from 'tweetnacl';
import { describe, expect, it } from 'vitest';

import {
  Ed25519Device,
  ed25519AuthArgs,
  type Ed25519Authorisation,
} from '../../vendor/passport/contract/src/wallet/ed25519.js';
import {
  ED25519_SWAP_CIRCUIT,
  contractForEd25519Account,
  ed25519AccountCircuits,
  ed25519AccountWaves,
} from '../../vendor/passport/contract/src/wallet/wave-deploy.js';
import { makeWitnesses } from '../../vendor/passport/contract/src/wallet/witnesses.js';
import { SWAP_CIRCUIT, accountCircuitIds, accountWaves } from '../src/passport/account-shape.js';
import { passportCallAuthoriser } from '../src/auth/passport-call.js';
import { DigestReplayGuard } from '../src/auth/verifiers.js';
import { accountCatalogue } from '../src/actions/catalogue.js';
import { ARM_CIRCUITS, DEVICE_ARM, wiredArm } from '../src/passport/arm.js';
import { ed25519Arm, ed25519ArmAuthArgs } from '../src/passport/ed25519-arm.js';
import type { AccountLedger, PassportRuntime } from '../src/passport/runtime.js';

const tokens = registryFor('stagenet');
const arm = ed25519Arm({ network: 'stagenet', tokens });
const rt = {} as PassportRuntime;

describe("the relay's Ed25519 arm (B1.5 seam on Track A's client)", () => {
  it("names Track A's circuits, and the market account is Track A's ed25519 account with the offer circuit", () => {
    expect(arm.name).toBe(DEVICE_ARM);
    expect(DEVICE_ARM).toBe('ed25519');
    expect(SWAP_CIRCUIT).toBe(ED25519_SWAP_CIRCUIT);
    expect(ARM_CIRCUITS.openSwap).toBe(ED25519_SWAP_CIRCUIT);
    const shape = ed25519AccountCircuits({ withSwap: true });
    expect(accountCircuitIds()).toEqual(shape);
    expect(accountWaves()).toEqual(ed25519AccountWaves({ withSwap: true }));
    for (const c of Object.values(ARM_CIRCUITS)) expect(shape).toContain(c);
    // The compiled account restricted to that shape keeps exactly those circuits.
    const Restricted = contractForEd25519Account({ withSwap: true });
    const ours = new Restricted(makeWitnesses() as never) as unknown as { provableCircuits: object };
    expect(Object.keys(ours.provableCircuits).sort()).toEqual([...shape].sort());
  });

  it("expands an authorisation to the circuit's trailing arguments exactly as Track A's client does", () => {
    const auth = {
      arm: 'ed25519',
      pk: { x: 1n, y: 2n },
      use_counter: 7n,
      sig: { r: { x: 3n, y: 4n }, s: 5n },
      show: { label: [], nonce: { digits: [], top: 0n } },
    } as unknown as Ed25519Authorisation;
    expect(ed25519ArmAuthArgs(auth)).toEqual(ed25519AuthArgs(auth));
    expect(arm.authArgs(auth)).toEqual([auth.pk, 7n, auth.sig, auth.show]);
  });

  it("enrols the wallet's key as Track A's device, with the arm's own entry derivation", async () => {
    const seed = new Uint8Array(32).fill(7);
    const wallet = Ed25519Device.fromSeed(seed);
    const { device, entryAt } = await arm.registrationDevice(rt, { deviceKey: wallet.publicKeyHex, body: {} });
    expect(device).toBeInstanceOf(Ed25519Device);
    expect(device.publicKeyHex).toBe(wallet.publicKeyHex);
    expect(device.label).toBe('Night Market - stagenet');
    const account = new Uint8Array(32).fill(9);
    expect(entryAt(account, 0n, 1n)).toEqual(wallet.entryAt(account, 0n, 1n));
    // A key that is not a prime-order point is refused at enrolment.
    await expect(arm.registrationDevice(rt, { deviceKey: `01${'00'.repeat(31)}`, body: {} })).rejects.toThrow(
      /identity/,
    );
  });
});

// ── B3: request auth by the call's own F3 signature ─────────────────────────

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const unhex = (h: string) => Uint8Array.from(Buffer.from(h, 'hex'));
const twUSDC = tokens.bySymbol('twUSDC')!.midnightColour;
const twBTC = tokens.bySymbol('twBTC')!.midnightColour;
const utwUSDC = tokens.bySymbol('utwUSDC')!.midnightColour;

/** A wallet key (tweetnacl: the RFC 8032 scheme Phantom's `signMessage` uses). */
function wallet(seed = new Uint8Array(randomBytes(32))) {
  const kp = nacl.sign.keyPair.fromSeed(seed);
  const deviceKey = hex(kp.publicKey);
  return {
    deviceKey,
    address: '',
    signMessage: async (m: Uint8Array) => nacl.sign.detached(m, kp.secretKey),
  };
}
type Wallet = ReturnType<typeof wallet>;

interface FakeAccount {
  account: string;
  salt: string;
  /** The account's encryption key on chain (its ledger `enc_key`). */
  encKey: string;
  authNonce: bigint;
  devices: Set<string>;
}

/** A runtime whose accounts are `accounts`, each booted with its devices live at use counter 0. */
function runtimeOf(...accounts: FakeAccount[]): PassportRuntime {
  const byAddress = new Map(accounts.map((a) => [a.account, a]));
  return {
    ledgerState: async (address: string) => {
      const a = byAddress.get(address);
      if (!a) return null;
      const ledger: Partial<AccountLedger> = {
        booted: true,
        device_count: BigInt(a.devices.size),
        device_epoch: 0n,
        auth_nonce: a.authNonce,
        inbox_count: 0n,
        enc_key: unhex(a.encKey),
        evm_domain_salt: unhex(a.salt),
        devices: {
          member: (e: Uint8Array) => a.devices.has(hex(e)),
          [Symbol.iterator]: () => [...a.devices].map(unhex)[Symbol.iterator](),
        },
      };
      return ledger as AccountLedger;
    },
  } as unknown as PassportRuntime;
}

/** An account controlled by `owner` (its entry at epoch 0, counter 0 is live). */
function accountOf(owner: Wallet, authNonce = 5n): FakeAccount {
  const account = hex(randomBytes(32));
  const device = ed25519DeviceOf(owner, display);
  return {
    account,
    salt: hex(randomBytes(32)),
    encKey: hex(randomBytes(32)),
    authNonce,
    devices: new Set([hex(device.entryAt(unhex(account), 0n, 0n))]),
  };
}

const display = { network: 'stagenet', tokens } as const;

/** What the browser sends for a gated call: the payload and the wallet's PassportAuth over it. */
async function browserGated(
  owner: Wallet,
  a: FakeAccount,
  request: Parameters<ReturnType<typeof ed25519DeviceOf>['sign']>[1],
  opts: {
    network?: 'stagenet' | 'undeployed';
    salt?: string;
    account?: string;
    authNonce?: bigint;
    encKey?: string;
  } = {},
) {
  const device = ed25519DeviceOf(owner, { network: opts.network ?? 'stagenet', tokens });
  const ctx = callContext({
    account: opts.account ?? a.account,
    authNonce: opts.authNonce ?? a.authNonce,
    networkSalt: opts.salt ?? a.salt,
    encKey: opts.encKey ?? a.encKey,
  });
  return passportAuthOf(await device.sign(ctx, request, 0n));
}

function withdrawPayload(a: FakeAccount, over: Partial<WithdrawPayload> = {}): WithdrawPayload {
  return {
    recipient: '11'.repeat(32),
    color: twUSDC,
    amount: '10000000',
    coin: { nonce: '33'.repeat(32), color: twUSDC, value: '25000000', mtIndex: '42' },
    authNonce: String(a.authNonce),
    ...over,
  };
}

describe('B3: the relay authenticates an account call by its own F3 signature (one prompt)', () => {
  it("accepts a withdrawal the account's wallet signed, and returns the authorisation the circuit takes", async () => {
    const owner = wallet();
    const a = accountOf(owner);
    const rt = runtimeOf(a);
    const p = withdrawPayload(a);
    const passportAuth = await browserGated(owner, a, withdrawRequest(p));
    const r = await arm.checkGatedCall(rt, 'withdraw', a.account, p, passportAuth);
    if (!r.ok) throw new Error(`refused: ${r.code} ${r.reason}`);
    expect(r.signer).toBe(owner.deviceKey);
    expect(r.account).toBe(a.account);
    expect(r.auth.arm).toBe('ed25519');
    const text = new TextDecoder().decode(r.auth.message);
    expect(text).toMatch(/^Night Market - stagenet *\nWithdraw shielded\n/);
    // F3 v2 (AA 00047 P9.C/P9.I; questions Q25 B′, Q32): the relay renders what the circuit renders:
    // the enforced base units and full token id, the site's reading marked as its label.
    expect(text.split('\n').slice(2, 6)).toEqual([
      `Base units ${'10000000'.padEnd(24)}`,
      `Token ${twUSDC}`,
      `This site labels it: ${'10.000000 twUSDC'.padEnd(34)}`,
      `To key ${'11'.repeat(8)}`,
    ]);
    expect(r.digestHex).toBe(createHash('sha256').update(r.auth.message).digest('hex'));
    expect(arm.authArgs(r.auth)).toHaveLength(4);
  });

  it('accepts an unshielded withdrawal and an inbox append the same way', async () => {
    const owner = wallet();
    const a = accountOf(owner);
    const rt = runtimeOf(a);
    const u: WithdrawUnshieldedPayload = {
      recipient: '44'.repeat(32),
      color: utwUSDC,
      amount: '2500000',
      authNonce: String(a.authNonce),
    };
    const ru = await arm.checkGatedCall(
      rt,
      'withdraw-unshielded',
      a.account,
      u,
      await browserGated(owner, a, withdrawUnshieldedRequest(u)),
    );
    expect(ru.ok).toBe(true);
    if (ru.ok) expect(new TextDecoder().decode(ru.auth.message)).toContain('Withdraw unshielded');
    const e: AppendInboxPayload = { entry: 'cd'.repeat(192), authNonce: String(a.authNonce) };
    const re = await arm.checkGatedCall(
      rt,
      'append-inbox',
      a.account,
      e,
      await browserGated(owner, a, appendInboxRequest(e)),
    );
    expect(re.ok).toBe(true);
  });

  it("refuses a signature by another key (in the owner's name), and a key that is not a device of the account", async () => {
    const owner = wallet();
    const stranger = wallet();
    const a = accountOf(owner);
    const rt = runtimeOf(a);
    const p = withdrawPayload(a);
    // The stranger signs, the request names the owner.
    const forged = { ...(await browserGated(stranger, a, withdrawRequest(p))), owner: owner.deviceKey };
    expect(await arm.checkGatedCall(rt, 'withdraw', a.account, p, forged)).toMatchObject({
      ok: false,
      code: 'bad-signature',
    });
    // The stranger signs in their own name: a valid signature, but not a device of this account.
    const theirs = await browserGated(stranger, a, withdrawRequest(p));
    expect(await arm.checkGatedCall(rt, 'withdraw', a.account, p, theirs)).toMatchObject({
      ok: false,
      code: 'wrong-signer',
    });
  });

  it('refuses a replay: an approval for an older auth nonce, and the same approval queued twice', async () => {
    const owner = wallet();
    const a = accountOf(owner, 5n);
    const rt = runtimeOf(a);
    const p = withdrawPayload(a);
    const passportAuth = await browserGated(owner, a, withdrawRequest(p));
    // The call landed: the account moved to nonce 6. The old approval (and its body) are stale.
    a.authNonce = 6n;
    expect(await arm.checkGatedCall(rt, 'withdraw', a.account, p, passportAuth)).toMatchObject({
      ok: false,
      code: 'expired',
    });
    // Resent with the body claiming the new nonce: the signature was over nonce 5.
    expect(await arm.checkGatedCall(rt, 'withdraw', a.account, { ...p, authNonce: '6' }, passportAuth)).toMatchObject({
      ok: false,
      code: 'bad-signature',
    });
    // At the right nonce, the same approval is accepted once by the route's replay guard.
    a.authNonce = 5n;
    const authorise = passportCallAuthoriser(() => rt, arm, new DigestReplayGuard(600));
    const catalogue = accountCatalogue({
      runtime: () => rt,
      arm,
      sponsor: {} as never,
      network: 'stagenet',
      replay: new DigestReplayGuard(600),
      entitlements: {} as never,
      log: {} as never,
    });
    const request = { account: a.account, payload: p as unknown as Record<string, unknown>, passportAuth };
    expect((await authorise(catalogue.get('withdraw')!, request)).ok).toBe(true);
    expect(await authorise(catalogue.get('withdraw')!, request)).toMatchObject({ ok: false, code: 'replayed' });
  });

  it('refuses an approval for another account', async () => {
    const owner = wallet();
    const a = accountOf(owner);
    const b = accountOf(owner);
    b.salt = a.salt; // same network salt: only the account differs
    const rt = runtimeOf(a, b);
    const p = withdrawPayload(a);
    const passportAuth = await browserGated(owner, a, withdrawRequest(p));
    expect(await arm.checkGatedCall(rt, 'withdraw', b.account, p, passportAuth)).toMatchObject({
      ok: false,
      code: 'bad-signature',
    });
  });

  it('refuses an approval for another network: another label, or another network salt', async () => {
    const owner = wallet();
    const a = accountOf(owner);
    const rt = runtimeOf(a);
    const p = withdrawPayload(a);
    // Signed in a local market ("Night Market - local"), sent to the stagenet relay.
    const local = await browserGated(owner, a, withdrawRequest(p), { network: 'undeployed' });
    expect(await arm.checkGatedCall(rt, 'withdraw', a.account, p, local)).toMatchObject({
      ok: false,
      code: 'bad-signature',
    });
    // Signed against another deployment's network salt.
    const otherSalt = await browserGated(owner, a, withdrawRequest(p), { salt: hex(randomBytes(32)) });
    expect(await arm.checkGatedCall(rt, 'withdraw', a.account, p, otherSalt)).toMatchObject({
      ok: false,
      code: 'bad-signature',
    });
  });

  it('refuses a body changed after signing (amount, recipient, coin)', async () => {
    const owner = wallet();
    const a = accountOf(owner);
    const rt = runtimeOf(a);
    const p = withdrawPayload(a);
    const passportAuth = await browserGated(owner, a, withdrawRequest(p));
    for (const changed of [
      { ...p, amount: '10000001' },
      { ...p, recipient: '12'.repeat(32) },
      { ...p, coin: { ...p.coin, mtIndex: '43' } },
    ]) {
      expect(await arm.checkGatedCall(rt, 'withdraw', a.account, changed, passportAuth)).toMatchObject({
        ok: false,
        code: 'bad-signature',
      });
    }
  });

  it('checks an offer (make or take) over the swap call, signed once', async () => {
    const owner = wallet();
    const a = accountOf(owner);
    const rt = runtimeOf(a);
    const make: OpenSwapPayload = {
      giveColor: twUSDC,
      giveAmount: '10000000',
      wantColor: twBTC,
      wantAmount: '20000',
      wantNonce: '11'.repeat(32),
      wantEntry: '22'.repeat(192),
      changeEntry: '00'.repeat(192),
      validUntil: '0',
      coin: { nonce: '33'.repeat(32), color: twUSDC, value: '30000000', mtIndex: '9' },
      authNonce: String(a.authNonce),
    };
    const device = ed25519DeviceOf(owner, display);
    const { call, coin } = openSwapArgs(make);
    const ctx = callContext({ account: a.account, authNonce: a.authNonce, networkSalt: a.salt, encKey: a.encKey });
    const passportAuth = passportAuthOf(await device.signOffer(ctx, call, coin, 0n));
    const ok = await arm.checkTradeCall(rt, 'open-swap', a.account, make, passportAuth);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      const lines = new TextDecoder().decode(ok.auth.message).split('\n');
      expect(lines[1]).toBe('Swap offer');
      expect(lines.slice(2, 8).map((l) => l.trimEnd())).toEqual([
        'Give base units 10000000',
        `Give token ${twUSDC}`,
        'This site labels it: 10.000000 twUSDC',
        'Get base units 20000',
        `Get token ${twBTC}`,
        'This site labels it: 0.00020000 twBTC',
      ]);
    }
    // A take is the same call (plus the offer id, which the take executor checks against the book).
    expect(
      (await arm.checkTradeCall(rt, 'take', a.account, { ...make, offerId: 'cd'.repeat(32) }, passportAuth)).ok,
    ).toBe(true);
    // The want changed after signing: refused.
    expect(
      await arm.checkTradeCall(rt, 'open-swap', a.account, { ...make, wantAmount: '20001' }, passportAuth),
    ).toMatchObject({ ok: false, code: 'bad-signature' });
  });

  it('refuses an account that is not a market account (FR-005) before any signature work', async () => {
    const owner = wallet();
    const a = accountOf(owner);
    const rt = runtimeOf(a);
    const p = withdrawPayload(a);
    const passportAuth = await browserGated(owner, a, withdrawRequest(p));
    const strict = ed25519Arm({
      network: 'stagenet',
      tokens,
      accountKeys: async () => ({ ok: false, reason: 'not a Night Market account' }),
    });
    expect(await strict.checkGatedCall(rt, 'withdraw', a.account, p, passportAuth)).toMatchObject({
      ok: false,
      code: 'wrong-account',
    });
  });

  it('refuses a signature over another site label for the same call (questions Q25 B′: the relay renders its own)', async () => {
    const owner = wallet();
    const a = accountOf(owner);
    const rt = runtimeOf(a);
    const p = withdrawPayload(a);
    // A page that labels twUSDC with other decimals: the base units and the token id are the same,
    // the site line differs, so the signed bytes are not the ones the relay (and the circuit) render.
    const lying = {
      ...tokens,
      byColour: (c: string) => {
        const t = tokens.byColour(c);
        return t && c === twUSDC ? { ...t, decimals: 2 } : t;
      },
    } as typeof tokens;
    const device = ed25519DeviceOf(owner, { network: 'stagenet', tokens: lying });
    const ctx = callContext({ account: a.account, authNonce: a.authNonce, networkSalt: a.salt, encKey: a.encKey });
    const signed = await device.sign(ctx, withdrawRequest(p), 0n);
    expect(new TextDecoder().decode(signed.message)).toContain('This site labels it: 100000.00 twUSDC');
    expect(await arm.checkGatedCall(rt, 'withdraw', a.account, p, passportAuthOf(signed))).toMatchObject({
      ok: false,
      code: 'bad-signature',
    });
  });

  it("wires Track A's arm and the Solana envelope scheme (wiredArm)", async () => {
    const wired = await wiredArm({ network: 'stagenet', tokens });
    expect(wired.arm.name).toBe('ed25519');
    expect(wired.scheme.id).toBe('solana-ed25519-possession-v1');
  });
});

describe('AA 00047 P9.I: cancel-offers (questions Q30) is rotate_enc_key with the account’s CURRENT key', () => {
  const cancel = (a: FakeAccount, newKey = a.encKey): CancelOffersPayload => ({
    newKey,
    authNonce: String(a.authNonce),
  });

  it('accepts a cancel the wallet signed as "Cancel all open offers"', async () => {
    const owner = wallet();
    const a = accountOf(owner);
    const rt = runtimeOf(a);
    const p = cancel(a);
    const r = await arm.checkGatedCall(
      rt,
      'cancel-offers',
      a.account,
      p,
      await browserGated(owner, a, cancelOffersRequest(p)),
    );
    if (!r.ok) throw new Error(`refused: ${r.code} ${r.reason}`);
    const lines = new TextDecoder().decode(r.auth.message).split('\n');
    expect(lines.slice(1, 3)).toEqual(['Cancel all open offers', 'Your key does not change']);
    expect(ARM_CIRCUITS.rotateEncKey).toBe('rotate_enc_key_with_ed25519');
  });

  it('refuses a key that is not the on-chain one, before any signature work (the market never changes a key)', async () => {
    const owner = wallet();
    const a = accountOf(owner);
    const rt = runtimeOf(a);
    const other = cancel(a, hex(randomBytes(32)));
    // Even a valid signature over that key change ("Rotate encryption key") is refused.
    const passportAuth = await browserGated(owner, a, cancelOffersRequest(other));
    expect(await arm.checkGatedCall(rt, 'cancel-offers', a.account, other, passportAuth)).toMatchObject({
      ok: false,
      code: 'malformed',
    });
  });

  it('refuses a cancel signed against another "current" key (other bytes), and an old nonce', async () => {
    const owner = wallet();
    const a = accountOf(owner);
    const rt = runtimeOf(a);
    const p = cancel(a);
    // The page believed the key was another one: its text read "Rotate encryption key".
    const misread = await browserGated(owner, a, cancelOffersRequest(p), { encKey: hex(randomBytes(32)) });
    expect(await arm.checkGatedCall(rt, 'cancel-offers', a.account, p, misread)).toMatchObject({
      ok: false,
      code: 'bad-signature',
    });
    const ok = await browserGated(owner, a, cancelOffersRequest(p));
    a.authNonce += 1n; // another call landed first
    expect(await arm.checkGatedCall(rt, 'cancel-offers', a.account, p, ok)).toMatchObject({
      ok: false,
      code: 'expired',
    });
  });

  it('the catalogue wires the executor (no longer the not-implemented placeholder)', async () => {
    const catalogue = accountCatalogue({
      runtime: () => null,
      arm,
      sponsor: {} as never,
      network: 'stagenet',
      replay: new DigestReplayGuard(600),
      entitlements: {} as never,
      log: {} as never,
    });
    const def = catalogue.get('cancel-offers')!;
    expect(def.auth).toBe('passport-call');
    expect(def.implementedBy).toBe('P9.I');
    // Without a runtime the executor says so (not "not-implemented").
    const ctx = { log: { info: () => {} } } as never;
    await expect(def.executor({ account: 'ab'.repeat(32) }, ctx)).rejects.toMatchObject({ code: 'not-available' });
  });
});

describe('AA 00047 P10.R: restore-enc-key (audit round 2 R2-3) is rotate_enc_key to the BROWSER’s key', () => {
  const restore = (a: FakeAccount, newKey: string): RestoreEncKeyPayload => ({
    newKey,
    authNonce: String(a.authNonce),
  });

  it('accepts a restore the wallet signed as "Rotate encryption key / New key …" for the browser’s key', async () => {
    const owner = wallet();
    const a = accountOf(owner); // a page changed the on-chain key: it is not the browser's
    const rt = runtimeOf(a);
    const browserKey = hex(randomBytes(32));
    const p = restore(a, browserKey);
    const r = await arm.checkGatedCall(
      rt,
      'restore-enc-key',
      a.account,
      p,
      await browserGated(owner, a, restoreEncKeyRequest(p)),
    );
    if (!r.ok) throw new Error(`refused: ${r.code} ${r.reason}`);
    const lines = new TextDecoder().decode(r.auth.message).split('\n');
    // TODO(P10.I): with P10.C's Q36 site prefix the first line changes; these lines do not.
    expect(lines[1]!.trimEnd()).toBe('Rotate encryption key'); // F3 v2 pads to a fixed length
    expect(lines[2]).toMatch(new RegExp(`^New key ${browserKey.slice(0, 16)}`));
    expect(r.signer).toBe(owner.deviceKey);
  });

  it('refuses the on-chain key itself (a cancel in disguise) and an all-zero key, before any signature work', async () => {
    const owner = wallet();
    const a = accountOf(owner);
    const rt = runtimeOf(a);
    for (const key of [a.encKey, '00'.repeat(32)]) {
      const p = restore(a, key);
      // Even a valid signature over it is refused.
      const passportAuth = await browserGated(owner, a, restoreEncKeyRequest(p));
      expect(await arm.checkGatedCall(rt, 'restore-enc-key', a.account, p, passportAuth)).toMatchObject({
        ok: false,
        code: 'malformed',
      });
    }
  });

  it('a cancel’s signature cannot pass as a restore, nor a restore’s as a cancel (other bytes)', async () => {
    const owner = wallet();
    const a = accountOf(owner);
    const rt = runtimeOf(a);
    const browserKey = hex(randomBytes(32));
    // The wallet signed a restore; the relay is asked to treat it as a cancel to the same key.
    const restoreAuth = await browserGated(owner, a, restoreEncKeyRequest(restore(a, browserKey)));
    expect(
      await arm.checkGatedCall(
        rt,
        'cancel-offers',
        a.account,
        { newKey: browserKey, authNonce: String(a.authNonce) },
        restoreAuth,
      ),
    ).toMatchObject({ ok: false, code: 'malformed' });
    // A real cancel signature presented as a restore to another key.
    const cancelAuth = await browserGated(
      owner,
      a,
      cancelOffersRequest({ newKey: a.encKey, authNonce: String(a.authNonce) }),
    );
    expect(
      await arm.checkGatedCall(rt, 'restore-enc-key', a.account, restore(a, browserKey), cancelAuth),
    ).toMatchObject({ ok: false, code: 'bad-signature' });
  });

  it('the catalogue wires the executor as a passport call (no longer the not-implemented placeholder)', async () => {
    const catalogue = accountCatalogue({
      runtime: () => null,
      arm,
      sponsor: {} as never,
      network: 'stagenet',
      replay: new DigestReplayGuard(600),
      entitlements: {} as never,
      log: {} as never,
    });
    const def = catalogue.get('restore-enc-key')!;
    expect(def.auth).toBe('passport-call');
    expect(def.lane).toBe('prover');
    const ctx = { log: { info: () => {} } } as never;
    await expect(def.executor({ account: 'ab'.repeat(32) }, ctx)).rejects.toMatchObject({ code: 'not-available' });
  });
});

describe('compact-runtime isolation on the relay (spike 3 §6)', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const version = (req: NodeJS.Require, pkg: string) =>
    JSON.parse(readFileSync(req.resolve(`${pkg}/package.json`), 'utf8')).version as string;
  const dirOf = (req: NodeJS.Require, pkg: string) => realpathSync(dirname(req.resolve(`${pkg}/package.json`)));

  it('the SDK resolves 0.19.0; the account module (and Track A’s client) 0.20.0; one onchain-runtime-v4', () => {
    const relay = createRequire(join(here, '../src/main.ts'));
    const compactJs = createRequire(relay.resolve('@midnight-ntwrk/compact-js'));
    const midnightJs = createRequire(relay.resolve('@midnight-ntwrk/midnight-js-contracts'));
    expect(version(compactJs, '@midnight-ntwrk/compact-runtime')).toBe('0.19.0');
    expect(version(midnightJs, '@midnight-ntwrk/compact-runtime')).toBe('0.19.0');
    const accountModule = join(here, '../../vendor/passport/contract/contracts/managed/account/contract/index.js');
    expect(readFileSync(accountModule, 'utf8')).not.toMatch(/from '@midnight-ntwrk\/compact-runtime'/);
    const fromAccount = createRequire(accountModule);
    expect(version(fromAccount, '@midnight-ntwrk/compact-runtime-0.20')).toBe('0.20.0');
    const client = createRequire(join(here, '../../vendor/passport/contract/src/wallet/ed25519.ts'));
    expect(version(client, '@midnight-ntwrk/compact-runtime-0.20')).toBe('0.20.0');
    const onchain = (dir: string) =>
      realpathSync(createRequire(join(dir, 'package.json')).resolve('@midnightntwrk/onchain-runtime-v4'));
    expect(onchain(dirOf(fromAccount, '@midnight-ntwrk/compact-runtime-0.20'))).toBe(
      onchain(dirOf(compactJs, '@midnight-ntwrk/compact-runtime')),
    );
  });
});
