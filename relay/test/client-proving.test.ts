// AA 00062 P3 (L-RELAY): the relay's client-proving mode, `CLIENT_PROVING=off|required` (plan I-62a).
//
//   - the mode is validated at start and `off` is the default; `required` needs the REAL client-proof
//     verifier (questions Q3 → A, P3.5: the pinned WASM, ./client-proof-verifier.test.ts) and the key
//     volume, and never a permissive one;
//   - in `required` the four k≥18 circuits are never sent to the relay's prover: the ledger's own
//     key-less body is handed to the page instead (checked byte for byte against the P1.2 golden
//     vectors), while `check`, the other circuits and the builtins go to the proof server as before;
//   - one proof per hand-off, at most one hand-off open per job; missing, late and invalid proofs end
//     the job with their codes and nothing is submitted (the invalid case through a TEST-DOUBLE verifier
//     injected into the desk, never through configuration);
//   - a proof the network refuses as invalid does not start Passport's DUST-race retry (no more proofs
//     are asked for), ends `client-proof-invalid` and reverts the pending spend;
//   - `/v1/config` and `/health` advertise `required`; `off` publishes nothing new;
//   - the relay never fetches a user-supplied URL.

import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as ledger from '@midnightntwrk/ledger-v9';
import { encodeContractKeyLocation, hashVerifierKey } from '@midnight-ntwrk/midnight-js-types';
import {
  API_PATHS,
  CLIENT_PROOF_STAGES,
  CLIENT_PROVEN_CIRCUITS,
  ClientProofRequestSchema,
  HealthResponseSchema,
  JobViewSchema,
  PROOF_REQUEST_TAG,
  PROOF_TAG,
  PublicConfigSchema,
  type JobView,
} from '@nightmarket/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { countsAgainstBudget, FailureBudget } from '../src/actions/failure-budget.js';
import { guarded } from '../src/app.js';
import { ClientProofDesk, isProofRefusal } from '../src/client-proving/desk.js';
import {
  builtInClientProofVerifier,
  CLIENT_PROOF_VERIFIER_WASM_SHA256,
  clientProvingStartProblem,
  NO_CLIENT_PROOF_VERIFIER,
  type ClientProofVerdict,
  type ClientProofVerifier,
  type ClientProofVerifierInput,
} from '../src/client-proving/verifier.js';
import { ConfigError } from '../src/config.js';
import { healthCollector } from '../src/health.js';
import { walletProviderFor, type SponsorWalletHandle } from '../src/passport/wallet-provider.js';
import { relayProofProvider, type ClientProofHandOff } from '../src/prover/proving-provider.js';
import { JobQueue, PublicError, type JobExecutor } from '../src/queue/jobs.js';
import { FakeSponsor, harness, silentLog, testConfig } from './harness.js';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const FIXTURES = here('./fixtures/client-proof/');
const SRC = here('../src/');
const fixture = (name: string) => new Uint8Array(readFileSync(join(FIXTURES, name)));
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const ACCOUNT = '11'.repeat(32);
const KEY_SET = 'ab'.repeat(32);

// ── the golden vectors (AA 00062 P1.2) ─────────────────────────────────────────

interface Vector {
  circuit: string;
  request: Uint8Array;
  keyMaterialOffset: number;
  /** The serialized preimage and binding input the ledger's prover received. */
  preimage: Uint8Array;
  binding: bigint | undefined;
  keyLocation: string;
}

/** Rebuild the preimage, the binding input and the key location from a captured key-less body. */
function vector(name: string, circuit: string, keyMaterialOffset: number): Vector {
  const request = fixture(`${name}.request.bin`);
  const tag = Buffer.from(PROOF_REQUEST_TAG, 'ascii');
  expect(Buffer.from(request.subarray(0, tag.length)).equals(tag)).toBe(true);
  expect(request[keyMaterialOffset]).toBe(0);
  const preimage = new Uint8Array(
    Buffer.concat([Buffer.from('midnight:proof-preimage-versioned:'), request.subarray(tag.length, keyMaterialOffset)]),
  );
  const tail = request.subarray(keyMaterialOffset + 1);
  let binding: bigint | undefined;
  if (tail[0] === 1) {
    // Some(Fr): a SCALE compact big integer, ((first >> 2) + 4) little-endian bytes.
    expect(tail[1]! & 3).toBe(3);
    const n = (tail[1]! >> 2) + 4;
    binding = 0n;
    for (let i = n; i >= 1; i--) binding = (binding << 8n) | BigInt(tail[1 + i]!);
  }
  const m = /contract:([0-9a-f]{64})\/([a-z0-9_]+)\?vk=([0-9a-f]{64})/.exec(Buffer.from(request).toString('latin1'));
  expect(m?.[2]).toBe(circuit);
  const keyLocation = encodeContractKeyLocation({
    contractAddress: m![1]!,
    circuitId: circuit,
    verifierKeyHash: m![3]!,
  });
  // The rebuilt preimage gives back the captured body: the vectors are what the ledger hands `prove`.
  expect(sha256(ledger.createProvingPayload(preimage, binding))).toBe(sha256(request));
  return { circuit, request, keyMaterialOffset, preimage, binding, keyLocation };
}

const MAKER = () => vector('open_swap_shielded_with_ed25519.maker', 'open_swap_shielded_with_ed25519', 2585);
const WITHDRAW = () => vector('withdraw_shielded_with_ed25519', 'withdraw_shielded_with_ed25519', 1556);
const GOLDEN_PROOF = () => fixture('open_swap_shielded_with_ed25519.maker.proof.bin');

// ── a key volume: the two real public verifier keys, plus a server-proven circuit ──

const SERVER_CIRCUIT = 'rotate_enc_key_with_ed25519';

/** `<root>/account/{keys,zkir,compiler}` with every file in the compiler manifest. Each circuit has a
 *  small stand-in prover key (a client-proven one's must never be read); the two golden circuits have
 *  their real ZKIR, the server-proven one a stand-in. */
function makeVolume(root: string): { serverLocation: string } {
  const dir = join(root, 'account');
  for (const d of ['keys', 'zkir', 'compiler']) mkdirSync(join(dir, d), { recursive: true });
  const keys: Record<string, unknown> = { type: 'directory' };
  const zkir: Record<string, unknown> = { type: 'directory' };
  const file = (b: Uint8Array) => ({ type: 'file', size: b.length, hash: sha256(b) });
  const add = (circuit: string, vk: Uint8Array, ir: Uint8Array = randomBytes(512)) => {
    const pk = randomBytes(4096);
    writeFileSync(join(dir, 'keys', `${circuit}.verifier`), vk);
    writeFileSync(join(dir, 'keys', `${circuit}.prover`), pk);
    writeFileSync(join(dir, 'zkir', `${circuit}.bzkir`), ir);
    keys[`${circuit}.verifier`] = file(vk);
    keys[`${circuit}.prover`] = file(pk);
    zkir[`${circuit}.bzkir`] = file(ir);
  };
  // The real public verifier keys and ZKIR of the two golden circuits (the real verifier reads the ZKIR).
  for (const c of ['open_swap_shielded_with_ed25519', 'withdraw_shielded_with_ed25519']) {
    add(c, fixture(`${c}.verifier`), fixture(`${c}.bzkir`));
  }
  const serverVk = randomBytes(2000);
  add(SERVER_CIRCUIT, serverVk);
  writeFileSync(
    join(dir, 'compiler', 'contract-manifest.json'),
    JSON.stringify({ 'manifest-version': '1', 'compiler-version': '0.35.0', keys, zkir }),
  );
  return {
    serverLocation: encodeContractKeyLocation({
      contractAddress: 'cd'.repeat(32),
      circuitId: SERVER_CIRCUIT,
      verifierKeyHash: hashVerifierKey(serverVk),
    }),
  };
}

/** The proof server: records every request and answers 200 (a /check answer for /check). */
function fakeProofServer() {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    await new Response(init?.body as BodyInit).arrayBuffer();
    calls.push(String(input));
    if (String(input).endsWith('/check')) {
      return new Response(Uint8Array.of(...Buffer.from('midnight:vec(option(u64)):'), 0x04, 0x01, 0x14));
    }
    return new Response(Uint8Array.of(9, 9, 9));
  });
  return { calls, fetch: fetchImpl as unknown as typeof fetch };
}

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
  vi.restoreAllMocks();
});
const tempRoot = () => {
  const d = mkdtempSync(join(tmpdir(), 'nm-client-proof-'));
  dirs.push(d);
  return d;
};

// ── P3.1: the mode ─────────────────────────────────────────────────────────────

describe('CLIENT_PROVING (P3.1)', () => {
  it('defaults to off, with a 300 s hand-off timeout', () => {
    expect(testConfig().clientProving).toEqual({ mode: 'off', timeoutSeconds: 300 });
    expect(testConfig({ CLIENT_PROVING: 'off' }).clientProving.mode).toBe('off');
    expect(testConfig({ CLIENT_PROVING: 'required' }).clientProving).toEqual({ mode: 'required', timeoutSeconds: 300 });
  });

  it('refuses any other mode, and a timeout outside 60–840 s', () => {
    for (const bad of ['on', 'REQUIRED', 'optional', 'true']) {
      expect(() => testConfig({ CLIENT_PROVING: bad })).toThrow(ConfigError);
    }
    expect(() => testConfig({ CLIENT_PROVING: 'on' })).toThrow(/CLIENT_PROVING must be one of off, required/);
    for (const bad of ['59', '841', '0', '300.5', 'x']) {
      expect(() => testConfig({ CLIENT_PROOF_TIMEOUT_SECONDS: bad })).toThrow(/CLIENT_PROOF_TIMEOUT_SECONDS/);
    }
    expect(testConfig({ CLIENT_PROOF_TIMEOUT_SECONDS: '60' }).clientProving.timeoutSeconds).toBe(60);
    expect(testConfig({ CLIENT_PROOF_TIMEOUT_SECONDS: '840' }).clientProving.timeoutSeconds).toBe(840);
  });

  it('`required` may start only with a verifier and the key volume; `off` needs neither', () => {
    const volume = { loaded: true, fingerprint: KEY_SET };
    expect(clientProvingStartProblem('off', null, volume)).toBeNull();
    expect(clientProvingStartProblem('off', null, { loaded: false, fingerprint: null })).toBeNull();
    expect(clientProvingStartProblem('required', null, volume)).toBe(NO_CLIENT_PROOF_VERIFIER);
    expect(NO_CLIENT_PROOF_VERIFIER).toMatch(/needs the built-in client-proof verifier/);
    // With a verifier (here a double), `required` still needs the key volume.
    const verifier: ClientProofVerifier = { name: 'double', verify: async () => ({ ok: false, reason: 'x' }) };
    expect(clientProvingStartProblem('required', verifier, { loaded: false, fingerprint: null })).toMatch(
      /needs the key volume/,
    );
    expect(clientProvingStartProblem('required', verifier, volume)).toBeNull();
  });

  it('nothing in the configuration can enable a verifier: only the pinned built-in one, or a test double', () => {
    expect(Object.keys(testConfig({ CLIENT_PROVING: 'required' }).clientProving).sort()).toEqual([
      'mode',
      'timeoutSeconds',
    ]);
    expect(readFileSync(join(SRC, 'config.ts'), 'utf8')).not.toMatch(/VERIFIER/);
    // main.ts builds the verifier from the key volume's path only; the module's path is never configured.
    const main = readFileSync(join(SRC, 'main.ts'), 'utf8');
    expect(main).toMatch(/builtInClientProofVerifier\(\{\s*managedPath: config\.managedPath,\s*log:/);
    expect(main).not.toMatch(/wasmPath/);
  });
});

// ── P3.1: the seam, against the golden vectors ─────────────────────────────────

describe('the proving provider in required mode (P3.1, the seam)', () => {
  let root: string;
  let serverLocation: string;
  beforeEach(() => {
    root = tempRoot();
    ({ serverLocation } = makeVolume(root));
  });

  const handOffRig = async () => {
    const server = fakeProofServer();
    const handed: Parameters<ClientProofHandOff['handOff']>[0][] = [];
    const provider = await relayProofProvider('http://proof-server:6300', root, {
      fetch: server.fetch,
      clientProofs: {
        circuits: new Set<string>(CLIENT_PROVEN_CIRCUITS),
        handOff: async (r) => {
          handed.push(r);
          return GOLDEN_PROOF();
        },
      },
    });
    return { server, handed, provider };
  };

  it('never sends a k≥18 circuit to the relay prover: it hands the ledger’s own key-less body over, byte for byte', async () => {
    // Without their prover keys: neither proof may read them.
    for (const c of ['open_swap_shielded_with_ed25519', 'withdraw_shielded_with_ed25519']) {
      rmSync(join(root, 'account', 'keys', `${c}.prover`));
    }
    const { server, handed, provider } = await handOffRig();
    for (const v of [MAKER(), WITHDRAW()]) {
      const proof = await provider.provingProvider().prove(v.preimage, v.keyLocation, v.binding);
      expect(sha256(proof)).toBe(sha256(GOLDEN_PROOF()));
      const r = handed.pop()!;
      expect(r.circuit).toBe(v.circuit);
      expect(sha256(r.proofRequest)).toBe(sha256(v.request));
      expect(r.keyMaterialOffset).toBe(v.keyMaterialOffset);
      // The pinned verifier key the location names (its sha256 is the location's `?vk=`).
      expect(v.keyLocation.endsWith(`?vk=${sha256(r.verifierKey)}`)).toBe(true);
    }
    expect(server.calls).toEqual([]);
  });

  it('still checks the k≥18 circuits on the proof server (ZKIR only), and proves everything else there', async () => {
    const { server, handed, provider } = await handOffRig();
    const v = MAKER();
    await provider.provingProvider().check(v.preimage, v.keyLocation);
    expect(server.calls).toEqual(['http://proof-server:6300/check']);
    const preimage = ledger.proofDataIntoSerializedPreimage(
      { value: [], alignment: [] } as never,
      { value: [], alignment: [] } as never,
      [],
      [],
      serverLocation,
    );
    await provider.provingProvider().prove(preimage, serverLocation, 5n);
    const builtin = ledger.proofDataIntoSerializedPreimage(
      { value: [], alignment: [] } as never,
      { value: [], alignment: [] } as never,
      [],
      [],
      'midnight/zswap/spend',
    );
    await provider.provingProvider().prove(builtin, 'midnight/zswap/spend', 5n);
    expect(server.calls).toEqual([
      'http://proof-server:6300/check',
      'http://proof-server:6300/prove',
      'http://proof-server:6300/prove',
    ]);
    expect(handed).toEqual([]);
  });

  it('off mode is unchanged: the same k≥18 call goes to the relay prover', async () => {
    const server = fakeProofServer();
    const provider = await relayProofProvider('http://proof-server:6300', root, { fetch: server.fetch });
    const v = MAKER();
    const answer = await provider.provingProvider().prove(v.preimage, v.keyLocation, v.binding);
    expect([...answer]).toEqual([9, 9, 9]);
    expect(server.calls).toEqual(['http://proof-server:6300/prove']);
  });
});

// ── P3.2: the hand-off, end to end through the queue and the routes ───────────

const PASSPORT_SOURCE = here('../../vendor/passport/contract/src/wallet/account.ts');

/** Passport's DUST-race test, read from the pinned submodule (`submitWithDustRetry`). */
function passportRetryPattern(): RegExp {
  const m = /const dustRace = \/(.+)\/\.test\(msg\);/.exec(readFileSync(PASSPORT_SOURCE, 'utf8'));
  expect(m, 'submitWithDustRetry’s pattern in vendor/passport').not.toBeNull();
  return new RegExp(m![1]!);
}

/** A node rejection as the wallet SDK reports it: SubmissionError ← the node client's ← the RPC's. */
function nodeRejection(code: number): Error {
  const rpc = new Error(`1010: Invalid Transaction: Custom error: ${code}`);
  const client = Object.assign(new Error('Transaction submission failed'), { name: 'SubmissionError', cause: rpc });
  return Object.assign(new Error('Transaction submission error'), { name: 'SubmissionError', cause: client });
}

/** A queue, a desk with a test-double verifier (or, with `real`, the built-in pinned WASM verifier over
 *  the volume) and a hand-driven clock, the routes, and the proving provider over a volume with the
 *  golden vectors' keys. */
async function rig(
  over: { verdict?: () => Promise<ClientProofVerdict>; timeoutSeconds?: number; real?: boolean } = {},
) {
  const root = tempRoot();
  makeVolume(root);
  let now = 1_800_000_000;
  const timers: { at: number; fn: () => void; live: boolean }[] = [];
  const queue = new JobQueue({ ttlSeconds: 3600, maxJobs: 100, log: silentLog(), now: () => now });
  const real = over.real ? await builtInClientProofVerifier({ managedPath: root }) : null;
  const verify = vi.fn<(input: ClientProofVerifierInput) => Promise<ClientProofVerdict>>(
    real ? (input) => real.verify(input) : over.verdict ? () => over.verdict!() : async () => ({ ok: true }),
  );
  const desk = new ClientProofDesk({
    jobs: queue,
    verifier: { name: real ? real.name : 'test-double', verify },
    timeoutSeconds: over.timeoutSeconds ?? 300,
    keySet: KEY_SET,
    proofServer: '9.0.0-rc.8',
    log: silentLog(),
    now: () => now,
    schedule: (fn, ms) => {
      const t = { at: now + ms / 1000, fn, live: true };
      timers.push(t);
      return () => {
        t.live = false;
      };
    },
  });
  queue.useClientProofs(desk);
  // Generous rate limits: these tests send many requests from one client.
  const config = testConfig({ RATE_LIMIT_ACTIONS_PER_MIN: '1000', RATE_LIMIT_READS_PER_MIN: '1000' });
  const h = harness({ queue, clientProofs: desk, config });
  const server = fakeProofServer();
  const provider = await relayProofProvider('http://proof-server:6300', root, {
    fetch: server.fetch,
    clientProofs: { circuits: desk.circuits, handOff: (r) => desk.handOff(r) },
  });
  /** Move the clock; the hand-off timers that are due fire unless `fire` is false. */
  const advance = (seconds: number, fire = true) => {
    now += seconds;
    if (!fire) return;
    for (const t of timers) {
      if (t.live && t.at <= now) {
        t.live = false;
        t.fn();
      }
    }
  };
  const view = (id: string) => queue.get(id)!;
  const stages = (id: string) => view(id).stages.map((s) => s.stage);
  const getRequest = (id: string) => h.app.request(API_PATHS.clientProof(id));
  const postProof = (id: string, body: unknown, type = 'application/json') =>
    h.app.request(API_PATHS.clientProof(id), {
      method: 'POST',
      headers: { 'content-type': type },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  const awaitHandOff = async (id: string, attempt = 1) => {
    await vi.waitFor(() => expect(view(id).clientProof?.attempt).toBe(attempt), { timeout: 5000, interval: 2 });
    return view(id).clientProof!;
  };
  return {
    queue,
    desk,
    verify,
    h,
    server,
    provider,
    advance,
    view,
    stages,
    getRequest,
    postProof,
    awaitHandOff,
    now: () => now,
  };
}

/** A sponsored action (a shielded withdrawal) as the executors run it: prove inside ctx.prove, then
 *  submit through the relay's wallet provider, with Passport's DUST-race retry and midnight-js's
 *  wrapping of a submission error. */
function sponsoredExecutor(
  r: Awaited<ReturnType<typeof rig>>,
  v: Vector,
  submitErrors: Error[],
): { executor: JobExecutor; submitted: Uint8Array[]; revert: ReturnType<typeof vi.fn> } {
  const submitted: Uint8Array[] = [];
  const revert = vi.fn(async () => undefined);
  const handle = {
    wallet: {
      submitTransaction: vi.fn(async (tx: unknown) => {
        const e = submitErrors.shift();
        if (e) throw e;
        submitted.push(tx as Uint8Array);
        return 'tx-id';
      }),
      revertTransaction: revert,
    },
  } as unknown as SponsorWalletHandle;
  const wallet = walletProviderFor(handle, {
    txTtlMs: 60_000,
    log: silentLog(),
    keys: { coinPublicKey: 'c', encryptionPublicKey: 'e' },
    onSubmitError: (e) => r.desk.submissionRefused(e),
  });
  const retry = passportRetryPattern();
  const executor: JobExecutor = async (_payload, ctx) =>
    ctx.prove(async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          const proof = await r.provider.provingProvider().prove(v.preimage, v.keyLocation, v.binding);
          try {
            const id = await wallet.submitTx(proof);
            return { txId: id };
          } catch (err) {
            // midnight-js's scoped transaction wraps a submission error so (midnight-js-contracts).
            throw new Error(`Unexpected error submitting scoped transaction 'withdraw': ${String(err)}`, {
              cause: err,
            });
          }
        } catch (e) {
          if (!retry.test(String((e as Error)?.message ?? e)) || attempt >= 3) throw e;
        }
      }
    });
  return { executor, submitted, revert };
}

describe('the client-proof hand-off (P3.2)', () => {
  it('hands out one request, takes one proof, checks it, then the action completes', async () => {
    const r = await rig();
    const { executor, submitted } = sponsoredExecutor(r, WITHDRAW(), []);
    const job = r.queue.submit({ action: 'withdraw', lane: 'prover', account: ACCOUNT, payload: {}, executor })!;
    const open = await r.awaitHandOff(job.requestId);
    expect(open).toMatchObject({ circuit: 'withdraw_shielded_with_ed25519', attempt: 1, fetched: false });
    expect(open.deadline).toBe(r.now() + 300);
    expect(r.view(job.requestId).state).toBe('running');
    expect(JobViewSchema.parse(r.view(job.requestId)).clientProof).toEqual(open);
    expect(r.stages(job.requestId)).toContain('awaiting-client-proof');

    const res = await r.getRequest(job.requestId);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = ClientProofRequestSchema.parse(await res.json());
    expect(body).toMatchObject({
      proofId: open.proofId,
      circuit: 'withdraw_shielded_with_ed25519',
      keyMaterialOffset: 1556,
      deadline: open.deadline,
      attempt: 1,
      keySet: KEY_SET,
      proofServer: '9.0.0-rc.8',
    });
    expect(sha256(Buffer.from(body.proofRequest, 'base64'))).toBe(sha256(WITHDRAW().request));
    expect(r.view(job.requestId).clientProof?.fetched).toBe(true);

    const proof = Buffer.from(GOLDEN_PROOF()).toString('base64');
    const posted = await r.postProof(job.requestId, { proofId: open.proofId, proof });
    expect(posted.status).toBe(200);
    const answer = (await posted.json()) as { job: JobView };
    expect(answer.job.stage).toBe('client-proof-checked');
    expect(answer.job.state).toBe('running');
    expect(answer.job.clientProof).toBeUndefined();
    expect(r.verify).toHaveBeenCalledTimes(1);
    const input = r.verify.mock.calls[0]![0];
    expect(input.circuit).toBe('withdraw_shielded_with_ed25519');
    expect(sha256(input.proofRequest)).toBe(sha256(WITHDRAW().request));
    expect(sha256(input.proof)).toBe(sha256(GOLDEN_PROOF()));
    expect(sha256(input.verifierKey)).toBe('0af6b9754da02f4b9dd919e5127de96b7d8a44ff318f23b3f4ed6429ad21ed91');

    const done = await r.queue.settled(job.requestId);
    expect(done?.state).toBe('succeeded');
    expect(submitted).toHaveLength(1);
    expect(sha256(submitted[0]!)).toBe(sha256(GOLDEN_PROOF()));
    expect(r.server.calls).toEqual([]); // the relay's prover proved nothing
    const s = r.stages(job.requestId);
    const order = CLIENT_PROOF_STAGES.map((x) => s.indexOf(x));
    expect(order.every((i, k) => i >= 0 && (k === 0 || i > order[k - 1]!))).toBe(true);
    // The request is gone once the hand-off ended.
    expect((await r.getRequest(job.requestId)).status).toBe(409);
  });

  it('takes exactly one proof: a second one, or one for another id, is refused', async () => {
    const r = await rig({
      verdict: () => new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 20)),
    });
    const { executor } = sponsoredExecutor(r, WITHDRAW(), []);
    const job = r.queue.submit({ action: 'withdraw', lane: 'prover', account: ACCOUNT, payload: {}, executor })!;
    const open = await r.awaitHandOff(job.requestId);
    const proof = Buffer.from(GOLDEN_PROOF()).toString('base64');
    expect((await r.postProof(job.requestId, { proofId: 'f'.repeat(32), proof })).status).toBe(409);
    // Two posts at once: the first holds the hand-off while it is checked, the second is refused.
    const [a, b] = await Promise.all([
      r.postProof(job.requestId, { proofId: open.proofId, proof }),
      r.postProof(job.requestId, { proofId: open.proofId, proof }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(((await (a.status === 409 ? a : b).json()) as { error: { code: string } }).error.code).toBe(
      'client-proof-already-received',
    );
    await r.queue.settled(job.requestId);
    const again = await r.postProof(job.requestId, { proofId: open.proofId, proof });
    expect(again.status).toBe(409);
    expect(r.verify).toHaveBeenCalledTimes(1);
  });

  it('an invalid proof (the test-double verifier says no) fails the job client-proof-invalid; nothing is submitted', async () => {
    const r = await rig({ verdict: async () => ({ ok: false, reason: 'pairing check failed' }) });
    const { executor, submitted } = sponsoredExecutor(r, WITHDRAW(), []);
    const failures = new FailureBudget({ perOwner: 5, perAccount: 5 });
    const job = r.queue.submit({
      action: 'withdraw',
      lane: 'prover',
      account: ACCOUNT,
      payload: {},
      executor: guarded(executor, { action: 'withdraw', owner: 'aa'.repeat(32), account: ACCOUNT, failures }),
    })!;
    const open = await r.awaitHandOff(job.requestId);
    await r.getRequest(job.requestId);
    const res = await r.postProof(job.requestId, {
      proofId: open.proofId,
      proof: Buffer.from(GOLDEN_PROOF()).toString('base64'),
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('client-proof-invalid');
    const done = await r.queue.settled(job.requestId);
    expect(done?.state).toBe('failed');
    expect(done?.error?.code).toBe('client-proof-invalid');
    expect(done?.error?.message).toMatch(/your proof server returned an invalid proof/);
    expect(submitted).toEqual([]);
    expect(r.server.calls).toEqual([]);
    // The requester's failure, never the market's.
    expect(failures.failures('aa'.repeat(32))).toBe(1);
    expect(countsAgainstBudget(new PublicError('client-proof-invalid', 'x'), true)).toBe(true);
  });

  it('refuses a proof that is not a proof (wrong tag, too large) as invalid, without calling the verifier', async () => {
    for (const bad of [
      Buffer.from('not a proof at all'),
      Buffer.concat([Buffer.from(PROOF_TAG), randomBytes(64 * 1024)]),
    ]) {
      const r = await rig();
      const { executor, submitted } = sponsoredExecutor(r, WITHDRAW(), []);
      const job = r.queue.submit({ action: 'withdraw', lane: 'prover', account: ACCOUNT, payload: {}, executor })!;
      const open = await r.awaitHandOff(job.requestId);
      const res = await r.postProof(job.requestId, { proofId: open.proofId, proof: bad.toString('base64') });
      expect(res.status).toBe(422);
      expect((await r.queue.settled(job.requestId))?.error?.code).toBe('client-proof-invalid');
      expect(r.verify).not.toHaveBeenCalled();
      expect(submitted).toEqual([]);
    }
  });

  it('a request never fetched before its deadline fails client-proof-missing; nothing is submitted', async () => {
    const r = await rig({ timeoutSeconds: 120 });
    const { executor, submitted } = sponsoredExecutor(r, WITHDRAW(), []);
    const job = r.queue.submit({ action: 'withdraw', lane: 'prover', account: ACCOUNT, payload: {}, executor })!;
    const open = await r.awaitHandOff(job.requestId);
    expect(open.deadline).toBe(r.now() + 120);
    r.advance(119);
    expect(r.view(job.requestId).clientProof).toBeDefined();
    r.advance(1);
    const done = await r.queue.settled(job.requestId);
    expect(done?.error?.code).toBe('client-proof-missing');
    expect(done?.clientProof).toBeUndefined();
    expect(submitted).toEqual([]);
    expect(r.server.calls).toEqual([]);
    const late = await r.postProof(job.requestId, {
      proofId: open.proofId,
      proof: Buffer.from(GOLDEN_PROOF()).toString('base64'),
    });
    expect(late.status).toBe(410);
    expect(r.verify).not.toHaveBeenCalled();
  });

  it('a fetched request whose proof misses the deadline fails client-proof-late; a late proof is refused', async () => {
    const r = await rig();
    const { executor, submitted } = sponsoredExecutor(r, WITHDRAW(), []);
    const job = r.queue.submit({ action: 'withdraw', lane: 'prover', account: ACCOUNT, payload: {}, executor })!;
    const open = await r.awaitHandOff(job.requestId);
    expect((await r.getRequest(job.requestId)).status).toBe(200);
    r.advance(300);
    const done = await r.queue.settled(job.requestId);
    expect(done?.error?.code).toBe('client-proof-late');
    const late = await r.postProof(job.requestId, {
      proofId: open.proofId,
      proof: Buffer.from(GOLDEN_PROOF()).toString('base64'),
    });
    expect(late.status).toBe(410);
    expect(((await late.json()) as { error: { code: string } }).error.code).toBe('client-proof-late');
    expect(submitted).toEqual([]);
  });

  it('a proof posted at the deadline, before the timer fires, is late too', async () => {
    const r = await rig();
    const { executor, submitted } = sponsoredExecutor(r, WITHDRAW(), []);
    const job = r.queue.submit({ action: 'withdraw', lane: 'prover', account: ACCOUNT, payload: {}, executor })!;
    const open = await r.awaitHandOff(job.requestId);
    await r.getRequest(job.requestId);
    // The clock reaches the deadline without the timer having run.
    r.advance(300, false);
    const res = await r.postProof(job.requestId, {
      proofId: open.proofId,
      proof: Buffer.from(GOLDEN_PROOF()).toString('base64'),
    });
    expect(res.status).toBe(410);
    expect((await r.queue.settled(job.requestId))?.error?.code).toBe('client-proof-late');
    expect(submitted).toEqual([]);
  });

  it('a take keeps its settle margin: the deadline is the signed expiry minus 60 s when that is sooner', async () => {
    const r = await rig();
    const v = MAKER();
    const executor: JobExecutor = async (_p, ctx) =>
      ctx.prove(async () => {
        await r.provider.provingProvider().prove(v.preimage, v.keyLocation, v.binding);
        return {};
      });
    const job = r.queue.submit({
      action: 'take',
      lane: 'account',
      account: ACCOUNT,
      payload: { validUntil: String(r.now() + 200) },
      executor,
    })!;
    const open = await r.awaitHandOff(job.requestId);
    expect(open.deadline).toBe(r.now() + 140);
    expect(open.circuit).toBe('open_swap_shielded_with_ed25519');
    r.advance(140);
    expect((await r.queue.settled(job.requestId))?.error?.code).toBe('client-proof-missing');
  });

  it('with under 30 s left at opening it fails client-proof-late at once and hands nothing out', async () => {
    const r = await rig();
    const v = MAKER();
    const executor: JobExecutor = async (_p, ctx) =>
      ctx.prove(async () => {
        await r.provider.provingProvider().prove(v.preimage, v.keyLocation, v.binding);
        return {};
      });
    const job = r.queue.submit({
      action: 'open-swap',
      lane: 'account',
      account: ACCOUNT,
      payload: { validUntil: String(r.now() + 89) },
      executor,
    })!;
    const done = await r.queue.settled(job.requestId);
    expect(done?.error?.code).toBe('client-proof-late');
    expect(done?.stages.map((s) => s.stage)).not.toContain('awaiting-client-proof');
    expect((await r.getRequest(job.requestId)).status).toBe(409);
    expect(r.server.calls).toEqual([]);
  });

  it('a DUST race after a good proof rebuilds the call: a NEW hand-off (attempt 2), and the old id is refused', async () => {
    const r = await rig();
    const { executor, submitted, revert } = sponsoredExecutor(r, WITHDRAW(), [nodeRejection(196)]);
    const job = r.queue.submit({ action: 'withdraw', lane: 'prover', account: ACCOUNT, payload: {}, executor })!;
    const first = await r.awaitHandOff(job.requestId, 1);
    const proof = Buffer.from(GOLDEN_PROOF()).toString('base64');
    expect((await r.postProof(job.requestId, { proofId: first.proofId, proof })).status).toBe(200);
    const second = await r.awaitHandOff(job.requestId, 2);
    expect(second.proofId).not.toBe(first.proofId);
    const stale = await r.postProof(job.requestId, { proofId: first.proofId, proof });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { error: { code: string } }).error.code).toBe('client-proof-wrong-id');
    expect((await r.postProof(job.requestId, { proofId: second.proofId, proof })).status).toBe(200);
    expect((await r.queue.settled(job.requestId))?.state).toBe('succeeded');
    expect(submitted).toHaveLength(1);
    expect(revert).not.toHaveBeenCalled(); // a DUST race is the wallet's own retry, not a refused proof
  });

  it('a proof the network refuses as invalid ends client-proof-invalid: no retry, no more proofs asked for, the spend reverted', async () => {
    for (const code of [115, 179]) {
      const r = await rig();
      const { executor, submitted, revert } = sponsoredExecutor(r, WITHDRAW(), [nodeRejection(code)]);
      const failures = new FailureBudget({ perOwner: 5, perAccount: 5 });
      const job = r.queue.submit({
        action: 'withdraw',
        lane: 'prover',
        account: ACCOUNT,
        payload: {},
        executor: guarded(executor, { action: 'withdraw', owner: 'aa'.repeat(32), account: ACCOUNT, failures }),
      })!;
      const open = await r.awaitHandOff(job.requestId);
      const proof = Buffer.from(GOLDEN_PROOF()).toString('base64');
      expect((await r.postProof(job.requestId, { proofId: open.proofId, proof })).status).toBe(200);
      const done = await r.queue.settled(job.requestId);
      expect(done?.error?.code).toBe('client-proof-invalid');
      expect(done?.error?.message).toMatch(/the network refused the proof/);
      expect(done?.stages.filter((s) => s.stage === 'awaiting-client-proof')).toHaveLength(1);
      expect(revert).toHaveBeenCalledTimes(1);
      expect(submitted).toEqual([]);
      expect(failures.failures('aa'.repeat(32))).toBe(1);
    }
  });

  it('the failures cannot match Passport’s DUST-race retry, as thrown or as midnight-js wraps them', () => {
    const retry = passportRetryPattern();
    // Today's node rejection DOES match (so a refused proof would be rebuilt three more times).
    expect(retry.test(String(nodeRejection(115)))).toBe(true);
    // Every message the desk can end a job with (read from its source, so a new one is covered too).
    const desk = readFileSync(join(SRC, 'client-proving', 'desk.ts'), 'utf8');
    const block = /const MESSAGES = \{([\s\S]*?)\} as const;/.exec(desk)![1]!;
    const messages = [...block.matchAll(/'([^']+)'|"([^"]+)"/g)].map((m) => m[1] ?? m[2]!);
    expect(messages.length).toBeGreaterThanOrEqual(5);
    for (const m of messages) {
      const e = new PublicError('client-proof-invalid', m);
      expect(retry.test(e.message)).toBe(false);
      expect(retry.test(`Unexpected error submitting scoped transaction 'withdraw': ${String(e)}`)).toBe(false);
    }
  });

  it('tells a proof refusal from the other node refusals', () => {
    expect(isProofRefusal(nodeRejection(115))).toBe(true);
    expect(isProofRefusal(nodeRejection(179))).toBe(true);
    for (const other of [196, 117, 138, 231, 235, 1150, 11]) expect(isProofRefusal(nodeRejection(other))).toBe(false);
    expect(isProofRefusal(new Error('fetch failed'))).toBe(false);
  });

  it('a job that ends while its hand-off is open abandons it; a proof posted then is ignored', async () => {
    const r = await rig();
    let fail!: (e: Error) => void;
    const v = WITHDRAW();
    const executor: JobExecutor = async (_p, ctx) =>
      ctx.prove(
        () =>
          new Promise((_resolve, reject) => {
            fail = reject;
            r.provider
              .provingProvider()
              .prove(v.preimage, v.keyLocation, v.binding)
              .catch(() => undefined);
          }),
      );
    const job = r.queue.submit({ action: 'withdraw', lane: 'prover', account: ACCOUNT, payload: {}, executor })!;
    const open = await r.awaitHandOff(job.requestId);
    fail(new PublicError('chain-unavailable', 'the chain could not be read'));
    expect((await r.queue.settled(job.requestId))?.error?.code).toBe('chain-unavailable');
    const res = await r.postProof(job.requestId, {
      proofId: open.proofId,
      proof: Buffer.from(GOLDEN_PROOF()).toString('base64'),
    });
    expect(res.status).toBe(410);
    expect(r.verify).not.toHaveBeenCalled();
  });

  it('a k≥18 proof outside a prover-lane hold fails closed: nothing is handed out', async () => {
    const r = await rig();
    const v = WITHDRAW();
    await expect(r.provider.provingProvider().prove(v.preimage, v.keyLocation, v.binding)).rejects.toThrow(
      /outside a prover-lane hold/,
    );
    expect(r.server.calls).toEqual([]);
  });

  it('non-k≥18 actions are unchanged in required mode: no hand-off, no new field, proven by the relay', async () => {
    const r = await rig();
    const preimage = ledger.proofDataIntoSerializedPreimage(
      { value: [], alignment: [] } as never,
      { value: [], alignment: [] } as never,
      [],
      [],
      'midnight/zswap/output',
    );
    const executor: JobExecutor = async (_p, ctx) =>
      ctx.prove(async () => {
        await r.provider.provingProvider().prove(preimage, 'midnight/zswap/output', 1n);
        return { ok: true };
      });
    const job = r.queue.submit({ action: 'register', lane: 'prover', payload: {}, executor })!;
    const done = await r.queue.settled(job.requestId);
    expect(done?.state).toBe('succeeded');
    expect(done?.stages.map((s) => s.stage)).toEqual(['queued', 'running', 'succeeded']);
    expect(r.server.calls).toEqual(['http://proof-server:6300/prove']);
    expect((await r.getRequest(job.requestId)).status).toBe(409);
  });
});

// ── the routes: shapes, refusals, off mode ─────────────────────────────────────

describe('the client-proof routes', () => {
  it('in off mode answer 404 client-proving-off, and nothing new is published', async () => {
    const h = harness();
    const id = '0'.repeat(32);
    for (const res of [
      await h.app.request(API_PATHS.clientProof(id)),
      await h.app.request(API_PATHS.clientProof(id), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ proofId: id, proof: 'AAAA' }),
      }),
    ]) {
      expect(res.status).toBe(404);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('client-proving-off');
    }
    const cfg = (await (await h.app.request('/v1/config')).json()) as Record<string, unknown>;
    expect(cfg).not.toHaveProperty('clientProving');
    const job = h.queue.submit({ action: 'register', lane: 'prover', payload: {}, executor: async () => ({}) })!;
    expect((await h.queue.settled(job.requestId)) as JobView).not.toHaveProperty('clientProof');
  });

  it('in required mode the client-proof POST is the only state-changing route beside POST /v1/actions/:action', async () => {
    const r = await rig();
    const writes = r.h.app.routes.filter((x) => !['GET', 'ALL', 'OPTIONS', 'HEAD'].includes(x.method));
    expect([...new Set(writes.map((x) => `${x.method} ${x.path}`))].sort()).toEqual([
      'POST /v1/actions/:action',
      'POST /v1/jobs/:requestId/client-proof',
    ]);
  });

  it('in required mode /v1/config advertises the circuits, the key set, the proof server and the timeout', async () => {
    const r = await rig({ timeoutSeconds: 240 });
    const cfg = PublicConfigSchema.parse(await (await r.h.app.request('/v1/config')).json());
    expect(cfg.clientProving).toEqual({
      mode: 'required',
      circuits: [
        'append_inbox_with_ed25519',
        'open_swap_shielded_with_ed25519',
        'withdraw_shielded_with_ed25519',
        'withdraw_unshielded_with_ed25519',
      ],
      keySet: KEY_SET,
      proofServer: '9.0.0-rc.8',
      timeoutSeconds: 240,
    });
  });

  it('/health reports the mode when it is required, and nothing when it is off', async () => {
    const base = {
      network: 'undeployed',
      version: 'v',
      startedAt: 0,
      sponsor: new FakeSponsor(),
      dustLowSpecks: 1n,
      prover: { probe: async () => ({ reachable: true, version: '9.0.0-rc.8', jobCapacity: 1, versionMatches: true }) },
      dustProver: {
        probe: async () => ({ reachable: true, version: '9.0.0-rc.6', jobCapacity: 1, versionMatches: true }),
      },
      keys: () => ({
        present: true,
        fingerprint: KEY_SET,
        pinned: true,
        matchesPin: true,
        missingProverKeys: [],
        missingVerifierKeys: [],
        missingZkir: [],
        mismatchedVerifierKeys: [],
      }),
      queue: new JobQueue({ ttlSeconds: 60, maxJobs: 10, log: silentLog() }),
      probes: { kernel: async () => ({ reachable: true, synced: true }), batcher: async () => ({ reachable: true }) },
      cacheSeconds: 0,
    } as unknown as Parameters<typeof healthCollector>[0];
    const required = HealthResponseSchema.parse(
      await healthCollector({ ...base, clientProving: { mode: 'required' } })(),
    );
    expect(required.clientProving).toEqual({ mode: 'required' });
    expect(await healthCollector(base)()).not.toHaveProperty('clientProving');
  });

  it('refuse malformed requests before touching the hand-off', async () => {
    const r = await rig();
    const { executor } = sponsoredExecutor(r, WITHDRAW(), []);
    const job = r.queue.submit({ action: 'withdraw', lane: 'prover', account: ACCOUNT, payload: {}, executor })!;
    const open = await r.awaitHandOff(job.requestId);
    const proof = Buffer.from(GOLDEN_PROOF()).toString('base64');
    const code = async (res: Response) => [res.status, ((await res.json()) as { error: { code: string } }).error.code];
    expect(await code(await r.getRequest('zz'))).toEqual([400, 'bad-request']);
    expect(await code(await r.getRequest('e'.repeat(32)))).toEqual([404, 'not-found']);
    expect(await code(await r.postProof('zz', { proofId: open.proofId, proof }))).toEqual([400, 'bad-request']);
    expect(await code(await r.postProof('e'.repeat(32), { proofId: open.proofId, proof }))).toEqual([404, 'not-found']);
    expect(await code(await r.postProof(job.requestId, 'not json'))).toEqual([400, 'bad-request']);
    expect(await code(await r.postProof(job.requestId, { proofId: open.proofId, proof }, 'text/plain'))).toEqual([
      400,
      'bad-request',
    ]);
    for (const body of [
      { proofId: open.proofId },
      { proofId: open.proofId.toUpperCase(), proof },
      { proofId: open.proofId, proof: 'not base64!' },
      { proofId: open.proofId, proof: proof.replace(/=+$/, '') + '=' },
      { proofId: open.proofId, proof, url: 'http://127.0.0.1:6300' },
    ]) {
      expect(await code(await r.postProof(job.requestId, body))).toEqual([400, 'bad-request']);
    }
    const huge = { proofId: open.proofId, proof: 'A'.repeat(130 * 1024) };
    expect(await code(await r.postProof(job.requestId, huge))).toEqual([413, 'payload-too-large']);
    // None of those consumed the hand-off: the real proof is still taken.
    expect(r.view(job.requestId).clientProof?.proofId).toBe(open.proofId);
    expect((await r.postProof(job.requestId, { proofId: open.proofId, proof })).status).toBe(200);
    expect((await r.queue.settled(job.requestId))?.state).toBe('succeeded');
  });
});

// ── P3.5: the hand-off with the built-in verifier (the pinned WASM) ─────────────

describe('the hand-off with the built-in verifier (P3.5, questions Q3 → A)', () => {
  const MAKE = () => fixture('open_swap_shielded_with_ed25519.maker.proof.bin');
  const WITHDRAWAL = () => fixture('withdraw_shielded_with_ed25519.proof.bin');

  it('a node-accepted golden proof is checked and the action completes with exactly those bytes', async () => {
    const r = await rig({ real: true });
    const { executor, submitted } = sponsoredExecutor(r, WITHDRAW(), []);
    const job = r.queue.submit({ action: 'withdraw', lane: 'prover', account: ACCOUNT, payload: {}, executor })!;
    const open = await r.awaitHandOff(job.requestId);
    await r.getRequest(job.requestId);
    const posted = await r.postProof(job.requestId, {
      proofId: open.proofId,
      proof: Buffer.from(WITHDRAWAL()).toString('base64'),
    });
    expect(posted.status).toBe(200);
    expect(((await posted.json()) as { job: JobView }).job.stage).toBe('client-proof-checked');
    expect(await r.verify.mock.results[0]!.value).toEqual({ ok: true });
    const done = await r.queue.settled(job.requestId);
    expect(done?.state).toBe('succeeded');
    expect(submitted.map(sha256)).toEqual([sha256(WITHDRAWAL())]);
    expect(r.server.calls).toEqual([]);
  });

  it('a make: the maker golden proof is checked', async () => {
    const r = await rig({ real: true });
    const { executor } = sponsoredExecutor(r, MAKER(), []);
    const job = r.queue.submit({ action: 'withdraw', lane: 'prover', account: ACCOUNT, payload: {}, executor })!;
    const open = await r.awaitHandOff(job.requestId);
    const posted = await r.postProof(job.requestId, {
      proofId: open.proofId,
      proof: Buffer.from(MAKE()).toString('base64'),
    });
    expect(posted.status).toBe(200);
    expect((await r.queue.settled(job.requestId))?.state).toBe('succeeded');
  });

  for (const [what, bad] of [
    [
      'a flipped byte',
      () => {
        const p = WITHDRAWAL();
        p[4000] ^= 0x01;
        return p;
      },
    ],
    ['another circuit’s valid proof (a make’s, for a withdrawal)', MAKE],
  ] as [string, () => Uint8Array][]) {
    it(`${what}: client-proof-invalid, charged to the requester, nothing submitted`, async () => {
      const r = await rig({ real: true });
      const { executor, submitted } = sponsoredExecutor(r, WITHDRAW(), []);
      const failures = new FailureBudget({ perOwner: 5, perAccount: 5 });
      const job = r.queue.submit({
        action: 'withdraw',
        lane: 'prover',
        account: ACCOUNT,
        payload: {},
        executor: guarded(executor, { action: 'withdraw', owner: 'aa'.repeat(32), account: ACCOUNT, failures }),
      })!;
      const open = await r.awaitHandOff(job.requestId);
      const res = await r.postProof(job.requestId, {
        proofId: open.proofId,
        proof: Buffer.from(bad()).toString('base64'),
      });
      expect(res.status).toBe(422);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('client-proof-invalid');
      const verdict = (await r.verify.mock.results[0]!.value) as ClientProofVerdict;
      expect(verdict.ok).toBe(false);
      const done = await r.queue.settled(job.requestId);
      expect(done?.error?.code).toBe('client-proof-invalid');
      expect(submitted).toEqual([]);
      expect(r.server.calls).toEqual([]);
      expect(failures.failures('aa'.repeat(32))).toBe(1);
    });
  }
});

// ── P3.3: the relay never fetches a user-supplied URL ──────────────────────────

describe('no user URL is ever fetched (P3.3, spec FR-003)', () => {
  it('a whole hand-off, fed URLs everywhere it takes input, makes no request at all', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    const r = await rig();
    const { executor } = sponsoredExecutor(r, WITHDRAW(), []);
    const job = r.queue.submit({ action: 'withdraw', lane: 'prover', account: ACCOUNT, payload: {}, executor })!;
    const open = await r.awaitHandOff(job.requestId);
    const url = 'http://127.0.0.1:6300/prove-circuit';
    expect(
      (await r.h.app.request(`${API_PATHS.clientProof(job.requestId)}?url=${encodeURIComponent(url)}`)).status,
    ).toBe(200);
    const withUrl = Buffer.concat([Buffer.from(PROOF_TAG), Buffer.from(` ${url} https://prover.example/`)]);
    for (const body of [
      { proofId: open.proofId, proof: Buffer.from(GOLDEN_PROOF()).toString('base64'), proverUrl: url },
      { proofId: open.proofId, proof: Buffer.from(GOLDEN_PROOF()).toString('base64'), callback: url },
    ]) {
      expect((await r.postProof(job.requestId, body)).status).toBe(400);
    }
    const res = await r.postProof(job.requestId, { proofId: open.proofId, proof: withUrl.toString('base64') });
    expect(res.status).toBe(200); // the test double accepts it; the bytes are only handed to the ledger
    await r.queue.settled(job.requestId);
    expect(spy).not.toHaveBeenCalled();
    expect(r.server.calls).toEqual([]);
  });

  it('the client-proving code makes no network request and reads no URL from its input', () => {
    const dir = join(SRC, 'client-proving');
    const sources = readdirSync(dir).filter((f) => f.endsWith('.ts'));
    expect(sources).toEqual(expect.arrayContaining(['desk.ts', 'verifier.ts']));
    for (const f of sources) {
      const s = readFileSync(join(dir, f), 'utf8');
      expect(s, f).not.toMatch(
        /\bfetch\s*\(|from ['"]node:(?:http|https|net|tls|dgram)['"]|new\s+WebSocket|new\s+URL\s*\(/,
      );
    }
    // P3.5: the only other thing there is the pinned verifier's generated module (./verifier-wasm/). Its
    // glue's one `fetch(` is the URL initialiser the relay never calls: verifier.ts instantiates the
    // module from the bytes it read and checked (`initSync`); the module itself imports no network API
    // (./client-proof-verifier.test.ts).
    expect(readdirSync(dir).filter((f) => !f.endsWith('.ts'))).toEqual(['verifier-wasm']);
    const verifier = readFileSync(join(dir, 'verifier.ts'), 'utf8');
    expect(verifier).toMatch(/glue\.initSync\(\{ module \}\)/);
    expect(verifier).not.toMatch(/__wbg_init|\.default\(|import \w+ from '\.\/verifier-wasm/);
    // The routes take exactly {proofId, proof}: the schema is strict.
    const app = readFileSync(join(SRC, 'app.ts'), 'utf8');
    const section = app.slice(
      app.indexOf('AA 00062 (I-62a): the client-proof hand-off'),
      app.indexOf('app.get(API_PATHS.demoTokens'),
    );
    expect(section).toContain('ClientProofSubmissionSchema.safeParse');
    expect(section).not.toMatch(/\bfetch\s*\(/);
  });
});

// ── the relay at start-up (Bun, as deployed) ───────────────────────────────────

function startRelay(env: Record<string, string>): Promise<{ code: number | null; out: string; config?: unknown }> {
  const port = 10_000 + Math.floor(Math.random() * 40_000);
  const tokensDir = tempRoot();
  const tokens = join(tokensDir, 'tokens.json');
  writeFileSync(tokens, JSON.stringify({ tokens: [{ symbol: 'tA', decimals: 6, midnightColour: 'aa'.repeat(32) }] }));
  return new Promise((resolve, reject) => {
    const child = spawn('bun', [join(SRC, 'main.ts')], {
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '/tmp',
        RELAY_NETWORK: 'undeployed',
        TOKENS_FILE: tokens,
        RELAY_HOST: '127.0.0.1',
        RELAY_PORT: String(port),
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let config: unknown;
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`the relay did not exit:\n${out}`));
    }, 60_000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, out, config });
    });
    void (async () => {
      for (;;) {
        if (child.exitCode !== null) return;
        const body = await fetch(`http://127.0.0.1:${port}/v1/config`).then(
          (r) => (r.ok ? r.json() : null),
          () => null,
        );
        if (body) {
          config = body;
          child.kill('SIGTERM');
          return;
        }
        await new Promise((r) => setTimeout(r, 200));
      }
    })();
  });
}

describe('the relay at start-up with CLIENT_PROVING (Bun)', () => {
  it('in required mode loads the pinned verifier under Bun, then refuses to start (exit 78) without a key volume', async () => {
    const r = await startRelay({ CLIENT_PROVING: 'required' });
    expect(r.code).toBe(78);
    // The verifier loaded: its SHA-256 was the pin (P3.5); what is missing is the key volume.
    expect(r.out).toContain('client-proof verifier loaded');
    expect(r.out).toContain(CLIENT_PROOF_VERIFIER_WASM_SHA256);
    expect(r.out).toContain('CLIENT_PROVING=required needs the key volume');
    expect(r.out).toContain('refusing to start');
  }, 90_000);

  it('refuses an unknown mode (exit 78)', async () => {
    const r = await startRelay({ CLIENT_PROVING: 'maybe' });
    expect(r.code).toBe(78);
    expect(r.out).toContain('CLIENT_PROVING must be one of off, required');
  }, 90_000);

  it('starts in off mode, explicit or by default, publishing nothing new', async () => {
    for (const env of [{}, { CLIENT_PROVING: 'off' }] as Record<string, string>[]) {
      const r = await startRelay(env);
      expect(r.config, r.out).toBeTruthy();
      expect(r.config).not.toHaveProperty('clientProving');
    }
  }, 120_000);
});
