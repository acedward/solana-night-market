// I-4, the RPC injector's account registration (owner 00059; consumer: Night Market's "Show in my
// wallet"), as the page uses it (AA 00060 P1.5). Browser-safe.
//
// PROVISIONAL: 00059's PROPOSAL of 2026-10-04 (plans/00059-injector-passport-accounts.md, Interfaces
// "I-4", PROPOSED): `GET /api/accounts/registration-info`, `POST /api/accounts` with
// `{solanaAddress, accountAddress, accountViewingKey, message, signature}`, `GET /api/accounts/:id`, the
// 9-line v1 text below, its error codes and statuses. P8.2 takes 00059's frozen builder, route and codes
// and its vectors; T8.5 checks that I-4's first line differs from I-5's, from `Site: ` and from every
// market label.
//
// Night Market renders the text ITSELF from this template and the injector's registration info; it
// never signs text an injector hands it.

import { z } from 'zod';

export const I4_STATUS = 'PROVISIONAL (00059 proposal of 2026-10-04)';

export const REGISTRATION_FIRST_LINE = 'solana-token-injector account registration v1';
export const REGISTRATION_MAX_BYTES = 512;

export const REGISTRATION_ERROR_CODES = [
  'malformed',
  'bad-solana-address',
  'bad-account-address',
  'bad-viewing-key',
  'bad-message',
  'message-mismatch',
  'wrong-origin',
  'wrong-network',
  'expired',
  'expiry-too-far',
  'bad-signature',
  'indexer-unavailable',
  'account-not-found',
  'not-passport-account',
  'not-a-device',
  'enc-key-mismatch',
  'storage-error',
  'accounts-disabled',
  'not-found',
] as const;
export type RegistrationErrorCode = (typeof REGISTRATION_ERROR_CODES)[number];

export const REGISTRATION_STATUSES = ['syncing', 'synced', 'incomplete', 'stale-key', 'error'] as const;
export type RegistrationStatus = (typeof REGISTRATION_STATUSES)[number];

export const RegistrationInfoSchema = z.object({
  format: z.literal(REGISTRATION_FIRST_LINE),
  origin: z.string(),
  networkId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/),
  maxTtlSeconds: z.number().int().positive(),
});
export type RegistrationInfo = z.infer<typeof RegistrationInfoSchema>;

export const RegistrationViewSchema = z
  .object({
    id: z.string().regex(/^[0-9a-f]{16}$/),
    solanaAddress: z.string(),
    accountAddress: z.string().regex(/^[0-9a-f]{64}$/),
    networkId: z.string(),
    keyFingerprint: z.string(),
    status: z.enum(REGISTRATION_STATUSES),
    error: z.string().nullable(),
    unseenCoins: z.number().int().nonnegative(),
    created: z.boolean().optional(),
    replacedKey: z.boolean().optional(),
  })
  .passthrough();
export type RegistrationView = z.infer<typeof RegistrationViewSchema>;

export interface RegistrationText {
  /** The injector's origin (registration-info `origin`). */
  origin: string;
  /** The injector's Midnight network (registration-info `networkId`). */
  networkId: string;
  /** The wallet (canonical base58). */
  solanaAddress: string;
  /** The account (64 hex, no 0x). */
  accountAddress: string;
  /** Unix seconds. */
  expires: number;
}

const two = (n: number) => String(n).padStart(2, '0');

/** "YYYY-MM-DD HH:MM:SS UTC". */
export function registrationExpiry(unixSeconds: number): string {
  const t = new Date(unixSeconds * 1000);
  return `${t.getUTCFullYear()}-${two(t.getUTCMonth() + 1)}-${two(t.getUTCDate())} ${two(t.getUTCHours())}:${two(t.getUTCMinutes())}:${two(t.getUTCSeconds())} UTC`;
}

/** The v1 registration text (9 lines, LF, no trailing LF). */
export function registrationMessageText(p: RegistrationText): string {
  const account = p.accountAddress.replace(/^0x/, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(account)) throw new RangeError('the account address is 64 hex');
  const text = [
    REGISTRATION_FIRST_LINE,
    'Show my Midnight account in my Solana wallet',
    `RPC ${p.origin}`,
    `Midnight network ${p.networkId}`,
    `Wallet ${p.solanaAddress}`,
    `Account ${account}`,
    `Expires ${registrationExpiry(p.expires)}`,
    "The RPC will see this account's balances.",
    'This signature authorises nothing on chain and moves no funds.',
  ].join('\n');
  if (!/^[\x20-\x7e\n]+$/.test(text) || text.length > REGISTRATION_MAX_BYTES) {
    throw new RangeError('the registration text must be printable ASCII, at most 512 bytes');
  }
  return text;
}

export class InjectorError extends Error {
  override name = 'InjectorError';
  constructor(
    message: string,
    readonly code: RegistrationErrorCode | 'unreachable' | 'unknown',
    readonly status?: number,
  ) {
    super(message);
  }
}

const base = (url: string) => url.replace(/\/+$/, '');

async function errorOf(res: Response): Promise<InjectorError> {
  let code: InjectorError['code'] = 'unknown';
  let message = `the injector answered ${res.status}`;
  try {
    const body = (await res.json()) as { code?: unknown; error?: unknown };
    if (typeof body.code === 'string' && (REGISTRATION_ERROR_CODES as readonly string[]).includes(body.code)) {
      code = body.code as RegistrationErrorCode;
    }
    if (typeof body.error === 'string') message = body.error;
  } catch {
    /* not JSON */
  }
  return new InjectorError(message, code, res.status);
}

export async function readRegistrationInfo(url: string, fetchImpl: typeof fetch = fetch): Promise<RegistrationInfo> {
  const res = await fetchImpl(`${base(url)}/api/accounts/registration-info`, { cache: 'no-store' });
  if (!res.ok) throw await errorOf(res);
  const parsed = RegistrationInfoSchema.safeParse(await res.json());
  if (!parsed.success) throw new InjectorError('the injector answered an unknown registration format', 'unknown');
  return parsed.data;
}

export interface RegistrationBody {
  solanaAddress: string;
  accountAddress: string;
  accountViewingKey: string;
  message: string;
  signature: string;
}

/** `POST /api/accounts` to the CONFIGURED injector only. Never retried here. */
export async function postRegistration(
  url: string,
  body: RegistrationBody,
  fetchImpl: typeof fetch = fetch,
): Promise<RegistrationView> {
  const res = await fetchImpl(`${base(url)}/api/accounts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await errorOf(res);
  const parsed = RegistrationViewSchema.safeParse(await res.json());
  if (!parsed.success) throw new InjectorError('the injector answered an unknown shape', 'unknown');
  return parsed.data;
}

export async function readRegistration(
  url: string,
  id: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RegistrationView> {
  if (!/^[0-9a-f]{16}$/.test(id)) throw new InjectorError('not a registration id', 'malformed');
  const res = await fetchImpl(`${base(url)}/api/accounts/${id}`, { cache: 'no-store' });
  if (!res.ok) throw await errorOf(res);
  const parsed = RegistrationViewSchema.safeParse(await res.json());
  if (!parsed.success) throw new InjectorError('the injector answered an unknown shape', 'unknown');
  return parsed.data;
}
