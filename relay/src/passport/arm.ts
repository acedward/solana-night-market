// The device arm that controls Night Market accounts: THE SEAM where Track A's Ed25519 arm
// (acedward/passport branch `00047-solana-ed25519-arm`, plan A2/A4) plugs into the relay (lane B3).
//
// MN Bank's accounts were controlled by the Passport account's `evm` arm (EIP-712 over secp256k1);
// that arm is gone from this repository (AA 00047, questions Q8). The relay's account and trade
// executors are otherwise arm-agnostic: they deploy, prove, publish, merge and settle the same way
// for any arm. What depends on the arm is exactly what `DeviceArm` names:
//   - the arm's circuit ids (`ARM_CIRCUITS`);
//   - how a gated call's own signature is checked against the account's CURRENT public state (the
//     message the Solana wallet signed is rebuilt from the call's arguments, never trusted from the
//     request), yielding the circuit's trailing authorisation arguments;
//   - the device a registration enrols.
//
// Until lane B3 implements `DeviceArm` (and P6.1 points vendor/passport at the arm's branch), main.ts
// wires no arm: the account and trade actions answer "not supported yet", and nothing is proven.

import {
  AppendInboxPayloadSchema,
  OpenSwapPayloadSchema,
  PassportAuthSchema,
  TakePayloadSchema,
  WithdrawPayloadSchema,
  type AppendInboxPayload,
  type OpenSwapPayload,
  type PassportAuth,
  type RelayActionName,
  type RelayActionScheme,
  type TakePayload,
  type WithdrawPayload,
} from '@nightmarket/core';

import type { AccountLedger, PassportRuntime } from './runtime.js';

/** The arm every Night Market account carries. */
export const DEVICE_ARM = 'ed25519';

/** The arm's circuits the relay proves, by plan A2's names (lane B3 aligns them with the arm as
 *  Track A builds it). */
export const ARM_CIRCUITS = {
  /** Registration: the first device's activation. */
  activate: 'activate_initial_device_with_ed25519',
  /** A shielded withdrawal to a wallet. */
  withdrawShielded: 'withdraw_shielded_with_ed25519',
  /** Re-filing a change coin's inbox entry (Q13). */
  appendInbox: 'append_inbox_with_ed25519',
  /** Making and taking offers. */
  openSwap: 'open_swap_shielded_with_ed25519',
} as const;

// ── The gated account calls (withdraw, append-inbox) ──────────────────────────

export type GatedAction = Extract<RelayActionName, 'withdraw' | 'append-inbox'>;

/** Every action a gated call's own Passport signature authorises. */
export const GATED_ACTIONS: readonly GatedAction[] = ['withdraw', 'append-inbox'];

export const isGatedAction = (a: string): a is GatedAction => (GATED_ACTIONS as readonly string[]).includes(a);

export type GatedPayload<A extends GatedAction> = A extends 'withdraw' ? WithdrawPayload : AppendInboxPayload;

const GATED_SCHEMAS = { withdraw: WithdrawPayloadSchema, 'append-inbox': AppendInboxPayloadSchema } as const;

/** Parse a gated action's body; null when it is not the action's shape. */
export function parseGatedPayload<A extends GatedAction>(action: A, payload: unknown): GatedPayload<A> | null {
  const r = GATED_SCHEMAS[action].safeParse(payload);
  return r.success ? (r.data as GatedPayload<A>) : null;
}

// ── The trade calls (open-swap, take) ──────────────────────────────────────────

export type TradeAction = 'open-swap' | 'take';

export const isTradeAction = (a: string): a is TradeAction => a === 'open-swap' || a === 'take';

export type TradePayload<A extends TradeAction> = A extends 'take' ? TakePayload : OpenSwapPayload;

export function parseTradePayload<A extends TradeAction>(action: A, payload: unknown): TradePayload<A> | null {
  const r = (action === 'take' ? TakePayloadSchema : OpenSwapPayloadSchema).safeParse(payload);
  return r.success ? (r.data as TradePayload<A>) : null;
}

// ── The check's outcome ────────────────────────────────────────────────────────

export interface CallCheckOk<P> {
  ok: true;
  /** The account (64 lowercase hex). */
  account: string;
  /** The device key that signed (64 lowercase hex). */
  signer: string;
  payload: P;
  passport: PassportAuth;
  /** The circuit's trailing authorisation arguments, as the Passport client takes them (its
   *  `*WithAuth` methods and `signer.authArgs`). Opaque here: the arm builds it. */
  auth: unknown;
  /** What the replay guard remembers (the signed message's digest, hex). */
  digestHex: string;
  ledger: AccountLedger;
}

export type GatedCheckOk<A extends GatedAction = GatedAction> = CallCheckOk<GatedPayload<A>>;
export type TradeCheckOk<A extends TradeAction = TradeAction> = CallCheckOk<TradePayload<A>>;

export interface GatedCheckFail {
  ok: false;
  code: 'malformed' | 'wrong-account' | 'wrong-signer' | 'expired' | 'bad-signature' | 'not-supported';
  reason: string;
}

/**
 * The shared first half of every arm's check: the account, the body, the authorisation's shape,
 * and the account's state (booted, at the auth nonce the call binds). The arm then rebuilds the
 * signed message, verifies the signature and the device's live entry (`check`).
 */
export async function preflightCall<P extends { authNonce: string }>(
  runtime: PassportRuntime,
  accountRaw: string | undefined,
  payload: P | null,
  passportRaw: unknown,
): Promise<{ ok: true; account: string; payload: P; passport: PassportAuth; ledger: AccountLedger } | GatedCheckFail> {
  const account = (accountRaw ?? '').replace(/^0x/, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(account)) return { ok: false, code: 'malformed', reason: 'this action needs an account' };
  if (!payload) return { ok: false, code: 'malformed', reason: 'the action arguments are not valid' };
  const pa = PassportAuthSchema.safeParse(passportRaw);
  if (!pa.success)
    return { ok: false, code: 'malformed', reason: 'the Passport authorisation is missing or malformed' };
  const ledger = await runtime.ledgerState(account);
  if (!ledger || !ledger.booted)
    return { ok: false, code: 'wrong-account', reason: 'no active account at this address' };
  if (ledger.auth_nonce !== BigInt(payload.authNonce)) {
    return { ok: false, code: 'expired', reason: 'the authorisation is for an older account state; sign again' };
  }
  return { ok: true, account, payload, passport: pa.data, ledger };
}

/**
 * What an arm gives the relay (lane B3 implements it for Ed25519 on Track A's client).
 */
export interface DeviceArm {
  readonly name: typeof DEVICE_ARM;
  readonly circuits: typeof ARM_CIRCUITS;
  /** Check a gated account call (`withdraw`, `append-inbox`) against the account's current state:
   *  rebuild the message the device signed from the arguments, verify the signature, and check the
   *  device's rolling entry at the signed use counter is live. */
  checkGatedCall<A extends GatedAction>(
    runtime: PassportRuntime,
    action: A,
    account: string | undefined,
    payload: unknown,
    passportAuth: unknown,
  ): Promise<GatedCheckOk<A> | GatedCheckFail>;
  /** The same for a trade call (`open-swap`, `take`): one swap-circuit call, signed once. */
  checkTradeCall<A extends TradeAction>(
    runtime: PassportRuntime,
    action: A,
    account: string | undefined,
    payload: unknown,
    passportAuth: unknown,
  ): Promise<TradeCheckOk<A> | GatedCheckFail>;
  /** The circuit's trailing authorisation arguments a checked call's `auth` expands to (for the
   *  calls the relay builds by hand: the swap circuit, and a withdrawal to a third party). */
  authArgs(auth: unknown): unknown[];
  /** The device a registration enrols, as the Passport client's device object (the one
   *  `CustodyAccount.deployDormant` and `activate` take), from the verified registration: its
   *  device key and body. */
  registrationDevice(
    runtime: PassportRuntime,
    registration: { deviceKey: string; body: Record<string, unknown> },
  ): Promise<{ device: unknown; entryAt(account: Uint8Array, epoch: bigint, counter: bigint): Uint8Array }>;
}

/**
 * The arm (and the relay envelope's signature scheme) this build wires into the relay: NONE yet.
 * Lane B3 returns Track A's Ed25519 arm and the Solana wallet's envelope scheme here; until then
 * main.ts serves the default catalogue, whose account and trade actions answer "not supported".
 */
export function wiredArm(): { arm: DeviceArm; scheme: RelayActionScheme } | null {
  return null;
}
