// The Ed25519 arm on the relay (AA 00047): a Solana wallet's key controls the account, on Track A's
// client (acedward/passport branch 00047-solana-ed25519-arm, vendor/passport; docs/ED25519-ARM.md).
//
// B1.5 wires what is fixed by Track A's API:
//   - the arm's circuits and the circuit's trailing arguments (`ed25519AuthArgs`: pk, use_counter,
//     sig, show);
//   - the device a registration enrols: `Ed25519Device` from the wallet's 32-byte public key alone
//     (activation is permissionless: the boot commitment binds the key), strictly decoded, with the
//     market's label and token display (`@nightmarket/core/passport`), so its `entryAt` is the arm's
//     own rolling-entry derivation.
// Lane B3 writes the two call checks (TODO(B3) below). Each is Track A's relay-side pattern:
//   1. `preflightCall` (./arm.ts): the account, the body, the PassportAuth's shape, the account's
//      state (booted, at the auth nonce the call binds);
//   2. `ed25519DeviceForCheck(passport, display).sign(ctx, request, counter)` (or `signOffer` with
//      `openSwapArgs(payload)`) with `ctx` = the account, its auth nonce and its sealed network salt
//      (`evm_domain_salt`): it rebuilds the challenge and the F3 message from the call's own
//      arguments, compares them with the contract's own rendering, and verifies the browser's
//      signature with tweetnacl (strict R, s unreduced) before any proving time is spent;
//   3. the device's rolling entry at the signed use counter is a live member of `ledger.devices`
//      (`device.entryAt(account, ledger.device_epoch, counter)`);
//   4. the result's `digestHex` for the replay guard (the rendered message's digest).
//
// Track A's client loads the compiled account module (in a deployment, the key volume's), so it is
// imported here at run time only: a relay without a key volume still starts and serves reads.

import type { NetworkName, TokenRegistry } from '@nightmarket/core';

import type { Ed25519Authorisation } from '../../../vendor/passport/contract/src/wallet/ed25519.js';
import { ARM_CIRCUITS, DEVICE_ARM, type DeviceArm, type GatedCheckFail } from './arm.js';

export interface Ed25519ArmOptions {
  /** The network, for the label every message starts with (`marketLabel`). */
  network: NetworkName;
  /** The market's token registry, for the symbols and decimals the messages show. It must be the
   *  registry the browser renders with (TODO(B2/B3): one source for both sides). */
  tokens: TokenRegistry;
}

/** The trailing arguments of every `_with_ed25519` gated circuit and of the offer circuit (Track A's
 *  `ed25519AuthArgs`; relay/test/ed25519-arm.test.ts holds the two equal). */
export const ed25519ArmAuthArgs = (a: Ed25519Authorisation): unknown[] => [a.pk, a.use_counter, a.sig, a.show];

export const CHECK_NOT_WIRED =
  'the Ed25519 call check is not wired yet (plan lane B3): the relay does not prove Solana-signed calls';

const notWired = async (): Promise<GatedCheckFail> => ({ ok: false, code: 'not-supported', reason: CHECK_NOT_WIRED });

/** The Ed25519 arm (its call checks are lane B3's: TODO(B3)). */
export function ed25519Arm(options: Ed25519ArmOptions): DeviceArm {
  return {
    name: DEVICE_ARM,
    circuits: ARM_CIRCUITS,
    // TODO(B3): steps 1–4 of the header, over `parseGatedPayload(action, payload)` and
    // `withdrawRequest` / `appendInboxRequest` (@nightmarket/core/passport).
    checkGatedCall: notWired,
    // TODO(B3): the same over `parseTradePayload(action, payload)` and `openSwapArgs(payload)`, with
    // `signOffer` (one swap-circuit call, signed once; a take keeps 00039's fully guaranteed
    // transcript steering).
    checkTradeCall: notWired,
    authArgs: ed25519ArmAuthArgs,
    async registrationDevice(_runtime, { deviceKey }) {
      const { ed25519DeviceForKey } = await import('@nightmarket/core/passport');
      const device = ed25519DeviceForKey(deviceKey, options);
      return { device, entryAt: (account, epoch, counter) => device.entryAt(account, epoch, counter) };
    },
  };
}
