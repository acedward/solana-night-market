// AA 00060 P4.3: the site's bridge registry, checked once when the page opens (./registry.ts), for the
// bridge pages (L-IN, L-OUT) and a notice where bridging would be offered. Without `bridges` in
// config.json there is nothing to show.

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

import type { NetworkName } from '@nightmarket/core';

import type { SolanaRpcConfig } from '../config.js';
import { Notice } from '../design/index.js';
import { checkBridges, type BridgeCheck } from './registry.js';

type BridgeState = BridgeCheck | { state: 'checking' };
const Ctx = createContext<BridgeState>({ state: 'none' });

export function BridgeProvider({
  bridges,
  network,
  solana,
  children,
}: {
  bridges: unknown;
  network: NetworkName;
  solana: SolanaRpcConfig | null | undefined;
  children: ReactNode;
}) {
  const [state, setState] = useState<BridgeState>(bridges === undefined ? { state: 'none' } : { state: 'checking' });
  useEffect(() => {
    let live = true;
    void checkBridges(bridges, network, solana).then(
      (s) => live && setState(s),
      () =>
        live &&
        setState({ state: 'refused', reason: 'Bridging is unavailable: the token registry could not be checked.' }),
    );
    return () => {
      live = false;
    };
  }, [bridges, network, solana]);
  return <Ctx.Provider value={state}>{children}</Ctx.Provider>;
}

export const useBridges = (): BridgeState => useContext(Ctx);

/** Why bridging is unavailable, where it would be offered (nothing when it is fine or not set up). */
export function BridgeNotice() {
  const s = useBridges();
  if (s.state !== 'refused') return null;
  return (
    <Notice tone="warning" role="status" data-testid="bridge-unavailable">
      {s.reason}
    </Notice>
  );
}
