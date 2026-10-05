// AA 00060 P7.3 (spec US1-5): the Bridge-in records this browser keeps, one per Solana lock it sent, under
// the store's `bridge` kind (id `in-<signature>`). They hold no secret: the Solana signature, what was
// locked, the lock nonce once read, and the bridge's last word. A reload shows them and resumes following
// them; the account's balance arrives whether or not the page is open.

import type { UndeliverableCode } from '@nightmarket/core/bridge';

import type { LocalStore } from '../../store/store.js';
import type { WalletScope } from '../../store/schema.js';

export const BRIDGE_IN_STATES = [
  /** The wallet sent it (or the page did); not confirmed on Solana yet. */
  'sent',
  /** Confirmed on Solana; its lock nonce read from the program's log. */
  'locked',
  /** The bridge reports it (observed / submitted). */
  'bridging',
  /** The PAGE's own decode shows the coin in the account. */
  'completed',
  /** The bridge gave up on the delivery: the SPL stays locked (no refund path). */
  'undeliverable',
  /** The Solana transaction failed: nothing was locked. */
  'failed',
] as const;
export type BridgeInState = (typeof BRIDGE_IN_STATES)[number];

export interface BridgeInRecord {
  direction: 'in';
  /** The Solana transaction's signature (base58). */
  signature: string;
  colour: string;
  mint: string;
  symbol: string;
  /** Base units. */
  amount: string;
  bridgeApi: string;
  /** The account's balance of `colour` by the page's own decode when the lock was sent (base units). */
  balanceBefore: string;
  createdAt: number;
  state: BridgeInState;
  lockNonce?: string;
  /** The bridge's progress words (I-3), as last read. */
  progress?: string;
  reason?: { code: UndeliverableCode; message: string };
  checkedAt?: number;
}

export const readBridgeIns = (store: LocalStore, scope: WalletScope, account: string): BridgeInRecord[] => {
  const out: BridgeInRecord[] = [];
  for (const r of store.list(scope)) {
    if (r.parsed.kind !== 'bridge' || r.parsed.scope.global || r.parsed.scope.account !== account || !r.record)
      continue;
    const d = r.record.data as BridgeInRecord;
    if (d.direction === 'in') out.push(d);
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
};

export const putBridgeIn = (store: LocalStore, scope: WalletScope, account: string, r: BridgeInRecord) =>
  store.put(scope, 'bridge', r, { account, id: `in-${r.signature}` });
