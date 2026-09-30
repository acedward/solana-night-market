// The demo-token claim (spec FR-007, questions Q5 option B; AA 00047 lanes B2 web and B3 relay):
// the wire contract both sides import.
//
// "Get demo tokens" asks the market's relay to mint a configured pack from the mint-test-tokens
// stagenet faucets into the caller's account (for example 1,000 twUSDC, 0.1 twBTC and 1 twETH). The
// sponsor pays the DUST; faucet tokens cost nothing to mint.
//
//   CLAIM  the RelayAction `demo-tokens` on the ordinary action route, `POST /v1/actions/demo-tokens`
//          (../api.ts `API_PATHS.action`): `{ account, payload: {}, auth }`, where `auth` is the
//          envelope signed by the account's device (the Solana wallet; the scheme is
//          `solanaRelayActionScheme`, ./passport/relay-envelope.ts, so the wallet shows "For claiming
//          demo tokens"). The envelope proves the caller holds the key, and names the account the
//          pack goes to. The answer is a job (`{ job }`); its result is a `DemoTokensResult`.
//   INFO   `GET /v1/demo-tokens` (DEMO_TOKENS_PATH), public: whether claims are open, the pack, the
//          limits and today's count; with `?owner=<device key>`, whether that key has claimed.
//
// Limits (enforced by the relay, shown by the page): once per Solana key, ever (`perKey`), and a
// daily cap across the relay (`dailyCap`, UTC days), kept in a persistent claims store; the relay's
// ordinary rate limits apply on top. A refused claim answers an ApiError whose `code` is one of
// DEMO_TOKEN_ERROR_CODES (plus the usual `unauthorised`, `rate-limited`, `sponsor-low`, …).

import { z } from 'zod';

/** The public read of the demo-token offer. */
export const DEMO_TOKENS_PATH = '/v1/demo-tokens';

/** `DEMO_TOKENS_PATH` for one device key (64 lowercase hex). */
export const demoTokensInfoPath = (owner?: string) =>
  owner ? `${DEMO_TOKENS_PATH}?owner=${encodeURIComponent(owner)}` : DEMO_TOKENS_PATH;

/** The claim's body: nothing beyond the envelope (the account is the request's and the envelope's). */
export const DemoTokensPayloadSchema = z.object({}).strict();
export type DemoTokensPayload = z.infer<typeof DemoTokensPayloadSchema>;

const hex32 = z.string().regex(/^[0-9a-f]{64}$/);
const decimal = z.string().regex(/^[0-9]{1,40}$/);

/** One token of the pack: its colour, how it shows, and the amount in its base units. */
export const DemoPackItemSchema = z.object({
  colour: hex32,
  symbol: z.string().min(1).max(16),
  decimals: z.number().int().min(0).max(18),
  amount: decimal,
});
export type DemoPackItem = z.infer<typeof DemoPackItemSchema>;

export const DemoTokensInfoSchema = z.object({
  /** False when this relay does not hand out demo tokens (not configured, or paused). */
  enabled: z.boolean(),
  /** Why not, in the relay's words, when disabled. */
  reason: z.string().optional(),
  pack: z.array(DemoPackItemSchema),
  limits: z.object({
    /** Claims per Solana key, ever (1). */
    perKey: z.number().int().positive(),
    /** Claims per UTC day across the relay. */
    dailyCap: z.number().int().nonnegative(),
    /** Claims counted today so far. */
    claimedToday: z.number().int().nonnegative(),
    /** Unix seconds when today's count resets (the next UTC midnight). */
    resetsAt: z.number().int(),
  }),
  /** Present for `?owner=`: whether that key has used its claim. */
  owner: z
    .object({
      deviceKey: hex32,
      claimed: z.boolean(),
      /** Unix seconds of the claim, when claimed. */
      claimedAt: z.number().int().optional(),
    })
    .optional(),
});
export type DemoTokensInfo = z.infer<typeof DemoTokensInfoSchema>;

/** The claim job's public result. */
export interface DemoTokensResult {
  /** The account the pack went to (64 hex). */
  account: string;
  pack: DemoPackItem[];
  /** The transactions that delivered it (the mints and the deposits, or one mint per token straight
   *  to the account). */
  txs: string[];
  /** Coins that reached the account WITHOUT an inbox entry the browser can open (a mint straight to
   *  the contract address), so the browser keeps them itself, as it keeps a withdrawal's change.
   *  Omitted when every coin was deposited with an inbox entry (`deposit_shielded`), which the next
   *  inbox walk reads. */
  coins?: Array<{ nonce: string; color: string; value: string }>;
}

/** Why a claim is refused, beyond the relay's usual codes. */
export const DEMO_TOKEN_ERROR_CODES = [
  /** The relay hands out no demo tokens (not configured, or paused). HTTP 503. */
  'demo-disabled',
  /** This Solana key has already claimed its pack. HTTP 409. */
  'demo-already-claimed',
  /** Today's cap across the relay is reached; the error's `detail` may carry the reset time. HTTP 429. */
  'demo-daily-cap',
] as const;
export type DemoTokenErrorCode = (typeof DEMO_TOKEN_ERROR_CODES)[number];
