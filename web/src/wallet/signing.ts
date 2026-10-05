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

import { bytesToHex, hexToBytes } from '@nightmarket/core';
import {
  deriveLandingMaster,
  registrationMessageText,
  type LandingMaster,
  type LandingMessageExpect,
  type LandingMessageParams,
  type RegistrationText,
} from '@nightmarket/core/bridge';
import { solanaRelayActionScheme, verifyEd25519Strict } from '@nightmarket/core/solana-auth';
import type {
  AccountStateView,
  DeviceSigner,
  OpenSwapPayload,
  PassportAuth,
  RelayActionMessage,
  RelayActionScheme,
} from '@nightmarket/core';
import {
  assertSafeEd25519Message,
  callContext,
  ed25519DeviceOf,
  findUseCounter,
  openSwapArgs,
  passportAuthOf,
  siteLine,
  type AuthRequest,
  type Ed25519Display,
  type GatedContext,
} from '@nightmarket/core/passport';

import { SignFactsMismatchError, missingFromSignedText, signFacts, type SignFacts } from './sign-facts.js';

/** One call to authorise: a gated account call (a withdrawal, an inbox append) or a swap (a make or
 *  a take, one `open_swap_shielded_with_ed25519` call). */
export type CallToAuthorise =
  | {
      kind: 'gated';
      request: AuthRequest;
      /** A key change BACK to this browser's own key (AA 00047 P10, R2-3): the only purpose for which a
       *  `rotateEncKey` may move the key; without it, a `rotateEncKey` is the market's cancel. */
      purpose?: 'restore-enc-key';
    }
  | { kind: 'swap'; action: 'open-swap' | 'take'; payload: OpenSwapPayload };

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
  /** AA 00060 P8 (I-4): sign the RPC injector's registration text, which this page RENDERS from the
   *  typed fields (it never signs a text an injector hands it). Resolves to the exact text and the
   *  signature (128 hex), checked strictly against the device key before anything is sent. */
  rpcRegistration?(fields: RegistrationText): Promise<{ message: string; signature: string }>;
  /** AA 00060 P6 (I-5): derive the Bridge-out landing key's master: the wallet signs the landing-key
   *  text twice (two prompts), both must be the same valid signature, and the master must match the
   *  check recorded earlier (`storedCheck`). The signatures never leave the tab. */
  landingMaster?(
    params: LandingMessageParams,
    o: { expect?: Omit<LandingMessageExpect, 'publicKey'>; storedCheck?: string | null },
  ): Promise<LandingMaster>;
}

/** The wallet signed, but not the envelope's bytes with the device key (never sent to the relay). */
export class EnvelopeSignatureError extends Error {
  override name = 'EnvelopeSignatureError';
  constructor() {
    super('The wallet signature does not match the request. Nothing was sent.');
  }
}

/** `ActionSigning` over Track A's Ed25519 arm, for any wallet that signs messages. `envelope` is the
 *  relay envelope's scheme (lane B3's Solana scheme; a test may pass another). `announce` hears the
 *  facts the contract enforces for each account call just before the wallet is asked (the signing
 *  panel lists them, ./sign-facts.ts; AA 00047 P9.S, questions Q25 B′), then null. The wallet is
 *  asked only when EVERY one of those facts is a line of the exact bytes it would sign (AA 00047
 *  P9.I): a fact the text does not carry throws `SignFactsMismatchError` and nothing is signed. */
export function ed25519ActionSigning(
  signer: DeviceSigner,
  display: Ed25519Display,
  envelope: RelayActionScheme = solanaRelayActionScheme,
  announce?: (facts: SignFacts | null) => void,
): ActionSigning {
  const device = ed25519DeviceOf(signer, display);
  return {
    deviceKey: signer.deviceKey,
    landingMaster(params, o) {
      return deriveLandingMaster((m) => signer.signMessage(m), params, hexToBytes(signer.deviceKey, 32), {
        ...(o.expect ? { expect: o.expect } : {}),
        storedCheck: o.storedCheck ?? null,
      });
    },
    async rpcRegistration(fields) {
      if (fields.solanaAddress !== signer.address) throw new EnvelopeSignatureError();
      const message = registrationMessageText(fields);
      const bytes = new TextEncoder().encode(message);
      assertSafeEd25519Message(bytes);
      const signature = await signer.signMessage(bytes);
      if (!verifyEd25519Strict(signer.deviceKey, bytes, signature)) throw new EnvelopeSignatureError();
      return { message, signature: bytesToHex(signature) };
    },
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
      const facts = signFacts(call, display.tokens, ctx);
      // The device hands the wallet exactly the bytes the contract renders (after its own checks);
      // this gate sits between the two: the panel's facts must each be a line of those bytes, or
      // the wallet is never asked.
      const gated = ed25519DeviceOf(
        {
          deviceKey: signer.deviceKey,
          address: signer.address,
          signMessage: async (message: Uint8Array) => {
            if (facts) {
              const missing = missingFromSignedText(facts, String.fromCharCode(...message), siteLine(display.network));
              if (missing.length > 0) throw new SignFactsMismatchError(missing);
            }
            announce?.(facts);
            return signer.signMessage(message);
          },
        },
        display,
      );
      try {
        if (call.kind === 'gated') return passportAuthOf(await gated.sign(cc, call.request, useCounter));
        const { call: args, coin } = openSwapArgs(call.payload);
        return passportAuthOf(await gated.signOffer(cc, args, coin, useCounter));
      } finally {
        announce?.(null);
      }
    },
    useCounter(state, hint) {
      const account = hexToBytes(state.account, 32);
      const epoch = BigInt(state.deviceEpoch);
      return findUseCounter(state.devices, (k) => bytesToHex(device.entryAt(account, epoch, k)), hint);
    },
  };
}
