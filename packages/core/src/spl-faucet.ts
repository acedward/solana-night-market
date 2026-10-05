// "Mint Solana tokens" (AA 00060 P13, spec FR-024; part of FR-023's Portfolio action 5): a TEST faucet on
// the relay that mints the bridged test SPL tokens (the journey registry's I-1 entries, e.g. X and Y) to
// the requesting Solana wallet. The market's faucet key pays the fee; the wallet is asked for nothing.
//
//   POST /v1/actions/spl-faucet   { payload: { wallet: <base58> } }        no signature (see below)
//   GET  /v1/spl-faucet[?wallet=<base58>]   what a claim mints, the period, and that wallet's last claim
//
// Defaults (the orchestrator's, the owner may adjust): test networks only (refused on mainnet-beta's
// genesis hash, and off unless configured), 1,000 whole tokens of each mint per claim in its own decimals,
// once per wallet per 24 h, the claims kept on disk.
//
// Authorisation: UNSIGNED, with its own per-client budget (the C2 pattern of the P10 audit). A wallet
// prompt would break FR-024 ("no wallet prompt"), and a claim can only ever mint to the wallet it names,
// so naming someone else's wallet gives them their tokens, and nothing it charges falls on that wallet's
// other allowances: the request is charged to the CLIENT (its rate limits, a per-client claim cap and a
// global cap per period), never to the wallet's owner limiter, failure budget or account gate.

import { z } from 'zod';

/** Solana mainnet-beta's genesis hash: the faucet never runs against it. */
export const SOLANA_MAINNET_BETA_GENESIS_HASH = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';

/** Why the faucet is off (`GET /v1/spl-faucet` `reason`):
 *  - `not-configured`: the relay has no faucet keys (SPL_FAUCET_KEYS_FILE);
 *  - `mainnet`: the registry or the Solana RPC is mainnet-beta;
 *  - `wrong-cluster`: the Solana RPC is not the journey registry's cluster;
 *  - `authority-mismatch`: a mint's on-chain mint authority is not the key the relay holds;
 *  - `mint-mismatch`: a mint is missing, is not a classic SPL Token mint, or has other decimals than I-1;
 *  - `unavailable`: the relay could not read the Solana RPC yet (it checks again). */
export const SPL_FAUCET_OFF_REASONS = [
  'not-configured',
  'mainnet',
  'wrong-cluster',
  'authority-mismatch',
  'mint-mismatch',
  'unavailable',
] as const;
export type SplFaucetOffReason = (typeof SPL_FAUCET_OFF_REASONS)[number];

/** The route's refusal codes (HTTP status in brackets). */
export const SPL_FAUCET_REFUSALS = {
  /** [403] the faucet is off for one of `SPL_FAUCET_OFF_REASONS` (the detail names it). */
  off: 'spl-faucet-off',
  /** [429] this wallet claimed within the period (Retry-After: until its next claim). */
  period: 'spl-faucet-period',
  /** [409] this wallet's last claim is still being sent or confirmed. */
  pending: 'spl-faucet-pending',
  /** [429] the faucet's claims for this period, or this client's, are used up. */
  cap: 'spl-faucet-cap',
  /** [400] the wallet is not a Solana address. */
  badWallet: 'spl-faucet-bad-wallet',
  /** the job: the transaction failed on Solana (nothing was minted). */
  failed: 'spl-faucet-failed',
} as const;

const base58Key = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
const decimal = z.string().regex(/^[0-9]{1,40}$/);

/** The claim's body: the Solana wallet to mint to. */
export const SplFaucetPayloadSchema = z.object({ wallet: base58Key }).strict();
export type SplFaucetPayload = z.infer<typeof SplFaucetPayloadSchema>;

export const SplFaucetTokenSchema = z.object({
  /** The SPL mint (base58). */
  mint: base58Key,
  symbol: z.string(),
  name: z.string(),
  decimals: z.number().int(),
  /** Base units per claim. */
  amount: decimal,
});
export type SplFaucetToken = z.infer<typeof SplFaucetTokenSchema>;

export const SplFaucetInfoSchema = z.object({
  enabled: z.boolean(),
  /** Why it is off (absent while it is on). */
  reason: z.enum(SPL_FAUCET_OFF_REASONS).optional(),
  /** What a claim mints (empty when it is not configured). */
  tokens: z.array(SplFaucetTokenSchema),
  /** One claim per wallet per this many hours. */
  periodHours: z.number().int(),
  /** Present when the request named a wallet: its last claim in the current period, if any. */
  claim: z
    .object({
      state: z.enum(['claimed', 'pending']),
      /** Unix seconds of the claim. */
      at: z.number().int(),
      /** Unix seconds from which the wallet may claim again (when `claimed`). */
      nextClaimAt: z.number().int(),
      /** The claim's Solana transaction signature, when it has one. */
      signature: z.string().optional(),
    })
    .optional(),
});
export type SplFaucetInfo = z.infer<typeof SplFaucetInfoSchema>;

export const SplFaucetResultSchema = z.object({
  wallet: base58Key,
  /** The one Solana transaction that created any missing token account and minted every token. */
  signature: z.string(),
  minted: z.array(
    SplFaucetTokenSchema.extend({
      /** The wallet's associated token account for the mint. */
      tokenAccount: base58Key,
      /** Whether the claim created that account. */
      createdAccount: z.boolean(),
    }),
  ),
  at: z.number().int(),
  nextClaimAt: z.number().int(),
});
export type SplFaucetResult = z.infer<typeof SplFaucetResultSchema>;
