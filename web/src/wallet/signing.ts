// The seam where the connected Solana wallet signs for the market (lane B2, on Track A's Ed25519
// arm client: acedward/passport branch 00047-solana-ed25519-arm, wired in B1.5 through
// `@nightmarket/core/passport`).
//
// MN Bank signed EIP-712 typed data with an EIP-1193 wallet; that is gone (AA 00047). Every browser
// operation (../passport/operations.ts, ../trade/operations.ts) asks for signatures only through
// `ActionSigning`, so lane B2 plugs Phantom in here and nothing else changes:
//   - `relayAction` signs the relay's RelayAction envelope (registration, and a withdrawal's
//     recipient key, F-B6) in the Solana envelope scheme lane B3 defines (TODO(B3));
//   - `preview` is the exact text the wallet will show for one account call (format F3: the call's
//     readable message, questions Q11), for the page's own confirmation panel (TODO(B2): the UX);
//   - `authorise` has the wallet sign that message and returns the Passport authorisation the relay
//     checks (Track A's `Ed25519Device`: the contract's own rendering, the Solana-transaction / SIWS
//     guard, the tweetnacl pre-check, strict R, s unreduced);
//   - `useCounter` finds this device's live rolling entry on the account (the arm's own derivation).
//
// `ed25519ActionSigning(signer, display)` is that implementation over any `DeviceSigner`: lane B2
// hands it Phantom's `signMessage` (TODO(B2): the Wallet Standard / `window.phantom.solana` adapter
// and its Ledger refusal, ./WalletContext.tsx `WalletAdapter`); the tests hand it a tweetnacl key.

import { bytesToHex, hexToBytes } from '@nightmarket/core';
import type {
  AccountStateView,
  DeviceSigner,
  OpenSwapPayload,
  PassportAuth,
  RelayActionMessage,
} from '@nightmarket/core';
import {
  callContext,
  ed25519DeviceOf,
  findUseCounter,
  openSwapArgs,
  passportAuthOf,
  type AuthRequest,
  type Ed25519Display,
  type GatedContext,
} from '@nightmarket/core/passport';

/** One call to authorise: a gated account call (a withdrawal, an inbox append) or a swap (a make or
 *  a take, one `open_swap_shielded_with_ed25519` call). */
export type CallToAuthorise =
  { kind: 'gated'; request: AuthRequest } | { kind: 'swap'; action: 'open-swap' | 'take'; payload: OpenSwapPayload };

export interface ActionSigning {
  /** The device key (64 lowercase hex): the Solana wallet's public key. */
  readonly deviceKey: string;
  /** Sign a RelayAction envelope; resolves to the signature (128 hex). */
  relayAction(message: RelayActionMessage): Promise<string>;
  /** The text the wallet will show (and sign) for one call on the account at `ctx`, without asking
   *  the wallet. */
  preview(ctx: GatedContext, call: CallToAuthorise): { text: string };
  /** Authorise one call on the account at `ctx` with the device's rolling entry at `useCounter`. */
  authorise(ctx: GatedContext, call: CallToAuthorise, useCounter: bigint): Promise<PassportAuth>;
  /** This device's current use counter on the account, from a hint (the last one used), or null
   *  when it is not a device of the account. */
  useCounter(state: AccountStateView, hint: bigint): bigint | null;
}

export class SigningUnavailableError extends Error {
  override name = 'SigningUnavailableError';
  constructor() {
    super('Signing with a Solana wallet is not available yet on this site.');
  }
}

/** `ActionSigning` over Track A's Ed25519 arm, for any wallet that signs messages. */
export function ed25519ActionSigning(signer: DeviceSigner, display: Ed25519Display): ActionSigning {
  const device = ed25519DeviceOf(signer, display);
  return {
    deviceKey: signer.deviceKey,
    relayAction() {
      // TODO(B3): the Solana envelope scheme (packages/core/src/auth.ts `RelayActionScheme`); B2 then
      // signs `scheme.messageBytes(message)` with `signer.signMessage` here.
      return Promise.reject(new SigningUnavailableError());
    },
    preview(ctx, call) {
      const cc = callContext(ctx);
      if (call.kind === 'gated') return { text: device.preview(cc, call.request).text };
      const { call: args, coin } = openSwapArgs(call.payload);
      return { text: device.previewOffer(cc, args, coin).text };
    },
    async authorise(ctx, call, useCounter) {
      const cc = callContext(ctx);
      if (call.kind === 'gated') return passportAuthOf(await device.sign(cc, call.request, useCounter));
      const { call: args, coin } = openSwapArgs(call.payload);
      return passportAuthOf(await device.signOffer(cc, args, coin, useCounter));
    },
    useCounter(state, hint) {
      const account = hexToBytes(state.account, 32);
      const epoch = BigInt(state.deviceEpoch);
      return findUseCounter(state.devices, (k) => bytesToHex(device.entryAt(account, epoch, k)), hint);
    },
  };
}
