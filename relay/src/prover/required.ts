// Every circuit the relay PROVES, as "<contract>/<circuit>" in the key volume's layout (plan P4-A,
// "key-volume completeness"). The start-up check (./keys.ts `verifyKeyVolume`) refuses to start the
// relay when any of them lacks its prover key, verifier key or ZKIR, so a missing key is found at
// deploy time instead of in a customer's job an hour later.
//
// Night Market proves only the account's device-arm calls (../passport/arm.ts `ARM_CIRCUITS`, Track
// A's Ed25519 arm) and its offer circuit:
//   account/activate_initial_device_with_ed25519   registration (actions/account-actions.ts)
//   account/withdraw_shielded_with_ed25519         a shielded withdrawal (actions/account-actions.ts)
//   account/withdraw_unshielded_with_ed25519       an unshielded withdrawal (actions/account-actions.ts, B3)
//   account/append_inbox_with_ed25519              re-filing a change coin's entry, Q13 (actions/account-actions.ts)
//   account/open_swap_shielded_with_ed25519        making and taking offers (trade/account-offer.ts)
// and, when the demo-token endpoint is on (AA 00047 B3, demo/faucet.ts):
//   account/deposit_shielded                       the pack's deposit into the account
//   faucet/mint                                    the mint-test-tokens v2 faucet's mint
// MN Bank also proved the bridge circuits and the vault's and the Signet singleton's; Night Market
// has no bridge. (The account contract still declares the vault as a callee, so the key job still
// compiles it: deploy/key-volume/build.sh.)
//
// relay/test/key-completeness.test.ts checks that every circuit name the relay's sources prove is
// listed here, and (once the submodule carries the arm, plan P6.1) that each is a real
// proof-bearing circuit of the compiled account.

import { ARM_CIRCUITS } from '../passport/arm.js';

export const ACCOUNT_PROVEN_CIRCUITS: readonly string[] = [
  ARM_CIRCUITS.activate,
  ARM_CIRCUITS.withdrawShielded,
  ARM_CIRCUITS.withdrawUnshielded,
  ARM_CIRCUITS.appendInbox,
  ARM_CIRCUITS.openSwap,
];

/** The contract directories of the key volume the relay reads: the account, and the mint-test-tokens
 *  v2 faucet the demo-token endpoint proves `mint` for (B3). */
export const KEY_VOLUME_CONTRACTS = { account: 'account', faucet: 'faucet' } as const;

export const RELAY_PROVEN_CIRCUITS: readonly string[] = ACCOUNT_PROVEN_CIRCUITS.map(
  (c) => `${KEY_VOLUME_CONTRACTS.account}/${c}`,
);

/** What the demo-token endpoint proves besides (required only when it is enabled). */
export const DEMO_TOKEN_PROVEN_CIRCUITS: readonly string[] = [
  `${KEY_VOLUME_CONTRACTS.account}/deposit_shielded`,
  `${KEY_VOLUME_CONTRACTS.faucet}/mint`,
];
