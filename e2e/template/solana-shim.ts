// AA 00057 (staged at packages/contracts-solana/.journey-shim.ts in the 00058 template volume, as AA 00058's
// P5 harness staged its .p5-shim.ts): re-exports that package's Solana libraries for bridge-wallets.ts,
// which lives in contracts-midnight (Bun's isolated linker resolves bare imports from the importing
// file's package).
export * as web3 from '@solana/web3.js';
export * as spl from '@solana/spl-token';
