#!/usr/bin/env node
// Point a compactc 0.35.0 contract module at compact-runtime 0.20.0, and nothing else at it
// (AA 00047 B1.5; the same step as acedward/passport's contract/scripts/pin-contract-runtime.mjs on
// branch 00047-solana-ed25519-arm, which the vendor/passport submodule pins).
//
// THE PROBLEM. compactc 0.35.0 generates code for compact-runtime 0.20.0: the module starts with
// `checkRuntimeVersion('0.20.0')` and throws on any other runtime. The stagenet SDK set (compact-js
// 2.5.5-rc.8, midnight-js 5.0.0-beta.7) depends on compact-runtime 0.19.0, and no published SDK
// depends on 0.20.0 yet. One runtime for both breaks one side: 0.20's `createCircuitContext` takes
// one options object where compact-js passes positional arguments.
//
// THE FIX (spike 3 §6, measured on stagenet): the contract module resolves 0.20.0 and everything
// else keeps 0.19.0. The workspace installs 0.20.0 under the npm alias
// `@midnight-ntwrk/compact-runtime-0.20` (packages/core and relay package.json, integrity in
// bun.lock), and this script renames the generated module's runtime import, in index.js and
// index.d.ts, to that alias. Track A's client (src/wallet/ed25519.ts) imports the same alias. Both
// runtimes wrap ONE onchain-runtime-v4 4.0.0-rc.3, so ledger values keep their identity across the
// boundary. No resolver trick is involved, so Node, Bun, Vitest and Vite all see the same thing.
//
// It also re-stamps compactc's integrity manifest (compiler/contract-manifest.json) for the two
// rewritten files, so the manifest never describes bytes that no longer exist (midnight-js's
// NodeZkConfigProvider and the relay's proof provider check artefacts against it).
//
// Idempotent; refuses a module that was not generated for runtime 0.20.0.
//
// usage: node scripts/pin-contract-runtime.mjs <managed-contract-dir> [...]

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

const FROM = "'@midnight-ntwrk/compact-runtime'";
const TO = "'@midnight-ntwrk/compact-runtime-0.20'";
const VERSION_CHECK = "checkRuntimeVersion('0.20.0')";

const dirs = process.argv.slice(2);
if (dirs.length === 0) {
  console.error('usage: node scripts/pin-contract-runtime.mjs <managed-contract-dir> [...]');
  process.exit(64);
}

for (const dir of dirs) {
  const js = path.join(dir, 'contract', 'index.js');
  const dts = path.join(dir, 'contract', 'index.d.ts');
  if (!existsSync(js)) {
    console.error(`pin-contract-runtime: ${js} does not exist (compile first)`);
    process.exit(66);
  }
  if (!readFileSync(js, 'utf8').includes(VERSION_CHECK)) {
    console.error(`pin-contract-runtime: ${js} was not generated for compact-runtime 0.20.0 (no ${VERSION_CHECK})`);
    process.exit(65);
  }
  for (const file of [js, dts]) {
    if (!existsSync(file)) continue;
    const before = readFileSync(file, 'utf8');
    const after = before.split(`from ${FROM}`).join(`from ${TO}`);
    if (after.includes(`from ${FROM}`) || after.includes(`require(${FROM})`) || after.includes(`import(${FROM})`)) {
      console.error(`pin-contract-runtime: ${file}: an import of ${FROM} survived`);
      process.exit(70);
    }
    if (after !== before) writeFileSync(file, after);
    const n = after.split(`from ${TO}`).length - 1;
    console.error(`pin-contract-runtime: ${path.relative(process.cwd(), file)}: ${n} import(s) of ${TO}`);
  }
  const manifestPath = path.join(dir, 'compiler', 'contract-manifest.json');
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    let restamped = 0;
    for (const name of ['index.js', 'index.d.ts']) {
      const entry = manifest?.contract?.[name];
      const file = path.join(dir, 'contract', name);
      if (!entry || !existsSync(file)) continue;
      const bytes = readFileSync(file);
      const hash = createHash('sha256').update(bytes).digest('hex');
      if (entry.size !== bytes.length || entry.hash !== hash) restamped += 1;
      entry.size = bytes.length;
      entry.hash = hash;
    }
    if (restamped > 0) writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    console.error(
      `pin-contract-runtime: ${path.relative(process.cwd(), manifestPath)}: ${restamped} entr(ies) re-stamped`,
    );
  }
}
