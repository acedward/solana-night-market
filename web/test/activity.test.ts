// AA 00047 P8.1: the action in progress behind the signing modal (src/activity/activity.ts), and the
// prompt store's "signed" outcome that moves the modal from Phantom's approval to the market's part.
// P8.2 (the owner's Q18 finding; questions Q24): a make has its own steps and ends when the exchange
// lists the offer; it never shows a Midnight confirmation.

import { describe, expect, it } from 'vitest';

import type { JobView } from '@nightmarket/core';

import {
  ACTIVITY_FLOW,
  ActivityStore,
  EXPECTED_SECONDS,
  OFFER_OFF_CHAIN,
  activityStep,
  stageWords,
  type ActivityKind,
} from '../src/activity/activity.js';
import { SignPromptStore } from '../src/wallet/sign-prompt.js';

const job = (
  requestId: string,
  stage: string,
  state = 'running',
  action = 'open-swap',
  before: string[] = [],
): JobView =>
  ({
    requestId,
    action,
    state,
    stage,
    stages: [...before, stage].map((s) => ({ stage: s, at: 1 })),
  }) as unknown as JobView;

describe('the activity store', () => {
  it('follows one action: begin, the approval, its jobs, the end', () => {
    const a = new ActivityStore();
    let seen = 0;
    a.subscribe(() => (seen += 1));
    const id = a.begin('open-swap', 1_000);
    expect(a.get()).toMatchObject({ kind: 'open-swap', title: 'Creating your offer', approvals: 0, job: null });
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

  it('an on-chain action: the market prepares it until the proof is done, then Midnight confirms', () => {
    for (const kind of ['take', 'withdraw', 'withdraw-unshielded', 'append-inbox'] as const) {
      expect(activityStep(kind, null)).toBe(1);
      expect(activityStep(kind, job('r', 'queued', 'queued', kind))).toBe(1);
      expect(activityStep(kind, job('r', 'proving', 'running', kind))).toBe(1);
    }
    expect(activityStep('take', job('r', 'offer-checked', 'running', 'take'))).toBe(1);
    for (const s of ['merged', 'settled', 'succeeded'])
      expect(activityStep('take', job('r', s, 'running', 'take'))).toBe(2);
    expect(activityStep('withdraw', job('r', 'submitted', 'running', 'withdraw'))).toBe(2);
    expect(activityStep('register', job('r', 'deploying', 'running', 'register'))).toBe(1);
    expect(activityStep('register', job('r', 'wave-1-submitted', 'running', 'register'))).toBe(2);
    // Demo tokens prove once per token: the step never goes back once a token landed.
    expect(activityStep('demo-tokens', job('r', 'minting', 'running', 'demo-tokens'))).toBe(1);
    expect(
      activityStep('demo-tokens', job('r', 'minting', 'running', 'demo-tokens', ['minting', 'minted-and-deposited'])),
    ).toBe(2);
    for (const kind of [
      'register',
      'demo-tokens',
      'take',
      'withdraw',
      'withdraw-unshielded',
      'append-inbox',
    ] as const) {
      expect(ACTIVITY_FLOW[kind]).toMatchObject({
        end: 'on-chain',
        steps: ['Market prepares it', 'Confirmed on Midnight'],
      });
      expect(EXPECTED_SECONDS[kind]).toBeGreaterThan(30);
    }
  });

  it('a make: Preparing your offer until the proof is done, then listed on the market, never on-chain', () => {
    const flow = ACTIVITY_FLOW['open-swap'];
    expect(flow.end).toBe('listed');
    expect(flow.steps).toEqual(['Preparing your offer', 'Listed on the market']);
    expect(flow.note).toContain(OFFER_OFF_CHAIN);
    expect(flow.note).not.toMatch(/Midnight|confirm/i);
    expect(OFFER_OFF_CHAIN).toBe(
      'Nothing goes on-chain until someone takes your offer, and your tokens stay in your account until then.',
    );
    expect(activityStep('open-swap', null)).toBe(1);
    for (const s of ['queued', 'running', 'waiting-for-prover', 'proving'])
      expect(activityStep('open-swap', job('r', s))).toBe(1);
    // After the proof: on the way to the order book (the step is "Listed on the market", current).
    for (const s of ['proven', 'posted', 'status-unknown']) expect(activityStep('open-swap', job('r', s))).toBe(2);
    // Listed: every step done (the exchange lists it; there is no transaction to wait for).
    expect(activityStep('open-swap', job('r', 'listed', 'running', 'open-swap', ['proving', 'proven', 'posted']))).toBe(
      3,
    );
    expect(
      activityStep('open-swap', job('r', 'succeeded', 'succeeded', 'open-swap', ['proving', 'posted', 'listed'])),
    ).toBe(3);
    // Ended before the exchange listed it: the last step is not ticked.
    expect(
      activityStep(
        'open-swap',
        job('r', 'succeeded', 'succeeded', 'open-swap', ['proving', 'posted', 'status-unknown']),
      ),
    ).toBe(2);
    expect(EXPECTED_SECONDS['open-swap']).toBeUndefined();
  });

  it('words each stage for the customer, and a make as off-chain', () => {
    expect(stageWords('proving', 'take')).toBe('Creating the zero-knowledge proof');
    expect(stageWords('settled', 'take')).toBe('Settled on Midnight');
    expect(stageWords('submitted', 'withdraw')).toBe('Sent to Midnight');
    expect(stageWords('minted-and-deposited', 'demo-tokens')).toBe('Minted into your account on Midnight');
    expect(stageWords('proving', 'open-swap')).toBe("Creating your offer's zero-knowledge proof");
    expect(stageWords('posted', 'open-swap')).toBe('Waiting for the market to list it (not on-chain)');
    expect(stageWords('listed', 'open-swap')).toBe('Listed on the market');
    expect(stageWords('status-unknown', 'open-swap')).toBe('Sent to the market; not listed yet');
    expect(stageWords('something-new', 'take')).toBe('something-new');
    // No make stage speaks of Midnight or a transaction.
    for (const s of [
      'queued',
      'running',
      'waiting-for-prover',
      'proving',
      'proven',
      'posted',
      'listed',
      'status-expired',
    ])
      expect(stageWords(s, 'open-swap')).not.toMatch(/Midnight|transaction|confirm/i);
    const kinds: ActivityKind[] = [
      'register',
      'demo-tokens',
      'open-swap',
      'take',
      'withdraw',
      'withdraw-unshielded',
      'append-inbox',
    ];
    for (const k of kinds) expect(ACTIVITY_FLOW[k].steps).toHaveLength(2);
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
