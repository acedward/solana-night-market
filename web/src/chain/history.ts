// The account's COMPLETE history, read and decoded by the browser itself (AA 00047 P11.B; questions
// Q47 A, which supersedes Q31 and Q43; spec FR-004b "Round 3"; audit round 3 R3-3…R3-6).
//
// WHAT IS READ (the public indexer of the site's network, never the relay):
//   1. `contract(address) { actions(limit: 500) { … } } block { height }` over HTTP: the account's
//      newest actions (newest first; the indexer caps the page at 500 and has no offset), each with its
//      transaction's hash, id, height, its range in the Zswap tree, the ledger's verdict, its raw Zswap
//      ledger events, and the entry point of the account's call;
//   2. when that page is FULL (the history may be longer) and this page session does not already hold
//      everything older: the `contractActions(address, offset: { height })` SUBSCRIPTION over a
//      WebSocket (./subscription.ts), from the deploy's block (or the height this session's read is
//      already complete through), oldest first, until it passes the oldest action the page holds. This
//      is the indexer's documented way to enumerate all of a contract's actions, and how midnight-js
//      follows a contract; it depends on nothing the relay says (Q43's by-hash reads named by the relay's
//      report are gone);
//   3. for a transaction that may have filled one of the account's approvals: its raw bytes
//      (`transactions(offset: { hash }) { raw }`), whose contract calls are decoded (R3-6).
//
// HOW COMPLETENESS IS KNOWN: a page shorter than the cap is the whole history; otherwise the stream
// must reach the page (by height, all of the oldest page height included), within a deadline and a cap
// on actions. Anything else leaves the history marked INCOMPLETE (`complete: false`, with the reason in
// `gap`), and nothing is concluded from what it lacks (@nightmarket/core `historyCovers`).
//
// WHAT IS DECODED: every event, with ledger-v9 (./ledger-decode.ts, loaded lazily, only here), keeping
// the account's own leaves (with the ledger's Merkle position) and spends. An event that does not
// decode, names another transaction, or puts a leaf outside its transaction's range leaves that
// transaction out and the history incomplete.
//
// Transactions are final once the indexer serves them, so a page session keeps what it decoded, per
// account, and later reads only what is newer.

import { mergeAccountTxs, type AccountHistory, type DecodedAccountTx, type DecodedCall } from '@nightmarket/core';

import type * as LedgerDecodeModule from './ledger-decode.js';
import type { IndexerTxForDecode } from './ledger-decode.js';
import { readSubscription } from './subscription.js';

/** The decoder (./ledger-decode.ts), loaded on first use. */
export type LedgerDecoder = Pick<
  typeof LedgerDecodeModule,
  'decodeAccountTx' | 'decodeTransactionCalls' | 'LedgerDecodeError'
>;

let decoderLoad: Promise<LedgerDecoder> | null = null;
/** ledger-v9's WebAssembly, fetched and instantiated on first use: the account and trade pages only. */
export function loadLedgerDecoder(): Promise<LedgerDecoder> {
  decoderLoad ??= import('./ledger-decode.js').catch((e: unknown) => {
    decoderLoad = null;
    throw e;
  });
  return decoderLoad;
}

/** The indexer's newest page of a contract's actions. */
export const HISTORY_PAGE = 500;
/** The most actions one read streams before giving up (the history is then incomplete). */
export const MAX_STREAMED_ACTIONS = 50_000;
/** How long one read may stream before giving up. */
export const STREAM_TIMEOUT_MS = 120_000;

const ACTION_FIELDS = `__typename
      ... on ContractCall { entryPoint }
      transaction {
        hash id block { height }
        ... on RegularTransaction { zswapStartIndex zswapEndIndex transactionResult { status } }
        zswapLedgerEvents { id raw }
      }`;

export const HISTORY_PAGE_QUERY = `query AccountHistory($address: HexEncoded!, $limit: Int) {
  contract(address: $address) {
    actions(limit: $limit) {
      ${ACTION_FIELDS}
    }
  }
  block { height }
}`;

export const HISTORY_SUBSCRIPTION = `subscription AccountHistory($address: HexEncoded!, $offset: BlockOffset) {
  contractActions(address: $address, offset: $offset) {
      ${ACTION_FIELDS}
  }
}`;

/** The block the account was deployed in: where its history starts. */
export const HISTORY_DEPLOY_QUERY = `query AccountHistoryStart($address: HexEncoded!) {
  contract(address: $address) { actions(limit: 1, type: DEPLOY) { transaction { block { height } } } }
}`;

export const TX_RAW_QUERY = `query AccountTxRaw($hash: HexEncoded!) {
  transactions(offset: { hash: $hash }) { hash ... on RegularTransaction { raw } }
}`;

/** One contract action as the indexer serves it (HTTP page and subscription alike). */
export interface IndexerAction {
  __typename?: string;
  entryPoint?: string | null;
  transaction: {
    hash: string;
    id: number;
    block: { height: number };
    zswapStartIndex?: number | null;
    zswapEndIndex?: number | null;
    transactionResult?: { status?: string | null } | null;
    zswapLedgerEvents?: Array<{ id: number; raw: string }> | null;
  };
}

const low = (h: string) => h.replace(/^0x/, '').toLowerCase();

/** Group actions by transaction (an account can be called more than once in one). */
export function txsOfActions(actions: readonly IndexerAction[]): IndexerTxForDecode[] {
  const byHash = new Map<string, IndexerTxForDecode & { entryPoints: string[] }>();
  for (const a of actions) {
    const t = a.transaction;
    const h = low(t.hash);
    const tx = byHash.get(h) ?? {
      hash: h,
      id: t.id,
      blockHeight: t.block.height,
      zswapStartIndex: t.zswapStartIndex ?? null,
      zswapEndIndex: t.zswapEndIndex ?? null,
      status: t.transactionResult?.status ?? null,
      entryPoints: [],
      events: t.zswapLedgerEvents ?? [],
    };
    if (a.entryPoint) tx.entryPoints.push(a.entryPoint);
    byHash.set(h, tx);
  }
  return [...byHash.values()];
}

export interface HistoryReaderOptions {
  graphql: <T>(query: string, variables: Record<string, unknown>) => Promise<T>;
  /** The indexer's WebSocket endpoint (`…/api/v4/graphql/ws`). */
  wsUrl: string;
  WebSocketImpl?: typeof WebSocket;
  decoder?: () => Promise<LedgerDecoder>;
  pageLimit?: number;
  maxStreamed?: number;
  streamTimeoutMs?: number;
}

interface Held {
  txs: DecodedAccountTx[];
  /** Complete from the deploy through this height (null: nothing complete held). */
  completeThrough: number | null;
}

export class AccountHistoryReader {
  private readonly held = new Map<string, Held>();
  private readonly inflight = new Map<string, Promise<AccountHistory>>();
  private readonly calls = new Map<string, DecodedCall[]>();

  constructor(private readonly o: HistoryReaderOptions) {}

  private decoder(): Promise<LedgerDecoder> {
    return (this.o.decoder ?? loadLedgerDecoder)();
  }

  /** The account's history (deduplicated, oldest first), and whether it is complete. */
  history(account: string): Promise<AccountHistory> {
    const address = low(account);
    const pending = this.inflight.get(address);
    if (pending) return pending;
    const read = this.read(address).finally(() => this.inflight.delete(address));
    this.inflight.set(address, read);
    return read;
  }

  private async read(address: string): Promise<AccountHistory> {
    const limit = Math.min(this.o.pageLimit ?? HISTORY_PAGE, HISTORY_PAGE);
    const page = await this.o.graphql<{
      contract: { actions: IndexerAction[] } | null;
      block: { height: number } | null;
    }>(HISTORY_PAGE_QUERY, { address, limit });
    const tip = page.block?.height ?? 0;
    if (!page.contract) return { account: address, txs: [], complete: true, throughHeight: tip };
    const held = this.held.get(address) ?? { txs: [], completeThrough: null };
    const pageTxs = txsOfActions(page.contract.actions);
    let raw: IndexerTxForDecode[] = pageTxs;
    let gap: string | undefined;
    if (page.contract.actions.length >= limit) {
      // The page is full: older actions may exist. They are known if this session's read is already
      // complete through the page's oldest height; otherwise stream them.
      const oldest = Math.min(...pageTxs.map((t) => t.blockHeight));
      const newest = pageTxs.reduce((a, b) => (b.blockHeight > a.blockHeight ? b : a));
      if (held.completeThrough === null || held.completeThrough < oldest) {
        try {
          const from = held.completeThrough ?? (await this.deployHeight(address));
          raw = [...(await this.stream(address, from, oldest, newest.hash)), ...pageTxs];
        } catch (e) {
          gap = e instanceof Error ? e.message : String(e);
        }
      }
    }
    const known = new Set(held.txs.map((t) => t.hash));
    const todo = raw.filter((t) => !known.has(low(t.hash)));
    const decoded: DecodedAccountTx[] = [];
    if (todo.length > 0) {
      const d = await this.decoder();
      for (const t of todo) {
        try {
          decoded.push(d.decodeAccountTx(address, t));
        } catch (e) {
          if (!(e instanceof d.LedgerDecodeError)) throw e;
          gap ??= `Midnight's record of one of this account's transactions could not be read (${e.message}).`;
        }
      }
    }
    const txs = mergeAccountTxs(held.txs, decoded);
    const complete = gap === undefined;
    this.held.set(address, {
      txs,
      // What is held stays complete through the older of the two reads when this one has a gap.
      completeThrough: complete ? tip : held.completeThrough,
    });
    return { account: address, txs, complete, throughHeight: tip, ...(gap ? { gap } : {}) };
  }

  private async deployHeight(address: string): Promise<number> {
    const d = await this.o.graphql<{
      contract: { actions: Array<{ transaction: { block: { height: number } } }> } | null;
    }>(HISTORY_DEPLOY_QUERY, { address });
    return d.contract?.actions[0]?.transaction.block.height ?? 0;
  }

  /** The account's actions from `from` (inclusive) through every action at `through`, streamed (it
   *  stops at the first action past `through`, or at the page's newest transaction `stopHash`). */
  private async stream(
    address: string,
    from: number,
    through: number,
    stopHash: string,
  ): Promise<IndexerTxForDecode[]> {
    const actions: IndexerAction[] = [];
    const max = this.o.maxStreamed ?? MAX_STREAMED_ACTIONS;
    let reached = false;
    await readSubscription({
      url: this.o.wsUrl,
      query: HISTORY_SUBSCRIPTION,
      variables: { address, offset: { height: from } },
      timeoutMs: this.o.streamTimeoutMs ?? STREAM_TIMEOUT_MS,
      ...(this.o.WebSocketImpl ? { WebSocketImpl: this.o.WebSocketImpl } : {}),
      onData: (data) => {
        const a = (data as { contractActions?: IndexerAction } | null)?.contractActions;
        if (!a?.transaction) return false;
        if (a.transaction.block.height > through || low(a.transaction.hash) === stopHash) {
          reached = true;
          return true;
        }
        actions.push(a);
        if (actions.length > max) throw new Error(`The account has more than ${max} actions to read.`);
        return false;
      },
    });
    if (!reached) throw new Error('The Midnight indexer’s stream ended before the newest page.');
    return txsOfActions(actions);
  }

  /** A transaction's contract calls, decoded from its raw bytes (kept: final), or null when the
   *  indexer does not have it. */
  async transactionCalls(hash: string): Promise<DecodedCall[] | null> {
    const h = low(hash);
    const known = this.calls.get(h);
    if (known) return known;
    const data = await this.o.graphql<{ transactions: Array<{ hash: string; raw?: string | null }> }>(TX_RAW_QUERY, {
      hash: h,
    });
    const tx = data.transactions.find((t) => low(t.hash) === h && typeof t.raw === 'string');
    if (!tx?.raw) return null;
    const d = await this.decoder();
    const calls = d.decodeTransactionCalls(tx.raw, h);
    if (this.calls.size >= 1_000) this.calls.clear();
    this.calls.set(h, calls);
    return calls;
  }
}
