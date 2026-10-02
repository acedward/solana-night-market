// The page's one chain reader (./indexer.ts), for the site's network: the public indexer, read
// straight from the browser (AA 00047 P9.S, questions Q26 A). And the account check every page shows:
// whether the account this browser holds for the connected wallet is the market's own, controlled by
// this wallet alone (audit C3).

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import type { NetworkProfile } from '@nightmarket/core';
import type { AccountCheck, AccountCheckProblem } from '@nightmarket/core/passport';

import { ChainReader, indexerWsUrlOf } from './indexer.js';

const Ctx = createContext<ChainReader | null>(null);

export function ChainProvider({ network, children }: { network: NetworkProfile; children: ReactNode }) {
  const reader = useMemo(
    () =>
      new ChainReader({
        indexerUrl: network.midnight.indexerUrl,
        // The account's history past the indexer's newest page is streamed (AA 00047 P11.B).
        indexerWsUrl: indexerWsUrlOf(network.midnight),
        networkId: network.midnightNetworkId,
      }),
    [network],
  );
  return <Ctx.Provider value={reader}>{children}</Ctx.Provider>;
}

/** The chain reader of the site's network. */
export function useChain(): ChainReader {
  const c = useContext(Ctx);
  if (!c) throw new Error('useChain needs a ChainProvider');
  return c;
}

export type AccountCheckState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'ok'; blockHeight: number }
  | { status: 'failed'; problems: AccountCheckProblem[]; blockHeight: number | null }
  | { status: 'error'; message: string };

/** What the page shows for a finished check (AA 00047 P11, R3-10): a check that fails ONLY because
 *  the indexer does not show the account's deploy yet is a read error (temporary: actions wait and it
 *  is read again), never a failed check. */
export function checkStateOf(
  check: AccountCheck,
  blockHeight: number | null,
): Exclude<AccountCheckState, { status: 'idle' } | { status: 'checking' }> {
  if (check.ok) return { status: 'ok', blockHeight: blockHeight ?? 0 };
  const unknown = check.problems.filter((p) => p.code === 'provenance-unknown');
  if (unknown.length > 0 && unknown.length === check.problems.length)
    return { status: 'error', message: unknown[0]!.message };
  return {
    status: 'failed',
    problems: check.problems.filter((p) => p.code !== 'provenance-unknown'),
    blockHeight,
  };
}

/**
 * The market-account check of `account` for this wallet and this browser's encryption key, read
 * from the chain: again whenever `revision` changes (a store write: a finished action, an import).
 * `refusedAtOpen` is the account's kept refusal from its opening (AA 00047 P10, R2-6: not fresh or
 * not empty then), which no later read can clear: the check fails with it, whatever the chain says now.
 * `deployTx` is the deploy transaction recorded at opening, read when the indexer has no deploy record
 * (AA 00047 P11, R3-10); while the account's origin cannot be judged yet, the check is an `error`
 * (actions wait and it is read again), never a refusal.
 */
export function useAccountCheck(
  account: string | null,
  deviceKey: string | null,
  encPublicKey: string | null,
  revision = 0,
  refusedAtOpen?: readonly AccountCheckProblem[] | null,
  deployTx?: string | null,
): AccountCheckState & { reload: () => void } {
  const chain = useChain();
  const [state, setState] = useState<AccountCheckState>({ status: 'idle' });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!account || !deviceKey || !encPublicKey) return;
    let live = true;
    let settled = false;
    // "Checking…" only while the read is out (a read that fails at once, e.g. refused by a
    // Content-Security-Policy, settles before this runs and must not be overwritten).
    const t = setTimeout(
      () => live && !settled && setState((s) => (s.status === 'ok' ? s : { status: 'checking' })),
      0,
    );
    chain.checkAccount(account, { deviceKey, encPublicKey, deployTx: deployTx ?? null }).then(
      ({ state: s, check }) => {
        settled = true;
        if (!live) return;
        setState(checkStateOf(check, s?.blockHeight ?? null));
      },
      (e: unknown) => {
        settled = true;
        if (live)
          setState({ status: 'error', message: e instanceof Error ? e.message : 'The chain could not be read.' });
      },
    );
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [chain, account, deviceKey, encPublicKey, revision, tick, deployTx]);
  const reload = () => setTick((n) => n + 1);
  if (account && refusedAtOpen?.length)
    return { status: 'failed', problems: [...refusedAtOpen], blockHeight: null, reload };
  return { ...state, reload };
}
