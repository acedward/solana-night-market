// AA 00060 P6.3 (spec FR-005–FR-011): the relay's side of Bridge out.
//
//   LandingEntitlements   a single-use token `le1.<account>.<op>.<expiry>.<mac>` the relay issues with
//                         tx1's result (`withdraw`, `purpose: 'bridge-out'`) or on `bridge-out-entitle`.
//                         Its MAC (HMAC-SHA256, a key derived from the sponsor seed) binds the network,
//                         the account, the device key, the landing coin public key, the colour, the
//                         amount, the operation (the landing coin's commitment) and the expiry (30 days),
//                         so it survives a restart and cannot be forged. Single use: held while its job
//                         runs, spent when it succeeds, released when it fails; spent ops are remembered
//                         in memory until they expire (a restart forgets them, and the ledger refuses a
//                         second spend of the landing coin anyway).
//   bridge-out            ONE sponsored second transaction of a landing coin: the lock (`lockForSolana`
//                         on a bridge of the journey registry, the Solana recipient the device's wallet)
//                         or the return (`deposit_shielded` into the same account). Checked BEFORE any
//                         queue slot, proof or DUST (spec FR-008; `bridgeOutChecks`): exactly one call,
//                         the right contract and entry point, no DUST spend, no unshielded offer, every
//                         output the call's own, a balanced shielded side; then the call's transcript is
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

import type { BridgeEntry, BridgeRegistry } from '@nightmarket/core/bridge';
import {
  BRIDGE_OUT_REFUSALS as R,
  BridgeOutEntitlePayloadSchema,
  BridgeOutPayloadSchema,
  LANDING_ENTITLEMENT_PATTERN,
  landingCoinCommitment,
  predictLandingCoin,
  type BridgeOutEntitlePayload,
  type BridgeOutPayload,
  type BridgeOutResult,
  type LandingBinding,
} from '@nightmarket/core/bridge/out';

import type { AdmissionCheck, AdmissionOutcome } from '../actions/admission.js';
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
  /** Ops whose bridge-out is queued or running. */
  private readonly pending = new Set<string>();
  /** Ops whose bridge-out succeeded → the token's expiry (unix s). */
  private readonly spent = new Map<string, number>();

  constructor(private readonly opts: LandingEntitlementOptions) {
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000));
    this.ttl = opts.ttlSeconds ?? LANDING_ENTITLEMENT_TTL_SECONDS;
  }

  /** The operation of a landing coin: its commitment, hashed under the label. */
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

  /** Admission: valid, not spent, not in use; the op is held until `spend` or `release`. */
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
        if (end.ok) this.spent.set(v.op, v.expiresAt);
      },
    };
  }

  private sweep(): void {
    const now = this.now();
    for (const [op, exp] of this.spent) if (exp <= now) this.spent.delete(op);
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
  if (tx.guaranteedOffer) offers.push(tx.guaranteedOffer);
  if (tx.fallibleOffer instanceof Map) {
    for (const [seg, o] of tx.fallibleOffer) {
      segments.add(Number(seg));
      offers.push(o);
    }
  }
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
  return { calls, otherActions, dustActions, unshielded, outputs, transients, imbalances };
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
  log: Logger;
}

const stripMeta = (raw: unknown) => {
  const { account: _a, signer: _s, auth: _x, passportAuth: _p, ...rest } = (raw ?? {}) as Record<string, unknown>;
  return rest;
};

/** Deserialize and run every check; the transaction, the call's facts and the withdrawal id. */
export async function checkBridgeOut(
  deps: Pick<BridgeOutDeps, 'bridges' | 'ledger' | 'transcripts'>,
  account: string,
  p: BridgeOutPayload,
): Promise<{ tx: Any; withdrawalId: bigint | null }> {
  const ledger = await deps.ledger();
  let tx: Any;
  try {
    tx = p.proven
      ? ledger.Transaction.deserialize('signature', 'proof', 'pre-binding', unhex(p.tx))
      : ledger.Transaction.deserialize('signature', 'pre-proof', 'pre-binding', unhex(p.tx));
  } catch (e) {
    throw new BridgeOutRefused(R.shape, `the transaction does not decode (${(e as Error).message})`);
  }
  const facts = bridgeOutTxFacts(tx);
  const { call, address } = structuralChecks(facts, p.kind, account, p.landing, deps.bridges);
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
        if (e instanceof BridgeOutRefused) throw new PublicError(e.code, e.message);
        throw e;
      }
      ctx.stage('checked', { kind: p.kind });
      let proven: Any = checked.tx;
      if (!p.proven) {
        ctx.stage('proving');
        const t0 = Date.now();
        proven = await deps.prove(checked.tx);
        ctx.stage('proven', { seconds: String(Math.round((Date.now() - t0) / 100) / 10) });
      }
      const bound = proven.bind();
      const txId = await deps.submitWithDust(bound);
      ctx.stage('submitted', { tx: txId });
      // A call built on a state a concurrent lock replaced passes the pool and fails at its block (no
      // fees): it frees its entitlement here, and the page rebuilds it on the new state (plan T6.5 i).
      if (!(await deps.awaitLanded(txId))) {
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
  if (!(await deps.liveDevice(account, p.deviceKey, BigInt(p.useCounter)))) {
    throw new BridgeOutRefused(R.entitleNotFound, 'the device is not a live device of the account', 403);
  }
  return deps.entitlements.issue(account, landing.binding, landing.commitment);
}

export function bridgeOutEntitleExecutor(deps: EntitleDeps): JobExecutor {
  return async (raw) => {
    const account = norm((raw as { account?: string }).account);
    const p = BridgeOutEntitlePayloadSchema.parse(stripMeta(raw));
    try {
      return { landingEntitlement: await entitle(deps, account, p) };
    } catch (e) {
      if (e instanceof BridgeOutRefused) throw new PublicError(e.code, e.message);
      throw e;
    }
  };
}

export { BridgeOutEntitlePayloadSchema, BridgeOutPayloadSchema };
/* eslint-enable @typescript-eslint/no-explicit-any */
