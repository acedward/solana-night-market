// The Passport client surface the BROWSER uses, imported module by module from the pinned
// submodule (vendor/passport = acedward/passport @ 451f761, branch 00047-solana-ed25519-arm: Track
// A's Ed25519 arm; questions Q12 option A).
//
// Never import the package root or its `./browser` entry here: the root pulls in modules that
// cannot load in a browser, and `./browser` drags in ledger-v9 (+10 MB of WASM). The set below
// is the one plan P0.4 proved byte-identical in Chromium, Node and Bun.
//
// The ARM-AGNOSTIC pieces (the account's encryption keys and inbox entries, the compiled contract's
// pure circuits, the call arguments and the offer's client-side pieces), and the device arm: Track
// A's Ed25519 arm client with what the browser and the relay must agree on (./ed25519.ts, AA 00047
// B1.5). MN Bank's EVM arm is gone (AA 00047).
//
// The compiled account module is compactc 0.35.0's and imports compact-runtime 0.20.0 through the
// `@midnight-ntwrk/compact-runtime-0.20` alias (scripts/pin-contract-runtime.mjs), so the browser
// bundle holds that runtime only; the relay's SDK keeps 0.19.0.
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

export * from './ed25519.js';
export * from './gated.js';
export * from './gated-unshielded.js';
export * from './offer-call.js';
export * from './relay-envelope.js';
export * from './vendor/offer-codec.js';

/** The upstream commit the client code above comes from. */
export const PASSPORT_CLIENT_COMMIT = '451f7610e90000e0c5550877418122a04b85d0e6';
