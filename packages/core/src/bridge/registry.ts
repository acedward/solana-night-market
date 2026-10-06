// I-1, the journey token registry (`journey-tokens.<midnight-network>.json`; owner 00057, shape in its
// master plan), as Night Market reads it (AA 00060 P1.4):
//
//   { "midnightNetwork": "undeployed", "solanaGenesisHash": "<base58>",
//     "tokens": [ { "colour": "<64 hex>", "splMint": "<base58>", "bridgeContract": "<64 hex>",
//                   "bridgeProgram": "<base58>", "bridgeApi": "<http(s) origin>",
//                   "name": "X", "symbol": "X", "decimals": 6 } ] }
//
// The BRIDGE REGISTRY is kept apart from the token registry (../tokens/registry.ts): a bridged token is
// an ordinary token there, and only this registry knows its SPL mint, program, contract and API (owner
// rule: no special token). Every entry must pass the arm's display rule (00060 Q4 A: a symbol of 1..8
// printable ASCII characters without a space, decimals 0..18), so a wallet never shows it as `?`.
//
// The parser refuses, naming the reason: another Midnight network or Solana genesis hash than the
// caller's; a malformed field; a duplicate mint, colour or symbol (symbols without regard to case, as
// the token registry compares them); and a colour that is not `tokenType(domainSep(splMint),
// bridgeContract)` (the bridge contract's own derivation, recomputed here with compact-runtime 0.20).
// Unknown fields are ignored (00057 may add some).

import { z } from 'zod';

import { isRenderableTokenDisplay } from '../../../../vendor/passport/contract/src/wallet/ed25519-message.js';
import { normaliseHex32 } from '../hex.js';
import { siteIconPath } from '../tokens/icon.js';
import { bridgeColourOf } from './colour.js';
import { base58Key32 } from './landing-key.js';

export type BridgeRegistryRefusal =
  | 'shape'
  | 'wrong-network'
  | 'bad-genesis-hash'
  | 'wrong-genesis-hash'
  | 'bad-mint'
  | 'bad-program'
  | 'bad-colour'
  | 'bad-contract'
  | 'bad-api'
  | 'unrenderable-symbol'
  | 'decimals'
  | 'duplicate-mint'
  | 'duplicate-colour'
  | 'duplicate-symbol'
  | 'colour-mismatch';

export class BridgeRegistryError extends Error {
  override name = 'BridgeRegistryError';
  constructor(
    readonly reason: BridgeRegistryRefusal,
    message: string,
  ) {
    super(`${reason}: ${message}`);
  }
}

const HEX64 = /^(0x)?[0-9a-fA-F]{64}$/;
const NETWORK = /^[a-z0-9-]{1,32}$/;

const EntrySchema = z.object({
  colour: z.string(),
  splMint: z.string(),
  bridgeContract: z.string(),
  bridgeProgram: z.string(),
  bridgeApi: z.string(),
  name: z.string().min(1).max(64),
  symbol: z.string(),
  decimals: z.number(),
  /** AA 00060 FR-022 (optional): the SPL token's icon on the site's own origin (../tokens/icon.ts); a
   *  value that is not one is ignored. */
  icon: z.unknown().optional(),
});

export const JourneyRegistrySchema = z.object({
  midnightNetwork: z.string(),
  solanaGenesisHash: z.string(),
  tokens: z.array(EntrySchema).min(1),
});
export type JourneyRegistryFile = z.input<typeof JourneyRegistrySchema>;

export interface BridgeEntry {
  /** The bridged token's colour on Midnight (64 lowercase hex). */
  colour: string;
  /** The classic SPL Token mint (canonical base58). */
  splMint: string;
  /** The bridge's Midnight contract (64 lowercase hex). */
  bridgeContract: string;
  /** The bridge's Solana program (canonical base58). */
  bridgeProgram: string;
  /** The bridge node's API origin. */
  bridgeApi: string;
  name: string;
  symbol: string;
  decimals: number;
  /** The SPL token's icon on the site's own origin (FR-022), when configured. Display only. */
  icon?: string;
}

export class BridgeRegistry {
  readonly entries: readonly BridgeEntry[];
  private readonly byColourMap: Map<string, BridgeEntry>;
  private readonly byMintMap: Map<string, BridgeEntry>;

  constructor(
    readonly midnightNetwork: string,
    readonly solanaGenesisHash: string,
    entries: readonly BridgeEntry[],
  ) {
    this.entries = Object.freeze([...entries]);
    this.byColourMap = new Map(entries.map((e) => [e.colour, e]));
    this.byMintMap = new Map(entries.map((e) => [e.splMint, e]));
  }

  /** The entry of a Midnight colour (any hex case, with or without 0x), or undefined. */
  byColour(colour: string): BridgeEntry | undefined {
    try {
      return this.byColourMap.get(normaliseHex32(colour));
    } catch {
      return undefined;
    }
  }

  /** The entry of an SPL mint (base58), or undefined. */
  byMint(mint: string): BridgeEntry | undefined {
    return this.byMintMap.get(mint);
  }
}

export interface BridgeRegistryExpect {
  /** The site's (or the relay's) Midnight network: I-1's must equal it. */
  midnightNetwork: string;
  /** The Solana RPC's `getGenesisHash`, when known: I-1's must equal it. */
  solanaGenesisHash?: string;
  /** Skip the colour re-derivation (only for tests of the other rules). */
  skipColourCheck?: boolean;
}

const isHttpOrigin = (v: string): boolean => {
  try {
    const u = new URL(v);
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.origin === v;
  } catch {
    return false;
  }
};

const refuse = (reason: BridgeRegistryRefusal, message: string): never => {
  throw new BridgeRegistryError(reason, message);
};

/** Parse and check an I-1 file; throws `BridgeRegistryError` naming the first refusal. */
export function parseJourneyRegistry(file: unknown, expect: BridgeRegistryExpect): BridgeRegistry {
  const parsed = JourneyRegistrySchema.safeParse(file);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    refuse('shape', `the journey registry is not in the I-1 shape (${issues})`);
  }
  const f = parsed.data!;
  if (!NETWORK.test(f.midnightNetwork)) refuse('wrong-network', `"${f.midnightNetwork}" is not a network name`);
  if (f.midnightNetwork !== expect.midnightNetwork) {
    refuse('wrong-network', `the registry is for ${f.midnightNetwork}, not ${expect.midnightNetwork}`);
  }
  if (!base58Key32(f.solanaGenesisHash)) refuse('bad-genesis-hash', 'solanaGenesisHash is not the base58 of 32 bytes');
  if (expect.solanaGenesisHash !== undefined && f.solanaGenesisHash !== expect.solanaGenesisHash) {
    refuse('wrong-genesis-hash', "the registry's Solana genesis hash differs from the Solana RPC's");
  }
  const entries: BridgeEntry[] = [];
  const mints = new Set<string>();
  const colours = new Set<string>();
  const symbols = new Set<string>();
  f.tokens.forEach((t, i) => {
    const at = `tokens[${i}] (${JSON.stringify(t.symbol)})`;
    if (!HEX64.test(t.colour)) refuse('bad-colour', `${at}: colour is not 64 hex`);
    if (!HEX64.test(t.bridgeContract)) refuse('bad-contract', `${at}: bridgeContract is not 64 hex`);
    if (!base58Key32(t.splMint)) refuse('bad-mint', `${at}: splMint is not the canonical base58 of 32 bytes`);
    if (!base58Key32(t.bridgeProgram)) {
      refuse('bad-program', `${at}: bridgeProgram is not the canonical base58 of 32 bytes`);
    }
    if (!isHttpOrigin(t.bridgeApi)) refuse('bad-api', `${at}: bridgeApi is not an http(s) origin`);
    if (!Number.isInteger(t.decimals) || t.decimals < 0 || t.decimals > 18) {
      refuse('decimals', `${at}: decimals ${t.decimals} is not an integer in 0..18`);
    }
    if (!isRenderableTokenDisplay({ symbol: t.symbol, decimals: t.decimals })) {
      refuse('unrenderable-symbol', `${at}: a symbol must be 1 to 8 printable ASCII characters without a space`);
    }
    const colour = normaliseHex32(t.colour);
    const bridgeContract = normaliseHex32(t.bridgeContract);
    if (mints.has(t.splMint)) refuse('duplicate-mint', `${at}: the mint ${t.splMint} is listed twice`);
    if (colours.has(colour)) refuse('duplicate-colour', `${at}: the colour ${colour} is listed twice`);
    if (symbols.has(t.symbol.toLowerCase())) refuse('duplicate-symbol', `${at}: the symbol is listed twice`);
    if (!expect.skipColourCheck && bridgeColourOf(t.splMint, bridgeContract) !== colour) {
      refuse('colour-mismatch', `${at}: colour is not tokenType(domainSep(splMint), bridgeContract)`);
    }
    mints.add(t.splMint);
    colours.add(colour);
    symbols.add(t.symbol.toLowerCase());
    const icon = siteIconPath(t.icon);
    entries.push({
      colour,
      splMint: t.splMint,
      bridgeContract,
      bridgeProgram: t.bridgeProgram,
      bridgeApi: t.bridgeApi,
      name: t.name,
      symbol: t.symbol,
      decimals: t.decimals,
      ...(icon ? { icon } : {}),
    });
  });
  return new BridgeRegistry(f.midnightNetwork, f.solanaGenesisHash, entries);
}
