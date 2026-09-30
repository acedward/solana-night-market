// "Get demo tokens" (spec FR-007, questions Q5 option B; AA 00047 lane B2, restyled in P8.1): the
// market's relay mints a configured pack from the mint-test-tokens faucets into the account, once
// per Solana key, under a daily cap. The card says what the pack is, what the limits are, and why
// the button is off when it is; the claim is one wallet prompt that moves none of the customer's
// funds, and the signing modal follows it to the end.

import { useCallback, useEffect, useState } from 'react';

import type { DemoTokensInfo, JobView, NetworkProfile } from '@nightmarket/core';

import { useActivity } from '../activity/ActivityContext.js';
import { stageWords } from '../activity/activity.js';
import { useAccountView } from '../account/useAccountView.js';
import { Button, Icon, Panel, Skeleton, Toast } from '../design/index.js';
import { useRelayStatus } from '../relay/RelayStatus.js';
import { claimDemoTokens, claimState, packText } from './operations.js';

export function DemoTokens({ network, relayUrl }: { network: NetworkProfile; relayUrl: string }) {
  const { account, hasSecret, relay, env, scope } = useAccountView(network, relayUrl);
  const { spendingPaused } = useRelayStatus();
  const activity = useActivity();
  const [info, setInfo] = useState<DemoTokensInfo | null | 'loading'>('loading');
  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState<JobView | null>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const owner = scope?.owner;
  const dismiss = useCallback(() => setMessage(null), []);

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

  const onJob = (j: JobView) => {
    setJob(j);
    activity.job(j);
  };
  const claim = async () => {
    const e = env(onJob);
    if (!e) return;
    setBusy(true);
    setMessage(null);
    setJob(null);
    try {
      const r = await activity.run('demo-tokens', () => claimDemoTokens(e, account.address, onJob));
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
    <Panel
      title={
        <>
          <Icon name="gift" className="title-icon" /> Free demo tokens
        </>
      }
      tone="quiet"
      as="aside"
      data-testid="demo-tokens"
    >
      {ready ? (
        <>
          <p className="demo-pack" data-testid="demo-pack">
            {packText(info.pack)}
          </p>
          <p className="xsmall muted" data-testid="demo-limits">
            One free pack per wallet: the market mints it from the test faucets into your account on Midnight and pays
            the fees. {info.remainingToday} of {info.dailyCap} left today.
          </p>
        </>
      ) : (
        <div aria-label="Checking what the market offers" role="status">
          <Skeleton line />
          <Skeleton line width="70%" />
        </div>
      )}
      {state && !state.ok && (
        <p className="small gap-top" data-testid="demo-unavailable" data-code={state.code}>
          {state.reason}
        </p>
      )}
      {spendingPaused && <p className="small gap-top">Not now: {spendingPaused}</p>}
      {message && (
        <Toast
          tone={message.kind === 'error' ? 'error' : 'success'}
          onClose={dismiss}
          timerKey={message.text}
          data-testid="demo-message"
        >
          {message.text}
        </Toast>
      )}
      {busy && job && (
        <p className="small gap-top" data-testid="demo-stage" data-stage={job.stage}>
          {stageWords(job.stage, job.action)}
          {job.state === 'queued' && job.position !== undefined ? ` · position ${job.position} in line` : ''}
        </p>
      )}
      <Button
        className="btn-block gap-top"
        data-testid="get-demo-tokens"
        disabled={busy || !state?.ok || !!spendingPaused}
        onClick={() => void claim()}
      >
        {busy ? 'Getting demo tokens…' : 'Get demo tokens'}
      </Button>
    </Panel>
  );
}
