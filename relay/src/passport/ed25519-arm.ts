// The Ed25519 arm on the relay (AA 00047): a Solana wallet's key controls the account, on Track A's
// client (acedward/passport branch 00047-solana-ed25519-arm, vendor/passport; docs/ED25519-ARM.md).
//
// REQUEST AUTH IS THE CALL'S OWN SIGNATURE (lane B3): the browser sends the wallet's 64-byte
// signature over the call's F3 message (PassportAuth), and the relay accepts the request only when
// that signature verifies over the message IT rebuilds from the call's arguments and the account's
// current public state. It is the very signature the circuit verifies, so every account action is
// one Phantom prompt, and a request the relay accepts is a call the account will accept. Each check:
//   1. `preflightCall` (./arm.ts): the account, the body, the PassportAuth's shape, the account's
//      state (booted, at the auth nonce the call binds: an approval for an older nonce is refused
//      as `expired`, never replayed);
//   2. the account is a market account (spec FR-005, ./account-keys.ts): its on-chain verifier keys
//      are the relay's pinned key set and its maintenance authority is retired;
//   3. `ed25519DeviceForCheck(passport, display).sign(ctx, request, counter)` (or `signOffer` with
//      `openSwapArgs(payload)`), `ctx` = the account, its auth nonce and its sealed network salt
//      (`evm_domain_salt`): Track A's device rebuilds the challenge and the F3 message (label =
//      the relay's network label, symbols and decimals from the relay's registry), compares them
//      with the contract's own rendering, refuses anything a wallet could read as a Solana
//      transaction, verifies the browser's signature with tweetnacl, decodes R strictly (not the
//      identity) and refuses s >= L, all before any proving time is spent. Another key, other
//      bytes, another account, another network (label or salt) all fail here;
//   4. the device's rolling entry at the signed use counter is a live member of `ledger.devices`;
//   5. `digestHex` (SHA-256 of the signed message) for the replay guard: the same approval can be
//      queued once (relay/src/auth/verifiers.ts `DigestReplayGuard`), and the on-chain `auth_nonce`
//      makes it single use for good once the call lands.
//
// Track A's client loads the compiled account module (in a deployment, the key volume's), so it is
// imported here at run time only: a relay without a key volume still starts and serves reads.
//
// The message is format F3 v2 (vendor/passport @ b2f1847, AA 00047 P9.C; questions Q25 B′, Q32):
// every amount shows its exact base units and its full 64-hex token id, and the site's name and
// decimals only on a line marked as the site's label ("This site labels it: …", from
// `ed25519TokenResolver`, the client's own `isRenderableTokenDisplay` rule); an offer's deadline
// reads as a UTC date and time. The relay renders it through core's `ed25519DeviceForCheck`, so it
// renders exactly what the browser and the circuit render.
//
// `cancel-offers` (questions Q30) is the arm's `rotate_enc_key` with `newKey` = the account's
// CURRENT `enc_key`: the check refuses any other key (the market never changes a key), and the call
// context carries that key (`CallContext.encKey`), so the rebuilt message reads "Cancel all open
// offers / Your key does not change". A wallet that signed "Rotate encryption key" signed other
// bytes, and is refused like any other mismatch.

import { createHash } from 'node:crypto';

import type { CancelOffersPayload, NetworkName, TokenRegistry } from '@nightmarket/core';

import type * as CorePassport from '@nightmarket/core/passport';

import type { Ed25519Authorisation, Ed25519Device } from '../../../vendor/passport/contract/src/wallet/ed25519.js';
import type { CallContext } from '../../../vendor/passport/contract/src/wallet/signer.js';
import {
  ARM_CIRCUITS,
  DEVICE_ARM,
  parseGatedPayload,
  parseTradePayload,
  preflightCall,
  type AccountKeysCheck,
  type CallCheckOk,
  type DeviceArm,
  type GatedAction,
  type GatedCheckFail,
  type TradeAction,
} from './arm.js';
import type { AccountLedger, PassportRuntime } from './runtime.js';

export interface Ed25519ArmOptions {
  /** The network, for the label every message starts with (`marketLabel`). */
  network: NetworkName;
  /** The market's token registry, for the symbols and decimals the messages show. It must be the
   *  registry the browser renders with (questions Q12: the relay's registry is the source). */
  tokens: TokenRegistry;
  /** FR-005: the account is a market account with the pinned verifier keys (./account-keys.ts).
   *  Absent in unit tests that exercise the signature checks alone. */
  accountKeys?: AccountKeysCheck;
}

/** The trailing arguments of every `_with_ed25519` gated circuit and of the offer circuit (Track A's
 *  `ed25519AuthArgs`; relay/test/ed25519-arm.test.ts holds the two equal). */
export const ed25519ArmAuthArgs = (a: Ed25519Authorisation): unknown[] => [a.pk, a.use_counter, a.sig, a.show];

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const unhex = (h: string) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ''), 'hex'));
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Why Track A's device refused to rebuild a call, as a check failure. */
function refusal(e: unknown): GatedCheckFail {
  const m = errorText(e);
  // The call cannot be displayed (an amount of 10^24 base units or more, a label or symbol the arm
  // cannot render): nothing a wallet signed can authorise it.
  if (e instanceof RangeError) return { ok: false, code: 'malformed', reason: `the call cannot be approved: ${m}` };
  return {
    ok: false,
    code: 'bad-signature',
    reason: `the signature does not approve this call on this account (${m.slice(0, 240)})`,
  };
}

type Rebuild = (device: Ed25519Device, ctx: CallContext, counter: bigint) => Promise<Ed25519Authorisation>;

/** The Ed25519 arm (lane B3). */
export function ed25519Arm(options: Ed25519ArmOptions): DeviceArm {
  const display = { network: options.network, tokens: options.tokens };

  async function check<P extends { authNonce: string }>(
    runtime: PassportRuntime,
    accountRaw: string | undefined,
    payload: P | null,
    passportRaw: unknown,
    rebuild: (payload: P, core: typeof CorePassport) => Rebuild,
    keep?: (payload: P, ledger: AccountLedger) => GatedCheckFail | null,
  ): Promise<CallCheckOk<P> | GatedCheckFail> {
    const pre = await preflightCall(runtime, accountRaw, payload, passportRaw);
    if (!pre.ok) return pre;
    const { account, passport, ledger } = pre;

    const keyRefusal = keep?.(pre.payload, ledger);
    if (keyRefusal) return keyRefusal;

    if (options.accountKeys) {
      const keys = await options.accountKeys(account);
      if (!keys.ok) return { ok: false, code: 'wrong-account', reason: keys.reason };
    }

    const core = await import('@nightmarket/core/passport');
    let device: Ed25519Device;
    try {
      device = core.ed25519DeviceForCheck(passport, display);
    } catch (e) {
      return { ok: false, code: 'wrong-signer', reason: `the signing key is not a valid device key: ${errorText(e)}` };
    }
    const ctx = core.callContext({
      account,
      authNonce: ledger.auth_nonce,
      networkSalt: hex(Uint8Array.from(ledger.evm_domain_salt)),
      // F3 v2: the arm's rotate_enc_key renders the cancel from the account's current key.
      encKey: hex(Uint8Array.from(ledger.enc_key)),
    });
    const counter = BigInt(passport.useCounter);
    let auth: Ed25519Authorisation;
    try {
      auth = await rebuild(pre.payload, core)(device, ctx, counter);
    } catch (e) {
      return refusal(e);
    }
    if (!isLiveDevice(ledger, device, account, counter)) {
      return {
        ok: false,
        code: 'wrong-signer',
        reason: 'the signing key is not a live device of this account at the signed use counter',
      };
    }
    return {
      ok: true,
      account,
      signer: passport.owner,
      payload: pre.payload,
      passport,
      auth,
      digestHex: createHash('sha256').update(auth.message).digest('hex'),
      ledger,
    };
  }

  return {
    name: DEVICE_ARM,
    circuits: ARM_CIRCUITS,
    checkGatedCall<A extends GatedAction>(
      runtime: PassportRuntime,
      action: A,
      account: string | undefined,
      payload: unknown,
      passportAuth: unknown,
    ) {
      const parsed = parseGatedPayload(action, payload);
      return check(
        runtime,
        account,
        parsed,
        passportAuth,
        (p, core) => {
          const request =
            action === 'withdraw'
              ? core.withdrawRequest(p as never)
              : action === 'withdraw-unshielded'
                ? core.withdrawUnshieldedRequest(p as never)
                : action === 'cancel-offers'
                  ? core.cancelOffersRequest(p as never)
                  : core.appendInboxRequest(p as never);
          return (device, ctx, counter) => device.sign(ctx, request, counter);
        },
        action === 'cancel-offers' ? (p, ledger) => cancelKeepsTheKey(p as CancelOffersPayload, ledger) : undefined,
      ) as never;
    },
    checkTradeCall<A extends TradeAction>(
      runtime: PassportRuntime,
      action: A,
      account: string | undefined,
      payload: unknown,
      passportAuth: unknown,
    ) {
      // A make and a take are the same swap-circuit call, signed once (the take's `offerId` is not
      // signed: the take executor checks the maker's offer is exactly this call's complement).
      const parsed = parseTradePayload(action, payload);
      return check(runtime, account, parsed, passportAuth, (p, core) => {
        const { call, coin } = core.openSwapArgs(p);
        return (device, ctx, counter) => device.signOffer(ctx, call, coin, counter);
      }) as never;
    },
    authArgs: ed25519ArmAuthArgs,
    async registrationDevice(_runtime, { deviceKey }) {
      const { ed25519DeviceForKey } = await import('@nightmarket/core/passport');
      const device = ed25519DeviceForKey(deviceKey, display);
      return { device, entryAt: (account, epoch, counter) => device.entryAt(account, epoch, counter) };
    },
  };
}

/** `cancel-offers` re-affirms the account's CURRENT encryption key (questions Q30): any other key
 *  would be a real key change, which the market never asks a wallet for. Refused before any
 *  signature work (at admission, and again when the job runs). */
export function cancelKeepsTheKey(payload: CancelOffersPayload, ledger: AccountLedger): GatedCheckFail | null {
  const onChain = hex(Uint8Array.from(ledger.enc_key));
  if (payload.newKey.replace(/^0x/, '').toLowerCase() === onChain) return null;
  return {
    ok: false,
    code: 'malformed',
    reason: "a cancel re-affirms the account's current encryption key; this key is not the one on chain",
  };
}

/** Whether `device`'s rolling entry at `counter` (under the account's current epoch) is live. */
export function isLiveDevice(ledger: AccountLedger, device: Ed25519Device, account: string, counter: bigint): boolean {
  return ledger.devices.member(device.entryAt(unhex(account), ledger.device_epoch, counter));
}
