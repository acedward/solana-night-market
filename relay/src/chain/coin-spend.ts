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

import { contractCoinNullifier, type CoinInfo } from '@nightmarket/core';

import { PublicError } from '../queue/jobs.js';

/** What the check reads: the nullifiers of the account's spent coins (null: no such account). */
export interface SpendReader {
  spentNullifiers(account: string): Promise<ReadonlySet<string> | null>;
}

/** Whether `coin` (owned by `account`) is already spent on chain. */
export async function coinSpent(reader: SpendReader, account: string, coin: CoinInfo): Promise<boolean> {
  const spent = await reader.spentNullifiers(account);
  if (!spent) return false;
  return spent.has(contractCoinNullifier(coin, account));
}

/**
 * Refuse a coin that is already spent, BEFORE any proof (`coin-spent`). A read that fails is the
 * market's (`chain-unavailable`, never charged): nothing is proven on a guess.
 */
export async function assertCoinUnspent(reader: SpendReader, account: string, coin: CoinInfo): Promise<void> {
  let spent: boolean;
  try {
    spent = await coinSpent(reader, account, coin);
  } catch (e) {
    throw new PublicError(
      'chain-unavailable',
      `the market could not check on Midnight that the coin is unspent; try again shortly (${e instanceof Error ? e.message.slice(0, 120) : 'read failed'})`,
    );
  }
  if (spent) {
    throw new PublicError(
      'coin-spent',
      'the coin this request spends was already spent on Midnight. Refresh your balances and choose another coin; nothing was proven or sent',
    );
  }
}
