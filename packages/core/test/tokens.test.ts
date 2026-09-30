import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { NETWORK_DEFAULT_PAIRS } from '../src/network.js';
import { PairConfigError, allPairs, makePair, pairFor, parsePairId, resolvePairs } from '../src/tokens/pairs.js';
import {
  STAGENET_SOURCE,
  TokenRegistryError,
  registryFor,
  registryFromConfig,
  registryFromMintTestTokens,
  stagenetRegistry,
} from '../src/tokens/registry.js';

const vendored = fileURLToPath(new URL('../src/tokens/mint-test-tokens/metadata.stagenet.json', import.meta.url));
const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const colour = (c: string) => c.repeat(64);

describe('the vendored mint-test-tokens registry', () => {
  it('is byte-identical to effectstream/mint-test-tokens @ a51cf3a (PROVENANCE.md)', () => {
    expect(sha256(vendored)).toBe('973977bc0dbf7eae6afd4b1d92f365326b2b69d257f3597cdaffa9dac34839d0');
    expect(STAGENET_SOURCE).toEqual({
      repo: 'effectstream/mint-test-tokens',
      commit: 'a51cf3ad46520d1ded938fb86db8b7b99373ce56',
      file: 'metadata/metadata.stagenet.json',
    });
  });
});

describe('the stagenet registry', () => {
  const r = stagenetRegistry();

  it('lists the six faucet tokens in the file order, with their privacy and decimals', () => {
    expect(r.tokens.map((t) => [t.symbol, t.decimals, t.privacy])).toEqual([
      ['twBTC', 8, 'shielded'],
      ['twETH', 18, 'shielded'],
      ['twUSDC', 6, 'shielded'],
      ['twUSDM', 6, 'shielded'],
      ['utwUSDC', 6, 'unshielded'],
      ['utwBTC', 8, 'unshielded'],
    ]);
    expect(r.shielded().map((t) => t.symbol)).toEqual(['twBTC', 'twETH', 'twUSDC', 'twUSDM']);
  });

  it("takes each token's ACTIVE deployment: its colour is the registry's tokenId, its issuer the contract", () => {
    const usdc = r.bySymbol('twUSDC')!;
    expect(usdc.name).toBe('Test-wrapped USDC');
    expect(usdc.midnightColour).toBe('e934b965a454ed6857080e9956ea83fb5542e0a860e96ce91daf35f5d7b02c9f');
    expect(usdc.contract).toBe('11e406f1a83fa87d3fafe62674c1822ad5fb13a1b31765a601f90b2563ab0ec6');
    expect(usdc.domainSeparator).toBe('mint-test-tokens:twUSDC');
    expect(r.bySymbol('twBTC')?.midnightColour).toBe('ad2ba014014e6ec705357be9db5d3ad6f535d4bef6576f84a461f23b313a2e8e');
    expect(r.bySymbol('twETH')?.midnightColour).toBe('2862f0f347068b6c4909079ab8e991067b71fe2263ef00c20f017eefb6e9477a');
    expect(r.bySymbol('twUSDM')?.contract).toBe('6f6dacef3dbddad25137afedadc8beb58bc4a8ee65d8c7150c21ca0bcb9bfede');
    expect(r.bySymbol('utwUSDC')?.contract).toBe('473e8354fe9cd1d65d30664805ff1672fa9dee3066ae8cb92505e5f1a7a1691e');
    expect(r.bySymbol('utwBTC')?.contract).toBe('2e962ef4bc7f2f44056a4089fed639fc5b67aca64dc5ed66e6e508b33836b59e');
    for (const t of r.tokens) {
      expect(t.source).toBe(STAGENET_SOURCE);
      expect(t.domainSeparator).toBe(`mint-test-tokens:${t.symbol}`);
    }
  });

  it('agrees with the colours the staging kernel lists (its captured /v1/known-tokens)', () => {
    const known = JSON.parse(
      readFileSync(
        fileURLToPath(new URL('./fixtures/kernel/staging-2026-09-27/known-tokens.json', import.meta.url)),
        'utf8',
      ),
    ) as Array<{ name: string; token_color: string; decimals: number; kind: string }>;
    for (const symbol of ['twBTC', 'twETH', 'twUSDC']) {
      const k = known.find((x) => x.name === symbol.toUpperCase())!;
      const t = r.bySymbol(symbol)!;
      expect([k.token_color, k.decimals, k.kind]).toEqual([t.midnightColour, t.decimals, t.privacy]);
    }
  });

  it('finds a token by colour in any case, and by symbol without regard to case', () => {
    const btc = r.bySymbol('twBTC')!;
    expect(r.byColour(`0x${btc.midnightColour.toUpperCase()}`)).toBe(btc);
    expect(r.byColour('not a colour')).toBeUndefined();
    expect(r.bySymbol('TWBTC')).toBe(btc);
    expect(r.bySymbol(' twbtc ')).toBe(btc);
    expect(r.bySymbol('BTC')).toBeUndefined();
  });

  it('refuses a registry file for another network, or one without an active deployment', () => {
    const file = JSON.parse(readFileSync(vendored, 'utf8'));
    expect(() => registryFromMintTestTokens('undeployed', file, STAGENET_SOURCE)).toThrow(/for stagenet/);
    const noActive = structuredClone(file);
    noActive.tokens[0].deployments[0].status = 'retired';
    expect(() => registryFromMintTestTokens('stagenet', noActive, STAGENET_SOURCE)).toThrow(/twBTC: no active/);
    expect(() => registryFromMintTestTokens('stagenet', { status: 'unavailable' }, STAGENET_SOURCE)).toThrow(
      TokenRegistryError,
    );
  });
});

describe('registries from configuration', () => {
  const extra = { symbol: 'nmGOLD', name: 'Night Market gold', decimals: 2, midnightColour: colour('f') };

  it('extends the built-in list by default (a token the market deployed itself)', () => {
    const r = registryFor('stagenet', { tokens: [extra] });
    expect(r.tokens).toHaveLength(7);
    expect(r.bySymbol('nmGOLD')).toMatchObject({ decimals: 2, privacy: 'shielded', contract: '', source: null });
    expect(r.bySymbol('twUSDC')?.source).toBe(STAGENET_SOURCE);
  });

  it('replaces it on request, and is the whole list on a network with none (the local stack)', () => {
    expect(registryFor('stagenet', { mode: 'replace', tokens: [extra] }).tokens.map((t) => t.symbol)).toEqual([
      'nmGOLD',
    ]);
    expect(registryFor('undeployed', { tokens: [extra] }).tokens).toHaveLength(1);
    expect(registryFromConfig('undeployed', { tokens: [extra] }).bySymbol('nmgold')?.name).toBe('Night Market gold');
    expect(() => registryFor('undeployed')).toThrow(/no built-in token list/);
    expect(registryFor('stagenet').tokens).toHaveLength(6);
  });

  it('refuses duplicates, bad decimals and malformed entries', () => {
    const dupColour = { ...extra, symbol: 'OTHER', midnightColour: stagenetRegistry().tokens[0]!.midnightColour };
    expect(() => registryFor('stagenet', { tokens: [dupColour] })).toThrow(/duplicate colour/);
    expect(() => registryFor('stagenet', { tokens: [{ ...extra, symbol: 'TWUSDC' }] })).toThrow(/duplicate symbol/);
    expect(() => registryFromConfig('undeployed', { tokens: [{ ...extra, decimals: 19 }] })).toThrow(
      /invalid token configuration/,
    );
    expect(() => registryFromConfig('undeployed', { tokens: [{ ...extra, symbol: 'no spaces' }] })).toThrow(
      /invalid token configuration/,
    );
    expect(() => registryFromConfig('undeployed', { tokens: [] })).toThrow(/invalid token configuration/);
  });
});

describe('pairs', () => {
  const r = stagenetRegistry();

  it("the stagenet default pairs, in the list's order, with no special token", () => {
    const { pairs, warnings } = resolvePairs(r, undefined, NETWORK_DEFAULT_PAIRS.stagenet);
    expect(warnings).toEqual([]);
    expect(pairs.map((p) => p.id)).toEqual(['twBTC/twUSDC', 'twETH/twUSDC', 'twUSDM/twUSDC', 'twETH/twBTC']);
    expect(pairs.map((p) => [p.base.decimals, p.quote.decimals])).toEqual([
      [8, 6],
      [18, 6],
      [6, 6],
      [18, 8],
    ]);
  });

  it("a site's own list replaces the default, in any case, and a bad entry is skipped with a warning", () => {
    const { pairs, warnings } = resolvePairs(
      r,
      ['twbtc/TWUSDM', 'twETH/twBTC', 'twBTC/twUSDM', 'twUSDM/twBTC', 'utwUSDC/twUSDC', 'nope/twUSDC', 'twBTC', 1],
      NETWORK_DEFAULT_PAIRS.stagenet,
    );
    expect(pairs.map((p) => p.id)).toEqual(['twBTC/twUSDM', 'twETH/twBTC']);
    expect(warnings).toEqual([
      'config.json "pairs": twBTC/twUSDM is already listed',
      'config.json "pairs": twUSDM/twBTC is already listed',
      'config.json "pairs": utwUSDC/twUSDC: utwUSDC is not shielded, so it cannot trade',
      'config.json "pairs": nope/twUSDC: unknown token nope',
      'config.json "pairs": "twBTC" is not a pair (write BASE/QUOTE)',
      'config.json "pairs": "1" is not a pair (write BASE/QUOTE)',
    ]);
  });

  it('a list with nothing valid falls back to the default, so a typo never empties the market', () => {
    const { pairs, warnings } = resolvePairs(r, ['BTC/USDC'], NETWORK_DEFAULT_PAIRS.stagenet);
    expect(pairs).toHaveLength(4);
    expect(warnings.at(-1)).toBe('config.json "pairs" names no valid pair; using the default pairs');
    expect(resolvePairs(r, 'twBTC/twUSDC', NETWORK_DEFAULT_PAIRS.stagenet).pairs).toHaveLength(4);
  });

  it('with no default list, every pair of shielded tokens, the earlier token as the base', () => {
    const local = registryFromConfig('undeployed', {
      tokens: [
        { symbol: 'A', decimals: 6, midnightColour: colour('a') },
        { symbol: 'B', decimals: 6, midnightColour: colour('b') },
        { symbol: 'U', decimals: 6, privacy: 'unshielded', midnightColour: colour('c') },
        { symbol: 'C', decimals: 6, midnightColour: colour('d') },
      ],
    });
    expect(resolvePairs(local, undefined, null).pairs.map((p) => p.id)).toEqual(['A/B', 'A/C', 'B/C']);
    expect(allPairs(local)).toHaveLength(3);
  });

  it('makePair refuses unknown, unshielded or identical tokens', () => {
    expect(() => makePair(r, 'twBTC', 'twBTC')).toThrow(PairConfigError);
    expect(() => makePair(r, 'twBTC', 'utwBTC')).toThrow(/not shielded/);
    expect(() => makePair(r, 'BTC', 'twBTC')).toThrow(/unknown token BTC/);
    expect(parsePairId(' twBTC / twUSDC ')).toEqual({ base: 'twBTC', quote: 'twUSDC' });
    expect(parsePairId('a/b/c')).toBeNull();
  });

  it('pairFor finds the listed pair of two colours in either orientation', () => {
    const pairs = resolvePairs(r, undefined, NETWORK_DEFAULT_PAIRS.stagenet).pairs;
    const btc = r.bySymbol('twBTC')!.midnightColour;
    const eth = r.bySymbol('twETH')!.midnightColour;
    const usdm = r.bySymbol('twUSDM')!.midnightColour;
    expect(pairFor(pairs, eth, btc)).toMatchObject({ pair: { id: 'twETH/twBTC' }, givesBase: true });
    expect(pairFor(pairs, `0x${btc.toUpperCase()}`, eth)).toMatchObject({ pair: { id: 'twETH/twBTC' }, givesBase: false });
    expect(pairFor(pairs, usdm, btc)).toBeNull();
  });
});
