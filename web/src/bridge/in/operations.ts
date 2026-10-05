// AA 00060 P7.3 (spec US1, FR-001-FR-003): Bridge in, the page's side.
//
//   precheckBridgeIn  every check of FR-002, BEFORE the wallet is asked: the registry is for these
//                     networks (../registry.ts did it), the mint is a classic SPL Token mint with I-1's
//                     decimals (Token-2022 is refused), the wallet's associated token account holds the
//                     amount, the wallet has SOL for the fee, the recipient is THIS wallet's account as
//                     the page verified it on the public indexer (Q26), and the bridge does not already
//                     say it cannot deliver there (I-3 recognition, beside the page's own check)
//   sendBridgeIn      builds ONE LockToContract (core bridge-in.ts) on a fresh blockhash and asks the
//                     wallet: `signAndSendTransaction`, or `signTransaction` + the page's own send of a
//                     transaction that must come back UNCHANGED and validly signed; the record is
//                     written only once the wallet has signed (a refusal records nothing, T7.8)
//   followBridgeIn    one step: the signature's confirmation, then the lock nonce from the program log
//                     (I-2), then the bridge's progress (I-3 `s2m:<nonce>`); COMPLETION only by the
//                     page's own decode of the account (the coin the bridge says it delivered, or the
//                     balance), never by the bridge's word (FR-003)

import nacl from 'tweetnacl';

import { contractCoinCommitment, formatUnits, holdingsByColour, type StoredCoin } from '@nightmarket/core';
import {
  BridgeInError,
  UNDELIVERABLE_TEXT,
  buildLockToAccount,
  checkLockToAccount,
  lockToAccountFacts,
  readLockNonce,
  readRecipientVerdict,
  readTransfer,
  s2mTransferId,
  transferProgressText,
  type BridgeEntry,
  type LockFacts,
} from '@nightmarket/core/bridge';
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  decodeKey,
  encodeKey,
  splitTransaction,
} from '@nightmarket/core/solana';

import type { TransactionFacts } from '../../wallet/sign-prompt.js';
import type { SolanaTransactions } from '../../wallet/transactions.js';
import type { SolanaRpc } from '../solana-rpc.js';
import type { BridgeInRecord } from './records.js';

/** The Solana fee headroom the wallet must hold: two 5,000-lamport signature fees. */
export const MIN_FEE_LAMPORTS = 10_000n;
const U64_MAX = (1n << 64n) - 1n;

export class BridgeInRefused extends Error {
  override name = 'BridgeInRefused';
}

export interface BridgeInContext {
  rpc: SolanaRpc;
  /** The Wallet Standard chain (`solana:<cluster>`) the wallet is asked to use. */
  chain: string;
  /** The connected wallet (base58). */
  depositor: string;
  /** The wallet's market account (64 hex) and the page's own check of it on the public indexer (Q26):
   *  `ok`, still `pending`, or `failed` (another contract, another device, an unreadable chain). */
  account: string;
  accountCheck: 'ok' | 'pending' | 'failed';
  transactions: SolanaTransactions | null;
  fetchImpl?: typeof fetch;
}

export interface Precheck {
  facts: LockFacts;
  splBalance: bigint;
  lamports: bigint;
  /** A note to show (not a refusal): e.g. the bridge has not indexed the account yet. */
  note: string | null;
}

export async function precheckBridgeIn(ctx: BridgeInContext, entry: BridgeEntry, amount: bigint): Promise<Precheck> {
  const refuse = (m: string): never => {
    throw new BridgeInRefused(m);
  };
  if (!ctx.transactions || (!ctx.transactions.signAndSend && !ctx.transactions.sign)) {
    refuse(
      'Your wallet cannot sign Solana transactions here, so Bridge in is unavailable. Your other actions are not affected.',
    );
  }
  if (ctx.accountCheck === 'failed') {
    refuse("This page's check of your account on Midnight failed, so Bridge in will not send tokens to it.");
  }
  if (ctx.accountCheck !== 'ok') refuse('Bridge in waits until this page has checked your account on Midnight.');
  if (amount <= 0n || amount > U64_MAX) refuse('Enter an amount above zero.');
  const mint = await ctx.rpc.accountInfo(entry.splMint);
  if (!mint) refuse(`The ${entry.symbol} mint does not exist on this Solana network.`);
  if (mint!.owner === TOKEN_2022_PROGRAM_ID) refuse("Token-2022 tokens can't be bridged.");
  if (mint!.owner !== TOKEN_PROGRAM_ID)
    refuse(`${entry.symbol}'s mint is not a classic SPL token, so it can't be bridged.`);
  if (mint!.data.length < 45 || mint!.data[44] !== entry.decimals) {
    refuse(`${entry.symbol}'s mint does not have the decimals this site lists (${entry.decimals}).`);
  }
  const facts = lockToAccountFacts({ entry, depositor: ctx.depositor, amount, account: ctx.account });
  const spl = await ctx.rpc.tokenBalance(facts.source);
  if (spl === null || spl === 0n) refuse(`Your wallet holds no ${entry.symbol} in its token account.`);
  if (spl! < amount) {
    refuse(
      `Your wallet holds only ${formatUnits(spl!, entry.decimals)} ${entry.symbol}, less than the ${formatUnits(amount, entry.decimals)} ${entry.symbol} entered.`,
    );
  }
  const lamports = await ctx.rpc.balance(ctx.depositor);
  if (lamports < MIN_FEE_LAMPORTS) refuse('Your wallet needs a little SOL for the Solana fee (at least 0.00001 SOL).');
  let note: string | null = null;
  try {
    const v = await readRecipientVerdict(entry.bridgeApi, ctx.account, ctx.fetchImpl);
    if (v.verdict === 'undeliverable') {
      refuse(
        `The bridge says it cannot deliver to your account: ${v.code ? UNDELIVERABLE_TEXT[v.code] : (v.message ?? 'no reason given')}`,
      );
    }
    if (v.verdict === 'retry') note = 'The bridge has not read your account yet; it will retry the delivery.';
  } catch (e) {
    if (e instanceof BridgeInRefused) throw e;
    note = "The bridge's own check of your account could not be read; this page's check passed.";
  }
  return { facts, splBalance: spl!, lamports, note };
}

/** The lock's facts for the signing panel while the wallet is open (P5.3). */
export const lockTransactionFacts = (entry: BridgeEntry, f: LockFacts): TransactionFacts => ({
  title: `Lock ${formatUnits(f.amount, entry.decimals)} ${entry.symbol} on Solana for your Night Market account`,
  facts: [
    { label: 'Program', value: f.program, mono: true },
    { label: 'Mint', value: f.mint, mono: true },
    {
      label: 'Amount',
      value: `${f.amount.toString()} base units (${formatUnits(f.amount, entry.decimals)} ${entry.symbol})`,
    },
    { label: 'From your token account', value: f.source, mono: true },
    { label: 'To your Night Market account', value: f.account, mono: true },
    { label: 'Fee payer', value: f.depositor, mono: true },
  ],
});

/** Sends the lock; resolves with the record to keep (state `sent`). Throws before recording anything
 *  when the wallet refuses, fails, or returns another transaction. */
export async function sendBridgeIn(
  ctx: BridgeInContext,
  entry: BridgeEntry,
  amount: bigint,
  balanceBefore: bigint,
  now = Date.now(),
): Promise<BridgeInRecord> {
  const blockhash = await ctx.rpc.latestBlockhash();
  const built = buildLockToAccount({
    entry,
    depositor: ctx.depositor,
    amount,
    account: ctx.account,
    recentBlockhash: blockhash,
  });
  checkLockToAccount(built.transaction, built.facts);
  let signature: string;
  if (ctx.transactions?.signAndSend) {
    signature = encodeKey(
      await ctx.transactions.signAndSend(built.transaction, ctx.chain, lockTransactionFacts(entry, built.facts)),
    );
  } else if (ctx.transactions?.sign) {
    const signed = await ctx.transactions.sign(built.transaction, ctx.chain, lockTransactionFacts(entry, built.facts));
    // The wallet must sign exactly the page's transaction: nothing added, nothing changed.
    try {
      checkLockToAccount(signed, built.facts);
    } catch (e) {
      throw new BridgeInRefused(
        `Your wallet returned another transaction than the lock (${(e as Error).message}). Nothing was sent.`,
      );
    }
    const parts = splitTransaction(signed);
    if (
      parts.signatures.length !== 1 ||
      !nacl.sign.detached.verify(parts.message, parts.signatures[0]!, decodeKey(ctx.depositor)) ||
      encodeKey(parts.message) !== encodeKey(built.message.bytes)
    ) {
      throw new BridgeInRefused('Your wallet returned a transaction the page cannot verify. Nothing was sent.');
    }
    signature = await ctx.rpc.sendTransaction(signed);
  } else {
    throw new BridgeInRefused('Your wallet cannot sign Solana transactions here.');
  }
  return {
    direction: 'in',
    signature,
    colour: entry.colour,
    mint: entry.splMint,
    symbol: entry.symbol,
    amount: amount.toString(10),
    bridgeApi: entry.bridgeApi,
    balanceBefore: balanceBefore.toString(10),
    createdAt: now,
    state: 'sent',
  };
}

const FINAL: ReadonlySet<BridgeInRecord['state']> = new Set(['completed', 'undeliverable', 'failed']);
export const isFinal = (r: BridgeInRecord): boolean => FINAL.has(r.state);

/** The page's balance of a colour by its own decode (confirmed coins only). */
export const pageBalance = (coins: readonly StoredCoin[], colour: string): bigint =>
  holdingsByColour(coins).find((h) => h.color === colour)?.total ?? 0n;

/** One step of following a Bridge-in record; resolves with the updated record (or the same). */
export async function followBridgeIn(
  r: BridgeInRecord,
  ctx: Pick<BridgeInContext, 'rpc' | 'depositor' | 'account' | 'fetchImpl'>,
  pageCoins: () => Promise<readonly StoredCoin[]>,
  now = Date.now(),
): Promise<BridgeInRecord> {
  if (isFinal(r)) return r;
  if (r.state === 'sent') {
    const status = await ctx.rpc.signatureStatus(r.signature);
    if (status === 'failed')
      return { ...r, state: 'failed', progress: 'The Solana transaction failed: nothing was locked.', checkedAt: now };
    if (!status) return { ...r, progress: 'Waiting for Solana to confirm the lock', checkedAt: now };
    const logs = await ctx.rpc.logMessages(r.signature);
    if (!logs) return { ...r, progress: 'Waiting for Solana to confirm the lock', checkedAt: now };
    let nonce: bigint;
    try {
      nonce = readLockNonce(logs, {
        depositor: ctx.depositor,
        mint: r.mint,
        amount: BigInt(r.amount),
        contractHex: ctx.account,
      });
    } catch (e) {
      throw new BridgeInError(`The lock's log does not match what was sent: ${(e as Error).message}`);
    }
    r = { ...r, state: 'locked', lockNonce: nonce.toString(10), progress: 'Locked on Solana', checkedAt: now };
  }
  // The bridge's progress (never its word on completion).
  const read = await readTransfer(r.bridgeApi, s2mTransferId(BigInt(r.lockNonce!)), ctx.fetchImpl).catch(() => null);
  if (read?.kind === 'view' && read.view.status === 'undeliverable') {
    const reason = read.view.reason;
    return {
      ...r,
      state: 'undeliverable',
      progress: transferProgressText(read),
      // The bridge's own words are kept (bounded) for support; the page shows only its plain-words text.
      ...(reason ? { reason: { code: reason.code, message: reason.message.slice(0, 500) } } : {}),
      checkedAt: now,
    };
  }
  const progress = read ? transferProgressText(read) : "The bridge's progress cannot be read right now";
  // Completion: the page's own decode of the account.
  const coins = await pageCoins();
  const delivered = read?.kind === 'view' ? read.view.delivery?.coin : null;
  const coinArrived =
    !!delivered &&
    delivered.colour === r.colour &&
    BigInt(delivered.value) === BigInt(r.amount) &&
    coins.some(
      (c) =>
        !c.pending &&
        c.mtIndex !== null &&
        c.commitment ===
          contractCoinCommitment(
            { nonce: delivered.nonce, color: delivered.colour, value: delivered.value },
            ctx.account,
          ),
    );
  const balanceArrived = pageBalance(coins, r.colour) >= BigInt(r.balanceBefore) + BigInt(r.amount);
  if (coinArrived || balanceArrived) {
    return { ...r, state: 'completed', progress: 'In your account', checkedAt: now };
  }
  return { ...r, state: read?.kind === 'view' ? 'bridging' : r.state, progress, checkedAt: now };
}
