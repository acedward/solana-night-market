// AA 00060 P6.2 (spec FR-010, FR-011): the Bridge-out records this browser keeps, one per transfer (its tx1
// auth nonce), under the store's `bridge` kind (id `out-<auth nonce>`). Written BEFORE each step (tx1, the
// lock, the return), so a reload resumes; they hold only public values (the landing key's coin public key
// and check value, the predicted landing coin, the relay's entitlement): never a signature, the master key
// or a per-transfer key (spec SC-005). Without them, "Find my transfers" finds every open transfer from the
// chain alone (./operations.ts `findTransfers`).

import type { LocalStore } from '../../store/store.js';
import type { WalletScope } from '../../store/schema.js';

export const BRIDGE_OUT_STATES = [
  /** The wallet is being asked for tx1 (the withdrawal to the landing key). */
  'tx1-signing',
  /** The market ran tx1; the landing coin is on its way to the landing key. */
  'tx1-sent',
  /** The landing coin is at the landing key (or found again by "Find my transfers"). */
  'landed',
  /** The market sent the lock (tx2). */
  'tx2-sent',
  /** The bridge recorded the withdrawal on Midnight; the release on Solana follows. */
  'locked',
  /** The tokens are in the wallet on Solana (the bridge's release receipt, or the token balance). */
  'arrived',
  /** The market sent the return to the account. */
  'returning',
  /** The coin is back in the account (the page's own decode). */
  'returned',
  /** tx1 never paid the landing key (refused or failed): nothing moved. */
  'failed',
] as const;
export type BridgeOutState = (typeof BRIDGE_OUT_STATES)[number];

export interface BridgeOutRecord {
  direction: 'out';
  /** The account's auth nonce tx1 is signed at: the transfer's index (I-5 `seed_t`). */
  authNonce: string;
  colour: string;
  symbol: string;
  /** Base units. */
  amount: string;
  bridgeContract: string;
  bridgeProgram: string;
  bridgeApi: string;
  /** The wallet (base58): the lock's Solana recipient. */
  wallet: string;
  /** The account coin tx1 spends. */
  spentCoin: { nonce: string; color: string; value: string };
  /** keys_t's coin public key (public). */
  landingCoinPublicKey: string;
  /** The landing coin tx1 pays (its nonce is public: the paid-out nonce of the spent coin). */
  landingNonce: string;
  landingCommitment: string;
  /** I-5's check value (public): a later derivation must give the same. */
  check: string;
  createdAt: number;
  state: BridgeOutState;
  tx1Id?: string;
  /** The relay's single-use landing entitlement (a MAC; not a secret of the customer's). */
  entitlement?: string;
  tx2Id?: string;
  /** The bridge's withdrawal id (I-3 `m2s:<id>`). */
  withdrawalId?: string;
  progress?: string;
  checkedAt?: number;
}

const FINAL: ReadonlySet<BridgeOutState> = new Set(['arrived', 'returned', 'failed']);
export const isFinalOut = (r: BridgeOutRecord): boolean => FINAL.has(r.state);

export function readBridgeOuts(store: LocalStore, scope: WalletScope, account: string): BridgeOutRecord[] {
  const out: BridgeOutRecord[] = [];
  for (const r of store.list(scope)) {
    if (r.parsed.kind !== 'bridge' || r.parsed.scope.global || r.parsed.scope.account !== account || !r.record)
      continue;
    const d = r.record.data as BridgeOutRecord;
    if (d.direction === 'out') out.push(d);
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

export const putBridgeOut = (store: LocalStore, scope: WalletScope, account: string, r: BridgeOutRecord) =>
  store.put(scope, 'bridge', r, { account, id: `out-${r.authNonce}` });
