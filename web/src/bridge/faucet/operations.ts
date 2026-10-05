// "Mint Solana tokens" (AA 00060 P13, spec FR-024; FR-023's Portfolio action 5): the browser's half of the
// market's TEST SPL faucet. The relay mints the bridged test tokens (the journey registry's X, Y, …) to the
// connected Solana wallet and pays the fee; the wallet is asked for NOTHING (no signature, no transaction).
//
//   faucetOffer      GET /v1/spl-faucet?wallet=  what a claim mints, whether the faucet is on, the wallet's
//                    last claim (null: this relay does not serve it)
//   claimSolanaTokens POST /v1/actions/spl-faucet {wallet}, then the job until it ends
//   solanaBalances   each token's balance in the wallet's associated token account, read from the SITE's
//                    Solana RPC (never the relay's word for it)

import {
  SPL_FAUCET_REFUSALS,
  SplFaucetResultSchema,
  formatUnits,
  type JobView,
  type SplFaucetInfo,
  type SplFaucetOffReason,
  type SplFaucetResult,
  type SplFaucetToken,
} from '@nightmarket/core';
import { associatedTokenAddress } from '@nightmarket/core/solana';

import { RelayError, type RelayClient } from '../../relay/client.js';
import { SolanaRpc } from '../solana-rpc.js';

export class FaucetError extends Error {
  override name = 'FaucetError';
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

/** "1,000 X and 1,000 Y" */
export function faucetAmountsText(tokens: readonly Pick<SplFaucetToken, 'amount' | 'decimals' | 'symbol'>[]): string {
  const parts = tokens.map((t) => `${formatUnits(BigInt(t.amount), t.decimals, { grouping: true })} ${t.symbol}`);
  return parts.length <= 1 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}

const OFF_TEXT: Record<SplFaucetOffReason, string> = {
  'not-configured': 'This market does not offer Mint Solana tokens.',
  mainnet: 'Mint Solana tokens is a test faucet: it is never offered on Solana mainnet.',
  'wrong-cluster': "The market's Solana connection is not the network its tokens are on, so the faucet is paused.",
  'authority-mismatch':
    "The market's faucet can no longer mint one of the tokens (its key is not the token's mint authority).",
  'mint-mismatch': 'One of the tokens the faucet would mint is not the token this site lists, so the faucet is paused.',
  unavailable: 'The market cannot reach Solana right now. Try again in a minute.',
};

/** Whether "Mint Solana tokens" is offered, and if not, why (for the action's disabled state). */
export function faucetAvailability(
  info: SplFaucetInfo | null | 'loading',
):
  | { state: 'loading' }
  | { state: 'offered' }
  | { state: 'not-offered'; reason: string; code: SplFaucetOffReason | 'unknown' } {
  if (info === 'loading') return { state: 'loading' };
  if (!info) return { state: 'not-offered', reason: OFF_TEXT['not-configured'], code: 'not-configured' };
  if (info.enabled) return { state: 'offered' };
  const code = info.reason ?? 'unknown';
  return { state: 'not-offered', reason: code === 'unknown' ? OFF_TEXT.unavailable : OFF_TEXT[code], code };
}

/** "14:06 UTC, 6 Oct" from Unix seconds. */
export const faucetTime = (unix: number): string =>
  new Date(unix * 1000).toLocaleString('en-GB', {
    timeZone: 'UTC',
    hour: '2-digit',
    minute: '2-digit',
    day: 'numeric',
    month: 'short',
  }) + ' UTC';

/** The faucet's refusals and failures in plain words. */
export function faucetErrorText(e: unknown): string {
  if (e instanceof FaucetError) return e.message;
  if (e instanceof RelayError) {
    switch (e.code) {
      case SPL_FAUCET_REFUSALS.period:
        return `Already claimed: ${e.relayMessage}.`;
      case SPL_FAUCET_REFUSALS.pending:
        return "This wallet's last claim is still on its way to Solana. Wait a minute, then check your balance.";
      case SPL_FAUCET_REFUSALS.cap:
        return `The faucet is busy: ${e.relayMessage}.`;
      case SPL_FAUCET_REFUSALS.off:
        return e.detail && e.detail in OFF_TEXT ? OFF_TEXT[e.detail as SplFaucetOffReason] : e.message;
      case SPL_FAUCET_REFUSALS.badWallet:
        return 'The connected wallet address is not a Solana address.';
      case 'unauthorised':
        if (e.detail === 'not-supported') return OFF_TEXT['not-configured'];
        break;
      case 'rate-limited':
        return 'Too many requests from this address. Wait a minute, then try again.';
    }
    return e.message;
  }
  return e instanceof Error ? e.message : 'The faucet could not mint your tokens.';
}

/** What the faucet answers, for `wallet` when given (null: this relay does not serve it). */
export const faucetOffer = (relay: RelayClient, wallet?: string): Promise<SplFaucetInfo | null> =>
  relay.splFaucetInfo(wallet);

/** Claim the faucet's tokens for `wallet`: one request (no wallet prompt), then the job to its end. */
export async function claimSolanaTokens(
  relay: RelayClient,
  wallet: string,
  onJob?: (job: JobView) => void,
  opts: { intervalMs?: number } = {},
): Promise<SplFaucetResult> {
  const job = await relay.submit('spl-faucet', { payload: { wallet } });
  onJob?.(job);
  const done = await relay.waitForJob(job.requestId, (j) => onJob?.(j), { intervalMs: opts.intervalMs ?? 1_000 });
  if (done.state !== 'succeeded' || !done.result) {
    const code = done.error?.code ?? 'failed';
    const text =
      code === SPL_FAUCET_REFUSALS.pending
        ? "The faucet's transaction was sent but Solana has not confirmed it yet. Check your balance in a minute; it is settled on your next claim."
        : code === SPL_FAUCET_REFUSALS.off
          ? `${done.error?.message ?? 'The faucet is paused'}.`
          : code === 'market-unavailable'
            ? 'The market could not reach Solana while minting. If nothing arrives, try again in a minute.'
            : `The faucet could not mint your tokens: ${done.error?.message ?? 'it failed'}.`;
    throw new FaucetError(text, code);
  }
  const r = SplFaucetResultSchema.safeParse(done.result);
  if (!r.success || r.data.wallet !== wallet)
    throw new FaucetError('The market answered something unexpected.', 'bad-result');
  return r.data;
}

/** P11 (light review L-B2): the RPC the faucet's balances are read on: the checked one (`solanaLineRpc`,
 *  never the injector's origin), or why there is none; null while bridging is not set up. */
export function faucetSolanaRpc(
  guard: { url: string } | { refused: string } | null,
  fetchImpl?: typeof fetch,
): { rpc: SolanaRpc } | { refused: string } | null {
  if (!guard) return null;
  if ('refused' in guard) return { refused: guard.refused };
  return { rpc: new SolanaRpc(guard.url, fetchImpl) };
}

/** Each token's balance (base units) in `wallet`'s associated token account, from the site's own Solana RPC;
 *  null for a token whose balance could not be read. A missing account is 0. */
export async function solanaBalances(
  rpc: SolanaRpc,
  wallet: string,
  tokens: readonly Pick<SplFaucetToken, 'mint'>[],
): Promise<Map<string, bigint | null>> {
  const out = new Map<string, bigint | null>();
  await Promise.all(
    tokens.map(async (t) => {
      try {
        out.set(t.mint, (await rpc.tokenBalance(associatedTokenAddress(wallet, t.mint))) ?? 0n);
      } catch {
        out.set(t.mint, null);
      }
    }),
  );
  return out;
}
