// The signing modal (spec FR-003 and FR-006b; AA 00047 lane B2, redesigned in P8.1, questions Q21).
//
// 1. While the Solana wallet is asked to sign, it shows the exact text the wallet shows, with its
//    fingerprint, so the customer can compare the two before approving (`sign-prompt`).
// 2. Once the wallet has signed, it follows the market's part of the action (`activity-progress`),
//    with the steps of that kind of action (../activity/activity.ts, questions Q24):
//    - an on-chain action (open an account, demo tokens, a take, a withdrawal): the relay proves the
//      call (about 20 s), submits it, and it lands; a bar fills against how long that action
//      usually takes (Approve → Market prepares it → Confirmed on Midnight);
//    - making an offer: the relay proves it and the exchange lists it; nothing reaches the chain
//      (Approve → Preparing your offer → Listed on the market). The bar covers the preparation
//      only; the listing has no duration bar, and the modal says the tokens stay in the account.
// It holds nothing and cancels nothing: the wallet answers (or the page's timeout ends the wait),
// the action ends, and the modal closes by itself; "Continue in background" only hides it.

import { useEffect, useState, useSyncExternalStore } from 'react';

import {
  ACTIVITY_FLOW,
  EXPECTED_SECONDS,
  OFFER_OFF_CHAIN,
  OFFER_PREPARE_SECONDS,
  activityStep,
  stageWords,
  type ActivityStore,
} from '../activity/activity.js';
import { Button, Dialog, Icon, ProgressBar, Spinner, Stepper } from '../design/index.js';
import { PROVER_MEMORY_GB } from '../prover/constants.js';
import { progressWords } from '../prover/client-prover.js';
import type { SignFacts } from './sign-facts.js';
import type { SignPromptKind, SignPromptStore, TransactionFacts } from './sign-prompt.js';
import { useWallet } from './WalletContext.js';

/** What the panel says first, per kind of request, with the connected wallet's name (AA 00060 P5.2). */
const lede = (kind: SignPromptKind, wallet: string): string =>
  ({
    'account-call': `${wallet} shows you this text. It is exactly what you approve, and what your account checks before anything happens. Approve it only if it matches what you asked for.`,
    'relay-envelope': `${wallet} asks you to prove you own this wallet, so the market can act for you. This signature moves none of your funds and costs nothing.`,
    'rpc-registration': `${wallet} shows you this text. Signing it lets the RPC it names show your Night Market balances in your wallet. It authorises nothing on chain and moves no funds.`,
    'landing-key': `${wallet} shows you this text, and asks you twice: sign the same text both times. It creates the private key your Bridge out lands on, and that key is permanent for this site, network and wallet: the same text gives the same key every time. Sign it only on this site; anyone who gets this signature can take the tokens of every Bridge out from this wallet on this site while they are in transit, now and in the future.`,
    'solana-transaction': `${wallet} asks you to approve one Solana transaction that this page built. It is the transaction below: check it matches what ${wallet} shows. It costs a small SOL fee.`,
  })[kind];

/** A Solana transaction's facts, as the page built it (AA 00060 P5.3). */
function TransactionFactsList({ facts }: { facts: TransactionFacts }) {
  return (
    <div className="sign-facts" data-testid="sign-tx-facts">
      <p className="sign-label">
        What this transaction does: <span data-testid="sign-tx-title">{facts.title}</span>
      </p>
      <dl className="sign-facts-list">
        {facts.facts.map((f, i) => (
          <div key={`${f.label}-${i}`} data-testid="sign-tx-fact" data-label={f.label}>
            <dt>{f.label}</dt>
            <dd className={f.mono ? 'mono break' : undefined}>{f.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** How long the progress view waits after a signature before it shows (a refused request ends at once). */
const SETTLE_MS = 300;

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

/**
 * What the contract enforces for this call (AA 00047 P9.S, questions Q25 B′): each amount as its exact
 * base units and full token id, with this site's reading marked as the site's label; recipients and
 * the deadline in full. The wallet's text binds the same facts.
 */
function SignFactsList({ facts }: { facts: SignFacts }) {
  return (
    <div className="sign-facts" data-testid="sign-facts">
      <p className="sign-label">
        What your account enforces: <span data-testid="sign-facts-title">{facts.title}</span>
      </p>
      <dl className="sign-facts-list">
        {facts.facts.map((f, i) => (
          <div key={`${f.label}-${i}`} data-testid="sign-fact" data-label={f.label} data-kind={f.kind}>
            <dt>{f.label}</dt>
            {f.kind === 'amount' ? (
              <dd>
                <span className="fact-line">
                  Base units{' '}
                  <span className="num" data-testid="sign-fact-base-units">
                    {f.baseUnits}
                  </span>
                </span>
                <span className="fact-line">
                  Token{' '}
                  <span className="mono break" data-testid="sign-fact-token-id">
                    {f.tokenId}
                  </span>
                </span>
                <span className="fact-line" data-testid="sign-fact-site-label">
                  This site labels it: {f.siteLabel}
                </span>
                <span className="fact-line xsmall muted">
                  {f.listed
                    ? "The name and decimals are this site's label; the contract checks the base units and the token."
                    : 'This site does not list this token: check its id.'}
                </span>
              </dd>
            ) : (
              <dd className={f.mono ? 'mono break' : undefined} data-testid="sign-fact-value">
                {f.value}
              </dd>
            )}
          </div>
        ))}
      </dl>
    </div>
  );
}

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

  // AA 00060 P5 (G-NIGHTLY run 1): a wallet can drop a request without showing a window. After a while
  // the panel says so, and what to do; the request still ends at the page's timeout.
  const hintMs = Math.min(10, Math.max(2, timeoutSeconds / 2)) * 1000;
  const [stale, setStale] = useState<number | null>(null);
  useEffect(() => {
    if (!prompt) return;
    const since = prompt.since;
    const t = setTimeout(() => setStale(since), Math.max(0, since + hintMs - Date.now()));
    return () => clearTimeout(t);
  }, [prompt, hintMs]);
  const noWindow = prompt !== null && stale === prompt.since;

  const flow = act ? ACTIVITY_FLOW[act.kind] : null;
  const steps = flow ? [`Approve in ${walletName}`, ...flow.steps] : [];

  if (prompt) {
    const digestLine = prompt.kind === 'account-call' ? 'Digest' : 'Nonce';
    const hide = () => {
      prompts.hide();
      activity.hide();
    };
    return (
      <Dialog
        open
        focusTitle
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
          {lede(prompt.kind, prompt.wallet)}
        </p>
        {flow?.end === 'listed' && (
          <p className="small off-chain-note" data-testid="sign-prompt-off-chain">
            Approving lists your offer on the market. {OFFER_OFF_CHAIN}
          </p>
        )}
        {prompt.facts && <SignFactsList facts={prompt.facts} />}
        {prompt.transaction ? (
          <TransactionFactsList facts={prompt.transaction} />
        ) : (
          <>
            <p className="sign-label">What {prompt.wallet} shows</p>
            {/* Focusable: the F3 v2 text (base units, full token ids) is long enough to scroll on a phone,
                and a keyboard user must be able to scroll it too (axe scrollable-region-focusable). */}
            <pre className="sign-text mono" data-testid="sign-prompt-text" tabIndex={0}>
              {prompt.text}
            </pre>
          </>
        )}
        {(prompt.kind === 'account-call' || prompt.kind === 'relay-envelope') && (
          <p className="fingerprint">
            <span>Check the fingerprint</span>
            <strong data-testid="sign-prompt-fingerprint">{prompt.fingerprint}</strong>
            <span>
              = the first digits of the <span className="mono">{digestLine}</span> line in {prompt.wallet}.
            </span>
          </p>
        )}
        <p className="waiting">
          <Spinner />
          <span>
            Waiting for your approval. Nothing is sent until you approve; if you close {prompt.wallet}&apos;s window,
            this stops waiting after {timeoutSeconds} seconds.
          </span>
        </p>
        {noWindow && (
          <p className="small" role="status" data-testid="sign-prompt-no-window">
            No window from {prompt.wallet}? Open {prompt.wallet} from your browser&apos;s toolbar: the request may be
            waiting there. If it is not, this request ends after {timeoutSeconds} seconds; then try again. Nothing is
            sent until you approve.
          </p>
        )}
      </Dialog>
    );
  }

  if (!act) return null;
  const settled =
    act.job !== null || (act.approvals > 0 && act.approvedAt !== null && now - act.approvedAt >= SETTLE_MS);
  if (!settled) return null;

  const job = act.job;
  const listing = flow!.end === 'listed';
  const step = activityStep(act.kind, job);
  const since = act.jobSince ?? act.approvedAt ?? act.startedAt;
  const elapsed = Math.max(0, (now - since) / 1000);
  // An on-chain action: the whole action's usual duration. A make: the preparation only, then no
  // length at all while the exchange lists it (it is not a transaction; questions Q24).
  const bar: number | undefined = listing
    ? step === 1
      ? Math.min(0.95, elapsed / OFFER_PREPARE_SECONDS)
      : undefined
    : Math.min(0.95, elapsed / (EXPECTED_SECONDS[job?.action ?? act.kind] ?? 60));
  // AA 00062 P4.3: while the customer's own prover works, the line says so, with ITS elapsed time.
  const cp = act.clientProof;
  const stage = cp ? progressWords(cp) : job ? stageWords(job.stage, job.action) : 'Sending to the market';
  const shownElapsed = cp ? Math.max(0, (now - cp.startedAt) / 1000) : elapsed;
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
      <div className="progress-block" data-end={flow!.end}>
        <p className="progress-line">
          <strong
            data-testid="activity-stage"
            data-stage={cp ? `client-proof-${cp.state}` : (job?.stage ?? 'sending')}
            aria-live="polite"
          >
            {stage}
            {queued}
          </strong>
          <span className="progress-time" data-testid="activity-elapsed">
            {clock(shownElapsed)}
          </span>
        </p>
        <ProgressBar
          {...(bar !== undefined ? { value: bar } : {})}
          label={listing && step > 1 ? 'Listing your offer' : act.title}
          data-testid="activity-bar"
        />
        {cp ? (
          // AA 00062: the proof is the customer's prover's, not the market's (the flow's note says the latter).
          <p className="progress-note" data-testid="activity-client-proof" data-state={cp.state}>
            Signed. Your proof server at <span className="mono break">{cp.url}</span> is creating this action&apos;s
            zero-knowledge proof; it needs about {PROVER_MEMORY_GB} GB of memory. Keep this page open until it is done:
            the market then finishes the action and pays its fees.
          </p>
        ) : (
          <p className="progress-note" data-testid="activity-note">
            {flow!.note}
          </p>
        )}
      </div>
    </Dialog>
  );
}
