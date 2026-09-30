// The market's pairs: a configured list of two-legged markets, `BASE/QUOTE` by symbol.
//
// No token is special (owner rule): any two different shielded tokens of the registry make a pair,
// and which pairs a site lists is DATA (the network's default list, or `config.json` `pairs`), never
// a rule in code. A pair's price is whole QUOTE tokens per whole BASE token; an offer that gives the
// base and wants the quote is an ask, the reverse a bid, whatever the two tokens are.
//
// A pair is one market: `twETH/twBTC` and `twBTC/twETH` are the same market, so a list may name it
// once. Both legs must be SHIELDED, because the account's swap circuit is `open_swap_shielded`.

import type { TokenEntry, TokenRegistry } from './registry.js';

export interface MarketPair {
  /** `BASE/QUOTE` in the registry's spelling of the symbols (`twBTC/twUSDC`). */
  id: string;
  base: TokenEntry;
  quote: TokenEntry;
}

export const PAIR_SEPARATOR = '/';

export class PairConfigError extends Error {
  override name = 'PairConfigError';
}

/** `twBTC/twUSDC` → its two symbols; null when the text is not one pair. */
export function parsePairId(text: string): { base: string; quote: string } | null {
  const parts = text.split(PAIR_SEPARATOR).map((s) => s.trim());
  if (parts.length !== 2 || parts.some((s) => !/^[A-Za-z0-9._-]{1,16}$/.test(s))) return null;
  return { base: parts[0]!, quote: parts[1]! };
}

/** The pair for two symbols, checked against the registry (throws PairConfigError). */
export function makePair(registry: TokenRegistry, baseSymbol: string, quoteSymbol: string): MarketPair {
  const base = registry.bySymbol(baseSymbol);
  const quote = registry.bySymbol(quoteSymbol);
  if (!base) throw new PairConfigError(`unknown token ${baseSymbol}`);
  if (!quote) throw new PairConfigError(`unknown token ${quoteSymbol}`);
  if (base === quote) throw new PairConfigError(`a pair needs two different tokens (${base.symbol})`);
  for (const t of [base, quote]) {
    if (t.privacy !== 'shielded') throw new PairConfigError(`${t.symbol} is not shielded, so it cannot trade`);
  }
  return { id: `${base.symbol}${PAIR_SEPARATOR}${quote.symbol}`, base, quote };
}

/** Every pair of two different shielded tokens, in registry order (the earlier token is the base):
 *  the default of a network whose list is not given (a local stack). */
export function allPairs(registry: TokenRegistry): MarketPair[] {
  const shielded = registry.shielded();
  const out: MarketPair[] = [];
  for (let i = 0; i < shielded.length; i++)
    for (let j = i + 1; j < shielded.length; j++) out.push(makePair(registry, shielded[i]!.symbol, shielded[j]!.symbol));
  return out;
}

export interface ResolvedPairs {
  pairs: MarketPair[];
  /** What was wrong with the configuration (the console names it); the bad entries are skipped. */
  warnings: string[];
}

/**
 * The pairs a site lists: `configured` (a list of `BASE/QUOTE` strings) when given, else the
 * network's default list, else every pair of shielded tokens. An entry that names an unknown or
 * unshielded token, one token twice, or a market already listed is skipped with a warning; when
 * nothing valid is left of a configured list, the network's default applies, so a typo never
 * empties the market.
 */
export function resolvePairs(
  registry: TokenRegistry,
  configured: unknown,
  networkDefault: readonly string[] | null,
): ResolvedPairs {
  const warnings: string[] = [];
  const pick = (list: readonly unknown[], what: string): MarketPair[] => {
    const out: MarketPair[] = [];
    const seen = new Set<string>();
    for (const item of list) {
      const text = typeof item === 'string' ? item : JSON.stringify(item);
      const ids = typeof item === 'string' ? parsePairId(item) : null;
      if (!ids) {
        warnings.push(`${what}: "${text}" is not a pair (write BASE/QUOTE)`);
        continue;
      }
      let pair: MarketPair;
      try {
        pair = makePair(registry, ids.base, ids.quote);
      } catch (e) {
        warnings.push(`${what}: ${text}: ${(e as Error).message}`);
        continue;
      }
      const market = [pair.base.midnightColour, pair.quote.midnightColour].sort().join(':');
      if (seen.has(market)) {
        warnings.push(`${what}: ${text} is already listed`);
        continue;
      }
      seen.add(market);
      out.push(pair);
    }
    return out;
  };
  const fallback = (): MarketPair[] => {
    if (networkDefault === null) return allPairs(registry);
    const pairs = pick(networkDefault, "the network's default pairs");
    return pairs.length > 0 ? pairs : allPairs(registry);
  };
  if (configured === undefined) return { pairs: fallback(), warnings };
  if (!Array.isArray(configured)) {
    warnings.push('config.json "pairs" must be a list of BASE/QUOTE strings; using the default pairs');
    return { pairs: fallback(), warnings };
  }
  const pairs = pick(configured, 'config.json "pairs"');
  if (pairs.length > 0) return { pairs, warnings };
  warnings.push('config.json "pairs" names no valid pair; using the default pairs');
  return { pairs: fallback(), warnings };
}

/** The listed pair two colours make (either orientation), and whether `giveColour` is its base. */
export function pairFor(
  pairs: readonly MarketPair[],
  giveColour: string,
  wantColour: string,
): { pair: MarketPair; givesBase: boolean } | null {
  const g = giveColour.replace(/^0x/, '').toLowerCase();
  const w = wantColour.replace(/^0x/, '').toLowerCase();
  for (const pair of pairs) {
    if (pair.base.midnightColour === g && pair.quote.midnightColour === w) return { pair, givesBase: true };
    if (pair.quote.midnightColour === g && pair.base.midnightColour === w) return { pair, givesBase: false };
  }
  return null;
}
