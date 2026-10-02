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

// AA 00047 P10 (questions Q36, P10.C's F3 v3): the circuit puts a fixed "Site: " in front of the label
// and accepts only words of visible ASCII with single spaces between them (no leading space, no run
// of spaces, not empty); `marketLabel` checks the same rule, so both labels below pass either client.
export const MARKET_LABELS: Readonly<Record<NetworkName, string>> = {
  stagenet: 'Night Market - stagenet',
  // "Night Market - undeployed" would be 25 characters.
  undeployed: 'Night Market - local',
};

/** Words of visible ASCII with single spaces between them (F3 v3's label rule, P10.C `isRenderableLabel`). */
export const LABEL_RULE = /^[\x21-\x7e]+( [\x21-\x7e]+)*$/;

export function marketLabel(network: NetworkName): string {
  const label = MARKET_LABELS[network];
  if (label === undefined) throw new RangeError(`no market label for network ${JSON.stringify(network)}`);
  if (label.length > MARKET_LABEL_BYTES || !LABEL_RULE.test(label)) {
    throw new RangeError(
      `the ${network} label must be at most ${MARKET_LABEL_BYTES} printable ASCII characters, words with single spaces between them`,
    );
  }
  return label;
}
