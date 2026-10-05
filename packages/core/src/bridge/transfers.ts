// I-3, the bridge node's transfer API (owner 00058; consumer: Night Market's Bridge in and Bridge out
// progress), as the page reads it (AA 00060 P1.5). Browser-safe.
//
// FROZEN: 00058 froze I-3 on 2026-10-04 at effectstream `6c07dab` (PR #937; plans/00058-bridge-contract-delivery.md,
// Interfaces "I-3") with its proposal unchanged: `TransferView` v2 (adds `recipientKind`, `reason {code, message, at}`,
// `delivery {adapter, account, coin, tx}`; status `undeliverable`), `GET /transfers/:id` answering 404
// until the node's Solana sync passes the lock's slot plus 32, and `GET /recipients/contract/:address`
// with `deliverable | undeliverable | retry` (adapter set iff deliverable, code set iff undeliverable). Its
// vectors (test/fixtures/00058-interfaces.json, `i3`) parse here (packages/core/test/bridge-in.test.ts).
//
// WIDENED 2026-10-05 (00058 Q6, resolved A by the 00057 orchestrator): `recipientKind` may be `null`, only
// while an s2m row's Solana lock has not been seen yet (the node's Midnight sync ran ahead during a
// re-sync). `readTransfer` reads such a view as `not-seen`: the page keeps polling.
//
// The page reads progress from here, but judges COMPLETION only by its own decode of the account
// (Bridge in, spec FR-003) or by the release on Solana (Bridge out, FR-009): the bridge API is not
// trusted for the outcome. The recognition verdict is asked BESIDE the page's own Q26 check, never
// instead of it.

import { z } from 'zod';

export const I3_STATUS = 'FROZEN 2026-10-04 (00058 @ 6c07dab); widened 2026-10-05 (00058 Q6 A: recipientKind null)';

export const TRANSFER_STATUSES = ['observed', 'submitted', 'completed', 'undeliverable'] as const;
export type TransferStatus = (typeof TRANSFER_STATUSES)[number];

export const UNDELIVERABLE_CODES = [
  'no-adapter',
  'not-a-contract',
  'not-a-passport-account',
  'authority-live',
  'bad-enc-key',
  'wrong-network',
  'counters',
] as const;
export type UndeliverableCode = (typeof UNDELIVERABLE_CODES)[number];

/** The page's plain words for each reason the bridge gives up on a delivery (the SPL stays locked). */
export const UNDELIVERABLE_TEXT: Readonly<Record<UndeliverableCode, string>> = {
  'no-adapter': 'The bridge cannot deliver to accounts at all (it has no delivery set up).',
  'not-a-contract': 'The bridge found no contract at the account address on this network.',
  'not-a-passport-account': 'The bridge does not recognise the account as a Night Market account.',
  'authority-live': "The account's setup key is still live, so the bridge will not deliver to it.",
  'bad-enc-key': "The account's encryption key is not usable.",
  'wrong-network': 'The account belongs to another network.',
  counters: "The account's counters are too high to deliver to.",
};

const decimal = z.string().regex(/^(0|[1-9][0-9]*)$/);
const hex64 = z.string().regex(/^[0-9a-f]{64}$/);

export const TransferViewSchema = z.object({
  id: z.string().regex(/^(s2m|m2s):(0|[1-9][0-9]*)$/),
  direction: z.enum(['s2m', 'm2s']),
  sourceId: z.string(),
  amount: decimal,
  recipientKind: z.enum(['wallet', 'contract', 'solana']).nullable(),
  recipient: z.string().nullable(),
  sender: z.string().nullable(),
  status: z.enum(TRANSFER_STATUSES),
  reason: z.object({ code: z.enum(UNDELIVERABLE_CODES), message: z.string(), at: z.string() }).nullable(),
  delivery: z
    .object({
      adapter: z.string(),
      account: hex64,
      coin: z.object({ nonce: hex64, colour: hex64, value: decimal }).nullable(),
      tx: z.string().nullable(),
    })
    .nullable(),
  srcRef: z.string().nullable(),
  dstRef: z.string().nullable(),
  observedBlock: z.number().int(),
  completedBlock: z.number().int().nullable(),
  relayer: z
    .object({
      attempts: z.number().int(),
      submittedAt: z.string().nullable(),
      lastAttemptAt: z.string().nullable(),
      lastTx: z.string().nullable(),
      lastError: z.string().nullable(),
    })
    .nullable(),
});
export type TransferView = z.infer<typeof TransferViewSchema>;

export const RecipientVerdictSchema = z.object({
  address: hex64,
  verdict: z.enum(['deliverable', 'undeliverable', 'retry']),
  adapter: z.string().nullable(),
  code: z.enum(UNDELIVERABLE_CODES).nullable(),
  message: z.string().nullable(),
  checkedAt: z.string(),
});
export type RecipientVerdict = z.infer<typeof RecipientVerdictSchema>;

export class BridgeApiError extends Error {
  override name = 'BridgeApiError';
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/** One read of a transfer: not seen by the bridge yet (404), or its view. */
export type TransferRead = { kind: 'not-seen' } | { kind: 'view'; view: TransferView };

const base = (api: string) => api.replace(/\/+$/, '');

/** `GET <api>/transfers/<id>`. The node answers the view WRAPPED, `{ "transfer": TransferView }` (00058
 *  `packages/node/api.ts` @ 1c9f4959; AA 00060 P10.3 C13: the page once read it bare, so every progress
 *  read failed and `undeliverable` was never shown). A 404 is "not seen yet" (the node's sync has not
 *  passed the lock), and so is a view whose `recipientKind` is null (00058 Q6: the lock itself is not
 *  seen yet). */
export async function readTransfer(api: string, id: string, fetchImpl: typeof fetch = fetch): Promise<TransferRead> {
  if (!/^(s2m|m2s):(0|[1-9][0-9]*)$/.test(id)) throw new BridgeApiError(`not a transfer id: ${id}`);
  const res = await fetchImpl(`${base(api)}/transfers/${encodeURIComponent(id)}`, { cache: 'no-store' });
  if (res.status === 404) return { kind: 'not-seen' };
  if (!res.ok) throw new BridgeApiError(`the bridge answered ${res.status}`, res.status);
  const body = (await res.json().catch(() => null)) as { transfer?: unknown } | null;
  const parsed = TransferViewSchema.safeParse(body && typeof body === 'object' ? body.transfer : undefined);
  if (!parsed.success) throw new BridgeApiError('the bridge answered a transfer in an unknown shape');
  if (parsed.data.id !== id) throw new BridgeApiError('the bridge answered another transfer');
  if (parsed.data.recipientKind === null) return { kind: 'not-seen' };
  return { kind: 'view', view: parsed.data };
}

/** `GET <api>/recipients/contract/<address>`: the bridge's own verdict on delivering to an account. */
export async function readRecipientVerdict(
  api: string,
  address: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RecipientVerdict> {
  const a = address.replace(/^0x/, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(a)) throw new BridgeApiError('an account address is 64 hex');
  const res = await fetchImpl(`${base(api)}/recipients/contract/${a}`, { cache: 'no-store' });
  if (!res.ok) throw new BridgeApiError(`the bridge answered ${res.status}`, res.status);
  const parsed = RecipientVerdictSchema.safeParse(await res.json());
  if (!parsed.success || parsed.data.address !== a) throw new BridgeApiError('the bridge answered an unknown shape');
  return parsed.data;
}

/** What the page shows for a transfer's progress (completion is judged elsewhere: see the header). */
export function transferProgressText(read: TransferRead): string {
  if (read.kind === 'not-seen') return 'Waiting for the bridge to see the lock';
  const v = read.view;
  switch (v.status) {
    case 'observed':
      return 'The bridge has seen the lock';
    case 'submitted':
      return 'The bridge is delivering';
    case 'completed':
      return 'The bridge reports it delivered';
    case 'undeliverable':
      return `The bridge cannot deliver: ${v.reason ? UNDELIVERABLE_TEXT[v.reason.code] : 'no reason given'} The tokens stay locked on Solana.`;
  }
}
