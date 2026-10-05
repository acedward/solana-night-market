// AA 00060 P7.3 (spec US1-5): the Bridge-in records this browser keeps, one per Solana lock, under the
// store's `bridge` kind. They hold no secret: the lock's message (what the wallet is asked to sign), its
// blockhash's last valid height, the Solana signature once known, what was locked, the lock nonce once
// read, and the bridge's last word. A reload shows them and resumes following them; the account's balance
// arrives whether or not the page is open.
//
// P10.3 (audit C3): the record is written BEFORE the wallet is asked (state `signing`, id `in-<key>`, the
// key being the SHA-256 of the message), so a wallet that sends the lock but answers too late (or never)
// leaves a record the page can find the lock by. Records from before P10.3 keep their id `in-<signature>`.

import type { UndeliverableCode } from '@nightmarket/core/bridge';

import type { LocalStore } from '../../store/store.js';
import { recordKey, type WalletScope } from '../../store/schema.js';

export const BRIDGE_IN_STATES = [
  /** The wallet is being asked (the record exists before the prompt: audit C3). */
  'signing',
  /** The wallet did not answer in time, or the send failed: the lock may have been sent. The page looks
   *  for it on Solana (by its exact message) until it finds it or its blockhash expires (audit C3). */
  'unknown',
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
  /** The Solana transaction's signature (base58), once known. */
  signature?: string;
  /** SHA-256 of the lock's message (64 hex): the record's id (audit C3). Absent on records from before. */
  key?: string;
  /** The lock's message, base64: how the page recognises the lock on Solana without its signature. */
  message?: string;
  /** The last block height its blockhash is valid at: after it, an unseen lock was never sent. */
  lastValidBlockHeight?: string;
  /** The slot its blockhash was read at: the lock cannot be in an earlier slot (the search's bound). */
  fromSlot?: string;
  /** The depositor's token account the lock spends from (where the page looks for it). */
  source?: string;
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

/** The record's id: `in-<key>` (the message's hash), or `in-<signature>` for a record from before P10.3. */
export const bridgeInId = (r: Pick<BridgeInRecord, 'key' | 'signature'>): string => `in-${r.key ?? r.signature ?? ''}`;

export const putBridgeIn = (store: LocalStore, scope: WalletScope, account: string, r: BridgeInRecord) =>
  store.put(scope, 'bridge', r, { account, id: bridgeInId(r) });

/** Withdraw a record the wallet declined (nothing was sent: audit C3). */
export const removeBridgeIn = (store: LocalStore, scope: WalletScope, account: string, r: BridgeInRecord) =>
  store.remove(recordKey(scope, 'bridge', { account, id: bridgeInId(r) }));
