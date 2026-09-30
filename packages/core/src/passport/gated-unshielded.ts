// The AuthRequest of a `withdraw-unshielded` action body (../unshielded.ts; AA 00047 lane B2), in the
// pinned Passport client's own shape, so the browser signs and the relay rebuilds the same call: the
// arm's `withdraw_unshielded_with_ed25519`, whose F3 message ("Withdraw unshielded") shows the
// amount, the token and the recipient's fingerprint.

import { hexToBytes, normaliseHex32 } from '../hex.js';
import type { WithdrawUnshieldedPayload } from '../unshielded.js';
import type { AuthRequest } from '../../../../vendor/passport/contract/src/wallet/signer.js';

export function unshieldedWithdrawRequest(p: WithdrawUnshieldedPayload): AuthRequest {
  return {
    op: 'withdrawUnshielded',
    color: hexToBytes(normaliseHex32(p.color), 32),
    amount: BigInt(p.amount),
    recipient: hexToBytes(normaliseHex32(p.recipient), 32),
  };
}
