// Public chain reads the relay serves to the browser: an account's ledger state, its inbox
// ciphertexts (the browser decrypts; the relay never sees the secret) and its Zswap activity
// (the exact positions of its coins' leaves, and its spends). A localnet indexer sends no CORS
// headers, and the relay keeps the parsing of ledger state and ledger events off the browser
// (plan P0.4: the browser bundle carries no ledger-v9).

import type { AccountStateView, InboxPage, UnshieldedBalancesView, ZswapActivity } from '@nightmarket/core';

import { type IndexerClient, ledgerEventDecoder, zswapActivityOf, type EventDecoder } from './indexer.js';

export type { AccountStateView, InboxPage, ZswapActivity };

export interface ChainReader {
  accountState(account: string): Promise<AccountStateView | null>;
  inbox(account: string, from: number, limit: number): Promise<InboxPage | null>;
  zswap(account: string): Promise<ZswapActivity | null>;
  /** The account's public unshielded balances (AA 00047 B3; packages/core/src/unshielded.ts). */
  unshielded(account: string): Promise<UnshieldedBalancesView | null>;
}

export class ChainReadNotImplementedError extends Error {
  override name = 'ChainReadNotImplementedError';
}

/** The relay without a key volume cannot parse account state: reads say so (501). */
export const notImplementedChainReader: ChainReader = {
  async accountState() {
    throw new ChainReadNotImplementedError('account reads need the relay key volume (the compiled account)');
  },
  async inbox() {
    throw new ChainReadNotImplementedError('account reads need the relay key volume (the compiled account)');
  },
  async zswap() {
    throw new ChainReadNotImplementedError('account reads need the relay key volume (the compiled account)');
  },
  async unshielded() {
    throw new ChainReadNotImplementedError('account reads need the relay key volume (the compiled account)');
  },
};

/** The part of a contract's on-chain state the unshielded read uses: its public balances, keyed by
 *  token type (`{ tag: 'unshielded', raw }` for unshielded tokens). */
export interface ContractBalances {
  balance: Map<{ tag: string; raw?: string }, bigint>;
}

/** An account's unshielded balances: one row per unshielded colour with a non-zero balance. */
export function unshieldedBalancesOf(
  account: string,
  state: ContractBalances,
  blockHeight: number,
): UnshieldedBalancesView {
  const balances = [...state.balance.entries()]
    .filter(([t, v]) => t.tag === 'unshielded' && typeof t.raw === 'string' && v > 0n)
    .map(([t, v]) => ({ colour: t.raw!.replace(/^0x/, '').toLowerCase(), amount: v.toString(10) }))
    .sort((a, b) => (a.colour < b.colour ? -1 : a.colour > b.colour ? 1 : 0));
  return { account, balances, blockHeight };
}

/** The fields of an account's ledger this reader uses (the compiled contract's `ledger()`). */
export interface LedgerView {
  readonly booted: boolean;
  readonly device_count: bigint;
  readonly device_epoch: bigint;
  readonly auth_nonce: bigint;
  readonly inbox_count: bigint;
  readonly enc_key: Uint8Array;
  readonly evm_domain_salt: Uint8Array;
  devices: { [Symbol.iterator](): Iterator<Uint8Array> };
  inbox: { member(k: bigint): boolean; lookup(k: bigint): Uint8Array };
}

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

export function accountStateView(account: string, l: LedgerView): AccountStateView {
  return {
    account,
    booted: l.booted,
    deviceCount: Number(l.device_count),
    deviceEpoch: l.device_epoch.toString(10),
    devices: [...l.devices].map(hex).sort(),
    authNonce: l.auth_nonce.toString(10),
    inboxCount: l.inbox_count.toString(10),
    encKey: hex(l.enc_key),
    networkSalt: hex(l.evm_domain_salt),
  };
}

export function inboxPageOf(account: string, l: LedgerView, from: number, limit: number): InboxPage {
  const total = Number(l.inbox_count);
  const entries: Array<string | null> = [];
  for (let i = from; i < Math.min(total, from + limit); i++) {
    const k = BigInt(i);
    entries.push(l.inbox.member(k) ? hex(l.inbox.lookup(k)) : null);
  }
  return { account, from, entries, total };
}

/** Reads over the indexer, parsing state with the compiled account's `ledger()`. */
export class IndexerChainReader implements ChainReader {
  private decoder: Promise<EventDecoder> | null = null;

  constructor(
    private readonly ledgerOf: (account: string) => Promise<LedgerView | null>,
    private readonly indexer: IndexerClient,
    decoder?: EventDecoder,
    /** The contract's on-chain state (for the unshielded balances); absent: the read says 501. */
    private readonly stateOf?: (account: string) => Promise<ContractBalances | null>,
  ) {
    if (decoder) this.decoder = Promise.resolve(decoder);
  }

  async accountState(account: string): Promise<AccountStateView | null> {
    const l = await this.ledgerOf(account);
    return l ? accountStateView(account, l) : null;
  }

  async inbox(account: string, from: number, limit: number): Promise<InboxPage | null> {
    const l = await this.ledgerOf(account);
    return l ? inboxPageOf(account, l, from, limit) : null;
  }

  async zswap(account: string): Promise<ZswapActivity | null> {
    const found = await this.indexer.accountTransactions(account);
    if (!found) return null;
    this.decoder ??= ledgerEventDecoder();
    return zswapActivityOf(account, found.txs, await this.decoder, found.tip);
  }

  /** The nullifiers the account's coins were spent with, over its WHOLE history (AA 00047 P11, audit
   *  round 3 R3-7: a coin is checked unspent before a proof is spent on it), or null when there is no
   *  such contract. */
  async spentNullifiers(account: string): Promise<ReadonlySet<string> | null> {
    const z = await this.zswap(account);
    return z ? new Set(z.inputs.map((i) => i.nullifier.replace(/^0x/, '').toLowerCase())) : null;
  }

  async unshielded(account: string): Promise<UnshieldedBalancesView | null> {
    if (!this.stateOf) throw new ChainReadNotImplementedError('this relay does not read contract balances');
    const [state, tip] = await Promise.all([this.stateOf(account), this.indexer.tip()]);
    return state ? unshieldedBalancesOf(account, state, tip) : null;
  }
}
