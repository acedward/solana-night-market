// The token registry: every token the market lists.
//
// No token is special (owner rule): a token has a symbol, a name, its decimals, its privacy and
// its colour on Midnight, and nothing else. Which tokens trade against which is the configured
// list of pairs (./pairs.ts), never a property of a token.
//
// The stagenet registry is the mint-test-tokens faucet registry, vendored beside this file byte for
// byte (mint-test-tokens/PROVENANCE.md): six native test tokens, each with a permissionless faucet
// contract. Configuration may add tokens the market deploys itself (same faucet contract, other
// names), or replace the list entirely (a local stack, whose colours are new on every run).

import { z } from 'zod';

import { normaliseHex32 } from '../hex.js';
import type { NetworkName } from '../network.js';
import stagenetRecord from './mint-test-tokens/metadata.stagenet.json';

export const TOKEN_PRIVACIES = ['shielded', 'unshielded'] as const;
export type TokenPrivacy = (typeof TOKEN_PRIVACIES)[number];

/** Where a registry entry came from. */
export interface TokenSource {
  repo: string;
  commit: string;
  file: string;
}

export interface TokenEntry {
  /** The token's symbol: twUSDC, twBTC, … Unique in a registry (without regard to case). */
  symbol: string;
  /** Its full name ("Test-wrapped USDC"). */
  name: string;
  decimals: number;
  /** Shielded tokens trade on the exchange (the swap circuit is `open_swap_shielded`); unshielded
   *  ones are held and shown only. */
  privacy: TokenPrivacy;
  /** The token's raw type on Midnight (the colour its coins carry), 64 lowercase hex. */
  midnightColour: string;
  /** The issuer (faucet) contract's address, 64 lowercase hex; '' when unknown. */
  contract: string;
  /** The issuer's domain separator (`mint-test-tokens:<symbol>`); '' when unknown. */
  domainSeparator: string;
  source: TokenSource | null;
}

export class TokenRegistryError extends Error {
  override name = 'TokenRegistryError';
}

export class TokenRegistry {
  readonly tokens: readonly TokenEntry[];
  private readonly byColourMap: Map<string, TokenEntry>;
  private readonly bySymbolMap: Map<string, TokenEntry>;

  constructor(
    readonly network: NetworkName,
    tokens: readonly TokenEntry[],
  ) {
    if (tokens.length === 0) throw new TokenRegistryError('a registry needs at least one token');
    this.byColourMap = new Map();
    this.bySymbolMap = new Map();
    for (const t of tokens) {
      if (!Number.isInteger(t.decimals) || t.decimals < 0 || t.decimals > 18) {
        throw new TokenRegistryError(`${t.symbol}: decimals ${t.decimals} out of range`);
      }
      if (this.byColourMap.has(t.midnightColour)) throw new TokenRegistryError(`duplicate colour ${t.midnightColour}`);
      const key = t.symbol.toLowerCase();
      if (this.bySymbolMap.has(key)) throw new TokenRegistryError(`duplicate symbol ${t.symbol}`);
      this.byColourMap.set(t.midnightColour, t);
      this.bySymbolMap.set(key, t);
    }
    this.tokens = Object.freeze([...tokens]);
  }

  /** The entry for a Midnight colour (any hex case, with or without 0x), or undefined. */
  byColour(colour: string): TokenEntry | undefined {
    try {
      return this.byColourMap.get(normaliseHex32(colour));
    } catch {
      return undefined;
    }
  }

  /** The entry for a symbol, without regard to case, or undefined. */
  bySymbol(symbol: string): TokenEntry | undefined {
    return this.bySymbolMap.get(symbol.trim().toLowerCase());
  }

  /** The tokens that can trade on the exchange, in registry order. */
  shielded(): TokenEntry[] {
    return this.tokens.filter((t) => t.privacy === 'shielded');
  }
}

// ── The stagenet registry, from the vendored mint-test-tokens file ──────────

export const STAGENET_SOURCE: TokenSource = {
  repo: 'effectstream/mint-test-tokens',
  commit: 'a51cf3ad46520d1ded938fb86db8b7b99373ce56',
  file: 'metadata/metadata.stagenet.json',
};

/** The part of the upstream registry file the market reads (the rest is kept, unread). */
const RegistryFileSchema = z.object({
  status: z.literal('ready'),
  network: z.object({ key: z.string() }),
  tokens: z.array(
    z.object({
      symbol: z.string().min(1),
      name: z.string().min(1),
      decimals: z.number().int().min(0).max(18),
      privacy: z.enum(TOKEN_PRIVACIES),
      domainSeparator: z.string().min(1),
      activeDeploymentId: z.string().min(1),
      deployments: z.array(
        z.object({
          deploymentId: z.string(),
          status: z.string(),
          contractAddress: z.string().regex(/^[0-9a-f]{64}$/),
          tokenId: z.string().regex(/^[0-9a-f]{64}$/),
        }),
      ),
    }),
  ),
});

/** The registry a mint-test-tokens registry file describes: each token's ACTIVE deployment. */
export function registryFromMintTestTokens(network: NetworkName, file: unknown, source: TokenSource): TokenRegistry {
  const parsed = RegistryFileSchema.safeParse(file);
  if (!parsed.success) throw new TokenRegistryError('the mint-test-tokens registry is not in the expected shape');
  if (parsed.data.network.key !== network) {
    throw new TokenRegistryError(`the mint-test-tokens registry is for ${parsed.data.network.key}, not ${network}`);
  }
  const tokens = parsed.data.tokens.map((t): TokenEntry => {
    const active = t.deployments.find((d) => d.deploymentId === t.activeDeploymentId && d.status === 'active');
    if (!active) throw new TokenRegistryError(`${t.symbol}: no active deployment`);
    return {
      symbol: t.symbol,
      name: t.name,
      decimals: t.decimals,
      privacy: t.privacy,
      midnightColour: normaliseHex32(active.tokenId),
      contract: normaliseHex32(active.contractAddress),
      domainSeparator: t.domainSeparator,
      source,
    };
  });
  return new TokenRegistry(network, tokens);
}

export function stagenetRegistry(): TokenRegistry {
  return registryFromMintTestTokens('stagenet', stagenetRecord, STAGENET_SOURCE);
}

// ── Registries from configuration (market-deployed tokens, or a local stack) ─

export const TokenConfigSchema = z.object({
  /** `extend` (the default) adds these tokens to the network's built-in list; `replace` makes them
   *  the whole list (a local stack). A network with no built-in list always takes them as the list. */
  mode: z.enum(['extend', 'replace']).default('extend'),
  tokens: z
    .array(
      z.object({
        symbol: z.string().regex(/^[A-Za-z0-9._-]{1,16}$/),
        name: z.string().min(1).max(64).optional(),
        decimals: z.number().int().min(0).max(18),
        privacy: z.enum(TOKEN_PRIVACIES).default('shielded'),
        midnightColour: z.string().regex(/^(0x)?[0-9a-fA-F]{64}$/),
        contract: z
          .string()
          .regex(/^([0-9a-fA-F]{64})?$/)
          .default(''),
        domainSeparator: z.string().max(64).default(''),
      }),
    )
    .min(1),
});
export type TokenConfig = z.input<typeof TokenConfigSchema>;

function configuredTokens(config: unknown): { mode: 'extend' | 'replace'; tokens: TokenEntry[] } {
  const parsed = TokenConfigSchema.safeParse(config);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new TokenRegistryError(`invalid token configuration: ${issues}`);
  }
  return {
    mode: parsed.data.mode,
    tokens: parsed.data.tokens.map((t) => ({
      symbol: t.symbol,
      name: t.name ?? t.symbol,
      decimals: t.decimals,
      privacy: t.privacy,
      midnightColour: normaliseHex32(t.midnightColour),
      contract: t.contract === '' ? '' : normaliseHex32(t.contract),
      domainSeparator: t.domainSeparator,
      source: null,
    })),
  };
}

/** The built-in token list of a network, or null when it has none (the local stack). */
function builtIn(network: NetworkName): TokenRegistry | null {
  return network === 'stagenet' ? stagenetRegistry() : null;
}

/** Build a registry from JSON configuration alone (a local stack's colours). */
export function registryFromConfig(network: NetworkName, config: unknown): TokenRegistry {
  return new TokenRegistry(network, configuredTokens(config).tokens);
}

/** The registry for a network: its built-in list, extended (or replaced) by `config` when given.
 *  The local stack has no built-in list, so it always needs configuration. */
export function registryFor(network: NetworkName, config?: unknown): TokenRegistry {
  const base = builtIn(network);
  if (config === undefined) {
    if (base) return base;
    throw new TokenRegistryError(`the ${network} network has no built-in token list; pass a token configuration`);
  }
  const { mode, tokens } = configuredTokens(config);
  if (mode === 'replace' || !base) return new TokenRegistry(network, tokens);
  return new TokenRegistry(network, [...base.tokens, ...tokens]);
}
