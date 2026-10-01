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
//     of the account's coins is checked (@nightmarket/core `checkZswapActivity`, Q31).
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

/** The account has a full indexer page of actions or more, and paging is not implemented. */
export class AccountHistoryTooLongError extends ChainReadError {
  override name = 'AccountHistoryTooLongError';
}

const STATE_QUERY = `query AccountState($address: HexEncoded!) {
  contract(address: $address) { state }
  block { height }
}`;

const ACTIONS_QUERY = `query AccountActions($address: HexEncoded!, $limit: Int) {
  contract(address: $address) {
    actions(limit: $limit) {
      transaction { hash block { height } zswapLedgerEvents { id raw } }
    }
  }
}`;

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

  /** The account's public state (what a gated call binds), or null. */
  async accountState(account: string): Promise<AccountStateView | null> {
    return (await this.account(account))?.view ?? null;
  }

  /** The account's transactions with their raw Zswap events (deduplicated, oldest first). */
  async accountTransactions(account: string): Promise<RawAccountTx[]> {
    const address = account.replace(/^0x/, '').toLowerCase();
    const limit = Math.min(this.o.maxActions ?? 500, 500);
    const data = await this.graphql<{
      contract: {
        actions: Array<{
          transaction: {
            hash: string;
            block: { height: number };
            zswapLedgerEvents?: Array<{ id: number; raw: string }>;
          };
        }>;
      } | null;
    }>(ACTIONS_QUERY, { address, limit });
    if (!data.contract) return [];
    if (data.contract.actions.length >= limit)
      throw new AccountHistoryTooLongError(`the account has ${limit} or more actions; paging is not implemented`);
    const byHash = new Map<string, RawAccountTx>();
    for (const a of data.contract.actions) {
      const t = a.transaction;
      if (!byHash.has(t.hash))
        byHash.set(t.hash, { hash: t.hash, blockHeight: t.block.height, events: t.zswapLedgerEvents ?? [] });
    }
    return [...byHash.values()].sort((x, y) => x.blockHeight - y.blockHeight || (x.hash < y.hash ? -1 : 1));
  }

  /**
   * The market-account check (audit C3) on the chain's own state: the verifier keys pinned in this
   * build, the authority retired, one device and it is `deviceKey`'s, the encryption key this browser
   * holds, this network's salt. `fresh` after a registration (first entry, nothing signed yet).
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
    const check = checkMarketAccount(state, {
      ...expect,
      networkSalt: this.networkSalt,
      verifierKeys: PINNED_ACCOUNT_KEYS.circuits,
    });
    return { state, check };
  }
}

export { accountCheckText };

/** What the operations use of the chain reader (a test passes a fake). */
export type AccountChain = Pick<
  ChainReader,
  'account' | 'accountState' | 'accountTransactions' | 'checkAccount' | 'networkSalt'
>;
