// Demo tokens (AA 00047 lane B3, spec FR-007, questions Q5 B): the relay mints a configured pack
// from the mint-test-tokens faucets into the caller's account, once per Solana key, under a daily
// cap. The sponsor pays the DUST; faucet tokens cost nothing to mint.
//
//   POST /v1/actions/demo-tokens   { account, payload: { useCounter }, auth: <RelayAction envelope> }
//   GET  /v1/demo-tokens[?owner=<device key>]   the pack, the limits, and whether that key claimed
//
// The claim is a RelayAction envelope (action `demo-tokens`, the account, the owner key) signed in
// the Solana scheme (./solana-auth.ts, Q14): one wallet prompt. The relay admits it only when the
// owner key is a live device of the account and the account is a market account (its on-chain
// verifier keys are the relay's pinned set). The body names the device's CURRENT use counter
// (AA 00047 P9, audit C8 / F-B10), so the relay checks the one rolling entry it derives at that
// counter instead of scanning counters (a scan has to stop somewhere: it stopped at 255).

import { z } from 'zod';

const hex32 = z.string().regex(/^[0-9a-f]{64}$/);
const decimal = z.string().regex(/^[0-9]{1,40}$/);

/** The claim's body: the signing device's current use counter (decimal); the account is the
 *  request's own `account`. The envelope's body hash signs it. */
export const DemoTokensPayloadSchema = z.object({ useCounter: decimal }).strict();
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
  /** Present when the request named an owner (AA 00047 P9, audit C8 / F-B7): whether that key has a
   *  pack that failed part-way, which it may claim again to get the rest (already charged: the day's
   *  cap does not stop it). Optional so a page tolerates an older relay. */
  resumable: z.boolean().optional(),
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
  /** Pack tokens the market held back (AA 00047 P10, R2-7): an earlier delivery of each was cut off
   *  and could not be checked on chain, so the market will not mint it again; an operator decides.
   *  Absent when none. */
  held?: { symbol: string; colour: string }[];
}
