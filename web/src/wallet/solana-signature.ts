// The Solana wallet's signature check now lives in `@nightmarket/core` (packages/core/src/solana-signature.ts),
// unchanged, so the landing-key library (packages/core/src/bridge/landing-key.ts, AA 00060 P1) refuses a
// Ledger-wrapped signature exactly as the page does. This module keeps the page's import path.
export {
  OFFCHAIN_SIGNING_DOMAIN,
  classifyWalletSignature,
  offchainWrappings,
  type SignatureVerdict,
} from '@nightmarket/core/solana-signature';
