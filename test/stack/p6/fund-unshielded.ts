// P9.I (AA 00047) local stack: give a market account an UNSHIELDED balance, the way any third party
// can: the account's permissionless `deposit_unshielded(color, amount)`, paid from a localnet
// development wallet (its NIGHT, the all-zero colour by default). The demo-token pack is shielded
// only, so this is what lets the harness drive an unshielded withdrawal end to end.
//
//   FUNDER_SEED_FILE=<a localnet dev seed (never the relay's sponsor seed while the relay runs)> \
//   MIDNIGHT_MANAGED_PATH=<a key dir that also holds account/keys/deposit_unshielded.prover> \
//   FUND_ACCOUNT=<64 hex> [FUND_COLOUR=00…00] [FUND_AMOUNT=5000000] bun test/stack/p6/fund-unshielded.ts
//
// Runs in a Bun container on the stack's network (test/stack/p6/run-local.sh). The relay's key volume
// keeps only the prover keys the relay uses, so run-local.sh passes a cloned key dir with the
// account's `deposit_unshielded` prover key added from the full keyed build. Only public values are
// printed.

import { readFileSync } from 'node:fs';

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
  const t1 = Date.now();
  const r = await custody.depositUnshielded(unhex(colour), amount);
  console.log(
    `FUNDED ${JSON.stringify({
      account,
      kind: 'unshielded',
      colour,
      amount: amount.toString(),
      txId: r.txId,
      depositSeconds: (Date.now() - t1) / 1000,
      totalSeconds: (Date.now() - t0) / 1000,
    })}`,
  );
} finally {
  await opened.stop().catch(() => {});
}
process.exit(0);
