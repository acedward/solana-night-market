// A TEST Solana wallet for the browser operations: an `ActionSigning` (../src/wallet/signing.ts)
// over a random Ed25519 key. The relay envelope is signed in the core TEST scheme; an account call
// is signed over a test message of the call (Track A's message builder is lane B2's); the device's
// use counter is found through a test entry derivation. It records every signature asked for, so
// the tests can check "one signature per action".

import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, type AccountStateView, type RelayActionMessage } from '@nightmarket/core';
import type { GatedContext } from '@nightmarket/core/passport';

import { testDevice } from '../../packages/core/test/fixtures/test-signing.js';
import type { ActionSigning, CallToAuthorise } from '../src/wallet/signing.js';

const utf8 = (s: string) => new TextEncoder().encode(s);
const json = (v: unknown) =>
  JSON.stringify(v, (_k, x: unknown) =>
    typeof x === 'bigint' ? x.toString(10) : x instanceof Uint8Array ? bytesToHex(x) : x,
  );

/** The message the fake wallet signs for one call (test-only). */
export function fakeCallMessage(ctx: GatedContext, call: CallToAuthorise): Uint8Array {
  return sha256(utf8(`night-market fake call\n${ctx.account}\n${ctx.authNonce}\n${json(call)}`));
}

/** A device's rolling entry at (account, epoch, counter) (test-only derivation). */
export function fakeDeviceEntry(account: string, deviceKey: string, epoch: bigint, counter: bigint): string {
  return bytesToHex(sha256(utf8(`entry|${account}|${deviceKey}|${epoch}|${counter}`)));
}

export function fakeSigning(opts: { onSign?: (what: string) => void } = {}) {
  const secret = ed25519.utils.randomSecretKey();
  const device = testDevice(secret);
  const calls: string[] = [];
  const signing: ActionSigning = {
    deviceKey: device.deviceKey,
    async relayAction(message: RelayActionMessage) {
      calls.push('relayAction');
      opts.onSign?.('relayAction');
      return device.signEnvelope(message);
    },
    async authorise(ctx, call, useCounter) {
      calls.push(`authorise:${call.kind === 'gated' ? call.request.op : call.action}`);
      opts.onSign?.('authorise');
      return {
        owner: device.deviceKey,
        signature: bytesToHex(ed25519.sign(fakeCallMessage(ctx, call), secret)),
        useCounter: useCounter.toString(10),
      };
    },
    useCounter(state: AccountStateView, hint: bigint) {
      const live = new Set(state.devices);
      const at = (k: bigint) => fakeDeviceEntry(state.account, device.deviceKey, BigInt(state.deviceEpoch), k);
      if (live.has(at(hint))) return hint;
      for (let k = 0n; k < 64n; k++) if (live.has(at(k))) return k;
      return null;
    },
  };
  return { signing, calls, device };
}
