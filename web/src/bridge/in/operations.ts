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
//                     transaction that must come back UNCHANGED and validly signed. P10.3 (audit C3):
//                     the record is written BEFORE the wallet is asked (`signing`); a wallet that declines
//                     withdraws it (nothing was sent, T7.8); a sign-and-send that times out (or a send
//                     that fails) may still have sent the lock, so the record becomes `unknown`, the page
//                     says so (never "nothing was sent"), keeps the wallet's late answer, and refuses a
//                     new Bridge in of that token until `reconcileBridgeIn` has found the lock on Solana by
//                     its exact message, or its blockhash has expired
//   followBridgeIn    one step: the signature's confirmation, then the lock nonce from the program log
//                     (I-2), then the bridge's progress (I-3 `s2m:<nonce>`); COMPLETION only by the
//                     page's own decode of the account: the coin the bridge says it delivered, matched
//                     by its commitment (P10.3, audit C10: never a balance another coin raised), never
//                     by the bridge's word (FR-003)

import { sha256 } from '@noble/hashes/sha2.js';
import nacl from 'tweetnacl';

import { bytesToHex, contractCoinCommitment, formatUnits, holdingsByColour, type StoredCoin } from '@nightmarket/core';
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
  toBase64,
} from '@nightmarket/core/solana';

import type { TransactionFacts } from '../../wallet/sign-prompt.js';
import type { SolanaTransactions } from '../../wallet/transactions.js';
import { WalletError } from '../../wallet/wallet-errors.js';
import type { SolanaRpc } from '../solana-rpc.js';
import type { BridgeInRecord } from './records.js';

/** The Solana fee headroom the wallet must hold: two 5,000-lamport signature fees. */
export const MIN_FEE_LAMPORTS = 10_000n;
const U64_MAX = (1n << 64n) - 1n;

export class BridgeInRefused extends Error {
  override name = 'BridgeInRefused';
}

/** The words for a lock whose fate is not known yet (audit C3). */
export const BRIDGE_IN_UNKNOWN_TEXT =
  'Your wallet did not answer in time, so the lock may or may not have been sent. If your wallet still shows the request, decline it. This page is checking Solana for the lock: wait until it has before you bridge this token in again.';

/** A lock that may have been sent: its record (`unknown`) is kept and followed (audit C3). */
export class BridgeInUncertain extends Error {
  override name = 'BridgeInUncertain';
  constructor(readonly record: BridgeInRecord) {
    super(BRIDGE_IN_UNKNOWN_TEXT);
  }
}

/** What `sendBridgeIn` reports on the way (audit C3): the record before the wallet is asked, the record
 *  with the wallet's LATE answer (after a timeout), and a record withdrawn because nothing was sent. */
export interface BridgeInHooks {
  onPrepared?(r: BridgeInRecord): void;
  onLate?(r: BridgeInRecord): void;
  onWithdrawn?(r: BridgeInRecord): void;
}

/** Wallet answers after which nothing was sent (the wallet said no, or was never reached). A timeout or an
 *  unknown failure of a sign-and-send is NOT one: the wallet may have sent the lock anyway. */
const nothingSent = (e: unknown) =>
  e instanceof WalletError && ['rejected', 'locked', 'hardware', 'paused', 'unavailable'].includes(e.kind);

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
  hooks: BridgeInHooks = {},
): Promise<BridgeInRecord> {
  if (!ctx.transactions?.signAndSend && !ctx.transactions?.sign) {
    throw new BridgeInRefused('Your wallet cannot sign Solana transactions here.');
  }
  const { blockhash, lastValidBlockHeight, slot } = await ctx.rpc.latestBlockhashInfo();
  const built = buildLockToAccount({
    entry,
    depositor: ctx.depositor,
    amount,
    account: ctx.account,
    recentBlockhash: blockhash,
  });
  checkLockToAccount(built.transaction, built.facts);
  const message = built.message.bytes;
  // Audit C3: the record exists BEFORE the wallet is asked.
  const pending: BridgeInRecord = {
    direction: 'in',
    key: bytesToHex(sha256(message)),
    message: toBase64(message),
    lastValidBlockHeight: lastValidBlockHeight.toString(10),
    fromSlot: slot.toString(10),
    source: built.facts.source,
    colour: entry.colour,
    mint: entry.splMint,
    symbol: entry.symbol,
    amount: amount.toString(10),
    bridgeApi: entry.bridgeApi,
    balanceBefore: balanceBefore.toString(10),
    createdAt: now,
    state: 'signing',
  };
  hooks.onPrepared?.(pending);
  const uncertain = (signature?: string) =>
    new BridgeInUncertain({
      ...pending,
      ...(signature ? { signature } : {}),
      state: 'unknown',
      progress: 'Checking Solana for the lock',
      checkedAt: now,
    });
  let signature: string;
  if (ctx.transactions.signAndSend) {
    try {
      signature = encodeKey(
        await ctx.transactions.signAndSend(built.transaction, ctx.chain, lockTransactionFacts(entry, built.facts)),
      );
    } catch (e) {
      if (nothingSent(e)) {
        hooks.onWithdrawn?.(pending);
        throw e;
      }
      // The wallet may still send it, or may have: keep its late answer.
      const late = (e as { late?: Promise<Uint8Array> } | null)?.late;
      if (late) {
        void late.then(
          (sig) => hooks.onLate?.({ ...pending, signature: encodeKey(sig), state: 'sent', checkedAt: Date.now() }),
          () => undefined,
        );
      }
      throw uncertain();
    }
  } else {
    let signed: Uint8Array;
    try {
      signed = await ctx.transactions.sign!(built.transaction, ctx.chain, lockTransactionFacts(entry, built.facts));
    } catch (e) {
      // signTransaction never sends: whatever the wallet does later, the page sends nothing.
      hooks.onWithdrawn?.(pending);
      if (e instanceof WalletError && e.kind === 'timeout')
        throw new WalletError(
          'timeout',
          `${e.message} Nothing was sent: this page sends the lock itself, and it has not.`,
        );
      throw e;
    }
    // The wallet must sign exactly the page's transaction: nothing added, nothing changed.
    try {
      checkLockToAccount(signed, built.facts);
    } catch (e) {
      hooks.onWithdrawn?.(pending);
      throw new BridgeInRefused(
        `Your wallet returned another transaction than the lock (${(e as Error).message}). Nothing was sent.`,
      );
    }
    const parts = splitTransaction(signed);
    if (
      parts.signatures.length !== 1 ||
      !nacl.sign.detached.verify(parts.message, parts.signatures[0]!, decodeKey(ctx.depositor)) ||
      encodeKey(parts.message) !== encodeKey(message)
    ) {
      hooks.onWithdrawn?.(pending);
      throw new BridgeInRefused('Your wallet returned a transaction the page cannot verify. Nothing was sent.');
    }
    try {
      signature = await ctx.rpc.sendTransaction(signed);
    } catch {
      // The RPC may have taken it before the error: its signature is known, so look for it.
      throw uncertain(encodeKey(parts.signatures[0]!));
    }
  }
  return { ...pending, signature, state: 'sent' };
}

/** Whether a new Bridge in of `colour` must wait: an earlier lock of it may have been sent (audit C3). */
export const blocksNewBridgeIn = (records: readonly BridgeInRecord[], colour: string): boolean =>
  records.some((r) => r.colour === colour && (r.state === 'signing' || r.state === 'unknown'));

/** How far back one look searches the source token account's transactions (pages of 100). */
export const BRIDGE_IN_SEARCH_PAGES = 10;

/**
 * One look on Solana for a lock whose wallet answer was lost (audit C3): by its signature when known, else
 * among the source token account's transactions back to the slot its blockhash was read at, by its exact
 * message. Found: `sent` (then followed as usual). Not found, the search complete, and its blockhash
 * already expired (read FIRST, so a lock that lands later cannot be missed): `failed`, nothing was locked.
 * Otherwise still `unknown` (a search cut short never says "nothing was locked").
 */
export async function reconcileBridgeIn(
  r: BridgeInRecord,
  ctx: Pick<BridgeInContext, 'rpc'>,
  now = Date.now(),
): Promise<BridgeInRecord> {
  if (r.state !== 'signing' && r.state !== 'unknown') return r;
  const height = r.lastValidBlockHeight ? await ctx.rpc.blockHeight() : null;
  if (r.signature && (await ctx.rpc.signatureStatus(r.signature))) {
    return { ...r, state: 'sent', progress: 'Found on Solana', checkedAt: now };
  }
  let complete = !r.message || !r.source;
  if (r.message && r.source) {
    const from = r.fromSlot ? BigInt(r.fromSlot) : null;
    let before: string | undefined;
    search: for (let page = 0; page < BRIDGE_IN_SEARCH_PAGES; page++) {
      const sigs = await ctx.rpc.signaturesForAddress(r.source, 100, before);
      for (const { signature, slot } of sigs) {
        if (from !== null && slot < from) {
          complete = true;
          break search;
        }
        const wire = await ctx.rpc.transactionWire(signature).catch(() => null);
        if (!wire) continue;
        let sent: Uint8Array;
        try {
          sent = splitTransaction(wire).message;
        } catch {
          continue;
        }
        if (toBase64(sent) === r.message)
          return { ...r, signature, state: 'sent', progress: 'Found on Solana', checkedAt: now };
      }
      if (sigs.length < 100) {
        complete = true;
        break;
      }
      before = sigs[sigs.length - 1]!.signature;
    }
  }
  if (complete && height !== null && height > BigInt(r.lastValidBlockHeight!)) {
    return {
      ...r,
      state: 'failed',
      progress: "Not sent: your wallet's request expired before it reached Solana. Nothing was locked.",
      checkedAt: now,
    };
  }
  return { ...r, state: 'unknown', progress: 'Checking Solana for the lock', checkedAt: now };
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
  if (r.state === 'signing' || r.state === 'unknown') return reconcileBridgeIn(r, ctx, now);
  if (r.state === 'sent' && r.signature) {
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
  // Audit C10 (F-A7): ONLY the delivered coin completes the lock; a balance that another coin of the
  // token raised (a second Bridge in, a trade) says nothing about this one.
  if (coinArrived) {
    return { ...r, state: 'completed', progress: 'In your account', checkedAt: now };
  }
  return { ...r, state: read?.kind === 'view' ? 'bridging' : r.state, progress, checkedAt: now };
}
