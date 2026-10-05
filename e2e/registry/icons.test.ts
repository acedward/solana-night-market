// AA 00057 P3b.3 (questions Q10): one icon table for the wallet and the site; the injector's token file from
// Night Market's full token list. Offline.

import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { parseJourneyRegistry } from '@nightmarket/core/bridge';

import { buildJourneyRegistry, main as cli } from './build.js';
import {
  InjectorTokensError,
  IconTableError,
  bridgedSymbol,
  injectorTokenFile,
  midnightName,
  parseIconTable,
  siteIconMap,
} from './icons.js';

const ROOT = join(__dirname, '../..');
const FIX = join(__dirname, 'fixtures');
const read = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
const table = () => parseIconTable(read(join(__dirname, 'token-icons.json')));
const rec = (w: 'x' | 'y') => read(join(FIX, `standin-${w}.record.json`));
const BASE = 'https://midnight-solana-token-icons.ac-edward.workers.dev/';

/** Night Market's full token list as the relay's TOKENS_FILE has it after bridge-tokens.ts (P9 run 3's shape). */
const nmTokens = () => ({
  mode: 'replace',
  tokens: [
    { symbol: 'twUSDC', decimals: 6, privacy: 'shielded', midnightColour: 'e0'.repeat(32), contract: '98'.repeat(32) },
    { symbol: 'twBTC', decimals: 8, privacy: 'shielded', midnightColour: '67'.repeat(32), contract: 'e0'.repeat(32) },
    {
      symbol: 'X',
      name: 'X',
      decimals: 6,
      privacy: 'shielded',
      midnightColour: rec('x').colour,
      contract: rec('x').bridgeContract,
    },
    {
      symbol: 'Y',
      name: 'Y',
      decimals: 6,
      privacy: 'shielded',
      midnightColour: rec('y').colour,
      contract: rec('y').bridgeContract,
    },
  ],
});
/** The injector's bundled tokens.undeployed.json @ 00059 b358a19 (the genesis tokens), abridged. */
const injectorBase = () => ({
  network: 'undeployed',
  tokens: { ['00'.repeat(32)]: { name: 'Midnight Test Token', symbol: 'MNTT', decimals: 6, description: 'genesis' } },
});

const tmp = mkdtempSync(join(tmpdir(), 'aa00057-icons-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('the icon table', () => {
  it("pins every file, and the site's bundled copies are byte-identical (the wallet and the site never drift)", () => {
    const t = table();
    expect(t.base).toBe(BASE);
    for (const [file, sha] of Object.entries(t.sha256)) {
      const copy = join(ROOT, 'web/public', t.siteDir, file);
      expect(existsSync(copy), copy).toBe(true);
      expect(createHash('sha256').update(readFileSync(copy)).digest('hex'), file).toBe(sha);
    }
  });

  it("the site's icon map derived from it IS the committed scripts/token-icons.json (bridge-tokens.ts's default)", () => {
    expect(siteIconMap(table())).toEqual(read(join(ROOT, 'scripts/token-icons.json')));
  });

  it('refuses a table that is not HTTPS, names an unpinned file, or a path outside the site', () => {
    const raw = read(join(__dirname, 'token-icons.json'));
    expect(() => parseIconTable({ ...raw, base: 'http://icons.example/' })).toThrow(IconTableError);
    expect(() => parseIconTable({ ...raw, midnight: { ...raw.midnight, Z: 'z.png' } })).toThrow(IconTableError);
    expect(() => parseIconTable({ ...raw, siteDir: '../token-icons/' })).toThrow(IconTableError);
    expect(() => parseIconTable({ ...raw, solana: { X: '../x.png' } })).toThrow(IconTableError);
  });
});

describe('I-1 with icons', () => {
  it('each entry gets image, splImage (HTTPS, ≤ 200 bytes) and the site icon, from the one table', () => {
    const reg = buildJourneyRegistry([rec('x'), rec('y')], { midnightNetwork: 'undeployed', icons: table() });
    expect(reg.tokens.map((t) => [t.symbol, t.image, t.splImage, t.icon])).toEqual([
      ['X', `${BASE}x-midnight.png`, `${BASE}x.png`, 'token-icons/x.png'],
      ['Y', `${BASE}y-midnight.png`, `${BASE}y.png`, 'token-icons/y.png'],
    ]);
    for (const t of reg.tokens) expect(Buffer.byteLength(t.image!)).toBeLessThanOrEqual(200);
    // Night Market's parser accepts it and keeps the site icon (FR-022).
    const parsed = parseJourneyRegistry(reg, { midnightNetwork: 'undeployed' });
    expect(parsed.entries.map((e) => e.icon)).toEqual(['token-icons/x.png', 'token-icons/y.png']);
  });

  it('the command line writes the icons by default, none with --icons none, and the site map with --site-icons-out', async () => {
    const files = [join(FIX, 'standin-x.record.json'), join(FIX, 'standin-y.record.json')];
    const a = join(tmp, 'a.json');
    const site = join(tmp, 'site-icons.json');
    expect(await cli(['--network', 'undeployed', '--out', a, '--site-icons-out', site, ...files])).toBe(0);
    expect(read(a).tokens[0].image).toBe(`${BASE}x-midnight.png`);
    expect(read(site)).toEqual(read(join(ROOT, 'scripts/token-icons.json')));
    const b = join(tmp, 'b.json');
    expect(await cli(['--network', 'undeployed', '--out', b, '--icons', 'none', ...files])).toBe(0);
    expect(read(b).tokens[0].image).toBeUndefined();
  });
});

describe("the injector's token file", () => {
  const journey = () => buildJourneyRegistry([rec('x'), rec('y')], { midnightNetwork: 'undeployed', icons: table() });

  it("lists Night Market's FULL list by colour: twBTC with 8 decimals, the bridged colours as I-4b names them, all with images", () => {
    const f = injectorTokenFile({
      network: 'undeployed',
      nightMarketTokens: nmTokens(),
      journey: journey(),
      icons: table(),
      base: injectorBase(),
    });
    expect(f.network).toBe('undeployed');
    expect(f.tokens['67'.repeat(32)]).toMatchObject({
      name: 'twBTC (Midnight)',
      symbol: 'twBTC',
      decimals: 8,
      image: `${BASE}twbtc.png`,
    });
    expect(f.tokens['e0'.repeat(32)]).toMatchObject({
      name: 'twUSDC (Midnight)',
      symbol: 'twUSDC',
      decimals: 6,
      image: `${BASE}twusdc.png`,
    });
    expect(f.tokens[rec('x').colour]).toMatchObject({
      name: 'X (Midnight)',
      symbol: 'mnX',
      decimals: 6,
      image: `${BASE}x-midnight.png`,
    });
    expect(f.tokens[rec('y').colour]).toMatchObject({
      name: 'Y (Midnight)',
      symbol: 'mnY',
      decimals: 6,
      image: `${BASE}y-midnight.png`,
    });
    // The injector's bundled genesis tokens are kept, and get the default image.
    expect(f.tokens['00'.repeat(32)]).toMatchObject({
      name: 'Midnight Test Token',
      symbol: 'MNTT',
      image: `${BASE}midnight.png`,
    });
    // Within the injector's own limits (00059 src/tokens/registry.js): name ≤ 32 bytes, symbol ≤ 10 bytes.
    for (const t of Object.values(f.tokens)) {
      expect(Buffer.byteLength(t.name)).toBeLessThanOrEqual(32);
      expect(Buffer.byteLength(t.symbol)).toBeLessThanOrEqual(10);
    }
  });

  it('puts an unshielded token under `unshielded`', () => {
    const list = nmTokens();
    list.tokens.push({
      symbol: 'utwUSDC',
      decimals: 6,
      privacy: 'unshielded',
      midnightColour: 'ab'.repeat(32),
      contract: '01'.repeat(32),
    });
    const f = injectorTokenFile({ network: 'undeployed', nightMarketTokens: list, journey: journey(), icons: table() });
    expect(f.unshielded?.['ab'.repeat(32)]).toMatchObject({
      symbol: 'utwUSDC',
      decimals: 6,
      image: `${BASE}midnight.png`,
    });
    expect(f.tokens['ab'.repeat(32)]).toBeUndefined();
  });

  it('refuses a colour listed twice, a bridged token missing from the list or with other decimals, a base for another network', () => {
    const j = journey();
    const dup = nmTokens();
    dup.tokens.push({ ...dup.tokens[0]!, symbol: 'twUSDC2' });
    expect(() =>
      injectorTokenFile({ network: 'undeployed', nightMarketTokens: dup, journey: j, icons: table() }),
    ).toThrow(InjectorTokensError);
    const noY = nmTokens();
    noY.tokens.pop();
    expect(() =>
      injectorTokenFile({ network: 'undeployed', nightMarketTokens: noY, journey: j, icons: table() }),
    ).toThrow(/not in Night Market/);
    const dec = nmTokens();
    dec.tokens[2] = { ...dec.tokens[2]!, decimals: 9 };
    expect(() =>
      injectorTokenFile({ network: 'undeployed', nightMarketTokens: dec, journey: j, icons: table() }),
    ).toThrow(/decimals/);
    expect(() =>
      injectorTokenFile({
        network: 'undeployed',
        nightMarketTokens: nmTokens(),
        journey: j,
        icons: table(),
        base: { network: 'stagenet', tokens: {} },
      }),
    ).toThrow(/stagenet/);
  });

  it("I-4b's display rule, as the injector applies it", () => {
    expect(midnightName('X')).toBe('X (Midnight)');
    expect(Buffer.byteLength(midnightName('A very long token name indeed, longer'))).toBeLessThanOrEqual(32);
    expect(bridgedSymbol('X', 'ab'.repeat(32))).toBe('mnX');
    expect(bridgedSymbol('mnX', 'ab'.repeat(32))).toBe('mnmnX');
  });

  it('the command line writes it (exit 0) and refuses with 65', async () => {
    const reg = join(tmp, 'journey.json');
    const nm = join(tmp, 'nm-tokens.json');
    const base = join(tmp, 'base.json');
    const out = join(tmp, 'tokens.undeployed.json');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(reg, JSON.stringify(journey()));
    writeFileSync(nm, JSON.stringify(nmTokens()));
    writeFileSync(base, JSON.stringify(injectorBase()));
    expect(
      await cli([
        'injector-tokens',
        '--network',
        'undeployed',
        '--journey',
        reg,
        '--nm-tokens',
        nm,
        '--base',
        base,
        '--out',
        out,
      ]),
    ).toBe(0);
    expect(read(out).tokens['67'.repeat(32)].decimals).toBe(8);
    expect(
      await cli(['injector-tokens', '--network', 'stagenet', '--journey', reg, '--nm-tokens', nm, '--out', out]),
    ).toBe(65);
    expect(await cli(['injector-tokens', '--network', 'undeployed'])).toBe(64);
  });
});
