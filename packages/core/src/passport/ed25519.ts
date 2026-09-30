// Track A's Ed25519 arm client, as the market uses it (AA 00047 B1.5): the ONE place the browser
// (lane B2) and the relay (lane B3) take the arm's device, its message and its checks from, so both
// sides render exactly the same bytes for a call.
//
// The client is acedward/passport's `contract/src/wallet/ed25519.ts` and `ed25519-message.ts`
// (branch 00047-solana-ed25519-arm, the vendor/passport submodule; docs/ED25519-ARM.md):
//   - `Ed25519Device`: the device is the Solana wallet's 32-byte public key, decoded STRICTLY (noble
//     `Point.fromBytes`, ZIP-215 off; the identity and every point outside the prime-order subgroup
//     are refused). To authorise a call it computes the challenge with the contract's own pure
//     circuit, renders the readable message (format F3) in TypeScript AND with the contract's
//     `ed25519_message_*` pure circuit (refusing any difference), refuses bytes that could read as a
//     Solana transaction, an off-chain message or a Sign-In With Solana request, asks the sign
//     callback, verifies the signature with tweetnacl (the pre-check), and decodes R strictly (not
//     the identity) with s unreduced (s >= L is refused).
//   - the message builder (`renderEd25519Message`) and its guards.
// Both are browser-safe: they load the compiled account module (compact-runtime 0.20.0, the only
// runtime the browser bundle holds) and nothing that needs Node.
//
// What this module adds is what both sides must AGREE on to render the same bytes:
//   - the LABEL on top of every message (`marketLabel`), per network;
//   - the TOKEN DISPLAY (symbol and decimals per colour) from the market's registry
//     (`ed25519TokenResolver`). The browser and the relay must resolve with the same registry for
//     the network (a token known to one side only renders differently on the other, so the
//     relay's check refuses the signature, with a reason; questions Q12);
//   - the device from a connected wallet (`ed25519DeviceOf`), and the relay's device for checking a
//     browser's signature (`ed25519DeviceForCheck`: every check above re-runs on the relay).

import type { TokenRegistry } from '../tokens/registry.js';
import type { NetworkName } from '../network.js';
import { bytesToHex, hexToBytes } from '../hex.js';
import { DEVICE_KEY_PATTERN, DeviceKeyError, type DeviceSigner } from '../signing.js';
import {
  Ed25519Device,
  decodeEd25519Point,
  encodeEd25519Point,
  type Ed25519Authorisation,
  type Ed25519SignatureArg,
} from '../../../../vendor/passport/contract/src/wallet/ed25519.js';
import {
  ED25519_MAX_DECIMALS,
  ED25519_SYMBOL_BYTES,
  type EdTokenResolver,
} from '../../../../vendor/passport/contract/src/wallet/ed25519-message.js';
import { marketLabel } from '../market-label.js';

export {
  Ed25519Device,
  ED25519_L,
  decodeEd25519Point,
  decodeEd25519Signature,
  encodeEd25519Point,
  ed25519AuthArgs,
  requireNetworkSalt,
  type Curve25519Point,
  type Ed25519Authorisation,
  type Ed25519DeviceOptions,
  type Ed25519SignFn,
  type Ed25519SignatureArg,
} from '../../../../vendor/passport/contract/src/wallet/ed25519.js';
export {
  ED25519_LABEL_BYTES,
  ED25519_MAX_AMOUNT,
  ED25519_MAX_DECIMALS,
  ED25519_MESSAGE_BYTES,
  ED25519_SYMBOL_BYTES,
  UNKNOWN_TOKEN,
  assertSafeEd25519Message,
  ed25519PossessionMessage,
  parsesAsSolanaTransaction,
  renderEd25519Message,
  type Ed25519Message,
  type Ed25519MessageFrame,
  type Ed25519MessageInput,
  type EdShowAny,
  type EdTokenDisplay,
  type EdTokenResolver,
} from '../../../../vendor/passport/contract/src/wallet/ed25519-message.js';

/**
 * The first line of every message the wallet shows (<= 24 printable ASCII characters): the market
 * and its network. The circuit renders it from the call's display input and the signature covers
 * it, so the browser and the relay must use the same one. Defined in the light `../market-label.ts`
 * (B3: the relay envelope's Solana scheme in the package root starts with it too).
 */
export { MARKET_LABELS, marketLabel } from '../market-label.js';

/**
 * How the arm shows a token (its symbol and decimals), from the market's registry. A symbol the
 * circuit cannot render (more than 8 characters, or not printable ASCII) shows as an UNKNOWN token:
 * base units under "?", beside the exact colour fingerprint the circuit computes. Nothing is
 * truncated, so the wallet never shows a symbol the registry does not have.
 */
export function ed25519TokenResolver(registry: TokenRegistry): EdTokenResolver {
  return (colourHex: string) => {
    const t = registry.byColour(colourHex);
    if (!t) return undefined;
    const renderable =
      t.symbol.length <= ED25519_SYMBOL_BYTES &&
      /^[\x20-\x7e]+$/.test(t.symbol) &&
      Number.isInteger(t.decimals) &&
      t.decimals >= 0 &&
      t.decimals <= ED25519_MAX_DECIMALS;
    return renderable ? { symbol: t.symbol, decimals: t.decimals } : undefined;
  };
}

/** What the arm's messages depend on besides the call: the network (its label) and the registry. */
export interface Ed25519Display {
  network: NetworkName;
  tokens: TokenRegistry;
}

const deviceKeyBytes = (deviceKey: string): Uint8Array => {
  const hex = deviceKey.replace(/^0x/, '').toLowerCase();
  if (!DEVICE_KEY_PATTERN.test(hex)) throw new DeviceKeyError('a device key is 64 hex characters');
  return hexToBytes(hex, 32);
};

/**
 * A device key that the arm accepts: it decodes STRICTLY as a prime-order Curve25519 point (not the
 * identity, no small-order or mixed-order point, canonical y). Throws DeviceKeyError otherwise.
 * A Solana address that fails this can never control an account.
 */
export function assertDeviceKeyDecodes(deviceKey: string): void {
  try {
    decodeEd25519Point(deviceKeyBytes(deviceKey), 'the device key');
  } catch (e) {
    throw e instanceof DeviceKeyError ? e : new DeviceKeyError((e as Error).message);
  }
}

/** The connected wallet (a B1 `DeviceSigner`: Phantom's `signMessage` in lane B2, a test key in
 *  tests) as Track A's device. Its `sign`/`signOffer` run every check before and after the wallet. */
export function ed25519DeviceOf(signer: DeviceSigner, display: Ed25519Display): Ed25519Device {
  return new Ed25519Device({
    publicKey: deviceKeyBytes(signer.deviceKey),
    sign: (message: Uint8Array) => signer.signMessage(message),
    label: marketLabel(display.network),
    tokens: ed25519TokenResolver(display.tokens),
  });
}

/**
 * The relay's side of a gated call (Track A's pattern, docs/ED25519-ARM.md "Signing in the browser,
 * proving on the relay"): a device whose sign callback returns the browser's 64-byte signature.
 * `device.sign(ctx, request, counter)` (or `signOffer`) then rebuilds the message from the call's own
 * arguments and the account's state, and verifies that signature over it; a signature over
 * anything else fails before any proving time is spent.
 */
export function ed25519DeviceForCheck(
  auth: { owner: string; signature: string },
  display: Ed25519Display,
): Ed25519Device {
  const signature = hexToBytes(auth.signature.replace(/^0x/, ''), 64);
  return new Ed25519Device({
    publicKey: deviceKeyBytes(auth.owner),
    sign: () => signature,
    label: marketLabel(display.network),
    tokens: ed25519TokenResolver(display.tokens),
  });
}

/** A device known by its public key only (enough to deploy and activate an account: activation is
 *  permissionless, the boot commitment binds the key). */
export function ed25519DeviceForKey(deviceKey: string, display?: Ed25519Display): Ed25519Device {
  return new Ed25519Device({
    publicKey: deviceKeyBytes(deviceKey),
    ...(display ? { label: marketLabel(display.network), tokens: ed25519TokenResolver(display.tokens) } : {}),
  });
}

/** The 64-byte RFC 8032 signature an authorisation carries, as the wire's 128 hex (R's canonical
 *  encoding, then s little-endian). Exactly the bytes the wallet returned: R was decoded strictly
 *  from canonical bytes and s was never reduced. */
export function ed25519SignatureHex(sig: Ed25519SignatureArg): string {
  const s = new Uint8Array(32);
  let v = sig.s;
  for (let i = 0; i < 32; i++) {
    s[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return bytesToHex(encodeEd25519Point(sig.r)) + bytesToHex(s);
}

/** The wire form of a gated call's authorisation (`PassportAuth`, ../accounts.ts). */
export function passportAuthOf(auth: Ed25519Authorisation): { owner: string; signature: string; useCounter: string } {
  return {
    owner: bytesToHex(encodeEd25519Point(auth.pk)),
    signature: ed25519SignatureHex(auth.sig),
    useCounter: auth.use_counter.toString(10),
  };
}
