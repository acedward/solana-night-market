// The signing modal (spec FR-003 and FR-006b; AA 00047 lane B2, redesigned in P8.1, questions Q21).
//
// 1. While the Solana wallet is asked to sign, it shows the exact text the wallet shows, with its
//    fingerprint, so the customer can compare the two before approving (`sign-prompt`).
// 2. Once the wallet has signed, it follows the market's part of the action (`activity-progress`):
//    the relay proves the call (20–60 s), submits it, and it lands. A bar fills against how long
//    that action usually takes, and the relay's own stage is named.
// It holds nothing and cancels nothing: the wallet answers (or the page's timeout ends the wait),
// the action ends, and the modal closes by itself; "Continue in background" only hides it.

import { useEffect, useState, useSyncExternalStore } from 'react';

import { EXPECTED_SECONDS, STAGE_WORDS, activityStep, type ActivityStore } from '../activity/activity.js';
import { Button, Dialog, Icon, ProgressBar, Spinner, Stepper } from '../design/index.js';
import type { SignPromptStore } from './sign-prompt.js';
import { useWallet } from './WalletContext.js';

const LEDE = {
  'account-call':
    'Phantom shows you this text. It is exactly what you approve, and what your account checks before anything happens. Approve it only if it matches what you asked for.',
  'relay-envelope':
    'Phantom asks you to prove you own this wallet, so the market can act for you. This signature moves none of your funds and costs nothing.',
} as const;

/** How long the progress view waits after a signature before it shows (a refused request ends at once). */
const SETTLE_MS = 300;

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
const usually = (s: number) => (s >= 55 ? 'about a minute' : `about ${Math.round(s / 5) * 5} seconds`);

export function SigningPrompt({
  prompts,
  activity,
  timeoutSeconds,
}: {
  prompts: SignPromptStore;
  activity: ActivityStore;
  timeoutSeconds: number;
}) {
  const prompt = useSyncExternalStore(prompts.subscribe, prompts.get, prompts.get);
  const act = useSyncExternalStore(activity.subscribe, activity.get, activity.get);
  const connected = useWallet().walletName;
  const walletName = prompt?.wallet ?? connected ?? 'your wallet';

  // A clock for the elapsed time and the bar, only while an action is on.
  const [now, setNow] = useState(() => Date.now());
  const running = act !== null;
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [running]);

  const steps = [`Approve in ${walletName}`, 'Market prepares it', 'Confirmed on Midnight'];

  if (prompt) {
    const digestLine = prompt.kind === 'account-call' ? 'Digest' : 'Nonce';
    const hide = () => {
      prompts.hide();
      activity.hide();
    };
    return (
      <Dialog
        open
        className="sign-modal"
        title={
          <>
            <Icon name="wallet" />
            <span>Approve in {prompt.wallet}</span>
          </>
        }
        onClose={hide}
        testId="sign-prompt"
        actions={
          <Button variant="secondary" onClick={hide} data-testid="sign-prompt-hide">
            Hide this panel
          </Button>
        }
      >
        {act ? <Stepper steps={steps} current={0} label={act.title} /> : null}
        <p className="small" data-testid="sign-prompt-kind" data-kind={prompt.kind}>
          {LEDE[prompt.kind]}
        </p>
        <p className="sign-label">What {prompt.wallet} shows</p>
        <pre className="sign-text mono" data-testid="sign-prompt-text">
          {prompt.text}
        </pre>
        <p className="fingerprint">
          <span>Check the fingerprint</span>
          <strong data-testid="sign-prompt-fingerprint">{prompt.fingerprint}</strong>
          <span>
            = the first digits of the <span className="mono">{digestLine}</span> line in {prompt.wallet}.
          </span>
        </p>
        <p className="waiting">
          <Spinner />
          <span>
            Waiting for your approval. Nothing is sent until you approve; if you close {prompt.wallet}&apos;s window,
            this stops waiting after {timeoutSeconds} seconds.
          </span>
        </p>
      </Dialog>
    );
  }

  if (!act) return null;
  const settled =
    act.job !== null || (act.approvals > 0 && act.approvedAt !== null && now - act.approvedAt >= SETTLE_MS);
  if (!settled) return null;

  const job = act.job;
  const step = activityStep(job);
  const since = act.jobSince ?? act.approvedAt ?? act.startedAt;
  const elapsed = Math.max(0, (now - since) / 1000);
  const expected = EXPECTED_SECONDS[job?.action ?? act.kind] ?? 60;
  const stage = job ? (STAGE_WORDS[job.stage] ?? job.stage) : 'Sending to the market';
  const queued = job?.state === 'queued' && job.position !== undefined ? ` · position ${job.position} in line` : '';
  return (
    <Dialog
      open
      className="sign-modal"
      title={
        <>
          <Icon name="spark" />
          <span>{act.title}</span>
        </>
      }
      onClose={() => activity.hide()}
      testId="activity-progress"
      actions={
        <Button variant="secondary" onClick={() => activity.hide()} data-testid="activity-hide">
          Continue in background
        </Button>
      }
    >
      <Stepper steps={steps} current={step} label={act.title} />
      <div className="progress-block">
        <p className="progress-line">
          <strong data-testid="activity-stage" data-stage={job?.stage ?? 'sending'}>
            {stage}
            {queued}
          </strong>
          <span className="progress-time" data-testid="activity-elapsed">
            {clock(elapsed)}
          </span>
        </p>
        <ProgressBar value={Math.min(0.95, elapsed / expected)} label={act.title} data-testid="activity-bar" />
        <p className="progress-note">
          Signed. The market is creating a zero-knowledge proof of your action and sending it to Midnight; this usually
          takes {usually(expected)}. You can keep browsing: the page tells you when it is done.
        </p>
      </div>
    </Dialog>
  );
}
