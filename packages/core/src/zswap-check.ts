// The account's Zswap activity: which of its shielded coins exist (a leaf the ledger inserted, at an
// exact Merkle position) and which are spent (a nullifier the ledger spent).
//
// AA 00047 P11.B (questions Q47 A, which supersedes Q31; spec FR-004b "Round 3"; audit round 3
// R3-3, R3-4, R3-5, R3-6): the BROWSER decodes this itself. It reads the account's COMPLETE history
// from the public indexer (web/src/chain/indexer.ts) and decodes every transaction's ledger events
// with ledger-v9's own WebAssembly, loaded lazily on the account and trade pages only
// (web/src/chain/ledger-decode.ts). Nothing here comes from the relay any more: the relay's
// `GET /v1/accounts/:a/zswap` report is not read by the page at all.
//
// What the page keeps of each transaction (`DecodedAccountTx`) is only what the ledger itself says
// about THIS account: the leaves of coins the account owns (`zswapOutput` events whose contract is the
// account, with the ledger's own `mtIndex`), the nullifiers of the account's coins it spent
// (`zswapInput` events whose contract is the account), and the entry points of the account's calls in
// it (the indexer's contract actions). The rules below then work on positive evidence only:
//
//   - a coin is identified by its FULL commitment (nonce, colour, value, owner), and has a position
//     only when a decoded leaf carries exactly that commitment (./coins.ts `reconcileCoins`);
//   - something is ABSENT from the account's history (a spend that never happened, a fill that never
//     came) only when the history read is COMPLETE through a height at or past the state the decision
//     rests on (`historyCovers`); otherwise the page does not decide;
//   - an approval is FILLED only by the decoded swap transaction that consumed it (`fillEvidence`).
//
// The relay-report checker below it (`checkZswapActivity`, Q31) is kept for compatibility (and its
// tests) but is no longer used by the page.

import {
  contractCoinCommitment,
  contractCoinNullifier,
  type CoinInfo,
  type OwnedInput,
  type OwnedOutput,
} from './coins.js';
import type { ZswapActivity } from './accounts.js';

/** One of the account's transactions with its raw Zswap events, as the indexer serves them. */
export interface RawAccountTx {
  hash: string;
  blockHeight: number;
  events: ReadonlyArray<{ id: number; raw: string }>;
}

const norm = (h: string) => h.replace(/^0x/, '').toLowerCase();

/** Whether `hay` (hex) contains `needle` (hex) at a whole-byte offset. */
export function containsBytes(hay: string, needle: string): boolean {
  const h = norm(hay);
  const n = norm(needle);
  if (n.length === 0 || n.length % 2 !== 0) return false;
  for (let i = h.indexOf(n); i >= 0; i = h.indexOf(n, i + 1)) if (i % 2 === 0) return true;
  return false;
}

export interface ZswapCheck {
  /** The report, with only what the indexer's own events support. */
  activity: ZswapActivity;
  /** Reported outputs and spends the indexer does not support (dropped). */
  unsupported: Array<{ kind: 'output' | 'spend'; value: string; txHash: string }>;
}

/** Keep the relay's reported outputs and spends that the account's own transactions carry. */
export function checkZswapActivity(account: string, reported: ZswapActivity, txs: readonly RawAccountTx[]): ZswapCheck {
  const me = norm(account);
  const byHash = new Map(txs.map((t) => [norm(t.hash), t]));
  const unsupported: ZswapCheck['unsupported'] = [];
  const carried = (txHash: string, value: string) => {
    const tx = byHash.get(norm(txHash));
    return !!tx && tx.events.some((e) => containsBytes(e.raw, me) && containsBytes(e.raw, value));
  };
  const outputs: OwnedOutput[] = [];
  for (const o of reported.outputs) {
    if (carried(o.txHash, o.commitment)) outputs.push(o);
    else unsupported.push({ kind: 'output', value: norm(o.commitment), txHash: norm(o.txHash) });
  }
  const inputs: OwnedInput[] = [];
  for (const i of reported.inputs) {
    if (carried(i.txHash, i.nullifier)) inputs.push(i);
    else unsupported.push({ kind: 'spend', value: norm(i.nullifier), txHash: norm(i.txHash) });
  }
  return { activity: { ...reported, outputs, inputs }, unsupported };
}

// ── The account's history, decoded by the browser (AA 00047 P11.B, Q47 A) ──────────────────────

/** One of the account's transactions, as the browser decoded it (ledger-v9) from the public indexer. */
export interface DecodedAccountTx {
  /** The transaction hash, 64 lowercase hex. */
  hash: string;
  blockHeight: number;
  /** The indexer's transaction id (orders transactions within a block). */
  id: number;
  /** The entry points of the account's calls in this transaction (the indexer's contract actions for
   *  the account; empty for its deploy and maintenance updates). */
  entryPoints: string[];
  /** The leaves the ledger inserted for coins THIS account owns: decoded `zswapOutput` events whose
   *  contract is the account, with the ledger's own Merkle position. */
  outputs: Array<{ commitment: string; mtIndex: string }>;
  /** The nullifiers of THIS account's coins the ledger spent: decoded `zswapInput` events whose
   *  contract is the account. */
  inputs: string[];
}

/** The account's history as the browser read it. */
export interface AccountHistory {
  /** The account's address, 64 lowercase hex. */
  account: string;
  /** Every transaction read, oldest first (by block height, then the indexer's id). */
  txs: DecodedAccountTx[];
  /** True when `txs` is the account's WHOLE history through `throughHeight`: nothing in between was
   *  skipped. Only a complete history may be used to say something did NOT happen. */
  complete: boolean;
  /** The chain height the read covers (the indexer's tip when it was read). */
  throughHeight: number;
  /** Why the history is not complete, when it is not (shown to the customer). */
  gap?: string;
}

/** One contract call of a transaction, decoded (ledger-v9) from the transaction's raw bytes. */
export interface DecodedCall {
  /** The called contract, 64 lowercase hex. */
  address: string;
  entryPoint: string;
  /** The coin commitments the call claims to RECEIVE (its transcripts' effects). */
  receives: string[];
  /** The nullifiers the call claims (the coins it spends). */
  nullifiers: string[];
}

/** The account's swap entry point: the only call that receives a trade's wanted coin (spec FR-011/012). */
export const SWAP_ENTRY_POINTS: readonly string[] = ['open_swap_shielded_with_ed25519'];

const low = (h: string) => h.replace(/^0x/, '').toLowerCase();

/** The leaves and spends of a decoded history, as the coin list reads them (./coins.ts). */
export function activityOf(history: AccountHistory): ZswapActivity {
  const outputs: OwnedOutput[] = [];
  const inputs: OwnedInput[] = [];
  for (const t of history.txs) {
    for (const o of t.outputs)
      outputs.push({ commitment: low(o.commitment), mtIndex: o.mtIndex, txHash: t.hash, blockHeight: t.blockHeight });
    for (const n of t.inputs) inputs.push({ nullifier: low(n), txHash: t.hash, blockHeight: t.blockHeight });
  }
  return {
    account: low(history.account),
    outputs,
    inputs,
    transactions: history.txs.length,
    blockHeight: history.throughHeight,
  };
}

/** Whether the history is COMPLETE through `height`: only then may the page conclude from what it
 *  does NOT contain (R3-4: a spend that never happened; R3-6: a fill that never came). */
export const historyCovers = (history: Pick<AccountHistory, 'complete' | 'throughHeight'>, height: number): boolean =>
  history.complete && history.throughHeight >= height;

/** The transaction that spent a coin of the account (its decoded nullifier), or null. */
export function spendOf(history: AccountHistory, coin: CoinInfo): DecodedAccountTx | null {
  const nullifier = contractCoinNullifier(coin, history.account);
  return history.txs.find((t) => t.inputs.some((n) => low(n) === nullifier)) ?? null;
}

/** The transaction that created a coin of the account (the decoded leaf of its full commitment), or null. */
export function leafOf(history: AccountHistory, commitment: string): { tx: DecodedAccountTx; mtIndex: string } | null {
  const c = low(commitment);
  for (const t of history.txs) {
    const o = t.outputs.find((x) => low(x.commitment) === c);
    if (o) return { tx: t, mtIndex: o.mtIndex };
  }
  return null;
}

/**
 * The transactions that MAY have filled an approval wanting `want` (R3-6): the ones whose decoded
 * leaves carry the wanted coin's full commitment for the account AND in which the account made a swap
 * call. Their raw bytes are read and decoded (`fillEvidence`) before anything is called filled.
 */
export function fillCandidates(history: AccountHistory, want: CoinInfo): string[] {
  const w = contractCoinCommitment(want, history.account);
  return history.txs
    .filter(
      (t) => t.outputs.some((o) => low(o.commitment) === w) && t.entryPoints.some((e) => SWAP_ENTRY_POINTS.includes(e)),
    )
    .map((t) => t.hash);
}

/**
 * POSITIVE evidence that an approval (an offer or a take) was FILLED (AA 00047 P11.B, audit round 3
 * R3-6 / F-A3-3 / F-B3-5): a transaction of the account's decoded history in which
 *   1. the ledger inserted a leaf with the wanted coin's FULL commitment (nonce, colour, value, this
 *      account), and
 *   2. the account's own SWAP call (decoded from the transaction's raw bytes) claims to receive exactly
 *      that coin and, when the paying coin is known, claims its nullifier.
 * The device's signature binds the wanted coin (its fresh nonce included) and the auth nonce it was
 * signed at (`open_swap_shielded_with_ed25519`'s challenge), so the swap call that receives it is that
 * approval's own, and it consumed that nonce. An inbox note proves nothing (anyone can file one with
 * `deposit_shielded`), and neither does a matching coin deposited in another transaction, or in the
 * same one by another call: neither is the swap's.
 * `calls(hash)` is the transaction's decoded calls, or undefined when they were not read.
 */
export function fillEvidence(args: {
  history: AccountHistory;
  want: CoinInfo;
  /** The coin the approval pays from, when the page still knows it. */
  give?: CoinInfo | null;
  calls: (txHash: string) => readonly DecodedCall[] | undefined;
}): { txHash: string; blockHeight: number } | null {
  const account = low(args.history.account);
  const w = contractCoinCommitment(args.want, account);
  const giveNullifier = args.give ? contractCoinNullifier(args.give, account) : null;
  for (const hash of fillCandidates(args.history, args.want)) {
    const tx = args.history.txs.find((t) => t.hash === hash)!;
    const calls = args.calls(hash);
    if (!calls) continue;
    const paid = calls.some(
      (c) =>
        low(c.address) === account &&
        SWAP_ENTRY_POINTS.includes(c.entryPoint) &&
        c.receives.some((r) => low(r) === w) &&
        (giveNullifier === null || c.nullifiers.some((n) => low(n) === giveNullifier)),
    );
    if (paid) return { txHash: tx.hash, blockHeight: tx.blockHeight };
  }
  return null;
}

/**
 * Merge transaction lists (by hash; a later copy of a transaction adds the entry points an earlier
 * partial read missed), oldest first.
 */
export function mergeAccountTxs(...lists: ReadonlyArray<readonly DecodedAccountTx[]>): DecodedAccountTx[] {
  const byHash = new Map<string, DecodedAccountTx>();
  for (const list of lists)
    for (const t of list) {
      const h = low(t.hash);
      const prev = byHash.get(h);
      byHash.set(
        h,
        prev ? { ...prev, entryPoints: [...new Set([...prev.entryPoints, ...t.entryPoints])] } : { ...t, hash: h },
      );
    }
  return [...byHash.values()].sort(
    (a, b) => a.blockHeight - b.blockHeight || a.id - b.id || (a.hash < b.hash ? -1 : 1),
  );
}
