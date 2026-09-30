// A TEST-ONLY relay-action scheme and device, so the relay's binding, nonce and route rules can be
// tested before the Solana scheme exists (plan lane B3 defines the real message format, shown in
// the wallet). Ed25519 over a test prefix and the envelope's canonical JSON: NOT the production
// format, and never exported from src.

import { ed25519 } from '@noble/curves/ed25519.js';

import { canonicalJson, type RelayActionMessage, type RelayActionScheme } from '../../src/auth.js';
import { bytesToHex } from '../../src/hex.js';
import { solanaAddressOf, type DeviceSigner } from '../../src/signing.js';

const PREFIX = 'night-market test envelope v0\n';

export const testScheme: RelayActionScheme = {
  id: 'test-ed25519-json',
  messageBytes: (m: RelayActionMessage) => new TextEncoder().encode(PREFIX + canonicalJson(m)),
  verify(m: RelayActionMessage, signature: Uint8Array): boolean {
    const pk = Uint8Array.from(m.owner.match(/../g)!.map((b) => parseInt(b, 16)));
    return ed25519.verify(signature, this.messageBytes(m), pk, { zip215: false });
  },
};

/** A test device: an Ed25519 key (random unless given) that signs like a Solana wallet's
 *  `signMessage`. */
export function testDevice(
  secret: Uint8Array = ed25519.utils.randomSecretKey(),
): DeviceSigner & { signEnvelope(m: RelayActionMessage): string } {
  const deviceKey = bytesToHex(ed25519.getPublicKey(secret));
  return {
    deviceKey,
    address: solanaAddressOf(deviceKey),
    signMessage: async (message: Uint8Array) => ed25519.sign(message, secret),
    signEnvelope: (m: RelayActionMessage) => bytesToHex(ed25519.sign(testScheme.messageBytes(m), secret)),
  };
}
