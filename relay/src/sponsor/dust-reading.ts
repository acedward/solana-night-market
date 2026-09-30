// The sponsor's DUST as /health reports it: stable while a transaction is in flight (issue 00049,
// questions Q24).
//
// Why the wallet's own balance dips: when the wallet pays a fee, the ledger's `DustLocalState.spend`
// marks the WHOLE DUST output it spends as pending (until the spend time plus the grace period, 3 h
// on stagenet), and `walletBalance` skips pending outputs. The output only comes back when the
// spend's `DustSpendProcessed` event is replayed: the ledger then removes it and adds the change,
// which keeps the output's backing NIGHT and has `seq + 1`. Meanwhile a 10,000-DUST output paying
// a 12-DUST fee reads as 10,000 DUST gone. The SDK's own list of pending coins cannot fill the gap:
// it drops a pending coin at the next event replay (its filter keeps only outputs the ledger still
// lists, and a pending output is never listed), and on stagenet that replay comes within seconds.
//
// So the relay tracks the locked outputs itself, from the outputs the wallet can spend:
// - every output belongs to a lineage (its backing NIGHT); a lineage that disappears between two
//   synced readings is locked by a spend in flight and counts at its last-seen value;
// - once the wallet holds the transaction that spends it (the facade's pending transactions, from
//   finalisation until the indexer confirms it), the lock learns that spend's fee (matched by the
//   output's nullifier) and counts at its value minus the fee, which is what the change will be;
// - the lock ends when the lineage is back (same `seq`: the spend was dropped or expired; a higher
//   `seq`: the change arrived) or when the ledger's grace period has certainly passed.
// Between balancing and finalisation (the fee payment's proof, seconds) the fee is not known yet
// and the lock counts in full.

/** One DUST output the wallet can spend now (the SDK's `dust.availableCoins`). */
export interface DustOutputView {
  /** The output's lineage: its backing NIGHT (`token.backingNight`), kept by a spend's change. */
  lineage: string;
  /** Its place in the lineage (`token.seq`): +1 for every spend. */
  seq: number;
  /** Its value in specks. */
  specks: bigint;
  /** Its nullifier (`nullifierKey`), which a spend of it names; absent when not computed. */
  nullifier?: string;
}

/** One DUST spend of a transaction the wallet has in flight. */
export interface PendingDustSpendView {
  /** The spent output's nullifier (`nullifierKey` of `DustSpend.oldNullifier`). */
  nullifier: string;
  /** The fee it pays (`DustSpend.vFee`), in specks. */
  feeSpecks: bigint;
}

/** One reading of the sponsor wallet. */
export interface DustWalletView {
  synced: boolean;
  /** The wallet's own balance in specks (`dust.balance(now)`): without the outputs a spend locks. */
  dustSpecks: bigint;
  /** The outputs it can spend now; absent when the wallet does not list them (then no tracking). */
  outputs?: readonly DustOutputView[];
  /** The DUST spends of the transactions in flight (the facade's `pending`); absent when unknown. */
  pendingSpends?: readonly PendingDustSpendView[];
  /** The ledger's DUST grace period in seconds: the longest a pending spend locks an output. */
  graceSeconds?: number;
}

export interface SettledDust {
  /** The balance to report: the wallet's balance plus what the outputs locked by spends in flight
   *  will be worth once their spends land (their value, minus each spend's fee once known). */
  specks: bigint;
  /** The part of `specks` that is locked by spends in flight (0 when idle). */
  inFlightSpecks: bigint;
  /** The fees of those spends, already taken out of `specks`, as far as they are known. */
  inFlightFeeSpecks: bigint;
  /** How many outputs are locked. */
  lockedOutputs: number;
}

/** The ledger's initial DUST grace period (3 h), used when a reading does not carry one. */
export const DEFAULT_DUST_GRACE_SECONDS = 3 * 60 * 60;
/** How long past the grace period a lock is kept at most (the wallet's sync may lag the chain). */
export const LOCK_EXPIRY_MARGIN_MS = 5 * 60_000;

/** The one text form of a DUST nullifier, on both sides of the match. */
export const nullifierKey = (nullifier: bigint): string => nullifier.toString(16);

interface Lock {
  seq: number;
  specks: bigint;
  since: number;
  nullifier: string | undefined;
  fee: bigint | undefined;
}

export class SettledDustTracker {
  private last: Map<string, DustOutputView> | null = null;
  private lastSynced = false;
  private readonly locks = new Map<string, Lock>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Feed one wallet reading; returns the balance to report. */
  observe(view: DustWalletView): SettledDust {
    if (!view.outputs) {
      this.reset();
      return { specks: view.dustSpecks, inFlightSpecks: 0n, inFlightFeeSpecks: 0n, lockedOutputs: 0 };
    }
    const t = this.now();
    const current = new Map<string, DustOutputView>();
    for (const o of view.outputs) {
      const seen = current.get(o.lineage);
      if (!seen || o.seq > seen.seq) current.set(o.lineage, o);
    }
    const expiryMs = (view.graceSeconds ?? DEFAULT_DUST_GRACE_SECONDS) * 1000 + LOCK_EXPIRY_MARGIN_MS;

    // Released: the lineage is back (the change arrived, or the spend was dropped), or the ledger
    // has certainly unlocked the output by now.
    for (const [lineage, lock] of this.locks) {
      const back = current.get(lineage);
      if ((back && back.seq >= lock.seq) || t - lock.since > expiryMs) this.locks.delete(lineage);
    }
    // Locked: a lineage that disappeared between two synced readings. A wallet still catching up
    // can drop outputs for other reasons (one decayed to zero), and the relay never spends then.
    if (this.last && this.lastSynced && view.synced) {
      for (const [lineage, before] of this.last) {
        if (!current.has(lineage) && !this.locks.has(lineage) && before.specks > 0n) {
          this.locks.set(lineage, {
            seq: before.seq,
            specks: before.specks,
            since: t,
            nullifier: before.nullifier,
            fee: undefined,
          });
        }
      }
    }
    // Fees: a lock learns the fee of the spend in flight that names its output, and keeps it (the
    // wallet forgets a transaction once the indexer confirms it, maybe before its change arrives).
    if (view.pendingSpends && view.pendingSpends.length > 0) {
      const fees = new Map(view.pendingSpends.map((s) => [s.nullifier, s.feeSpecks] as const));
      for (const lock of this.locks.values()) {
        const fee = lock.fee === undefined && lock.nullifier !== undefined ? fees.get(lock.nullifier) : undefined;
        if (fee !== undefined && fee >= 0n) lock.fee = fee > lock.specks ? lock.specks : fee;
      }
    }
    this.last = current;
    this.lastSynced = view.synced;

    let inFlightSpecks = 0n;
    let inFlightFeeSpecks = 0n;
    for (const lock of this.locks.values()) {
      inFlightSpecks += lock.specks - (lock.fee ?? 0n);
      inFlightFeeSpecks += lock.fee ?? 0n;
    }
    return {
      specks: view.dustSpecks + inFlightSpecks,
      inFlightSpecks,
      inFlightFeeSpecks,
      lockedOutputs: this.locks.size,
    };
  }

  /** Forget everything (the wallet was closed). */
  reset(): void {
    this.last = null;
    this.lastSynced = false;
    this.locks.clear();
  }
}
