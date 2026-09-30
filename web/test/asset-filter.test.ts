// Plan 00042 P1.4, carried over: the asset filter's parsing, storage and rules, case by case. The
// rules are generic: no asset is special, and a market shows only when both of its tokens are
// listed, so a pair without twUSDC (twETH/twBTC) is filtered by the same code as any other.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type FeedState,
  NETWORK_DEFAULT_ASSETS,
  NETWORK_DEFAULT_PAIRS,
  type MarketPair,
  type TokenEntry,
  registryFor,
  resolvePairs,
  stagenetRegistry,
} from '@nightmarket/core';

import { assetFilterText } from '../src/assets/AssetFilterContext.js';
import contextSource from '../src/assets/AssetFilterContext.tsx?raw';
import {
  type FilterAsset,
  applyAssetsParam,
  assetView,
  parseAssetsParam,
  readAssetFilter,
  resolveSiteAssets,
  saveAssetFilter,
  withoutAssetsParam,
} from '../src/assets/filter.js';
import filterSource from '../src/assets/filter.ts?raw';
import { loadSiteConfig } from '../src/config.js';
import configSource from '../src/config.ts?raw';
import { marketRows } from '../src/market/view.js';
import { ASSET_FILTER_KEY, type WalletScope } from '../src/store/schema.js';
import { ImportError, LocalStore } from '../src/store/store.js';

const registry = stagenetRegistry();
const PAIRS = resolvePairs(registry, undefined, NETWORK_DEFAULT_PAIRS.stagenet).pairs;
const ALL = ['twBTC', 'twETH', 'twUSDC', 'twUSDM', 'utwUSDC', 'utwBTC'];
const LOADING: FeedState = { status: 'loading', stream: 'off' };
const ME: WalletScope = { network: 'stagenet', owner: 'ab'.repeat(32) };

/** A page load at `url` on a site whose set is `site` (null = every asset): the parameter
 *  applied to the store, and the view it gives. */
function load(
  url: string,
  store: LocalStore | null,
  assets: readonly TokenEntry[] = registry.tokens,
  site: readonly string[] | null = null,
) {
  const replaced: string[] = [];
  const u = new URL(url, 'https://market.example/');
  const win = {
    location: { search: u.search, href: u.href },
    history: {
      state: null,
      replaceState: (_s: unknown, _t: string, to?: string | URL | null) => replaced.push(String(to)),
    },
  };
  const applied = applyAssetsParam(win, store);
  const listed =
    readAssetFilter(store) ?? (applied.param.kind === 'set' && !applied.saved ? applied.param.symbols : null);
  return { applied, replaced, view: assetView(listed, assets, [], site) };
}

const shown = (view: ReturnType<typeof assetView>, tokens: readonly TokenEntry[] = registry.tokens) =>
  tokens.filter(view.shows).map((t) => t.symbol);
const markets = (view: ReturnType<typeof assetView>, pairs: readonly MarketPair[] = PAIRS) =>
  marketRows(LOADING, pairs, view.showsPair).map((m) => m.pair);
const marketKeys = () => {
  const out: Record<string, string> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)!;
    if (k.startsWith('night-market/')) out[k] = localStorage.getItem(k)!;
  }
  return out;
};

let store: LocalStore;
beforeEach(() => {
  localStorage.clear();
  store = new LocalStore(localStorage);
});

describe('the assets parameter', () => {
  it('parses a list: trimmed, split on commas, well-formed symbols only, no duplicates', () => {
    expect(parseAssetsParam('')).toEqual({ kind: 'absent' });
    expect(parseAssetsParam('?pair=twBTC/twUSDC')).toEqual({ kind: 'absent' });
    expect(parseAssetsParam('?assets=twUSDC,twBTC')).toEqual({ kind: 'set', symbols: ['twUSDC', 'twBTC'] });
    expect(parseAssetsParam('?assets=%20twusdc%20,,twBTC,twUSDC,')).toEqual({
      kind: 'set',
      symbols: ['twusdc', 'twBTC'],
    });
    expect(parseAssetsParam('?assets=twUSDC+twBTC')).toEqual({ kind: 'set', symbols: ['twUSDC', 'twBTC'] });
    expect(parseAssetsParam('?assets=all')).toEqual({ kind: 'clear' });
    expect(parseAssetsParam('?assets=ALL')).toEqual({ kind: 'clear' });
    expect(parseAssetsParam('?assets=')).toEqual({ kind: 'clear' });
    expect(parseAssetsParam('?assets')).toEqual({ kind: 'clear' });
    expect(parseAssetsParam('?assets=%3Cscript%3E,twUSDC')).toEqual({ kind: 'set', symbols: ['twUSDC'] });
    expect(parseAssetsParam('?assets=<script>')).toEqual({ kind: 'invalid' });
    expect(parseAssetsParam(`?assets=${'X'.repeat(17)}`)).toEqual({ kind: 'invalid' });
    const many = Array.from({ length: 40 }, (_, i) => `T${i}`).join(',');
    expect((parseAssetsParam(`?assets=${many}`) as { symbols: string[] }).symbols).toHaveLength(32);
  });

  it('is removed from the address bar, keeping the path, the other parameters and the section', () => {
    expect(withoutAssetsParam('https://market.example/?assets=twUSDC')).toBe('/');
    expect(withoutAssetsParam('https://market.example/app/?x=1&assets=twUSDC#markets')).toBe('/app/?x=1#markets');
    const { replaced } = load('/?assets=twBTC#markets', store);
    expect(replaced).toEqual(['/#markets']);
    expect(load('/#markets', store).replaced).toEqual([]); // no parameter: the address is left alone
  });
});

describe('the rules', () => {
  it('no parameter, nothing stored: everything is visible and nothing is written', () => {
    const { view } = load('/', store);
    expect(view.filtering).toBe(false);
    expect(shown(view)).toEqual(ALL);
    expect(markets(view)).toEqual(['twBTC/twUSDC', 'twETH/twUSDC', 'twUSDM/twUSDC', 'twETH/twBTC']);
    expect(marketKeys()).toEqual({});
  });

  it('?assets=twUSDC: twUSDC only, and no market (none has both tokens listed)', () => {
    const { view } = load('/?assets=twUSDC', store);
    expect(view.filtering).toBe(true);
    expect(shown(view)).toEqual(['twUSDC']);
    expect(markets(view)).toEqual([]);
  });

  it('?assets=twbtc: twBTC only (any case), and no market', () => {
    const { view } = load('/?assets=twbtc', store);
    expect(shown(view)).toEqual(['twBTC']);
    expect(view.shows({ symbol: 'TWBTC' })).toBe(true);
    expect(markets(view)).toEqual([]);
  });

  it('?assets=twBTC,twUSDC: those two and the twBTC/twUSDC market only', () => {
    const { view } = load('/?assets=twBTC,twUSDC', store);
    expect(shown(view)).toEqual(['twBTC', 'twUSDC']);
    expect(markets(view)).toEqual(['twBTC/twUSDC']);
  });

  it('?assets=twETH,twBTC: the pair without twUSDC, exactly like any other', () => {
    const { view } = load('/?assets=twETH,twBTC', store);
    expect(shown(view)).toEqual(['twBTC', 'twETH']);
    expect(markets(view)).toEqual(['twETH/twBTC']);
  });

  it('a pair of generic assets: shown when both are listed; no asset is special', () => {
    const A = { symbol: 'AAA' };
    const B = { symbol: 'BBB' };
    const C = { symbol: 'CCC' };
    const pairs: Array<[FilterAsset, FilterAsset]> = [
      [A, B],
      [A, C],
      [B, C],
    ];
    const view = assetView(['AAA', 'BBB'], [A, B, C]);
    expect(pairs.filter(([a, b]) => view.showsPair(a, b))).toEqual([[A, B]]);
    expect([A, B, C].filter(view.shows)).toEqual([A, B]);
    // The order of a pair's legs does not matter, and neither leg is a quote currency.
    expect(view.showsPair(B, A)).toBe(true);
    expect(assetView(['CCC'], [A, B, C]).showsPair(A, C)).toBe(false);
  });

  it('the rules never read a role: no "usdc"/"stock" in the filter code', () => {
    const src = filterSource.replace(/\/\/.*$/gm, '');
    expect(src).not.toMatch(/\brole\b|\.usdc\(|stocks\(|'usdc'|'stock'/);
  });

  it('?assets=twUSDC,EURC while EURC is unknown: twUSDC only, and the note names EURC', () => {
    const { view } = load('/?assets=twUSDC,EURC', store);
    expect(shown(view)).toEqual(['twUSDC']);
    expect(view.known).toEqual(['twUSDC']);
    expect(view.unknown).toEqual(['EURC']);
    expect(readAssetFilter(store)).toEqual(['twUSDC', 'EURC']); // kept, for when EURC arrives
  });

  it('?assets=EURC (nothing known): everything stays visible, with the note', () => {
    const { view } = load('/?assets=EURC', store);
    expect(view.filtering).toBe(false);
    expect(view.unknown).toEqual(['EURC']);
    expect(shown(view)).toEqual(ALL);
    expect(markets(view)).toHaveLength(4);
  });

  it('assets marked always visible show whatever the list, and count as known (the site passes none)', () => {
    const PINNED = { symbol: 'PIN' };
    const view = assetView(['twUSDC'], registry.tokens, [PINNED]);
    expect(view.shows(PINNED)).toBe(true);
    expect(assetView(['PIN'], registry.tokens, [PINNED]).unknown).toEqual([]);
    expect(contextSource).toMatch(/assetView\(.*, \[\], site\)/);
  });

  it('a stored filter applies with no parameter', () => {
    load('/?assets=twBTC,twUSDC', store);
    const again = load('/#account', new LocalStore(localStorage));
    expect(again.applied.param.kind).toBe('absent');
    expect(shown(again.view)).toEqual(['twBTC', 'twUSDC']);
  });

  it('?assets=all and ?assets= clear it', () => {
    for (const url of ['/?assets=all', '/?assets=']) {
      load('/?assets=twUSDC', store);
      expect(marketKeys()[ASSET_FILTER_KEY]).toBeDefined();
      const { view } = load(url, store);
      expect(view.filtering).toBe(false);
      expect(marketKeys()[ASSET_FILTER_KEY]).toBeUndefined();
      expect(shown(view)).toHaveLength(6);
    }
  });

  it('a new list replaces the old one', () => {
    load('/?assets=twUSDC', store);
    expect(shown(load('/?assets=twETH,twUSDC', store).view)).toEqual(['twETH', 'twUSDC']);
    expect(readAssetFilter(store)).toEqual(['twETH', 'twUSDC']);
  });

  it('?assets=<script>,twUSDC drops the bad symbol; a list of only bad ones changes nothing', () => {
    expect(load('/?assets=%3Cscript%3E,twUSDC', store).view.listed).toEqual(['twUSDC']);
    const { applied, replaced } = load('/?assets=%3Cscript%3E', store);
    expect(applied.param.kind).toBe('invalid');
    expect(replaced).toEqual(['/']);
    expect(readAssetFilter(store)).toEqual(['twUSDC']);
  });

  it('a browser that cannot keep data applies the list to this page load only', () => {
    const { applied, view } = load('/?assets=twUSDC', null);
    expect(applied.saved).toBe(false);
    expect(shown(view)).toEqual(['twUSDC']);
    expect(marketKeys()).toEqual({});
  });

  it('Export, then Import: the filter survives; CLEAR ALL removes it', () => {
    store.put(ME, 'profile', { firstSeen: 1 });
    load('/?assets=twUSDC,twBTC', store);
    const file = store.exportWallet(ME);
    expect(file.records.map((r) => r.key)).toContain(ASSET_FILTER_KEY);
    expect(store.clearAll()).toBe(3); // the profile, the filter, the schema marker
    expect(readAssetFilter(store)).toBeNull();
    expect(marketKeys()).toEqual({});
    expect(store.importWallet(JSON.parse(JSON.stringify(file)), ME).imported).toBe(2);
    expect(readAssetFilter(store)).toEqual(['twUSDC', 'twBTC']);
  });

  it('Import refuses a filter record this page would not write', () => {
    store.put(ME, 'profile', { firstSeen: 1 });
    saveAssetFilter(store, ['twUSDC']);
    const file = JSON.parse(JSON.stringify(store.exportWallet(ME))) as {
      records: Array<{ key: string; value: { data: unknown } }>;
    };
    file.records.find((r) => r.key === ASSET_FILTER_KEY)!.value.data = { assets: ['<script>'] };
    localStorage.clear();
    expect(() => new LocalStore(localStorage).importWallet(file, ME)).toThrow(ImportError);
    expect(marketKeys()).toEqual({});
  });

  it('a token the market adds by configuration (nmGOLD) and its pair: filtered by the same code', () => {
    const withGold = registryFor('stagenet', {
      tokens: [{ symbol: 'nmGOLD', name: 'Night Market gold', decimals: 2, midnightColour: 'f7'.repeat(32) }],
    });
    const pairs = resolvePairs(withGold, ['nmGOLD/twUSDC', 'twBTC/twUSDC'], NETWORK_DEFAULT_PAIRS.stagenet).pairs;
    const { view } = load('/?assets=twUSDC,nmGOLD', store, withGold.tokens);
    expect(view.unknown).toEqual([]);
    expect(shown(view, withGold.tokens)).toEqual(['twUSDC', 'nmGOLD']);
    expect(markets(view, pairs)).toEqual(['nmGOLD/twUSDC']);
  });
});

describe('the markets view with a filter', () => {
  it('keeps every market when nothing is listed (the unfiltered page is unchanged)', () => {
    expect(marketRows(LOADING, PAIRS)).toEqual(marketRows(LOADING, PAIRS, assetView(null, registry.tokens).showsPair));
  });

  it('passes both tokens of each pair to the filter', () => {
    const seen: string[] = [];
    marketRows(LOADING, PAIRS, (a, b) => {
      seen.push(`${a.symbol}/${b.symbol}`);
      return true;
    });
    expect(seen).toEqual(['twBTC/twUSDC', 'twETH/twUSDC', 'twUSDM/twUSDC', 'twETH/twBTC']);
  });
});

// Plan 00046 P2.4, carried over: each domain's set (config.json `assets`, or the network's default
// set, which is data) is the ceiling, and the 00042 list narrows within it.
describe("the site's set", () => {
  const PARTNER = ['twETH', 'twBTC'];
  const stagenetSite = (configured: unknown) =>
    resolveSiteAssets(configured, NETWORK_DEFAULT_ASSETS.stagenet, registry.tokens);
  const onSite = (configured: unknown, url = '/') => load(url, store, registry.tokens, stagenetSite(configured).set);

  it('stagenet, no assets: every token and every pair (its default set is data: all of them)', () => {
    expect(NETWORK_DEFAULT_ASSETS.stagenet).toBeNull();
    expect(stagenetSite(undefined)).toEqual({ set: null, warnings: [] });
    const { view } = onSite(undefined);
    expect(view.filtering).toBe(false);
    expect(shown(view)).toEqual(ALL);
    expect(markets(view)).toHaveLength(4);
  });

  it('a partner set (twETH, twBTC): those 2 tokens and their market only', () => {
    expect(stagenetSite(PARTNER)).toEqual({ set: PARTNER, warnings: [] });
    const { view } = onSite(PARTNER);
    expect(shown(view)).toEqual(['twBTC', 'twETH']);
    expect(markets(view)).toEqual(['twETH/twBTC']);
  });

  it('assets: "all": 6 tokens, 4 markets', () => {
    expect(stagenetSite('all')).toEqual({ set: null, warnings: [] });
    expect(stagenetSite('ALL').set).toBeNull();
    const { view } = onSite('all');
    expect(shown(view)).toHaveLength(6);
    expect(markets(view)).toHaveLength(4);
  });

  it('the partner set + ?assets=twETH: twETH only, and no market', () => {
    const { view } = onSite(PARTNER, '/?assets=twETH');
    expect(view.filtering).toBe(true);
    expect(shown(view)).toEqual(['twETH']);
    expect(markets(view)).toEqual([]);
    expect([view.unavailable, view.unknown]).toEqual([[], []]);
  });

  it('the partner set + ?assets=twUSDC,twETH: twETH only, and twUSDC named as not available on this site', () => {
    const { view } = onSite(PARTNER, '/?assets=twUSDC,twETH');
    expect(shown(view)).toEqual(['twETH']);
    expect(view.known).toEqual(['twETH']);
    expect(view.unavailable).toEqual(['twUSDC']);
    expect(view.unknown).toEqual([]);
    expect(assetFilterText(view)).toBe('Showing only twETH. Not available on this site: twUSDC.');
    // A list of only outside symbols narrows nothing: the site's set, with the note.
    const only = onSite(PARTNER, '/?assets=twUSDM').view;
    expect(only.filtering).toBe(false);
    expect(shown(only)).toEqual(['twBTC', 'twETH']);
    expect(assetFilterText(only)).toBe(
      'None of the listed assets is on this site, so every asset is shown. Not available on this site: twUSDM.',
    );
  });

  it('the partner set + ?assets=all: the partner set (the stored list is forgotten)', () => {
    onSite(PARTNER, '/?assets=twETH');
    expect(readAssetFilter(store)).toEqual(['twETH']);
    const { view } = onSite(PARTNER, '/?assets=all');
    expect(readAssetFilter(store)).toBeNull();
    expect(view.filtering).toBe(false);
    expect(shown(view)).toEqual(['twBTC', 'twETH']);
  });

  it('a typo (twETC) beside valid symbols: the valid ones, and a warning', () => {
    const r = stagenetSite(['tweth', 'twETC', 'TWBTC', 'twETH']);
    expect(r.set).toEqual(['twETH', 'twBTC']); // any case, no duplicates
    expect(r.warnings).toEqual(['config.json "assets": ignoring unknown assets: twETC']);
  });

  it('only unknown symbols (or not a list): the network default, and a warning', () => {
    const r = stagenetSite(['twETC', 'EURC']);
    expect(r.set).toBeNull();
    expect(r.warnings).toEqual([
      'config.json "assets": ignoring unknown assets: twETC, EURC',
      'config.json "assets" names no known asset; using the network\'s default',
    ]);
    for (const bad of ['twETH,twBTC', 42, { a: 1 }, [7]]) {
      const b = stagenetSite(bad);
      expect(b.set).toBeNull();
      expect(b.warnings.length).toBeGreaterThan(0);
    }
    // A default set (data) naming a token the registry does not know: everything, with warnings.
    const other = resolveSiteAssets(undefined, ['wStkA'], [{ symbol: 'twUSDC' }]);
    expect(other.set).toBeNull();
    expect(other.warnings).toHaveLength(2);
  });

  it('a default set that names known tokens narrows like a configured one (the data drives it)', () => {
    expect(resolveSiteAssets(undefined, ['twBTC', 'twUSDC'], registry.tokens)).toEqual({
      set: ['twBTC', 'twUSDC'],
      warnings: [],
    });
  });

  it('the site code names no token and reads no role (the owner rule: no special token in code)', () => {
    for (const src of [filterSource, configSource, contextSource]) {
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      expect(code).not.toMatch(/\bu?tw(usdc|usdm|btc|eth)\b|\bw?usdc\b|\bw?stk[abc]\b/i);
      expect(code).not.toMatch(/\brole\b|\.usdc\(|stocks\(|'stock'/);
    }
  });
});

describe('loadSiteConfig: the site set and pairs from config.json', () => {
  const fetchJson = (body: unknown) =>
    (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => warn.mockRestore());

  it('the market domain (no assets): every token, no warning; no config.json: the same', async () => {
    const c = await loadSiteConfig(fetchJson({ network: 'stagenet', relayUrl: '/relay' }));
    expect(c.assets).toBeNull();
    expect(c.pairs).toBeUndefined();
    const none = (async () => new Response('', { status: 404 })) as unknown as typeof fetch;
    expect((await loadSiteConfig(none)).assets).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it('a partner domain: its own set and pairs, passed through as data', async () => {
    const c = await loadSiteConfig(
      fetchJson({ network: 'stagenet', relayUrl: '/relay', assets: ['twETH', 'twBTC'], pairs: ['twETH/twBTC'] }),
    );
    expect(c.assets).toEqual(['twETH', 'twBTC']);
    expect(c.pairs).toEqual(['twETH/twBTC']);
    expect(warn).not.toHaveBeenCalled();
  });

  it('"all", a typo, and only unknown symbols', async () => {
    expect((await loadSiteConfig(fetchJson({ assets: 'all' }))).assets).toBeNull();
    expect((await loadSiteConfig(fetchJson({ assets: ['twUSDC', 'twETC'] }))).assets).toEqual(['twUSDC']);
    expect(warn).toHaveBeenCalledWith('Night Market: config.json "assets": ignoring unknown assets: twETC');
    warn.mockClear();
    expect((await loadSiteConfig(fetchJson({ assets: ['NOPE'] }))).assets).toBeNull();
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('undeployed with its token list and no assets: everything', async () => {
    const tokens = {
      tokens: [
        { symbol: 'tA', decimals: 6, midnightColour: 'aa'.repeat(32) },
        { symbol: 'tB', decimals: 8, midnightColour: 'bb'.repeat(32) },
      ],
    };
    expect((await loadSiteConfig(fetchJson({ network: 'undeployed', tokens }))).assets).toBeNull();
    expect((await loadSiteConfig(fetchJson({ network: 'undeployed', tokens, assets: ['tB'] }))).assets).toEqual(['tB']);
    expect(warn).not.toHaveBeenCalled();
  });
});
