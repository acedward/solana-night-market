// AA 00057 P5R.0: register a stagenet wallet's NIGHT for DUST generation (a self-transaction: no transfer
// to any other wallet) and measure how fast its DUST accrues. Runs in the 00058 bridge template's
// environment (staged at packages/contracts-midnight/.journey/dust-register.ts by ../run-local.sh prep),
// with the template's own wallet helpers (@effectstream/midnight-contracts buildWalletFacade and
// registerNightForDust: the fee is paid from DUST the NIGHT being registered generates first).
//
//   SEED_FILE=/run/secrets/seed LABEL=temporary-12 OUT=/out SAMPLE_MINUTES=5 \
//   MIDNIGHT_PROOF_SERVER_URL=http://proof-server:6300 bun dust-register.ts
//
// The seed (32- or 64-byte hex, read in-process) is never printed. The output is public: the label, the
// unshielded address (it must equal the one Night Market's wallet code derives for the same seed), NIGHT,
// DUST before and after, the UTXOs registered, and the accrual (DUST per minute, measured over
// SAMPLE_MINUTES and as the wallet's own projection one minute ahead).
import fs from 'node:fs';
import path from 'node:path';

import { buildWalletFacade, registerNightForDust } from '@effectstream/midnight-contracts';
import * as ledger from '@midnightntwrk/ledger-v9';
import * as Rx from 'rxjs';

import { midnightUrls } from '../network.ts';

const env = process.env;
const LABEL = env.LABEL ?? 'wallet';
const OUT = env.OUT ?? '/out';
const SAMPLE_MINUTES = Number(env.SAMPLE_MINUTES ?? '5');
const SPECKS = 10n ** 15n;
const t0 = Date.now();
const log = (m: string) => console.log(`[dust-register ${LABEL}] +${((Date.now() - t0) / 1000).toFixed(1)}s ${m}`);
const dustOf = (v: bigint) => Number((v * 1000n) / SPECKS) / 1000;

function readSeed(file: string): string {
  const s = fs.readFileSync(file, 'utf8').trim().toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{64}$|^[0-9a-f]{128}$/.test(s)) throw new Error('the seed file holds no 32- or 64-byte hex seed');
  return s;
}
const night = (s: any): bigint => s.unshielded?.balances?.[(ledger as any).nativeToken().raw] ?? 0n;
const complete = (s: any) =>
  s.shielded?.progress?.isStrictlyComplete?.() === true &&
  s.unshielded?.progress?.isStrictlyComplete?.() === true &&
  s.dust?.progress?.isStrictlyComplete?.() === true;
const synced = (w: any, timeoutMs = 1_500_000): Promise<any> =>
  Rx.firstValueFrom(
    w.wallet
      .state()
      .pipe(
        Rx.filter(complete),
        Rx.timeout({ first: timeoutMs, with: () => Rx.throwError(() => new Error('not synced')) }),
      ),
  );

async function main() {
  const u = midnightUrls('stagenet');
  const net = { id: u.id, indexer: u.indexer, indexerWS: u.indexerWS, node: u.node, proofServer: u.proofServer };
  const w: any = await buildWalletFacade(net as any, readSeed(env.SEED_FILE ?? '/run/secrets/seed'), u.id as never);
  const before = await synced(w);
  const unregistered = (before.unshielded?.availableCoins ?? []).filter(
    (c: any) => c.meta?.registeredForDustGeneration === false,
  ).length;
  const res: Record<string, unknown> = {
    label: LABEL,
    unshieldedAddress: w.unshieldedAddress,
    night: night(before).toString(),
    dustBefore: dustOf(before.dust.balance(new Date())),
    unregisteredUtxos: unregistered,
    syncSeconds: (Date.now() - t0) / 1000,
  };
  log(`synced: NIGHT ${night(before)}, ${unregistered} unregistered UTXO(s)`);
  const tReg = Date.now();
  const ok = await registerNightForDust(w);
  res.registered = ok;
  res.registrationSeconds = (Date.now() - tReg) / 1000;
  if (!ok) throw new Error('the DUST registration failed');
  const s1 = await synced(w);
  const d1 = s1.dust.balance(new Date());
  const projected = s1.dust.balance(new Date(Date.now() + 60_000)) - d1;
  res.dustAfterRegistration = dustOf(d1);
  res.projectedDustPerMinute = dustOf(projected);
  const ta = Date.now();
  await new Promise((r) => setTimeout(r, SAMPLE_MINUTES * 60_000));
  const s2 = await synced(w);
  const d2 = s2.dust.balance(new Date());
  res.measuredDustPerMinute = Math.round((dustOf(d2 - d1) / ((Date.now() - ta) / 60_000)) * 1000) / 1000;
  res.dustAtEnd = dustOf(d2);
  res.at = new Date().toISOString();
  fs.appendFileSync(path.join(OUT, 'dust-register.jsonl'), `${JSON.stringify(res)}\n`);
  log(JSON.stringify(res));
  await w.wallet.stop().catch(() => undefined);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(`FAILED dust-register ${LABEL}: ${String((e as Error)?.message ?? e).slice(0, 500)}`);
    process.exit(1);
  },
);
