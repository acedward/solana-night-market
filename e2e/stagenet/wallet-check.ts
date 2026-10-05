// AA 00057 P5R.0: a stagenet wallet's NIGHT and DUST, read with Night Market's own wallet code (the relay's
// facade and key derivation, relay/src/sponsor/facade.ts), so the number is what the relay's sponsor will
// see. Read only: nothing is signed or sent.
//
//   SEED_FILE=/run/secrets/seed LABEL=temporary-11 NETWORK=stagenet OUT=/out bun e2e/stagenet/wallet-check.ts
//
// The seed is read in-process from SEED_FILE and never printed; the output is public: the label, the
// unshielded address, NIGHT, DUST (specks and whole), the DUST outputs it can spend now, and whether any
// NIGHT is registered for DUST generation (a DUST output exists, or DUST is accruing).

/* eslint-disable @typescript-eslint/no-explicit-any */
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PROFILES, type NetworkName } from '@nightmarket/core';

import { parseSponsorSeed } from '../../relay/src/config.js';
import { openFacadeWallet } from '../../relay/src/sponsor/facade.js';

const NETWORK = (process.env.NETWORK ?? 'stagenet') as NetworkName;
const P = PROFILES[NETWORK];
const LABEL = process.env.LABEL ?? 'wallet';
const OUT = process.env.OUT ?? '/out';
const TIMEOUT_MS = Number(process.env.SYNC_TIMEOUT_S ?? '1500') * 1000;
const SPECKS_PER_DUST = 10n ** 15n;

async function main() {
  const seed = parseSponsorSeed(readFileSync(process.env.SEED_FILE ?? '/run/secrets/seed', 'utf8'));
  const t0 = Date.now();
  const w = await openFacadeWallet(
    seed,
    {
      networkId: P.midnightNetworkId,
      indexerUrl: P.midnight.indexerUrl,
      indexerWsUrl: P.midnight.indexerWsUrl,
      nodeWsUrl: P.midnight.nodeWsUrl,
      // Never used: nothing is proven here.
      dustProofServerUrl: process.env.DUST_PROVER ?? 'http://127.0.0.1:1',
    },
    { feeBlocksMargin: 5 },
  );
  const facade: any = (w.handle as any).wallet;
  const state: any = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`not synced after ${TIMEOUT_MS / 1000} s`)), TIMEOUT_MS);
    const sub = facade.state().subscribe({
      next: (s: any) => {
        // Every sub-wallet strictly complete (00058 P5's rule), not only the facade's isSynced.
        const complete =
          s.shielded?.progress?.isStrictlyComplete?.() === true &&
          s.unshielded?.progress?.isStrictlyComplete?.() === true &&
          s.dust?.progress?.isStrictlyComplete?.() === true;
        if (s.isSynced === true && complete) {
          clearTimeout(timer);
          sub.unsubscribe();
          resolve(s);
        }
      },
      error: reject,
    });
  });
  const ledger: any = await import('@midnightntwrk/ledger-v9');
  const nativeRaw = ledger.nativeToken().raw;
  const night: bigint = state.unshielded?.balances?.[nativeRaw] ?? 0n;
  const dust: bigint = state.dust.balance(new Date());
  const outputs = Array.isArray(state.dust.availableCoins) ? state.dust.availableCoins.length : null;
  const af: any = await import('@midnightntwrk/wallet-sdk-address-format');
  const ua = await facade.unshielded.getAddress();
  let address: string;
  try {
    address = af.MidnightBech32m.encode(P.midnightNetworkId, ua).asString();
  } catch {
    address = String(ua?.toString?.() ?? ua);
  }
  const res = {
    label: LABEL,
    network: NETWORK,
    unshieldedAddress: address,
    night: night.toString(),
    nightWhole: (Number(night) / 1e6).toString(),
    dustSpecks: dust.toString(),
    dust: (Number((dust * 1000n) / SPECKS_PER_DUST) / 1000).toString(),
    dustOutputs: outputs,
    registeredForDust: (outputs ?? 0) > 0 || dust > 0n,
    syncSeconds: (Date.now() - t0) / 1000,
    at: new Date().toISOString(),
  };
  appendFileSync(join(OUT, 'wallets.jsonl'), `${JSON.stringify(res)}\n`);
  process.stdout.write(`${JSON.stringify(res)}\n`);
  await w.stop().catch(() => undefined);
}

main().then(
  () => process.exit(0),
  (e: unknown) => {
    process.stderr.write(`FAILED wallet-check ${LABEL}: ${String((e as Error)?.message ?? e).slice(0, 500)}\n`);
    process.exit(1);
  },
);
/* eslint-enable @typescript-eslint/no-explicit-any */
