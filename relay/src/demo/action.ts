// The `demo-tokens` action (spec FR-007, plan B3): its admission check and its executor.
//
// Admission (before any queue slot, security review F-B2 style), after the route verified the
// claim's RelayAction envelope (the Solana scheme: one Phantom prompt, its relay nonce spent):
//   1. the account is an active Night Market account (booted; FR-005: its on-chain verifier keys are
//      the pinned set and its authority is retired);
//   2. the envelope's owner key is a live device of that account (a key cannot send the pack to an
//      account it does not control);
//   3. the claims store reserves the pack: once per Solana key, ever, within the daily cap
//      (./claims.ts). A refusal after this point (a full queue) releases the reservation.
// The executor (prover lane, sponsor wallet held for the whole pack) mints each token of the pack
// into the account (./faucet.ts), confirms the claim with the transaction ids when every token
// landed, and releases it when anything failed, so the key can claim again (faucet tokens cost
// nothing; a token that did land before the failure is simply received twice).

import type { DemoTokenMint, DemoTokenPath, DemoTokensInfo, DemoTokensResult } from '@nightmarket/core';

import type { AdmissionCheck } from '../actions/admission.js';
import type { Logger } from '../log.js';
import type { AccountKeysCheck, DeviceArm } from '../passport/arm.js';
import type { AccountLedger, PassportRuntime } from '../passport/runtime.js';
import type { SponsorWalletHandle } from '../passport/wallet-provider.js';
import { PublicError, type JobExecutor } from '../queue/jobs.js';
import type { SponsorSession } from '../sponsor/session.js';
import type { DemoTokenClaims } from './claims.js';
import type { MintOutcome } from './faucet.js';
import type { ResolvedPackItem } from './pack.js';

/** One token's mint into the account (./faucet.ts `DemoFaucets.direct` / `viaSponsor`). */
export type DemoMint = (o: {
  rt: PassportRuntime;
  wallet: SponsorWalletHandle;
  account: string;
  encKey: Uint8Array;
  item: ResolvedPackItem;
  path: DemoTokenPath;
  stage: (name: string, detail?: Record<string, string>) => void;
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
}

const norm = (h: string | undefined) => (h ?? '').replace(/^0x/, '').toLowerCase();
const unhex = (h: string) => Uint8Array.from(Buffer.from(h, 'hex'));

/** Whether `deviceKey` is a live device of the account: its rolling entry under the account's
 *  epoch is on the ledger at some use counter below `limit` (MIP-0013 S11). */
export async function isDeviceOf(
  arm: DeviceArm,
  rt: PassportRuntime,
  ledger: AccountLedger,
  deviceKey: string,
  account: string,
  limit = 256n,
): Promise<boolean> {
  let entryAt: (account: Uint8Array, epoch: bigint, counter: bigint) => Uint8Array;
  try {
    ({ entryAt } = await arm.registrationDevice(rt, { deviceKey, body: {} }));
  } catch {
    return false; // not a key the arm accepts (not a prime-order point)
  }
  const address = unhex(account);
  for (let k = 0n; k < limit; k++) if (ledger.devices.member(entryAt(address, ledger.device_epoch, k))) return true;
  return false;
}

export function demoTokensInfo(deps: Pick<DemoTokenDeps, 'claims' | 'pack'> & { enabled: boolean; dailyCap: number }) {
  return (owner?: string): DemoTokensInfo => ({
    enabled: deps.enabled,
    pack: deps.pack.map(({ symbol, colour, decimals, amount }) => ({ symbol, colour, decimals, amount })),
    perKey: 1,
    dailyCap: deps.dailyCap,
    remainingToday: deps.claims.remainingToday(),
    ...(owner ? { claimed: deps.claims.hasClaimed(norm(owner)) } : {}),
  });
}

export function demoTokens(deps: DemoTokenDeps): { admit: AdmissionCheck; executor: JobExecutor } {
  /** Reservations admitted and not yet run, by owner key. */
  const reserved = new Map<string, { confirm(txs: string[]): void; release(): void }>();

  const admit: AdmissionCheck = async ({ account: accountRaw, signer }) => {
    const account = norm(accountRaw);
    const owner = norm(signer);
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
    if (!(await isDeviceOf(deps.arm, rt, ledger, owner, account))) {
      return {
        ok: false,
        status: 401,
        code: 'unauthorised',
        reason: 'the signing wallet does not control this account',
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
    if (!r.ok) return { ok: false, status: 429, code: r.code, reason: r.reason };
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
    try {
      const rt = deps.runtime();
      if (!rt) throw new PublicError('not-available', 'the market cannot mint demo tokens right now (no prover keys)');
      const ledger = await rt.ledgerState(account);
      if (!ledger?.booted) throw new PublicError('wrong-account', 'no active account at this address');
      const encKey = Uint8Array.from(ledger.enc_key);
      const minted = await ctx.prove(() =>
        deps.sponsor.withWallet(async (w) => {
          const out: DemoTokenMint[] = [];
          for (const item of deps.pack) {
            ctx.stage('minting', { symbol: item.symbol });
            const txs = await deps.mint({
              rt,
              wallet: w as SponsorWalletHandle,
              account,
              encKey,
              item,
              path: deps.path,
              stage: (name, detail) => ctx.stage(name, detail),
            });
            out.push({ symbol: item.symbol, colour: item.colour, amount: item.amount, txs });
          }
          return out;
        }),
      );
      const txIds = minted.flatMap((m) =>
        Object.values(m.txs).filter((t): t is string => typeof t === 'string' && t !== ''),
      );
      claim.confirm(txIds);
      deps.log.info('demo tokens delivered', { tokens: minted.length, transactions: txIds.length, path: deps.path });
      const result: DemoTokensResult = { account, path: deps.path, minted };
      return result as unknown as Record<string, unknown>;
    } catch (e) {
      claim.release();
      throw e;
    }
  };

  return { admit, executor };
}
