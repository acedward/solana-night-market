// Is a coin the account holds still unspent? (AA 00047 P11, audit round 3 R3-7 / F-B3-6.)
//
// A swap or a withdrawal spends one of the account's coins, which the browser names (its nonce,
// colour, value and Merkle position). A coin that was already spent still has a valid membership
// path (old roots are kept), so its proof succeeds and only the chain (or the batcher) refuses it:
// the proof was spent for nothing, and a take's failure was then charged to nobody (its codes are a
// counterparty's). So, before proving, the relay computes the coin's nullifier (a contract-owned
// coin's nullifier depends only on the coin and the account: packages/core `contractCoinNullifier`)
// and refuses a coin whose nullifier the account's history already shows (`coin-spent`, before any
// proof). It reads the WHOLE history (../chain/indexer.ts, past 500 actions: R3-5).
//
// When that read fails (AA 00047 P11.F, audit round 4 R4-5 / F-A4-4: a history streamed for longer than
// the relay waits, or past its 100,000 actions, which a griefer's deposits can cause), a TRADE is
// refused for now (`chain-unavailable`, never charged; it is tried again later), but a WITHDRAWAL goes
// ahead without the check (`withdrawSpendCheck`): the ledger refuses a double spend anyway, and a
// customer's funds must always be able to leave.

import { contractCoinNullifier, type CoinInfo } from '@nightmarket/core';

import type { AccountTxView } from './indexer.js';
import { PublicError } from '../queue/jobs.js';

/** What the check reads: the nullifiers of the account's spent coins (null: no such account). */
export interface SpendReader {
  spentNullifiers(account: string): Promise<ReadonlySet<string> | null>;
  /** The account's whole history, decoded for the account, and the tip it was read at (AA 00047
   *  P11.F, R4-2: how a refused take is reconciled, ../trade/reconcile.ts). Absent: no reconcile. */
  accountTxs?(account: string): Promise<{ txs: readonly AccountTxView[]; tip: number } | null>;
}

/** Whether `coin` (owned by `account`) is already spent on chain. */
export async function coinSpent(reader: SpendReader, account: string, coin: CoinInfo): Promise<boolean> {
  const spent = await reader.spentNullifiers(account);
  if (!spent) return false;
  return spent.has(contractCoinNullifier(coin, account));
}

const coinSpentError = () =>
  new PublicError(
    'coin-spent',
    'the coin this request spends was already spent on Midnight. Refresh your balances and choose another coin; nothing was proven or sent',
  );

const chainUnavailable = (e: unknown) =>
  new PublicError(
    'chain-unavailable',
    `the market could not check on Midnight that the coin is unspent; try again shortly (${e instanceof Error ? e.message.slice(0, 120) : 'read failed'})`,
  );

/**
 * Refuse a coin that is already spent, BEFORE any proof (`coin-spent`). A read that fails is the
 * market's (`chain-unavailable`, never charged): nothing is proven on a guess.
 */
export async function assertCoinUnspent(reader: SpendReader, account: string, coin: CoinInfo): Promise<void> {
  let spent: boolean;
  try {
    spent = await coinSpent(reader, account, coin);
  } catch (e) {
    throw chainUnavailable(e);
  }
  if (spent) throw coinSpentError();
}

/**
 * `assertCoinUnspent` for a take (AA 00047 P11.F, R4-2), from ONE read of the decoded history when the
 * reader gives it: returns the chain tip that read covers (null when the reader gives no history), so
 * that a refusal at settlement can be judged by the transactions that landed AFTER it.
 */
export async function assertCoinUnspentAt(
  reader: SpendReader,
  account: string,
  coin: CoinInfo,
): Promise<number | null> {
  if (!reader.accountTxs) {
    await assertCoinUnspent(reader, account, coin);
    return null;
  }
  let found: { txs: readonly AccountTxView[]; tip: number } | null;
  try {
    found = await reader.accountTxs(account);
  } catch (e) {
    throw chainUnavailable(e);
  }
  if (!found) return null;
  const nullifier = contractCoinNullifier(coin, account);
  if (found.txs.some((t) => t.inputs.includes(nullifier))) throw coinSpentError();
  return found.tip;
}

/**
 * The pre-proof check of a WITHDRAWAL (AA 00047 P11.F, audit round 4 R4-5): a spent coin is still
 * refused before any proof (`coin-spent`), but when the history cannot be read the withdrawal goes
 * ahead unchecked (`'unchecked'`): the ledger refuses a double spend anyway, and funds must always be
 * able to leave, even from an account a griefer has filled with deposits.
 */
export async function withdrawSpendCheck(
  reader: SpendReader,
  account: string,
  coin: CoinInfo,
): Promise<'unspent' | 'unchecked'> {
  let spent: boolean;
  try {
    spent = await coinSpent(reader, account, coin);
  } catch {
    return 'unchecked';
  }
  if (spent) throw coinSpentError();
  return 'unspent';
}
