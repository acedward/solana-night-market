// AA 00060 P4.1 (spec FR-013): the site's and the relay's token lists, pairs and bridge registry,
// generated from ONE journey registry (I-1), so the two lists cannot drift apart. `scripts/bridge-tokens.ts`
// is the command line around `bridgeTokenLists`.
//
// A bridged token becomes an ordinary token of both lists (owner rule: no special token): its symbol,
// name and decimals as I-1 gives them, privacy `shielded`, its colour, and its bridge contract as the
// issuer. What only the bridge pages need (the SPL mint, program, contract and API) goes into the site's
// separate `bridges` object, never into the token entries.
//
// The generator refuses (BridgeTokensError, each with a named reason):
//   - everything the I-1 parser refuses (./registry.ts: the network and genesis hash, malformed fields, a
//     symbol the arm cannot render, decimals, duplicates, a colour that is not the bridge's);
//   - a symbol that collides with a token the site already lists (`symbol-collision`), or a colour
//     already listed (`colour-listed`);
//   - with the Solana RPC's facts: a mint the RPC does not have (`mint-not-found`), one owned by
//     Token-2022 (`token-2022`) or by any other program than the classic Token program
//     (`not-spl-token`), or whose on-chain decimals differ from I-1's (`decimals-mismatch`);
//   - a pair naming a symbol neither list has (`unknown-pair-token`), and site and relay lists that would
//     still differ (`lists-differ`: the existing relay file and site config did not agree to begin with).
//
// P12.1b (spec FR-022): with `icons`, each SITE token entry without an icon gets its Midnight icon by
// symbol, and each `bridges` entry without one its SPL icon. Icons are display only: the relay's list
// is written without them, and the digest never includes them.

import { PROFILES, isNetworkName, type NetworkName } from '../network.js';
import { tokensDigest } from '../tokens/digest.js';
import { siteIconPath } from '../tokens/icon.js';
import { type TokenRegistry, registryFor, type TokenConfig } from '../tokens/registry.js';
import { BridgeRegistryError, parseJourneyRegistry, type BridgeEntry } from './registry.js';

export const CLASSIC_TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

export type BridgeTokensRefusal =
  | BridgeRegistryError['reason']
  | 'bad-site-config'
  | 'symbol-collision'
  | 'colour-listed'
  | 'mint-not-found'
  | 'token-2022'
  | 'not-spl-token'
  | 'decimals-mismatch'
  | 'unknown-pair-token'
  | 'lists-differ';

export class BridgeTokensError extends Error {
  override name = 'BridgeTokensError';
  constructor(
    readonly reason: BridgeTokensRefusal,
    message: string,
  ) {
    super(`${reason}: ${message}`);
  }
}

/** What the Solana RPC says about the chain and each mint (read by the command line). */
export interface SolanaFacts {
  genesisHash: string;
  /** By mint (base58): the owning program and, for an SPL mint, its decimals. Absent: no such account. */
  mints: Record<string, { owner: string; decimals: number | null } | undefined>;
}

export interface BridgeTokenListsInput {
  /** The I-1 file (`journey-tokens.<net>.json`), parsed JSON. */
  journey: unknown;
  /** The site's current `config.json` (its `network`, and `tokens` / `pairs` if any). */
  siteConfig: Record<string, unknown>;
  /** The relay's current `TOKENS_FILE` content, if any. */
  relayTokens?: unknown;
  /** Pairs to add, `BASE/QUOTE` by symbol. */
  pairs?: string[];
  /** `extend` (default): add the bridged tokens to the lists; `replace`: the bridged tokens ARE the lists. */
  mode?: 'extend' | 'replace';
  /** The Solana RPC's facts (the command line's `--solana-rpc`). */
  solana?: SolanaFacts;
  /** Icons to fill in by symbol (FR-022); entries that already name one keep it. */
  icons?: TokenIconMap;
}

/** Icons by token symbol (without regard to case), as paths on the site's own origin (../tokens/icon.ts). */
export interface TokenIconMap {
  /** The Midnight token's icon: the site's `tokens` entries. */
  midnight?: Readonly<Record<string, string>>;
  /** The SPL token's icon: the site's `bridges.tokens` entries. */
  solana?: Readonly<Record<string, string>>;
}

const iconFor = (map: Readonly<Record<string, string>> | undefined, symbol: unknown): string | null => {
  if (!map || typeof symbol !== 'string') return null;
  const key = Object.keys(map).find((k) => k.toLowerCase() === symbol.toLowerCase());
  return key ? siteIconPath(map[key]) : null;
};

/** `entry` with `icon` filled in from `map` when it names none (an invalid one is left as it is). */
function withIcon<T extends { symbol?: unknown; icon?: unknown }>(
  entry: T,
  map: Readonly<Record<string, string>> | undefined,
): T {
  if (entry.icon !== undefined) return entry;
  const icon = iconFor(map, entry.symbol);
  return icon ? { ...entry, icon } : entry;
}

export interface BridgeTokenLists {
  /** The site's config.json, with `tokens`, `pairs` and `bridges` written. */
  siteConfig: Record<string, unknown>;
  /** The relay's TOKENS_FILE. */
  relayTokens: TokenConfig;
  /** Both lists' digest (`GET /v1/config` `tokensDigest`). */
  tokensDigest: string;
  bridged: BridgeEntry[];
}

type ConfigToken = TokenConfig['tokens'][number];

const refuse = (reason: BridgeTokensRefusal, message: string): never => {
  throw new BridgeTokensError(reason, message);
};

function existingTokens(network: NetworkName, config: unknown): TokenRegistry | null {
  try {
    return registryFor(network, config);
  } catch {
    return null; // a network with no built-in list and no configuration: nothing listed yet
  }
}

const tokensOf = (config: unknown): { mode: 'extend' | 'replace'; tokens: ConfigToken[] } | null => {
  if (!config || typeof config !== 'object' || !Array.isArray((config as { tokens?: unknown }).tokens)) return null;
  const c = config as { mode?: unknown; tokens: ConfigToken[] };
  return { mode: c.mode === 'replace' ? 'replace' : 'extend', tokens: c.tokens };
};

export function bridgeTokenLists(input: BridgeTokenListsInput): BridgeTokenLists {
  const networkName = input.siteConfig.network ?? 'stagenet';
  if (typeof networkName !== 'string' || !isNetworkName(networkName)) {
    refuse('bad-site-config', `the site config's network ${JSON.stringify(networkName)} is not one Night Market knows`);
  }
  const network = networkName as NetworkName;
  let registry;
  try {
    registry = parseJourneyRegistry(input.journey, {
      midnightNetwork: PROFILES[network].midnightNetworkId,
      ...(input.solana ? { solanaGenesisHash: input.solana.genesisHash } : {}),
    });
  } catch (e) {
    if (e instanceof BridgeRegistryError) throw new BridgeTokensError(e.reason, e.message.replace(/^[a-z-]+: /, ''));
    throw e;
  }
  const mode = input.mode ?? 'extend';
  const siteBefore = mode === 'replace' ? null : existingTokens(network, input.siteConfig.tokens);
  for (const e of registry.entries) {
    const bySymbol = siteBefore?.bySymbol(e.symbol);
    if (bySymbol)
      refuse('symbol-collision', `${e.symbol} is already the symbol of ${bySymbol.midnightColour.slice(0, 16)}…`);
    if (siteBefore?.byColour(e.colour))
      refuse('colour-listed', `the colour of ${e.symbol} (${e.colour}) is already listed`);
    if (input.solana) {
      const m = input.solana.mints[e.splMint];
      if (!m) refuse('mint-not-found', `the Solana RPC has no mint ${e.splMint} (${e.symbol})`);
      if (m!.owner === TOKEN_2022_PROGRAM)
        refuse('token-2022', `${e.symbol}'s mint ${e.splMint} is a Token-2022 mint: it cannot be bridged`);
      if (m!.owner !== CLASSIC_TOKEN_PROGRAM)
        refuse('not-spl-token', `${e.symbol}'s mint ${e.splMint} is owned by ${m!.owner}, not the SPL Token program`);
      if (m!.decimals !== e.decimals)
        refuse('decimals-mismatch', `${e.symbol}: I-1 says ${e.decimals} decimals, the mint has ${m!.decimals}`);
    }
  }
  const bridged: ConfigToken[] = registry.entries.map((e) => ({
    symbol: e.symbol,
    name: e.name,
    decimals: e.decimals,
    privacy: 'shielded',
    midnightColour: e.colour,
    contract: e.bridgeContract,
    domainSeparator: '',
  }));
  const withBridged = (current: unknown): TokenConfig => {
    const t = mode === 'replace' ? null : tokensOf(current);
    return t
      ? { mode: t.mode, tokens: [...t.tokens, ...bridged] }
      : { mode: mode === 'replace' ? 'replace' : 'extend', tokens: bridged };
  };
  const siteListed = withBridged(input.siteConfig.tokens);
  const siteTokens: TokenConfig = input.icons?.midnight
    ? { ...siteListed, tokens: siteListed.tokens.map((t) => withIcon(t, input.icons?.midnight)) }
    : siteListed;
  const relayTokens = withBridged(input.relayTokens ?? input.siteConfig.tokens);
  let siteAfter: TokenRegistry;
  let relayAfter: TokenRegistry;
  try {
    siteAfter = registryFor(network, siteTokens);
    relayAfter = registryFor(network, relayTokens);
  } catch (e) {
    return refuse('bad-site-config', (e as Error).message);
  }
  const siteDigest = tokensDigest(siteAfter);
  if (tokensDigest(relayAfter) !== siteDigest) {
    refuse('lists-differ', "the relay's existing TOKENS_FILE and the site's config.json do not list the same tokens");
  }
  const pairs = Array.isArray(input.siteConfig.pairs) ? [...(input.siteConfig.pairs as string[])] : [];
  for (const p of input.pairs ?? []) {
    const [base, quote] = p.split('/');
    for (const s of [base, quote]) {
      if (!s || !siteAfter.bySymbol(s))
        refuse('unknown-pair-token', `the pair ${p} names ${s ?? '(nothing)'}, which the lists do not have`);
    }
    if (!pairs.includes(p)) pairs.push(p);
  }
  const siteConfig: Record<string, unknown> = {
    ...input.siteConfig,
    tokens: siteTokens,
    ...(pairs.length > 0 ? { pairs } : {}),
    bridges: {
      midnightNetwork: registry.midnightNetwork,
      solanaGenesisHash: registry.solanaGenesisHash,
      tokens: registry.entries.map((e) => withIcon(e, input.icons?.solana)),
    },
  };
  return { siteConfig, relayTokens, tokensDigest: siteDigest, bridged: [...registry.entries] };
}
