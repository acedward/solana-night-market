// Local-stack harness (AA 00047 B3): deploy mint-test-tokens v2 shielded faucets on a ledger-9
// localnet, from the key volume's `faucet` bundle (the vendored contracts/faucet source, compiled by
// the key job with compactc 0.34.0), and print the relay's TOKENS_FILE for them.
//
//   FUNDER_SEED_FILE=<a funded local seed file> MIDNIGHT_MANAGED_PATH=<key volume> \
//   FAUCETS=twUSDC:6,twBTC:8 bun test/stack/b3/deploy-faucets.ts > tokens.json
//
// AA 00047 P9.I: FAUCET_BUNDLE=<a compiled mint-test-tokens v2 `unshielded-token.compact` bundle>
// PRIVACY=unshielded deploys UNSHIELDED faucets the same way (same constructor), so the harness can
// give an account an unshielded balance of a listed token (test/stack/p6/fund-unshielded.ts).
//
// Runs in a Bun container on the stack's network (test/stack/b3/run-local.sh). The seed is a LOCAL
// development seed (the localnet's genesis wallets); only public values are printed.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { parseSponsorSeed } from '../../../relay/src/config.js';
import { createLogger } from '../../../relay/src/log.js';
import { PassportRuntime } from '../../../relay/src/passport/runtime.js';
import { openFacadeWallet } from '../../../relay/src/sponsor/facade.js';

const env = (k: string, d?: string) => {
  const v = process.env[k] ?? d;
  if (v === undefined || v === '') throw new Error(`${k} is required`);
  return v;
};
const log = createLogger({ level: 'warn' }, { service: 'deploy-faucets' });
const managedPath = env('MIDNIGHT_MANAGED_PATH', '/app/vendor/passport/contract/contracts/managed');
const indexerUrl = env('MIDNIGHT_INDEXER_URL', 'http://indexer:8088/api/v4/graphql');
const indexerWsUrl = env('MIDNIGHT_INDEXER_WS_URL', 'ws://indexer:8088/api/v4/graphql/ws');
const privacy = env('PRIVACY', 'shielded') as 'shielded' | 'unshielded';
const faucets = env('FAUCETS', 'twUSDC:6,twBTC:8')
  .split(',')
  .map((s) => {
    const [symbol, decimals] = s.split(':');
    return { symbol: symbol!, decimals: Number(decimals) };
  });

const bytes32 = (text: string) => {
  const out = new Uint8Array(32);
  out.set(new TextEncoder().encode(text));
  return out;
};

const seedHex = parseSponsorSeed(readFileSync(env('FUNDER_SEED_FILE', '/run/secrets/funder'), 'utf8'));
const runtime = await PassportRuntime.load({
  managedPath,
  networkId: 'undeployed',
  indexerUrl,
  indexerWsUrl,
  contractProofServerUrl: env('MIDNIGHT_CONTRACT_PROOF_SERVER_URL', 'http://proof-server-rc8:6300'),
  log,
});
const opened = await openFacadeWallet(
  seedHex,
  {
    networkId: 'undeployed',
    indexerUrl,
    indexerWsUrl,
    nodeWsUrl: env('MIDNIGHT_NODE_WS_URL', 'ws://node:9944'),
    dustProofServerUrl: env('MIDNIGHT_DUST_PROOF_SERVER_URL', 'http://proof-server:6300'),
  },
  { feeBlocksMargin: 20 },
);
try {
  const bundle = process.env.FAUCET_BUNDLE ?? join(managedPath, 'faucet');
  const mod = (await import(pathToFileURL(join(bundle, 'contract', 'index.js')).href)) as { Contract: unknown };
  const { CompiledContract } = await import('@midnight-ntwrk/compact-js');
  const { NodeZkConfigProvider } = await import('@midnight-ntwrk/midnight-js-node-zk-config-provider');
  const { deployContract } = await import('@midnight-ntwrk/midnight-js-contracts');
  const ledger = await import('@midnightntwrk/ledger-v9');
  const cc = CompiledContract as unknown as {
    make(t: string, c: unknown): { pipe(...o: unknown[]): unknown };
    withVacantWitnesses: unknown;
    withCompiledFileAssets(p: string): unknown;
  };
  const compiled = cc.make('faucet', mod.Contract).pipe(cc.withVacantWitnesses, cc.withCompiledFileAssets(bundle));
  const base = await runtime.providers(opened.handle as never);
  const providers = { ...base, zkConfigProvider: new NodeZkConfigProvider(bundle) };
  const tokens = [];
  for (const f of faucets) {
    const domainSeparator = `mint-test-tokens:${f.symbol}`;
    const t0 = Date.now();
    const deployed = (await (deployContract as unknown as (p: unknown, o: unknown) => Promise<unknown>)(providers, {
      compiledContract: compiled,
      args: [`Test ${f.symbol}`, f.symbol, BigInt(f.decimals), bytes32(domainSeparator)],
    })) as { deployTxData: { public: { contractAddress: string; txId?: string } } };
    const address = deployed.deployTxData.public.contractAddress;
    const colour = String(
      (ledger as unknown as { rawTokenType(d: Uint8Array, a: string): string }).rawTokenType(
        bytes32(domainSeparator),
        address,
      ),
    );
    process.stderr.write(
      `deployed ${f.symbol} faucet ${address} (colour ${colour}, tx ${deployed.deployTxData.public.txId ?? '?'}, ${((Date.now() - t0) / 1000).toFixed(1)} s)\n`,
    );
    tokens.push({
      symbol: f.symbol,
      decimals: f.decimals,
      privacy,
      midnightColour: colour,
      contract: address,
      domainSeparator,
    });
  }
  process.stdout.write(`${JSON.stringify({ mode: 'replace', tokens }, null, 1)}\n`);
} finally {
  await opened.stop().catch(() => {});
}
process.exit(0);
