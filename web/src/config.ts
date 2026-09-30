// The site's runtime configuration: `config.json` next to index.html, so a deployment can point
// the same build at another network or relay without rebuilding. Anything missing falls back to
// the stagenet profile.

import {
  NETWORK_DEFAULT_ASSETS,
  type NetworkOverrides,
  type NetworkProfile,
  registryFor,
  resolveNetwork,
} from '@nightmarket/core';

import { resolveSiteAssets } from './assets/filter.js';

export interface SiteConfig {
  network: NetworkProfile;
  /** The relay's base URL ('' until the lanes call it). */
  relayUrl: string;
  /** Tokens the market adds to the network's built-in list (stagenet's is the vendored
   *  mint-test-tokens registry), or the whole list (`mode: "replace"`, or a network with none, the
   *  local stack). */
  tokens?: unknown;
  /** The site's pairs, `BASE/QUOTE` by symbol (`["twBTC/twUSDC", …]`); undefined: the network's
   *  default pairs. Data, like `assets`: no token is special. */
  pairs?: unknown;
  /** This site's asset set (plan 00046), from `assets` (a list of symbols, or "all") or the
   *  network's default set (which belongs to the built-in token list: a site that configures its
   *  own `tokens` shows all of them unless it names `assets`); null = every asset. Each domain
   *  serves the same build with its own `config.json`, and the page's `?assets=` list only narrows
   *  within this set. */
  assets: string[] | null;
  /** How long the page waits for the Solana wallet to answer a connection or a signature, in
   *  seconds (`walletTimeoutSeconds`, 5–600; default 120). */
  walletTimeoutSeconds: number;
}

export const DEFAULT_WALLET_TIMEOUT_SECONDS = 120;

const walletTimeout = (v: unknown): number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 5 && v <= 600 ? v : DEFAULT_WALLET_TIMEOUT_SECONDS;

export async function loadSiteConfig(fetchImpl: typeof fetch = fetch): Promise<SiteConfig> {
  let raw: {
    network?: unknown;
    relayUrl?: unknown;
    overrides?: unknown;
    tokens?: unknown;
    pairs?: unknown;
    assets?: unknown;
    walletTimeoutSeconds?: unknown;
  } = {};
  try {
    const res = await fetchImpl('./config.json', { cache: 'no-store' });
    if (res.ok) raw = (await res.json()) as typeof raw;
  } catch {
    /* no config.json: defaults */
  }
  const name = typeof raw.network === 'string' ? raw.network : 'stagenet';
  const overrides = raw.overrides && typeof raw.overrides === 'object' ? (raw.overrides as NetworkOverrides) : {};
  const network = resolveNetwork(name, overrides);
  return {
    network,
    relayUrl: typeof raw.relayUrl === 'string' ? raw.relayUrl : '',
    ...(raw.tokens !== undefined ? { tokens: raw.tokens } : {}),
    ...(raw.pairs !== undefined ? { pairs: raw.pairs } : {}),
    assets: siteAssets(network, raw.tokens, raw.assets),
    walletTimeoutSeconds: walletTimeout(raw.walletTimeoutSeconds),
  };
}

/** Resolve the site's set against the market's token list, naming any configuration problem in the
 *  console. Without a token list (the markets then say why), every asset is the set. */
function siteAssets(network: NetworkProfile, tokens: unknown, configured: unknown): string[] | null {
  let registry;
  try {
    registry = registryFor(network.name, tokens);
  } catch {
    return null;
  }
  const networkDefault = NETWORK_DEFAULT_ASSETS[network.name];
  const { set, warnings } = resolveSiteAssets(configured, networkDefault, registry.tokens);
  for (const w of warnings) console.warn(`Night Market: ${w}`);
  return set;
}
