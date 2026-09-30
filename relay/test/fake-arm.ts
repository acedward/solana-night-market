// A TEST device arm (../src/passport/arm.ts): the relay's executors and routes are arm-agnostic, so
// they are tested with this stand-in until Track A's Ed25519 arm exists (lane B3 wires the real
// one). It checks exactly what a real arm must: the call's signature is the named device's over a
// message rebuilt from the arguments and the account's CURRENT state, and the device's rolling
// entry at the signed use counter is live. The message and the entry derivation are test-only.

import { createHash } from 'node:crypto';

import { ed25519 } from '@noble/curves/ed25519.js';
import { canonicalJson, type PassportAuth } from '@nightmarket/core';

import {
  ARM_CIRCUITS,
  DEVICE_ARM,
  parseGatedPayload,
  parseTradePayload,
  preflightCall,
  type DeviceArm,
  type GatedAction,
  type GatedCheckFail,
  type TradeAction,
} from '../src/passport/arm.js';
import type { PassportRuntime } from '../src/passport/runtime.js';

const sha = (s: string | Uint8Array) => createHash('sha256').update(s).digest();
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const unhex = (h: string) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ''), 'hex'));

/** The body fields a call's challenge does not bind, as in the real contract: the append's
 *  entitlement (the market's, F-B3) and a withdrawal's recipient encryption key (F-B6, bound by the
 *  relay envelope instead). */
const UNSIGNED_FIELDS = new Set(['entitlement', 'recipientEncryptionKey']);

/** The message a device signs for one call (test-only format). */
export function testCallMessage(action: string, account: string, payload: Record<string, unknown>): Uint8Array {
  const { authNonce, ...all } = payload;
  const rest = Object.fromEntries(Object.entries(all).filter(([k]) => !UNSIGNED_FIELDS.has(k)));
  return sha(`night-market test call v0\n${canonicalJson({ action, account, authNonce, payload: rest })}`);
}

/** A device's rolling entry at (account, epoch, counter) (test-only derivation). */
export function testDeviceEntry(account: string, deviceKey: string, epoch: bigint, counter: bigint): string {
  return hex(sha(`entry|${account}|${deviceKey}|${epoch}|${counter}`));
}

/** A test device key (random unless given) that signs calls. */
export function callSigner(secret: Uint8Array = ed25519.utils.randomSecretKey()) {
  const deviceKey = hex(ed25519.getPublicKey(secret));
  return {
    deviceKey,
    /** The PassportAuth a browser sends for `payload` on `account`. */
    passportAuth(action: string, account: string, payload: Record<string, unknown>, useCounter = 0n): PassportAuth {
      return {
        owner: deviceKey,
        signature: hex(ed25519.sign(testCallMessage(action, account, payload), secret)),
        useCounter: useCounter.toString(10),
      };
    },
  };
}

async function check(
  rt: PassportRuntime,
  action: GatedAction | TradeAction,
  accountRaw: string | undefined,
  payload: ({ authNonce: string } & Record<string, unknown>) | null,
  passportRaw: unknown,
) {
  const pre = await preflightCall(rt, accountRaw, payload, passportRaw);
  if (!pre.ok) return pre;
  const { account, passport, ledger } = pre;
  const message = testCallMessage(action, account, pre.payload);
  let valid: boolean;
  try {
    valid = ed25519.verify(unhex(passport.signature), message, unhex(passport.owner), { zip215: false });
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, code: 'bad-signature', reason: 'the signature is not valid' } as GatedCheckFail;
  const entry = testDeviceEntry(account, passport.owner, ledger.device_epoch, BigInt(passport.useCounter));
  if (!ledger.devices.member(unhex(entry))) {
    return {
      ok: false,
      code: 'wrong-signer',
      reason: 'the signer is not a live device of this account at that counter',
    } as GatedCheckFail;
  }
  return {
    ok: true as const,
    account,
    signer: passport.owner,
    payload: pre.payload,
    passport,
    auth: { arm: 'test', pk: passport.owner, use_counter: BigInt(passport.useCounter), sig: passport.signature },
    digestHex: hex(message),
    ledger,
  };
}

export const testArm: DeviceArm = {
  name: DEVICE_ARM,
  circuits: ARM_CIRCUITS,
  checkGatedCall: (rt, action, account, payload, passportAuth) =>
    check(rt, action, account, parseGatedPayload(action, payload), passportAuth) as never,
  checkTradeCall: (rt, action, account, payload, passportAuth) =>
    check(rt, action, account, parseTradePayload(action, payload), passportAuth) as never,
  authArgs: (auth) => {
    const a = auth as { pk: string; use_counter: bigint; sig: string };
    return [a.pk, a.use_counter, a.sig];
  },
  registrationDevice: async (_rt, { deviceKey }) => ({
    device: { arm: 'test', deviceKey },
    entryAt: (account, epoch, counter) => unhex(testDeviceEntry(hex(account), deviceKey, epoch, counter)),
  }),
};

/** A runtime whose only account is `account`: booted, `devices` live at use counter 0, at
 *  `authNonce`. Counts its ledger reads. */
export function fakeAccountRuntime(
  account: string,
  deviceKeys: readonly string[],
  authNonce = 3n,
): PassportRuntime & { reads: number } {
  const live = new Set(deviceKeys.map((d) => testDeviceEntry(account, d, 0n, 0n)));
  const ledger = {
    booted: true,
    device_count: BigInt(deviceKeys.length),
    device_epoch: 0n,
    auth_nonce: authNonce,
    inbox_count: 0n,
    enc_key: new Uint8Array(32),
    devices: {
      member: (e: Uint8Array) => live.has(hex(e)),
      [Symbol.iterator]: () => [...live].map(unhex)[Symbol.iterator](),
    },
    inbox: { member: () => false, lookup: () => new Uint8Array(192) },
  };
  const rt = {
    reads: 0,
    ledgerState: async (a: string) => {
      rt.reads++;
      return a === account ? ledger : null;
    },
  };
  return rt as unknown as PassportRuntime & { reads: number };
}
