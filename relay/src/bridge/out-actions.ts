// AA 00060 P6.3 (spec FR-005–FR-011): the relay's side of Bridge out.
//
//   LandingEntitlements   a single-use token `le1.<account>.<op>.<expiry>.<mac>` the relay issues with
//                         tx1's result (`withdraw`, `purpose: 'bridge-out'`) or on `bridge-out-entitle`.
//                         Its MAC (HMAC-SHA256, a key derived from the sponsor seed) binds the network,
//                         the account, the device key, the landing coin public key, the colour, the
//                         amount, the operation (the landing coin's commitment) and the expiry (30 days),
//                         so it survives a restart and cannot be forged. Single use: held while its job
//                         runs, spent when it succeeds, released when it fails. Spent ops, and each op's
//                         failures after proving, are kept ON DISK (RELAY_DATA_DIR) until the op expires,
//                         keyed by the landing coin (a re-issue for the same coin is the same op): a
//                         restart or a re-issue does not make a spent landing coin sponsorable again, and
//                         an op that failed after proving `maxFailedAttempts` times (default 3) in a day is
//                         refused until the day passes (AA 00060 P10.3, audit C1: F-A1, F-B1, F-B5).
//   bridge-out            ONE sponsored second transaction of a landing coin: the lock (`lockForSolana`
//                         on a bridge of the journey registry, the Solana recipient the device's wallet)
//                         or the return (`deposit_shielded` into the same account). Checked BEFORE any
//                         queue slot, proof or DUST (spec FR-008; `bridgeOutChecks`): exactly one call,
//                         the right contract and entry point, no DUST spend, no unshielded offer, every
//                         output the call's own, a balanced shielded side; exactly ONE input, and it is the
//                         ENTITLED landing coin (its nullifier recomputed from the entitlement's commitment
//                         and the coin secret key the unproven call carries anyway, Q2 A), exactly one
//                         output, no fallible section, no proven transaction (audit C1); then the call's
//                         transcript is
//                         RUN on the contract's state of the block the page built it on (a lock must
//                         record exactly `{device's wallet, entitlement's amount}`) and on the latest
//                         state (a concurrent lock makes it stale: `bridge-out-stale`, rebuild). The
//                         relay proves it when it is unproven (questions Q2 A), the sponsor adds DUST
//                         ONLY, and submits.
//   bridge-out-entitle    re-issues an entitlement (resume from an empty browser) after a public-indexer
//                         check: tx1 is the account's `withdraw_shielded_with_ed25519`, one of its outputs
//                         is the landing coin (the paid-out coin of the named spent coin, owned by the
//                         landing key), and the device is a live device of the account.
//
// Nothing here holds a secret of the customer's: the unproven transaction carries the per-transfer
// key's witness for its one input (Q2 A, a documented limitation), which only the proof request uses.

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { BridgeEntry, BridgeRegistry } from '@nightmarket/core/bridge';
import {
  BRIDGE_OUT_REFUSALS as R,
  BridgeOutEntitlePayloadSchema,
  BridgeOutPayloadSchema,
  LANDING_ENTITLEMENT_PATTERN,
  coinPublicKeyOfSecret,
  landingCoinCommitment,
  landingCoinNullifier,
  predictLandingCoin,
  type BridgeOutEntitlePayload,
  type BridgeOutPayload,
  type BridgeOutResult,
  type LandingBinding,
} from '@nightmarket/core/bridge/out';

import type { AdmissionCheck, AdmissionOutcome, PreauthCheck } from '../actions/admission.js';
import type { Logger } from '../log.js';
import { PublicError, type JobExecutor } from '../queue/jobs.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

const norm = (h: unknown) =>
  String(h ?? '')
    .replace(/^0x/i, '')
    .toLowerCase();
const unhex = (h: string) => Uint8Array.from(Buffer.from(norm(h), 'hex'));
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

// ── Landing entitlements ──────────────────────────────────────────────────────

export const LANDING_ENTITLEMENT_TTL_SECONDS = 30 * 86_400;
const MAC_LABEL = 'night-market relay: landing entitlement v1';

/** The MAC key: derived from the sponsor seed (stable across restarts), or random without one. */
export function landingEntitlementKey(sponsorSeedHex: string | null): Uint8Array {
  if (!sponsorSeedHex) return randomBytes(32);
  return createHmac('sha256', Buffer.from(sponsorSeedHex, 'hex'))
    .update('night-market relay: landing entitlement key v1')
    .digest();
}

export interface LandingEntitlementOptions {
  key: Uint8Array;
  network: string;
  ttlSeconds?: number;
  now?: () => number;
  /** Where spent ops and failed attempts are kept (`<RELAY_DATA_DIR>/landing-entitlements.json`); null or
   *  absent: in memory only (tests). */
  file?: string | null;
  /** Proved failures one op may have per `attemptWindowSeconds` (default 3, the page's own retries). */
  maxFailedAttempts?: number;
  attemptWindowSeconds?: number;
}

/** What the entitlement store keeps on disk (no secret: ops are hashes of public commitments). */
interface LandingStoreFile {
  version: 1;
  /** op → the token's expiry (unix s). */
  spent: Record<string, number>;
  /** op → its proved failures since `since` (unix s), kept for one attempt window (`expiresAt` is unused). */
  failures: Record<string, { count: number; since: number; expiresAt: number }>;
}

export type LandingCheck = { ok: true; op: string; expiresAt: number } | { ok: false; reason: string };

const normBinding = (b: LandingBinding): LandingBinding => ({
  deviceKey: norm(b.deviceKey),
  coinPublicKey: norm(b.coinPublicKey),
  colour: norm(b.colour),
  amount: BigInt(b.amount).toString(10),
});

export class LandingEntitlements {
  private readonly now: () => number;
  private readonly ttl: number;
  private readonly maxFailures: number;
  private readonly window: number;
  /** Ops whose bridge-out is queued or running. */
  private readonly pending = new Set<string>();
  /** Ops whose running bridge-out failed its re-check before the prover ran (audit C9): not counted. */
  private readonly beforeProof = new Set<string>();
  /** Ops whose landing coin was consumed → when that was recorded (unix s; files from before P10.4 hold the
   *  spending token's expiry). Persisted and NEVER swept (P10.4, audit D2: R-A1, R-B2): a re-issue from
   *  tx1's evidence must not make a spent coin sponsorable again. 64 hex per completed bridge-out. */
  private readonly spent = new Map<string, number>();
  /** Ops whose bridge-out failed after proving. Persisted. */
  private readonly failures = new Map<string, { count: number; since: number; expiresAt: number }>();

  constructor(private readonly opts: LandingEntitlementOptions) {
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000));
    this.ttl = opts.ttlSeconds ?? LANDING_ENTITLEMENT_TTL_SECONDS;
    this.maxFailures = opts.maxFailedAttempts ?? 3;
    this.window = opts.attemptWindowSeconds ?? 86_400;
    if (opts.file) this.load(opts.file);
  }

  private load(file: string): void {
    if (!existsSync(file)) return;
    // A file that does not parse is refused loudly: starting with an empty store would make every spent
    // landing coin sponsorable again.
    const data = JSON.parse(readFileSync(file, 'utf8')) as LandingStoreFile;
    if (data.version !== 1) throw new Error(`${file}: unknown landing entitlement store version`);
    for (const [op, exp] of Object.entries(data.spent ?? {})) this.spent.set(op, Number(exp));
    for (const [op, f] of Object.entries(data.failures ?? {})) this.failures.set(op, { ...f });
    this.sweep();
  }

  private save(): void {
    const file = this.opts.file;
    if (!file) return;
    const data: LandingStoreFile = {
      version: 1,
      spent: Object.fromEntries(this.spent),
      failures: Object.fromEntries(this.failures),
    };
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(data)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
  }

  /** Whether the landing coin with commitment `landingCommitment` was consumed (audit D2). */
  isSpent(landingCommitment: string): boolean {
    return this.spent.has(LandingEntitlements.opOf(landingCommitment));
  }

  /** Record `token`'s landing coin as consumed: a lock that landed after the relay stopped waiting for it
   *  (audit D2: R-A1, a late landing). */
  markSpent(token: string): void {
    const op = typeof token === 'string' ? token.split('.')[2] : undefined;
    if (!op || !/^[0-9a-f]{64}$/.test(op)) return;
    this.spent.set(op, this.now());
    this.failures.delete(op);
    this.save();
  }

  /** The running job of `token` failed its re-check before the prover ran (a concurrent lock moved the
   *  bridge on while it was queued): its failure costs nothing, so it does not use up an attempt (audit
   *  C9 / F-A6). Failures after the prover ran, including a lock that does not land, still count. */
  failedBeforeProof(token: string): void {
    const op = typeof token === 'string' ? token.split('.')[2] : undefined;
    if (op && this.pending.has(op)) this.beforeProof.add(op);
  }

  static opOf(landingCommitment: string): string {
    return createHash('sha256')
      .update(`${MAC_LABEL}|op|landing:${norm(landingCommitment)}`)
      .digest('hex');
  }

  private mac(account: string, b: LandingBinding, op: string, expiry: number): string {
    return createHmac('sha256', this.opts.key)
      .update(
        [MAC_LABEL, this.opts.network, account, b.deviceKey, b.coinPublicKey, b.colour, b.amount, op, expiry].join('|'),
      )
      .digest('hex');
  }

  /** Issue the entitlement of the landing coin with commitment `landingCommitment`. */
  issue(account: string, binding: LandingBinding, landingCommitment: string): string {
    const acc = norm(account);
    const op = LandingEntitlements.opOf(landingCommitment);
    const expiry = this.now() + this.ttl;
    return `le1.${acc}.${op}.${expiry}.${this.mac(acc, normBinding(binding), op, expiry)}`;
  }

  /** Whether `token` is a valid, unexpired entitlement of `account` for exactly `binding`. */
  verify(token: unknown, account: string | undefined, binding: LandingBinding): LandingCheck {
    if (typeof token !== 'string' || !LANDING_ENTITLEMENT_PATTERN.test(token)) {
      return { ok: false, reason: 'no landing entitlement' };
    }
    const [, acc, op, exp, mac] = token.split('.') as [string, string, string, string, string];
    const expiresAt = Number(exp);
    let b: LandingBinding;
    try {
      b = normBinding(binding);
    } catch {
      return { ok: false, reason: 'the landing details are malformed' };
    }
    const want = Buffer.from(this.mac(acc, b, op, expiresAt), 'hex');
    if (!timingSafeEqual(want, Buffer.from(mac, 'hex'))) {
      return { ok: false, reason: 'the entitlement was not issued by this market for these landing details' };
    }
    if (acc !== norm(account)) return { ok: false, reason: 'the entitlement is for another account' };
    if (expiresAt <= this.now()) return { ok: false, reason: 'the entitlement has expired' };
    return { ok: true, op, expiresAt };
  }

  /**
   * Admission: valid, not spent, not in use, not out of attempts; the op is held until its job ends
   * (`finished`: spent on success, a proved failure counted) or the request is refused (`release`).
   */
  admit(token: unknown, account: string | undefined, binding: LandingBinding): AdmissionOutcome {
    this.sweep();
    const v = this.verify(token, account, binding);
    if (!v.ok) return { ok: false, status: 403, code: R.entitlementInvalid, reason: v.reason };
    if (this.spent.has(v.op) || this.pending.has(v.op)) {
      return {
        ok: false,
        status: 403,
        code: R.entitlementUsed,
        reason: 'this landing coin was already locked or returned (the entitlement is single use)',
      };
    }
    const f = this.failures.get(v.op);
    if (f && f.count >= this.maxFailures) {
      const retryAfterSeconds = Math.max(1, f.since + this.window - this.now());
      return {
        ok: false,
        status: 429,
        code: R.attempts,
        reason: `this landing coin's second transaction failed ${f.count} times after the market proved it; try again later`,
        retryAfterSeconds,
      };
    }
    this.pending.add(v.op);
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        this.pending.delete(v.op);
      },
      finished: (end) => {
        if (released) return;
        released = true;
        this.pending.delete(v.op);
        const unproven = this.beforeProof.delete(v.op);
        if (end.ok) {
          this.spent.set(v.op, this.now());
          this.failures.delete(v.op);
          this.save();
        } else if (end.proved && !unproven) {
          const now = this.now();
          const cur = this.failures.get(v.op);
          const fresh = !cur || cur.since + this.window <= now;
          this.failures.set(v.op, {
            count: fresh ? 1 : cur.count + 1,
            since: fresh ? now : cur.since,
            expiresAt: v.expiresAt,
          });
          this.save();
        }
      },
    };
  }

  /** A failure count lasts one attempt window, whatever the token it was counted under; spent ops stay
   *  (audit D2: R-B2). */
  private sweep(): void {
    const now = this.now();
    let changed = false;
    for (const [op, f] of this.failures) {
      if (f.since + this.window <= now) {
        this.failures.delete(op);
        changed = true;
      }
    }
    if (changed) this.save();
  }
}

/** The binding and commitment a bridge-out withdrawal's result entitles (tx1). */
export function landingOfWithdrawal(p: {
  recipient: string;
  color: string;
  amount: string;
  coin: { nonce: string; color: string; value: string };
  deviceKey: string;
}): { binding: LandingBinding; commitment: string } {
  const landing = predictLandingCoin(
    { nonce: norm(p.coin.nonce), color: norm(p.coin.color), value: p.coin.value },
    BigInt(p.amount),
  );
  return {
    binding: {
      deviceKey: norm(p.deviceKey),
      coinPublicKey: norm(p.recipient),
      colour: norm(p.color),
      amount: p.amount,
    },
    commitment: landingCoinCommitment(landing, norm(p.recipient)),
  };
}

// ── The transaction's facts (pure over the ledger-v9 surface, duck-typed) ─────

export interface BridgeOutTxFacts {
  /** Every action of every intent: contract calls (`address`, `entryPoint`) and anything else. */
  calls: { address: string; entryPoint: string; call: Any }[];
  otherActions: number;
  dustActions: number;
  unshielded: boolean;
  /** Each Zswap output's owning contract (null: a user output) and transients. */
  outputs: (string | null)[];
  transients: number;
  /** Non-zero, non-DUST imbalances, `segment:token`. */
  imbalances: string[];
  /** The guaranteed offer's inputs and outputs (audit C1: exactly one each). */
  guaranteedInputs: number;
  guaranteedOutputs: number;
  /** The guaranteed inputs' nullifiers (64 hex). */
  nullifiers: string[];
  /** The segments of any FALLIBLE offer (audit C1: none). */
  fallibleSegments: number[];
}

const entryPointOf = (ep: unknown): string =>
  typeof ep === 'string' ? ep : ep instanceof Uint8Array ? new TextDecoder().decode(ep) : String(ep);

export function bridgeOutTxFacts(tx: Any): BridgeOutTxFacts {
  const calls: BridgeOutTxFacts['calls'] = [];
  let otherActions = 0;
  let dustActions = 0;
  let unshielded = false;
  const segments = new Set<number>([0]);
  const intents: Map<number, Any> = tx.intents instanceof Map ? tx.intents : new Map();
  for (const [seg, intent] of intents) {
    segments.add(Number(seg));
    for (const a of intent.actions ?? []) {
      if (a && a.address !== undefined && a.entryPoint !== undefined && 'guaranteedTranscript' in a) {
        calls.push({ address: norm(a.address), entryPoint: entryPointOf(a.entryPoint), call: a });
      } else otherActions += 1;
    }
    dustActions += (intent.dustActions?.spends?.length ?? 0) + (intent.dustActions?.registrations?.length ?? 0);
    if (intent.guaranteedUnshieldedOffer || intent.fallibleUnshieldedOffer) unshielded = true;
  }
  const outputs: (string | null)[] = [];
  let transients = 0;
  const offers: Any[] = [];
  const fallibleSegments: number[] = [];
  if (tx.guaranteedOffer) offers.push(tx.guaranteedOffer);
  if (tx.fallibleOffer instanceof Map) {
    for (const [seg, o] of tx.fallibleOffer) {
      segments.add(Number(seg));
      fallibleSegments.push(Number(seg));
      offers.push(o);
    }
  }
  const guaranteed = tx.guaranteedOffer;
  const nullifiers: string[] = (guaranteed?.inputs ?? []).map((i: Any) => norm(i.nullifier));
  for (const o of offers) {
    for (const out of o.outputs ?? []) outputs.push(out.contractAddress ? norm(out.contractAddress) : null);
    transients += o.transients?.length ?? 0;
  }
  const imbalances: string[] = [];
  for (const s of segments) {
    for (const [token, delta] of tx.imbalances(s) as Map<Any, bigint>) {
      if (token?.tag === 'dust' || delta === 0n) continue;
      imbalances.push(`${s}:${token?.tag}:${norm(token?.raw)}=${delta}`);
    }
  }
  return {
    calls,
    otherActions,
    dustActions,
    unshielded,
    outputs,
    transients,
    imbalances,
    guaranteedInputs: guaranteed?.inputs?.length ?? 0,
    guaranteedOutputs: guaranteed?.outputs?.length ?? 0,
    nullifiers,
    fallibleSegments,
  };
}

export class BridgeOutRefused extends Error {
  override name = 'BridgeOutRefused';
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 403 | 409 = 400,
  ) {
    super(message);
  }
}

/**
 * The structural checks (no network): exactly one call, of the expected entry point, on a contract
 * the request may target; no DUST spend, no unshielded offer, no transient, every output the call's
 * own, a balanced shielded side. Returns the call and, for a lock, its bridge entry.
 */
export function structuralChecks(
  facts: BridgeOutTxFacts,
  kind: BridgeOutPayload['kind'],
  account: string,
  binding: LandingBinding,
  bridges: BridgeRegistry,
): { call: Any; address: string; bridge: BridgeEntry | null } {
  if (facts.calls.length !== 1 || facts.otherActions > 0) {
    throw new BridgeOutRefused(
      R.shape,
      `expected exactly one contract call, found ${facts.calls.length + facts.otherActions} actions`,
    );
  }
  if (facts.dustActions > 0) throw new BridgeOutRefused(R.dust, 'the transaction spends DUST (the market adds it)');
  if (facts.unshielded) throw new BridgeOutRefused(R.unshielded, 'the transaction moves unshielded tokens');
  const c = facts.calls[0]!;
  let bridge: BridgeEntry | null = null;
  if (kind === 'lock') {
    bridge = bridges.entries.find((e) => norm(e.bridgeContract) === c.address) ?? null;
    if (!bridge) throw new BridgeOutRefused(R.contract, 'the call is not to a bridge this market bridges');
    if (norm(bridge.colour) !== norm(binding.colour)) {
      throw new BridgeOutRefused(
        R.colour,
        `the call is to the ${bridge.symbol} bridge, not the landing coin's colour's`,
      );
    }
    if (c.entryPoint !== 'lockForSolana')
      throw new BridgeOutRefused(R.shape, `the call is ${c.entryPoint}, not lockForSolana`);
  } else {
    if (c.address !== norm(account)) {
      throw new BridgeOutRefused(R.destination, 'a return must deposit into the same account');
    }
    if (c.entryPoint !== 'deposit_shielded') {
      throw new BridgeOutRefused(R.shape, `the call is ${c.entryPoint}, not deposit_shielded`);
    }
  }
  if (facts.transients > 0) throw new BridgeOutRefused(R.shape, 'the transaction has transient coins');
  // Audit C1: nothing that can fail AFTER the market paid (a fallible offer or a fallible part of the call),
  // and exactly the page's layout: one input (the landing coin) and one output (the coin the call receives).
  if ((facts.fallibleSegments ?? []).length > 0) {
    throw new BridgeOutRefused(
      R.shape,
      'the transaction has a fallible offer (the market pays only for a guaranteed one)',
    );
  }
  if (c.call?.fallibleTranscript) {
    throw new BridgeOutRefused(R.shape, 'the call has a fallible part (the market pays only for a guaranteed call)');
  }
  if (facts.guaranteedInputs !== 1) {
    throw new BridgeOutRefused(
      R.shape,
      `the transaction must spend exactly one input (the landing coin), not ${facts.guaranteedInputs}`,
    );
  }
  if (facts.guaranteedOutputs !== 1) {
    throw new BridgeOutRefused(
      R.shape,
      `the transaction must create exactly one output, not ${facts.guaranteedOutputs}`,
    );
  }
  if (facts.outputs.length === 0 || facts.outputs.some((o) => o !== c.address)) {
    throw new BridgeOutRefused(
      R.shape,
      'every output must be the coin the call receives (no change, no other recipient)',
    );
  }
  if (facts.imbalances.length > 0) {
    throw new BridgeOutRefused(R.shape, `the shielded side is not balanced (${facts.imbalances.join(', ')})`);
  }
  return { call: c.call, address: c.address, bridge };
}

/** What the transcript checks need: compact-runtime, and the contract's state at a block / now. */
export interface TranscriptDeps {
  /** `@midnight-ntwrk/compact-runtime-0.20` (its QueryContext and CostModel). */
  runtime: { QueryContext: Any; CostModel: Any };
  /** The bridge contract module's `ledger(state)` (the vendored compiled JS). */
  bridgeLedger: (state: Any) => Any;
  /** The contract's state as of the block `blockHash`, or null. */
  stateAt(address: string, blockHash: string): Promise<Any | null>;
  /** The contract's latest state, or null. */
  latestState(address: string): Promise<Any | null>;
}

/** Run the call's transcripts (guaranteed, then fallible) on `state`; returns the state after. */
export function runCall(rt: TranscriptDeps['runtime'], state: Any, address: string, call: Any): Any {
  let qc = new rt.QueryContext(state.data, address);
  const cost = rt.CostModel.initialCostModel();
  for (const t of [call.guaranteedTranscript, call.fallibleTranscript]) if (t) qc = qc.runTranscript(t, cost);
  return qc.state;
}

/**
 * The transcript checks: on the state the page built on, a lock records exactly `{device's wallet,
 * amount}` under the bridge's next withdrawal id (and a return runs at all); on the latest state the
 * call still runs (else `bridge-out-stale`). Returns the withdrawal id of a lock.
 */
export async function transcriptChecks(
  deps: TranscriptDeps,
  kind: BridgeOutPayload['kind'],
  address: string,
  call: Any,
  binding: LandingBinding,
  blockHash: string,
): Promise<{ withdrawalId: bigint | null }> {
  const built = await deps.stateAt(address, blockHash);
  if (!built) throw new BridgeOutRefused(R.stale, 'the block the call was built on is not known: rebuild it', 409);
  let after: Any;
  try {
    after = runCall(deps.runtime, built, address, call);
  } catch (e) {
    throw new BridgeOutRefused(R.shape, `the call does not run on the state it was built on (${(e as Error).message})`);
  }
  let withdrawalId: bigint | null = null;
  if (kind === 'lock') {
    const before = deps.bridgeLedger(built.data);
    const next = deps.bridgeLedger(after);
    withdrawalId = BigInt(before.withdrawalNonce);
    if (BigInt(next.withdrawalNonce) !== withdrawalId + 1n || !next.withdrawals.member(withdrawalId)) {
      throw new BridgeOutRefused(R.shape, 'the call does not record one withdrawal');
    }
    const w = next.withdrawals.lookup(withdrawalId);
    if (hex(Uint8Array.from(w.solanaRecipient)) !== norm(binding.deviceKey)) {
      throw new BridgeOutRefused(R.destination, "the lock's Solana recipient is not the device's wallet");
    }
    if (BigInt(w.amount) !== BigInt(binding.amount)) {
      throw new BridgeOutRefused(R.amount, `the lock records ${w.amount}, not ${binding.amount}`);
    }
  }
  const latest = await deps.latestState(address);
  if (!latest) throw new BridgeOutRefused(R.stale, 'the contract cannot be read right now: rebuild and resend', 409);
  try {
    runCall(deps.runtime, latest, address, call);
  } catch {
    throw new BridgeOutRefused(
      R.stale,
      'the contract changed since the call was built (another bridge-out landed first): rebuild it and send again',
      409,
    );
  }
  // The transcript READS the withdrawal nonce (its value is checked when it runs), so a call that runs
  // on the latest state records under the same id it did on the state it was built on.
  return { withdrawalId };
}

// ── The actions ───────────────────────────────────────────────────────────────

export interface BridgeOutDeps {
  bridges: BridgeRegistry;
  entitlements: LandingEntitlements;
  /** `@midnightntwrk/ledger-v9` (Transaction.deserialize). */
  ledger: () => Promise<Any>;
  transcripts: () => Promise<TranscriptDeps>;
  /** Prove an unproven transaction (the relay's proof provider); resolves with the unbound proven one. */
  prove(tx: Any): Promise<Any>;
  /** Hold the prover lane and the sponsor wallet: add DUST only to the bound transaction and submit. */
  submitWithDust(tx: Any): Promise<string>;
  /** Whether the submitted transaction landed on Midnight (false: refused at its block, or not seen in
   *  time). A lock that does not land frees its entitlement (the job fails `bridge-out-stale`). */
  awaitLanded(txId: string): Promise<boolean>;
  /** P10.4 (audit D2, R-A1): after `awaitLanded` gave up, whether the transaction landed after all (a longer
   *  watch). When it resolves true, the entitlement's landing coin is recorded spent. Optional (tests). */
  lateLanding?(txId: string): Promise<boolean>;
  log: Logger;
}

const stripMeta = (raw: unknown) => {
  const { account: _a, signer: _s, auth: _x, passportAuth: _p, ...rest } = (raw ?? {}) as Record<string, unknown>;
  return rest;
};

/**
 * Audit C1: the transaction's ONE input is the ENTITLED landing coin. From the request's `spend`: the coin
 * secret key's public key must be the binding's; the coin (that nonce, the binding's colour and amount,
 * that key) must be the coin whose commitment the entitlement's op names; and the input's nullifier must
 * be that coin's. Another key's coin, another coin of the same key, or any other amount or colour is
 * refused here, before any proof or DUST.
 */
export function inputChecks(facts: BridgeOutTxFacts, p: BridgeOutPayload, op: string): void {
  if (!p.spend) throw new BridgeOutRefused(R.input, 'the request does not name the landing coin it spends');
  let coinPublicKey: string;
  try {
    coinPublicKey = coinPublicKeyOfSecret(p.spend.coinSecretKey);
  } catch {
    throw new BridgeOutRefused(R.input, 'the landing key is malformed');
  }
  if (coinPublicKey !== norm(p.landing.coinPublicKey)) {
    throw new BridgeOutRefused(R.input, "the coin is not the entitled landing key's");
  }
  const coin = {
    nonce: norm(p.spend.nonce),
    color: norm(p.landing.colour),
    value: BigInt(p.landing.amount).toString(10),
  };
  if (LandingEntitlements.opOf(landingCoinCommitment(coin, coinPublicKey)) !== op) {
    throw new BridgeOutRefused(R.input, 'the coin is not the landing coin this entitlement is for');
  }
  const nullifier = landingCoinNullifier(coin, p.spend.coinSecretKey);
  if (facts.nullifiers.length !== 1 || facts.nullifiers[0] !== nullifier) {
    throw new BridgeOutRefused(R.input, 'the transaction does not spend the entitled landing coin');
  }
}

/** Deserialize and run every check; the transaction, the call's facts and the withdrawal id. */
export async function checkBridgeOut(
  deps: Pick<BridgeOutDeps, 'bridges' | 'ledger' | 'transcripts' | 'entitlements'>,
  account: string,
  p: BridgeOutPayload,
): Promise<{ tx: Any; withdrawalId: bigint | null }> {
  // Audit C1: a proven transaction cannot show which coin it spends (its witness is gone); the page sends
  // it unproven and the relay proves it (questions Q2 A).
  if (p.proven) {
    throw new BridgeOutRefused(
      R.proven,
      'send the bridge-out unproven: the market proves it, and checks the coin it spends',
    );
  }
  const v = deps.entitlements.verify(p.entitlement, account, p.landing);
  if (!v.ok) throw new BridgeOutRefused(R.entitlementInvalid, v.reason, 403);
  const ledger = await deps.ledger();
  let tx: Any;
  try {
    tx = ledger.Transaction.deserialize('signature', 'pre-proof', 'pre-binding', unhex(p.tx));
  } catch (e) {
    throw new BridgeOutRefused(R.shape, `the transaction does not decode (${(e as Error).message})`);
  }
  const facts = bridgeOutTxFacts(tx);
  const { call, address } = structuralChecks(facts, p.kind, account, p.landing, deps.bridges);
  inputChecks(facts, p, v.op);
  const { withdrawalId } = await transcriptChecks(
    await deps.transcripts(),
    p.kind,
    address,
    call,
    p.landing,
    p.blockHash,
  );
  return { tx, withdrawalId };
}

/**
 * `bridge-out`'s preauthorisation (audit C2: F-A2, F-B2): the entitlement's MAC, BEFORE the request may
 * charge the device it names (the owner's rate limit), the account (its one-job gate) or the queue. A
 * forged or foreign entitlement costs the named customer nothing.
 */
export function bridgeOutPreauth(entitlements: LandingEntitlements): PreauthCheck {
  return async ({ account, payload }) => {
    const p = BridgeOutPayloadSchema.safeParse(payload);
    if (!p.success)
      return { ok: false, status: 400, code: 'bad-request', reason: 'the bridge-out request is malformed' };
    const v = entitlements.verify(p.data.entitlement, account, p.data.landing);
    return v.ok ? { ok: true } : { ok: false, status: 403, code: R.entitlementInvalid, reason: v.reason };
  };
}

/** `bridge-out`'s admission: the entitlement, then every check, before any queue slot. */
export function bridgeOutAdmission(
  deps: Pick<BridgeOutDeps, 'bridges' | 'ledger' | 'transcripts' | 'entitlements'>,
): AdmissionCheck {
  return async ({ account, payload }) => {
    const p = BridgeOutPayloadSchema.safeParse(payload);
    if (!p.success)
      return { ok: false, status: 400, code: 'bad-request', reason: 'the bridge-out request is malformed' };
    const held = deps.entitlements.admit(p.data.entitlement, account, p.data.landing);
    if (!held.ok) return held;
    try {
      await checkBridgeOut(deps, norm(account), p.data);
    } catch (e) {
      held.release?.();
      if (e instanceof BridgeOutRefused) return { ok: false, status: e.status, code: e.code, reason: e.message };
      throw e;
    }
    return held;
  };
}

/** `bridge-out`'s executor: check again (the state may have moved while queued), prove, DUST, submit. */
export function bridgeOutExecutor(deps: BridgeOutDeps): JobExecutor {
  return async (raw, ctx) => {
    const account = norm((raw as { account?: string }).account);
    const p = BridgeOutPayloadSchema.parse(stripMeta(raw));
    return ctx.prove(async () => {
      let checked: { tx: Any; withdrawalId: bigint | null };
      try {
        checked = await checkBridgeOut(deps, account, p);
      } catch (e) {
        // Nothing was proven: this failure does not use up one of the entitlement's attempts (audit C9).
        deps.entitlements.failedBeforeProof(p.entitlement);
        if (e instanceof BridgeOutRefused) throw new PublicError(e.code, e.message);
        throw e;
      }
      ctx.stage('checked', { kind: p.kind });
      ctx.stage('proving');
      const t0 = Date.now();
      const proven: Any = await deps.prove(checked.tx);
      ctx.stage('proven', { seconds: String(Math.round((Date.now() - t0) / 100) / 10) });
      const bound = proven.bind();
      const txId = await deps.submitWithDust(bound);
      ctx.stage('submitted', { tx: txId });
      // A call built on a state a concurrent lock replaced passes the pool and fails at its block (no
      // fees): it frees its entitlement here, and the page rebuilds it on the new state (plan T6.5 i).
      if (!(await deps.awaitLanded(txId))) {
        // It may still land (audit D2): keep watching, and record the coin spent if it does.
        if (deps.lateLanding) {
          void deps
            .lateLanding(txId)
            .then((landed) => {
              if (!landed) return;
              deps.entitlements.markSpent(p.entitlement);
              deps.log.info('a bridge-out landed after the wait; its landing coin is recorded spent', { tx: txId });
            })
            .catch(() => undefined);
        }
        throw new PublicError(
          R.stale,
          'the transaction did not land (the contract moved on before it was included): rebuild it and send again',
        );
      }
      ctx.stage('landed', { tx: txId });
      const result: BridgeOutResult = {
        txId,
        ...(p.kind === 'lock' && checked.withdrawalId !== null
          ? { withdrawalId: checked.withdrawalId.toString(10) }
          : {}),
      };
      return result as unknown as Record<string, unknown>;
    });
  };
}

// ── bridge-out-entitle ────────────────────────────────────────────────────────

export interface EntitleDeps {
  entitlements: LandingEntitlements;
  /** tx1 as the public indexer has it: its calls' entry points on the account and every Zswap output's
   *  commitment, or null when the account has no such transaction. */
  tx1(account: string, tx1Hash: string): Promise<{ entryPoints: string[]; outputs: string[] } | null>;
  /** Whether `deviceKey`'s entry at `useCounter` is a live device of the account. */
  liveDevice(account: string, deviceKey: string, useCounter: bigint): Promise<boolean>;
  /** P10.4 (audit D3, R-A3): how many re-issue evidence reads (account histories) run at once relay-wide,
   *  and how many more may wait for a turn; beyond that a request is refused 503 `busy`. */
  readLimit?: { max: number; waiting: number };
}

/** Default relay-wide bound on re-issue evidence reads (audit D3). */
export const ENTITLE_READ_LIMIT = { max: 2, waiting: 8 };

/** A counting semaphore with a bounded waiting room: `acquire` resolves with a release, or null when full. */
export class ReadLimiter {
  private running = 0;
  private readonly queue: Array<() => void> = [];
  constructor(private readonly limit: { max: number; waiting: number }) {}
  acquire(): Promise<(() => void) | null> {
    const release = () => {
      const next = this.queue.shift();
      if (next) next();
      else this.running--;
    };
    if (this.running < this.limit.max) {
      this.running++;
      return Promise.resolve(release);
    }
    if (this.queue.length >= this.limit.waiting) return Promise.resolve(null);
    return new Promise((resolve) => this.queue.push(() => resolve(release)));
  }
}

export const WITHDRAW_ENTRY_POINT = 'withdraw_shielded_with_ed25519';

export async function entitle(deps: EntitleDeps, account: string, p: BridgeOutEntitlePayload): Promise<string> {
  const amount = BigInt(p.amount);
  if (amount <= 0n || amount > BigInt(p.spentCoin.value)) {
    throw new BridgeOutRefused(R.entitleNotFound, 'the amount is not within the spent coin', 403);
  }
  const tx1 = await deps.tx1(account, p.tx1Hash);
  if (!tx1 || !tx1.entryPoints.includes(WITHDRAW_ENTRY_POINT)) {
    throw new BridgeOutRefused(R.entitleNotFound, "tx1 is not one of the account's withdrawals", 403);
  }
  const landing = landingOfWithdrawal({
    recipient: p.landingCoinPublicKey,
    color: p.spentCoin.color,
    amount: p.amount,
    coin: p.spentCoin,
    deviceKey: p.deviceKey,
  });
  if (!tx1.outputs.map(norm).includes(landing.commitment)) {
    throw new BridgeOutRefused(R.entitleNotFound, 'tx1 paid no such coin to that landing key', 403);
  }
  // Audit D2 (R-A1, R-B2): no new entitlement for a landing coin already locked or returned.
  if (deps.entitlements.isSpent(landing.commitment)) {
    throw new BridgeOutRefused(
      R.entitlementUsed,
      'this landing coin was already locked or returned: there is nothing left to finish',
      403,
    );
  }
  if (!(await deps.liveDevice(account, p.deviceKey, BigInt(p.useCounter)))) {
    throw new BridgeOutRefused(R.entitleNotFound, 'the device is not a live device of the account', 403);
  }
  return deps.entitlements.issue(account, landing.binding, landing.commitment);
}

/**
 * `bridge-out-entitle`'s whole check, as a preauthorisation (audit C2: F-A2, F-B2): the indexer's evidence
 * of tx1 and the live device are checked BEFORE the request may charge the device it names, take the
 * account's one-job gate, or a queue slot. On success the entitlement rides into the job, which only
 * returns it (no gate, no prover). Refusals are 403 `entitle-not-found`; an indexer outage is 503.
 */
export function entitlePreauth(deps: EntitleDeps): PreauthCheck {
  // Audit D3 (R-A3): the evidence reads run in the request path, so they are bounded relay-wide.
  const limiter = new ReadLimiter(deps.readLimit ?? ENTITLE_READ_LIMIT);
  return async ({ account, payload }) => {
    const p = BridgeOutEntitlePayloadSchema.safeParse(payload);
    if (!p.success || !account) {
      return { ok: false, status: 400, code: 'bad-request', reason: 'the entitlement request is malformed' };
    }
    const release = await limiter.acquire();
    if (!release) {
      return {
        ok: false,
        status: 503,
        code: 'busy',
        reason: 'the relay is checking too many transfers right now; try again shortly',
      };
    }
    try {
      return { ok: true, adds: { landingEntitlement: await entitle(deps, norm(account), p.data) } };
    } catch (e) {
      if (e instanceof BridgeOutRefused) return { ok: false, status: 403, code: e.code, reason: e.message };
      return {
        ok: false,
        status: 503,
        code: 'chain-unavailable',
        reason: "the account's history could not be read right now; try again shortly",
      };
    } finally {
      release();
    }
  };
}

/** `bridge-out-entitle`'s executor: the entitlement its preauthorisation issued (nothing else to do). */
export function bridgeOutEntitleExecutor(): JobExecutor {
  return async (raw) => {
    const token = (raw as { landingEntitlement?: unknown }).landingEntitlement;
    if (typeof token !== 'string' || !LANDING_ENTITLEMENT_PATTERN.test(token)) {
      throw new PublicError(R.entitleNotFound, 'no entitlement was issued for this request');
    }
    return { landingEntitlement: token };
  };
}

export { BridgeOutEntitlePayloadSchema, BridgeOutPayloadSchema };
/* eslint-enable @typescript-eslint/no-explicit-any */
