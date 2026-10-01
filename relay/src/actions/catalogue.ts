// Every state-changing action the relay offers, with its lane, how it is authorised, the shape
// of its body, and its executor.
//
// `defaultCatalogue()` has every action with an executor that fails with `not-implemented`: that is
// what main.ts serves when no device arm can run (no key volume). `accountCatalogue`, `withTrade`
// and `withDemoTokens` add the executors, which are arm-agnostic given a `DeviceArm`: register and
// demo-tokens (authorised by a RelayAction envelope in the Solana scheme, which for registration is
// also the enrolment), and withdraw, withdraw-unshielded, append-inbox, open-swap and take, each
// authorised by the call's OWN Passport signature (`passport-call`, the F3 message the circuit
// verifies), so every action is one wallet prompt.

import { z } from 'zod';

import {
  AppendInboxPayloadSchema,
  DemoTokensPayloadSchema,
  OpenSwapPayloadSchema,
  RELAY_ACTIONS,
  RegisterPayloadSchema,
  TakePayloadSchema,
  WithdrawPayloadSchema,
  WithdrawUnshieldedPayloadSchema,
  type JobLane,
  type RelayActionName,
} from '@nightmarket/core';

import type { AuthKind } from '../auth/verifiers.js';
import type { AdmissionCheck } from './admission.js';
import { registrationAdmission, type RegistrationCaps } from './registration-caps.js';
import { PublicError, type JobExecutor } from '../queue/jobs.js';
import { openSwapExecutor, takeExecutor, type TradeDeps } from '../trade/executors.js';
import { expiryAdmission } from '../trade/expiry.js';

export interface ActionDefinition {
  action: RelayActionName;
  lane: JobLane;
  auth: AuthKind;
  /** Whether the request names an existing Passport account. */
  requiresAccount: boolean;
  /** Whether the action spends the sponsor's DUST (refused while the sponsor is not ready). */
  requiresSponsor: boolean;
  payload: z.ZodType<Record<string, unknown>>;
  /** An extra check before the job is queued (./admission.ts; security review F-B2, F-B3). */
  admit?: AdmissionCheck;
  /** For a `passport-call` action: whether this body ALSO needs a RelayAction envelope over the
   *  whole body, signed by the same device, because it carries arguments the call's own signature
   *  cannot cover (security review F-B6: a withdrawal's recipient encryption key). */
  envelope?: (payload: Record<string, unknown>) => boolean;
  executor: JobExecutor;
  /** The plan lane that implements the executor. */
  implementedBy: string;
}

import {
  appendInboxExecutor,
  registerExecutor,
  withdrawExecutor,
  withdrawUnshieldedExecutor,
  type AccountActionDeps,
} from './account-actions.js';

/** Until a lane defines its action's body, any JSON object (the size limit still applies). */
const anyObject = z.record(z.string(), z.unknown());

export { RegisterPayloadSchema };

const notImplemented =
  (action: RelayActionName, lane: string): JobExecutor =>
  async () => {
    throw new PublicError('not-implemented', `the ${action} operation is not available yet (plan lane ${lane})`);
  };

const def = (
  action: RelayActionName,
  lane: JobLane,
  implementedBy: string,
  extra: Partial<Pick<ActionDefinition, 'requiresAccount' | 'payload' | 'auth'>> = {},
): ActionDefinition => ({
  action,
  lane,
  auth: extra.auth ?? 'relay-action',
  requiresAccount: extra.requiresAccount ?? true,
  requiresSponsor: true,
  payload: extra.payload ?? anyObject,
  executor: notImplemented(action, implementedBy),
  implementedBy,
});

export function defaultCatalogue(): Map<RelayActionName, ActionDefinition> {
  const list: ActionDefinition[] = [
    def('register', 'prover', 'B3', { requiresAccount: false, payload: RegisterPayloadSchema }),
    def('withdraw', 'prover', 'B3'),
    def('append-inbox', 'prover', 'B3'),
    def('open-swap', 'prover', 'B3'),
    def('take', 'prover', 'B3'),
    def('withdraw-unshielded', 'prover', 'B3'),
    def('demo-tokens', 'prover', 'B3', { payload: DemoTokensPayloadSchema }),
  ];
  const map = new Map(list.map((d) => [d.action, d]));
  for (const a of RELAY_ACTIONS) if (!map.has(a)) throw new Error(`action ${a} has no definition`);
  return map;
}

/**
 * The catalogue with the account executors: register (authorised by its RelayAction envelope,
 * which is also the enrolment), and withdraw, withdraw-unshielded and append-inbox, each authorised
 * by the gated call's OWN Passport signature (`passport-call`), so every action is one wallet prompt.
 */
export function accountCatalogue(deps: AccountActionDeps): Map<RelayActionName, ActionDefinition> {
  const map = defaultCatalogue();
  const set = (action: RelayActionName, patch: Partial<ActionDefinition>) =>
    map.set(action, { ...map.get(action)!, ...patch });
  set('register', { executor: registerExecutor(deps) });
  set('withdraw', {
    auth: 'passport-call',
    payload: WithdrawPayloadSchema,
    // The recipient's encryption key is not in the contract's WithdrawShielded challenge (F-B6). A
    // second signature binds it only when the deployment asks for it (questions Q13: off by default,
    // one prompt per action).
    ...(deps.withdrawRecipientEnvelope ? { envelope: (p) => p.recipientEncryptionKey !== undefined } : {}),
    executor: withdrawExecutor(deps),
  });
  set('withdraw-unshielded', {
    auth: 'passport-call',
    payload: WithdrawUnshieldedPayloadSchema,
    executor: withdrawUnshieldedExecutor(deps),
  });
  set('append-inbox', {
    auth: 'passport-call',
    payload: AppendInboxPayloadSchema,
    // Only against a single-use entitlement the bank issued for that change (security review F-B3).
    admit: async ({ account, payload }) => deps.entitlements.admit(payload.entitlement, account),
    executor: appendInboxExecutor(deps),
  });
  return map;
}

/**
 * The catalogue with the trade executors added: making an offer (`open-swap`) and taking one
 * (`take`), each authorised by the swap call's OWN signature (one prompt), and admitted only inside
 * the call's signed expiry (AA 00047 P9, audit C6: ../trade/expiry.ts).
 */
export function withTrade(
  map: Map<RelayActionName, ActionDefinition>,
  deps: TradeDeps,
): Map<RelayActionName, ActionDefinition> {
  const set = (action: RelayActionName, patch: Partial<ActionDefinition>) =>
    map.set(action, { ...map.get(action)!, ...patch });
  set('open-swap', {
    auth: 'passport-call',
    payload: OpenSwapPayloadSchema,
    admit: expiryAdmission('open-swap', deps.expiry, deps.now),
    executor: openSwapExecutor(deps),
  });
  set('take', {
    auth: 'passport-call',
    payload: TakePayloadSchema,
    admit: expiryAdmission('take', deps.expiry, deps.now),
    executor: takeExecutor(deps),
  });
  return map;
}

/**
 * The catalogue with the demo-token claim (spec FR-007, ../demo/action.ts): a RelayAction envelope in
 * the Solana scheme, admitted only for a live device of an active market account, once per key and
 * within the daily cap.
 */
export function withDemoTokens(
  map: Map<RelayActionName, ActionDefinition>,
  demo: { admit: AdmissionCheck; executor: JobExecutor },
): Map<RelayActionName, ActionDefinition> {
  map.set('demo-tokens', {
    ...map.get('demo-tokens')!,
    payload: DemoTokensPayloadSchema,
    admit: demo.admit,
    executor: demo.executor,
  });
  return map;
}

/**
 * The catalogue with registration capped (AA 00047 P9, audit C4: ./registration-caps.ts): a global
 * and a per-client daily cap, and at most a few registrations queued or running at once.
 */
export function withRegistrationCaps(
  map: Map<RelayActionName, ActionDefinition>,
  caps: RegistrationCaps,
): Map<RelayActionName, ActionDefinition> {
  map.set('register', { ...map.get('register')!, admit: registrationAdmission(caps) });
  return map;
}
