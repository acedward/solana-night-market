// AA 00060 P11 (light review L-B1): whether the LAST read of an account on Midnight succeeded. A failed
// refresh leaves the browser's coins as they were, so a view that sums them with a fresh Solana read would
// show a stale total. Every view of a bridged token reads this: after a failed Midnight read, the Midnight
// line is "unavailable" and there is no total (as after a failed Solana read). `syncAccount` records it.

import { useSyncExternalStore } from 'react';

export type MidnightRead = { ok: true } | { ok: false; why: string };

const reads = new Map<string, MidnightRead>();
const listeners = new Set<() => void>();
const key = (account: string) => account.replace(/^0x/, '').toLowerCase();

/** Record the outcome of a read of `account` on Midnight. */
export function noteMidnightRead(account: string, outcome: MidnightRead): void {
  const k = key(account);
  const before = reads.get(k);
  if (before && before.ok === outcome.ok && (before.ok || (!outcome.ok && before.why === outcome.why))) return;
  reads.set(k, outcome);
  for (const l of listeners) l();
}

/** Why the last read of `account` on Midnight failed, or null (it succeeded, or none was made yet). */
export function midnightReadFailure(account: string | null | undefined): string | null {
  if (!account) return null;
  const r = reads.get(key(account));
  return r && !r.ok ? r.why : null;
}

/** `midnightReadFailure`, followed as it changes. */
export function useMidnightReadFailure(account: string | null | undefined): string | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => midnightReadFailure(account),
    () => null,
  );
}

/** Tests: forget every recorded read. */
export function resetMidnightReads(): void {
  reads.clear();
  for (const l of listeners) l();
}
