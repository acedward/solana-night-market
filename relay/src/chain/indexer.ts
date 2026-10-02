// The indexer reads behind the account routes: which Zswap leaves the ledger inserted for the
// account's coins (with their exact Merkle positions), and which of its coins were spent.
//
// Source: the indexer's `contract(address) { actions { transaction { zswapLedgerEvents } } }`
// (indexer API v4, present on the local 4.4.0-rc.3 stack and on stagenet). Every coin an account
// owns is created by a transaction that calls the account (a contract-owned output must be
// claimed by its contract in the same transaction), so the account's actions cover all of them.
// Each event is the ledger's own serialised `Event`, decoded here with ledger-v9:
//   zswapOutput { commitment, contract, mtIndex }   a new leaf, at its exact position
//   zswapInput  { nullifier, contract }              a spend
// Only events whose `contract` is the account are kept.
//
// Past 500 actions (AA 00047 P11, audit round 3 R3-5 / F-B3-4). `contract.actions` answers the
// NEWEST actions only, at most 500 (indexer API v4, `Contract.actions`: "use the `contractActions`
// subscription to enumerate all actions"); the relay used to refuse such an account (501
// `history-too-long`), so its coins could not be found nor its spends proven. Now, when that page is
// full, the relay reads the whole history through the `contractActions(address, offset: {height})`
// subscription (./ws-subscription.ts), which streams the account's actions in order from a block
// height, until it has seen every transaction of the newest page: the union is then the complete
// history at the time of the read. What it read is kept per account (a bounded cache): the next read
// subscribes only from the block after the cached history, or not at all when the newest page
// already overlaps it. The indexer indexes whole finalised blocks, so a block it has served does not
// change. `AccountHistoryTooLongError` remains for an account past `maxHistoryActions` (100,000).
//
// Each action also names its entry point when it is a call (AA 00047 P11.F, audit round 4 R4-2): a take
// the exchange did not settle is judged by the transaction that spent its coin or moved its account's
// nonce (../trade/reconcile.ts), and only the account's own calls in it say whose that was.

import type { OwnedInput, OwnedOutput, ZswapActivity } from '@nightmarket/core';

import { subscribeUntil, type WebSocketFactory } from './ws-subscription.js';

export class IndexerError extends Error {
  override name = 'IndexerError';
  /** The indexer failed or could not be reached: not the requester's doing. */
  readonly infrastructure = true;
}

/** The account's history is longer than the relay reads (`maxHistoryActions`), or longer than one
 *  indexer page while the relay has no WebSocket URL to read the rest. */
export class AccountHistoryTooLongError extends IndexerError {
  override name = 'AccountHistoryTooLongError';
  constructor(readonly limit: number) {
    super(`the account has more than ${limit} actions, more than this relay reads`);
  }
}

const ACTIONS_QUERY = `query AccountActions($address: HexEncoded!, $limit: Int) {
  contract(address: $address) {
    actions(limit: $limit) {
      __typename ... on ContractCall { entryPoint }
      transaction { hash block { height } zswapLedgerEvents { id raw } }
    }
  }
  block { height }
}`;

/** Every action of the account from a block height on, oldest first (indexer API v4). */
export const HISTORY_SUBSCRIPTION = `subscription AccountHistory($address: HexEncoded!, $offset: BlockOffset) {
  contractActions(address: $address, offset: $offset) {
    __typename ... on ContractCall { entryPoint }
    transaction { hash block { height } zswapLedgerEvents { id raw } }
  }
}`;

/** The indexer's largest `Contract.actions` page. */
export const INDEXER_PAGE_LIMIT = 500;

interface ActionTxWire {
  /** The call's entry point (a ContractCall); absent for a deploy or a maintenance update. */
  entryPoint?: string | null;
  transaction: {
    hash: string;
    block: { height: number };
    zswapLedgerEvents: Array<{ id: number; raw: string }> | null;
  };
}

export interface RawActionTx {
  hash: string;
  blockHeight: number;
  events: Array<{ id: number; raw: string }>;
  /** The entry points of the account's calls in this transaction (AA 00047 P11.F, R4-2). */
  entryPoints?: string[];
}

export interface IndexerClientOptions {
  indexerUrl: string;
  /** The indexer's WebSocket endpoint (subscriptions): how a history past one page is read. Absent:
   *  such an account answers `AccountHistoryTooLongError` (as before AA 00047 P11). */
  indexerWsUrl?: string;
  fetchImpl?: typeof fetch;
  /** For tests: the WebSocket the subscription opens. */
  webSocket?: WebSocketFactory;
  timeoutMs?: number;
  /** The newest-actions page size (the indexer caps it at 500; tests lower it). */
  maxActions?: number;
  /** The most actions read per account through the subscription (default 100,000). */
  maxHistoryActions?: number;
  /** How long one history subscription may take (default 120 s). */
  historyTimeoutMs?: number;
  /** Accounts whose read history is kept (least recently used forgotten first; default 256). */
  maxCachedAccounts?: number;
}

/** What the relay keeps of an account's history: every transaction up to and including the block
 *  `completeThrough` (all of that block's actions included). */
interface CachedHistory {
  byHash: Map<string, RawActionTx>;
  completeThrough: number;
  actions: number;
}

export class IndexerClient {
  private readonly f: typeof fetch;
  private readonly histories = new Map<string, CachedHistory>();
  /** Subscriptions run (for operators and tests). */
  subscriptions = 0;
  constructor(private readonly options: IndexerClientOptions) {
    this.f = options.fetchImpl ?? fetch;
  }

  async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const res = await this.f(this.options.indexerUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 20_000),
    });
    if (!res.ok) throw new IndexerError(`the indexer answered ${res.status}`);
    const body = (await res.json()) as { data?: T; errors?: Array<{ message?: string }> };
    if (body.errors?.length) throw new IndexerError(`indexer: ${body.errors.map((e) => e.message).join('; ')}`);
    if (!body.data) throw new IndexerError('the indexer returned no data');
    return body.data;
  }

  /** The chain tip's height. */
  async tip(): Promise<number> {
    const data = await this.graphql<{ block: { height: number } | null }>('query Tip { block { height } }', {});
    return data.block?.height ?? 0;
  }

  /** The account's transactions (deduplicated, oldest first) and the chain tip: its WHOLE history,
   *  however long (see the header). */
  async accountTransactions(account: string): Promise<{ txs: RawActionTx[]; tip: number } | null> {
    const limit = Math.min(this.options.maxActions ?? INDEXER_PAGE_LIMIT, INDEXER_PAGE_LIMIT);
    const data = await this.graphql<{
      contract: { actions: ActionTxWire[] } | null;
      block: { height: number } | null;
    }>(ACTIONS_QUERY, { address: account, limit });
    if (!data.contract) return null;
    const tip = data.block?.height ?? 0;
    const page = new Map<string, RawActionTx>();
    for (const a of data.contract.actions) addTx(page, a);
    if (data.contract.actions.length < limit) return { txs: sorted(page), tip };
    // A full page: older actions may exist. Read the rest of the history.
    return { txs: sorted(await this.wholeHistory(account, page)), tip };
  }

  /** The account's whole history, given its newest page (`page`, a full one). */
  private async wholeHistory(account: string, page: Map<string, RawActionTx>): Promise<Map<string, RawActionTx>> {
    const key = account.replace(/^0x/, '').toLowerCase();
    const pageHeights = [...page.values()].map((t) => t.blockHeight);
    const pageFrom = Math.min(...pageHeights);
    const pageTo = Math.max(...pageHeights);
    let cached = this.histories.get(key);
    if (cached) this.histories.delete(key); // re-inserted below: Map order is least recently used
    // The newest page holds every action from some point in block `pageFrom` on; the cache holds
    // every action through block `completeThrough`. They cover everything when they overlap.
    if (!cached || pageFrom > cached.completeThrough) {
      if (!this.options.indexerWsUrl) throw new AccountHistoryTooLongError(page.size);
      const from = cached ? cached.completeThrough + 1 : 0;
      const byHash = cached ? new Map(cached.byHash) : new Map<string, RawActionTx>();
      let actions = cached?.actions ?? 0;
      const missing = new Set(page.keys());
      for (const h of byHash.keys()) missing.delete(h);
      const max = this.options.maxHistoryActions ?? 100_000;
      this.subscriptions++;
      await subscribeUntil<{ contractActions: ActionTxWire }>({
        url: this.options.indexerWsUrl,
        query: HISTORY_SUBSCRIPTION,
        variables: { address: key, offset: { height: from } },
        timeoutMs: this.options.historyTimeoutMs ?? 120_000,
        ...(this.options.webSocket ? { webSocket: this.options.webSocket } : {}),
        onNext: (d) => {
          const a = d.contractActions;
          if (!a?.transaction?.hash) return false;
          if (++actions > max) throw new AccountHistoryTooLongError(max);
          addTx(byHash, a);
          missing.delete(a.transaction.hash);
          return missing.size === 0;
        },
      });
      cached = { byHash, completeThrough: from - 1, actions };
    }
    for (const t of page.values()) if (!cached.byHash.has(t.hash)) cached.byHash.set(t.hash, t);
    // The page is the newest at the time of the read: every block through its newest one is complete.
    cached.completeThrough = Math.max(cached.completeThrough, pageTo);
    this.histories.set(key, cached);
    const maxAccounts = this.options.maxCachedAccounts ?? 256;
    while (this.histories.size > maxAccounts) {
      const oldest = this.histories.keys().next().value;
      if (oldest === undefined) break;
      this.histories.delete(oldest);
    }
    return cached.byHash;
  }
}

function addTx(into: Map<string, RawActionTx>, a: ActionTxWire): void {
  const t = a.transaction;
  let tx = into.get(t.hash);
  if (!tx) {
    tx = { hash: t.hash, blockHeight: t.block.height, events: t.zswapLedgerEvents ?? [], entryPoints: [] };
    into.set(t.hash, tx);
  }
  // A transaction with several calls of the account is several actions: keep each one's entry point.
  const eps = (tx.entryPoints ??= []);
  if (typeof a.entryPoint === 'string' && a.entryPoint && !eps.includes(a.entryPoint)) eps.push(a.entryPoint);
}

const sorted = (m: Map<string, RawActionTx>): RawActionTx[] =>
  [...m.values()].sort((a, b) => a.blockHeight - b.blockHeight || (a.hash < b.hash ? -1 : 1));

/** A decoded Zswap event, as ledger-v9's `Event.content` describes it. */
export type DecodedEvent =
  | { tag: 'zswapOutput'; commitment: string; contract: string | undefined; mtIndex: bigint }
  | { tag: 'zswapInput'; nullifier: string; contract: string | undefined }
  | { tag: string };

export type EventDecoder = (rawHex: string) => DecodedEvent;

/** ledger-v9's decoder (loaded on first use: the WASM is large). */
export async function ledgerEventDecoder(): Promise<EventDecoder> {
  const { Event } = await import('@midnightntwrk/ledger-v9');
  return (rawHex) => {
    const bytes = Uint8Array.from(Buffer.from(rawHex.replace(/^0x/, ''), 'hex'));
    return Event.deserialize(bytes).content as DecodedEvent;
  };
}

const norm = (h: string | undefined) => (h ?? '').replace(/^0x/, '').toLowerCase();

/** One of the account's transactions, decoded: its calls' entry points, the leaves of the account's
 *  coins it inserted (full commitments) and the nullifiers of the account's coins it spent. */
export interface AccountTxView {
  hash: string;
  blockHeight: number;
  entryPoints: readonly string[];
  outputs: readonly string[];
  inputs: readonly string[];
}

/** The account's transactions, decoded for the account (AA 00047 P11.F, R4-2), oldest first. */
export function accountTxViews(account: string, txs: readonly RawActionTx[], decode: EventDecoder): AccountTxView[] {
  const me = norm(account);
  const seenEvents = new Set<number>();
  return txs.map((tx) => {
    const outputs: string[] = [];
    const inputs: string[] = [];
    for (const ev of [...tx.events].sort((a, b) => a.id - b.id)) {
      if (seenEvents.has(ev.id)) continue;
      seenEvents.add(ev.id);
      const d = decode(ev.raw);
      if (d.tag === 'zswapOutput' && 'commitment' in d && norm(d.contract) === me) outputs.push(norm(d.commitment));
      else if (d.tag === 'zswapInput' && 'nullifier' in d && norm(d.contract) === me) inputs.push(norm(d.nullifier));
    }
    return {
      hash: norm(tx.hash),
      blockHeight: tx.blockHeight,
      entryPoints: [...(tx.entryPoints ?? [])],
      outputs,
      inputs,
    };
  });
}

/** Keep the account's own leaves and spends from its transactions' events. */
export function zswapActivityOf(
  account: string,
  txs: readonly RawActionTx[],
  decode: EventDecoder,
  tip: number,
): ZswapActivity {
  const me = norm(account);
  const outputs: OwnedOutput[] = [];
  const inputs: OwnedInput[] = [];
  const seenEvents = new Set<number>();
  for (const tx of txs) {
    for (const ev of [...tx.events].sort((a, b) => a.id - b.id)) {
      if (seenEvents.has(ev.id)) continue;
      seenEvents.add(ev.id);
      const d = decode(ev.raw);
      if (d.tag === 'zswapOutput' && 'commitment' in d && norm(d.contract) === me) {
        outputs.push({
          commitment: norm(d.commitment),
          mtIndex: d.mtIndex.toString(10),
          txHash: tx.hash,
          blockHeight: tx.blockHeight,
        });
      } else if (d.tag === 'zswapInput' && 'nullifier' in d && norm(d.contract) === me) {
        inputs.push({ nullifier: norm(d.nullifier), txHash: tx.hash, blockHeight: tx.blockHeight });
      }
    }
  }
  return { account: me, outputs, inputs, transactions: txs.length, blockHeight: tip };
}
