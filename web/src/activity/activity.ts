// The action in progress, for the signing modal (AA 00047 P8.1, spec FR-006b "progress while a proof
// runs"; questions Q21, Q24). A signed action is the wallet's approval (./wallet/sign-prompt.ts
// shows the exact text), then the market's job. The pages report their jobs here
// (`OperationEnv.onJob`), and the modal shows the steps, a bar and the relay's own stage.
//
// Two kinds of action end differently (the owner's Q18 finding, P8.2):
//   - on Midnight: opening an account, demo tokens, a take, a withdrawal, saving a change. The relay
//     proves the call (about 20 s), submits it, and the job ends once it is on-chain. Steps: Approve
//     → Market prepares it → Confirmed on Midnight, and a bar against how long the whole action
//     usually takes (plan P6.4).
//   - on the market's order book: making an offer. The relay proves the offer and the exchange (the
//     Offer Files kernel) lists it; NOTHING reaches the chain until someone takes it, and the tokens
//     stay in the account until then. Steps: Approve → Preparing your offer → Listed on the market;
//     the bar covers only the preparation (the proof), and the step ends when the exchange lists it.
//
// It holds nothing the flows depend on: the operations, their records and their errors are
// unchanged; closing the modal ("Continue in background") only hides it.

import type { JobView } from '@nightmarket/core';

/** What the customer started (the operation, not the relay's job: a withdrawal may run two jobs). */
export type ActivityKind =
  | 'register'
  | 'demo-tokens'
  | 'open-swap'
  | 'take'
  | 'withdraw'
  | 'withdraw-unshielded'
  | 'append-inbox'
  | 'restore-enc-key';

export const ACTIVITY_TITLE: Record<ActivityKind, string> = {
  register: 'Opening your account',
  'demo-tokens': 'Getting your demo tokens',
  'open-swap': 'Creating your offer',
  take: 'Taking the offer',
  withdraw: 'Withdrawing',
  'withdraw-unshielded': 'Withdrawing',
  'append-inbox': 'Saving your change',
  'restore-enc-key': 'Restoring your encryption key',
};

/** The sentence every make-offer screen carries: a made offer is off-chain until someone takes it. */
export const OFFER_OFF_CHAIN =
  'Nothing goes on-chain until someone takes your offer, and your tokens stay in your account until then.';

/** How an action ends: a Midnight transaction, or a listing on the market's order book (a make). */
export type ActivityEnd = 'on-chain' | 'listed';

export interface ActivityFlow {
  end: ActivityEnd;
  /** The two steps after the wallet's approval (step 0, "Approve in <wallet>"). */
  steps: readonly [string, string];
  /** What the progress view says under the bar. */
  note: string;
}

const ON_CHAIN_STEPS = ['Market prepares it', 'Confirmed on Midnight'] as const;
const KEEP_BROWSING = 'You can keep browsing: the page tells you when it is done.';

export const ACTIVITY_FLOW: Record<ActivityKind, ActivityFlow> = {
  register: {
    end: 'on-chain',
    steps: ON_CHAIN_STEPS,
    note: `Signed. The market creates your account on Midnight (three transactions) and pays their fees; this usually takes about a minute. ${KEEP_BROWSING}`,
  },
  'demo-tokens': {
    end: 'on-chain',
    steps: ON_CHAIN_STEPS,
    note: `Signed. The market mints your demo tokens from the test faucets into your account on Midnight and pays the fees; this usually takes about 50 seconds. ${KEEP_BROWSING}`,
  },
  'open-swap': {
    end: 'listed',
    steps: ['Preparing your offer', 'Listed on the market'],
    note: `Signed. The market creates your offer's zero-knowledge proof (usually 20 to 30 seconds), then the exchange lists it in the order book. ${OFFER_OFF_CHAIN} ${KEEP_BROWSING}`,
  },
  take: {
    end: 'on-chain',
    steps: ON_CHAIN_STEPS,
    note: `Signed. The market creates the zero-knowledge proof of your side, then settles it with the offer in one transaction on Midnight; this usually takes about 45 seconds. ${KEEP_BROWSING}`,
  },
  withdraw: {
    end: 'on-chain',
    steps: ON_CHAIN_STEPS,
    note: `Signed. The market creates the zero-knowledge proof of your withdrawal and sends it to Midnight; this usually takes about 40 seconds. ${KEEP_BROWSING}`,
  },
  'withdraw-unshielded': {
    end: 'on-chain',
    steps: ON_CHAIN_STEPS,
    note: `Signed. The market creates the zero-knowledge proof of your withdrawal and sends it to Midnight; this usually takes about 40 seconds. ${KEEP_BROWSING}`,
  },
  'append-inbox': {
    end: 'on-chain',
    steps: ON_CHAIN_STEPS,
    note: `Signed. The market records the coin in your account's inbox on Midnight; this usually takes about 40 seconds. ${KEEP_BROWSING}`,
  },
  // AA 00047 P10 (audit round 2, R2-3): the same circuit, back to this browser's key.
  'restore-enc-key': {
    end: 'on-chain',
    steps: ON_CHAIN_STEPS,
    note: `Signed. The market sends one transaction to Midnight that puts this browser's encryption key back on your account; this usually takes about 40 seconds. ${KEEP_BROWSING}`,
  },
};

/** How long each relay job usually takes end to end on stagenet, in seconds (plan P6.4, measured):
 *  the bar of an on-chain action fills against this and never claims to be done before the job is. */
export const EXPECTED_SECONDS: Record<string, number> = {
  register: 63,
  'demo-tokens': 49,
  take: 44,
  withdraw: 42,
  'withdraw-unshielded': 42,
  'append-inbox': 39,
  'restore-enc-key': 39,
};

/** A make's preparation (the relay's checks and the offer's proof, 21.9 s on stagenet, plan P6.4):
 *  the bar of "Preparing your offer". The listing that follows has no bar length: it is not a
 *  transaction, and it ends when the exchange lists the offer. */
export const OFFER_PREPARE_SECONDS = 30;

/** The relay's stages in the customer's words. */
export const STAGE_WORDS: Record<string, string> = {
  queued: 'Waiting in line',
  running: 'Starting',
  'waiting-for-prover': 'Waiting for the prover',
  deploying: 'Creating your account',
  'wave-1-submitted': 'Account created (step 1 of 2)',
  'wave-2-submitted': 'Account features added (step 2 of 2)',
  deployed: 'Account created',
  activating: 'Linking your wallet to the account',
  'activation-submitted': 'Sent to Midnight',
  activated: 'Account ready',
  minting: 'Minting from the test faucets',
  minted: 'Minted on Midnight',
  depositing: 'Depositing into your account',
  deposited: 'Deposited into your account on Midnight',
  'minted-and-deposited': 'Minted into your account on Midnight',
  proving: 'Creating the zero-knowledge proof',
  proven: 'Proof ready',
  posted: 'Sent to the market',
  listed: 'Listed on the market',
  'offer-checked': 'Checking the offer is still there',
  merged: 'Matching with the offer',
  settled: 'Settled on Midnight',
  submitted: 'Sent to Midnight',
  succeeded: 'Done',
  failed: 'Failed',
};

/** A make's stages: it is an offer on the order book, not a transaction. */
const OFFER_STAGE_WORDS: Record<string, string> = {
  proving: "Creating your offer's zero-knowledge proof",
  proven: 'Offer ready, sending it to the market',
  posted: 'Waiting for the market to list it (not on-chain)',
  listed: 'Listed on the market',
};

/** A stage in the customer's words, for this action (a make's words say it is off-chain). */
export function stageWords(stage: string, action?: string): string {
  if (action === 'open-swap') {
    const w = OFFER_STAGE_WORDS[stage];
    if (w) return w;
    if (stage.startsWith('status-')) return 'Sent to the market; not listed yet';
  }
  return STAGE_WORDS[stage] ?? stage;
}

/** The stages of an on-chain action after which the proof is done and the transaction is on its way
 *  or landed (the "Confirmed on Midnight" step). */
const ON_CHAIN_AFTER_PROOF = new Set([
  'wave-1-submitted',
  'wave-2-submitted',
  'deployed',
  'activating',
  'activation-submitted',
  'activated',
  'minted',
  'deposited',
  'minted-and-deposited',
  'merged',
  'settled',
  'submitted',
  'succeeded',
]);

/** A make's stages once its proof is done: on the way to the order book (or ended without the
 *  exchange listing it yet, `status-…`). Only `listed` completes the last step. */
const OFFER_LISTING = (stage: string) =>
  stage === 'proven' || stage === 'posted' || stage === 'succeeded' || stage.startsWith('status-');

/**
 * Where the action is, on the modal's steps: 0 = approve in the wallet, 1 = the market prepares it
 * (a make: "Preparing your offer"), 2 = confirming on Midnight (a make: being listed), 3 = all done
 * (a make the exchange lists). Monotonic over the job's stages, so an action that proves several
 * times (demo tokens, one mint per token) never steps back.
 */
export function activityStep(kind: ActivityKind, job: JobView | null): 1 | 2 | 3 {
  if (!job) return 1;
  const stages = [...job.stages.map((s) => s.stage), job.stage];
  if (ACTIVITY_FLOW[kind].end === 'listed') {
    if (stages.includes('listed')) return 3;
    return stages.some(OFFER_LISTING) ? 2 : 1;
  }
  return stages.some((s) => ON_CHAIN_AFTER_PROOF.has(s)) ? 2 : 1;
}

export interface Activity {
  id: number;
  kind: ActivityKind;
  title: string;
  startedAt: number;
  /** The relay's job, once one exists (the latest one, for an action that runs two). */
  job: JobView | null;
  /** When the current job was first seen (the bar's start). */
  jobSince: number | null;
  /** Wallet approvals given so far in this action, and when the last one came. */
  approvals: number;
  approvedAt: number | null;
}

export class ActivityStore {
  private current: Activity | null = null;
  private hidden = false;
  private seq = 0;
  private readonly listeners = new Set<() => void>();

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** The action to show, or null (none, or the customer sent it to the background). */
  readonly get = (): Activity | null => (this.hidden ? null : this.current);

  /** The action, hidden or not (the page's own trackers). */
  readonly peek = (): Activity | null => this.current;

  begin(kind: ActivityKind, now = Date.now()): number {
    this.seq += 1;
    this.current = {
      id: this.seq,
      kind,
      title: ACTIVITY_TITLE[kind],
      startedAt: now,
      job: null,
      jobSince: null,
      approvals: 0,
      approvedAt: null,
    };
    this.hidden = false;
    this.emit();
    return this.seq;
  }

  /** A job update from the relay (the page's `onJob`). */
  job(job: JobView, now = Date.now()): void {
    const a = this.current;
    if (!a) return;
    const fresh = a.job?.requestId !== job.requestId;
    this.current = { ...a, job, jobSince: fresh ? now : a.jobSince };
    this.emit();
  }

  /** The wallet signed a prompt of this action (the modal moves on to the market's part). */
  approved(now = Date.now()): void {
    const a = this.current;
    if (!a) return;
    this.current = { ...a, approvals: a.approvals + 1, approvedAt: now, job: null, jobSince: null };
    this.emit();
  }

  /** The action finished (done or failed): the modal closes; the page says how it went. */
  end(id: number): void {
    if (this.current?.id !== id) return;
    this.current = null;
    this.hidden = false;
    this.emit();
  }

  /** "Continue in background": hidden until the action ends or the wallet asks again. */
  hide(): void {
    this.hidden = true;
    this.emit();
  }

  show(): void {
    this.hidden = false;
    this.emit();
  }

  /** Run `fn` as one activity: begin, then end whatever happens. */
  async run<T>(kind: ActivityKind, fn: () => Promise<T>): Promise<T> {
    const id = this.begin(kind);
    try {
      return await fn();
    } finally {
      this.end(id);
    }
  }

  private emit() {
    for (const l of this.listeners) l();
  }
}
