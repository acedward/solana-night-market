// AA 00060 P13 (spec FR-024): "Mint Solana tokens", the relay's TEST SPL faucet. It mints the journey
// registry's bridged test tokens (I-1, e.g. X and Y) to the requesting Solana wallet, in ONE Solana
// transaction per claim that creates any missing associated token account and then `MintToChecked`s each
// mint. The fee (and the new accounts' rent) is paid by the first mint's authority key; the wallet signs
// nothing.
//
// Refused, with a named reason (@nightmarket/core `SPL_FAUCET_OFF_REASONS`):
//   - on mainnet-beta: the registry's genesis hash, or the Solana RPC's, is mainnet-beta's (final);
//   - when the RPC is not the registry's cluster;
//   - when a mint's on-chain mint authority is not the key held, or the mint is not the registry's classic
//     SPL mint with its decimals. Checked at start (`check`) and AGAIN before every claim is sent;
//   - per wallet: once per period (claims on disk, ./claims.ts); while its last claim is unconfirmed;
//   - per client and per period overall: the caps (the request is unsigned: the C2 pattern, see
//     @nightmarket/core ./spl-faucet.ts).
// Nothing here logs or returns a key; the result and every refusal carry public values only.

import nacl from 'tweetnacl';

import {
  SPL_FAUCET_REFUSALS as R,
  SOLANA_MAINNET_BETA_GENESIS_HASH,
  SplFaucetPayloadSchema,
  parseUnits,
  type SplFaucetInfo,
  type SplFaucetOffReason,
  type SplFaucetResult,
  type SplFaucetToken,
} from '@nightmarket/core';
import type { BridgeEntry, BridgeRegistry } from '@nightmarket/core/bridge';
import {
  MAX_TRANSACTION_BYTES,
  TOKEN_PROGRAM_ID,
  assembleTransaction,
  associatedTokenAddress,
  compileLegacyMessage,
  createAssociatedTokenAccountIdempotentInstruction,
  decodeKey,
  encodeKey,
  mintToCheckedInstruction,
  parseMintAccount,
  type Instruction,
} from '@nightmarket/core/solana';

import type { AdmissionOutcome } from '../actions/admission.js';
import { isInfrastructureFailure } from '../actions/failure-budget.js';
import type { Logger } from '../log.js';
import { PublicError, type JobExecutor } from '../queue/jobs.js';
import type { FaucetClaimRecord, SplFaucetClaims } from './claims.js';
import type { FaucetKey } from './keys.js';
import { SolanaRpcError, type FaucetSolanaRpc } from './solana-rpc.js';

/** One faucet token: its registry entry, the authority key held for it, and the base units per claim. */
export interface FaucetToken {
  entry: BridgeEntry;
  key: FaucetKey;
  amount: bigint;
}

export type FaucetState =
  | { kind: 'checking' }
  | { kind: 'ready' }
  | { kind: 'off'; reason: Exclude<SplFaucetOffReason, 'not-configured'>; final: boolean; at: number; detail: string };

/** A state a check can end in (never `checking`). */
export type CheckedState = Exclude<FaucetState, { kind: 'checking' }>;

export interface SplFaucetOptions {
  registry: BridgeRegistry;
  /** SPL mint → its authority key (./keys.ts: every mint is in `registry`). */
  keys: ReadonlyMap<string, FaucetKey>;
  rpc: FaucetSolanaRpc;
  claims: SplFaucetClaims;
  /** Whole tokens per mint per claim (a decimal, e.g. "1000"). */
  amountWhole: string;
  periodSeconds: number;
  /** Claims admitted per period across all wallets. */
  claimsPerPeriod: number;
  /** Claims admitted per period from one client address. */
  perClientPerPeriod: number;
  log: Logger;
  now?: () => number;
  /** How long a sent transaction is followed before it is left pending (ms). */
  confirmTimeoutMs?: number;
  pollMs?: number;
  /** A refusal that is not final is checked again at most this often (seconds). */
  recheckSeconds?: number;
}

export class FaucetConfigError extends Error {
  override name = 'FaucetConfigError';
}

/** The faucet's tokens in registry order, each with its amount in its own decimals. Throws
 *  `FaucetConfigError` when the amount does not fit a mint's decimals or a u64. */
export function faucetTokens(
  registry: BridgeRegistry,
  keys: ReadonlyMap<string, FaucetKey>,
  amountWhole: string,
): FaucetToken[] {
  const out: FaucetToken[] = [];
  for (const entry of registry.entries) {
    const key = keys.get(entry.splMint);
    if (!key) continue;
    let amount: bigint;
    try {
      amount = parseUnits(amountWhole, entry.decimals);
    } catch {
      throw new FaucetConfigError(
        `SPL_FAUCET_AMOUNT ${amountWhole} cannot be expressed in ${entry.symbol}'s ${entry.decimals} decimals`,
      );
    }
    if (amount <= 0n || amount >= 1n << 64n)
      throw new FaucetConfigError(`SPL_FAUCET_AMOUNT ${amountWhole} is not a positive u64 amount of ${entry.symbol}`);
    out.push({ entry, key, amount });
  }
  if (out.length === 0) throw new FaucetConfigError('SPL_FAUCET_KEYS_FILE names none of the registry tokens');
  return out;
}

/** The one claim transaction's instructions for `wallet` (ATA create-if-missing, then MintToChecked, per
 *  token), its fee payer, and its message. Exported for the size check and the tests. */
export function claimInstructions(
  tokens: readonly FaucetToken[],
  wallet: string,
): { payer: string; instructions: Instruction[] } {
  const payer = tokens[0]!.key.publicKey;
  const instructions: Instruction[] = [];
  for (const t of tokens) {
    const ata = associatedTokenAddress(wallet, t.entry.splMint);
    instructions.push(createAssociatedTokenAccountIdempotentInstruction(payer, ata, wallet, t.entry.splMint));
    instructions.push(mintToCheckedInstruction(t.entry.splMint, ata, t.key.publicKey, t.amount, t.entry.decimals));
  }
  return { payer, instructions };
}

/** Sign the compiled message with every key it requires, in its signer order. */
function signClaim(tokens: readonly FaucetToken[], wallet: string, blockhash: string) {
  const { payer, instructions } = claimInstructions(tokens, wallet);
  const message = compileLegacyMessage(payer, blockhash, instructions);
  const byKey = new Map(tokens.map((t) => [t.key.publicKey, t.key.secretKey]));
  const signatures = message.accountKeys.slice(0, message.numRequiredSignatures).map((k) => {
    const sk = byKey.get(k);
    if (!sk) throw new Error('a required signer is not a faucet key'); // cannot happen: only payer/authorities sign
    return nacl.sign.detached(message.bytes, sk);
  });
  const wire = assembleTransaction(message, signatures);
  return { wire, signature: encodeKey(signatures[0]!) };
}

const isWallet = (s: string): boolean => {
  try {
    return encodeKey(decodeKey(s)) === s;
  } catch {
    return false;
  }
};

const OFF_TEXT: Record<SplFaucetOffReason, string> = {
  'not-configured': 'this market does not offer Mint Solana tokens',
  mainnet: 'Mint Solana tokens is a test faucet and is never enabled on Solana mainnet',
  'wrong-cluster': "the market's Solana RPC is not the cluster its token registry names",
  'authority-mismatch': "the market's faucet key is not the mint authority of a token it would mint",
  'mint-mismatch': 'a token the faucet would mint is not the classic SPL mint the registry names',
  unavailable: 'the market cannot reach its Solana RPC right now; try again shortly',
};

export class SplFaucet {
  readonly tokens: readonly FaucetToken[];
  private state: FaucetState = { kind: 'checking' };
  private readonly now: () => number;
  /** Wallets whose claim is admitted and not finished in this process → the client that asked. */
  private readonly inFlight = new Map<string, string>();
  /** Admission times per client, for the per-client cap (memory only: a restart resets it). */
  private readonly byClient = new Map<string, number[]>();
  private checking: Promise<CheckedState> | null = null;

  constructor(private readonly o: SplFaucetOptions) {
    this.now = o.now ?? (() => Math.floor(Date.now() / 1000));
    this.tokens = faucetTokens(o.registry, o.keys, o.amountWhole);
    // One transaction per claim: it must fit a Solana packet with every token in it.
    const probe = signClaim(this.tokens, encodeKey(new Uint8Array(32).fill(9)), encodeKey(new Uint8Array(32).fill(8)));
    if (probe.wire.length > MAX_TRANSACTION_BYTES)
      throw new FaucetConfigError(
        `the faucet's claim transaction is ${probe.wire.length} bytes, over Solana's ${MAX_TRANSACTION_BYTES}: list fewer mints in SPL_FAUCET_KEYS_FILE`,
      );
    if (o.registry.solanaGenesisHash === SOLANA_MAINNET_BETA_GENESIS_HASH)
      this.state = {
        kind: 'off',
        reason: 'mainnet',
        final: true,
        at: this.now(),
        detail: 'the registry is mainnet-beta',
      };
  }

  get current(): FaucetState {
    return this.state;
  }

  /** The public token list (what a claim mints). */
  publicTokens(): SplFaucetToken[] {
    return this.tokens.map((t) => ({
      mint: t.entry.splMint,
      symbol: t.entry.symbol,
      name: t.entry.name,
      decimals: t.entry.decimals,
      amount: t.amount.toString(10),
    }));
  }

  /** Check the chain (the RPC's cluster, every mint and its authority) and record the outcome. A final
   *  refusal (mainnet) is never lifted. Concurrent callers share one check. */
  check(): Promise<CheckedState> {
    if (this.state.kind === 'off' && this.state.final) return Promise.resolve(this.state);
    this.checking ??= this.verifyChain()
      .then((s) => {
        this.state = s;
        if (s.kind === 'off')
          this.o.log[s.reason === 'unavailable' ? 'warn' : 'error']('the SPL faucet is off', {
            reason: s.reason,
            detail: s.detail,
          });
        return s;
      })
      .finally(() => {
        this.checking = null;
      });
    return this.checking;
  }

  /** The chain checks, without recording them. */
  async verifyChain(): Promise<CheckedState> {
    const off = (
      reason: Exclude<SplFaucetOffReason, 'not-configured'>,
      detail: string,
      final = false,
    ): CheckedState => ({
      kind: 'off',
      reason,
      final,
      at: this.now(),
      detail,
    });
    if (this.o.registry.solanaGenesisHash === SOLANA_MAINNET_BETA_GENESIS_HASH)
      return off('mainnet', 'the registry is mainnet-beta', true);
    try {
      const genesis = await this.o.rpc.genesisHash();
      if (genesis === SOLANA_MAINNET_BETA_GENESIS_HASH) return off('mainnet', 'the Solana RPC is mainnet-beta', true);
      if (genesis !== this.o.registry.solanaGenesisHash)
        return off('wrong-cluster', "the Solana RPC's genesis hash is not the registry's");
      for (const t of this.tokens) {
        const a = await this.o.rpc.account(t.entry.splMint);
        if (!a) return off('mint-mismatch', `the mint of ${t.entry.symbol} does not exist`);
        if (a.owner !== TOKEN_PROGRAM_ID)
          return off('mint-mismatch', `the mint of ${t.entry.symbol} is not a classic SPL Token mint`);
        let m;
        try {
          m = parseMintAccount(a.data);
        } catch {
          return off('mint-mismatch', `the mint of ${t.entry.symbol} is not a mint account`);
        }
        if (!m.isInitialized) return off('mint-mismatch', `the mint of ${t.entry.symbol} is not initialised`);
        if (m.decimals !== t.entry.decimals)
          return off(
            'mint-mismatch',
            `the mint of ${t.entry.symbol} has ${m.decimals} decimals, the registry ${t.entry.decimals}`,
          );
        if (m.mintAuthority !== t.key.publicKey)
          return off(
            'authority-mismatch',
            `the mint authority of ${t.entry.symbol} is ${m.mintAuthority ?? 'none'}, not the faucet key ${t.key.publicKey}`,
          );
      }
      return { kind: 'ready' };
    } catch (e) {
      if (isInfrastructureFailure(e) || e instanceof SolanaRpcError)
        return off('unavailable', e instanceof Error ? e.message : 'the Solana RPC could not be read');
      throw e;
    }
  }

  /** A refusal that is not final is re-checked when it is older than `recheckSeconds` (or still checking). */
  private async fresh(): Promise<FaucetState> {
    const s = this.state;
    if (s.kind === 'ready') return s;
    if (s.kind === 'off' && (s.final || this.now() - s.at < (this.o.recheckSeconds ?? 30))) return s;
    return this.check();
  }

  /** `GET /v1/spl-faucet[?wallet=]`. */
  info(wallet?: string): SplFaucetInfo {
    const s = this.state;
    if (s.kind === 'off' && !s.final && this.now() - s.at >= (this.o.recheckSeconds ?? 30)) void this.check();
    const out: SplFaucetInfo = {
      enabled: s.kind === 'ready',
      ...(s.kind === 'off' ? { reason: s.reason } : s.kind === 'checking' ? { reason: 'unavailable' as const } : {}),
      tokens: this.publicTokens(),
      periodHours: Math.round(this.o.periodSeconds / 3600),
    };
    if (wallet) {
      const r = this.o.claims.get(wallet);
      if (r && (r.state !== 'claimed' || r.at + this.o.periodSeconds > this.now())) {
        out.claim = {
          state: r.state === 'claimed' ? 'claimed' : 'pending',
          at: r.at,
          nextClaimAt: r.at + this.o.periodSeconds,
          ...(r.signature ? { signature: r.signature } : {}),
        };
      }
    }
    return out;
  }

  private clientCount(client: string): number {
    const cutoff = this.now() - this.o.periodSeconds;
    const list = (this.byClient.get(client) ?? []).filter((t) => t > cutoff);
    if (list.length === 0) this.byClient.delete(client);
    else this.byClient.set(client, list);
    return list.length;
  }

  private uncharge(client: string, at: number): void {
    const list = this.byClient.get(client);
    const i = list?.lastIndexOf(at) ?? -1;
    if (list && i >= 0) list.splice(i, 1);
  }

  /** Settle a pending record left by an earlier job or run: claimed, released, or still unknown. */
  private async reconcile(wallet: string, r: FaucetClaimRecord): Promise<'claimed' | 'released' | 'pending'> {
    if (r.state === 'reserved' || !r.signature) {
      this.o.claims.release(wallet);
      return 'released';
    }
    const st = await this.o.rpc.signatureStatus(r.signature);
    if (st) {
      if (st.err) {
        this.o.claims.release(wallet);
        return 'released';
      }
      if (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized') {
        this.o.claims.claimed(wallet);
        return 'claimed';
      }
      return 'pending';
    }
    const height = await this.o.rpc.blockHeight();
    if (r.lastValidBlockHeight !== undefined && height > r.lastValidBlockHeight) {
      // It can no longer land; one last look, in case it landed just before.
      if (await this.o.rpc.signatureStatus(r.signature)) return 'pending';
      this.o.claims.release(wallet);
      return 'released';
    }
    return 'pending';
  }

  /** The route's admission check: everything before a queue slot. */
  async admit(payload: Record<string, unknown>, client: string): Promise<AdmissionOutcome> {
    const wallet = String(payload.wallet ?? '');
    if (!isWallet(wallet))
      return {
        ok: false,
        status: 400,
        code: R.badWallet,
        reason: 'the wallet is not a Solana address (base58, 32 bytes)',
      };
    const s = await this.fresh();
    if (s.kind !== 'ready') {
      const reason: SplFaucetOffReason = s.kind === 'off' ? s.reason : 'unavailable';
      return {
        ok: false,
        status: reason === 'mainnet' ? 403 : 503,
        code: R.off,
        reason: OFF_TEXT[reason],
        detail: reason,
      };
    }
    if (this.inFlight.has(wallet))
      return { ok: false, status: 409, code: R.pending, reason: 'a claim for this wallet is in progress; wait for it' };
    let r = this.o.claims.get(wallet);
    if (r && r.state !== 'claimed') {
      let settled: Awaited<ReturnType<SplFaucet['reconcile']>>;
      try {
        settled = await this.reconcile(wallet, r);
      } catch (e) {
        this.o.log.warn('an earlier SPL faucet claim could not be checked', { error: e });
        return { ok: false, status: 503, code: R.off, reason: OFF_TEXT.unavailable, detail: 'unavailable' };
      }
      if (settled === 'pending')
        return {
          ok: false,
          status: 409,
          code: R.pending,
          reason: "this wallet's last claim was sent and is not confirmed yet; try again in a minute",
        };
      r = this.o.claims.get(wallet);
    }
    const now = this.now();
    if (r && r.state === 'claimed' && r.at + this.o.periodSeconds > now) {
      const wait = r.at + this.o.periodSeconds - now;
      return {
        ok: false,
        status: 429,
        code: R.period,
        reason: `this wallet received its test tokens at ${new Date(r.at * 1000).toISOString()}; the next claim opens at ${new Date((r.at + this.o.periodSeconds) * 1000).toISOString()}`,
        retryAfterSeconds: Math.max(1, wait),
      };
    }
    if (this.o.claims.countInPeriod() >= this.o.claimsPerPeriod)
      return {
        ok: false,
        status: 429,
        code: R.cap,
        reason: "the faucet's claims for this period are used up; try again later",
        retryAfterSeconds: 3600,
      };
    if (this.clientCount(client) >= this.o.perClientPerPeriod)
      return {
        ok: false,
        status: 429,
        code: R.cap,
        reason: 'too many faucet claims from this address in this period; try again later',
        retryAfterSeconds: 3600,
      };
    try {
      this.o.claims.reserve(wallet);
    } catch (e) {
      this.o.log.error('the SPL faucet claims file could not be written', { error: e });
      return { ok: false, status: 503, code: R.off, reason: OFF_TEXT.unavailable, detail: 'unavailable' };
    }
    const at = now;
    this.byClient.set(client, [...(this.byClient.get(client) ?? []), at]);
    this.inFlight.set(wallet, client);
    let released = false;
    return {
      ok: true,
      // The route refused it after all (a full queue): nothing was sent.
      release: () => {
        if (released) return;
        released = true;
        this.inFlight.delete(wallet);
        this.uncharge(client, at);
        if (this.o.claims.get(wallet)?.state === 'reserved') this.o.claims.release(wallet);
      },
      finished: () => {
        this.inFlight.delete(wallet);
      },
    };
  }

  /** Follow a sent transaction until it is confirmed, failed, can no longer land, or the wait ends. */
  private async follow(
    signature: string,
    lastValidBlockHeight: number,
  ): Promise<'confirmed' | 'failed' | 'expired' | 'timeout'> {
    const until = Date.now() + (this.o.confirmTimeoutMs ?? 60_000);
    const poll = this.o.pollMs ?? 1_000;
    for (;;) {
      try {
        const st = await this.o.rpc.signatureStatus(signature);
        if (st?.err) return 'failed';
        if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) return 'confirmed';
        if (!st && (await this.o.rpc.blockHeight()) > lastValidBlockHeight) {
          const last = await this.o.rpc.signatureStatus(signature);
          if (!last) return 'expired';
          if (last.err) return 'failed';
        }
      } catch (e) {
        if (!isInfrastructureFailure(e) && !(e instanceof SolanaRpcError)) throw e;
      }
      if (Date.now() >= until) return 'timeout';
      await new Promise((r) => setTimeout(r, poll));
    }
  }

  /** The job (the `relay` lane): check the chain again, build, sign, record, send, confirm. */
  executor(): JobExecutor {
    return async (raw, ctx) => {
      const { wallet } = SplFaucetPayloadSchema.parse({ wallet: (raw as { wallet?: unknown }).wallet });
      const client = this.inFlight.get(wallet);
      const reservedAt = this.o.claims.get(wallet)?.at;
      const giveBack = () => {
        if (client && reservedAt !== undefined) this.uncharge(client, reservedAt);
      };
      let sent = false;
      try {
        ctx.stage('checking');
        const s = await this.verifyChain();
        if (s.kind !== 'ready') {
          this.state = s;
          throw new PublicError(R.off, `${OFF_TEXT[s.reason]}. Nothing was minted`);
        }
        const accounts = await Promise.all(
          this.tokens.map(async (t) => {
            const tokenAccount = associatedTokenAddress(wallet, t.entry.splMint);
            return { tokenAccount, exists: (await this.o.rpc.account(tokenAccount)) !== null };
          }),
        );
        const { blockhash, lastValidBlockHeight } = await this.o.rpc.latestBlockhash();
        const { wire, signature } = signClaim(this.tokens, wallet, blockhash);
        // Written BEFORE the send: whatever happens next, the next request reconciles it on chain.
        this.o.claims.pending(wallet, signature, lastValidBlockHeight);
        sent = true;
        ctx.stage('sending', { signature });
        try {
          await this.o.rpc.sendTransaction(wire);
        } catch (e) {
          if (e instanceof SolanaRpcError) {
            // The RPC refused it (preflight): it was not forwarded, so nothing can land.
            this.o.claims.release(wallet);
            giveBack();
            ctx.log.warn('the SPL faucet transaction was refused by the Solana RPC', {
              code: e.code,
              message: e.message,
            });
            throw new PublicError(
              R.failed,
              `Solana refused the faucet's transaction (${e.message}). Nothing was minted; try again later`,
            );
          }
          throw e;
        }
        ctx.stage('confirming', { signature });
        const outcome = await this.follow(signature, lastValidBlockHeight);
        if (outcome === 'failed' || outcome === 'expired') {
          this.o.claims.release(wallet);
          throw new PublicError(
            R.failed,
            outcome === 'failed'
              ? 'the faucet transaction failed on Solana. Nothing was minted; try again'
              : 'the faucet transaction expired before it landed. Nothing was minted; try again',
          );
        }
        if (outcome === 'timeout')
          throw new PublicError(
            R.pending,
            `the faucet transaction ${signature} was sent and is not confirmed yet; it is checked again on your next claim`,
          );
        const rec = this.o.claims.claimed(wallet);
        ctx.stage('confirmed', { signature });
        const result: SplFaucetResult = {
          wallet,
          signature,
          minted: this.tokens.map((t, i) => ({
            mint: t.entry.splMint,
            symbol: t.entry.symbol,
            name: t.entry.name,
            decimals: t.entry.decimals,
            amount: t.amount.toString(10),
            tokenAccount: accounts[i]!.tokenAccount,
            createdAccount: !accounts[i]!.exists,
          })),
          at: rec.at,
          nextClaimAt: rec.at + this.o.periodSeconds,
        };
        ctx.log.info('SPL faucet claim confirmed', { signature, tokens: this.tokens.map((t) => t.entry.symbol) });
        return result as unknown as Record<string, unknown>;
      } catch (e) {
        if (!sent) {
          // Nothing was sent: the wallet and the client get their claim back.
          const r = this.o.claims.get(wallet);
          if (r?.state === 'reserved') {
            this.o.claims.release(wallet);
            giveBack();
          }
        }
        throw e;
      } finally {
        this.inFlight.delete(wallet);
      }
    };
  }
}

/** The faucet's GET answer when it is not configured. */
export const notConfiguredInfo = (periodHours: number): SplFaucetInfo => ({
  enabled: false,
  reason: 'not-configured',
  tokens: [],
  periodHours,
});
