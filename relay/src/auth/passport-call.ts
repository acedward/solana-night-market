// The route-level `passport-call` authoriser: a gated action (withdraw, append-inbox) or a trade
// (open-swap, take) is accepted when its own Passport signature verifies against the account's
// current state (the device arm's check, ../passport/arm.ts), and its digest has not been accepted
// before. The executor checks again when the job starts.

import type { ActionRequest } from '@nightmarket/core';

import type { ActionDefinition } from '../actions/catalogue.js';
import { isGatedAction, isTradeAction, type DeviceArm } from '../passport/arm.js';
import type { PassportRuntime } from '../passport/runtime.js';
import type { DigestReplayGuard, VerifyOutcome } from './verifiers.js';

export function passportCallAuthoriser(
  runtime: () => PassportRuntime | null,
  arm: DeviceArm,
  replay: DigestReplayGuard,
): (def: ActionDefinition, request: ActionRequest) => Promise<VerifyOutcome> {
  return async (def, request) => {
    const action = def.action;
    if (!isTradeAction(action) && !isGatedAction(action)) {
      return { ok: false, code: 'not-supported', reason: 'this action is not authorised by a Passport signature' };
    }
    const rt = runtime();
    if (!rt) return { ok: false, code: 'not-supported', reason: 'the market cannot verify account calls right now' };
    const r = isTradeAction(action)
      ? await arm.checkTradeCall(rt, action, request.account, request.payload, request.passportAuth)
      : await arm.checkGatedCall(rt, action, request.account, request.payload, request.passportAuth);
    if (!r.ok) return r;
    if (!replay.claim(r.digestHex))
      return { ok: false, code: 'replayed', reason: 'this authorisation was already used' };
    return {
      ok: true,
      signer: r.signer,
      kind: 'passport-call',
      account: r.account,
      release: () => replay.release(r.digestHex),
    };
  };
}
