// The relay's action authorisation: a RelayAction envelope that the customer's device signs to ask
// the market's relay to spend its sponsor's DUST on an action.
//
// A `RelayAction` binds, in one signature:
//   - the ACTION (for example "register") and the request body (`payloadHash`, SHA-256 of the
//     canonical JSON of the payload), so a signature cannot be reused with other arguments;
//   - the Midnight NETWORK and, for account actions, the Passport ACCOUNT;
//   - the OWNER, the device key (./signing.ts) whose signature it must carry;
//   - a relay-issued NONCE, single use: the relay remembers every nonce it issued, forgets a
//     nonce the moment it is used, and forgets all of them on restart, so a signature can be
//     accepted at most once, ever;
//   - an EXPIRY (unix seconds); the relay also caps how far ahead it may be.
//
// THE SIGNATURE SCHEME IS A SEAM (plan lane B3). `RelayActionScheme` turns an envelope into the exact
// bytes the wallet signs and checks a signature over them. The Solana scheme (Ed25519 over a
// domain-separated message that can never parse as a Solana transaction or a sign-in message, shown
// in the wallet next to the decoded action) plugs in there, alongside Track A's message builder for
// the account's own calls. Until a scheme is given, every envelope is refused as `not-supported`.

import { sha256 } from '@noble/hashes/sha2.js';
import { z } from 'zod';

import { bytesToHex } from './hex.js';
import { DEVICE_KEY_PATTERN } from './signing.js';

/** Every action the relay knows. The executors are wired per network; the names are the contract. */
export const RELAY_ACTIONS = ['register', 'withdraw', 'append-inbox', 'open-swap', 'take'] as const;
export type RelayActionName = (typeof RELAY_ACTIONS)[number];

/** The message as it travels in JSON: every value a string. */
export const RelayActionMessageSchema = z.object({
  action: z.enum(RELAY_ACTIONS),
  network: z.string().min(1).max(32),
  /** The device key (64 lowercase hex): the Solana wallet's public key. */
  owner: z.string().regex(DEVICE_KEY_PATTERN),
  account: z.string().regex(/^0x[0-9a-f]{64}$/),
  payloadHash: z.string().regex(/^0x[0-9a-f]{64}$/),
  nonce: z.string().regex(/^0x[0-9a-f]{64}$/),
  expiry: z.string().regex(/^[0-9]{1,20}$/),
});
export type RelayActionMessage = z.infer<typeof RelayActionMessageSchema>;

/** A signed envelope. The signature is an Ed25519 signature (64 bytes, 128 hex). */
export const SignedRelayActionSchema = z.object({
  message: RelayActionMessageSchema,
  signature: z.string().regex(/^[0-9a-f]{128}$/),
});
export type SignedRelayAction = z.infer<typeof SignedRelayActionSchema>;

/** `account` for actions that have no account yet (registration). */
export const NO_ACCOUNT = `0x${'0'.repeat(64)}`;

/**
 * How a device signs an envelope (the seam lane B3 fills for Solana wallets).
 * `messageBytes` is what the wallet is asked to sign; `verify` checks `signature` (64 bytes) is the
 * envelope owner's over exactly those bytes.
 */
export interface RelayActionScheme {
  /** A short name for logs and errors ("solana-ed25519-v1"). */
  readonly id: string;
  messageBytes(message: RelayActionMessage): Uint8Array;
  verify(message: RelayActionMessage, signature: Uint8Array): boolean;
}

// ── Canonical JSON and the payload hash ──────────────────────────────────────

export class CanonicalJsonError extends Error {
  override name = 'CanonicalJsonError';
}

/**
 * A deterministic JSON rendering: object keys sorted, no whitespace, bigints as decimal
 * strings. Only plain JSON values (and bigints) are allowed: no undefined, functions, NaN,
 * byte arrays or class instances, so the browser and the relay always hash the same bytes.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'bigint':
      return JSON.stringify(value.toString(10));
    case 'number':
      if (!Number.isFinite(value)) throw new CanonicalJsonError('non-finite number');
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new CanonicalJsonError('only plain objects can be hashed (encode bytes as hex strings)');
      }
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
    }
    default:
      throw new CanonicalJsonError(`cannot hash a ${typeof value}`);
  }
}

/** SHA-256 of the payload's canonical JSON, 0x-prefixed lowercase hex. */
export function payloadHash(payload: unknown): string {
  return bytesToHex(sha256(new TextEncoder().encode(canonicalJson(payload))), true);
}

// ── Building ─────────────────────────────────────────────────────────────────

export interface RelayActionInput {
  action: RelayActionName;
  network: string;
  /** The device key (64 hex, any case, optional 0x). */
  owner: string;
  /** Passport account address (64 hex, with or without 0x); omit for registration. */
  account?: string;
  payload: unknown;
  /** Relay-issued nonce (0x + 64 hex). */
  nonce: string;
  /** Unix seconds. */
  expiry: number | bigint;
}

export function buildRelayActionMessage(input: RelayActionInput): RelayActionMessage {
  const account = input.account === undefined ? NO_ACCOUNT : `0x${input.account.replace(/^0x/, '').toLowerCase()}`;
  return RelayActionMessageSchema.parse({
    action: input.action,
    network: input.network,
    owner: input.owner.replace(/^0x/, '').toLowerCase(),
    account,
    payloadHash: payloadHash(input.payload),
    nonce: input.nonce.toLowerCase(),
    expiry: BigInt(input.expiry).toString(10),
  });
}

// ── Verification (the relay side) ────────────────────────────────────────────

export type AuthFailureCode =
  | 'malformed'
  | 'not-supported'
  | 'wrong-action'
  | 'wrong-network'
  | 'wrong-account'
  | 'payload-mismatch'
  | 'expired'
  | 'expiry-too-far'
  | 'bad-signature'
  | 'wrong-signer'
  | 'unknown-nonce'
  | 'replayed';

export type AuthResult =
  { ok: true; signer: string; message: RelayActionMessage } | { ok: false; code: AuthFailureCode; reason: string };

export interface VerifyRelayActionOptions {
  expectedAction: RelayActionName;
  network: string;
  /** The account the route acts on (64 hex, optional 0x), or undefined for registration. */
  expectedAccount?: string;
  payload: unknown;
  /** The signature scheme; absent until a wallet arm is wired (every envelope is then refused). */
  scheme?: RelayActionScheme;
  /** Unix seconds; defaults to the wall clock. */
  now?: number;
  /** The furthest an expiry may be in the future, in seconds. */
  maxTtlSeconds: number;
  /**
   * Consume the nonce: returns 'ok' if the relay issued it and it was unused (and marks it
   * used), 'unknown' if the relay never issued it (or forgot it on restart), 'used' if it was
   * already consumed. Called only after every other check passed.
   */
  consumeNonce(nonce: string, owner: string): 'ok' | 'unknown' | 'used';
}

const fail = (code: AuthFailureCode, reason: string): AuthResult => ({ ok: false, code, reason });

export const NOT_SUPPORTED_REASON =
  'signing is not available yet: Solana wallets arrive with the Ed25519 account arm (plan lanes B2 and B3)';

const unhex = (h: string) => {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
};

/** The checks every envelope passes, before its expiry and nonce: shape, binding and signature. */
function checkBinding(
  signed: unknown,
  options: Pick<VerifyRelayActionOptions, 'expectedAction' | 'network' | 'expectedAccount' | 'payload' | 'scheme'>,
  beforeSignature: (message: RelayActionMessage) => AuthResult | null = () => null,
): AuthResult {
  const parsed = SignedRelayActionSchema.safeParse(signed);
  if (!parsed.success) return fail('malformed', 'the authorisation is missing or malformed');
  const { message, signature } = parsed.data;
  if (message.action !== options.expectedAction)
    return fail('wrong-action', `signed for "${message.action}", not "${options.expectedAction}"`);
  if (message.network !== options.network) return fail('wrong-network', `signed for network "${message.network}"`);
  const expectedAccount =
    options.expectedAccount === undefined
      ? NO_ACCOUNT
      : `0x${options.expectedAccount.replace(/^0x/, '').toLowerCase()}`;
  if (message.account !== expectedAccount) return fail('wrong-account', 'signed for another account');
  let hash: string;
  try {
    hash = payloadHash(options.payload);
  } catch {
    return fail('malformed', 'the payload cannot be hashed');
  }
  if (message.payloadHash !== hash) return fail('payload-mismatch', 'the signature does not cover this request body');
  const early = beforeSignature(message);
  if (early) return early;
  if (!options.scheme) return fail('not-supported', NOT_SUPPORTED_REASON);
  let valid = false;
  try {
    valid = options.scheme.verify(message, unhex(signature));
  } catch {
    valid = false;
  }
  if (!valid) return fail('bad-signature', "the signature is not from the owner's device");
  return { ok: true, signer: message.owner, message };
}

/**
 * What a signed relay action binds, WITHOUT its expiry and nonce (security review F-B6): the action,
 * network, account and the exact payload, signed by the owner. An executor uses it to check again,
 * when a queued job's turn comes, an envelope the route already verified in full (its nonce is
 * spent, and it may have expired while the job waited).
 */
export function checkRelayActionBinding(
  signed: unknown,
  options: Pick<VerifyRelayActionOptions, 'expectedAction' | 'network' | 'expectedAccount' | 'payload' | 'scheme'>,
): AuthResult {
  return checkBinding(signed, options);
}

/** Check a signed relay action against the route it arrived on. Pure except `consumeNonce`. */
export function verifyRelayAction(signed: unknown, options: VerifyRelayActionOptions): AuthResult {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const r = checkBinding(signed, options, (message) => {
    const expiry = Number(message.expiry);
    if (!Number.isSafeInteger(expiry) || expiry <= now) return fail('expired', 'the authorisation has expired');
    if (expiry > now + options.maxTtlSeconds)
      return fail('expiry-too-far', `expiry is more than ${options.maxTtlSeconds} s ahead`);
    return null;
  });
  if (!r.ok) return r;
  const nonce = options.consumeNonce(r.message.nonce, r.signer);
  if (nonce === 'unknown')
    return fail('unknown-nonce', 'the relay did not issue this nonce (or has restarted); ask for a new one');
  if (nonce === 'used') return fail('replayed', 'this authorisation was already used');
  return r;
}
