// Demo tokens (AA 00047 lane B3, spec FR-007, questions Q5 B): the relay mints a configured pack
// from the mint-test-tokens faucets into the caller's account, once per Solana key, under a daily
// cap. The sponsor pays the DUST; faucet tokens cost nothing to mint.
//
//   POST /v1/actions/demo-tokens   { account, payload: {}, auth: <RelayAction envelope> }
//   GET  /v1/demo-tokens[?owner=<device key>]   the pack, the limits, and whether that key claimed
//
// The claim is a RelayAction envelope (action `demo-tokens`, the account, the owner key) signed in
// the Solana scheme (./solana-auth.ts, Q14): one wallet prompt. The relay admits it only when the
// owner key is a live device of the account and the account is a market account (its on-chain
// verifier keys are the relay's pinned set).

import { z } from 'zod';

const hex32 = z.string().regex(/^[0-9a-f]{64}$/);
const decimal = z.string().regex(/^[0-9]{1,40}$/);

/** The claim's body: nothing beyond the account the request names. */
export const DemoTokensPayloadSchema = z.object({}).strict();
export type DemoTokensPayload = z.infer<typeof DemoTokensPayloadSchema>;

/** How the pack reaches the account (plan B3; the evidence decides the default):
 *  - `direct`: each faucet mints straight to the account's contract address and the account's
 *    `deposit_shielded` receives it in the SAME transaction (one transaction per token);
 *  - `via-sponsor`: each faucet mints to the relay's sponsor wallet, which then deposits the coin
 *    into the account with `deposit_shielded` (two transactions per token). */
export const DEMO_TOKEN_PATHS = ['direct', 'via-sponsor'] as const;
export type DemoTokenPath = (typeof DEMO_TOKEN_PATHS)[number];

export const DemoTokenPackItemSchema = z.object({
  symbol: z.string(),
  colour: hex32,
  decimals: z.number().int(),
  /** Base units. */
  amount: decimal,
});
export type DemoTokenPackItem = z.infer<typeof DemoTokenPackItemSchema>;

export const DemoTokensInfoSchema = z.object({
  enabled: z.boolean(),
  pack: z.array(DemoTokenPackItemSchema),
  /** Claims per Solana key, ever (1). */
  perKey: z.number().int(),
  /** Claims the relay admits in any rolling 24 hours. */
  dailyCap: z.number().int(),
  remainingToday: z.number().int(),
  /** Present when the request named an owner: whether that key has claimed (or is claiming). */
  claimed: z.boolean().optional(),
});
export type DemoTokensInfo = z.infer<typeof DemoTokensInfoSchema>;

export interface DemoTokenMint {
  symbol: string;
  colour: string;
  /** Base units. */
  amount: string;
  /** `direct`: `mintAndDeposit`; `via-sponsor`: `mint` then `deposit`. */
  txs: { mintAndDeposit?: string; mint?: string; deposit?: string };
}

export interface DemoTokensResult {
  account: string;
  path: DemoTokenPath;
  minted: DemoTokenMint[];
}
