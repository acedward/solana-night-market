// "Get demo tokens" (spec FR-007, questions Q5 option B; AA 00047 lane B2 web, lane B3 relay): the
// browser's half of the claim. The relay mints a configured pack from the mint-test-tokens faucets
// into the account, once per Solana key, under a daily cap, and the sponsor pays the DUST.
//
// ONE wallet prompt: the claim's RelayAction envelope (`demo-tokens`, the account, the owner key),
// signed in the Solana scheme (Track A's proof-of-key message, questions Q14): it moves none of the
// customer's funds. The pack lands through `deposit_shielded`, which files an inbox entry sealed to
// the account's own key, so the next inbox walk (syncAccount) shows the new coins.

import {
  buildRelayActionMessage,
  formatUnits,
  type DemoTokensInfo,
  type DemoTokensResult,
  type JobView,
} from '@nightmarket/core';

import {
  OperationError,
  dropJob,
  findJobs,
  gatedContext,
  putJob,
  syncAccount,
  updateJob,
  type OperationEnv,
} from '../passport/operations.js';
import { jobErrorText } from '../relay/messages.js';

/** "1,000.00 twUSDC · 0.10 twBTC · 1.00 twETH" */
export const packText = (pack: DemoTokensInfo['pack']): string =>
  pack
    .map((p) => `${formatUnits(BigInt(p.amount), p.decimals, { minFractionDigits: 2, grouping: true })} ${p.symbol}`)
    .join(' · ');

/** Whether this wallet may claim now, and if not, why (for the button and its note). */
export function claimState(
  info: DemoTokensInfo | null,
): { ok: true } | { ok: false; reason: string; code: 'unavailable' | 'disabled' | 'claimed' | 'cap' } {
  if (!info) return { ok: false, code: 'unavailable', reason: 'This market does not hand out demo tokens.' };
  if (!info.enabled) return { ok: false, code: 'disabled', reason: 'Demo tokens are paused on this market.' };
  if (info.claimed)
    return { ok: false, code: 'claimed', reason: 'This wallet has had its demo tokens (one pack per wallet).' };
  // A pack that failed part-way can be finished whatever the day's count (it was counted already).
  if (info.remainingToday <= 0 && !info.resumable)
    return { ok: false, code: 'cap', reason: 'Today’s demo tokens are all given out. Try again tomorrow (UTC).' };
  return { ok: true };
}

/**
 * Claim the demo pack for `account`: one signature, then the relay's job (resumed when one is in
 * flight), then an inbox walk so the new coins show. Resolves to the job's result.
 */
export async function claimDemoTokens(
  env: OperationEnv,
  account: string,
  onJob?: (job: JobView) => void,
): Promise<DemoTokensResult> {
  let requestId = findJobs(env, account, 'demo-tokens')[0]?.requestId;
  if (!requestId) {
    // The device's current use counter (AA 00047 P9, audit C8 / F-B10): the relay checks the one
    // device entry at this counter instead of scanning for it.
    const { counter } = await gatedContext(env, account);
    const payload = { useCounter: counter.toString(10) };
    const { nonce, maxTtlSeconds } = await env.relay.nonce();
    const message = buildRelayActionMessage({
      action: 'demo-tokens',
      network: env.scope.network,
      owner: env.signing.deviceKey,
      account,
      payload,
      nonce,
      expiry: Math.floor(Date.now() / 1000) + Math.min(maxTtlSeconds, 300),
    });
    const signature = await env.signing.relayAction(message);
    const job = await env.relay.submit('demo-tokens', { account, payload, auth: { message, signature } });
    putJob(env, account, job, 'demo-tokens');
    (onJob ?? env.onJob)?.(job);
    requestId = job.requestId;
  }
  const done = await env.relay.waitForJob(requestId, (j) => {
    updateJob(env, account, j);
    onJob?.(j);
  });
  dropJob(env, account, requestId);
  if (done.state !== 'succeeded' || !done.result)
    throw new OperationError(jobErrorText(done.error, 'The market could not deliver the demo tokens.'));
  await syncAccount(env, account).catch(() => undefined);
  return done.result as unknown as DemoTokensResult;
}
