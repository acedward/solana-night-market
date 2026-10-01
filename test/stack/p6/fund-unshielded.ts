// P9.I (AA 00047) local stack: give a market account an UNSHIELDED balance, the way any third party
// can: the account's permissionless `deposit_unshielded(color, amount)`, paid from a localnet
// development wallet (its NIGHT, the all-zero colour by default). The demo-token pack is shielded
// only, so this is what lets the harness drive an unshielded withdrawal end to end.
//
//   FUNDER_SEED_FILE=<a localnet dev seed (never the relay's sponsor seed while the relay runs)> \
//   MIDNIGHT_MANAGED_PATH=<a key dir that also holds account/keys/deposit_unshielded.prover> \
//   FUND_ACCOUNT=<64 hex> [FUND_COLOUR=00…00] [FUND_AMOUNT=5000000] bun test/stack/p6/fund-unshielded.ts
//
// With MINT_FAUCET=<a deployed mint-test-tokens v2 UNSHIELDED faucet> and MINT_BUNDLE=<its compiled
// bundle>, it first mints FUND_AMOUNT of that faucet's token to the funder's own unshielded address,
// then deposits it (FUND_COLOUR must be that token). NIGHT itself cannot be used: the localnet node
// refuses `deposit_unshielded` of NIGHT into the account (`Custom error: 231`, P9.I local runs 2-3).
//
// Runs in a Bun container on the stack's network (test/stack/p6/run-local.sh). The relay's key volume
// keeps only the prover keys the relay uses, so run-local.sh passes a cloned key dir with the
// account's `deposit_unshielded` prover key added from the full keyed build. Only public values are
// printed.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { parseUnshieldedAddress } from '@nightmarket/core';

import { parseSponsorSeed } from '../../../relay/src/config.js';
import { createLogger } from '../../../relay/src/log.js';
import { PassportRuntime } from '../../../relay/src/passport/runtime.js';
import { syncedKeys } from '../../../relay/src/passport/wallet-provider.js';
import { openFacadeWallet } from '../../../relay/src/sponsor/facade.js';

const env = (k: string, d?: string) => {
  const v = process.env[k] ?? d;
  if (v === undefined || v === '') throw new Error(`${k} is required`);
  return v;
};
const unhex = (h: string) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ''), 'hex'));

const t0 = Date.now();
const log = createLogger({ level: 'warn' }, { service: 'fund-unshielded' });
const account = env('FUND_ACCOUNT').replace(/^0x/, '').toLowerCase();
const colour = env('FUND_COLOUR', '00'.repeat(32)).replace(/^0x/, '').toLowerCase();
const amount = BigInt(env('FUND_AMOUNT', '5000000'));
const indexerUrl = env('MIDNIGHT_INDEXER_URL', 'http://indexer:8088/api/v4/graphql');
const indexerWsUrl = env('MIDNIGHT_INDEXER_WS_URL', 'ws://indexer:8088/api/v4/graphql/ws');

const seedHex = parseSponsorSeed(readFileSync(env('FUNDER_SEED_FILE'), 'utf8'));
const runtime = await PassportRuntime.load({
  managedPath: env('MIDNIGHT_MANAGED_PATH', '/app/vendor/passport/contract/contracts/managed'),
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
const handle = opened.handle as Parameters<typeof syncedKeys>[0];
await syncedKeys(handle);
// The funder's own unshielded balance of the colour (public; a diagnosis when the deposit fails).
const balanceNow = () =>
  new Promise<bigint | null>((resolve) => {
    const w = (opened.handle as unknown as { wallet: { state(): { subscribe(o: object): { unsubscribe(): void } } } })
      .wallet;
    const timer = setTimeout(() => resolve(null), 60_000);
    const sub = w.state().subscribe({
      next: (st: { isSynced?: boolean; unshielded?: { balances?: Record<string, bigint> } }) => {
        if (st.isSynced !== true) return;
        const b = st.unshielded?.balances ?? {};
        clearTimeout(timer);
        resolve(BigInt(b[colour] ?? b[`0x${colour}`] ?? 0n));
        setTimeout(() => sub.unsubscribe(), 0);
      },
      error: () => resolve(null),
    });
  });
console.log(`funder unshielded balance of ${colour.slice(0, 8)}…: ${String(await balanceNow())}`);
try {
  const l = await runtime.ledgerState(account);
  if (!l?.booted) throw new Error('the account is not active');
  const providers = await runtime.providers(handle);
  const custody = await runtime.client.account.CustodyAccount.connect(
    providers,
    runtime.compiledAccount(),
    account,
    runtime.client.witnesses.emptyCoinStore(),
  );
  let minted: Record<string, unknown> | null = null;
  const mintFaucet = process.env.MINT_FAUCET;
  if (mintFaucet) {
    const bundle = env('MINT_BUNDLE');
    const mod = (await import(pathToFileURL(join(bundle, 'contract', 'index.js')).href)) as { Contract: unknown };
    const { CompiledContract } = await import('@midnight-ntwrk/compact-js');
    const { NodeZkConfigProvider } = await import('@midnight-ntwrk/midnight-js-node-zk-config-provider');
    const { findDeployedContract } = await import('@midnight-ntwrk/midnight-js-contracts');
    const { httpClientProofProvider } = await import('@midnight-ntwrk/midnight-js-http-client-proof-provider');
    const cc = CompiledContract as unknown as {
      make(t: string, c: unknown): { pipe(...o: unknown[]): unknown };
      withVacantWitnesses: unknown;
      withCompiledFileAssets(p: string): unknown;
    };
    const compiled = cc.make('faucet', mod.Contract).pipe(cc.withVacantWitnesses, cc.withCompiledFileAssets(bundle));
    const faucet = (await (findDeployedContract as unknown as (p: unknown, o: unknown) => Promise<unknown>)(
      // The relay runtime's proof provider indexes only the key volume's bundles: prove the faucet's
      // mint with midnight-js's own HTTP prover over this bundle (rc.8, as the relay's faucet mint).
      {
        ...providers,
        zkConfigProvider: new NodeZkConfigProvider(bundle),
        proofProvider: httpClientProofProvider(
          env('MIDNIGHT_CONTRACT_PROOF_SERVER_URL', 'http://proof-server-rc8:6300'),
          new NodeZkConfigProvider(bundle) as never,
        ),
      },
      { contractAddress: mintFaucet, compiledContract: compiled },
    )) as { callTx: { mint(r: unknown, a: bigint): Promise<{ public: { txId: string } }> } };
    const ks = (opened.handle as unknown as { unshieldedKeystore: { getBech32Address(): { asString(): string } } })
      .unshieldedKeystore;
    const me = parseUnshieldedAddress(ks.getBech32Address().asString(), 'undeployed');
    const tm = Date.now();
    const m = await faucet.callTx.mint(
      { is_left: false, left: { bytes: new Uint8Array(32) }, right: { bytes: unhex(me) } },
      amount,
    );
    minted = { faucet: mintFaucet, to: me, txId: m.public.txId, seconds: (Date.now() - tm) / 1000 };
    console.log(`MINTED ${JSON.stringify(minted)}`);
    // The deposit spends the minted output: wait until the wallet has seen it.
    for (let i = 0; i < 30; i++) {
      const b = await balanceNow();
      if (b !== null && b >= amount) break;
      await new Promise((res) => setTimeout(res, 2_000));
    }
    console.log(`funder unshielded balance after the mint: ${String(await balanceNow())}`);
  }
  const t1 = Date.now();
  const r = await custody.depositUnshielded(unhex(colour), amount);
  console.log(
    `FUNDED ${JSON.stringify({
      account,
      kind: 'unshielded',
      colour,
      amount: amount.toString(),
      txId: r.txId,
      minted,
      depositSeconds: (Date.now() - t1) / 1000,
      totalSeconds: (Date.now() - t0) / 1000,
    })}`,
  );
} finally {
  await opened.stop().catch(() => {});
}
process.exit(0);
