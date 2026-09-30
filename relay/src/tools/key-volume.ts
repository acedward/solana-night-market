// The key volume's checks, run by the one-shot key job (deploy/key-volume/build.sh) inside the
// key-volume image. It never proves and never holds a secret: everything it reads and prints is
// public (hashes, addresses, circuit names).
//
//   bun relay/src/tools/key-volume.ts prune <root>            delete the prover keys not kept, re-stamp
//   bun relay/src/tools/key-volume.ts marker-inputs <root>    print the installed set's input stamp
//   bun relay/src/tools/key-volume.ts verify <root> [--inputs <stamp>] [--write-marker] [--recheck]
//
// `verify` runs the checks of relay/src/prover/key-volume.ts and prints a JSON report. It
// exits 0 when the set is VERIFIED and 1 otherwise. With --write-marker it writes the report as
// `<root>/.night-market-keys.json`; with --recheck it keeps the marker's build facts.
//
// Environment (the relay's own names, so one .env drives both):
//   RELAY_NETWORK                       stagenet (default) or undeployed
//   MIDNIGHT_INDEXER_URL                override the profile's indexer
//   RELAY_KEYS_FINGERPRINT              the pinned verifier-key fingerprint (64 hex)
//   KEYS_KEEP_PROVERS                   the kept prover keys (<bundle>/<circuit>, comma-separated)
//   KV_*                                build facts build.sh passes in (toolchain and sources)

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { resolveNetwork, type NetworkOverrides } from '@nightmarket/core';

import {
  KEYED_BUNDLES,
  checkExpectedVk,
  missingProvers,
  parseKeptProvers,
  proversToPrune,
  restampManifest,
  verifierDigests,
} from '../prover/key-volume.js';
import { scanKeyTree } from '../prover/keys.js';

const MARKER = '.night-market-keys.json';
const FORMAT = 'night-market-key-volume/1';

type Json = Record<string, unknown>;

const say = (msg: string) => process.stderr.write(`key-volume: ${msg}\n`);
const nowUtc = () => new Date().toISOString();
const env = (name: string) => {
  const v = process.env[name]?.trim();
  return v === undefined || v === '' ? undefined : v;
};

function readMarker(root: string): Json | null {
  const p = join(root, MARKER);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as Json;
  } catch {
    return null;
  }
}

function network() {
  const name = env('RELAY_NETWORK') ?? 'stagenet';
  const overrides: NetworkOverrides = {};
  const indexerUrl = env('MIDNIGHT_INDEXER_URL');
  if (indexerUrl) overrides.midnight = { indexerUrl };
  return resolveNetwork(name, overrides);
}

async function expectedVkOf(root: string, bundle: string): Promise<Record<string, string> | undefined> {
  const mod = (await import(pathToFileURL(join(root, bundle, 'contract', 'index.js')).href)) as {
    expectedVk?: Record<string, string>;
  };
  return mod.expectedVk;
}

async function verify(root: string, opts: { inputs?: string; writeMarker: boolean; recheck: boolean }) {
  const problems: string[] = [];
  const warnings: string[] = [];
  const previous = opts.recheck ? readMarker(root) : null;
  const kept = parseKeptProvers(env('KEYS_KEEP_PROVERS'));
  const net = network();

  // 1. Each bundle against its compiled expectedVk table.
  const ours: Record<string, Record<string, string>> = {};
  const expectedVk: Json = {};
  for (const bundle of KEYED_BUNDLES) {
    ours[bundle] = verifierDigests(join(root, bundle));
    const check = checkExpectedVk(bundle, ours[bundle]!, await expectedVkOf(root, bundle));
    expectedVk[bundle] = { circuits: check.circuits, ok: check.problems.length === 0 };
    problems.push(...check.problems);
  }

  // 2. (MN Bank also checked the bridge vault's and the Signet singleton's keys against the ones
  //    deployed on the network; Night Market proves none of their circuits. Checking a Night Market
  //    account's on-chain verifier keys against the pinned set is lane B3's, spec FR-005.)

  // 3. The prover keys the relay proves with.
  const missing = missingProvers(root, kept);
  problems.push(...missing.map((m) => `${m}: prover key or zkir missing`));

  // 4. The fingerprint (the relay's own algorithm) against the pin.
  const fingerprint = scanKeyTree(root).fingerprint;
  const pin = env('RELAY_KEYS_FINGERPRINT')?.toLowerCase() ?? null;
  if (pin === null) warnings.push('RELAY_KEYS_FINGERPRINT is not set: the relay will accept any key set');
  else if (pin !== fingerprint) problems.push(`fingerprint ${fingerprint} differs from RELAY_KEYS_FINGERPRINT ${pin}`);

  const verdict = problems.length === 0 ? 'VERIFIED' : 'MISMATCH';
  const report: Json = {
    format: FORMAT,
    verdict,
    network: net.name,
    fingerprint,
    fingerprintPinned: pin,
    inputs: opts.inputs ?? (previous?.inputs as string | undefined) ?? null,
    builtUtc: (previous?.builtUtc as string | undefined) ?? nowUtc(),
    verifiedUtc: nowUtc(),
    build: previous?.build ?? {
      source: env('KV_SOURCE') ?? null,
      compactc: env('KV_COMPACTC_VERSION') ?? null,
      compactcArchiveSha256: env('KV_COMPACTC_ARCHIVE_SHA256') ?? null,
      // The account's declared callees (compile-time inputs only; not installed) and the runtime the
      // account module is pinned to (AA 00047 B1.5).
      calleeCompactc: env('KV_CALLEE_COMPACTC_VERSION') ?? null,
      calleeCompactcArchiveSha256: env('KV_CALLEE_COMPACTC_ARCHIVE_SHA256') ?? null,
      contractRuntime: env('KV_CONTRACT_RUNTIME') ?? null,
      sigNetMidnight: env('KV_SIGNET_VERSION') ?? null,
      passportCommit: env('KV_PASSPORT_COMMIT') ?? null,
      accountSourceSha256: env('KV_ACCOUNT_SHA256') ?? null,
      compileSeconds: env('KV_COMPILE_SECONDS') ? Number(env('KV_COMPILE_SECONDS')) : null,
    },
    keptProvers: kept,
    checks: { expectedVk, provers: { kept: kept.length, missing }, fingerprint },
    problems,
    warnings,
  };
  if (opts.writeMarker && verdict === 'VERIFIED')
    writeFileSync(join(root, MARKER), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  for (const w of warnings) say(`warning: ${w}`);
  for (const p of problems) say(`PROBLEM: ${p}`);
  say(`verdict ${verdict} (fingerprint ${fingerprint})`);
  return verdict === 'VERIFIED';
}

async function main(): Promise<number> {
  const [cmd, root, ...rest] = process.argv.slice(2);
  if (!cmd || !root) {
    say('usage: key-volume.ts prune|marker-inputs|verify <root> [options]');
    return 64;
  }
  if (cmd === 'prune') {
    const kept = parseKeptProvers(env('KEYS_KEEP_PROVERS'));
    const doomed = proversToPrune(root, kept);
    for (const f of doomed) rmSync(f);
    let restamped = 0;
    for (const bundle of KEYED_BUNDLES) restamped += restampManifest(join(root, bundle));
    say(`pruned ${doomed.length} prover keys (kept ${kept.length}); ${restamped} manifest entries removed`);
    return 0;
  }
  if (cmd === 'marker-inputs') {
    const m = readMarker(root);
    if (m && m.verdict === 'VERIFIED' && typeof m.inputs === 'string') process.stdout.write(`${m.inputs}\n`);
    return 0;
  }
  if (cmd === 'verify') {
    const flag = (name: string) => rest.includes(name);
    const i = rest.indexOf('--inputs');
    const inputs = i >= 0 ? rest[i + 1] : undefined;
    const ok = await verify(root, {
      ...(inputs ? { inputs } : {}),
      writeMarker: flag('--write-marker'),
      recheck: flag('--recheck'),
    });
    return ok ? 0 : 1;
  }
  say(`unknown command ${cmd}`);
  return 64;
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    say(`error: ${(e as Error).message}`);
    process.exit(2);
  },
);
