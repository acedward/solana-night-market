// AA 00060 P6.2 / P6.5 (spec US2, FR-004–FR-011): Bridge out, the page's side.
//
//   landingMasterFor  I-5: the wallet signs the landing-key text twice (two prompts); the master must
//                     match the check this browser recorded for earlier transfers ('landing-key-changed')
//   startBridgeOut    keys_t(account, authNonce) → the predicted landing coin → the record (BEFORE the
//                     wallet is asked) → tx1: the account's ordinary sponsored withdrawal of exactly the
//                     amount, to the landing key (`purpose: 'bridge-out'`: the relay's result carries a
//                     single-use landing entitlement); one prompt
//   finishLock        tx2: `lockForSolana(coin, <the wallet's key>)` on the bridge of the coin's colour,
//                     built here with no key material on one block's state (./build.ts), balanced by the
//                     landing coin through the COMPUTED path (@nightmarket/core/bridge/landing-spend:
//                     whatever key tx1 sealed it to; questions Q5 A), checked, and sent UNPROVEN to the
//                     relay's `bridge-out` (it proves: Q2 A, the per-transfer key's witness reaches its
//                     prover only; it adds DUST only and submits); rebuilt when the bridge moved on
//                     (`bridge-out-stale`, a concurrent lock)
//   returnToAccount   the same with `deposit_shielded` into the account: the coin comes back
//   followBridgeOut   the bridge's progress (I-3 `m2s:<id>`) and the release on Solana (the receipt PDA
//                     `["release", id]`, read on the site's Solana RPC)
//   findTransfers     "Find my transfers" with NO stored record (plan Interfaces): every withdrawal of the
//                     account (the page's own decode), its paid-out coin, keys_t for each auth nonce
//                     before the current one; an output of that transaction it owns is a transfer; one the
//                     landing key still holds is open; the relay re-issues its entitlement on indexer
//                     evidence (`bridge-out-entitle`)
//
// SECRETS (tab memory only, wiped when done): the master key (LandingMaster, kept by the caller for the
// session), each transfer's keys_t (cleared at the end of every call here). Nothing secret is stored or
// sent; the unproven tx2 carries the landing coin's spend witness for the relay's prover (Q2 A).

import { formatShieldedAddress, type JobView, type StoredCoin } from '@nightmarket/core';
import {
  m2sTransferId,
  readTransfer,
  transferProgressText,
  type BridgeEntry,
  type LandingMaster,
} from '@nightmarket/core/bridge';
import type { BridgeOutEntitleResult } from '@nightmarket/core/bridge/out';
import { bridgeReleaseReceiptAddress } from '@nightmarket/core/solana';

import {
  CHANGE_PENDING,
  JobFailedError,
  OperationError,
  awaitChange,
  secureChange,
  syncAccount,
  withdrawToWallet,
  type OperationEnv,
} from '../../passport/operations.js';
import { RelayError } from '../../relay/client.js';
import type { SolanaRpc } from '../solana-rpc.js';
import { putBridgeOut, readBridgeOuts, type BridgeOutRecord } from './records.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

const norm = (h: string) => h.replace(/^0x/i, '').toLowerCase();

export interface BridgeOutContext {
  env: OperationEnv;
  /** The site's network name and its Midnight network id. */
  network: string;
  networkId: string;
  indexerUrl: string;
  indexerWsUrl: string;
  /** I-5's fields: the page's origin and I-1's Solana genesis hash. */
  origin: string;
  solanaGenesisHash: string;
  /** The connected wallet (base58) and its key (64 hex): the lock's Solana recipient. */
  wallet: string;
  deviceKey: string;
  rpc?: SolanaRpc;
  fetchImpl?: typeof fetch;
  WebSocketImpl?: typeof WebSocket;
  /** Progress words for the panel (no secrets). */
  onProgress?: (text: string) => void;
  /** A note the customer should read after the flow (AA 00060 P12.2: the change could not be saved yet). */
  onNote?: (text: string) => void;
}

export class BridgeOutError extends OperationError {
  override name = 'BridgeOutError';
}

/** I-5's master for this wallet on this site and network: two prompts; the check must match earlier ones. */
export async function landingMasterFor(ctx: BridgeOutContext, account: string): Promise<LandingMaster> {
  if (!ctx.env.signing.landingMaster) throw new BridgeOutError('This wallet connection cannot derive a landing key.');
  const stored = readBridgeOuts(ctx.env.store, ctx.env.scope, account).find((r) => r.check)?.check ?? null;
  return ctx.env.signing.landingMaster(
    {
      origin: ctx.origin,
      midnightNetwork: ctx.networkId,
      solanaGenesisHash: ctx.solanaGenesisHash,
      walletAddress: ctx.wallet,
    },
    { expect: { siteNetwork: ctx.networkId, rpcGenesisHash: ctx.solanaGenesisHash }, storedCheck: stored },
  );
}

async function landingKeys(master: LandingMaster, account: string, authNonce: string) {
  const { landingKeyFor } = await import('@nightmarket/core/bridge/landing-wallet');
  return landingKeyFor(master, account, BigInt(authNonce));
}

/** What a stopped tx1 record adds (audit C7): its tokens may have moved anyway. */
export const TX1_MAY_HAVE_MOVED =
  'If the tokens left your account anyway, use "Find my transfers": it finds them and lets you finish or return them.';

/** A stopped tx1 record's progress (audit D6: R-B4): the error, cut so that the advice above always fits the
 *  record's 300 characters (an export holding a longer one would not import). */
export function tx1StoppedProgress(e: unknown): string {
  const room = 300 - TX1_MAY_HAVE_MOVED.length - 1;
  const why = (e instanceof Error ? e.message : 'failed').replace(/\s+/g, ' ').trim();
  const cut = why.length > room ? `${why.slice(0, room - 1)}…` : why;
  return `${cut} ${TX1_MAY_HAVE_MOVED}`;
}

/** Whether an entitlement's expiry (its 4th field, unix seconds) has passed (audit D4: R-A4, R-B3). */
export function entitlementExpired(token: string | undefined, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
  if (!token) return false;
  const exp = Number(token.split('.')[3]);
  return Number.isFinite(exp) && exp <= nowSeconds;
}

/**
 * AA 00060 P12.2 (spec FR-021, session finding S-1): a PARTIAL Bridge out's change, saved in the inbox right
 * after tx1, with one more approval, as a withdrawal does (Accounts' send: `awaitChange`, then
 * `secureChange`). The injector and other browsers then see it. Never fails the Bridge out: if the change
 * cannot be saved now, the account's "Save it now" item is the fallback, and the note says so.
 */
async function saveBridgeOutChange(ctx: BridgeOutContext, account: string, change: StoredCoin): Promise<void> {
  try {
    ctx.onProgress?.('Waiting for Midnight to show the change of your withdrawal');
    const outcome = await awaitChange(ctx.env, account, change.commitment);
    if (outcome.state === 'pending') {
      ctx.onNote?.(`${CHANGE_PENDING} Then use "Save it now" under your account.`);
      return;
    }
    if (outcome.state === 'void') {
      ctx.onNote?.('Midnight shows that the withdrawal to your landing key never happened: nothing left your account.');
      return;
    }
    ctx.onProgress?.('Approve saving the change in your inbox in your wallet (one more approval)');
    await secureChange(ctx.env, account, outcome.coin);
    // As Accounts does after saving a change: read the account again, so the page sees the entry.
    await syncAccount(ctx.env, account);
  } catch (e) {
    ctx.onNote?.(
      `The change of this Bridge out is not saved in your inbox yet (${e instanceof Error ? e.message : 'failed'}). It is kept in this browser: use "Save it now" under your account.`,
    );
  }
}

/** tx1: the record first, then ONE approval of the withdrawal to the landing key; for a partial withdrawal,
 *  one more approval to save its change (P12.2, FR-021). */
export async function startBridgeOut(
  ctx: BridgeOutContext,
  master: LandingMaster,
  o: { account: string; entry: BridgeEntry; amount: bigint; coin: StoredCoin },
): Promise<BridgeOutRecord> {
  const { predictLandingCoin, landingCoinCommitment } = await import('@nightmarket/core/bridge/out');
  const state = await ctx.env.chain.accountState(o.account);
  if (!state) throw new BridgeOutError('The account cannot be read on Midnight right now.');
  const n = state.authNonce;
  const keys = await landingKeys(master, o.account, n);
  try {
    const landing = predictLandingCoin(o.coin, o.amount);
    const record: BridgeOutRecord = {
      direction: 'out',
      authNonce: n,
      colour: norm(o.entry.colour),
      symbol: o.entry.symbol,
      amount: o.amount.toString(10),
      bridgeContract: norm(o.entry.bridgeContract),
      bridgeProgram: o.entry.bridgeProgram,
      bridgeApi: o.entry.bridgeApi,
      wallet: ctx.wallet,
      spentCoin: { nonce: norm(o.coin.nonce), color: norm(o.coin.color), value: o.coin.value },
      landingCoinPublicKey: keys.coinPublicKey,
      landingNonce: landing.nonce,
      landingCommitment: landingCoinCommitment(landing, keys.coinPublicKey),
      check: master.check,
      createdAt: Date.now(),
      state: 'tx1-signing',
    };
    const recipient = formatShieldedAddress(
      { coinPublicKey: keys.coinPublicKey, encryptionPublicKey: keys.encryptionPublicKey },
      ctx.network,
    );
    let r = record;
    let change: StoredCoin | null = null;
    try {
      const done = await withdrawToWallet(
        ctx.env,
        o.account,
        { color: o.entry.colour, amount: o.amount, recipient },
        {
          purpose: 'bridge-out',
          coin: o.coin as StoredCoin & { mtIndex: string },
          expectAuthNonce: n,
          onPrepared: () => putBridgeOut(ctx.env.store, ctx.env.scope, o.account, record),
        },
      );
      change = done.change;
      r = {
        ...record,
        state: 'tx1-sent',
        tx1Id: norm(done.txId),
        ...(done.landingEntitlement ? { entitlement: done.landingEntitlement } : {}),
        progress: 'Sent to your landing key',
        checkedAt: Date.now(),
      };
    } catch (e) {
      // Usually refused before or by the market, so nothing paid the landing key (a refused approval
      // writes no record). But an interrupted answer can hide a tx1 that landed (audit C7 / F-B4): the
      // record says so, and "Find my transfers" adopts such a record again when its coin is there.
      if (readBridgeOuts(ctx.env.store, ctx.env.scope, o.account).some((x) => x.authNonce === n)) {
        putBridgeOut(ctx.env.store, ctx.env.scope, o.account, {
          ...record,
          state: 'failed',
          progress: tx1StoppedProgress(e),
          checkedAt: Date.now(),
        });
      }
      throw e;
    }
    putBridgeOut(ctx.env.store, ctx.env.scope, o.account, r);
    // FR-021: a partial withdrawal left change in the account; save it in the inbox now.
    if (change) await saveBridgeOutChange(ctx, o.account, change);
    return r;
  } finally {
    keys.clear();
  }
}

/** keys_t's computed local state, once the landing coin is on chain (waits up to `waitMs`). */
async function computedState(ctx: BridgeOutContext, keys: Any, r: BridgeOutRecord, waitMs = 180_000) {
  const [{ landingLocalState, findLandingCoin }, { readZswapEvents }] = await Promise.all([
    import('@nightmarket/core/bridge/landing-spend'),
    import('./zswap-events.js'),
  ]);
  const coin = { nonce: r.landingNonce, color: r.colour, value: BigInt(r.amount) };
  const until = Date.now() + waitMs;
  for (;;) {
    const events = await readZswapEvents(ctx.indexerWsUrl, {
      timeoutMs: 120_000,
      ...(ctx.WebSocketImpl ? { WebSocketImpl: ctx.WebSocketImpl } : {}),
    });
    const state = landingLocalState(
      keys,
      coin,
      events.map((e) => e.raw),
    );
    if (findLandingCoin(state, coin)) return { state, coin };
    if (Date.now() > until) {
      throw new BridgeOutError('The landing coin is not on Midnight (yet, or no longer): nothing to finish.');
    }
    ctx.onProgress?.('Waiting for Midnight to show the coin at your landing key');
    await new Promise((res) => setTimeout(res, 5_000));
  }
}

/** POST one `bridge-out` and wait for its job; resolves with the result, or throws the relay's code. */
async function sendBridgeOut(
  ctx: BridgeOutContext,
  account: string,
  body: Record<string, unknown>,
): Promise<{ txId: string; withdrawalId?: string }> {
  const job: JobView = await ctx.env.relay.submit('bridge-out', { account, payload: body });
  ctx.env.onJob?.(job);
  const done = await ctx.env.relay.waitForJob(job.requestId, (j) => ctx.env.onJob?.(j));
  if (done.state !== 'succeeded') {
    throw new JobFailedError(done.error?.code ?? 'failed', done.error?.message ?? 'The market could not finish this.');
  }
  return done.result as unknown as { txId: string; withdrawalId?: string };
}

const isStale = (e: unknown) =>
  (e instanceof RelayError && e.code === 'bridge-out-stale') ||
  (e instanceof JobFailedError && e.code === 'bridge-out-stale');

async function secondTransaction(
  ctx: BridgeOutContext,
  master: LandingMaster,
  account: string,
  r: BridgeOutRecord,
  kind: 'lock' | 'return',
): Promise<BridgeOutRecord> {
  if (!r.entitlement) throw new BridgeOutError('This transfer has no entitlement yet: use "Find my transfers".');
  if (entitlementExpired(r.entitlement)) {
    // Audit D4: "Find my transfers" renews it (the market re-issues it from tx1's evidence).
    throw new BridgeOutError('This transfer\'s entitlement has expired: use "Find my transfers" to renew it.');
  }
  const keys = await landingKeys(master, account, r.authNonce);
  try {
    if (keys.coinPublicKey !== r.landingCoinPublicKey) {
      throw new BridgeOutError('This wallet does not hold the landing key of this transfer.');
    }
    const { buildLock, buildReturn, balanceAndCheck } = await import('./build.js');
    const { readChainStates } = await import('./states.js');
    const { landingCoinSecretKeyHex } = await import('@nightmarket/core/bridge/landing-wallet');
    ctx.onProgress?.('Reading your landing key');
    const { state, coin } = await computedState(ctx, keys, r);
    for (let attempt = 1; ; attempt++) {
      const contract = kind === 'lock' ? r.bridgeContract : account;
      const states = await readChainStates(ctx.indexerUrl, contract, ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {});
      if (!states) throw new BridgeOutError('The contract cannot be read on Midnight right now.');
      let draft: Awaited<ReturnType<typeof buildLock>> | Awaited<ReturnType<typeof buildReturn>>;
      if (kind === 'lock') {
        draft = await buildLock({
          networkId: ctx.networkId,
          states,
          bridgeContract: r.bridgeContract,
          colour: r.colour,
          amount: BigInt(r.amount),
          solanaRecipient: ctx.deviceKey,
          keys,
        });
      } else {
        const acc = await ctx.env.chain.accountState(account);
        if (!acc) throw new BridgeOutError('The account cannot be read on Midnight right now.');
        draft = await buildReturn({
          networkId: ctx.networkId,
          states,
          account,
          colour: r.colour,
          amount: BigInt(r.amount),
          accountEncKey: acc.encKey,
          keys,
        });
      }
      const { hex } = await balanceAndCheck({ networkId: ctx.networkId, draft, contract, state, keys, coin });
      // Written BEFORE the market is asked (spec FR-010).
      const sending: BridgeOutRecord = {
        ...r,
        state: kind === 'lock' ? 'tx2-sent' : 'returning',
        ...(kind === 'lock' && 'withdrawalId' in draft ? { withdrawalId: draft.withdrawalId.toString(10) } : {}),
        progress: kind === 'lock' ? 'Sending the lock' : 'Sending the coin back to your account',
        checkedAt: Date.now(),
      };
      putBridgeOut(ctx.env.store, ctx.env.scope, account, sending);
      ctx.onProgress?.(
        kind === 'lock' ? 'The market proves and sends the lock' : 'The market proves and sends the return',
      );
      try {
        const out = await sendBridgeOut(ctx, account, {
          kind,
          entitlement: r.entitlement,
          landing: {
            deviceKey: norm(ctx.deviceKey),
            coinPublicKey: r.landingCoinPublicKey,
            colour: r.colour,
            amount: r.amount,
          },
          tx: hex,
          proven: false,
          blockHash: draft.blockHash,
          // Audit C1: which coin it spends (its public nonce, and the key the witness already carries).
          spend: { nonce: r.landingNonce, coinSecretKey: landingCoinSecretKeyHex(keys) },
        });
        const done: BridgeOutRecord = {
          ...sending,
          state: kind === 'lock' ? 'locked' : 'returned',
          tx2Id: norm(out.txId),
          ...(out.withdrawalId ? { withdrawalId: out.withdrawalId } : {}),
          progress: kind === 'lock' ? 'Locked on Midnight; the bridge releases it on Solana' : 'Back in your account',
          checkedAt: Date.now(),
        };
        putBridgeOut(ctx.env.store, ctx.env.scope, account, done);
        return done;
      } catch (e) {
        // A concurrent lock moved the bridge on: free to retry on the new state (plan T6.5 i).
        if (isStale(e) && attempt < 3) {
          ctx.onProgress?.('The bridge moved on: rebuilding');
          continue;
        }
        putBridgeOut(ctx.env.store, ctx.env.scope, account, {
          ...r,
          progress: e instanceof Error ? e.message.slice(0, 300) : 'failed',
          checkedAt: Date.now(),
        });
        throw e;
      }
    }
  } finally {
    keys.clear();
  }
}

/** tx2: lock the landing coin for the wallet on Solana. */
export const finishLock = (ctx: BridgeOutContext, master: LandingMaster, account: string, r: BridgeOutRecord) =>
  secondTransaction(ctx, master, account, r, 'lock');

/** Return the landing coin to the account (instead of the lock). */
export const returnToAccount = (ctx: BridgeOutContext, master: LandingMaster, account: string, r: BridgeOutRecord) =>
  secondTransaction(ctx, master, account, r, 'return');

/** One step of following a lock: the bridge's progress, and arrival from Solana itself. */
export async function followBridgeOut(
  ctx: Pick<BridgeOutContext, 'rpc' | 'fetchImpl'>,
  r: BridgeOutRecord,
): Promise<BridgeOutRecord> {
  if (r.state !== 'locked' || r.withdrawalId === undefined) return r;
  const id = BigInt(r.withdrawalId);
  if (ctx.rpc) {
    const receipt = await ctx.rpc.accountInfo(bridgeReleaseReceiptAddress(r.bridgeProgram, id)).catch(() => null);
    if (receipt) return { ...r, state: 'arrived', progress: 'In your wallet on Solana', checkedAt: Date.now() };
  }
  const read = await readTransfer(r.bridgeApi, m2sTransferId(id), ctx.fetchImpl).catch(() => null);
  return {
    ...r,
    progress: read ? transferProgressText(read) : "The bridge's progress cannot be read right now",
    checkedAt: Date.now(),
  };
}

/** A transfer "Find my transfers" found from the chain alone. */
export interface FoundTransfer {
  authNonce: string;
  tx1Hash: string;
  spentCoin: { nonce: string; color: string; value: string };
  amount: bigint;
  landingCoinPublicKey: string;
  landingNonce: string;
  landingCommitment: string;
  /** The landing key still holds the coin (by the computed path). */
  open: boolean;
}

const OUTPUTS_QUERY = (hash: string) =>
  `{ transactions(offset: {hash: "${hash}"}) { hash zswapLedgerEvents { raw } } }`;

/** Every Zswap output commitment of a transaction (the public indexer). */
async function txOutputs(ctx: BridgeOutContext, hash: string): Promise<string[]> {
  const f = ctx.fetchImpl ?? fetch;
  const res = await f(ctx.indexerUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: OUTPUTS_QUERY(norm(hash)) }),
  });
  const body = (await res.json()) as { data?: { transactions?: { zswapLedgerEvents: { raw: string }[] }[] } };
  const { decodeEvent } = await import('../../chain/ledger-decode.js');
  const out: string[] = [];
  for (const ev of body.data?.transactions?.[0]?.zswapLedgerEvents ?? []) {
    const d = decodeEvent(ev.raw);
    if (d.kind === 'output') out.push(norm(d.commitment));
  }
  return out;
}

/** "Find my transfers" (plan Interfaces): no stored record needed. */
export async function findTransfers(
  ctx: BridgeOutContext,
  master: LandingMaster,
  account: string,
  o: { maxNonces?: number } = {},
): Promise<FoundTransfer[]> {
  const { predictLandingCoin, landingCoinCommitment } = await import('@nightmarket/core/bridge/out');
  const { landingKeyFor } = await import('@nightmarket/core/bridge/landing-wallet');
  ctx.onProgress?.('Reading your account on Midnight');
  const sync = await syncAccount(ctx.env, account);
  const nonceNow = BigInt(sync.state.authNonce);
  const lowest = nonceNow - BigInt(o.maxNonces ?? 256);
  const found: FoundTransfer[] = [];
  const withdrawals = (sync.history.txs as Any[]).filter((t) =>
    (t.entryPoints ?? []).some((e: string) => /withdraw_shielded/.test(e)),
  );
  for (const tx of withdrawals) {
    const spent = sync.coins.find((c) => c.spent && c.spentTx && norm(c.spentTx) === norm(tx.hash));
    if (!spent) continue;
    // The change this withdrawal left, when this browser knows it (its own record, or the inbox); without
    // it the whole coin was paid (a change never filed in the inbox is a known limitation here).
    const change = sync.coins.find(
      (c) =>
        c.color === spent.color &&
        c.commitment !== spent.commitment &&
        (c.changeOf?.spent === spent.commitment || (c.createdTx !== undefined && norm(c.createdTx) === norm(tx.hash))),
    );
    const amount = change?.changeOf
      ? BigInt(change.changeOf.amount)
      : BigInt(spent.value) - (change ? BigInt(change.value) : 0n);
    if (amount <= 0n) continue;
    const outputs = new Set(await txOutputs(ctx, tx.hash));
    const landing = predictLandingCoin(spent, amount);
    for (let n = nonceNow - 1n; n >= 0n && n >= lowest; n--) {
      const keys = landingKeyFor(master, account, n);
      try {
        const commitment = landingCoinCommitment(landing, keys.coinPublicKey);
        if (!outputs.has(commitment)) continue;
        found.push({
          authNonce: n.toString(10),
          tx1Hash: norm(tx.hash),
          spentCoin: { nonce: norm(spent.nonce), color: norm(spent.color), value: spent.value },
          amount,
          landingCoinPublicKey: keys.coinPublicKey,
          landingNonce: landing.nonce,
          landingCommitment: commitment,
          open: false,
        });
        break;
      } finally {
        keys.clear();
      }
    }
  }
  // Which ones the landing key still holds (the computed path: no wallet SDK, whatever the seal).
  if (found.length > 0) {
    const [{ landingLocalState, findLandingCoin }, { readZswapEvents }] = await Promise.all([
      import('@nightmarket/core/bridge/landing-spend'),
      import('./zswap-events.js'),
    ]);
    ctx.onProgress?.('Checking which of your transfers are still open');
    const events = (
      await readZswapEvents(ctx.indexerWsUrl, {
        timeoutMs: 120_000,
        ...(ctx.WebSocketImpl ? { WebSocketImpl: ctx.WebSocketImpl } : {}),
      })
    ).map((e) => e.raw);
    for (const f of found) {
      const keys = landingKeyFor(master, account, BigInt(f.authNonce));
      try {
        const coin = { nonce: f.landingNonce, color: f.spentCoin.color, value: f.amount };
        f.open = !!findLandingCoin(landingLocalState(keys, coin, events), coin);
      } finally {
        keys.clear();
      }
    }
  }
  return found;
}

/**
 * Which found transfers "Find my transfers" adopts (P10.3, audit C7 / F-B4): every OPEN one whose record
 * this browser lacks, or holds without an entitlement (tx1 landed but its answer was lost), or marked
 * failed or still signing after an interrupted tx1, or (P10.4, audit D4) whose entitlement has EXPIRED.
 * Adopting re-issues the entitlement and overwrites that record. A record with a live entitlement is left
 * alone (its own Finish / Return works).
 */
export function transfersToAdopt<F extends Pick<FoundTransfer, 'authNonce' | 'open'>>(
  found: readonly F[],
  records: readonly Pick<BridgeOutRecord, 'authNonce' | 'state' | 'entitlement'>[],
  nowSeconds = Math.floor(Date.now() / 1000),
): F[] {
  const byNonce = new Map(records.map((r) => [r.authNonce, r]));
  return found.filter((f) => {
    if (!f.open) return false;
    const r = byNonce.get(f.authNonce);
    return (
      !r ||
      !r.entitlement ||
      entitlementExpired(r.entitlement, nowSeconds) ||
      r.state === 'failed' ||
      r.state === 'tx1-signing'
    );
  });
}

/** Re-issue a found transfer's entitlement (`bridge-out-entitle`, indexer evidence) and record it. */
export async function adoptTransfer(
  ctx: BridgeOutContext,
  master: LandingMaster,
  account: string,
  f: FoundTransfer,
  entry: BridgeEntry,
): Promise<BridgeOutRecord> {
  const state = await ctx.env.chain.accountState(account);
  if (!state) throw new BridgeOutError('The account cannot be read on Midnight right now.');
  const counter = ctx.env.signing.useCounter(state, 0n);
  if (counter === null) throw new BridgeOutError('This wallet is not a device of this account.');
  const job = await ctx.env.relay.submit('bridge-out-entitle', {
    account,
    payload: {
      tx1Hash: f.tx1Hash,
      spentCoin: f.spentCoin,
      amount: f.amount.toString(10),
      landingCoinPublicKey: f.landingCoinPublicKey,
      deviceKey: norm(ctx.deviceKey),
      useCounter: counter.toString(10),
    },
  });
  const done = await ctx.env.relay.waitForJob(job.requestId, () => undefined);
  if (done.state !== 'succeeded') {
    throw new JobFailedError(
      done.error?.code ?? 'failed',
      done.error?.message ?? 'The market could not find this transfer.',
    );
  }
  const { landingEntitlement } = done.result as unknown as BridgeOutEntitleResult;
  const r: BridgeOutRecord = {
    direction: 'out',
    authNonce: f.authNonce,
    colour: norm(f.spentCoin.color),
    symbol: entry.symbol,
    amount: f.amount.toString(10),
    bridgeContract: norm(entry.bridgeContract),
    bridgeProgram: entry.bridgeProgram,
    bridgeApi: entry.bridgeApi,
    wallet: ctx.wallet,
    spentCoin: f.spentCoin,
    landingCoinPublicKey: f.landingCoinPublicKey,
    landingNonce: f.landingNonce,
    landingCommitment: f.landingCommitment,
    check: master.check,
    createdAt: Date.now(),
    state: 'landed',
    entitlement: landingEntitlement,
    progress: 'Found again: ready to finish or return',
    checkedAt: Date.now(),
  };
  putBridgeOut(ctx.env.store, ctx.env.scope, account, r);
  return r;
}
/* eslint-enable @typescript-eslint/no-explicit-any */
