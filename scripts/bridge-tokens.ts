// AA 00060 P4.1 (spec FR-013): generate the site's and the relay's token lists, pairs and bridge registry
// from ONE journey registry (I-1, `journey-tokens.<network>.json`). The logic is
// packages/core/src/bridge/token-lists.ts (`bridgeTokenLists`); this is its command line.
//
//   bun scripts/bridge-tokens.ts <journey-tokens.json> --site-config <config.json> --relay-tokens <tokens.json>
//       [--pairs X/Y,…] [--mode extend|replace] [--solana-rpc <url>] [--out-site <file>] [--out-relay <file>]
//
// It reads the site's config.json (its `network`, and the tokens/pairs already there) and the relay's
// TOKENS_FILE (when it exists; `extend` keeps what it lists), and writes both back (or to --out-*): the
// site's `tokens`, `pairs` and `bridges`, the relay's tokens. With --solana-rpc it also checks each mint
// on that RPC (the classic SPL Token program owns it, its decimals are I-1's) and the RPC's genesis hash.
// It prints the lists' digest (`GET /v1/config` `tokensDigest`). Exit codes: 0 written; 65 refused (the
// reason is named: `bridge-tokens: refused: <reason>: …`); 64 usage.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { BridgeTokensError, bridgeTokenLists, type SolanaFacts } from '@nightmarket/core/bridge';

const usage = (m: string): never => {
  console.error(`bridge-tokens: ${m}`);
  console.error(
    'usage: bun scripts/bridge-tokens.ts <journey-tokens.json> --site-config <config.json> --relay-tokens <tokens.json> [--pairs X/Y,…] [--mode extend|replace] [--solana-rpc <url>] [--out-site <file>] [--out-relay <file>]',
  );
  process.exit(64);
};

export interface CliArgs {
  journey: string;
  siteConfig: string;
  relayTokens: string;
  pairs: string[];
  mode: 'extend' | 'replace';
  solanaRpc: string | null;
  outSite: string;
  outRelay: string;
}

export function parseArgs(argv: string[]): CliArgs {
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const v = argv[i + 1];
      if (v === undefined) usage(`${a} needs a value`);
      flags[a.slice(2)] = v!;
      i++;
    } else positional.push(a);
  }
  if (positional.length !== 1) usage('give exactly one journey registry file');
  for (const f of Object.keys(flags)) {
    if (!['site-config', 'relay-tokens', 'pairs', 'mode', 'solana-rpc', 'out-site', 'out-relay'].includes(f))
      usage(`unknown flag --${f}`);
  }
  if (!flags['site-config'] || !flags['relay-tokens']) usage('--site-config and --relay-tokens are required');
  const mode = flags.mode ?? 'extend';
  if (mode !== 'extend' && mode !== 'replace') usage('--mode is extend or replace');
  return {
    journey: positional[0]!,
    siteConfig: flags['site-config']!,
    relayTokens: flags['relay-tokens']!,
    pairs: flags.pairs
      ? flags.pairs
          .split(',')
          .map((p) => p.trim())
          .filter(Boolean)
      : [],
    mode: mode as 'extend' | 'replace',
    solanaRpc: flags['solana-rpc'] ?? null,
    outSite: flags['out-site'] ?? flags['site-config']!,
    outRelay: flags['out-relay'] ?? flags['relay-tokens']!,
  };
}

/** The Solana RPC's facts for every mint of the registry: its genesis hash, and each mint's owner and decimals. */
export async function solanaFacts(
  rpcUrl: string,
  mints: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<SolanaFacts> {
  const call = async (method: string, params: unknown[]) => {
    const res = await fetchImpl(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const body = (await res.json()) as { result?: unknown; error?: { message: string } };
    if (body.error) throw new Error(`${method}: ${body.error.message}`);
    return body.result;
  };
  const genesisHash = String(await call('getGenesisHash', []));
  const out: SolanaFacts = { genesisHash, mints: {} };
  for (const mint of mints) {
    const r = (await call('getAccountInfo', [mint, { encoding: 'base64' }])) as {
      value: { owner: string; data: [string, string] } | null;
    };
    if (!r?.value) continue;
    const data = Buffer.from(r.value.data[0], 'base64');
    // The SPL Mint layout: COption<Pubkey> mint authority (36), supply u64 (8), decimals u8 at 44.
    out.mints[mint] = { owner: r.value.owner, decimals: data.length >= 45 ? data[44]! : null };
  }
  return out;
}

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));
const write = (path: string, value: unknown) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);

export async function main(argv: string[], fetchImpl: typeof fetch = fetch): Promise<number> {
  const args = parseArgs(argv);
  const journey = readJson(args.journey) as { tokens?: { splMint?: string }[] };
  const siteConfig = (existsSync(args.siteConfig) ? readJson(args.siteConfig) : {}) as Record<string, unknown>;
  const relayTokens = existsSync(args.relayTokens) ? readJson(args.relayTokens) : undefined;
  try {
    const solana = args.solanaRpc
      ? await solanaFacts(
          args.solanaRpc,
          (journey.tokens ?? []).map((t) => String(t.splMint)),
          fetchImpl,
        )
      : undefined;
    const lists = bridgeTokenLists({
      journey,
      siteConfig,
      ...(relayTokens !== undefined ? { relayTokens } : {}),
      pairs: args.pairs,
      mode: args.mode,
      ...(solana ? { solana } : {}),
    });
    write(args.outSite, lists.siteConfig);
    write(args.outRelay, lists.relayTokens);
    console.log(`bridge-tokens: wrote ${args.outSite} and ${args.outRelay}`);
    console.log(
      `bridge-tokens: ${lists.bridged.map((b) => b.symbol).join(', ')} bridged; tokensDigest ${lists.tokensDigest}`,
    );
    return 0;
  } catch (e) {
    if (e instanceof BridgeTokensError) {
      console.error(`bridge-tokens: refused: ${e.message}`);
      return 65;
    }
    throw e;
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
