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
// B1.5 typed the seam with Track A's client (vendor/passport @ 451f761): a check's `auth` is Track A's
// `Ed25519Authorisation` and a registration's device its `Ed25519Device`. `./ed25519-arm.ts` is the
// arm (lane B3): it rebuilds each call's F3 message from the call's arguments and the account's
// state and verifies the wallet's signature over it, the same signature the circuit verifies, so
// every account action is ONE wallet prompt. `wiredArm` hands main.ts the arm and the Solana
// envelope scheme (packages/core/src/solana-auth.ts) for the two actions without an account call
// (opening an account, demo tokens).
//
// Only TYPES come from the client here: its modules load the compiled account (the key volume's, in a
// deployment), so the relay imports them at run time only (./runtime.ts, ./ed25519-arm.ts).

import {
  AppendInboxPayloadSchema,
  CancelOffersPayloadSchema,
  OpenSwapPayloadSchema,
  PassportAuthSchema,
  TakePayloadSchema,
  WithdrawPayloadSchema,
  WithdrawUnshieldedPayloadSchema,
  type AppendInboxPayload,
  type CancelOffersPayload,
  type NetworkName,
  type OpenSwapPayload,
  type PassportAuth,
  type RelayActionName,
  type RelayActionScheme,
  type TakePayload,
  type TokenRegistry,
  type WithdrawPayload,
  type WithdrawUnshieldedPayload,
} from '@nightmarket/core';

import type { Ed25519Authorisation, Ed25519Device } from '../../../vendor/passport/contract/src/wallet/ed25519.js';
import type { AccountLedger, PassportRuntime } from './runtime.js';

/** The arm every Night Market account carries. */
export const DEVICE_ARM = 'ed25519';

/** The arm's circuits the relay proves: Track A's `_with_ed25519` circuits (relay/test/account-shape
 *  checks each against the compiled contract and against Track A's own account shape). */
export const ARM_CIRCUITS = {
  /** Registration: the first device's activation. */
  activate: 'activate_initial_device_with_ed25519',
  /** A shielded withdrawal to a wallet. */
  withdrawShielded: 'withdraw_shielded_with_ed25519',
  /** An unshielded withdrawal to a user address (lane B3). */
  withdrawUnshielded: 'withdraw_unshielded_with_ed25519',
  /** Re-filing a change coin's inbox entry (Q13). */
  appendInbox: 'append_inbox_with_ed25519',
  /** Making and taking offers. */
  openSwap: 'open_swap_shielded_with_ed25519',
} as const;

// ── The gated account calls (withdraw, withdraw-unshielded, append-inbox) ─────

export type GatedAction = Extract<
  RelayActionName,
  'withdraw' | 'withdraw-unshielded' | 'append-inbox' | 'cancel-offers'
>;

/** Every action a gated call's own Passport signature authorises. `cancel-offers` (AA 00047 P9.S,
 *  questions Q30) is the arm's `rotate_enc_key` to the account's current key. */
export const GATED_ACTIONS: readonly GatedAction[] = [
  'withdraw',
  'withdraw-unshielded',
  'append-inbox',
  'cancel-offers',
];

export const isGatedAction = (a: string): a is GatedAction => (GATED_ACTIONS as readonly string[]).includes(a);

export type GatedPayload<A extends GatedAction> = A extends 'withdraw'
  ? WithdrawPayload
  : A extends 'withdraw-unshielded'
    ? WithdrawUnshieldedPayload
    : A extends 'cancel-offers'
      ? CancelOffersPayload
      : AppendInboxPayload;

const GATED_SCHEMAS = {
  withdraw: WithdrawPayloadSchema,
  'withdraw-unshielded': WithdrawUnshieldedPayloadSchema,
  'append-inbox': AppendInboxPayloadSchema,
  'cancel-offers': CancelOffersPayloadSchema,
} as const;

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
  /** The rebuilt authorisation, as the Passport client takes it (its `*WithAuth` methods and
   *  `signer.authArgs`): Track A's `Ed25519Authorisation`, which the arm's check builds with the
   *  browser's signature (every check of `Ed25519Device.sign` re-run on the relay). */
  auth: Ed25519Authorisation;
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

/** Why a call's account is refused before any signature work: it is not a Night Market account
 *  deployed with the relay's pinned key set, or its maintenance authority was not retired (spec
 *  FR-005; ./account-keys.ts). */
export type AccountKeysCheck = (account: string) => Promise<{ ok: true } | { ok: false; reason: string }>;

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
  /** Check a gated account call (`withdraw`, `withdraw-unshielded`, `append-inbox`) against the account's current state:
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
   *  calls the relay builds by hand: the swap circuit, and a withdrawal to a third party): Track A's
   *  `ed25519AuthArgs`, `(pk, use_counter, sig, show)`. */
  authArgs(auth: Ed25519Authorisation): unknown[];
  /** The device a registration enrols, as the Passport client's device object (the one
   *  `CustodyAccount.deployDormant` and `activate` take), from the verified registration: its
   *  device key and body. */
  registrationDevice(
    runtime: PassportRuntime,
    registration: { deviceKey: string; body: Record<string, unknown> },
  ): Promise<{ device: Ed25519Device; entryAt(account: Uint8Array, epoch: bigint, counter: bigint): Uint8Array }>;
}

/**
 * The arm and the relay envelope's signature scheme this build wires into the relay (lane B3):
 * Track A's Ed25519 arm (./ed25519-arm.ts), rendering with the relay's network label and token
 * registry, and the Solana envelope scheme (packages/core/src/solana-auth.ts, questions Q14).
 * `accountKeys` is the FR-005 check every call's account passes first (./account-keys.ts).
 */
export async function wiredArm(options: {
  network: NetworkName;
  tokens: TokenRegistry;
  accountKeys?: AccountKeysCheck;
}): Promise<{ arm: DeviceArm; scheme: RelayActionScheme }> {
  // Both at run time: the arm loads the compiled account, the scheme the pinned client's message
  // module; neither is in the key-volume image, which imports this file for the circuit names.
  const { ed25519Arm } = await import('./ed25519-arm.js');
  const { solanaRelayActionScheme } = await import('@nightmarket/core/solana-auth');
  return { arm: ed25519Arm(options), scheme: solanaRelayActionScheme };
}
