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
    refusedAtOpen: z
      .array(z.object({ code: z.string().regex(/^[a-z-]{1,32}$/), message: text(300) }).strict())
      .max(16)
      .optional(),
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
    pending: z
      .object({
        authNonce: decimal,
        input: z.object({ nonce: hex32, color: hex32, value: decimal }).strict(),
        since: ms,
      })
      .strict()
      .optional(),
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
    status: z.enum(['live', 'filled', 'expired', 'cancelled', 'ended', 'refused']),
    kernelStatus: text(64).optional(),
    settledTx: txId.optional(),
    fillVerified: z.literal(true).optional(),
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
      'restore-enc-key',
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

/** AA 00060 P7.3: a Bridge-in record (../bridge/in/records.ts); no secret. */
const base58 = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,90}$/);
const bridgeIn = z
  .object({
    direction: z.literal('in'),
    signature: base58.optional(),
    key: hex32.optional(),
    message: z
      .string()
      .regex(/^[A-Za-z0-9+/]{1,4000}={0,2}$/)
      .optional(),
    lastValidBlockHeight: decimal.optional(),
    fromSlot: decimal.optional(),
    lookupErrors: z.number().int().min(0).max(100_000).optional(),
    blockhashExpired: z.boolean().optional(),
    searchBefore: base58.optional(),
    source: base58.optional(),
    colour: hex32,
    mint: base58,
    symbol: text(16),
    amount: decimal,
    bridgeApi: z.string().regex(/^https?:\/\/[^\s/]{1,200}$/),
    balanceBefore: decimal,
    createdAt: ms,
    state: z.enum([
      'signing',
      'unknown',
      'sent',
      'locked',
      'bridging',
      'completed',
      'undeliverable',
      'failed',
      'dismissed',
    ]),
    lockNonce: decimal.optional(),
    progress: text(300).optional(),
    reason: z
      .object({ code: text(40), message: text(500) })
      .strict()
      .optional(),
    checkedAt: ms.optional(),
  })
  .strict();

/** AA 00060 P6.2: a Bridge-out record (../bridge/out/records.ts). Public values only: the landing key's
 *  PUBLIC coin key and check value, the predicted landing coin, the relay's entitlement (a MAC, not a
 *  secret of the customer's); never a signature, the master key or a per-transfer key (spec SC-005). */
const bridgeOut = z
  .object({
    direction: z.literal('out'),
    authNonce: decimal,
    colour: hex32,
    symbol: text(16),
    amount: decimal,
    bridgeContract: hex32,
    bridgeProgram: base58,
    bridgeApi: z.string().regex(/^https?:\/\/[^\s/]{1,200}$/),
    wallet: base58,
    spentCoin: z.object({ nonce: hex32, color: hex32, value: decimal }).strict(),
    landingCoinPublicKey: hex32,
    landingNonce: hex32,
    landingCommitment: hex32,
    check: z.string().regex(/^[0-9a-f]{32}$/),
    createdAt: ms,
    state: z.enum([
      'tx1-signing',
      'tx1-sent',
      'landed',
      'tx2-sent',
      'locked',
      'arrived',
      'returning',
      'returned',
      'failed',
    ]),
    tx1Id: z
      .string()
      .regex(/^[0-9a-fA-F]{1,200}$/)
      .optional(),
    entitlement: z
      .string()
      .regex(/^le1\.[0-9a-f]{64}\.[0-9a-f]{64}\.[1-9][0-9]{0,11}\.[0-9a-f]{64}$/)
      .optional(),
    tx2Id: z
      .string()
      .regex(/^[0-9a-fA-F]{1,200}$/)
      .optional(),
    withdrawalId: decimal.optional(),
    progress: text(300).optional(),
    checkedAt: ms.optional(),
  })
  .strict();

const bridge = z.union([bridgeIn, bridgeOut]);

export const RECORD_DATA_SCHEMAS: Record<RecordKind, z.ZodType> = {
  bridge,
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
  const needsAccount = ['account', 'coins', 'roster', 'offer', 'bridge'].includes(key.kind);
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
    case 'bridge':
      if (
        d.direction === 'out'
          ? key.id !== `out-${String(d.authNonce)}`
          : key.id !== `in-${String(d.key ?? d.signature)}` || (d.key === undefined && d.signature === undefined)
      )
        return 'a bridge record does not match its key';
      break;
    case 'secret':
      // A secret and its public key must be one pair (security review F-B5).
      if (encPublicKeyOf(String(d.encSecretKey)) !== d.encPublicKey)
        return "a secret record's public key is not its secret's";
      break;
  }
  return null;
}
