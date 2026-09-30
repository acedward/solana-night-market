// How much memory the relay needs to prove (plan 00039 P5.1b, question Q25).
//
// SYNTHETIC mode (--synthetic) needs no keys and no proof server: it generates a prover key of
// --key-mb MB with its compiler manifest and sends /prove bodies for it to an in-process server that
// reads each body to the end. It measures what the relay itself holds while it sends a body, and is
// cheap enough for CI (.github/workflows/ci.yml, job "Relay prover memory").
//
// MN Bank also had a REAL mode: one k=18 account call built offline and proved against a real proof
// server. It drove the EVM arm (`append_inbox_with_evm`), which Night Market removed (AA 00047); it
// comes back on the Ed25519 arm with lane B3. It is in `main`'s history.
//
//   bun relay/src/tools/prover-memory.ts --synthetic [--key-mb MB] [--proofs N] [--budget-mb MB]
//                                        [--gc-each] [--stock] [--out FILE]
//
//   --stock            prove through midnight-js's stock HTTP proving provider instead (the relay's
//                      path before P5.1b), to compare the two in one build
//   --gc-each          run Bun.gc(true) after each proof and report the memory after it too
//
// Run it in a container with a memory limit and no swap (test/memory/run-prover-memory.sh does):
// it reads the container's cgroup (memory.stat `anon`, memory.current, memory.peak, memory.events)
// through a sampler PROCESS, so a peak inside a synchronous WASM call is still seen. It prints one
// JSON report and exits 1 when the peak anonymous memory exceeds --budget-mb, and 2 on an error.
// Past the container's limit the kernel kills it (exit 137).

import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomFillSync } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CGROUP = '/sys/fs/cgroup';
const MB = 1024 * 1024;

type Json = Record<string, unknown>;

const say = (msg: string) => process.stderr.write(`prover-memory: ${msg}\n`);

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function readCgroup(file: string): string | null {
  try {
    return readFileSync(join(CGROUP, file), 'utf8');
  } catch {
    return null;
  }
}

function statField(stat: string | null, field: string): number | null {
  const m = stat?.match(new RegExp(`^${field} (\\d+)$`, 'm'));
  return m ? Number(m[1]) : null;
}

/** One reading of this process and its container. */
function snapshot(label: string): Json {
  const stat = readCgroup('memory.stat');
  const events = readCgroup('memory.events');
  const mu = process.memoryUsage();
  const num = (s: string | null) => (s === null ? null : Number(s.trim()));
  return {
    label,
    at: new Date().toISOString(),
    anonMb: mb(statField(stat, 'anon')),
    fileMb: mb(statField(stat, 'file')),
    currentMb: mb(num(readCgroup('memory.current'))),
    peakMb: mb(num(readCgroup('memory.peak'))),
    swapMb: mb(num(readCgroup('memory.swap.current'))),
    eventsMax: statField(events, 'max'),
    oomKill: statField(events, 'oom_kill'),
    rssMb: mb(mu.rss),
    heapUsedMb: mb(mu.heapUsed),
    externalMb: mb(mu.external),
    arrayBuffersMb: mb(mu.arrayBuffers),
  };
}

const mb = (bytes: number | null | undefined) =>
  bytes === null || bytes === undefined ? null : Math.round(bytes / MB);

/** A separate process that reads the cgroup every 100 ms: it keeps sampling while the relay's
 *  thread is inside a synchronous WASM call or a large copy. */
function startSampler(file: string): { stop: () => Promise<void> } {
  const script = `while :; do a=$(grep '^anon ' ${CGROUP}/memory.stat | cut -d' ' -f2); c=$(cat ${CGROUP}/memory.current); echo "$(date +%s%3N) $a $c"; sleep 0.1; done > ${file}`;
  const child = spawn('sh', ['-c', script], { stdio: 'ignore' });
  return {
    stop: () =>
      new Promise((done) => {
        child.once('exit', () => done());
        child.kill('SIGTERM');
      }),
  };
}

interface Sample {
  t: number;
  anon: number;
  current: number;
}

function readSamples(file: string): Sample[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.trim().split(' ').map(Number))
    .filter((p) => p.length === 3 && p.every((n) => Number.isFinite(n)))
    .map(([t, anon, current]) => ({ t: t!, anon: anon!, current: current! }));
}

function peakBetween(samples: Sample[], from: number, to: number): { anonMb: number | null; currentMb: number | null } {
  const inside = samples.filter((s) => s.t >= from && s.t <= to);
  if (inside.length === 0) return { anonMb: null, currentMb: null };
  return {
    anonMb: mb(Math.max(...inside.map((s) => s.anon))),
    currentMb: mb(Math.max(...inside.map((s) => s.current))),
  };
}

const gc = () => (globalThis as { Bun?: { gc(force: boolean): void } }).Bun?.gc(true);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** What one run proves. */
interface Scenario {
  /** For the report. */
  describe: Json;
  /** One proof; returns facts for the report. */
  prove(): Promise<Json>;
  close?: () => Promise<void>;
}

async function main(): Promise<number> {
  const proofs = Number(arg('--proofs') ?? '4');
  const budgetMb = arg('--budget-mb') ? Number(arg('--budget-mb')) : null;
  const gcEach = process.argv.includes('--gc-each');
  const stock = process.argv.includes('--stock');
  const synthetic = process.argv.includes('--synthetic');
  const keyMb = Number(arg('--key-mb') ?? '544');
  const out = arg('--out');
  if (!Number.isInteger(proofs) || proofs < 1) throw new Error('--proofs must be a positive integer');
  if (!Number.isInteger(keyMb) || keyMb < 1) throw new Error('--key-mb must be a positive integer');
  if (!synthetic) {
    throw new Error(
      'only --synthetic runs in this build: the real mode proved an EVM-arm call, and comes back on the Ed25519 arm (AA 00047 lane B3)',
    );
  }

  const work = mkdtempSync(join(tmpdir(), 'prover-memory-'));
  const samplesFile = join(work, 'samples.txt');
  const sampler = startSampler(samplesFile);
  const snapshots: Json[] = [snapshot('start')];
  const proofRuns: Json[] = [];
  let describe: Json;
  try {
    const scenario = await syntheticScenario(work, { stock, keyMb });
    describe = scenario.describe;
    gc();
    await sleep(500);
    snapshots.push(snapshot('ready'));
    for (let i = 1; i <= proofs; i++) {
      const t0 = Date.now();
      const facts = await scenario.prove();
      const t1 = Date.now();
      const after = snapshot(`after proof ${i}`);
      let afterGc: Json | null = null;
      if (gcEach) {
        gc();
        await sleep(200);
        afterGc = snapshot(`after proof ${i} + Bun.gc(true)`);
      }
      proofRuns.push({ proof: i, ms: t1 - t0, ...facts, t0, t1, after, afterGc });
      say(`proof ${i}/${proofs}: ${t1 - t0} ms, anon after ${String(after.anonMb)} MB`);
    }
    await sleep(5_000);
    snapshots.push(snapshot('5 s after the last proof'));
    gc();
    await sleep(1_000);
    snapshots.push(snapshot('after a final Bun.gc(true)'));
    await scenario.close?.();
  } finally {
    await sampler.stop();
  }

  const samples = readSamples(samplesFile);
  rmSync(work, { recursive: true, force: true });
  for (const run of proofRuns) {
    const { t0, t1 } = run as { t0: number; t1: number };
    run.peakDuring = peakBetween(samples, t0, t1);
    delete run.t0;
    delete run.t1;
  }
  const all = peakBetween(samples, 0, Number.MAX_SAFE_INTEGER);
  const report: Json = {
    tool: 'relay/src/tools/prover-memory.ts',
    ...describe,
    bun: (globalThis as { Bun?: { version: string } }).Bun?.version ?? null,
    containerLimitMb: mb(Number((readCgroup('memory.max') ?? '').trim()) || null),
    swapLimit: (readCgroup('memory.swap.max') ?? '').trim() || null,
    proofs,
    gcEach,
    samples: samples.length,
    peakAnonMb: all.anonMb,
    peakCurrentMb: all.currentMb,
    snapshots,
    proofRuns,
    budgetMb,
  };
  const pass = budgetMb === null || (all.anonMb !== null && all.anonMb <= budgetMb);
  report.result = budgetMb === null ? 'MEASURED' : pass ? 'PASS' : 'FAIL';
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (out) writeFileSync(out, text);
  process.stdout.write(text);
  return pass ? 0 : 1;
}

/**
 * No keys and no proof server: a generated prover key of --key-mb MB in a bundle with its compiler
 * manifest, a preimage for it, and an in-process server that reads each /prove body to the end and
 * answers 16 bytes. It measures what the relay itself holds while it sends a body (the CI check).
 */
async function syntheticScenario(work: string, o: { stock: boolean; keyMb: number }): Promise<Scenario> {
  const ledger = await import('@midnightntwrk/ledger-v9');
  const { encodeContractKeyLocation, hashVerifierKey } = await import('@midnight-ntwrk/midnight-js-types');
  const circuit = 'synthetic_k18';
  const volume = join(work, 'volume');
  const dir = join(volume, 'Synthetic');
  for (const d of ['keys', 'zkir', 'compiler']) mkdirSync(join(dir, d), { recursive: true });
  const keyBytes = o.keyMb * MB;
  const keyHash = createHash('sha256');
  const fd = openSync(join(dir, 'keys', `${circuit}.prover`), 'w');
  const chunk = new Uint8Array(16 * MB);
  for (let done = 0; done < keyBytes;) {
    const piece = chunk.subarray(0, Math.min(chunk.length, keyBytes - done));
    randomFillSync(piece);
    writeSync(fd, piece);
    keyHash.update(piece);
    done += piece.length;
  }
  closeSync(fd);
  const vk = new Uint8Array(randomBytes(3_000));
  const ir = new Uint8Array(randomBytes(40_000));
  writeFileSync(join(dir, 'keys', `${circuit}.verifier`), vk);
  writeFileSync(join(dir, 'zkir', `${circuit}.bzkir`), ir);
  const entry = (size: number, hash: string) => ({ type: 'file', size, hash });
  const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
  writeFileSync(
    join(dir, 'compiler', 'contract-manifest.json'),
    JSON.stringify({
      'manifest-version': '1',
      keys: {
        type: 'directory',
        [`${circuit}.prover`]: entry(keyBytes, keyHash.digest('hex')),
        [`${circuit}.verifier`]: entry(vk.length, sha(vk)),
      },
      zkir: { type: 'directory', [`${circuit}.bzkir`]: entry(ir.length, sha(ir)) },
    }),
  );

  const received: { bytes: number; contentLength: string | null }[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    maxRequestBodySize: 2 ** 32 - 1,
    async fetch(req) {
      let bytes = 0;
      const reader = req.body?.getReader();
      for (let r = await reader?.read(); r && !r.done; r = await reader!.read()) bytes += r.value.length;
      received.push({ bytes, contentLength: req.headers.get('content-length') });
      return new Response(new Uint8Array(16));
    },
  });
  const url = `http://127.0.0.1:${server.port}`;
  const keyLocation = encodeContractKeyLocation({
    contractAddress: 'ab'.repeat(32),
    circuitId: circuit,
    verifierKeyHash: hashVerifierKey(vk),
  });
  const aligned = { value: [], alignment: [] };
  const preimage = ledger.proofDataIntoSerializedPreimage(aligned as never, aligned as never, [], [], keyLocation);
  let prover: { prove(p: Uint8Array, k: string, b?: bigint): Promise<Uint8Array> };
  if (o.stock) {
    const { nodeZkConfigRegistry } = await import('@midnight-ntwrk/midnight-js-node-zk-config-provider');
    const { httpClientProvingProvider } = await import('@midnight-ntwrk/midnight-js-http-client-proof-provider');
    prover = httpClientProvingProvider(url, await nodeZkConfigRegistry(volume), { timeout: 900_000 }) as never;
  } else {
    const { relayProofProvider } = await import('../prover/proving-provider.js');
    prover = (await relayProofProvider(url, volume, { timeout: 900_000 })).provingProvider();
  }
  return {
    describe: {
      mode: 'synthetic',
      circuit: `Synthetic/${circuit}`,
      proverKeyMb: o.keyMb,
      provider: o.stock ? 'midnight-js httpClientProvingProvider (stock)' : 'relay (relayProofProvider)',
      proofServer: 'in-process: reads each /prove body to the end, answers 16 bytes',
    },
    prove: async () => {
      const before = received.length;
      await prover.prove(preimage, keyLocation, 12_345n);
      const got = received[before];
      if (!got || got.bytes <= keyBytes) throw new Error('the server did not receive a whole /prove body');
      if (got.contentLength !== null && Number(got.contentLength) !== got.bytes) {
        throw new Error(`Content-Length ${got.contentLength} but ${got.bytes} bytes received`);
      }
      return { bodyBytes: got.bytes, contentLength: got.contentLength };
    },
    close: async () => {
      await server.stop(true);
    },
  };
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    say(`error: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    process.exit(2);
  },
);
