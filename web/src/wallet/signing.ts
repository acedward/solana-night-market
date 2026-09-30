// The seam where the connected Solana wallet signs for the market (AA 00047 lane B2, on Track A's
// Ed25519 arm client: acedward/passport branch 00047-solana-ed25519-arm, wired in B1.5 through
// `@nightmarket/core/passport`).
//
// Every browser operation (../passport/operations.ts, ../trade/operations.ts, ../demo/operations.ts)
// asks for signatures only through `ActionSigning`:
//   - `relayAction` signs the relay's RelayAction envelope (opening an account, claiming demo
//     tokens) in lane B3's Solana scheme (`solanaRelayActionScheme`, packages/core/src/solana-auth.ts,
//     questions Q14: Track A's proof-of-key message with the envelope's digest as its nonce);
//   - `preview` is the exact text the wallet will show (and sign) for one account call (format F3:
//     the call's readable message, questions Q11), without asking the wallet;
//   - `authorise` has the wallet sign that message and returns the Passport authorisation the relay
//     checks (Track A's `Ed25519Device`: the contract's own rendering, the Solana-transaction / SIWS
//     guard, the tweetnacl pre-check, strict R, s unreduced);
//   - `useCounter` finds this device's live rolling entry on the account (the arm's own derivation).
//
// `ed25519ActionSigning(signer, display)` is that implementation over any `DeviceSigner`: the
// Phantom adapter (./phantom-adapter.ts) hands it the wallet's `signMessage` (which already refuses
// a Ledger-wrapped or mismatched signature, ./solana-signature.ts); the tests hand it a tweetnacl key.

import { bytesToHex, hexToBytes, solanaRelayActionScheme } from '@nightmarket/core';
import type {
  AccountStateView,
  DeviceSigner,
  OpenSwapPayload,
  PassportAuth,
  RelayActionMessage,
  RelayActionScheme,
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

/** The wallet signed, but not the envelope's bytes with the device key (never sent to the relay). */
export class EnvelopeSignatureError extends Error {
  override name = 'EnvelopeSignatureError';
  constructor() {
    super('The wallet signature does not match the request. Nothing was sent.');
  }
}

/** `ActionSigning` over Track A's Ed25519 arm, for any wallet that signs messages. `envelope` is the
 *  relay envelope's scheme (lane B3's Solana scheme; a test may pass another). */
export function ed25519ActionSigning(
  signer: DeviceSigner,
  display: Ed25519Display,
  envelope: RelayActionScheme = solanaRelayActionScheme,
): ActionSigning {
  const device = ed25519DeviceOf(signer, display);
  return {
    deviceKey: signer.deviceKey,
    async relayAction(message) {
      if (message.owner !== signer.deviceKey) throw new EnvelopeSignatureError();
      const signature = await signer.signMessage(envelope.messageBytes(message));
      // The same strict check the relay runs, before anything is sent.
      if (!envelope.verify(message, signature)) throw new EnvelopeSignatureError();
      return bytesToHex(signature);
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
