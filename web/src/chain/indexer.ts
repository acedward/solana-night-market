// The browser's own reader of the chain (AA 00047 P9.S; spec FR-004b; questions Q26 A and Q31): the
// PUBLIC Midnight indexer of the site's network (`network.midnight.indexerUrl`, the stagenet one by
// default), read straight from the page, never through the relay. The relay is trustless: it relays
// signatures, proves and pays, but what the page believes about an account comes from here.
//
// Two GraphQL reads, the same ones midnight-js's public data provider and the relay make:
//   - `contract(address) { state }`: the account's serialised ContractState, decoded in the page with
//     the compiled account's `ledger()` (@nightmarket/core/passport `decodeAccountState`). Everything
//     a signature binds (the auth nonce, the device and its use counter, the network salt), the
//     encryption key notes are sealed to, the inbox, the public balances, the verifier keys and the
//     maintenance authority come from it;
//   - `contract(address) { actions { transaction { hash block { height } zswapLedgerEvents } } }`:
//     the account's transactions and their raw Zswap events, against which the relay's decoded report
//     of the account's coins is checked (@nightmarket/core `checkZswapActivity`, Q31). The indexer
//     serves only the newest 500 there (its cap, with no offset); an account with a longer history
//     (an active one, or one a griefer filled with 500 one-unit deposits, audit round 2 R2-6) is read
//     past that page by transaction hash, `transactions(offset: { hash })`, for every transaction the
//     relay's report names that the page does not hold, in pages of `TX_PAGE`, each kept only when
//     its own `contractActions` name the account (AA 00047 P10, questions Q43).
// The stagenet indexer answers any origin (`access-control-allow-origin: *`); a deployment with a
// Content-Security-Policy must allow it in `connect-src` (deploy/RUNBOOK.md).

import { type AccountStateView, type RawAccountTx } from '@nightmarket/core';
import {
  PINNED_ACCOUNT_KEYS,
  accountCheckText,
  checkMarketAccount,
  decodeAccountState,
  networkSaltFor,
  type AccountChainState,
  type AccountCheck,
  type MarketAccountExpectation,
} from '@nightmarket/core/passport';

/** What the page knows to expect of its account (the rest is this build's and this network's). */
export type AccountExpectation = Pick<MarketAccountExpectation, 'deviceKey' | 'encPublicKey' | 'fresh' | 'counterHint'>;

export class ChainReadError extends Error {
  override name = 'ChainReadError';
}

/** How many transactions one by-hash read asks for (GraphQL aliases in one request). */
export const TX_PAGE = 50;
/** The most transactions read by hash for one account read (a relay naming endless hashes cannot
 *  make the page read forever: what is past this stays unconfirmed, never an error). */
export const MAX_TXS_BY_HASH = 2_000;
const HASH_RE = /^[0-9a-f]{64}$/;

const STATE_QUERY = `query AccountState($address: HexEncoded!) {
  contract(address: $address) { state }
  block { height }
}`;

/** The block the account was deployed in (AA 00047 P10, R2-6). */
const DEPLOY_QUERY = `query AccountDeploy($address: HexEncoded!) {
  contract(address: $address) { actions(limit: 1, type: DEPLOY) { transaction { block { height } } } }
}`;

/** The account's state as of a block: at the deploy's block, the state as DEPLOYED. */
const STATE_AT_QUERY = `query AccountStateAt($address: HexEncoded!, $height: Int!) {
  contract(address: $address, offset: { height: $height }) { state }
}`;

const ACTIONS_QUERY = `query AccountActions($address: HexEncoded!, $limit: Int) {
  contract(address: $address) {
    actions(limit: $limit) {
      transaction { hash block { height } zswapLedgerEvents { id raw } }
    }
  }
}`;

/** One page of transactions by hash: `t<i>: transactions(offset: { hash: $h<i> })`. */
const txsByHashQuery = (n: number) =>
  `query AccountTxs(${Array.from({ length: n }, (_, i) => `$h${i}: HexEncoded!`).join(', ')}) {\n` +
  Array.from(
    { length: n },
    (_, i) =>
      `  t${i}: transactions(offset: { hash: $h${i} }) { hash block { height } contractActions { address } zswapLedgerEvents { id raw } }`,
  ).join('\n') +
  '\n}';

interface IndexerTx {
  hash: string;
  block: { height: number };
  contractActions?: Array<{ address: string }>;
  zswapLedgerEvents?: Array<{ id: number; raw: string }>;
}

export interface ChainReaderOptions {
  indexerUrl: string;
  /** The Midnight network id (for the network salt every account of this network carries). */
  networkId: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** The most actions read per account (the indexer caps a page at 500). */
  maxActions?: number;
}

/** The account as the chain shows it, at a block height. */
export interface AccountOnChain extends AccountChainState {
  blockHeight: number;
}

export class ChainReader {
  private readonly f: typeof fetch;
  constructor(private readonly o: ChainReaderOptions) {
    this.f = o.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  /** Where the page reads the chain (shown on the account panel). */
  get indexerUrl(): string {
    return this.o.indexerUrl;
  }

  /** This network's salt. */
  get networkSalt(): string {
    return networkSaltFor(this.o.networkId);
  }

  private async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    let res: Response;
    try {
      res = await this.f(this.o.indexerUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(this.o.timeoutMs ?? 20_000),
      });
    } catch {
      throw new ChainReadError('The Midnight indexer did not answer. Check your connection and try again.');
    }
    if (!res.ok) throw new ChainReadError(`The Midnight indexer answered ${res.status}.`);
    let body: { data?: T; errors?: Array<{ message?: string }> };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      throw new ChainReadError('The Midnight indexer sent something that is not JSON.');
    }
    if (body.errors?.length)
      throw new ChainReadError(
        `The Midnight indexer refused the read: ${body.errors.map((e) => e.message).join('; ')}`,
      );
    if (!body.data) throw new ChainReadError('The Midnight indexer returned no data.');
    return body.data;
  }

  /** The account's whole on-chain state, or null when there is no contract at the address. */
  async account(account: string): Promise<AccountOnChain | null> {
    const address = account.replace(/^0x/, '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(address)) throw new ChainReadError('That is not an account address.');
    // Several parts of a page ask at once (the check on the page, the side panel, the demo card):
    // reads already on their way are shared, never cached past their answer.
    const pending = this.inflight.get(address);
    if (pending) return pending;
    const read = this.readAccount(address).finally(() => this.inflight.delete(address));
    this.inflight.set(address, read);
    return read;
  }

  private readonly inflight = new Map<string, Promise<AccountOnChain | null>>();

  private async readAccount(address: string): Promise<AccountOnChain | null> {
    const data = await this.graphql<{ contract: { state: string } | null; block: { height: number } | null }>(
      STATE_QUERY,
      { address },
    );
    if (!data.contract?.state) return null;
    return { ...decodeAccountState(address, data.contract.state), blockHeight: data.block?.height ?? 0 };
  }

  /** The account's state as it was DEPLOYED (the indexer's state at the deploy's block), or null when
   *  the indexer shows no deploy. It never changes: kept once read (AA 00047 P10, R2-6). */
  async deployedState(account: string): Promise<AccountChainState | null> {
    const address = account.replace(/^0x/, '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(address)) throw new ChainReadError('That is not an account address.');
    const known = this.deployed.get(address);
    if (known) return known;
    const d = await this.graphql<{
      contract: { actions: Array<{ transaction: { block: { height: number } } }> } | null;
    }>(DEPLOY_QUERY, { address });
    const height = d.contract?.actions[0]?.transaction.block.height;
    if (height === undefined) return null;
    const at = await this.graphql<{ contract: { state: string } | null }>(STATE_AT_QUERY, { address, height });
    if (!at.contract?.state) return null;
    const state = decodeAccountState(address, at.contract.state);
    this.deployed.set(address, state);
    return state;
  }

  private readonly deployed = new Map<string, AccountChainState>();

  /** The account's public state (what a gated call binds), or null. */
  async accountState(account: string): Promise<AccountStateView | null> {
    return (await this.account(account))?.view ?? null;
  }

  /**
   * The account's transactions with their raw Zswap events (deduplicated, oldest first): the newest
   * page of its actions, and, when that page is full (the history may be longer), every transaction
   * in `need` (the hashes the relay's report names) that the page does not hold, read by hash and
   * kept only when it is one of the account's (its contract actions name the account). Never throws
   * for a long history (AA 00047 P10, R2-6).
   */
  async accountTransactions(account: string, need: Iterable<string> = []): Promise<RawAccountTx[]> {
    const address = account.replace(/^0x/, '').toLowerCase();
    const limit = Math.min(this.o.maxActions ?? 500, 500);
    const data = await this.graphql<{
      contract: { actions: Array<{ transaction: IndexerTx }> } | null;
    }>(ACTIONS_QUERY, { address, limit });
    if (!data.contract) return [];
    const byHash = new Map<string, RawAccountTx>();
    for (const a of data.contract.actions) {
      const t = a.transaction;
      const h = t.hash.replace(/^0x/, '').toLowerCase();
      if (!byHash.has(h))
        byHash.set(h, { hash: t.hash, blockHeight: t.block.height, events: t.zswapLedgerEvents ?? [] });
    }
    if (data.contract.actions.length >= limit) {
      // The page is full: the account has older transactions than it shows. Read the ones the
      // report needs, by hash.
      const missing = [...new Set([...need].map((h) => h.replace(/^0x/, '').toLowerCase()))]
        .filter((h) => HASH_RE.test(h) && !byHash.has(h))
        .slice(0, MAX_TXS_BY_HASH);
      for (const t of await this.transactionsByHash(address, missing)) byHash.set(t.hash.toLowerCase(), t);
    }
    return [...byHash.values()].sort((x, y) => x.blockHeight - y.blockHeight || (x.hash < y.hash ? -1 : 1));
  }

  /** Transactions are final once the indexer serves them: what was read by hash is kept (bounded). */
  private readonly txCache = new Map<string, RawAccountTx | null>();

  /** The transactions with these hashes that are the account's (`contractActions` name it), read in
   *  pages of `TX_PAGE`. */
  private async transactionsByHash(address: string, hashes: readonly string[]): Promise<RawAccountTx[]> {
    const out: RawAccountTx[] = [];
    const todo: string[] = [];
    for (const h of hashes) {
      const hit = this.txCache.get(`${address}:${h}`);
      if (hit === undefined) todo.push(h);
      else if (hit) out.push(hit);
    }
    for (let i = 0; i < todo.length; i += TX_PAGE) {
      const page = todo.slice(i, i + TX_PAGE);
      const vars = Object.fromEntries(page.map((h, k) => [`h${k}`, h]));
      const data = await this.graphql<Record<string, IndexerTx[] | null>>(txsByHashQuery(page.length), vars);
      page.forEach((h, k) => {
        const found = (data[`t${k}`] ?? []).find(
          (t) =>
            t.hash.replace(/^0x/, '').toLowerCase() === h &&
            (t.contractActions ?? []).some((a) => a.address.replace(/^0x/, '').toLowerCase() === address),
        );
        const tx = found ? { hash: h, blockHeight: found.block.height, events: found.zswapLedgerEvents ?? [] } : null;
        if (this.txCache.size >= 10_000) this.txCache.clear();
        this.txCache.set(`${address}:${h}`, tx);
        if (tx) out.push(tx);
      });
    }
    return out;
  }

  /**
   * The market-account check (audit C3) on the chain's own state: the verifier keys pinned in this
   * build, the authority retired, one device and it is `deviceKey`'s, the encryption key this browser
   * holds, this network's salt. `fresh` after a registration (first entry, nothing signed yet, and
   * empty as deployed: its deploy-time state is read too).
   */
  async checkAccount(
    account: string,
    expect: AccountExpectation,
  ): Promise<{ state: AccountOnChain | null; check: AccountCheck }> {
    const state = await this.account(account);
    if (!state)
      return {
        state: null,
        check: {
          ok: false,
          useCounter: null,
          problems: [{ code: 'not-booted', message: 'There is no account at this address on Midnight (yet).' }],
        },
      };
    // A just-opened account must start empty AS DEPLOYED (R2-6, questions Q42).
    const deployed = expect.fresh ? await this.deployedState(account) : null;
    const check = checkMarketAccount(
      state,
      {
        ...expect,
        networkSalt: this.networkSalt,
        verifierKeys: PINNED_ACCOUNT_KEYS.circuits,
      },
      deployed ?? undefined,
    );
    return { state, check };
  }
}

export { accountCheckText };

/** What the operations use of the chain reader (a test passes a fake). */
export type AccountChain = Pick<
  ChainReader,
  'account' | 'accountState' | 'accountTransactions' | 'checkAccount' | 'networkSalt'
>;
