// The account's UNSHIELDED side (spec US3 and FR-001; AA 00047 lane B2 web, lane B3 relay): the wire
// contract both sides import.
//
// A Passport account can also hold unshielded tokens (the registry's utwUSDC and utwBTC, sent to the
// contract's address by anyone); they are public contract balances, not coins, so the browser keeps
// nothing for them and reads them from the relay:
//
//   READ      `GET /v1/accounts/:account/unshielded` (unshieldedBalancesPath): the account's
//             unshielded balance per token colour, from the chain (UnshieldedBalancesView).
//   WITHDRAW  the RelayAction `withdraw-unshielded` on `POST /v1/actions/withdraw-unshielded`: the
//             arm's `withdraw_unshielded_with_ed25519` call, authorised by its OWN signature
//             (`passportAuth`, a `passport-call` like `withdraw`: the wallet signs the circuit's F3
//             "Withdraw unshielded" message, which covers the colour, the amount, the recipient and
//             the nonce, so ONE prompt). The recipient is an unshielded wallet address,
//             `mn_addr_<network>1…` (32 bytes). The job's result is a WithdrawUnshieldedResult.
//
// The gated call's AuthRequest is `unshieldedWithdrawRequest(payload)`
// (./passport/gated-unshielded.ts), so the browser and the relay build the same one.

import { bech32m } from '@scure/base';
import { z } from 'zod';

import { bytesToHex } from './hex.js';

const hex32 = z.string().regex(/^(0x)?[0-9a-fA-F]{64}$/);
const decimal = z.string().regex(/^[0-9]{1,40}$/);

/** `GET` the account's unshielded balances. */
export const unshieldedBalancesPath = (account: string) => `/v1/accounts/${account}/unshielded`;

export const UnshieldedBalancesViewSchema = z.object({
  account: z.string().regex(/^[0-9a-f]{64}$/),
  /** One row per colour with a non-zero balance, in base units (decimal strings). */
  balances: z.array(z.object({ colour: z.string().regex(/^[0-9a-f]{64}$/), amount: decimal })),
  /** The newest block the answer covers. */
  blockHeight: z.number().int().nonnegative(),
});
export type UnshieldedBalancesView = z.infer<typeof UnshieldedBalancesViewSchema>;

/** The body of `withdraw-unshielded`: pay `amount` of `color` from the account's unshielded balance
 *  to an unshielded wallet (its 32-byte user address). */
export const WithdrawUnshieldedPayloadSchema = z
  .object({
    /** The recipient's unshielded user address (32 bytes, from `mn_addr_…`). */
    recipient: hex32,
    color: hex32,
    amount: decimal,
    /** The auth nonce the signed challenge binds. */
    authNonce: decimal,
  })
  .strict();
export type WithdrawUnshieldedPayload = z.infer<typeof WithdrawUnshieldedPayloadSchema>;

export interface WithdrawUnshieldedResult {
  txId: string;
}

// ── Unshielded wallet addresses ──────────────────────────────────────────────

export class UnshieldedAddressError extends Error {
  override name = 'UnshieldedAddressError';
}

/** Decode an unshielded wallet address (`mn_addr_<network>1…`; 'mainnet' has no network segment)
 *  to its 32-byte user address (64 lowercase hex). */
export function parseUnshieldedAddress(text: string, network: string): string {
  let decoded: { prefix: string; bytes: Uint8Array };
  try {
    decoded = bech32m.decodeToBytes(text.trim() as `${string}1${string}`);
  } catch {
    throw new UnshieldedAddressError('This is not a Midnight address.');
  }
  const [prefix, type, net = 'mainnet'] = decoded.prefix.split('_');
  if (prefix !== 'mn' || type !== 'addr') throw new UnshieldedAddressError('This is not an unshielded wallet address.');
  if (net !== network) throw new UnshieldedAddressError(`This address is for the ${net} network, not ${network}.`);
  if (decoded.bytes.length !== 32) throw new UnshieldedAddressError('This unshielded address has the wrong length.');
  return bytesToHex(decoded.bytes);
}

/** Encode (tests, and showing an address). */
export function formatUnshieldedAddress(userAddress: string, network: string): string {
  const bytes = Uint8Array.from(
    userAddress
      .replace(/^0x/, '')
      .match(/../g)!
      .map((b) => parseInt(b, 16)),
  );
  if (bytes.length !== 32) throw new UnshieldedAddressError('a user address is 32 bytes');
  const prefix = network === 'mainnet' ? 'mn_addr' : `mn_addr_${network}`;
  return bech32m.encode(prefix, bech32m.toWords(bytes), false);
}
