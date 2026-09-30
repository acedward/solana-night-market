// The `withdraw-unshielded` action (AA 00047 lane B3): pay unshielded tokens the account holds to a
// Midnight user address, with the arm's `withdraw_unshielded_with_ed25519`. Authorised, like every
// account call, by the call's own F3 signature (PassportAuth: "Withdraw unshielded", the amount with
// the token's decimals, the recipient's fingerprint), so it is one wallet prompt. Unshielded coins
// carry no secret, so there is no coin argument and no inbox entry.

import { z } from 'zod';

const hex32 = z.string().regex(/^(0x)?[0-9a-fA-F]{64}$/);
const decimal = z.string().regex(/^[0-9]{1,40}$/);

export const WithdrawUnshieldedPayloadSchema = z
  .object({
    /** The recipient's 32-byte user address (the payload of a Midnight `mn_addr…` address). */
    recipient: hex32,
    /** The token's colour (its raw type), 64 hex. */
    color: hex32,
    /** Base units (Uint<128> in the circuit; the arm renders at most 10^24 − 1). */
    amount: decimal,
    /** The auth nonce the signed challenge binds. */
    authNonce: decimal,
  })
  .strict();
export type WithdrawUnshieldedPayload = z.infer<typeof WithdrawUnshieldedPayloadSchema>;

export interface WithdrawUnshieldedResult {
  txId: string;
}
