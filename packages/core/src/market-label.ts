// The first line of every message a Solana wallet shows for Night Market (AA 00047, questions Q12):
// the market and its network, at most 24 printable ASCII characters (the Ed25519 arm's label field).
//
// The circuit renders it from the call's display input and the signature covers it, so the browser
// and the relay must use the same one; the relay envelope's message (./solana-auth.ts, Q14) starts
// with it too. It lives in its own light module (no compiled contract) so the package root can use
// it; `@nightmarket/core/passport` re-exports it unchanged.

import type { NetworkName } from './network.js';

/** The arm's label width (Track A's `ED25519_LABEL_BYTES`; packages/core/test/solana-auth.test.ts
 *  holds the two equal). */
export const MARKET_LABEL_BYTES = 24;

// TODO(P10.I): P10.C's F3 v3 (questions Q36) renders a fixed marker in front of this label and accepts
// only words of visible characters with single spaces; both labels below already are. Re-check them
// against the client's label rule at the re-pin (its "P10.C client API" Evidence row).
export const MARKET_LABELS: Readonly<Record<NetworkName, string>> = {
  stagenet: 'Night Market - stagenet',
  // "Night Market - undeployed" would be 25 characters.
  undeployed: 'Night Market - local',
};

export function marketLabel(network: NetworkName): string {
  const label = MARKET_LABELS[network];
  if (label === undefined) throw new RangeError(`no market label for network ${JSON.stringify(network)}`);
  if (label.length > MARKET_LABEL_BYTES || !/^[\x20-\x7e]*$/.test(label)) {
    throw new RangeError(`the ${network} label must be at most ${MARKET_LABEL_BYTES} printable ASCII characters`);
  }
  return label;
}
