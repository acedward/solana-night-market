// A FAKE CHAIN for the browser operations' unit tests (AA 00047 P9.S): the `AccountChain` the
// operations read the account from (../src/chain/indexer.ts), over the same state the tests' fake
// relay keeps (`state`, `entries`, `zswapActivity`), so a test sets the account up once. The REAL
// decoding and the REAL market-account check are tested on real serialised states in
// packages/core/test/account-chain.test.ts and in the browser (test/e2e/chain.spec.ts).
//
// By default the account passes the check and the indexer's raw events carry everything the relay
// reports; a test can make the check fail (`check`), or the indexer show other transactions (`txs`).

import type { AccountStateView, RawAccountTx, ZswapActivity } from '@nightmarket/core';
import type { AccountCheck } from '@nightmarket/core/passport';

import type { AccountChain, AccountOnChain, AccountExpectation } from '../src/chain/indexer.js';

export interface FakeChainSource {
  state: AccountStateView | null;
  entries: Array<string | null>;
  zswapActivity: ZswapActivity;
  unshielded?: Array<{ colour: string; amount: string }>;
  /** The account's credited unshielded amounts (its `unshielded_balances` map). */
  credited?: Array<{ colour: string; amount: string }>;
}

const PREFIX = Buffer.from('midnight:event[v14]:').toString('hex');

/** The raw events a chain would carry for a Zswap report (the account's address and each value). */
export function rawTxsFor(account: string, activity: ZswapActivity): RawAccountTx[] {
  const byHash = new Map<string, RawAccountTx & { events: Array<{ id: number; raw: string }> }>();
  let id = 0;
  const add = (txHash: string, blockHeight: number, value: string) => {
    const tx = byHash.get(txHash) ?? { hash: txHash, blockHeight, events: [] };
    tx.events.push({ id: id++, raw: `${PREFIX}0800${account}${value}00` });
    byHash.set(txHash, tx);
  };
  for (const o of activity.outputs) add(o.txHash, o.blockHeight, o.commitment);
  for (const i of activity.inputs) add(i.txHash, i.blockHeight, i.nullifier);
  return [...byHash.values()];
}

export class FakeChain implements AccountChain {
  /** The check's verdict (default: passes, at the fake signing's counter). */
  check: AccountCheck | null = null;
  /** What the indexer shows of the account's transactions (default: what the relay reports). */
  txs: RawAccountTx[] | null = null;
  /** Every read, as `kind:account` (to assert where the page read from). */
  readonly reads: string[] = [];
  /** Every expectation the page checked an account against. */
  readonly expectations: AccountExpectation[] = [];

  constructor(private readonly source: FakeChainSource) {}

  get networkSalt(): string {
    return '5a'.repeat(32);
  }

  async account(account: string): Promise<AccountOnChain | null> {
    this.reads.push(`state:${account}`);
    const view = this.source.state;
    if (!view) return null;
    return {
      account,
      view,
      operations: {},
      authority: { committee: 0, threshold: 1 },
      inbox: [...this.source.entries],
      unshielded: this.source.unshielded ?? [],
      credited: this.source.credited ?? [],
      round: '0',
      blockHeight: 9,
    };
  }

  async accountState(account: string): Promise<AccountStateView | null> {
    return (await this.account(account))?.view ?? null;
  }

  /** The transactions the page said it needs (the relay report's, AA 00047 P10 R2-6). */
  readonly needs: string[][] = [];

  async accountTransactions(account: string, need: Iterable<string> = []): Promise<RawAccountTx[]> {
    this.reads.push(`txs:${account}`);
    this.needs.push([...need]);
    return this.txs ?? rawTxsFor(account, this.source.zswapActivity);
  }

  async checkAccount(account: string, expect: AccountExpectation) {
    this.expectations.push(expect);
    const state = await this.account(account);
    return {
      state,
      check: this.check ?? { ok: state !== null, problems: [], useCounter: null },
    };
  }
}
