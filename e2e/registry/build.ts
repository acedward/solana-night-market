// AA 00057 P1: the journey token registry generator (I-1, owner 00057). It reads the bridge deployments'
// records (I-3 (c), `effectstream.solana-midnight-bridge.deployment/1`, written by 00058's
// `bun run bridge:record` and served by each bridge node at `GET /deployment`) and writes ONE
// `journey-tokens.<midnight-network>.json`:
//
//   { "midnightNetwork": "<net>", "solanaGenesisHash": "<base58>",
//     "tokens": [ { "colour", "splMint", "bridgeContract", "bridgeProgram", "bridgeApi",
//                   "name", "symbol", "decimals" } ] }
//
// Each entry is one record: `bridgeApi` is the record's `api`, `decimals` its `splMintDecimals` (read from
// the mint by bridge:record; re-read here with --solana-rpc). Nothing is guessed: a record without a
// `name` or a `symbol` is refused (I-3 keeps them optional, I-1 needs them).
//
// It refuses, naming the reason, and writes nothing:
//   - a record that is not a deployment record (`record-shape`, `wrong-schema`);
//   - a record for another Midnight network than --network (`wrong-network`);
//   - records that name different Solana genesis hashes (`mixed-genesis`), or another one than --genesis
//     or the --solana-rpc's `getGenesisHash` (`wrong-genesis-hash`);
//   - two records for one SPL mint (`duplicate-mint`: I-1 lists ONE canonical deployment per mint), one
//     bridge contract (`duplicate-contract`) or one symbol, case aside (`duplicate-symbol`);
//   - a symbol that is not 1-8 printable ASCII characters without a space (`bad-symbol`: the account
//     contract's messages show at most 8 characters, 00060 Q4), a missing or over-long name
//     (`missing-name`), decimals outside 0..18 (`decimals`);
//   - a colour that is not `tokenType(domainSep(splMint), bridgeContract)` (`colour-mismatch`);
//   - with --solana-rpc: a mint the RPC does not have (`mint-missing`), one the classic SPL Token program
//     does not own (`mint-not-classic`), or whose decimals differ from the record's (`mint-decimals`);
//   - and, last, anything Night Market's own I-1 parser refuses (`registry-refused`), so a written file is
//     always one the site, the relay and the injector accept.
//
//   bun e2e/registry/build.ts --network <midnight-network> [--genesis <base58>] [--solana-rpc <url>]
//       [--out <file> | --out-dir <dir>] <record.json | http(s)://<bridge node origin>> ...
//
// A positional `http(s)://` origin is read as `<origin>/deployment`. Exit codes: 0 written; 65 refused
// (`journey-registry: refused: <reason>: …`); 64 usage.
//
// AA 00057 P3b.3 (questions Q10): with the icon table (`--icons`, default ./token-icons.json; `none`: none),
// each entry also gets `image` and `splImage` (HTTPS URLs: the wallet, through the injector) and `icon`
// (Night Market FR-022: the same file on the site's own origin); `--site-icons-out` writes the site's icon
// map from the same table. A second mode writes the injector's own token file from Night Market's full
// token list (./icons.ts `injectorTokenFile`):
//
//   bun e2e/registry/build.ts injector-tokens --network <net> --journey <I-1> --nm-tokens <relay TOKENS_FILE>
//       [--base <the injector's bundled tokens.<net>.json>] [--icons <table>] --out <file>

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BridgeRegistryError, bridgeColourOf, parseJourneyRegistry } from '@nightmarket/core/bridge';

import { solanaFacts } from '../../scripts/bridge-tokens.js';
import {
  IconTableError,
  InjectorTokensError,
  injectorTokenFile,
  parseIconTable,
  siteIconMap,
  withIcons,
  type IconTable,
} from './icons.js';

export const DEPLOYMENT_RECORD_SCHEMA = 'effectstream.solana-midnight-bridge.deployment/1';
export const CLASSIC_SPL_TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

export type JourneyBuildRefusal =
  | 'no-records'
  | 'record-shape'
  | 'wrong-schema'
  | 'wrong-network'
  | 'mixed-genesis'
  | 'wrong-genesis-hash'
  | 'missing-name'
  | 'bad-symbol'
  | 'decimals'
  | 'duplicate-mint'
  | 'duplicate-contract'
  | 'duplicate-symbol'
  | 'colour-mismatch'
  | 'mint-missing'
  | 'mint-not-classic'
  | 'mint-decimals'
  | 'registry-refused';

export class JourneyBuildError extends Error {
  override name = 'JourneyBuildError';
  constructor(
    readonly reason: JourneyBuildRefusal,
    message: string,
  ) {
    super(`${reason}: ${message}`);
  }
}

/** The I-3 (c) fields this generator reads (the record may carry more; they are ignored). */
export interface DeploymentRecord {
  schema: string;
  splMint: string;
  splMintDecimals: number;
  name?: string;
  symbol?: string;
  bridgeProgram: string;
  bridgeContract: string;
  colour: string;
  midnightNetwork: string;
  solanaGenesisHash: string;
  api: string;
}

export interface JourneyToken {
  colour: string;
  splMint: string;
  bridgeContract: string;
  bridgeProgram: string;
  bridgeApi: string;
  name: string;
  symbol: string;
  decimals: number;
  /** P3b.3 (Q10): the Midnight-side token's icon (an HTTPS URL; the wallet, through the injector). */
  image?: string;
  /** P3b.3 (Q10): the real SPL token's icon (an HTTPS URL; the injector's metadata fill-in, 00059 P7). */
  splImage?: string;
  /** P3b.3 (FR-022): the SPL token's icon on Night Market's own origin (the same file, bundled by the site). */
  icon?: string;
}

export interface JourneyRegistry {
  midnightNetwork: string;
  solanaGenesisHash: string;
  tokens: JourneyToken[];
}

/** What the Solana RPC says (scripts/bridge-tokens.ts `solanaFacts`). */
export interface SolanaMintFacts {
  genesisHash: string;
  mints: Record<string, { owner: string; decimals: number | null } | undefined>;
}

export interface BuildExpect {
  /** The Midnight network every record must name (and the file's name). */
  midnightNetwork: string;
  /** The Solana cluster's genesis hash every record must name, when known. */
  solanaGenesisHash?: string;
  /** The Solana RPC's facts, to re-check the genesis hash and every mint. */
  solana?: SolanaMintFacts;
  /** P3b.3: the icon table (./token-icons.json): each entry gains `image`, `splImage` and `icon`. */
  icons?: IconTable;
}

const refuse = (reason: JourneyBuildRefusal, message: string): never => {
  throw new JourneyBuildError(reason, message);
};

const SYMBOL = /^[\x21-\x7e]{1,8}$/;
const NAME = /^[\x20-\x7e]{1,64}$/;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Check one record's shape; returns it typed. */
export function readRecord(raw: unknown, at: string): DeploymentRecord {
  if (!isObject(raw)) return refuse('record-shape', `${at} is not a JSON object`);
  if (raw.schema !== DEPLOYMENT_RECORD_SCHEMA) {
    refuse('wrong-schema', `${at}: schema ${JSON.stringify(raw.schema)} is not ${DEPLOYMENT_RECORD_SCHEMA}`);
  }
  for (const k of [
    'splMint',
    'bridgeProgram',
    'bridgeContract',
    'colour',
    'midnightNetwork',
    'solanaGenesisHash',
    'api',
  ] as const) {
    if (typeof raw[k] !== 'string' || raw[k] === '') refuse('record-shape', `${at}: ${k} is not a non-empty string`);
  }
  if (typeof raw.splMintDecimals !== 'number') refuse('record-shape', `${at}: splMintDecimals is not a number`);
  for (const k of ['name', 'symbol'] as const) {
    if (raw[k] !== undefined && typeof raw[k] !== 'string') refuse('record-shape', `${at}: ${k} is not a string`);
  }
  return raw as unknown as DeploymentRecord;
}

/** Build I-1 from deployment records (in the given order); throws `JourneyBuildError` naming the first refusal. */
export function buildJourneyRegistry(records: readonly unknown[], expect: BuildExpect): JourneyRegistry {
  if (records.length === 0) refuse('no-records', 'give at least one deployment record');
  const recs = records.map((r, i) => readRecord(r, `record ${i + 1}`));
  const genesis = recs[0]!.solanaGenesisHash;
  const mints = new Map<string, number>();
  const contracts = new Map<string, number>();
  const symbols = new Map<string, number>();
  const tokens: JourneyToken[] = recs.map((r, i) => {
    const at = `record ${i + 1} (${JSON.stringify(r.symbol ?? r.splMint)})`;
    if (r.midnightNetwork !== expect.midnightNetwork) {
      refuse('wrong-network', `${at} is for ${r.midnightNetwork}, not ${expect.midnightNetwork}`);
    }
    if (r.solanaGenesisHash !== genesis) {
      refuse('mixed-genesis', `${at} names the Solana genesis ${r.solanaGenesisHash}, record 1 names ${genesis}`);
    }
    if (expect.solanaGenesisHash !== undefined && r.solanaGenesisHash !== expect.solanaGenesisHash) {
      refuse(
        'wrong-genesis-hash',
        `${at} names the Solana genesis ${r.solanaGenesisHash}, not ${expect.solanaGenesisHash}`,
      );
    }
    if (r.name === undefined || !NAME.test(r.name)) {
      refuse('missing-name', `${at}: a journey token needs a name of 1 to 64 printable ASCII characters`);
    }
    if (r.symbol === undefined || !SYMBOL.test(r.symbol)) {
      refuse('bad-symbol', `${at}: a symbol must be 1 to 8 printable ASCII characters without a space`);
    }
    if (!Number.isInteger(r.splMintDecimals) || r.splMintDecimals < 0 || r.splMintDecimals > 18) {
      refuse('decimals', `${at}: splMintDecimals ${r.splMintDecimals} is not an integer in 0..18`);
    }
    const contract = r.bridgeContract.replace(/^0x/, '').toLowerCase();
    const colour = r.colour.replace(/^0x/, '').toLowerCase();
    const seenMint = mints.get(r.splMint);
    if (seenMint !== undefined) {
      refuse('duplicate-mint', `${at}: the SPL mint ${r.splMint} is also record ${seenMint} (one deployment per mint)`);
    }
    const seenContract = contracts.get(contract);
    if (seenContract !== undefined)
      refuse('duplicate-contract', `${at}: the bridge contract is also record ${seenContract}`);
    const seenSymbol = symbols.get(r.symbol!.toLowerCase());
    if (seenSymbol !== undefined) refuse('duplicate-symbol', `${at}: the symbol is also record ${seenSymbol}`);
    let derived: string;
    try {
      derived = bridgeColourOf(r.splMint, contract);
    } catch (e) {
      return refuse('record-shape', `${at}: ${(e as Error).message}`);
    }
    if (derived !== colour) {
      refuse(
        'colour-mismatch',
        `${at}: colour ${colour} is not tokenType(domainSep(splMint), bridgeContract) = ${derived}`,
      );
    }
    if (expect.solana) {
      const m = expect.solana.mints[r.splMint];
      if (!m) refuse('mint-missing', `${at}: the Solana RPC has no account ${r.splMint}`);
      if (m!.owner !== CLASSIC_SPL_TOKEN_PROGRAM) {
        refuse('mint-not-classic', `${at}: ${r.splMint} is owned by ${m!.owner}, not the classic SPL Token program`);
      }
      if (m!.decimals !== r.splMintDecimals) {
        refuse(
          'mint-decimals',
          `${at}: the mint has ${m!.decimals} decimals on chain, the record says ${r.splMintDecimals}`,
        );
      }
    }
    mints.set(r.splMint, i + 1);
    contracts.set(contract, i + 1);
    symbols.set(r.symbol!.toLowerCase(), i + 1);
    return {
      colour,
      splMint: r.splMint,
      bridgeContract: contract,
      bridgeProgram: r.bridgeProgram,
      bridgeApi: r.api,
      name: r.name!,
      symbol: r.symbol!,
      decimals: r.splMintDecimals,
    };
  });
  if (expect.solana && expect.solana.genesisHash !== genesis) {
    refuse(
      'wrong-genesis-hash',
      `the records name the Solana genesis ${genesis}, the RPC's is ${expect.solana.genesisHash}`,
    );
  }
  const out: JourneyRegistry = {
    midnightNetwork: expect.midnightNetwork,
    solanaGenesisHash: genesis,
    tokens: expect.icons ? withIcons(expect.icons, tokens) : tokens,
  };
  try {
    parseJourneyRegistry(out, { midnightNetwork: expect.midnightNetwork, solanaGenesisHash: genesis });
  } catch (e) {
    if (e instanceof BridgeRegistryError)
      refuse('registry-refused', `Night Market's I-1 parser refuses it: ${e.message}`);
    throw e;
  }
  return out;
}

/** The file name I-1 gives a network's registry. */
export const journeyFileName = (midnightNetwork: string): string => `journey-tokens.${midnightNetwork}.json`;

// ── command line ───────────────────────────────────────────────────────────

export interface CliArgs {
  network: string;
  genesis: string | null;
  solanaRpc: string | null;
  out: string;
  sources: string[];
  /** P3b.3: the icon table (default ./token-icons.json; `none`: no icons). */
  icons: string | null;
  /** P3b.3: also write Night Market's site icon map (scripts/token-icons.json's format) here. */
  siteIconsOut: string | null;
}

/** The default icon table: ./token-icons.json. */
export const DEFAULT_ICON_TABLE = fileURLToPath(new URL('./token-icons.json', import.meta.url));
export const readIconTable = (path: string): IconTable => parseIconTable(JSON.parse(readFileSync(path, 'utf8')));

class UsageError extends Error {}

export function parseArgs(argv: string[]): CliArgs {
  const flags: Record<string, string> = {};
  const sources: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const v = argv[i + 1];
      if (v === undefined) throw new UsageError(`${a} needs a value`);
      const k = a.slice(2);
      if (!['network', 'genesis', 'solana-rpc', 'out', 'out-dir', 'icons', 'site-icons-out'].includes(k))
        throw new UsageError(`unknown flag ${a}`);
      flags[k] = v;
      i++;
    } else sources.push(a);
  }
  if (!flags.network || !/^[a-z0-9-]{1,32}$/.test(flags.network))
    throw new UsageError('--network <midnight network> is required');
  if (sources.length === 0)
    throw new UsageError('give at least one deployment record (a file or a bridge node origin)');
  if (flags.out && flags['out-dir']) throw new UsageError('give --out or --out-dir, not both');
  return {
    network: flags.network,
    genesis: flags.genesis ?? null,
    solanaRpc: flags['solana-rpc'] ?? null,
    out: flags.out ?? join(flags['out-dir'] ?? '.', journeyFileName(flags.network)),
    sources,
    icons: flags.icons === 'none' ? null : (flags.icons ?? DEFAULT_ICON_TABLE),
    siteIconsOut: flags['site-icons-out'] ?? null,
  };
}

/** A record from a file, or from a bridge node's `GET /deployment` (a positional http(s) origin). */
export async function loadRecord(source: string, fetchImpl: typeof fetch = fetch): Promise<unknown> {
  if (/^https?:\/\//.test(source)) {
    const url = `${source.replace(/\/+$/, '')}/deployment`;
    const res = await fetchImpl(url);
    if (!res.ok) throw new JourneyBuildError('record-shape', `${url} answered ${res.status}`);
    return res.json();
  }
  return JSON.parse(readFileSync(source, 'utf8'));
}

export async function main(argv: string[], fetchImpl: typeof fetch = fetch): Promise<number> {
  if (argv[0] === 'injector-tokens') return injectorTokensMain(argv.slice(1));
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    console.error(`journey-registry: ${e.message}`);
    console.error(
      'usage: bun e2e/registry/build.ts --network <net> [--genesis <base58>] [--solana-rpc <url>] [--out <file> | --out-dir <dir>] [--icons <table.json>|none] [--site-icons-out <file>] <record.json | http(s)://origin> ...',
    );
    return 64;
  }
  try {
    const records: unknown[] = [];
    for (const s of args.sources) records.push(await loadRecord(s, fetchImpl));
    const expect: BuildExpect = {
      midnightNetwork: args.network,
      ...(args.genesis ? { solanaGenesisHash: args.genesis } : {}),
      ...(args.icons ? { icons: readIconTable(args.icons) } : {}),
    };
    // The records' own checks first, so the RPC is asked only about mints of well-formed records.
    let reg = buildJourneyRegistry(records, expect);
    if (args.solanaRpc) {
      const solana = await solanaFacts(
        args.solanaRpc,
        reg.tokens.map((t) => t.splMint),
        fetchImpl,
      );
      reg = buildJourneyRegistry(records, { ...expect, solana });
    }
    writeFileSync(args.out, `${JSON.stringify(reg, null, 2)}\n`);
    console.log(
      `journey-registry: wrote ${args.out}: ${reg.tokens.map((t) => `${t.symbol} ${t.colour.slice(0, 8)}…`).join(', ')}`,
    );
    if (args.siteIconsOut) {
      if (!expect.icons) throw new JourneyBuildError('record-shape', '--site-icons-out needs an icon table');
      writeFileSync(args.siteIconsOut, `${JSON.stringify(siteIconMap(expect.icons), null, 2)}\n`);
      console.log(`journey-registry: wrote the site's icon map ${args.siteIconsOut}`);
    }
    return 0;
  } catch (e) {
    if (e instanceof JourneyBuildError || e instanceof IconTableError) {
      console.error(`journey-registry: refused: ${e.message}`);
      return 65;
    }
    throw e;
  }
}

/**
 * `build.ts injector-tokens --network <net> --journey <I-1> --nm-tokens <relay TOKENS_FILE> [--base <file>]
 * [--icons <table>] --out <file>`: the injector's token file (its TOKEN_REGISTRY) from Night Market's full
 * token list, I-1 and the icon table (./icons.ts `injectorTokenFile`).
 */
export async function injectorTokensMain(argv: string[]): Promise<number> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i]!;
    const v = argv[i + 1];
    if (
      !k.startsWith('--') ||
      v === undefined ||
      !['network', 'journey', 'nm-tokens', 'base', 'icons', 'out'].includes(k.slice(2))
    ) {
      console.error(`journey-registry injector-tokens: bad argument ${k}`);
      console.error(
        'usage: bun e2e/registry/build.ts injector-tokens --network <net> --journey <I-1> --nm-tokens <tokens.json> [--base <file>] [--icons <table>] --out <file>',
      );
      return 64;
    }
    flags[k.slice(2)] = v;
  }
  if (!flags.network || !flags.journey || !flags['nm-tokens'] || !flags.out) {
    console.error('journey-registry injector-tokens: --network, --journey, --nm-tokens and --out are required');
    return 64;
  }
  const read = (p: string): unknown => JSON.parse(readFileSync(p, 'utf8'));
  try {
    const journey = read(flags.journey) as { midnightNetwork?: string; tokens: never[] };
    if (journey.midnightNetwork !== flags.network)
      throw new InjectorTokensError(
        `injector tokens: I-1 is for ${String(journey.midnightNetwork)}, not ${flags.network}`,
      );
    const file = injectorTokenFile({
      network: flags.network,
      nightMarketTokens: read(flags['nm-tokens']),
      journey,
      icons: readIconTable(flags.icons ?? DEFAULT_ICON_TABLE),
      ...(flags.base ? { base: read(flags.base) } : {}),
    });
    writeFileSync(flags.out, `${JSON.stringify(file, null, 2)}\n`);
    console.log(
      `journey-registry: wrote the injector's token file ${flags.out}: ${Object.values(file.tokens)
        .map((t) => `${t.symbol} ${t.decimals}`)
        .join(', ')}`,
    );
    return 0;
  } catch (e) {
    if (e instanceof InjectorTokensError || e instanceof IconTableError) {
      console.error(`journey-registry: refused: ${e.message}`);
      return 65;
    }
    throw e;
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
