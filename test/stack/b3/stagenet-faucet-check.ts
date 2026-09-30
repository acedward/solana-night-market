// A tiny STAGENET check of the demo-token path (AA 00047 B3; the full acceptance is plan P6.3): with
// the relay's own code, check a stagenet faucet's on-chain `mint` verifier key against the key
// volume, then mint a small amount to the funding wallet's own coin key (the first half of the
// `via-sponsor` path): the faucet's mint proved on rc.8, the wallet's DUST on rc.6, the transaction
// accepted by stagenet. About 1 DUST.
//
//   FUNDER_SEED_FILE=<the funding wallet's seed file, mounted read-only> CHECK_SYMBOL=twUSDC \
//   CHECK_AMOUNT=1 bun test/stack/b3/stagenet-faucet-check.ts
//
// The caller holds the shared funding lock for the whole run (test/stack/b3/README.md). The seed is
// read in-process only; nothing secret is printed: the output is the faucet, the transaction, the
// wallet's DUST before and after, and the timings.

import { readFileSync } from 'node:fs';

import { parseUnits, registryFor } from '@nightmarket/core';

import { parseSponsorSeed } from '../../../relay/src/config.js';
import { DemoFaucets } from '../../../relay/src/demo/faucet.js';
import { resolvePack } from '../../../relay/src/demo/pack.js';
import { createLogger } from '../../../relay/src/log.js';
import { PassportRuntime } from '../../../relay/src/passport/runtime.js';
import { openFacadeWallet } from '../../../relay/src/sponsor/facade.js';

const env = (k: string, d?: string) => {
  const v = process.env[k] ?? d;
  if (v === undefined || v === '') throw new Error(`${k} is required`);
  return v;
};
const log = createLogger({ level: 'warn' }, { service: 'stagenet-faucet-check' });
const symbol = env('CHECK_SYMBOL', 'twUSDC');
const amount = env('CHECK_AMOUNT', '1');
const tokens = registryFor('stagenet');
const [item] = resolvePack([{ symbol, amount }], tokens);
const t0 = Date.now();
const secs = () => Math.round((Date.now() - t0) / 100) / 10;
const out: Record<string, unknown> = {
  symbol,
  amount,
  baseUnits: parseUnits(amount, item!.decimals).toString(),
  faucet: item!.faucet,
};

const endpoints = {
  networkId: 'stagenet',
  indexerUrl: 'https://indexer.stagenet.shielded.tools/api/v4/graphql',
  indexerWsUrl: 'wss://indexer.stagenet.shielded.tools/api/v4/graphql/ws',
  nodeWsUrl: 'wss://rpc.stagenet.shielded.tools',
  dustProofServerUrl: env('MIDNIGHT_DUST_PROOF_SERVER_URL'),
};
const rt = await PassportRuntime.load({
  managedPath: env('MIDNIGHT_MANAGED_PATH', '/app/vendor/passport/contract/contracts/managed'),
  networkId: 'stagenet',
  indexerUrl: endpoints.indexerUrl,
  indexerWsUrl: endpoints.indexerWsUrl,
  contractProofServerUrl: env('MIDNIGHT_CONTRACT_PROOF_SERVER_URL'),
  log,
});
const opened = await openFacadeWallet(parseSponsorSeed(readFileSync(env('FUNDER_SEED_FILE'), 'utf8')), endpoints, {
  feeBlocksMargin: 20,
});
const dust = async () => {
  const Rx = await import('rxjs');
  const s = (await Rx.firstValueFrom(
    (opened.handle as { wallet: { state(): { pipe(...o: unknown[]): unknown } } }).wallet
      .state()
      .pipe(Rx.filter((x: unknown) => (x as { isSynced?: boolean }).isSynced === true)) as never,
  )) as { dust: { balance(t: Date): bigint } };
  return s.dust.balance(new Date());
};
try {
  const before = await dust();
  out.syncedAfterSeconds = secs();
  out.dustBefore = (Number(before) / 1e15).toFixed(6);
  const faucets = new DemoFaucets(rt, log);
  await faucets.checkFaucet(item!.faucet);
  out.faucetMintKeyMatches = true;
  const t1 = Date.now();
  out.mintTx = await faucets.mintToSponsor({ wallet: opened.handle as never, item: item! });
  out.mintSeconds = Math.round((Date.now() - t1) / 100) / 10;
  const after = await dust();
  out.dustAfter = (Number(after) / 1e15).toFixed(6);
  out.dustSpent = (Number(before - after) / 1e15).toFixed(6);
} finally {
  await opened.stop().catch(() => {});
}
out.totalSeconds = secs();
process.stdout.write(`STAGENET-FAUCET-CHECK ${JSON.stringify(out)}\n`);
process.exit(0);
