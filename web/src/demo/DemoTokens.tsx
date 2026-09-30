// "Get demo tokens" (spec FR-007, questions Q5 option B; AA 00047 lane B2): the market's relay
// mints a configured pack from the mint-test-tokens faucets into the account, once per Solana key,
// under a daily cap. The card says what the pack is, what the limits are, and why the button is off
// when it is; the claim is one wallet prompt that moves none of the customer's funds.

import { useCallback, useEffect, useState } from 'react';

import type { DemoTokensInfo, JobView, NetworkProfile } from '@nightmarket/core';

import { useAccountView } from '../account/useAccountView.js';
import { Button, Notice, Panel } from '../design/index.js';
import { useRelayStatus } from '../relay/RelayStatus.js';
import { claimDemoTokens, claimState, packText } from './operations.js';

const STAGE_TEXT: Record<string, string> = {
  queued: 'Waiting in line',
  running: 'Started',
  minting: 'Minting from the faucets',
  depositing: 'Depositing into your account',
  submitted: 'Sent to the network',
  succeeded: 'Done',
};

export function DemoTokens({ network, relayUrl }: { network: NetworkProfile; relayUrl: string }) {
  const { account, hasSecret, relay, env, scope } = useAccountView(network, relayUrl);
  const { spendingPaused } = useRelayStatus();
  const [info, setInfo] = useState<DemoTokensInfo | null | 'loading'>('loading');
  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState<JobView | null>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const owner = scope?.owner;

  const load = useCallback(() => {
    relay.demoTokensInfo(owner).then(setInfo, () => setInfo(null));
  }, [relay, owner]);
  useEffect(() => {
    const t = setTimeout(load, 0);
    return () => clearTimeout(t);
  }, [load]);

  if (!account || !hasSecret) return null;
  const state = info === 'loading' ? null : claimState(info);
  if (state && !state.ok && state.code === 'unavailable') return null;

  const claim = async () => {
    const e = env(setJob);
    if (!e) return;
    setBusy(true);
    setMessage(null);
    setJob(null);
    try {
      const r = await claimDemoTokens(e, account.address, setJob);
      const got = r.minted?.length ? r.minted.map((m) => m.symbol).join(', ') : 'the pack';
      setMessage({ kind: 'ok', text: `Demo tokens delivered (${got}). They are in your holdings.` });
    } catch (err) {
      setMessage({
        kind: 'error',
        text: err instanceof Error ? err.message : 'The demo tokens could not be delivered.',
      });
    } finally {
      setBusy(false);
      load();
    }
  };

  const ready = info !== 'loading' && info !== null;
  return (
    <Panel title="Demo tokens" tone="quiet" as="aside" data-testid="demo-tokens">
      {ready ? (
        <>
          <p className="small" data-testid="demo-pack">
            {packText(info.pack)}
          </p>
          <p className="xsmall muted" data-testid="demo-limits">
            One pack per wallet, free: the market mints it from the test faucets and pays the fees.{' '}
            {info.remainingToday} of {info.dailyCap} left today.
          </p>
        </>
      ) : (
        <p className="small muted">Checking what the market offers…</p>
      )}
      {state && !state.ok && (
        <p className="small" data-testid="demo-unavailable" data-code={state.code}>
          {state.reason}
        </p>
      )}
      {spendingPaused && <p className="small">Not now: {spendingPaused}</p>}
      {message && (
        <Notice
          tone={message.kind === 'error' ? 'danger' : 'success'}
          role={message.kind === 'error' ? 'alert' : 'status'}
          className="panel-intro"
          data-testid="demo-message"
        >
          {message.text}
        </Notice>
      )}
      {busy && job && (
        <p className="small" data-testid="demo-stage" data-stage={job.stage}>
          {STAGE_TEXT[job.stage] ?? job.stage}
          {job.state === 'queued' && job.position !== undefined ? ` · position ${job.position} in the queue` : ''}
        </p>
      )}
      <Button
        data-testid="get-demo-tokens"
        disabled={busy || !state?.ok || !!spendingPaused}
        onClick={() => void claim()}
      >
        {busy ? 'Getting demo tokens…' : 'Get demo tokens'}
      </Button>
    </Panel>
  );
}
