// Network profiles. Every endpoint is configuration: a profile is a set of defaults, and any field
// can be overridden by the relay's env or the site's config.json.
//
// Only PUBLIC endpoints live here. The sponsor seed and the proof servers' internal URLs are
// relay-only configuration and never reach the browser.

import { z } from 'zod';

export const NETWORK_NAMES = ['undeployed', 'stagenet'] as const;
export type NetworkName = (typeof NETWORK_NAMES)[number];

const url = z.url();

export const NetworkProfileSchema = z.object({
  name: z.enum(NETWORK_NAMES),
  /** The Midnight network id the SDK is set to (`setNetworkId`). */
  midnightNetworkId: z.string().min(1),
  midnight: z.object({
    nodeUrl: url,
    nodeWsUrl: url,
    indexerUrl: url,
    indexerWsUrl: url,
    /** A block explorer for Midnight transactions, when there is one. */
    explorerUrl: url.optional(),
  }),
  zswap: z.object({
    /** The offer-files kernel API (`/v1/offers`, `/v1/pairs`, …). */
    kernelUrl: url,
    /** The batcher (`POST /send-input`). */
    batcherUrl: url,
    batcherTarget: z.string().min(1),
    /** The public exchange site, for links. */
    siteUrl: url.optional(),
  }),
});
export type NetworkProfile = z.infer<typeof NetworkProfileSchema>;

/** The live staging network: the stagenet node and indexer, and the staging ZSwap exchange. */
export const STAGENET: NetworkProfile = {
  name: 'stagenet',
  midnightNetworkId: 'stagenet',
  midnight: {
    nodeUrl: 'https://rpc.stagenet.shielded.tools',
    nodeWsUrl: 'wss://rpc.stagenet.shielded.tools',
    indexerUrl: 'https://indexer.stagenet.shielded.tools/api/v4/graphql',
    indexerWsUrl: 'wss://indexer.stagenet.shielded.tools/api/v4/graphql/ws',
  },
  zswap: {
    kernelUrl: 'https://stagenet.api-zswap.zkdojo.com',
    batcherUrl: 'https://stagenet.batcher-zswap.zkdojo.com',
    batcherTarget: 'midnight-balancer',
    siteUrl: 'https://stagenet.zswap.zkdojo.com',
  },
};

/** The local ledger-9 stack: in-network DNS names, as a relay container on
 *  `${COMPOSE_PROJECT_NAME}_default` sees them. */
export const UNDEPLOYED: NetworkProfile = {
  name: 'undeployed',
  midnightNetworkId: 'undeployed',
  midnight: {
    nodeUrl: 'http://node:9944',
    nodeWsUrl: 'ws://node:9944',
    indexerUrl: 'http://indexer:8088/api/v4/graphql',
    indexerWsUrl: 'ws://indexer:8088/api/v4/graphql/ws',
  },
  zswap: {
    kernelUrl: 'http://kernel:9999',
    batcherUrl: 'http://batcher:3334',
    batcherTarget: 'midnight-balancer',
  },
};

export const PROFILES: Readonly<Record<NetworkName, NetworkProfile>> = { stagenet: STAGENET, undeployed: UNDEPLOYED };

/** Each network's default asset set (plan 00046): the symbols a site shows when its
 *  `config.json` names no `assets` of its own. This is DATA beside the profiles, never a rule in
 *  code: no symbol here is special. `null` shows every token of the registry. */
export const NETWORK_DEFAULT_ASSETS: Readonly<Record<NetworkName, readonly string[] | null>> = {
  stagenet: null,
  undeployed: null,
};

/** Each network's default pairs (`BASE/QUOTE`), when a site's `config.json` names no `pairs`. DATA,
 *  like the asset sets: any two shielded tokens make a pair, and none is special. `null` lists every
 *  pair of shielded tokens (the local stack). */
export const NETWORK_DEFAULT_PAIRS: Readonly<Record<NetworkName, readonly string[] | null>> = {
  stagenet: ['twBTC/twUSDC', 'twETH/twUSDC', 'twUSDM/twUSDC', 'twETH/twBTC'],
  undeployed: null,
};

/** A partial profile: any subset of fields, nested. */
export type NetworkOverrides = {
  [K in keyof Omit<NetworkProfile, 'name'>]?: NetworkProfile[K] extends object
    ? Partial<NetworkProfile[K]>
    : NetworkProfile[K];
};

export class NetworkConfigError extends Error {
  override name = 'NetworkConfigError';
}

export function isNetworkName(value: unknown): value is NetworkName {
  return typeof value === 'string' && (NETWORK_NAMES as readonly string[]).includes(value);
}

/** The profile for `name` with `overrides` applied, validated. Unknown keys are refused. */
export function resolveNetwork(name: string, overrides: NetworkOverrides = {}): NetworkProfile {
  if (!isNetworkName(name))
    throw new NetworkConfigError(`unknown network "${name}" (expected ${NETWORK_NAMES.join(' or ')})`);
  const base = PROFILES[name];
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (!(key in base) || key === 'name') throw new NetworkConfigError(`unknown network setting "${key}"`);
    const current = (base as Record<string, unknown>)[key];
    if (value === undefined) continue;
    if (current !== null && typeof current === 'object' && typeof value === 'object' && value !== null) {
      for (const sub of Object.keys(value)) {
        if (!(sub in current)) {
          const optional = ['explorerUrl', 'siteUrl'];
          if (!optional.includes(sub)) throw new NetworkConfigError(`unknown network setting "${key}.${sub}"`);
        }
      }
      const defined = Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined));
      merged[key] = { ...current, ...defined };
    } else {
      merged[key] = value;
    }
  }
  const parsed = NetworkProfileSchema.safeParse(merged);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new NetworkConfigError(`invalid ${name} network settings: ${issues}`);
  }
  return parsed.data;
}
