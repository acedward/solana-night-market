// The action in progress, for the signing modal (AA 00047 P8.1, spec FR-006b "progress while a proof
// runs"; questions Q21). A signed action is: the wallet's approval (./wallet/sign-prompt.ts shows the
// exact text), then the market's job: the relay proves the call (20–60 s on stagenet, plan P6.4),
// submits it, and it lands. The pages report their jobs here (`OperationEnv.onJob`), and the modal
// shows the steps, a bar against how long that action usually takes, and the relay's own stage.
//
// It holds nothing the flows depend on: the operations, their records and their errors are
// unchanged; closing the modal ("Continue in background") only hides it.

import type { JobView } from '@nightmarket/core';

/** What the customer started (the operation, not the relay's job: a withdrawal may run two jobs). */
export type ActivityKind =
  'register' | 'demo-tokens' | 'open-swap' | 'take' | 'withdraw' | 'withdraw-unshielded' | 'append-inbox';

export const ACTIVITY_TITLE: Record<ActivityKind, string> = {
  register: 'Opening your account',
  'demo-tokens': 'Getting your demo tokens',
  'open-swap': 'Publishing your offer',
  take: 'Taking the offer',
  withdraw: 'Withdrawing',
  'withdraw-unshielded': 'Withdrawing',
  'append-inbox': 'Saving your change',
};

/** How long each relay job usually takes end to end on stagenet, in seconds (plan P6.4, measured):
 *  the bar fills against this and never claims to be done before the job is. */
export const EXPECTED_SECONDS: Record<string, number> = {
  register: 63,
  'demo-tokens': 49,
  'open-swap': 54,
  take: 44,
  withdraw: 42,
  'withdraw-unshielded': 42,
  'append-inbox': 39,
};

/** The relay's stages in the customer's words. */
export const STAGE_WORDS: Record<string, string> = {
  queued: 'Waiting in line',
  running: 'Starting',
  deploying: 'Creating your account',
  'wave-1-submitted': 'Account created (step 1 of 2)',
  'wave-2-submitted': 'Account features added (step 2 of 2)',
  deployed: 'Account created',
  activating: 'Linking your wallet to the account',
  'activation-submitted': 'Sent to Midnight',
  activated: 'Account ready',
  minting: 'Minting from the test faucets',
  depositing: 'Depositing into your account',
  proving: 'Creating the zero-knowledge proof',
  proven: 'Proof ready',
  posted: 'Sent to the exchange',
  listed: 'Listed on the exchange',
  'offer-checked': 'Checking the offer is still there',
  merged: 'Matching with the offer',
  settled: 'Settled',
  submitted: 'Sent to Midnight',
  succeeded: 'Done',
  failed: 'Failed',
};

/** The stages after which the proof is done and the transaction is on its way (step 3 of 3). */
const CONFIRMING = new Set([
  'proven',
  'posted',
  'listed',
  'merged',
  'settled',
  'submitted',
  'activation-submitted',
  'activated',
  'succeeded',
]);

/** 0 = approve in the wallet, 1 = the market prepares it (proof), 2 = confirming on Midnight. */
export const activityStep = (job: JobView | null): 1 | 2 => (job && CONFIRMING.has(job.stage) ? 2 : 1);

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
