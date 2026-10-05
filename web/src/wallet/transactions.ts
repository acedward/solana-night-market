// AA 00060 (Bridge in): the connected wallet's Solana transaction features, where it has them. A plain
// module (no React), so the Bridge-in operations and the stack harness (test/gates/landing) can use the
// type without the wallet context. `facts` is what the page built, decoded, for its signing panel (P5.3).

import type { TransactionFacts } from './sign-prompt.js';

export interface SolanaTransactions {
  /** `solana:signAndSendTransaction` (the wallet sends): resolves with the first signature. */
  signAndSend?(transaction: Uint8Array, chain: string, facts?: TransactionFacts): Promise<Uint8Array>;
  /** `solana:signTransaction` (the page sends): resolves with the signed wire transaction. */
  sign?(transaction: Uint8Array, chain: string, facts?: TransactionFacts): Promise<Uint8Array>;
}
