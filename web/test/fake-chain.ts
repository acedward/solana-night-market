// A FAKE CHAIN for the browser operations' unit tests (AA 00047 P9.S, P11.B): the `AccountChain` the
// operations read the account from (../src/chain/indexer.ts), over the same state the tests' fake
// relay keeps (`state`, `entries`, `zswapActivity`), so a test sets the account up once. The REAL
// decoding and the REAL market-account check are tested on real serialised states and real stagenet
// transactions in packages/core/test/account-chain.test.ts, web/test/ledger-decode.test.ts,
// web/test/chain-reader.test.ts and in the browser (test/e2e/).
//
// `zswapActivity` here is what the CHAIN holds (the leaves and spends the page decodes from the
// account's history, AA 00047 P11.B), not a relay report. By default the account passes the check and
// the history is complete; a test can make the check fail (`check`), the history incomplete
// (`complete`), hide a leaf or a spend from it (`hidden`), or give a transaction's decoded calls
// (`txCalls` on the source).

import type { AccountHistory, AccountStateView, DecodedAccountTx, DecodedCall, ZswapActivity } from '@nightmarket/core';
import type { AccountCheck } from '@nightmarket/core/passport';

import type { AccountChain, AccountOnChain, AccountExpectation } from '../src/chain/indexer.js';

const PREFIX = Buffer.from('midnight:event[v14]:').toString('hex');

export interface FakeChainSource {
  state: AccountStateView | null;
  entries: Array<string | null>;
  /** The account's leaves and spends on the chain, by transaction. */
  zswapActivity: ZswapActivity;
  unshielded?: Array<{ colour: string; amount: string }>;
  /** The account's credited unshielded amounts (its `unshielded_balances` map). */
  credited?: Array<{ colour: string; amount: string }>;
  /** The decoded contract calls of the account's transactions (a swap's), by hash. */
  txCalls?: Map<string, DecodedCall[]>;
}

/** The decoded history a chain with this activity gives (oldest first, by first appearance). */
export function historyFor(
  account: string,
  activity: ZswapActivity,
  calls: ReadonlyMap<string, readonly DecodedCall[]> = new Map(),
  hidden: ReadonlySet<string> = new Set(),
): DecodedAccountTx[] {
  const byHash = new Map<string, DecodedAccountTx>();
  const tx = (hash: string, blockHeight: number) => {
    const t = byHash.get(hash) ?? { hash, blockHeight, id: byHash.size, entryPoints: [], outputs: [], inputs: [] };
    byHash.set(hash, t);
    return t;
  };
  for (const o of activity.outputs)
    if (!hidden.has(o.commitment))
      tx(o.txHash, o.blockHeight).outputs.push({ commitment: o.commitment, mtIndex: o.mtIndex });
  for (const i of activity.inputs) if (!hidden.has(i.nullifier)) tx(i.txHash, i.blockHeight).inputs.push(i.nullifier);
  for (const [hash, cs] of calls) {
    const t = byHash.get(hash) ?? tx(hash, 1);
    t.entryPoints.push(...cs.filter((c) => c.address === account).map((c) => c.entryPoint));
  }
  return [...byHash.values()];
}

export class FakeChain implements AccountChain {
  /** The check's verdict (default: passes, at the fake signing's counter). */
  check: AccountCheck | null = null;
  /** Whether the history read is complete (default) and the height it covers. */
  complete = true;
  throughHeight = 1_000_000;
  /** Leaves and spends the indexer's history does NOT carry (by commitment or nullifier). */
  readonly hidden = new Set<string>();
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

  async accountHistory(account: string): Promise<AccountHistory> {
    this.reads.push(`history:${account}`);
    return {
      account,
      txs: historyFor(account, this.source.zswapActivity, this.source.txCalls, this.hidden),
      complete: this.complete,
      throughHeight: this.throughHeight,
      ...(this.complete ? {} : { gap: 'the stream was refused' }),
    };
  }

  /**
   * NOT part of the page's chain since AA 00047 P11.B: the pre-P11.B page read the account's
   * transactions as raw events and checked the RELAY's report against them (Q31, Q43). Kept only so
   * the same tests run against that page for the fail-before evidence (plan P11.B (4)).
   */
  async accountTransactions(
    account: string,
  ): Promise<Array<{ hash: string; blockHeight: number; events: Array<{ id: number; raw: string }> }>> {
    this.reads.push(`txs:${account}`);
    const out = new Map<string, { hash: string; blockHeight: number; events: Array<{ id: number; raw: string }> }>();
    let id = 0;
    const add = (txHash: string, blockHeight: number, value: string) => {
      const t = out.get(txHash) ?? { hash: txHash, blockHeight, events: [] };
      if (!this.hidden.has(value)) t.events.push({ id: id++, raw: `${PREFIX}0800${account}${value}00` });
      out.set(txHash, t);
    };
    for (const o of this.source.zswapActivity.outputs) add(o.txHash, o.blockHeight, o.commitment);
    for (const i of this.source.zswapActivity.inputs) add(i.txHash, i.blockHeight, i.nullifier);
    return [...out.values()];
  }

  /** Transactions whose raw bytes the indexer will not serve or that do not decode (AA 00047 P11.F, R4-4). */
  failCalls = new Set<string>();

  async transactionCalls(hash: string): Promise<DecodedCall[] | null> {
    this.reads.push(`calls:${hash}`);
    if (this.failCalls.has(hash)) throw new Error('the indexer did not serve the transaction’s bytes');
    return this.source.txCalls?.get(hash) ?? null;
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
