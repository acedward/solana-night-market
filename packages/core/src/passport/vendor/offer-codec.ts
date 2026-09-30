// VENDORED from acedward/passport @ 51c1fb4ad164af034c8ed60fbb047e43cdd509f5
//   contract/src/wallet/offer.ts, section 2 (the client-side pieces of the call) and the recipient
//   and TTL constants: the change-coin prediction, the call's eight leading arguments, the portable
//   inbox entries and the give-coin choice. These do not depend on the device arm.
//
// WHY: upstream offer.ts cannot load in a browser. It imports node:crypto and node:fs at module
// scope, and inbox.ts, whose module-scope Buffer.from throws without node:buffer (plan 00039
// P0.4). Client-only shim under questions Q12 (option C allowed for shims) and Q18 (option B).
//
// CHANGES from upstream, and nothing else:
//   - imports point at the submodule (vendor/passport) instead of sibling files;
//   - `freshWantNonce` draws from WebCrypto instead of node:crypto's randomBytes;
//   - `offerInboxEntries` (node:crypto, via inbox.ts) is replaced by the async
//     `offerInboxEntriesPortable` (sealEntryPortable), which P0.4 proved interoperable;
//   - sections 1 (the OpenSwapShielded EIP-712 type) and 6 (signing with an `evm` device) are left
//     out (AA 00047: Night Market has no EVM arm; the Ed25519 arm's message builder comes from
//     Track A's client), and so are the envelope (section 3), imbalance reading (4) and the
//     ledger-v9 builder (5), which are relay-side and keep using upstream offer.ts directly.
//
// DROP this file when upstream ships a browser-safe codec (the Q18 request to the PR #4
// workstream). packages/core/test/vendored-vs-upstream.test.ts compares every export here with
// upstream offer.ts on Node, so drift fails CI.
/* eslint-disable */

import { pureCircuits, type QualifiedCoin, type ShieldedCoin } from '../../../../../vendor/passport/contract/src/wallet/contract.js';
import { sealEntryPortable } from '../../../../../vendor/passport/contract/src/wallet/deposit.js';
import { bytesToHex } from '../../../../../vendor/passport/contract/src/wallet/hex.js';

/** Recipient shapes the circuit accepts. Kind 2 (a contract taker) exists in the numbering and is
 *  refused by `assert_open_swap_terms` — see the note there for why it cannot work at all. */
export const RECIPIENT_OPEN = 0n;
export const RECIPIENT_NAMED_COIN_KEY = 1n;
export const RECIPIENT_CONTRACT_REFUSED = 2n;

// ─────────────────────────────────────────────────────────────────────────────
// 2. Client-side pieces of the call
// ─────────────────────────────────────────────────────────────────────────────

/** The surviving change coin of an offer, predicted BEFORE the call.
 *
 *  An offer's change entry is an ARGUMENT — it is appended inside the same call and bound in the
 *  challenge — so the maker cannot read the coin off the result the way every other spend does. The
 *  nonce comes from the contract's own free oracle rather than a TypeScript transcription of the
 *  standard library's rule (questions file, Q34). */
export function predictChangeCoin(coin: QualifiedCoin, giveAmount: bigint): ShieldedCoin | null {
  if (coin.value < giveAmount) {
    throw new RangeError('held coin is smaller than the give amount');
  }
  const value = coin.value - giveAmount;
  if (value === 0n) return null;
  return {
    nonce: (pureCircuits as any).swap_change_nonce(coin.nonce) as Uint8Array,
    color: coin.color,
    value,
  };
}

/** A fresh 32-byte want nonce. Client randomness, never derived from public data: it is what makes
 *  the wanted coin's commitment unpredictable to anyone but the maker until the offer is published. */
export const freshWantNonce = (): Uint8Array => globalThis.crypto.getRandomValues(new Uint8Array(32)); // VENDOR CHANGE: WebCrypto

export interface OfferCallArgs {
  giveColor: Uint8Array;
  giveAmount: bigint;
  recipientKind: bigint;
  recipient: Uint8Array;
  want: ShieldedCoin;
  wantEntry: Uint8Array;
  changeEntry: Uint8Array;
  validUntil: bigint;
}

/** The eight leading circuit arguments, in declaration order. The auth arguments follow. */
export const offerCircuitArgs = (a: OfferCallArgs): unknown[] => [
  a.giveColor,
  a.giveAmount,
  a.recipientKind,
  a.recipient,
  a.want,
  a.wantEntry,
  a.changeEntry,
  a.validUntil,
];

/**
 * Both inbox entries for an offer, sealed to the account's encryption key.
 *
 * The change entry is REQUIRED even when there is no change: it is a circuit argument, so some 192
 * bytes must be passed, and the circuit appends it only when change exists. Passing an entry that
 * describes the (nonexistent) zero-value change coin would put a decryptable lie in the maker's own
 * store if the rule ever changed, so the no-change case passes an all-zero container instead —
 * indistinguishable from any other ciphertext to an observer, and never appended.
 */
export async function offerInboxEntriesPortable( // VENDOR CHANGE: portable (async) sealing
  encPublicKey: Uint8Array,
  want: ShieldedCoin,
  change: ShieldedCoin | null,
): Promise<{ wantEntry: Uint8Array; changeEntry: Uint8Array }> {
  return {
    wantEntry: await sealEntryPortable(encPublicKey, want),
    changeEntry: change ? await sealEntryPortable(encPublicKey, change) : new Uint8Array(192),
  };
}

/** First coin of `color` in the store with `value >= give`. There is no in-circuit merge in
 *  stateless custody, so a client that holds only smaller coins must merge them itself first (two
 *  ordinary spends); refusing here is the honest answer rather than proving something unsettleable. */
export function selectGiveCoin(
  coins: Iterable<QualifiedCoin>,
  color: Uint8Array,
  give: bigint,
): QualifiedCoin {
  const wanted = bytesToHex(color);
  for (const c of coins) {
    if (bytesToHex(c.color) === wanted && c.value >= give) return c;
  }
  throw new Error(
    `no held coin of colour ${wanted} with value >= ${give}; stateless custody has no in-circuit ` +
      'merge, so the client must combine coins first',
  );
}

/** The ledger's hard cap on an intent's lifetime (upstream section 3). */
export const TTL_CAP_SECONDS = 3600;
