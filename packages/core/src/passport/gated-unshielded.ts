// The AuthRequest of a `withdraw-unshielded` action body (AA 00047 lane B3), in the pinned Passport
// client's own shape, as the browser builds it and the relay rebuilds it (./gated.ts has the others).
// The Ed25519 arm's `Ed25519Device.sign(callContext(ctx), request, counter)` renders its F3 message
// ("Withdraw unshielded", the amount, the recipient's fingerprint) from exactly these arguments.

import { hexToBytes, normaliseHex32 } from '../hex.js';
import type { WithdrawUnshieldedPayload } from '../withdraw-unshielded.js';
import type { AuthRequest } from '../../../../vendor/passport/contract/src/wallet/signer.js';

export function withdrawUnshieldedRequest(p: WithdrawUnshieldedPayload): AuthRequest {
  return {
    op: 'withdrawUnshielded',
    color: hexToBytes(normaliseHex32(p.color), 32),
    amount: BigInt(p.amount),
    recipient: hexToBytes(normaliseHex32(p.recipient), 32),
  };
}
