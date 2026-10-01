// The shape of every record kind this page writes (security review F-B4), so an Import accepts
// only records this page could have written itself: every field known and well-typed, nothing
// else, and each record consistent with the key it is filed under (its account, its id). The
// types they mirror live next to the code that writes them (passport/records.ts, trade/records.ts,
// @nightmarket/core `StoredCoin`); a change there must be made here too, and the
// store tests import a record of every kind written the way the page writes it.
//
// Addresses, colours, amounts and keys are checked exactly (they decide where money goes); text
// that is only shown (a summary, a message) is bounded in length. React renders it as text.

import { z } from 'zod';

import { APPEND_ENTITLEMENT_PATTERN, encPublicKeyOf } from '@nightmarket/core';

import { AssetFilterDataSchema } from '../assets/filter.js';
import { ASSET_FILTER_ID, type ParsedKey, type RecordKind } from './schema.js';

const hex32 = z.string().regex(/^[0-9a-f]{64}$/);
const decimal = z.string().regex(/^[0-9]{1,40}$/);
const ms = z.number().int().nonnegative();
/** A transaction id or hash as the relay or a wallet reported it (shown, and linked in an explorer
 *  URL path: letters, digits, `-` and `_` only). */
const txId = z.string().regex(/^[0-9A-Za-z_-]{0,200}$/);
const text = (max: number) => z.string().max(max);
const entitlement = z.string().regex(APPEND_ENTITLEMENT_PATTERN);

const profile = z.object({ firstSeen: ms.optional(), lastSeen: ms.optional() }).strict();

/** Nothing writes a wallet-scoped `settings` record today: accept only a small flat map. */
const settings = z.record(z.string().max(64), z.union([text(256), z.number(), z.boolean(), z.null()]));

const account = z
  .object({
    address: hex32,
    device: hex32,
    network: z.string().regex(/^[a-z0-9-]{1,32}$/),
    createdAt: ms,
    txs: z.object({ waveOne: txId, waveTwo: txId, activation: txId }).strict().optional(),
  })
  .strict();

const secret = z.object({ encSecretKey: hex32, encPublicKey: hex32, pending: z.boolean().optional() }).strict();

const storedCoin = z
  .object({
    nonce: hex32,
    color: hex32,
    value: decimal,
    mtIndex: decimal.nullable(),
    commitment: hex32,
    origin: z.enum(['inbox', 'change', 'local']),
    inInbox: z.boolean(),
    inboxIndex: decimal.optional(),
    createdTx: txId.optional(),
    spent: z.boolean(),
    spentTx: txId.optional(),
    appendEntitlement: entitlement.optional(),
    changeOf: z.object({ spent: hex32, amount: decimal }).strict().optional(),
  })
  .strict();
// No count bound of its own (security review F-B8): an account's list only grows (spent coins are
// kept, see @nightmarket/core `reconcileCoins`), and a bound below what the browser can hold refused
// the page's own exports. The import's size bound, checked before any record is parsed, is the
// limit: it measures what localStorage itself can hold (schema.ts `MAX_IMPORT_FILE_BYTES`).
const coins = z.array(storedCoin);

const roster = z.object({ useCounter: decimal }).strict();

const offer = z
  .object({
    offerId: hex32,
    role: z.enum(['make', 'take']),
    side: z.enum(['buy', 'sell']),
    pair: z.string().regex(/^[A-Za-z0-9._-]{1,16}\/[A-Za-z0-9._-]{1,16}$/),
    base: hex32,
    quote: hex32,
    baseRaw: decimal,
    quoteRaw: decimal,
    summary: text(200),
    coin: hex32,
    authNonce: decimal,
    wantNonce: hex32,
    createdAt: ms,
    expiresAt: ms,
    validUntil: decimal.optional(),
    status: z.enum(['live', 'filled', 'expired', 'cancelled', 'refused']),
    kernelStatus: text(64).optional(),
    settledTx: txId.optional(),
    checkedAt: ms.optional(),
  })
  .strict();

const job = z
  .object({
    requestId: z.string().regex(/^[0-9a-f]{32}$/),
    action: z.enum([
      'register',
      'withdraw',
      'withdraw-unshielded',
      'append-inbox',
      'open-swap',
      'take',
      'demo-tokens',
      'cancel-offers',
    ]),
    startedAt: ms,
    state: z.enum(['queued', 'running', 'succeeded', 'failed']),
    stage: text(64),
    context: z
      .object({ summary: text(200).optional(), spent: hex32.optional(), coin: hex32.optional() })
      .strict()
      .optional(),
  })
  .strict();

export const RECORD_DATA_SCHEMAS: Record<RecordKind, z.ZodType> = {
  profile,
  settings,
  account,
  secret,
  coins,
  roster,
  offer,
  job,
};

/**
 * Why an imported record's data is not one this page writes, or null when it is. Checks its shape
 * for its kind, and that it agrees with the key it is filed under.
 */
export function recordDataProblem(key: ParsedKey, data: unknown): string | null {
  // The asset filter (plan 00042) is the one browser-wide settings record Import accepts.
  const isAssetFilter = key.kind === 'settings' && key.scope.global && key.id === ASSET_FILTER_ID;
  const r = (isAssetFilter ? AssetFilterDataSchema : RECORD_DATA_SCHEMAS[key.kind]).safeParse(data);
  if (!r.success) return `a ${key.kind} record is not in the shape this page writes`;
  const scopeAccount = key.scope.global ? null : key.scope.account;
  const needsAccount = ['account', 'coins', 'roster', 'offer'].includes(key.kind);
  if (needsAccount && !scopeAccount) return `a ${key.kind} record is not filed under an account`;
  if (['profile'].includes(key.kind) && scopeAccount) return 'a profile record is filed under an account';
  const d = r.data as Record<string, unknown>;
  switch (key.kind) {
    case 'account':
      if (d.address !== scopeAccount) return 'an account record names another account than its key';
      if (!key.scope.global && d.network !== key.scope.network) return 'an account record names another network';
      if (!key.scope.global && String(d.device) !== key.scope.owner)
        return 'an account record names another device than this wallet';
      break;
    case 'offer':
      if (key.id !== `${String(d.role)}-${String(d.offerId)}`) return 'an offer record does not match its key';
      break;
    case 'job':
      if (key.id !== d.requestId) return 'a job record does not match its key';
      break;
    case 'secret':
      // A secret and its public key must be one pair (security review F-B5).
      if (encPublicKeyOf(String(d.encSecretKey)) !== d.encPublicKey)
        return "a secret record's public key is not its secret's";
      break;
  }
  return null;
}
