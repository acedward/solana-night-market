// "Prove first" (AA 00062, interface I-62a v2; owner, questions Q4 → D; research R6).
//
// A k≥18 account call in `CLIENT_PROVING=required` mode runs in three steps, and only BYTES are kept
// between them:
//
//   prepare   the executor builds the unproven call with the sponsor's PUBLIC keys only, and `capture`
//             serialises it (`U`) and runs the ledger's `Transaction.prove` on a copy with a provider that
//             answers `check` for real (the proof server's `/check`, the ZKIR only) and, for every `prove`,
//             records the k≥18 call's request (`createProvingPayload(preimage, bindingInput)`, the ledger's
//             own key-less `/prove` body) and refuses: nothing is proven, no prover lane is taken. The job
//             then PARKS on its ticket (./desk.ts), holding only its account's one-job slot.
//   the user  the page fetches the request, the user's prover proves it, the page posts the proof back;
//             the desk checks it (./verifier.ts) and that the account has not moved (`round`, `auth_nonce`).
//   finalize  `inject` deserialises `U` again and runs `Transaction.prove`: the k≥18 call's request is
//             re-derived and must be BYTE-EQUAL to the one the user proved (it was 8/8 times in R6), and
//             gets the user's proof; the 2–3 Zswap builtins go to the proof server as today. Only this
//             step takes the prover lane (seconds). The caller then binds and posts a make, merges a take
//             for the batcher, or balances and submits a sponsored call under the sponsor wallet.
//
// Why this is sound (R6, ledger `ContractCall::public_inputs` at `ledger-9.1.0.0-rc.3`): the proof binds the
// call (address, circuit, transcripts, communication commitment) and the intent's binding commitment, whose
// randomness is drawn when the intent is built (at prepare). It does not bind the TTL, the other actions,
// the DUST, the other intents or the final `bind()`. The DUST fee is added after the proof in its own
// intent (wallet-sdk-facade `balanceUnboundTransaction`), exactly as without client proving.
//
// Staleness: every k≥18 call reads the account's `round` (bumped by EVERY state change, contract INV-7) and
// `auth_nonce` by value in its guaranteed transcript. Both are read before the build (the baseline) and
// compared at finalize; a call the check misses is refused by the node at the mempool (`ReadMismatch`,
// code 104: no DUST is spent), which ./desk.ts maps to `client-proof-stale` as well.
//
// PRIVACY. `U` and the request carry the call's private inputs: they live in the ticket and this job's
// closures only, are never logged (sizes and hashes are), and are dropped when the job ends.

import { createHash } from 'node:crypto';

import * as ledgerV9 from '@midnightntwrk/ledger-v9';
import { parseContractKeyLocation } from '@midnight-ntwrk/midnight-js-types';
import type { JobActionName } from '@nightmarket/core';

import type { Logger } from '../log.js';
import type { LedgerProvingProvider, RelayProofProvider } from '../prover/proving-provider.js';
import { equalBytes, proveBodyFrame } from '../prover/prove-body.js';
import { PublicError, type JobContext } from '../queue/jobs.js';
import type { SponsorSession } from '../sponsor/session.js';
import type { ClientProofDesk, FreshVerdict } from './desk.js';

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex').slice(0, 16);

/** What a captured call holds: everything finalize needs, as bytes. */
export interface CapturedCall {
  circuit: string;
  /** The unproven transaction, serialised. */
  unproven: Uint8Array;
  /** The k≥18 call's key-less `/prove` body. */
  proofRequest: Uint8Array;
  keyMaterialOffset: number;
  /** The pinned verifier key the call's key location names (its sha256 is the `?vk=`). */
  verifierKey: Uint8Array;
  /** Unix seconds: the earliest intent TTL of the transaction, or null when it cannot be read. */
  intentTtl: number | null;
}

/** A ledger transaction as prove first drives it. */
interface ProvableTx {
  serialize(): Uint8Array;
  prove(provider: LedgerProvingProvider, costModel: unknown): Promise<unknown>;
  intents?: Map<number, { ttl?: unknown }>;
}

/** The ledger functions prove first uses (ledger-v9's; the tests substitute them). */
export interface ProveFirstLedger {
  createProvingPayload(serializedPreimage: Uint8Array, overwriteBindingInput?: bigint): Uint8Array;
  /** An unproven, unbound transaction from its bytes. */
  deserializeUnproven(bytes: Uint8Array): ProvableTx;
  costModel(): unknown;
}

const defaultLedger: ProveFirstLedger = {
  createProvingPayload: (p, b) => ledgerV9.createProvingPayload(p, b),
  deserializeUnproven: (bytes) =>
    (
      ledgerV9.Transaction as unknown as {
        deserialize(s: string, p: string, b: string, raw: Uint8Array): ProvableTx;
      }
    ).deserialize('signature', 'pre-proof', 'pre-binding', bytes),
  costModel: () => ledgerV9.CostModel.initialCostModel(),
};

/** Raised inside the capture provider to stop the ledger proving anything. */
class CaptureStop extends Error {
  override name = 'CaptureStop';
}

/** The earliest intent TTL (unix seconds) of a transaction, or null. */
function earliestTtlSeconds(tx: ProvableTx): number | null {
  try {
    let min: number | null = null;
    for (const intent of tx.intents?.values() ?? []) {
      const t = intent.ttl instanceof Date ? intent.ttl.getTime() : null;
      if (t !== null && Number.isFinite(t)) min = min === null ? t : Math.min(min, t);
    }
    return min === null ? null : Math.floor(min / 1000);
  } catch {
    return null;
  }
}

export interface ProveFirstOptions {
  /** The relay's proof provider (in `required` mode it refuses the client circuits itself). */
  proofProvider: Pick<RelayProofProvider, 'provingProvider'>;
  /** The circuits the user's prover proves. */
  circuits: ReadonlySet<string>;
  log: Logger;
  ledger?: ProveFirstLedger;
}

/** Capture (prepare) and inject (finalize): the ledger-facing half of prove first. */
export class ProveFirst {
  private readonly ledger: ProveFirstLedger;

  constructor(private readonly o: ProveFirstOptions) {
    this.ledger = o.ledger ?? defaultLedger;
  }

  /**
   * PREPARE: the k≥18 call's proof request of an unproven transaction, proving nothing. Throws when the
   * transaction has no client-proven call, or more than one (no action builds such a transaction).
   */
  async capture(unprovenTx: unknown): Promise<CapturedCall> {
    const t0 = Date.now();
    const unproven = (unprovenTx as ProvableTx).serialize();
    const inner = this.o.proofProvider.provingProvider();
    const found: { circuit: string; request: Uint8Array; keyMaterialOffset: number; keyLocation: string }[] = [];
    let calls = 0;
    const L = this.ledger;
    const circuits = this.o.circuits;
    const provider: LedgerProvingProvider = {
      check: (preimage, keyLocation) => inner.check(preimage, keyLocation),
      lookupKey: (keyLocation) => inner.lookupKey(keyLocation),
      // Synchronous up to the refusal: the ledger asks for all its proofs before it awaits any (R6: every
      // call reached `prove` at prepare, 3–4 of them), and nothing here may outlive its refusal.
      async prove(preimage, keyLocation, bindingInput) {
        calls++;
        const circuit = parseContractKeyLocation(keyLocation)?.circuitId;
        if (circuit !== undefined && circuits.has(circuit)) {
          const request = L.createProvingPayload(preimage, bindingInput);
          const frame = proveBodyFrame(request, L.createProvingPayload(preimage, undefined));
          found.push({ circuit, request, keyMaterialOffset: frame.head.length, keyLocation });
        }
        throw new CaptureStop('prepare captures the proof request and proves nothing');
      },
    };
    const copy = L.deserializeUnproven(unproven);
    const intentTtl = earliestTtlSeconds(copy);
    try {
      await copy.prove(provider, L.costModel());
    } catch (e) {
      // The refusal above is expected; anything that stopped the ledger before it asked for the k≥18
      // proof (a /check failure, a malformed call) is not.
      if (found.length === 0) throw e;
    }
    if (found.length !== 1) {
      throw new Error(`prepare found ${found.length} client-proven calls in the transaction (exactly 1 expected)`);
    }
    const c = found[0]!;
    const keys = await inner.lookupKey(c.keyLocation);
    if (!keys) throw new Error(`no verifier key for the ${c.circuit} call's key location`);
    this.o.log.info('client proof prepared', {
      circuit: c.circuit,
      unprovenBytes: unproven.length,
      requestBytes: c.request.length,
      requestSha256: sha(c.request),
      proveCallsAtPrepare: calls,
      prepareMs: Date.now() - t0,
    });
    return {
      circuit: c.circuit,
      unproven,
      proofRequest: c.request,
      keyMaterialOffset: c.keyMaterialOffset,
      verifierKey: Uint8Array.from(keys.verifierKey),
      intentTtl,
    };
  }

  /**
   * FINALIZE: the transaction proven, with the user's proof in its k≥18 call and the builtins proven by
   * the proof server. Unbound, unbalanced. A request that is no longer byte-equal to the one the user
   * proved fails `market-unavailable` (the market's failure; nothing is submitted).
   */
  async inject(c: CapturedCall, proof: Uint8Array): Promise<unknown> {
    const t0 = Date.now();
    const inner = this.o.proofProvider.provingProvider();
    const L = this.ledger;
    const circuits = this.o.circuits;
    let matched = 0;
    let mismatched = false;
    let builtins = 0;
    const provider: LedgerProvingProvider = {
      check: (preimage, keyLocation) => inner.check(preimage, keyLocation),
      lookupKey: (keyLocation) => inner.lookupKey(keyLocation),
      async prove(preimage, keyLocation, bindingInput) {
        const circuit = parseContractKeyLocation(keyLocation)?.circuitId;
        if (circuit !== undefined && circuits.has(circuit)) {
          const again = L.createProvingPayload(preimage, bindingInput);
          if (circuit !== c.circuit || !equalBytes(again, c.proofRequest)) {
            mismatched = true;
            throw new Error('the proof request changed between prepare and finalize');
          }
          matched++;
          return Uint8Array.from(proof);
        }
        builtins++;
        return inner.prove(preimage, keyLocation, bindingInput);
      },
    };
    const notTheSame = () =>
      new PublicError(
        'market-unavailable',
        "the market could not finish this action with your proof server's proof. Nothing was sent and it does not count against you; try again",
      );
    let proven: unknown;
    try {
      proven = await L.deserializeUnproven(c.unproven).prove(provider, L.costModel());
    } catch (e) {
      if (mismatched) {
        this.o.log.error('the proof request changed between prepare and finalize', { circuit: c.circuit });
        throw notTheSame();
      }
      throw e;
    }
    if (matched !== 1) {
      this.o.log.error('finalize did not meet the prepared call exactly once', { circuit: c.circuit, matched });
      throw notTheSame();
    }
    this.o.log.info('client proof finalized', {
      circuit: c.circuit,
      builtinProofs: builtins,
      finalizeMs: Date.now() - t0,
    });
    return proven;
  }
}

/** The account state a staleness check reads. */
export type AccountStateReader = (account: string) => Promise<{ round: bigint; auth_nonce: bigint } | null>;

/** The account's state before the build: what the call's transcript reads. */
export interface Baseline {
  round: bigint;
  authNonce: bigint;
}

/** The sponsor wallet's public keys and unshielded address (nothing secret). */
export interface SponsorPublic {
  coinPublicKey: string;
  encryptionPublicKey: string;
  /** The unshielded (Bech32) address a take's batcher submission names; null when the wallet has none. */
  unshieldedAddress: string | null;
}

export interface ParkOptions {
  ctx: JobContext;
  action: JobActionName;
  account: string;
  baseline: Baseline;
  /** The unproven transaction (`createUnprovenCallTx`'s `private.unprovenTx`). */
  unprovenTx: unknown;
  /** Unix seconds: a make's or a take's signed `validUntil`. */
  signedDeadline?: number;
  /** A take's other freshness condition: its maker's offer still live on the exchange. */
  alsoFresh?: () => Promise<FreshVerdict>;
}

/** A call whose user proof has arrived, been checked and found fresh. */
export interface ParkedCall {
  circuit: string;
  /** Finalize under the prover lane (`ctx.prove`): the proven, unbound transaction. May be run again
   *  (a DUST race): the same proof each time. */
  inject(): Promise<unknown>;
  /** The staleness check again, right before the hand-over: throws `client-proof-stale`. */
  assertFresh(): Promise<void>;
  /** A failed submission of this call: the error to throw (`client-proof-invalid` for a refused proof,
   *  `client-proof-stale` for code 104, else the error itself). */
  submissionRefused(error: unknown): unknown;
}

export interface ClientProvingOptions {
  desk: ClientProofDesk;
  proveFirst: Pick<ProveFirst, 'capture' | 'inject'>;
  sponsor: Pick<SponsorSession, 'withWallet'>;
  /** The account's `round` and `auth_nonce` (the indexer). */
  readState: AccountStateReader;
  log: Logger;
}

/** The executors' side of prove first (`CLIENT_PROVING=required`). */
export class ClientProving {
  private sponsorKeys: Promise<SponsorPublic> | null = null;

  constructor(private readonly o: ClientProvingOptions) {}

  get desk(): ClientProofDesk {
    return this.o.desk;
  }

  /** The circuits the user's prover proves. */
  get circuits(): ReadonlySet<string> {
    return this.o.desk.circuits;
  }

  /** The sponsor wallet's public keys and address, read once: the first call holds the wallet for the
   *  read (milliseconds); every later one holds nothing. */
  sponsorPublic(): Promise<SponsorPublic> {
    if (!this.sponsorKeys) {
      const p = this.o.sponsor.withWallet(async (w) => {
        const { syncedKeys } = await import('../passport/wallet-provider.js');
        const keys = await syncedKeys(w as never);
        const address =
          (w as { unshieldedKeystore?: { getBech32Address?(): { asString(): string } } }).unshieldedKeystore
            ?.getBech32Address?.()
            ?.asString() ?? null;
        return { ...keys, unshieldedAddress: address };
      });
      this.sponsorKeys = p;
      p.catch(() => {
        if (this.sponsorKeys === p) this.sponsorKeys = null;
      });
    }
    return this.sponsorKeys;
  }

  /** The account's `round` and `auth_nonce` now: read BEFORE the call is built. */
  async baseline(account: string): Promise<Baseline> {
    const s = await this.o.readState(account);
    if (!s) throw new PublicError('not-found', 'the account is not on chain');
    return { round: s.round, authNonce: s.auth_nonce };
  }

  /**
   * Prepare and park: capture the call's proof request, open the job's ticket and wait (holding nothing)
   * for the user's proof, checked and fresh. Rejects with the job's `client-proof-*` PublicError.
   */
  async park(o: ParkOptions): Promise<ParkedCall> {
    const captured = await this.o.proveFirst.capture(o.unprovenTx);
    const fresh = async (): Promise<FreshVerdict> => {
      const s = await this.o.readState(o.account);
      if (!s) return { ok: false, reason: 'the account is not on chain' };
      if (s.round !== o.baseline.round || s.auth_nonce !== o.baseline.authNonce) {
        return {
          ok: false,
          reason: `the account moved: round ${o.baseline.round} → ${s.round}, auth_nonce ${o.baseline.authNonce} → ${s.auth_nonce}`,
        };
      }
      return o.alsoFresh ? o.alsoFresh() : { ok: true };
    };
    const proof = await this.o.desk.park({
      requestId: o.ctx.requestId,
      action: o.action,
      circuit: captured.circuit,
      proofRequest: captured.proofRequest,
      keyMaterialOffset: captured.keyMaterialOffset,
      verifierKey: captured.verifierKey,
      intentTtl: captured.intentTtl,
      ...(o.signedDeadline !== undefined ? { signedDeadline: o.signedDeadline } : {}),
      fresh,
    });
    const desk = this.o.desk;
    const proveFirst = this.o.proveFirst;
    const requestId = o.ctx.requestId;
    return {
      circuit: captured.circuit,
      inject: () => o.ctx.prove(() => proveFirst.inject(captured, proof)),
      async assertFresh() {
        let v: FreshVerdict;
        try {
          v = await fresh();
        } catch (e) {
          o.ctx.log.warn('the account could not be read before the hand-over', { error: e });
          throw new PublicError(
            'market-unavailable',
            'the market could not read your account on Midnight right now. Nothing was sent and it does not count against you; try again shortly',
          );
        }
        if (!v.ok) throw desk.stale(requestId, v.reason);
      },
      submissionRefused: (error) => desk.submissionRefused(requestId, error),
    };
  }
}

/** The wallet SDK's and Passport's DUST race (`submitWithDustRetry`'s pattern), over an error's causes. */
const DUST_RACE = /SubmissionError|Invalid Transaction|DustDoubleSpend|NotNormalized/;

/** Whether a submission failure is a DUST race worth re-balancing (never a PublicError: a refused proof
 *  and a stale call are mapped to theirs before this is asked). */
export function isDustRace(error: unknown): boolean {
  if (error instanceof PublicError) return false;
  let e: unknown = error;
  for (let depth = 0; depth < 8 && e !== undefined && e !== null; depth++) {
    const o = e as { name?: unknown; message?: unknown; cause?: unknown };
    if (typeof o.name === 'string' && DUST_RACE.test(o.name)) return true;
    if (typeof o.message === 'string' && DUST_RACE.test(o.message)) return true;
    e = typeof e === 'object' ? o.cause : undefined;
  }
  return false;
}

/** How often, and how far apart, a DUST race re-balances with the same proof (Passport's numbers). */
export const DUST_RETRIES = 3;
export const DUST_RETRY_DELAY_MS = 10_000;
