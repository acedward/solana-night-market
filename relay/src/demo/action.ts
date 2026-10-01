// The `demo-tokens` action (spec FR-007, plan B3): its admission check and its executor.
//
// Admission (before any queue slot, security review F-B2 style), after the route verified the
// claim's RelayAction envelope (the Solana scheme: one Phantom prompt, its relay nonce spent):
//   1. the account is an active Night Market account (booted; FR-005: its on-chain verifier keys are
//      the pinned set and its authority is retired);
//   2. the envelope's owner key is a live device of that account AT THE USE COUNTER THE BODY NAMES
//      (AA 00047 P9, audit C8 / F-B10: the one rolling entry derived at that counter must be on the
//      ledger; no scan of counters, which had to stop somewhere and stopped at 255). A key cannot
//      send the pack to an account it does not control;
//   3. the claims store reserves the pack: once per Solana key, ever, within the daily cap, or
//      resumes the key's partial claim (./claims.ts). A refusal after this point (a full queue)
//      releases the reservation.
// The executor (prover lane, sponsor wallet held for the whole pack) mints each token of the pack
// that has not landed yet into the account (./faucet.ts), records each one in the claims store as it
// lands, and confirms the claim when every token landed. When anything fails, the claim stays
// (partial, resumable, its daily charge kept: audit C8 / F-B7), so the key can claim again and get
// only the tokens still missing.
//
// Never twice (AA 00047 P10, audit round 2 R2-7 / F-B2-4): each token is recorded as PENDING, with the
// inbox entry its transaction files, BEFORE the transaction is submitted (the faucet calls back just
// before it submits). A resumed claim first RECONCILES every pending token against the account's
// on-chain inbox: the entry is there → delivered; it is not and the transaction can no longer land →
// minted again; it is not but could still land → the job stops (`demo-tokens-settling`, not counted)
// and nothing is minted; nothing to look for → quarantined (held back for good; an operator decides).

import type { DemoTokenMint, DemoTokenPath, DemoTokensInfo, DemoTokensResult } from '@nightmarket/core';

import type { AdmissionCheck } from '../actions/admission.js';
import type { Logger } from '../log.js';
import type { AccountKeysCheck, DeviceArm } from '../passport/arm.js';
import type { AccountLedger, PassportRuntime } from '../passport/runtime.js';
import type { SponsorWalletHandle } from '../passport/wallet-provider.js';
import { PublicError, type JobExecutor } from '../queue/jobs.js';
import type { SponsorSession } from '../sponsor/session.js';
import type { ClaimHandle, DemoTokenClaims, PendingToken } from './claims.js';
import type { MintOutcome } from './faucet.js';
import type { ResolvedPackItem } from './pack.js';

/** What a mint tells the claim JUST BEFORE it submits a transaction (AA 00047 P10, R2-7): the
 *  stage, the inbox entry the transaction files into the account (when it files one), and the Unix
 *  second after which it can no longer land (its TTL; absent: the relay's settle window). Throwing
 *  here (the claims store cannot write) stops the mint before anything is submitted. */
export type BeforeSubmit = (p: { stage: PendingToken['stage']; entry?: Uint8Array; notAfter?: number }) => void;

/** One token's mint into the account (./faucet.ts `DemoFaucets.direct` / `viaSponsor`). */
export type DemoMint = (o: {
  rt: PassportRuntime;
  wallet: SponsorWalletHandle;
  account: string;
  encKey: Uint8Array;
  item: ResolvedPackItem;
  path: DemoTokenPath;
  stage: (name: string, detail?: Record<string, string>) => void;
  beforeSubmit: BeforeSubmit;
}) => Promise<MintOutcome>;

export interface DemoTokenDeps {
  runtime: () => PassportRuntime | null;
  sponsor: SponsorSession;
  claims: DemoTokenClaims;
  pack: readonly ResolvedPackItem[];
  path: DemoTokenPath;
  /** The device arm: its entry derivation says whether the claim's key is a device of the account. */
  arm: DeviceArm;
  accountKeys?: AccountKeysCheck;
  mint: DemoMint;
  log: Logger;
  /** How long a submission without a known TTL may still land (seconds; default 4 h). */
  pendingSettleSeconds?: number;
  /** Unix seconds now (tests). */
  now?: () => number;
}

/** Seconds past a transaction's TTL before its absence on chain is final (block time, indexer lag). */
const SETTLE_MARGIN_SECONDS = 300;

const hexOf = (b: Uint8Array) => Buffer.from(b).toString('hex');

/**
 * A pending token's fate, read from the account's on-chain inbox (AA 00047 P10, R2-7): `landed` when
 * its entry is there, `not-landed` when it is not and its transaction can no longer land,
 * `settling` when it could still land, `unknowable` when there is no entry to look for.
 */
export async function reconcilePending(
  rt: PassportRuntime,
  account: string,
  pending: PendingToken,
  now: number,
): Promise<'landed' | 'not-landed' | 'settling' | 'unknowable'> {
  if (!pending.entry) return 'unknowable';
  const ledger = await rt.ledgerState(account);
  if (!ledger) throw new PublicError('chain-unavailable', 'the account could not be read to check an earlier delivery');
  const from = /^[0-9]{1,20}$/.test(pending.inboxFrom ?? '') ? BigInt(pending.inboxFrom!) : 0n;
  const start = from <= ledger.inbox_count ? from : 0n;
  for (let k = start; k < ledger.inbox_count; k++) {
    if (ledger.inbox.member(k) && hexOf(ledger.inbox.lookup(k)) === pending.entry) return 'landed';
  }
  return now > pending.notAfter + SETTLE_MARGIN_SECONDS ? 'not-landed' : 'settling';
}

const norm = (h: string | undefined) => (h ?? '').replace(/^0x/, '').toLowerCase();
const unhex = (h: string) => Uint8Array.from(Buffer.from(h, 'hex'));

/** Whether `deviceKey` is a live device of the account at use counter `counter`: its rolling entry
 *  at that counter, under the account's epoch, is on the ledger (MIP-0013 S11). */
export async function isDeviceAt(
  arm: DeviceArm,
  rt: PassportRuntime,
  ledger: AccountLedger,
  deviceKey: string,
  account: string,
  counter: bigint,
): Promise<boolean> {
  let entryAt: (account: Uint8Array, epoch: bigint, counter: bigint) => Uint8Array;
  try {
    ({ entryAt } = await arm.registrationDevice(rt, { deviceKey, body: {} }));
  } catch {
    return false; // not a key the arm accepts (not a prime-order point)
  }
  return ledger.devices.member(entryAt(unhex(account), ledger.device_epoch, counter));
}

export function demoTokensInfo(deps: Pick<DemoTokenDeps, 'claims' | 'pack'> & { enabled: boolean; dailyCap: number }) {
  return (owner?: string): DemoTokensInfo => ({
    enabled: deps.enabled,
    pack: deps.pack.map(({ symbol, colour, decimals, amount }) => ({ symbol, colour, decimals, amount })),
    perKey: 1,
    dailyCap: deps.dailyCap,
    remainingToday: deps.claims.remainingToday(),
    ...(owner ? { claimed: deps.claims.hasClaimed(norm(owner)), resumable: deps.claims.isResumable(norm(owner)) } : {}),
  });
}

/** The 2^64 bound of the account's use counters (Uint<64>). */
const U64_LIMIT = 1n << 64n;

export function demoTokens(deps: DemoTokenDeps): { admit: AdmissionCheck; executor: JobExecutor } {
  /** Reservations admitted and not yet run, by owner key. */
  const reserved = new Map<string, ClaimHandle>();

  const admit: AdmissionCheck = async ({ account: accountRaw, signer, payload }) => {
    const account = norm(accountRaw);
    const owner = norm(signer);
    const counterText = typeof payload.useCounter === 'string' ? payload.useCounter : '';
    const counter = /^[0-9]{1,20}$/.test(counterText) ? BigInt(counterText) : -1n;
    if (counter < 0n || counter >= U64_LIMIT)
      return { ok: false, status: 400, code: 'bad-request', reason: 'the claim must name the device use counter' };
    const rt = deps.runtime();
    if (!rt)
      return { ok: false, status: 503, code: 'not-available', reason: 'the market cannot mint demo tokens right now' };
    const ledger = await rt.ledgerState(account);
    if (!ledger || !ledger.booted)
      return { ok: false, status: 403, code: 'wrong-account', reason: 'no active account at this address' };
    if (deps.accountKeys) {
      const keys = await deps.accountKeys(account);
      if (!keys.ok) return { ok: false, status: 403, code: 'wrong-account', reason: keys.reason };
    }
    if (!(await isDeviceAt(deps.arm, rt, ledger, owner, account, counter))) {
      return {
        ok: false,
        status: 401,
        code: 'unauthorised',
        reason: 'the signing wallet is not a live device of this account at the use counter it names',
        detail: 'wrong-signer',
      };
    }
    if (reserved.has(owner))
      return {
        ok: false,
        status: 429,
        code: 'already-claimed',
        reason: 'this wallet is already receiving its demo tokens',
      };
    const r = deps.claims.reserve(owner, account);
    if (!r.ok) return { ok: false, status: r.code === 'store-unavailable' ? 503 : 429, code: r.code, reason: r.reason };
    reserved.set(owner, r);
    return {
      ok: true,
      release: () => {
        if (reserved.get(owner) === r) reserved.delete(owner);
        r.release();
      },
    };
  };

  const executor: JobExecutor = async (raw, ctx) => {
    const body = raw as { account?: string; signer?: string };
    const account = norm(body.account);
    const owner = norm(body.signer);
    const claim = reserved.get(owner);
    reserved.delete(owner);
    if (!claim) throw new PublicError('not-admitted', 'this demo-token claim was not admitted');
    /** Whether a mint was started: only then does a failure count against the key's attempts. */
    let attempted = false;
    const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
    try {
      const rt = deps.runtime();
      if (!rt) throw new PublicError('not-available', 'the market cannot mint demo tokens right now (no prover keys)');
      const ledger = await rt.ledgerState(account);
      if (!ledger?.booted) throw new PublicError('wrong-account', 'no active account at this address');
      const encKey = Uint8Array.from(ledger.enc_key);

      // An earlier attempt's tokens whose submission is uncertain are reconciled BEFORE anything is
      // minted (AA 00047 P10, R2-7): never mint a token twice.
      const settling: string[] = [];
      for (const [colour, pending] of Object.entries(claim.pending)) {
        const symbol = deps.pack.find((i) => norm(i.colour) === colour)?.symbol ?? colour.slice(0, 8);
        const verdict = await reconcilePending(rt, account, pending, now());
        ctx.stage('reconciled', { symbol, verdict });
        if (verdict === 'landed') claim.settle(colour, { reconciled: true });
        else if (verdict === 'not-landed') claim.settle(colour, null);
        else if (verdict === 'settling') settling.push(symbol);
        else {
          claim.quarantine(colour, 'its delivery was cut off before it could be found on chain');
          deps.log.warn('a demo token was held back (quarantined): its earlier delivery cannot be checked', {
            symbol,
            stage: pending.stage,
          });
        }
      }
      if (settling.length > 0) {
        throw new PublicError(
          'demo-tokens-settling',
          `an earlier delivery of ${settling.join(', ')} may still land; nothing more was minted. Try again in an hour`,
        );
      }

      const already = claim.delivered;
      const held = claim.quarantined;
      const minted = await ctx.prove(() =>
        deps.sponsor.withWallet(async (w) => {
          const out: DemoTokenMint[] = [];
          for (const item of deps.pack) {
            const colour = norm(item.colour);
            const landed = already[colour];
            if (landed) {
              // A resumed claim: this token landed in an earlier attempt; never mint it twice.
              const { reconciled: _r, ...txs } = landed;
              out.push({ symbol: item.symbol, colour: item.colour, amount: item.amount, txs });
              continue;
            }
            if (held[colour]) continue; // quarantined: never minted again by the relay
            ctx.stage('minting', { symbol: item.symbol });
            attempted = true;
            const txs = await deps.mint({
              rt,
              wallet: w as SponsorWalletHandle,
              account,
              encKey,
              item,
              path: deps.path,
              stage: (name, detail) => ctx.stage(name, detail),
              // Written durably BEFORE the transaction is submitted (R2-7); a write that fails throws
              // here, and nothing is submitted.
              beforeSubmit: ({ stage, entry, notAfter }) =>
                claim.submitting(colour, {
                  since: now(),
                  notAfter: notAfter ?? now() + (deps.pendingSettleSeconds ?? 4 * 3600),
                  stage,
                  ...(entry ? { entry: hexOf(entry), inboxFrom: String(ledger.inbox_count) } : {}),
                }),
            });
            // Written before the next token (audit C8 / F-B7): a failure later keeps this one's charge.
            claim.progress(colour, txs);
            out.push({ symbol: item.symbol, colour: item.colour, amount: item.amount, txs });
          }
          return out;
        }),
      );
      const txIds = minted.flatMap((m) =>
        Object.values(m.txs).filter((t): t is string => typeof t === 'string' && t !== ''),
      );
      claim.confirm(txIds);
      const heldBack = deps.pack.filter((i) => held[norm(i.colour)]).map(({ symbol, colour }) => ({ symbol, colour }));
      deps.log.info('demo tokens delivered', {
        tokens: minted.length,
        transactions: txIds.length,
        path: deps.path,
        resumed: claim.resumed,
        held: heldBack.length,
      });
      const result: DemoTokensResult = {
        account,
        path: deps.path,
        minted,
        ...(heldBack.length > 0 ? { held: heldBack } : {}),
      };
      return result as unknown as Record<string, unknown>;
    } catch (e) {
      claim.fail(attempted);
      throw e;
    }
  };

  return { admit, executor };
}
