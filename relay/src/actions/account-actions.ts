// The account executors (plan L-ACC): register, withdraw, withdraw-unshielded (AA 00047 B3),
// append-inbox, cancel-offers (AA 00047 P9.I, questions Q30) and restore-enc-key (AA 00047 P10, R2-3).
//
// Every one runs on the prover lane (one proof at a time), pays its DUST from the sponsor wallet,
// keeps the call's private state (the coin a spend consumes) in a per-job in-memory store that is
// wiped when the job ends, and returns only public data (addresses, transaction ids, the change
// coin the browser must keep). Nothing about the customer is written anywhere (Q5).

import {
  RegisterPayloadSchema,
  checkRelayActionBinding,
  type AppendInboxResult,
  type CancelOffersResult,
  type RegisterResult,
  type RestoreEncKeyResult,
  type RelayActionScheme,
  type SignedRelayAction,
  type WithdrawResult,
  type WithdrawUnshieldedResult,
} from '@nightmarket/core';

import type { DigestReplayGuard } from '../auth/verifiers.js';
import type { AppendEntitlements } from './entitlements.js';
import type { Logger } from '../log.js';
import type { DeviceArm, GatedAction } from '../passport/arm.js';
import { MemoryPrivateStateProvider } from '../passport/private-state.js';
import type { PassportRuntime } from '../passport/runtime.js';
import type { SponsorWalletHandle } from '../passport/wallet-provider.js';
import { PublicError, type JobContext, type JobExecutor } from '../queue/jobs.js';
import type { SponsorSession } from '../sponsor/session.js';

export interface AccountActionDeps {
  /** The Passport runtime, or null when the relay has no key volume. */
  runtime: () => PassportRuntime | null;
  /** The device arm (../passport/arm.ts): how calls are checked and devices enrolled. */
  arm: DeviceArm;
  /** The relay envelope's signature scheme (F-B6 re-checks it); absent until lane B3 wires it. */
  scheme?: RelayActionScheme;
  sponsor: SponsorSession;
  /** The Midnight network name a RelayAction envelope must name (security review F-B6). */
  network: string;
  /** F-B6's second signature for a withdrawal's recipient encryption key (questions Q13; the
   *  deployment's RELAY_WITHDRAW_RECIPIENT_ENVELOPE, off by default: one prompt per action). */
  withdrawRecipientEnvelope?: boolean;
  replay: DigestReplayGuard;
  /** Issues and checks the single-use entitlements `append-inbox` needs (security review F-B3). */
  entitlements: AppendEntitlements;
  log: Logger;
}

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const unhex = (h: string) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ''), 'hex'));
const secondsSince = (t: number) => Math.round((Date.now() - t) / 100) / 10;

function needRuntime(deps: AccountActionDeps): PassportRuntime {
  const rt = deps.runtime();
  if (!rt)
    throw new PublicError('not-available', 'the market cannot run account operations right now (no prover keys)');
  return rt;
}

const txIdOf = (r: unknown): string => {
  const p = (r as { public?: { txId?: unknown; transactionHash?: unknown } } | null)?.public;
  return String(p?.txId ?? p?.transactionHash ?? '');
};

// ── register ──────────────────────────────────────────────────────────────────

/**
 * Deploy wave 1 and wave 2 (the account shape: the device arm and the offer circuit; authority
 * retired) and activate the device the registration enrols (the arm builds it from the verified
 * registration: its device key, the Solana wallet's). Returns the account's address and every
 * transaction.
 */
export function registerExecutor(deps: AccountActionDeps): JobExecutor {
  return async (raw, ctx) => {
    const body = raw as { encPublicKey?: unknown; auth?: SignedRelayAction; signer?: string };
    const parsed = RegisterPayloadSchema.safeParse({ encPublicKey: body.encPublicKey });
    if (!parsed.success || !body.auth || !body.signer)
      throw new PublicError('bad-request', 'the registration is malformed');
    const rt = needRuntime(deps);
    const encPublicKey = unhex(parsed.data.encPublicKey);
    const signer = body.signer.toLowerCase();
    const { device, entryAt } = await deps.arm.registrationDevice(rt, {
      deviceKey: signer,
      body: raw as Record<string, unknown>,
    });

    return ctx.prove(() =>
      deps.sponsor.withWallet(async (w) => {
        const privateState = new MemoryPrivateStateProvider();
        try {
          const providers = await rt.providers(w as SponsorWalletHandle, privateState);
          const submitted = providers.walletProvider.submitted;
          const labels = ['wave-1-submitted', 'wave-2-submitted', 'activation-submitted'];
          const originalSubmit = providers.walletProvider.submitTx.bind(providers.walletProvider);
          providers.walletProvider.submitTx = async (tx: unknown) => {
            const id = await originalSubmit(tx);
            const label = labels[submitted.length - 1] ?? 'submitted';
            ctx.stage(label, { tx: id });
            return id;
          };
          const t0 = Date.now();
          ctx.stage('deploying');
          const waves = rt.client.shape.accountWaves();
          const dormant = await rt.client.account.CustodyAccount.deployDormant(
            providers,
            rt.compiledAccount(),
            device as never,
            { publicKey: encPublicKey, secretKey: undefined },
            {
              waveOneCircuits: waves.waveOne,
              waveTwoCircuits: waves.waveTwo,
              armsInWaveTwo: [],
              retireAuthority: true,
            },
          );
          const tDeployed = Date.now();
          ctx.stage('deployed', { account: dormant.address });
          ctx.stage('activating', { account: dormant.address });
          const activation = await dormant.activate(device as never, dormant.salt);
          const tActivated = Date.now();
          const account = String(dormant.address).replace(/^0x/, '').toLowerCase();

          // Read back what the customer relies on.
          const l = await rt.ledgerState(account);
          const ok =
            !!l &&
            l.booted === true &&
            l.device_count === 1n &&
            hex(l.enc_key) === hex(encPublicKey) &&
            l.devices.member(entryAt(unhex(account), l.device_epoch, 0n));
          if (!ok)
            throw new PublicError('register-mismatch', 'the account was created but does not read back as expected');
          ctx.stage('activated', { account, tx: txIdOf(activation) });

          const result: RegisterResult = {
            account,
            device: signer,
            txs: {
              waveOne: submitted[0]?.txId ?? '',
              waveTwo: submitted[1]?.txId ?? '',
              activation: txIdOf(activation) || (submitted[2]?.txId ?? ''),
            },
            seconds: {
              waveOne: submitted[0] ? Math.round((submitted[0].at - t0) / 100) / 10 : 0,
              waveTwo: submitted[1] && submitted[0] ? Math.round((submitted[1].at - submitted[0].at) / 100) / 10 : 0,
              activation: Math.round((tActivated - tDeployed) / 100) / 10,
              total: secondsSince(t0),
            },
          };
          return result as unknown as Record<string, unknown>;
        } finally {
          privateState.wipe();
        }
      }),
    );
  };
}

// ── gated calls ────────────────────────────────────────────────────────────────

async function recheck<A extends GatedAction>(deps: AccountActionDeps, action: A, raw: unknown, ctx: JobContext) {
  const rt = needRuntime(deps);
  const body = raw as { account?: string; passportAuth?: unknown };
  const { account: _a, passportAuth: _p, signer: _s, auth: _auth, ...payload } = raw as Record<string, unknown>;
  const check = await deps.arm.checkGatedCall(rt, action, body.account, payload, body.passportAuth);
  if (!check.ok) {
    ctx.log.info('gated call no longer valid at run time', { code: check.code });
    throw new PublicError(check.code === 'expired' ? 'stale-authorisation' : 'unauthorised', check.reason);
  }
  return { rt, check };
}

/** Run a gated call's proof and submission; release the replay guard if it fails. */
async function runGated<T>(deps: AccountActionDeps, digestHex: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    deps.replay.release(digestHex);
    throw e;
  }
}

/** The circuit's declared result, from the call result's private part (the reference client's
 *  `changeOf`): `Maybe<ShieldedCoinInfo>`, the change coin. */
function changeOf(r: unknown): unknown {
  const p = (r as { private?: { result?: unknown } } | null)?.private;
  const v = p?.result as { is_some?: boolean; value?: unknown } | undefined;
  return v && v.is_some ? v.value : null;
}

/**
 * The same call, for a recipient that is not the paying (sponsor) wallet: midnight-js must seal
 * the coin's ciphertext to the recipient's encryption key, which only a contract-scoped
 * transaction's `additionalCoinEncPublicKeyMappings` supplies (the `callTx(...)` shortcut cannot).
 */
async function withdrawToThirdParty(
  custody: { callTx: Record<string, (...a: unknown[]) => Promise<unknown>> },
  providers: unknown,
  circuit: string,
  recipientHex: string,
  encryptionKeyHex: string,
  args: unknown[],
): Promise<{ txId: string; change: unknown }> {
  const { withContractScopedTransaction } = await import('@midnight-ntwrk/midnight-js-contracts');
  let inner: unknown = null;
  const run = withContractScopedTransaction as unknown as (
    p: unknown,
    fn: (txCtx: unknown) => Promise<void>,
    o: unknown,
  ) => Promise<{ public?: { txId?: string } }>;
  const finalized = await run(
    providers,
    async (txCtx) => {
      inner = await custody.callTx[circuit]!(txCtx, ...args);
    },
    {
      scopeName: circuit,
      additionalCoinEncPublicKeyMappings: new Map([
        [recipientHex.replace(/^0x/, '').toLowerCase(), encryptionKeyHex.replace(/^0x/, '').toLowerCase()],
      ]),
    },
  );
  return { txId: String(finalized?.public?.txId ?? ''), change: changeOf(inner) ?? changeOf(finalized) };
}

/** The arm's `withdraw_shielded`: one coin (the browser's choice) pays `amount` to a shielded
 *  wallet; the change comes back as the circuit's result (it has no inbox entry: Q13). */
export function withdrawExecutor(deps: AccountActionDeps): JobExecutor {
  return async (raw, ctx) => {
    const { rt, check } = await recheck(deps, 'withdraw', raw, ctx);
    const p = check.payload;
    if (p.recipientEncryptionKey && deps.withdrawRecipientEnvelope) {
      // Security review F-B6 (when the deployment turns it on, Q13): the encryption key the coin is
      // sealed to must be the one the device signed in the route's RelayAction envelope (the
      // contract's challenge does not cover it).
      const { account: _a, passportAuth: _p, signer: _s, auth, ...body } = raw as Record<string, unknown>;
      const envelope = checkRelayActionBinding(auth, {
        expectedAction: 'withdraw',
        network: deps.network,
        expectedAccount: check.account,
        payload: body,
        ...(deps.scheme ? { scheme: deps.scheme } : {}),
      });
      if (!envelope.ok || envelope.signer.toLowerCase() !== check.signer.toLowerCase()) {
        deps.replay.release(check.digestHex);
        throw new PublicError('unauthorised', "the recipient is not the one the device's relay envelope names");
      }
    }
    return runGated(deps, check.digestHex, () =>
      ctx.prove(() =>
        deps.sponsor.withWallet(async (w) => {
          const privateState = new MemoryPrivateStateProvider();
          try {
            const providers = await rt.providers(w as SponsorWalletHandle, privateState);
            const { account: accountMod, witnesses } = rt.client;
            const coin = {
              nonce: unhex(p.coin.nonce),
              color: unhex(p.coin.color),
              value: BigInt(p.coin.value),
              mtIndex: BigInt(p.coin.mtIndex),
            };
            const custody = await accountMod.CustodyAccount.connect(
              providers,
              rt.compiledAccount(),
              check.account,
              witnesses.withCoin(witnesses.emptyCoinStore(), coin),
            );
            ctx.stage('proving', { circuit: deps.arm.circuits.withdrawShielded });
            const out = p.recipientEncryptionKey
              ? await withdrawToThirdParty(
                  custody,
                  providers,
                  deps.arm.circuits.withdrawShielded,
                  p.recipient,
                  p.recipientEncryptionKey,
                  [{ bytes: unhex(p.recipient) }, unhex(p.color), BigInt(p.amount), ...deps.arm.authArgs(check.auth)],
                )
              : await custody.withdrawShieldedWithAuth(
                  unhex(p.recipient),
                  unhex(p.color),
                  BigInt(p.amount),
                  check.auth,
                );
            ctx.stage('submitted', { tx: String(out.txId) });
            const change = out.change as { nonce: Uint8Array; color: Uint8Array; value: bigint } | null;
            const result: WithdrawResult = {
              txId: String(out.txId),
              change: change
                ? { nonce: hex(change.nonce), color: hex(change.color), value: change.value.toString(10) }
                : null,
              // The change has no inbox entry: the market will pay for filing ONE (F-B3).
              ...(change
                ? { changeEntitlement: deps.entitlements.issue(check.account, `withdraw:${String(out.txId)}`) }
                : {}),
            };
            return result as unknown as Record<string, unknown>;
          } finally {
            privateState.wipe();
          }
        }),
      ),
    );
  };
}

/** The arm's `withdraw_unshielded` (AA 00047 B3): pay `amount` of an unshielded colour the account
 *  holds to a user address. No coin (unshielded balances are public), no change, no inbox entry. */
export function withdrawUnshieldedExecutor(deps: AccountActionDeps): JobExecutor {
  return async (raw, ctx) => {
    const { rt, check } = await recheck(deps, 'withdraw-unshielded', raw, ctx);
    const p = check.payload;
    return runGated(deps, check.digestHex, () =>
      ctx.prove(() =>
        deps.sponsor.withWallet(async (w) => {
          const privateState = new MemoryPrivateStateProvider();
          try {
            const providers = await rt.providers(w as SponsorWalletHandle, privateState);
            const custody = await rt.client.account.CustodyAccount.connect(
              providers,
              rt.compiledAccount(),
              check.account,
              rt.client.witnesses.emptyCoinStore(),
            );
            ctx.stage('proving', { circuit: deps.arm.circuits.withdrawUnshielded });
            const out = await custody.withdrawUnshieldedWithAuth(
              unhex(p.color),
              BigInt(p.amount),
              unhex(p.recipient),
              check.auth,
            );
            ctx.stage('submitted', { tx: String(out.txId) });
            const result: WithdrawUnshieldedResult = { txId: String(out.txId) };
            return result as unknown as Record<string, unknown>;
          } finally {
            privateState.wipe();
          }
        }),
      ),
    );
  };
}

/** The arm's `append_inbox`: file one 192-byte entry (Q13: a withdrawal's change, sealed by the
 *  browser to the account's own public key), only against the single-use entitlement the market
 *  issued for that change (security review F-B3): checked at admission and again here; spent when
 *  the append lands, released when it fails. */
export function appendInboxExecutor(deps: AccountActionDeps): JobExecutor {
  return async (raw, ctx) => {
    const token = (raw as { entitlement?: unknown } | null)?.entitlement;
    try {
      const out = await appendInbox(deps, raw, ctx);
      deps.entitlements.spend(token);
      return out;
    } catch (e) {
      deps.entitlements.release(token);
      throw e;
    }
  };
}

async function appendInbox(deps: AccountActionDeps, raw: unknown, ctx: JobContext): Promise<Record<string, unknown>> {
  const { rt, check } = await recheck(deps, 'append-inbox', raw, ctx);
  const p = check.payload;
  const ent = deps.entitlements.verify(p.entitlement, check.account);
  if (!ent.ok) throw new PublicError('no-entitlement', ent.reason);
  return runGated(deps, check.digestHex, () =>
    ctx.prove(() =>
      deps.sponsor.withWallet(async (w) => {
        const privateState = new MemoryPrivateStateProvider();
        try {
          const providers = await rt.providers(w as SponsorWalletHandle, privateState);
          const custody = await rt.client.account.CustodyAccount.connect(
            providers,
            rt.compiledAccount(),
            check.account,
            rt.client.witnesses.emptyCoinStore(),
          );
          ctx.stage('proving', { circuit: deps.arm.circuits.appendInbox });
          const out = await custody.appendInboxWithAuth(unhex(p.entry), check.auth);
          ctx.stage('submitted', { tx: String(out.txId) });
          const result: AppendInboxResult = { txId: String(out.txId) };
          return result as unknown as Record<string, unknown>;
        } finally {
          privateState.wipe();
        }
      }),
    ),
  );
}

/**
 * "Cancel all open offers" (AA 00047 P9.I; questions Q30, audit C6): the arm's
 * `rotate_enc_key_with_ed25519` with `newKey` = the account's CURRENT encryption key. The state does
 * not change apart from the auth nonce, so every approval the device signed before (its open offers
 * included, wherever a copy of them is kept) can never be used again. The arm's check refuses any
 * other key (`cancelKeepsTheKey`: at admission and again here), and the call context carries the
 * current key, so the wallet's text reads "Cancel all open offers / Your key does not change". On
 * the prover lane like every gated call; the failure budget applies (app.ts `budgeted`).
 */
export function cancelOffersExecutor(deps: AccountActionDeps): JobExecutor {
  return rotateEncKeyExecutor(deps, 'cancel-offers');
}

/**
 * "Restore my encryption key" (AA 00047 P10, audit round 2 R2-3, questions Q36): the same circuit,
 * `rotate_enc_key_with_ed25519`, with `newKey` = the key THIS BROWSER holds, for an account whose
 * on-chain key a page changed (F-A2-3: a real key change passed off as something else locks the
 * account out of the site, whose chain check needs the browser's key). The wallet reads "Rotate
 * encryption key / New key <16 hex>"; the arm's check refuses the on-chain key itself (that is a
 * cancel: `restoreChangesTheKey`), at admission and again here. Its own daily cap, never the
 * cancels'; never refused by the failure budget (app.ts `guarded`).
 */
export function restoreEncKeyExecutor(deps: AccountActionDeps): JobExecutor {
  return rotateEncKeyExecutor(deps, 'restore-enc-key');
}

/** The arm's `rotate_enc_key` for `cancel-offers` (the current key) or `restore-enc-key` (another). */
function rotateEncKeyExecutor(deps: AccountActionDeps, action: 'cancel-offers' | 'restore-enc-key'): JobExecutor {
  return async (raw, ctx) => {
    const { rt, check } = await recheck(deps, action, raw, ctx);
    const p = check.payload;
    return runGated(deps, check.digestHex, () =>
      ctx.prove(() =>
        deps.sponsor.withWallet(async (w) => {
          const privateState = new MemoryPrivateStateProvider();
          try {
            const providers = await rt.providers(w as SponsorWalletHandle, privateState);
            const custody = await rt.client.account.CustodyAccount.connect(
              providers,
              rt.compiledAccount(),
              check.account,
              rt.client.witnesses.emptyCoinStore(),
            );
            ctx.stage('proving', { circuit: deps.arm.circuits.rotateEncKey });
            const out = await custody.rotateEncKeyWithAuth(unhex(p.newKey), check.auth);
            ctx.stage('submitted', { tx: String(out.txId) });
            const result: CancelOffersResult | RestoreEncKeyResult = { txId: String(out.txId) };
            return result as unknown as Record<string, unknown>;
          } finally {
            privateState.wipe();
          }
        }),
      ),
    );
  };
}
