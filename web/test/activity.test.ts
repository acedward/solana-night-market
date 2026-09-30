// AA 00047 P8.1: the action in progress behind the signing modal (src/activity/activity.ts), and the
// prompt store's "signed" outcome that moves the modal from Phantom's approval to the market's part.

import { describe, expect, it } from 'vitest';

import type { JobView } from '@nightmarket/core';

import { ActivityStore, activityStep } from '../src/activity/activity.js';
import { SignPromptStore } from '../src/wallet/sign-prompt.js';

const job = (requestId: string, stage: string, state = 'running'): JobView =>
  ({ requestId, action: 'open-swap', state, stage, stages: [{ stage, at: 1 }] }) as unknown as JobView;

describe('the activity store', () => {
  it('follows one action: begin, the approval, its jobs, the end', () => {
    const a = new ActivityStore();
    let seen = 0;
    a.subscribe(() => (seen += 1));
    const id = a.begin('open-swap', 1_000);
    expect(a.get()).toMatchObject({ kind: 'open-swap', title: 'Publishing your offer', approvals: 0, job: null });
    a.approved(2_000);
    expect(a.get()).toMatchObject({ approvals: 1, approvedAt: 2_000 });
    a.job(job('r1', 'proving'), 3_000);
    expect(a.get()).toMatchObject({ jobSince: 3_000 });
    a.job(job('r1', 'posted'), 9_000);
    expect(a.get()!.jobSince).toBe(3_000); // the same job: the bar keeps its start
    a.job(job('r2', 'proving'), 12_000);
    expect(a.get()!.jobSince).toBe(12_000); // a second job (a withdrawal's inbox note) starts again
    a.end(id + 1); // another action's end changes nothing
    expect(a.get()).not.toBeNull();
    a.end(id);
    expect(a.get()).toBeNull();
    expect(seen).toBeGreaterThanOrEqual(6);
  });

  it('hides until the action ends, and ends whatever the action does', async () => {
    const a = new ActivityStore();
    await expect(
      a.run('take', async () => {
        a.hide();
        expect(a.get()).toBeNull();
        expect(a.peek()).not.toBeNull();
        throw new Error('declined');
      }),
    ).rejects.toThrow('declined');
    expect(a.peek()).toBeNull();
    a.job(job('r3', 'proving')); // no action: ignored
    expect(a.peek()).toBeNull();
  });

  it('names the step: the market prepares it until the proof is done, then Midnight confirms', () => {
    expect(activityStep(null)).toBe(1);
    expect(activityStep(job('r', 'queued', 'queued'))).toBe(1);
    expect(activityStep(job('r', 'proving'))).toBe(1);
    for (const s of ['proven', 'posted', 'listed', 'merged', 'settled', 'submitted', 'succeeded'])
      expect(activityStep(job('r', s))).toBe(2);
  });
});

describe('the prompt store', () => {
  it('tells its listeners when the wallet signed, and not when the request ended otherwise', () => {
    const p = new SignPromptStore();
    let signed = 0;
    const off = p.onSigned(() => (signed += 1));
    p.open(new TextEncoder().encode('Night Market - stagenet\nSwap offer\n'), 'Phantom');
    p.close('ended');
    expect(signed).toBe(0);
    p.open(new TextEncoder().encode('Night Market - stagenet\nSwap offer\n'), 'Phantom');
    p.close('signed');
    expect(signed).toBe(1);
    expect(p.get()).toBeNull();
    off();
    p.close('signed');
    expect(signed).toBe(1);
  });
});
