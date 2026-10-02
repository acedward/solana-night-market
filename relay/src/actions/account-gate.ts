// One expensive job per account at a time (AA 00047 P10, audit round 2 R2-1 / F-A2-1).
//
// Every action that names an account proves (and most pay the sponsor's DUST), so the route admits
// at most `JOBS_PER_ACCOUNT` (default 1) queued-or-running jobs per account: a second request for an
// account whose job has not finished is refused at admission (`429 account-busy`) before any queue
// slot, proof or DUST, and its signature can be sent again once the first job ends. Together with the
// prover lane's fairness (../queue/prover-lock.ts: within a rank, a job is passed by each other key at
// most once) a customer's job waits behind at most one job of each other account of its rank, however
// fast another account sends; takes and makes, which carry a signed deadline, go first (P11.F, R4-1).
//
// The slot is taken synchronously (two racing requests cannot both pass), given back when the route
// refuses the request after all, and otherwise when the job ends (success or failure).

export class AccountGate {
  private readonly active = new Map<string, number>();

  constructor(private readonly maxPerAccount: number) {}

  /** Take a slot for `account`; its release (idempotent), or null when the account is at its limit. */
  take(accountRaw: string): (() => void) | null {
    const account = accountRaw.replace(/^0x/, '').toLowerCase();
    const n = this.active.get(account) ?? 0;
    if (n >= this.maxPerAccount) return null;
    this.active.set(account, n + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.active.get(account) ?? 1) - 1;
      if (left > 0) this.active.set(account, left);
      else this.active.delete(account);
    };
  }

  /** Jobs of `account` admitted and not finished. */
  inFlight(accountRaw: string): number {
    return this.active.get(accountRaw.replace(/^0x/, '').toLowerCase()) ?? 0;
  }
}
