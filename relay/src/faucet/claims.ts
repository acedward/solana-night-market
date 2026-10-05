// AA 00060 P13 (spec FR-024): the test SPL faucet's claims, one record per Solana wallet, kept in
// `<RELAY_DATA_DIR>/spl-faucet-claims.json` so the once-per-period rule survives a restart.
//
// A record's life:
//   - RESERVED at admission, before any queue slot (so two requests for one wallet cannot both pass);
//   - PENDING once its transaction is signed, written BEFORE it is sent, with the signature and the last
//     block height at which it can land: whatever happens next (the relay stops, the RPC drops the
//     answer), the next request for that wallet reconciles it on chain before anything is minted again;
//   - CLAIMED when the transaction is confirmed; it blocks the wallet until `at + period`;
//   - deleted (RELEASED) when nothing was sent, or when the chain says the transaction failed or can no
//     longer land: the wallet may claim again at once.
// A reserved record found on disk at start was never sent (the signature is written before the send), so
// it is dropped. Claimed records older than the period are dropped when the file is next written.
//
// Every change is written to disk FIRST (a temporary file, fsync, rename; mode 600) and only then
// applied in memory, so a failed write leaves memory as it was and the caller refuses the request. The
// file holds only public values: wallet addresses, times, signatures, block heights.

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMAT = 'night-market-spl-faucet-claims/1';

export interface FaucetClaimRecord {
  /** Unix seconds of the reservation: the period runs from here. */
  at: number;
  state: 'reserved' | 'pending' | 'claimed';
  /** The transaction's signature (base58), from `pending` on. */
  signature?: string;
  /** The last block height at which the transaction can land, from `pending` on. */
  lastValidBlockHeight?: number;
  /** Unix seconds of the confirmation. */
  claimedAt?: number;
}

interface StoreFile {
  format: typeof FORMAT;
  claims: Record<string, FaucetClaimRecord>;
}

export class FaucetClaimsError extends Error {
  override name = 'FaucetClaimsError';
}

export interface FaucetClaimsOptions {
  /** The claims file; null: memory only (tests). */
  file: string | null;
  periodSeconds: number;
  now?: () => number;
}

export class SplFaucetClaims {
  private readonly now: () => number;
  private readonly claims = new Map<string, FaucetClaimRecord>();

  constructor(private readonly o: FaucetClaimsOptions) {
    this.now = o.now ?? (() => Math.floor(Date.now() / 1000));
    if (o.file) this.load(o.file);
  }

  private load(file: string): void {
    if (!existsSync(file)) return;
    let data: StoreFile;
    try {
      data = JSON.parse(readFileSync(file, 'utf8')) as StoreFile;
    } catch {
      // Starting empty would let every wallet claim again: refuse loudly instead.
      throw new FaucetClaimsError(`${file} cannot be read as the SPL faucet's claims; fix or move it`);
    }
    if (data?.format !== FORMAT || typeof data.claims !== 'object' || data.claims === null)
      throw new FaucetClaimsError(`${file} is not an SPL faucet claims file (${FORMAT})`);
    for (const [wallet, r] of Object.entries(data.claims)) {
      if (r.state === 'reserved') continue; // never sent
      this.claims.set(wallet, { ...r });
    }
  }

  private write(next: Map<string, FaucetClaimRecord>): void {
    const file = this.o.file;
    if (!file) return;
    const cutoff = this.now() - this.o.periodSeconds;
    const claims: Record<string, FaucetClaimRecord> = {};
    for (const [w, r] of next) if (r.state !== 'claimed' || r.at > cutoff) claims[w] = r;
    const body = `${JSON.stringify({ format: FORMAT, claims } satisfies StoreFile)}\n`;
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    const fd = openSync(tmp, 'w', 0o600);
    try {
      writeSync(fd, body);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, file);
  }

  /** Apply `change` on a copy, write it, then keep it (a write that throws changes nothing). */
  private commit(change: (m: Map<string, FaucetClaimRecord>) => void): void {
    const next = new Map(this.claims);
    change(next);
    this.write(next);
    this.claims.clear();
    for (const [w, r] of next) this.claims.set(w, r);
  }

  get(wallet: string): FaucetClaimRecord | undefined {
    const r = this.claims.get(wallet);
    return r ? { ...r } : undefined;
  }

  /** Records made in the current period (any state): the faucet's claims this period. */
  countInPeriod(): number {
    const cutoff = this.now() - this.o.periodSeconds;
    let n = 0;
    for (const r of this.claims.values()) if (r.at > cutoff) n++;
    return n;
  }

  reserve(wallet: string): FaucetClaimRecord {
    const r: FaucetClaimRecord = { at: this.now(), state: 'reserved' };
    this.commit((m) => m.set(wallet, r));
    return { ...r };
  }

  pending(wallet: string, signature: string, lastValidBlockHeight: number): void {
    const cur = this.claims.get(wallet);
    if (!cur) throw new FaucetClaimsError('no reservation to send');
    this.commit((m) => m.set(wallet, { at: cur.at, state: 'pending', signature, lastValidBlockHeight }));
  }

  claimed(wallet: string): FaucetClaimRecord {
    const cur = this.claims.get(wallet);
    if (!cur) throw new FaucetClaimsError('no claim to confirm');
    const r: FaucetClaimRecord = { ...cur, state: 'claimed', claimedAt: this.now() };
    this.commit((m) => m.set(wallet, r));
    return { ...r };
  }

  release(wallet: string): void {
    if (!this.claims.has(wallet)) return;
    this.commit((m) => m.delete(wallet));
  }
}
