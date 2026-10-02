// The live markets for the whole app: one feed per page load, started while at least one
// component shows prices (the Markets page, the Trade page) and stopped when none does, so a page
// without prices makes no exchange request.
//
// The markets are the site's configured pairs (`config.json` `pairs`, or the network's default
// list): any two shielded tokens, none special (AA 00047). Holdings are shown in each token's own
// units; nothing is totalled in a "home" currency.

import { createContext, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react';

import {
  type FeedState,
  KernelClient,
  MarketFeed,
  type MarketPair,
  NETWORK_DEFAULT_PAIRS,
  type NetworkProfile,
  type TokenRegistry,
  registryFor,
  resolvePairs,
} from '@nightmarket/core';

interface MarketsContext {
  feed: MarketFeed | null;
  registry: TokenRegistry | null;
  pairs: readonly MarketPair[];
  /** Why there is no feed (for example a network without a token list). */
  error: string | null;
  kernelUrl: string;
}

/** How many mounted components use each feed. */
const users = new WeakMap<MarketFeed, number>();

const Ctx = createContext<MarketsContext | null>(null);

export function MarketProvider({
  network,
  tokens,
  pairs: configuredPairs,
  children,
}: {
  network: NetworkProfile;
  /** The site configuration's token list (extends, or replaces, the network's built-in one). */
  tokens?: unknown;
  /** The site configuration's pairs (`BASE/QUOTE`), or undefined for the network's default. */
  pairs?: unknown;
  children: ReactNode;
}) {
  const ctx = useMemo<MarketsContext>(() => {
    let registry: TokenRegistry | null = null;
    let error: string | null = null;
    try {
      registry = registryFor(network.name, tokens);
    } catch (e) {
      error = e instanceof Error ? e.message : 'no token list';
    }
    let pairs: MarketPair[] = [];
    if (registry) {
      const resolved = resolvePairs(registry, configuredPairs, NETWORK_DEFAULT_PAIRS[network.name]);
      for (const w of resolved.warnings) console.warn(`Night Market: ${w}`);
      pairs = resolved.pairs;
    }
    const feed = registry
      ? new MarketFeed({ client: new KernelClient({ baseUrl: network.zswap.kernelUrl }), registry, pairs })
      : null;
    return { feed, registry, pairs, error, kernelUrl: network.zswap.kernelUrl };
  }, [network, tokens, configuredPairs]);
  useEffect(() => () => ctx.feed?.stop(), [ctx]);
  return <Ctx.Provider value={ctx}>{children}</Ctx.Provider>;
}

/** The market's token list (the network's built-in one, as the site configuration extends it),
 *  WITHOUT starting the price feed: for views that only name tokens. */
export function useTokenRegistry(): TokenRegistry | null {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useTokenRegistry outside MarketProvider');
  return ctx.registry;
}

/** The site's pairs, in display order, WITHOUT starting the price feed. */
export function usePairs(): readonly MarketPair[] {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('usePairs outside MarketProvider');
  return ctx.pairs;
}

export interface MarketsValue {
  state: FeedState;
  registry: TokenRegistry | null;
  pairs: readonly MarketPair[];
  error: string | null;
  kernelUrl: string;
  /** Refresh now (coalesced with a refresh already running). */
  refresh(): void;
}

const LOADING: FeedState = { status: 'loading', stream: 'off' };
const noop = () => () => {};

export function useMarkets(): MarketsValue {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useMarkets outside MarketProvider');
  const { feed, registry, pairs } = ctx;

  useEffect(() => {
    if (!feed) return;
    users.set(feed, (users.get(feed) ?? 0) + 1);
    feed.start();
    return () => {
      const left = (users.get(feed) ?? 1) - 1;
      users.set(feed, left);
      if (left === 0) feed.stop();
    };
  }, [feed]);

  const state = useSyncExternalStore(feed ? (cb) => feed.subscribe(cb) : noop, () =>
    feed ? feed.getState() : LOADING,
  );

  return useMemo<MarketsValue>(
    () => ({
      state,
      registry,
      pairs,
      error: ctx.error,
      kernelUrl: ctx.kernelUrl,
      refresh: () => void feed?.refresh(),
    }),
    [state, registry, pairs, feed, ctx.error, ctx.kernelUrl],
  );
}
