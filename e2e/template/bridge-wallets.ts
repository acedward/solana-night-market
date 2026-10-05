// AA 00057 P2: fresh live keys and funding for the journey's two bridge deployments, X and Y. A port of
// the `keys` and `fund` phases of AA 00058's P5 driver (`evidence/00058-bridge-contract-delivery/p5/
// harness/tmpl/p5.ts`, sha256 916f88bc2b3db72fd93f6db8a0fe5cbb0764c3e49b7e106269a82214ec37adc9, the copy
// AA 00060's P9 harness staged), unchanged in what it does; the other phases (00058's own scenarios) are
// not carried. It runs in the 00058 TEMPLATE's environment: ../prep-template.sh stages it at
// packages/contracts-midnight/.journey/bridge-wallets.ts and the Solana shim at
// packages/contracts-solana/.journey-shim.ts (Bun's isolated linker resolves bare imports from the
// importing file's package), so it uses the template's own key and wallet helpers.
//
//   PHASE=keys  fresh live keys for X and Y with the template's helpers: the Solana operator, depositor
//               and program keypairs; the Midnight operator and delivery seeds (X also a user seed); a
//               wallet-storage password. Files 600 in /secrets-x and /secrets-y (dirs 700). Addresses
//               only are printed.
//   PHASE=fund  Solana airdrops from the validator's faucet (operators 10 SOL, depositors 2 SOL); NIGHT
//               from dev seed 3 ONLY (one transfer, four outputs), then each fresh Midnight wallet
//               registers its NIGHT for DUST and waits for spendable DUST.
//
// Mounts: /secrets-x, /secrets-y (each deployment's live secrets dir), /out (public evidence).
// Endpoints: env MIDNIGHT_* and SOLANA_DEVNET_RPC_URL, as the template's live mode reads them.

// Typed against the 00058 template's packages, not this repository's: e2e/template/ is excluded from
// this repository's tsconfig and eslint.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  buildWalletFacade,
  registerNightForDust,
  resolveFacadeDustAvailableCoins,
  resolveFacadeDustBalance,
  syncAndWaitForFunds,
} from '@effectstream/midnight-contracts';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import * as ledger from '@midnightntwrk/ledger-v9';
import * as Rx from 'rxjs';

import { liveKeyPaths, readKeypairFile, writeKeypairFile } from '../../contracts-solana/keys.ts';
import { web3 } from '../../contracts-solana/.journey-shim.ts';
import { midnightUrls } from '../network.ts';
import { isDevSeed, liveSeedPath, readSeedFile, shieldedAddressFromSeed } from '../wallets.ts';

const { Connection, Keypair, LAMPORTS_PER_SOL } = web3;
const env = process.env;
const PHASE = env.PHASE ?? '';
const OUT = env.OUT ?? '/out';
const NETWORK = 'undeployed';
const SOLANA_RPC = env.SOLANA_DEVNET_RPC_URL!;
const SEED3 = '0'.repeat(63) + '3'; // PUBLIC localnet dev seed 3: the bridges' funder (00058 plan D-7)
const D = { X: { secrets: '/secrets-x' }, Y: { secrets: '/secrets-y' } } as const;
type Dep = keyof typeof D;

const t0 = Date.now();
const log = (...a: unknown[]) =>
  console.log(`[bridge-wallets ${PHASE}] +${((Date.now() - t0) / 1000).toFixed(1)}s`, ...a);
const jsonable = (v: unknown) => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)));
const report: Record<string, any> = { phase: PHASE, startedAt: new Date().toISOString() };
const save = () =>
  fs.writeFileSync(path.join(OUT, `bridge-wallets-${PHASE}.json`), `${JSON.stringify(jsonable(report), null, 2)}\n`);

const night = (s: any): bigint => s.unshielded?.balances?.[(ledger as any).nativeToken().raw] ?? 0n;
const complete = (s: any) =>
  s.shielded.progress.isStrictlyComplete() &&
  s.unshielded.progress.isStrictlyComplete() &&
  s.dust.progress.isStrictlyComplete();
async function waitState(w: any, what: string, pred: (s: any) => boolean, timeoutMs = 900_000): Promise<any> {
  return Rx.firstValueFrom(
    w.wallet
      .state()
      .pipe(
        Rx.filter(pred),
        Rx.timeout({ first: timeoutMs, with: () => Rx.throwError(() => new Error(`timeout waiting for ${what}`)) }),
      ),
  );
}

async function phaseKeys() {
  const out: Record<string, any> = {};
  for (const d of ['X', 'Y'] as Dep[]) {
    process.env.BRIDGE_SECRETS_DIR = D[d].secrets;
    const k = liveKeyPaths();
    const o: Record<string, string> = {};
    for (const [role, file] of [
      ['operator', k.operator],
      ['depositor', k.user],
      ['program', k.program],
    ] as const) {
      if (fs.existsSync(file)) throw new Error(`${file} exists; fresh keys only`);
      const kp = Keypair.generate();
      writeKeypairFile(file, kp);
      o[`solana_${role}`] = kp.publicKey.toBase58();
    }
    const roles = d === 'X' ? (['operator', 'delivery', 'user'] as const) : (['operator', 'delivery'] as const);
    for (const role of roles) {
      const file = liveSeedPath(role);
      const seed = randomBytes(32).toString('hex');
      if (isDevSeed(seed)) throw new Error('impossible: a dev seed');
      fs.writeFileSync(file, `${seed}\n`, { mode: 0o600, flag: 'wx' });
      if (role === 'user') o.midnight_user_shielded = shieldedAddressFromSeed(seed, NETWORK);
    }
    fs.writeFileSync(path.join(D[d].secrets, 'storage-password'), `J57a1!${randomBytes(24).toString('base64url')}\n`, {
      mode: 0o600,
      flag: 'wx',
    });
    o.files = fs
      .readdirSync(D[d].secrets)
      .map((f) => `${f}:${(fs.statSync(path.join(D[d].secrets, f)).mode & 0o777).toString(8)}`)
      .join(' ');
    o.dirMode = (fs.statSync(D[d].secrets).mode & 0o777).toString(8);
    out[d] = o;
  }
  report.keys = out;
  const ok = Object.values(out).every(
    (o: any) => o.dirMode === '700' && !/:6[0-7][1-7]|:[0-7][1-7][0-7]/.test(o.files),
  );
  report.ok = ok;
  log(
    `keys ${ok ? 'OK' : 'NOT PRIVATE'}: ${JSON.stringify(Object.fromEntries(Object.entries(out).map(([d, o]: any) => [d, o.solana_operator])))}`,
  );
  if (!ok) throw new Error('the secrets are not private (dir 700, files 600)');
}

async function phaseFund() {
  const c = new Connection(SOLANA_RPC, 'confirmed');
  const airdrops: any[] = [];
  for (const d of ['X', 'Y'] as Dep[]) {
    for (const [role, file, sol] of [
      ['operator', 'solana-operator.json', 10],
      ['depositor', 'solana-user.json', 2],
    ] as const) {
      const pk = readKeypairFile(path.join(D[d].secrets, file)).publicKey;
      const sig = await c.requestAirdrop(pk, sol * LAMPORTS_PER_SOL);
      const bh = await c.getLatestBlockhash('confirmed');
      const res = await c.confirmTransaction({ signature: sig, ...bh }, 'confirmed');
      if (res.value.err) throw new Error(`airdrop ${d} ${role}: ${JSON.stringify(res.value.err)}`);
      airdrops.push({
        deployment: d,
        role,
        address: pk.toBase58(),
        sol,
        lamports: await c.getBalance(pk, 'confirmed'),
      });
    }
  }
  report.airdrops = airdrops;
  if (!airdrops.every((a) => a.lamports >= a.sol * LAMPORTS_PER_SOL)) throw new Error('an airdrop did not arrive');

  const u = midnightUrls('stagenet');
  const net = { id: u.id, indexer: u.indexer, indexerWS: u.indexerWS, node: u.node, proofServer: u.proofServer };
  const AMOUNT = BigInt(env.NIGHT_PER_WALLET ?? '10000000000000');
  const source = await buildWalletFacade(net as any, SEED3, u.id as never);
  await syncAndWaitForFunds(source.wallet, { timeoutMs: 900_000 });
  const src = await waitState(
    source,
    'dev seed 3 with NIGHT and DUST',
    (s) => complete(s) && night(s) >= 4n * AMOUNT && resolveFacadeDustAvailableCoins(s) >= 1,
  );
  log(`funder (dev seed 3) ${source.unshieldedAddress}: NIGHT ${night(src)}`);
  const targets: { d: Dep; role: 'operator' | 'delivery'; w: any }[] = [];
  for (const d of ['X', 'Y'] as Dep[]) {
    for (const role of ['operator', 'delivery'] as const) {
      const w = await buildWalletFacade(
        net as any,
        readSeedFile(path.join(D[d].secrets, `midnight-${role}.seed`)),
        u.id as never,
      );
      await syncAndWaitForFunds(w.wallet, { timeoutMs: 900_000 });
      const s = await waitState(w, `${d} ${role} synced`, complete);
      if (night(s) !== 0n) throw new Error(`${d} ${role} wallet is not fresh`);
      targets.push({ d, role, w });
    }
  }
  const outputs = await Promise.all(
    targets.map(async ({ w }) => ({
      type: (ledger as any).nativeToken().raw,
      receiverAddress: await w.wallet.unshielded.getAddress(),
      amount: AMOUNT,
    })),
  );
  const recipe = await source.wallet.transferTransaction(
    [{ type: 'unshielded', outputs }],
    { shieldedSecretKeys: source.zswapSecretKeys, dustSecretKey: source.dustSecretKey },
    { ttl: new Date(Date.now() + 30 * 60_000) },
  );
  const signed = await source.wallet.signRecipe(recipe, (p: Uint8Array) => source.unshieldedKeystore.signDataAsync(p));
  const fundingTx = String(await source.wallet.submitTransaction(await source.wallet.finalizeRecipe(signed)));
  log(`NIGHT ${AMOUNT} to each of 4 wallets: ${fundingTx}`);
  const midnight = await Promise.all(
    targets.map(async ({ d, role, w }) => {
      await waitState(w, `${d} ${role} NIGHT`, (s) => complete(s) && night(s) >= AMOUNT);
      const tReg = Date.now();
      if (!(await registerNightForDust(w))) throw new Error(`${d} ${role}: DUST registration failed`);
      // The registration re-creates the NIGHT UTXO: wait for NIGHT back as well as spendable DUST.
      const ready = await waitState(
        w,
        `${d} ${role} DUST`,
        (s) => complete(s) && resolveFacadeDustAvailableCoins(s) >= 1 && night(s) >= AMOUNT,
      );
      return {
        deployment: d,
        role,
        unshielded: w.unshieldedAddress,
        night: night(ready).toString(),
        dust: resolveFacadeDustBalance(ready, new Date()).toString(),
        registrationSeconds: (Date.now() - tReg) / 1000,
      };
    }),
  );
  for (const w of [source, ...targets.map((t) => t.w)]) await w.wallet.stop().catch(() => undefined);
  report.midnight = { funder: 'dev seed 3', fundingTx, nightPerWallet: AMOUNT, wallets: midnight };
  if (!midnight.every((m) => BigInt(m.night) >= AMOUNT && BigInt(m.dust) > 0n)) throw new Error('a wallet has no DUST');
}

setNetworkId(NETWORK as never);
const phases: Record<string, () => Promise<void>> = { keys: phaseKeys, fund: phaseFund };
const fn = phases[PHASE];
if (!fn) {
  console.error(`unknown PHASE "${PHASE}" (keys, fund)`);
  process.exit(64);
}
fn()
  .then(() => {
    report.finishedAt = new Date().toISOString();
    save();
    log('DONE');
    process.exit(0);
  })
  .catch((e) => {
    report.fatal = String((e as Error)?.message ?? e);
    report.finishedAt = new Date().toISOString();
    save();
    log('FATAL', report.fatal);
    process.exit(1);
  });
