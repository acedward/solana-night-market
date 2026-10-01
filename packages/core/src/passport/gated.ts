// One gated Passport call's ARGUMENTS, as the browser builds them and the relay rebuilds them.
//
// A gated call binds its arguments and the account's public state in a challenge that the device
// signs; the relay rebuilds the same challenge from the same arguments (never trusting what it is
// sent) and checks the signature against a live device of the account. This module holds the
// arm-agnostic half: the call context and the `AuthRequest` of each action body, in the pinned
// Passport client's own shapes. The arm-specific half (the message the Solana wallet signs, and its
// check) is Track A's Ed25519 arm client (./ed25519.ts): its `Ed25519Device.sign(callContext(ctx),
// request, counter)` takes exactly what this module builds.
//
// The coin a spend consumes is part of the signed challenge (AUTH-10), `mt_index` included, so
// the browser resolves the coin's exact position BEFORE it builds the call (../coins.ts).

import type { AppendInboxPayload, CancelOffersPayload, WithdrawPayload } from '../accounts.js';
import { hexToBytes, normaliseHex32 } from '../hex.js';
import type { AuthRequest, CallContext } from '../../../../vendor/passport/contract/src/wallet/signer.js';

/** The account state a gated call is built against (all public). */
export interface GatedContext {
  /** The account's contract address, 64 hex. */
  account: string;
  /** The auth nonce the call executes against. */
  authNonce: bigint;
  /** The account's network salt, 64 hex: its sealed `evm_domain_salt` (AccountStateView
   *  `networkSalt`). The Ed25519 arm binds it into every challenge, so a signature for one network
   *  (or one deployment) can never be used on another. */
  networkSalt: string;
  /** The account's CURRENT encryption key, 64 hex: its ledger `enc_key` (AccountStateView
   *  `encKey`; the page reads it from the chain, the relay from its ledger read). The F3 v2 client
   *  (vendor/passport @ b2f1847) renders the arm's `rotate_enc_key` from it: re-affirming this key is
   *  the market's on-chain cancel, "Cancel all open offers" (questions Q30, Q32), and any other key
   *  would read "Rotate encryption key". */
  encKey: string;
}

/** The Passport client's call context for `ctx` (the F3 v2 client's `CallContext`, `encKey` included). */
export const callContext = (ctx: GatedContext): CallContext => ({
  contractAddress: hexToBytes(normaliseHex32(ctx.account), 32),
  authNonce: ctx.authNonce,
  evmDomainSalt: hexToBytes(normaliseHex32(ctx.networkSalt), 32),
  encKey: hexToBytes(normaliseHex32(ctx.encKey), 32),
});

/** The AuthRequest of a `withdraw` action body. */
export function withdrawRequest(p: WithdrawPayload): AuthRequest {
  return {
    op: 'withdrawShielded',
    recipient: hexToBytes(normaliseHex32(p.recipient), 32),
    color: hexToBytes(normaliseHex32(p.color), 32),
    amount: BigInt(p.amount),
    coin: {
      nonce: hexToBytes(normaliseHex32(p.coin.nonce), 32),
      color: hexToBytes(normaliseHex32(p.coin.color), 32),
      value: BigInt(p.coin.value),
      mt_index: BigInt(p.coin.mtIndex),
    },
  };
}

/** The AuthRequest of an `append-inbox` action body. */
export function appendInboxRequest(p: AppendInboxPayload): AuthRequest {
  return { op: 'appendInbox', entry: hexToBytes(p.entry, 192) };
}

/** The AuthRequest of a `cancel-offers` action body: re-affirm the account's encryption key (the
 *  arm's `rotate_enc_key`, questions Q30), which only bumps the auth nonce. */
export function cancelOffersRequest(p: CancelOffersPayload): AuthRequest {
  return { op: 'rotateEncKey', newKey: hexToBytes(normaliseHex32(p.newKey), 32) };
}

/**
 * The device's current use counter (MIP-0013 S11): the counter whose rolling entry is a live
 * member of the account's device set. `entryAt(counter)` is the arm's entry derivation for this
 * device, account and epoch (the Ed25519 arm's comes from Track A's client). Starts at the
 * browser's remembered counter (a hint) and scans forward; null when no entry within `limit` is
 * live (not a device of this account).
 */
export function findUseCounter(
  devices: readonly string[],
  entryAt: (counter: bigint) => string,
  hint = 0n,
  limit = 4096n,
): bigint | null {
  const live = new Set(devices.map((d) => d.toLowerCase()));
  if (live.has(entryAt(hint).toLowerCase())) return hint;
  for (let k = 0n; k < limit; k++) if (live.has(entryAt(k).toLowerCase())) return k;
  return null;
}
