// AA 00060 P12.1d (spec FR-025): ONE Solana read for every view of the bridged tokens. The Portfolio's rows
// (FR-020) and the compact "Your tokens" list beside the books (FR-025) both show the wallet's SPL balance
// of each I-1 mint; this provider reads it once (./portfolio.ts `useSolanaLines`, on the site's Solana RPC,
// never the injector) and both views read the same lines, so moving between pages reads nothing again.
//
// It reads only once a view needs it (`useSolanaHoldings` reports the account's bridged coins), again when
// those coins change (a bridge in or out landed) and on `refresh()` ("Refresh balances", a faucet claim).

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import type { StoredCoin } from '@nightmarket/core';
import type { BridgeEntry } from '@nightmarket/core/bridge';

import { useWallet } from '../wallet/WalletContext.js';
import { useBridges } from './BridgeContext.js';
import { bridgedCoinsKey, solanaLineRpc, useSolanaLines, type LineRead } from './portfolio.js';
import type { BridgeCheck } from './registry.js';

interface SolanaLinesValue {
  /** The registry's entries (empty when bridging is not ready). */
  entries: readonly BridgeEntry[];
  /** The wallet's SPL balance by mint. */
  lines: ReadonlyMap<string, LineRead>;
  /** Read again. */
  refresh(): void;
  /** A view's account coins of the bridged colours (`bridgedCoinsKey`). */
  coinsChanged(key: string): void;
  /** P11 (light review L-B2): the Solana RPC every balance read uses, after the config check
   *  (`solanaLineRpc`: the site's Solana RPC, never its injector's origin), or null (no bridging). */
  rpc: { url: string } | { refused: string } | null;
}

const NONE: SolanaLinesValue = {
  entries: [],
  lines: new Map(),
  refresh: () => undefined,
  coinsChanged: () => undefined,
  rpc: null,
};
const Ctx = createContext<SolanaLinesValue>(NONE);

export function SolanaLinesProvider({
  injectorUrl,
  children,
}: {
  /** config.json `injector.url`: the Solana line never reads it (the config check). */
  injectorUrl: string | null;
  children: ReactNode;
}) {
  const bridges = useBridges();
  const wallet = useWallet();
  return (
    <SolanaLinesSource
      bridges={bridges}
      walletAddress={wallet.status === 'connected' ? wallet.address : null}
      injectorUrl={injectorUrl}
    >
      {children}
    </SolanaLinesSource>
  );
}

/** The provider's state, given the bridge check and the connected wallet (tests use it directly). */
export function SolanaLinesSource({
  bridges,
  walletAddress,
  injectorUrl,
  fetchImpl,
  children,
}: {
  bridges: BridgeCheck | { state: 'checking' };
  walletAddress: string | null;
  injectorUrl: string | null;
  fetchImpl?: typeof fetch;
  children: ReactNode;
}) {
  const entries = useMemo(() => (bridges.state === 'ready' ? bridges.registry.entries : []), [bridges]);
  const rpc = useMemo(
    () => (bridges.state === 'ready' ? solanaLineRpc(bridges.solana, injectorUrl) : null),
    [bridges, injectorUrl],
  );
  const [refreshes, setRefreshes] = useState(0);
  // null until a view needs the lines: nothing is read for a page that shows none.
  const [coinsKey, setCoinsKey] = useState<string | null>(null);
  const owner = coinsKey !== null ? walletAddress : null;
  const lines = useSolanaLines(rpc, owner, entries, `${refreshes}|${coinsKey ?? ''}`, fetchImpl);
  const refresh = useCallback(() => setRefreshes((n) => n + 1), []);
  const coinsChanged = useCallback((key: string) => setCoinsKey(key), []);
  const value = useMemo(
    () => ({ entries, lines, refresh, coinsChanged, rpc }),
    [entries, lines, refresh, coinsChanged, rpc],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** The bridged tokens' Solana lines for a view showing `coins` (the account's coins, unfiltered). */
export function useSolanaHoldings(coins: readonly StoredCoin[]): Omit<SolanaLinesValue, 'coinsChanged'> {
  const { entries, lines, refresh, coinsChanged, rpc } = useContext(Ctx);
  const key = bridgedCoinsKey(coins, entries);
  useEffect(() => {
    if (entries.length > 0) coinsChanged(key);
  }, [key, entries.length, coinsChanged]);
  return { entries, lines, refresh, rpc };
}

/** P11 (light review L-B2): the checked Solana RPC (`solanaLineRpc`) for any other Solana balance read. */
export function useSolanaRpcGuard(): SolanaLinesValue['rpc'] {
  return useContext(Ctx).rpc;
}
