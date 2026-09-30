// The seam where the connected Solana wallet signs for the market (lane B2, on Track A's Ed25519
// arm client: its message builder and its device-entry derivation).
//
// MN Bank signed EIP-712 typed data with an EIP-1193 wallet; that is gone (AA 00047). Every browser
// operation (../passport/operations.ts, ../trade/operations.ts) asks for signatures only through
// `ActionSigning`, so lane B2 plugs Phantom in here and nothing else changes:
//   - `relayAction` signs the relay's RelayAction envelope (registration, and a withdrawal's
//     recipient key, F-B6) in the Solana envelope scheme lane B3 defines;
//   - `authorise` builds the arm's message over one account call (F3 readable text or F1 digest,
//     plan A3), shows it next to the decoded action, has the wallet sign it (`signMessage`), and
//     returns the Passport authorisation the relay checks;
//   - `useCounter` finds this device's live rolling entry on the account.

import type { AccountStateView, OpenSwapPayload, PassportAuth, RelayActionMessage } from '@nightmarket/core';
import type { AuthRequest, GatedContext } from '@nightmarket/core/passport';

/** One call to authorise: a gated account call (a withdrawal, an inbox append) or a swap (a make or
 *  a take, one `open_swap_shielded` call). */
export type CallToAuthorise =
  | { kind: 'gated'; request: AuthRequest }
  | { kind: 'swap'; action: 'open-swap' | 'take'; payload: OpenSwapPayload };

export interface ActionSigning {
  /** The device key (64 lowercase hex): the Solana wallet's public key. */
  readonly deviceKey: string;
  /** Sign a RelayAction envelope; resolves to the signature (128 hex). */
  relayAction(message: RelayActionMessage): Promise<string>;
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
