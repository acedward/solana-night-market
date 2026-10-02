// Whose failure is a take the exchange did not settle? (AA 00047 P11.F, audit round 4 R4-2: F-B4-2,
// F-A4-3.)
//
// Round 3 (R3-7) charged the taker when, after the batcher refused, its coin was spent or its account's
// nonce had moved. Neither says WHICH transaction did it, so an honest taker was charged when
//   - its take had in fact landed (the batcher failed after submitting, or answered without the hash):
//     the take itself spent the coin and moved the nonce;
//   - its OWN offer was taken by someone else at the same moment: that swap moved the nonce, and spent
//     the coin when the offer paid from the same one.
// Now the relay reads the account's decoded history again (its calls' entry points, its coins' leaves
// and spends: ../chain/indexer.ts `accountTxViews`) and judges by the transaction:
//   settled      a transaction holds the take's WANTED coin (its full commitment for this account: the
//                fresh nonce the device signed) and a swap call of the account: the take settled, the
//                job succeeds;
//   raced        the coin was spent, or the nonce first moved after the job started, by ANOTHER swap of
//                the account (its own offer filled): not the taker's doing, never charged;
//   taker        the coin was spent, or the nonce first moved, by a non-swap call of the account (a
//                withdrawal, a cancel, a key change, sent elsewhere): charged, as in round 3;
//   unresolved   the history cannot be read, or shows nothing that explains a spent coin or a moved
//                nonce (the indexer may lag the chain): never the requester's fault;
//   counterparty the coin is unspent and the nonce unmoved: the maker's or the exchange's refusal.

import { SWAP_ENTRY_POINTS, contractCoinCommitment, contractCoinNullifier, type CoinInfo } from '@nightmarket/core';

import type { AccountTxView } from '../chain/indexer.js';
import { ARM_CIRCUITS } from '../passport/arm.js';

export type TakeVerdict =
  | { kind: 'settled'; txHash: string }
  | { kind: 'raced'; txHash: string; by: 'coin' | 'nonce' }
  | { kind: 'taker'; code: 'coin-spent' | 'stale-authorisation'; txHash: string }
  | { kind: 'unresolved'; why: string }
  | { kind: 'counterparty' };

const isSwap = (ep: string) => SWAP_ENTRY_POINTS.includes(ep);

/** The account's calls that move its auth nonce: every gated `_with_ed25519` call but the activation
 *  (the deposits are permissionless and leave it alone). */
export const isNonceMoving = (ep: string): boolean => /_with_ed25519$/.test(ep) && ep !== ARM_CIRCUITS.activate;

export function judgeTake(args: {
  account: string;
  /** What the take paid with, what it wanted (its signed fresh nonce, colour and amount), and the auth
   *  nonce it was signed at. */
  take: { coin: CoinInfo; want: CoinInfo; authNonce: string };
  /** The account's decoded history, read after the refusal. */
  txs: readonly AccountTxView[];
  /** The chain tip the job's pre-proof read covered: only a later transaction can have moved the nonce
   *  during the take (the job checked the nonce when it started). */
  startedAt: number;
  /** The account's auth nonce on chain now (null: not read). */
  ledgerNonce: bigint | null;
}): TakeVerdict {
  const account = args.account.replace(/^0x/, '').toLowerCase();
  const wanted = contractCoinCommitment(args.take.want, account);
  const settled = args.txs.find((t) => t.outputs.includes(wanted) && t.entryPoints.some(isSwap));
  if (settled) return { kind: 'settled', txHash: settled.hash };

  const nullifier = contractCoinNullifier(args.take.coin, account);
  const spender = args.txs.find((t) => t.inputs.includes(nullifier));
  if (spender) {
    if (spender.entryPoints.some(isSwap)) return { kind: 'raced', txHash: spender.hash, by: 'coin' };
    if (spender.entryPoints.some(isNonceMoving)) {
      return { kind: 'taker', code: 'coin-spent', txHash: spender.hash };
    }
    return { kind: 'unresolved', why: 'the transaction that spent the coin shows no call of the account' };
  }

  if (args.ledgerNonce === null) return { kind: 'unresolved', why: "the account's nonce could not be read" };
  if (args.ledgerNonce === BigInt(args.take.authNonce)) return { kind: 'counterparty' };
  const movers = args.txs.filter((t) => t.blockHeight > args.startedAt && t.entryPoints.some(isNonceMoving));
  if (movers.length === 0) return { kind: 'unresolved', why: 'no transaction read yet explains the moved nonce' };
  // The first block that moved it; within one block the order is not known, so a swap there wins.
  const height = Math.min(...movers.map((t) => t.blockHeight));
  const first = movers.filter((t) => t.blockHeight === height);
  const swap = first.find((t) => t.entryPoints.some(isSwap));
  if (swap) return { kind: 'raced', txHash: swap.hash, by: 'nonce' };
  return { kind: 'taker', code: 'stale-authorisation', txHash: first[0]!.hash };
}
