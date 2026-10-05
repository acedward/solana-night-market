// AA 00057 P3b.3 (questions Q10, the owner 2026-10-05): ONE icon table (./token-icons.json) for every place
// a journey token is shown, so the wallet and the site never drift:
//
//   - I-1 (journey-tokens.<net>.json) entries gain `image` (the Midnight-side token's icon: the injector's
//     "<name> (Midnight)") and `splImage` (the real SPL token's icon: the injector's metadata fill-in for
//     registry mints, 00059 P7), both HTTPS URLs from the table's `base`; and `icon` (Night Market FR-022:
//     the SPL token's icon on the SITE'S own origin, `siteDir` + the same file);
//   - Night Market's site icon map (the format of scripts/token-icons.json, which scripts/bridge-tokens.ts
//     reads with --icons) is derived from the same table;
//   - the injector's own token file `tokens.<net>.json` (its TOKEN_REGISTRY; 00059 src/tokens/registry.js)
//     is generated from Night Market's FULL token list (the relay's TOKENS_FILE: names, symbols, decimals,
//     e.g. twBTC 8), with images from the table, over the injector's bundled file (the genesis tokens).
//
// Pure functions; build.ts is the command line.

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface IconTable {
  base: string;
  siteDir: string;
  default: string;
  midnight: Record<string, string>;
  solana: Record<string, string>;
  sha256: Record<string, string>;
}

export class IconTableError extends Error {
  override name = 'IconTableError';
}

const FILE = /^[a-z0-9][a-z0-9._-]{0,60}\.(?:png|webp|svg)$/;
const HEX64 = /^[0-9a-f]{64}$/;
/** 00059 P7.2: an I-1 image is an HTTPS URL of at most 200 bytes. */
const MAX_URL_BYTES = 200;

/** Parse and check the table: an HTTPS base, a relative site dir, known files with their SHA-256. */
export function parseIconTable(raw: unknown): IconTable {
  const t = raw as Partial<IconTable> | null;
  const fail = (m: string): never => {
    throw new IconTableError(`icon table: ${m}`);
  };
  if (!t || typeof t !== 'object') fail('not an object');
  if (typeof t!.base !== 'string' || !/^https:\/\/[^/?#]+\/(?:[^?#]*\/)?$/.test(t!.base))
    fail('`base` must be an https URL ending in /');
  if (typeof t!.siteDir !== 'string' || !/^(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/){1,3}$/.test(t!.siteDir))
    fail('`siteDir` must be a relative directory ending in /');
  const sha = t!.sha256 ?? {};
  for (const [f, h] of Object.entries(sha)) {
    if (!FILE.test(f)) fail(`sha256: ${f} is not a file name`);
    if (typeof h !== 'string' || !HEX64.test(h)) fail(`sha256: ${f} is not 64 hex`);
  }
  const files = (m: unknown, what: string): Record<string, string> => {
    if (!m || typeof m !== 'object') return fail(`\`${what}\` must map symbols to files`);
    for (const [sym, f] of Object.entries(m as Record<string, unknown>)) {
      if (typeof f !== 'string' || !FILE.test(f)) fail(`${what}.${sym}: not a file name`);
      if (!((f as string) in sha)) fail(`${what}.${sym}: ${f} has no sha256`);
    }
    return m as Record<string, string>;
  };
  const midnight = files(t!.midnight, 'midnight');
  const solana = files(t!.solana, 'solana');
  if (typeof t!.default !== 'string' || !(t!.default in sha)) fail('`default` must be a file with a sha256');
  for (const f of Object.keys(sha)) {
    if (Buffer.byteLength(t!.base + f) > MAX_URL_BYTES) fail(`${t!.base}${f} is longer than ${MAX_URL_BYTES} bytes`);
  }
  return { base: t!.base!, siteDir: t!.siteDir!, default: t!.default!, midnight, solana, sha256: sha };
}

const bySymbol = (m: Record<string, string>, symbol: string): string | null => {
  const k = Object.keys(m).find((s) => s.toLowerCase() === symbol.toLowerCase());
  return k ? m[k]! : null;
};

/** The wallet's (public) URL of the Midnight-side icon of `symbol`, or null when the table has none. */
export const midnightImage = (t: IconTable, symbol: string): string | null => {
  const f = bySymbol(t.midnight, symbol);
  return f ? t.base + f : null;
};
/** The wallet's (public) URL of the real SPL token's icon of `symbol`, or null. */
export const splImage = (t: IconTable, symbol: string): string | null => {
  const f = bySymbol(t.solana, symbol);
  return f ? t.base + f : null;
};

/** Night Market's site icon map (scripts/token-icons.json's format), from the table. */
export function siteIconMap(t: IconTable): { midnight: Record<string, string>; solana: Record<string, string> } {
  const map = (m: Record<string, string>) => Object.fromEntries(Object.entries(m).map(([s, f]) => [s, t.siteDir + f]));
  return { midnight: map(t.midnight), solana: map(t.solana) };
}

/** I-1 entries with `image`, `splImage` (wallet URLs) and `icon` (the site path of the SPL icon), from the table. */
export function withIcons<T extends { symbol: string }>(
  t: IconTable,
  entries: readonly T[],
): Array<T & { image?: string; splImage?: string; icon?: string }> {
  return entries.map((e) => {
    const image = midnightImage(t, e.symbol);
    const spl = splImage(t, e.symbol);
    const site = bySymbol(t.solana, e.symbol);
    return {
      ...e,
      ...(image ? { image } : {}),
      ...(spl ? { splImage: spl } : {}),
      ...(site ? { icon: t.siteDir + site } : {}),
    };
  });
}

// ── the injector's token file (00059 src/tokens/registry.js) ────────────────────────────────────

/** UTF-8 cut at a character boundary (00059 src/tokens/display.js `cutUtf8`). */
function cutUtf8(s: string, max: number): string {
  let out = '';
  let n = 0;
  for (const ch of s) {
    const b = Buffer.byteLength(ch);
    if (n + b > max) break;
    out += ch;
    n += b;
  }
  return out;
}
/** "<name> (Midnight)" within the injector's 32-byte name limit (00059 I-4b's rule). */
export const midnightName = (name: string): string => {
  const base = cutUtf8(name, 21).replace(/ +$/, '');
  return base ? `${base} (Midnight)` : '(Midnight)';
};
/** I-4b's symbol for a BRIDGED colour: "mn" + the SPL symbol (never equal to it), within 10 bytes. */
export const bridgedSymbol = (symbol: string, colour: string): string => {
  const s = `mn${cutUtf8(symbol, 8)}`;
  return s.toLowerCase() !== symbol.toLowerCase() ? s : `MN${colour.slice(0, 6).toUpperCase()}`;
};

export interface InjectorTokenInfo {
  name: string;
  symbol: string;
  decimals: number;
  image: string;
  description: string;
}
export interface InjectorTokenFile {
  network: string;
  note: string;
  tokens: Record<string, InjectorTokenInfo>;
  unshielded?: Record<string, InjectorTokenInfo>;
}

export class InjectorTokensError extends Error {
  override name = 'InjectorTokensError';
}

/**
 * The injector's token file for `network`: every token of Night Market's list (the relay's TOKENS_FILE,
 * `{tokens: [{symbol, name?, decimals, privacy, midnightColour}]}`) by colour, named "<name> (Midnight)"
 * (a bridged colour of I-1 with I-4b's "mn" symbol, the I-1 name and decimals: the same display the
 * injector derives from I-1, so the two never disagree), each with its table image (the table's default
 * when it has none); over `base` (the injector's bundled file: the genesis tokens), whose entries are kept
 * and given the default image when they have none. Refuses a colour listed twice in Night Market's list,
 * and a decimals value the injector would refuse.
 */
export function injectorTokenFile(o: {
  network: string;
  nightMarketTokens: unknown;
  journey: {
    tokens: ReadonlyArray<{ colour: string; splMint: string; name: string; symbol: string; decimals: number }>;
  };
  icons: IconTable;
  base?: unknown;
}): InjectorTokenFile {
  const fail = (m: string): never => {
    throw new InjectorTokensError(`injector tokens: ${m}`);
  };
  const def = o.icons.base + o.icons.default;
  const base = (o.base ?? null) as {
    network?: unknown;
    tokens?: Record<string, any>;
    unshielded?: Record<string, any>;
  } | null;
  if (base && base.network !== o.network) fail(`the base file is for ${String(base.network)}, not ${o.network}`);
  const tokens: Record<string, InjectorTokenInfo> = {};
  const unshielded: Record<string, InjectorTokenInfo> = {};
  for (const [k, v] of Object.entries(base?.tokens ?? {})) tokens[k.toLowerCase()] = { ...v, image: v?.image ?? def };
  for (const [k, v] of Object.entries(base?.unshielded ?? {}))
    unshielded[k.toLowerCase()] = { ...v, image: v?.image ?? def };
  const list = (o.nightMarketTokens as { tokens?: unknown })?.tokens;
  if (!Array.isArray(list)) fail("Night Market's token list has no `tokens` array");
  const seen = new Set<string>();
  for (const t of list as any[]) {
    const colour = String(t?.midnightColour ?? '')
      .replace(/^0x/, '')
      .toLowerCase();
    if (!HEX64.test(colour)) fail(`${JSON.stringify(t?.symbol)}: midnightColour is not 64 hex`);
    if (seen.has(colour)) fail(`${t.symbol}: the colour ${colour} is listed twice`);
    seen.add(colour);
    const symbol = String(t.symbol ?? '');
    if (!symbol || Buffer.byteLength(symbol) > 10) fail(`${colour}: symbol must be 1..10 bytes`);
    if (!Number.isInteger(t.decimals) || t.decimals < 0 || t.decimals > 255) fail(`${symbol}: decimals ${t.decimals}`);
    const bridged = o.journey.tokens.find((j) => j.colour.toLowerCase() === colour);
    const name = midnightName(bridged ? bridged.name : String(t.name ?? symbol));
    const info: InjectorTokenInfo = bridged
      ? {
          name,
          symbol: bridgedSymbol(bridged.symbol, colour),
          decimals: bridged.decimals,
          image: midnightImage(o.icons, bridged.symbol) ?? def,
          description: `Midnight half of ${bridged.name} (SPL mint ${bridged.splMint}), bridged; display only`,
        }
      : {
          name,
          symbol,
          decimals: t.decimals,
          image: midnightImage(o.icons, symbol) ?? def,
          description: `Night Market token ${symbol} on Midnight; display only`,
        };
    if (bridged && bridged.decimals !== t.decimals)
      fail(`${symbol}: Night Market lists ${t.decimals} decimals, I-1 ${bridged.decimals}`);
    if (t.privacy === 'unshielded') unshielded[colour] = info;
    else tokens[colour] = info;
  }
  for (const j of o.journey.tokens)
    if (!seen.has(j.colour.toLowerCase())) fail(`I-1's ${j.symbol} is not in Night Market's token list`);
  return {
    network: o.network,
    note: "Generated by AA 00057 e2e/registry/build.ts injector-tokens from Night Market's token list, I-1 and the icon table (e2e/registry/token-icons.json).",
    tokens,
    ...(Object.keys(unshielded).length > 0 ? { unshielded } : {}),
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
