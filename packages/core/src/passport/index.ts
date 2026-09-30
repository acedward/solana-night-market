// The Passport client surface the BROWSER uses, imported module by module from the pinned
// submodule (vendor/passport = acedward/passport @ 51c1fb4, questions Q12 option A).
//
// Never import the package root or its `./browser` entry here: the root pulls in modules that
// cannot load in a browser, and `./browser` drags in ledger-v9 (+10 MB of WASM). The set below
// is the one plan P0.4 proved byte-identical in Chromium, Node and Bun.
//
// Only the ARM-AGNOSTIC pieces are exported: the account's encryption keys and inbox entries, the
// compiled contract's pure circuits, the call arguments and the offer's client-side pieces. The
// device arm (how a call is signed and checked) is Track A's Ed25519 arm, which lanes B2 and B3 plug
// in (../signing.ts); MN Bank's EVM arm is gone (AA 00047).
//
// One piece is a vendored shim (Q18 option B), because its upstream module cannot load in a
// browser: the offer codec's client-side section (./vendor/offer-codec.ts). It carries its upstream
// source and commit.
//
// Needs the light compile first (`bun run contracts`): contract.ts imports the generated account
// module from the submodule's git-ignored contracts/managed/.

export {
  generateEncKeyPairPortable,
  sealEntryPortable,
  openEntryPortable,
  inboxWalkPortable,
} from '../../../../vendor/passport/contract/src/wallet/deposit.js';
export {
  ENTRY_SIZE,
  ENTRY_VERSION,
  ENTRY_SUITE,
  type PlainCoin,
} from '../../../../vendor/passport/contract/src/wallet/entry-format.js';
export type { AuthRequest, CallContext } from '../../../../vendor/passport/contract/src/wallet/signer.js';
export {
  pureCircuits,
  type QualifiedCoin,
  type ShieldedCoin,
} from '../../../../vendor/passport/contract/src/wallet/contract.js';

export * from './gated.js';
export * from './offer-call.js';
export * from './vendor/offer-codec.js';

/** The upstream commit the client code above comes from. */
export const PASSPORT_CLIENT_COMMIT = '51c1fb4ad164af034c8ed60fbb047e43cdd509f5';
