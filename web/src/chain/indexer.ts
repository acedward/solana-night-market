// The browser's own reader of the chain (AA 00047 P9.S; spec FR-004b; questions Q26 A and Q31): the
// PUBLIC Midnight indexer of the site's network (`network.midnight.indexerUrl`, the stagenet one by
// default), read straight from the page, never through the relay. The relay is trustless: it relays
// signatures, proves and pays, but what the page believes about an account comes from here.
//
// What it reads:
//   - `contract(address) { state }`: the account's serialised ContractState, decoded in the page with
//     the compiled account's `ledger()` (@nightmarket/core/passport `decodeAccountState`). Everything
//     a signature binds (the auth nonce, the device and its use counter, the network salt), the
//     encryption key notes are sealed to, the inbox, the public balances, the verifier keys and the
//     maintenance authority come from it;
//   - the account's COMPLETE history with its ledger events, decoded in the page with ledger-v9
//     (./history.ts, ./ledger-decode.ts; AA 00047 P11.B, questions Q47 A): which of its shielded coins
//     exist (each leaf's exact Merkle position) and which are spent, and the raw bytes of a transaction
//     that may have filled one of its approvals. The newest 500 actions over HTTP; anything older
//     through the indexer's `contractActions` subscription (WebSocket). The relay's report of these is
//     no longer read.
// The stagenet indexer answers any origin (`access-control-allow-origin: *`); a deployment with a
// Content-Security-Policy must allow it in `connect-src`, its WebSocket (`wss:`) endpoint included, and
// allow WebAssembly (`'wasm-unsafe-eval'`) (deploy/RUNBOOK.md §16).

import { type AccountHistory, type AccountStateView, type DecodedCall } from '@nightmarket/core';
import {
  PINNED_ACCOUNT_KEYS,
  accountCheckText,
  checkAccountOrigin,
  checkMarketAccount,
  decodeAccountState,
  networkSaltFor,
  readAccountOrigin,
  type AccountChainState,
  type AccountCheck,
  type MarketAccountExpectation,
  type OriginVerdict,
} from '@nightmarket/core/passport';

import { AccountHistoryReader, type LedgerDecoder } from './history.js';

/** What the page knows to expect of its account (the rest is this build's and this network's).
 *  `deployTx`: the account's deploy transaction as this browser recorded it at opening (the wave-1
 *  hash), read from the chain when the indexer has no deploy record (AA 00047 P11, R3-10). */
export type AccountExpectation = Pick<
  MarketAccountExpectation,
  'deviceKey' | 'encPublicKey' | 'fresh' | 'counterHint'
> & {
  deployTx?: string | null;
};

export class ChainReadError extends Error {
  override name = 'ChainReadError';
}

const STATE_QUERY = `query AccountState($address: HexEncoded!) {
  contract(address: $address) { state }
  block { height }
}`;

export interface ChainReaderOptions {
  indexerUrl: string;
  /** The indexer's WebSocket endpoint (default: derived from `indexerUrl`, `…/ws`). */
  indexerWsUrl?: string;
  /** For tests: the WebSocket class and the ledger decoder. */
  WebSocketImpl?: typeof WebSocket;
  decoder?: () => Promise<LedgerDecoder>;
  /** The Midnight network id (for the network salt every account of this network carries). */
  networkId: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** The most actions read per page (the indexer caps a page at 500). */
  maxActions?: number;
}

/** The indexer's WebSocket endpoint of a network: the profile's when it is the same host as its HTTP
 *  endpoint, else derived from the HTTP endpoint (a `config.json` that moves only `indexerUrl`). */
export function indexerWsUrlOf(midnight: { indexerUrl: string; indexerWsUrl?: string }): string {
  try {
    if (midnight.indexerWsUrl && new URL(midnight.indexerWsUrl).host === new URL(midnight.indexerUrl).host)
      return midnight.indexerWsUrl;
  } catch {
    /* derive it below */
  }
  return indexerWsUrlFor(midnight.indexerUrl);
}

/** The indexer's WebSocket endpoint for its HTTP one: the same host and path, `ws(s):`, `/ws`. */
export function indexerWsUrlFor(indexerUrl: string): string {
  const u = new URL(indexerUrl);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = `${u.pathname.replace(/\/+$/, '')}/ws`;
  return u.toString();
}

/** The account as the chain shows it, at a block height. */
export interface AccountOnChain extends AccountChainState {
  blockHeight: number;
}

export class ChainReader {
  private readonly f: typeof fetch;
  private readonly histories: AccountHistoryReader;
  constructor(private readonly o: ChainReaderOptions) {
    this.f = o.fetchImpl ?? ((input, init) => fetch(input, init));
    this.histories = new AccountHistoryReader({
      graphql: (q, v) => this.graphql(q, v),
      wsUrl: o.indexerWsUrl ?? indexerWsUrlFor(o.indexerUrl),
      ...(o.WebSocketImpl ? { WebSocketImpl: o.WebSocketImpl } : {}),
      ...(o.decoder ? { decoder: o.decoder } : {}),
      ...(o.maxActions !== undefined ? { pageLimit: o.maxActions } : {}),
    });
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

  /**
   * The verdict on the account's ORIGIN (AA 00047 P11, R3-1 / R3-10; @nightmarket/core/passport
   * `readAccountOrigin`, `checkAccountOrigin`): its deploy-time state against the constructor's, run
   * here with this browser's encryption key and this network's salt, and every action of the account
   * before its authority retired. A known verdict never changes (the history before a retirement is
   * final): kept for the page's lifetime. "Not known yet" (no deploy on the indexer) is asked again
   * next time, and never judged on the current state instead.
   */
  async origin(account: string, expect: Pick<AccountExpectation, 'encPublicKey' | 'deployTx'>): Promise<OriginVerdict> {
    const address = account.replace(/^0x/, '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(address)) throw new ChainReadError('That is not an account address.');
    const key = `${address}:${expect.encPublicKey.replace(/^0x/, '').toLowerCase()}`;
    const known = this.origins.get(key);
    if (known) return known;
    const read = await readAccountOrigin((q, v) => this.graphql(q, v), address, { deployTx: expect.deployTx ?? null });
    const verdict = await checkAccountOrigin(read, {
      encPublicKey: expect.encPublicKey,
      networkSalt: this.networkSalt,
      verifierKeys: PINNED_ACCOUNT_KEYS.circuits,
    });
    if (verdict.known) {
      if (this.origins.size >= 256) this.origins.clear();
      this.origins.set(key, verdict);
    }
    return verdict;
  }

  private readonly origins = new Map<string, OriginVerdict>();

  /** The account's public state (what a gated call binds), or null. */
  async accountState(account: string): Promise<AccountStateView | null> {
    return (await this.account(account))?.view ?? null;
  }

  /**
   * The account's COMPLETE history, decoded in this page (AA 00047 P11.B, questions Q47 A): its
   * transactions, oldest first, each with the account's own leaves (exact Merkle positions) and spends
   * from the ledger's events, and the entry points of its calls; `complete` says whether nothing in
   * between was skipped (./history.ts). Never asks the relay.
   */
  async accountHistory(account: string): Promise<AccountHistory> {
    const address = account.replace(/^0x/, '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(address)) throw new ChainReadError('That is not an account address.');
    return this.histories.history(address);
  }

  /** A transaction's contract calls, decoded from its raw bytes, or null when the indexer does not
   *  have it (R3-6: the evidence of a fill). */
  async transactionCalls(hash: string): Promise<DecodedCall[] | null> {
    const h = hash.replace(/^0x/, '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(h)) return null;
    return this.histories.transactionCalls(h);
  }

  /**
   * The market-account check (audit C3) on the chain's own state: the verifier keys pinned in this
   * build, the authority retired, one device and it is `deviceKey`'s, the encryption key this browser
   * holds, this network's salt, the counters far from overflowing, and the account's origin (AA 00047
   * P11, R3-1: the deploy-time state is the constructor's, nothing else wrote before the retirement;
   * read once per page). `fresh` after a registration (first entry, nothing signed yet).
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
    // Where it came from, on every check (R3-1; R2-6's "starts empty", as deployed, is part of it).
    const origin = await this.origin(account, expect);
    const { deployTx: _deployTx, ...rest } = expect;
    const check = checkMarketAccount(
      state,
      {
        ...rest,
        networkSalt: this.networkSalt,
        verifierKeys: PINNED_ACCOUNT_KEYS.circuits,
      },
      origin,
    );
    return { state, check };
  }
}

export { accountCheckText };

/** What the operations use of the chain reader (a test passes a fake). */
export type AccountChain = Pick<
  ChainReader,
  'account' | 'accountState' | 'accountHistory' | 'transactionCalls' | 'checkAccount' | 'networkSalt'
>;
