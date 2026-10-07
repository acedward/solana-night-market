// AA 00062 P3 (L-RELAY) and P3.6 (L-PROVEFIRST): the relay's client-proving mode, `CLIENT_PROVING=off|required`
// (plan I-62a v2, "prove first"; owner, questions Q4 → D).
//
//   - the mode is validated at start and `off` is the default; `required` needs the REAL client-proof
//     verifier (questions Q3 → A, P3.5: the pinned WASM, ./client-proof-verifier.test.ts) and the key
//     volume, and never a permissive one; the ticket timeout defaults to 600 s (60–3000);
//   - in `required` the relay's own prover REFUSES the four k≥18 circuits; prove first CAPTURES the
//     ledger's own key-less body at prepare (checked byte for byte against the P1.2 golden vectors) and
//     INJECTS the user's proof at finalize (the builtins still go to the proof server);
//   - the REAL executors (withdraw, open-swap, take) park on a ticket holding NOTHING but their account's
//     slot: another user's account opening and demo tokens run meanwhile (the prover lane and the sponsor
//     wallet are free);
//   - one proof per ticket, one ticket per job; missing, late and invalid proofs end the job with their
//     codes (the invalid case through a TEST-DOUBLE verifier injected into the desk, never through
//     configuration, and through the real verifier); nothing is submitted;
//   - a stale call (the account moved between prepare and finalize) → 409 `client-proof-stale`, nothing
//     submitted, not charged, and the same signed request goes through when sent again; the node's
//     code 104 maps to it too, never to a DUST race; a DUST race re-balances with the SAME proof;
//   - a restart drops the tickets with their jobs: a clear 404;
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
  encodeOffer,
  type JobView,
  type OpenSwapPayload,
  type TakePayload,
} from '@nightmarket/core';
import { of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { accountOffer, walletOffer, type FakeTx } from '../../test/gates/take/fake-tx.js';
import { appendInboxExecutor, withdrawExecutor, type AccountActionDeps } from '../src/actions/account-actions.js';
import { CLIENT_PROVEN_ACTIONS, defaultCatalogue, withClientProving } from '../src/actions/catalogue.js';
import { countsAgainstBudget, FailureBudget } from '../src/actions/failure-budget.js';
import { guarded } from '../src/app.js';
import { DigestReplayGuard } from '../src/auth/verifiers.js';
import { ClientProofDesk, isProofRefusal, isStaleRefusal } from '../src/client-proving/desk.js';
import { ClientProving, ProveFirst, isDustRace, type ProveFirstLedger } from '../src/client-proving/prove-first.js';
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
import { PassportRuntime } from '../src/passport/runtime.js';
import type { SponsorWalletHandle } from '../src/passport/wallet-provider.js';
import { relayProofProvider } from '../src/prover/proving-provider.js';
import { JobQueue, PublicError, type JobExecutor } from '../src/queue/jobs.js';
import { ExclusiveSponsorSession } from '../src/sponsor/session.js';
import type { ProvenAccountOffer } from '../src/trade/account-offer.js';
import { openSwapExecutor, takeExecutor, type TradeDeps } from '../src/trade/executors.js';
import { describeTx } from '../src/trade/tx-structure.js';
import { callSigner, testArm, testCallMessage, testDeviceEntry } from './fake-arm.js';
import { FakeSponsor, harness, silentLog, testConfig, testEntitlements } from './harness.js';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const FIXTURES = here('./fixtures/client-proof/');
const SRC = here('../src/');
const fixture = (name: string) => new Uint8Array(readFileSync(join(FIXTURES, name)));
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const ACCOUNT = '11'.repeat(32);
const KEY_SET = 'ab'.repeat(32);
const OWNER_KEY = (s: { deviceKey: string }) => s.deviceKey;

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

const VECTORS = {
  maker: () => vector('open_swap_shielded_with_ed25519.maker', 'open_swap_shielded_with_ed25519', 2585),
  taker: () => vector('open_swap_shielded_with_ed25519.taker', 'open_swap_shielded_with_ed25519', 2586),
  withdraw: () => vector('withdraw_shielded_with_ed25519', 'withdraw_shielded_with_ed25519', 1556),
};
type VectorName = keyof typeof VECTORS;
const GOLDEN_PROOF = () => fixture('open_swap_shielded_with_ed25519.maker.proof.bin');
const REAL_PROOFS: Record<VectorName, () => Uint8Array> = {
  maker: () => fixture('open_swap_shielded_with_ed25519.maker.proof.bin'),
  taker: () => fixture('open_swap_shielded_with_ed25519.taker.proof.bin'),
  withdraw: () => fixture('withdraw_shielded_with_ed25519.proof.bin'),
};

const builtin = (location: string) =>
  ledger.proofDataIntoSerializedPreimage(
    { value: [], alignment: [] } as never,
    { value: [], alignment: [] } as never,
    [],
    [],
    location,
  );

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
    calls.push(String(input).replace('http://proof-server:6300', ''));
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

/** A node rejection as the wallet SDK reports it: SubmissionError ← the node client's ← the RPC's. */
function nodeRejection(code: number): Error {
  const rpc = new Error(`1010: Invalid Transaction: Custom error: ${code}`);
  const client = Object.assign(new Error('Transaction submission failed'), { name: 'SubmissionError', cause: rpc });
  return Object.assign(new Error('Transaction submission error'), { name: 'SubmissionError', cause: client });
}

const PASSPORT_SOURCE = here('../../vendor/passport/contract/src/wallet/account.ts');

/** Passport's DUST-race test, read from the pinned submodule (`submitWithDustRetry`). */
function passportRetryPattern(): RegExp {
  const m = /const dustRace = \/(.+)\/\.test\(msg\);/.exec(readFileSync(PASSPORT_SOURCE, 'utf8'));
  expect(m, 'submitWithDustRetry’s pattern in vendor/passport').not.toBeNull();
  return new RegExp(m![1]!);
}

// ── P3.1: the mode ─────────────────────────────────────────────────────────────

describe('CLIENT_PROVING (P3.1; I-62a v2 deadlines)', () => {
  it('defaults to off, with a 600 s ticket timeout', () => {
    expect(testConfig().clientProving).toEqual({ mode: 'off', timeoutSeconds: 600 });
    expect(testConfig({ CLIENT_PROVING: 'off' }).clientProving.mode).toBe('off');
    expect(testConfig({ CLIENT_PROVING: 'required' }).clientProving).toEqual({ mode: 'required', timeoutSeconds: 600 });
  });

  it('refuses any other mode, and a timeout outside 60–3000 s', () => {
    for (const bad of ['on', 'REQUIRED', 'optional', 'true']) {
      expect(() => testConfig({ CLIENT_PROVING: bad })).toThrow(ConfigError);
    }
    expect(() => testConfig({ CLIENT_PROVING: 'on' })).toThrow(/CLIENT_PROVING must be one of off, required/);
    for (const bad of ['59', '3001', '0', '300.5', 'x']) {
      expect(() => testConfig({ CLIENT_PROOF_TIMEOUT_SECONDS: bad })).toThrow(/CLIENT_PROOF_TIMEOUT_SECONDS/);
    }
    expect(testConfig({ CLIENT_PROOF_TIMEOUT_SECONDS: '60' }).clientProving.timeoutSeconds).toBe(60);
    expect(testConfig({ CLIENT_PROOF_TIMEOUT_SECONDS: '3000' }).clientProving.timeoutSeconds).toBe(3000);
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

  it('in required mode every k≥18 action runs on its account’s lane; the others keep theirs', () => {
    const before = defaultCatalogue();
    const after = withClientProving(defaultCatalogue());
    expect([...CLIENT_PROVEN_ACTIONS].sort()).toEqual([
      'append-inbox',
      'open-swap',
      'take',
      'withdraw',
      'withdraw-unshielded',
    ]);
    for (const [action, def] of after) {
      expect(def.lane, action).toBe(CLIENT_PROVEN_ACTIONS.includes(action) ? 'account' : before.get(action)!.lane);
    }
  });
});

// ── P3.1 / P3.6: the relay's prover in required mode, and capture / inject ─────

describe('the proving provider in required mode (fail closed)', () => {
  let root: string;
  let serverLocation: string;
  beforeEach(() => {
    root = tempRoot();
    ({ serverLocation } = makeVolume(root));
  });

  it('refuses every k≥18 circuit: nothing is sent to the proof server, no prover key is read', async () => {
    for (const c of ['open_swap_shielded_with_ed25519', 'withdraw_shielded_with_ed25519']) {
      rmSync(join(root, 'account', 'keys', `${c}.prover`));
    }
    const server = fakeProofServer();
    const provider = await relayProofProvider('http://proof-server:6300', root, {
      fetch: server.fetch,
      clientCircuits: new Set<string>(CLIENT_PROVEN_CIRCUITS),
    });
    for (const v of [VECTORS.maker(), VECTORS.withdraw()]) {
      await expect(provider.provingProvider().prove(v.preimage, v.keyLocation, v.binding)).rejects.toThrow(
        /proven by the user's prover in CLIENT_PROVING=required mode/,
      );
    }
    expect(server.calls).toEqual([]);
  });

  it('still checks the k≥18 circuits (ZKIR only), and proves the other circuits and the builtins', async () => {
    const server = fakeProofServer();
    const provider = await relayProofProvider('http://proof-server:6300', root, {
      fetch: server.fetch,
      clientCircuits: new Set<string>(CLIENT_PROVEN_CIRCUITS),
    });
    const v = VECTORS.maker();
    await provider.provingProvider().check(v.preimage, v.keyLocation);
    await provider.provingProvider().prove(builtin(serverLocation), serverLocation, 5n);
    await provider.provingProvider().prove(builtin('midnight/zswap/spend'), 'midnight/zswap/spend', 5n);
    expect(server.calls).toEqual(['/check', '/prove', '/prove']);
  });

  it('off mode is unchanged: the same k≥18 call goes to the relay prover', async () => {
    const server = fakeProofServer();
    const provider = await relayProofProvider('http://proof-server:6300', root, { fetch: server.fetch });
    const v = VECTORS.maker();
    const answer = await provider.provingProvider().prove(v.preimage, v.keyLocation, v.binding);
    expect([...answer]).toEqual([9, 9, 9]);
    expect(server.calls).toEqual(['/prove']);
  });
});

/**
 * The ledger as prove first drives it, around stand-in transactions: `unproven(name)` is what a build
 * returns (its bytes name a golden vector); its `prove` asks the provider for the vector's `check`, then
 * for ALL its proofs at once, as the ledger does (R6: the k≥18 call plus two Zswap builtins), and returns
 * a stand-in proven transaction carrying the k≥18 proof it got. `changeBinding` makes the NEXT
 * deserialisation re-derive a different request (a call that is no longer the prepared one).
 */
function fakeLedger(o: { intentTtl: () => number }) {
  const state = { deserialized: 0, changeBinding: false, captureOnly: [] as number[] };
  const nameOf = (bytes: Uint8Array) =>
    Buffer.from(bytes)
      .toString()
      .replace(/^unproven:/, '') as VectorName;
  const L: ProveFirstLedger = {
    createProvingPayload: (p, b) => ledger.createProvingPayload(p, b),
    costModel: () => ({}),
    deserializeUnproven(bytes) {
      state.deserialized++;
      const name = nameOf(bytes);
      const v = VECTORS[name]();
      const binding = state.changeBinding ? (v.binding ?? 0n) + 1n : v.binding;
      return {
        serialize: () => bytes,
        intents: new Map([[1, { ttl: new Date(o.intentTtl() * 1000) }]]),
        async prove(provider) {
          await provider.check(v.preimage, v.keyLocation);
          const [proof, ...builtins] = await Promise.all([
            provider.prove(v.preimage, v.keyLocation, binding),
            provider.prove(builtin('midnight/zswap/spend'), 'midnight/zswap/spend', 5n),
            provider.prove(builtin('midnight/zswap/output'), 'midnight/zswap/output', 6n),
          ]);
          return { kind: 'proven', name, proof, builtins: builtins.length };
        },
      };
    },
  };
  const unproven = (name: VectorName) => ({ serialize: () => Uint8Array.from(Buffer.from(`unproven:${name}`)) });
  return { L, state, unproven };
}

describe('prove first: capture at prepare, inject at finalize (P3.6.2)', () => {
  let root: string;
  beforeEach(() => {
    root = tempRoot();
    makeVolume(root);
  });

  const pf = async () => {
    const server = fakeProofServer();
    const provider = await relayProofProvider('http://proof-server:6300', root, {
      fetch: server.fetch,
      clientCircuits: new Set<string>(CLIENT_PROVEN_CIRCUITS),
    });
    const fl = fakeLedger({ intentTtl: () => 1_800_003_600 });
    const proveFirst = new ProveFirst({
      proofProvider: provider,
      circuits: new Set<string>(CLIENT_PROVEN_CIRCUITS),
      log: silentLog(),
      ledger: fl.L,
    });
    return { server, proveFirst, ...fl };
  };

  it('captures the ledger’s own key-less body, byte for byte, and proves NOTHING (only /check)', async () => {
    for (const [name, v] of Object.entries(VECTORS) as [VectorName, () => Vector][]) {
      const t = await pf();
      const c = await t.proveFirst.capture(t.unproven(name));
      expect(c.circuit).toBe(v().circuit);
      expect(sha256(c.proofRequest)).toBe(sha256(v().request));
      expect(c.keyMaterialOffset).toBe(v().keyMaterialOffset);
      expect(v().keyLocation.endsWith(`?vk=${sha256(c.verifierKey)}`)).toBe(true);
      expect(c.intentTtl).toBe(1_800_003_600);
      expect(Buffer.from(c.unproven).toString()).toBe(`unproven:${name}`);
      expect(t.server.calls).toEqual(['/check']);
    }
  });

  it('injects the user’s proof into the SAME call at finalize; the builtins go to the proof server', async () => {
    const t = await pf();
    const c = await t.proveFirst.capture(t.unproven('withdraw'));
    const proof = REAL_PROOFS.withdraw();
    const proven = (await t.proveFirst.inject(c, proof)) as { proof: Uint8Array; builtins: number };
    expect(sha256(proven.proof)).toBe(sha256(proof));
    expect(proven.builtins).toBe(2);
    expect(t.server.calls).toEqual(['/check', '/check', '/prove', '/prove']);
    // Again (a DUST race): the same proof, the builtins proven again.
    const again = (await t.proveFirst.inject(c, proof)) as { proof: Uint8Array };
    expect(sha256(again.proof)).toBe(sha256(proof));
  });

  it('a request that changed between prepare and finalize is never finalized: market-unavailable', async () => {
    const t = await pf();
    const c = await t.proveFirst.capture(t.unproven('maker'));
    t.state.changeBinding = true;
    await expect(t.proveFirst.inject(c, GOLDEN_PROOF())).rejects.toMatchObject({
      name: 'PublicError',
      code: 'market-unavailable',
    });
  });

  it('a transaction without a client-proven call cannot be prepared (fails closed)', async () => {
    const t = await pf();
    const none = {
      serialize: () => Uint8Array.of(1),
      intents: new Map(),
      prove: async (p: { prove(a: Uint8Array, b: string, c?: bigint): Promise<Uint8Array> }) => {
        await p.prove(builtin('midnight/zswap/spend'), 'midnight/zswap/spend', 1n);
        return {};
      },
    };
    const proveFirst = new ProveFirst({
      proofProvider: {
        provingProvider: () => ({
          check: async () => [],
          prove: async () => Uint8Array.of(1),
          lookupKey: async () => undefined,
        }),
      },
      circuits: new Set<string>(CLIENT_PROVEN_CIRCUITS),
      log: silentLog(),
      ledger: { ...t.L, deserializeUnproven: () => none },
    });
    await expect(proveFirst.capture(none)).rejects.toThrow();
  });
});

// ── the rig: a queue, a desk, prove first, and the REAL executors ──────────────

/** The sponsor wallet with its real one-at-a-time lock; counts who holds it. */
class TestSponsor extends ExclusiveSponsorSession {
  holding = 0;
  holds = 0;
  constructor(private readonly handle: SponsorWalletHandle) {
    super();
  }
  async start() {}
  async stop() {}
  status() {
    return { configured: true, state: 'synced' as const, synced: true, dustSpecks: 10n ** 20n };
  }
  protected wallet() {
    return this.handle;
  }
  override withWallet<T>(fn: (w: unknown) => Promise<T>): Promise<T> {
    return super.withWallet(async (w) => {
      this.holding++;
      this.holds++;
      try {
        return await fn(w);
      } finally {
        this.holding--;
      }
    });
  }
}

/** A sponsor wallet handle: balances by wrapping, submits (or fails with the next queued error). */
function fakeWallet(errors: Error[]) {
  const submitted: { name: string; proof: Uint8Array }[] = [];
  const revert = vi.fn(async () => undefined);
  const submitTransaction = vi.fn(async (tx: unknown) => {
    const e = errors.shift();
    if (e) throw e;
    const proven = (tx as { balanced: { name: string; proof: Uint8Array } }).balanced;
    submitted.push({ name: proven.name, proof: proven.proof });
    return `tx-${submitted.length}`;
  });
  const handle = {
    wallet: {
      state: () =>
        of({
          isSynced: true,
          shielded: {
            coinPublicKey: { toHexString: () => 'c0'.repeat(32) },
            encryptionPublicKey: { toHexString: () => 'e0'.repeat(32) },
          },
        }),
      balanceUnboundTransaction: async (tx: unknown) => ({ recipe: tx }),
      signRecipe: async (r: unknown) => r,
      finalizeRecipe: async (r: unknown) => ({ balanced: (r as { recipe: unknown }).recipe }),
      submitTransaction,
      revertTransaction: revert,
    },
    shieldedSecretKeys: {},
    dustSecretKey: {},
    unshieldedKeystore: {
      signDataAsync: async () => 'sig',
      getBech32Address: () => ({ asString: () => 'mn_addr_undeployed1sponsor' }),
    },
  } as unknown as SponsorWalletHandle;
  return { handle, submitted, revert, submitTransaction };
}

async function rig(
  over: {
    verdict?: () => Promise<ClientProofVerdict>;
    timeoutSeconds?: number;
    real?: boolean;
    submitErrors?: Error[];
  } = {},
) {
  const root = tempRoot();
  makeVolume(root);
  let now = 1_800_000_000;
  const timers: { at: number; fn: () => void; live: boolean }[] = [];
  const log = silentLog();
  const queue = new JobQueue({ ttlSeconds: 3600, maxJobs: 100, log, now: () => now });
  const real = over.real ? await builtInClientProofVerifier({ managedPath: root }) : null;
  const verify = vi.fn<(input: ClientProofVerifierInput) => Promise<ClientProofVerdict>>(
    real ? (input) => real.verify(input) : over.verdict ? () => over.verdict!() : async () => ({ ok: true }),
  );
  const desk = new ClientProofDesk({
    jobs: queue,
    verifier: { name: real ? real.name : 'test-double', verify },
    timeoutSeconds: over.timeoutSeconds ?? 600,
    keySet: KEY_SET,
    proofServer: '9.0.0-rc.8',
    log,
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
    clientCircuits: desk.circuits,
  });
  const fl = fakeLedger({ intentTtl: () => now + 3600 });
  const proveFirst = new ProveFirst({ proofProvider: provider, circuits: desk.circuits, log, ledger: fl.L });
  const wallet = fakeWallet(over.submitErrors ?? []);
  const sponsor = new TestSponsor(wallet.handle);
  // The account on chain: `round` and `auth_nonce` move when something lands.
  const chain = { round: 5n, authNonce: 2n, reads: 0 };
  const signer = callSigner();
  const live = new Set([testDeviceEntry(ACCOUNT, signer.deviceKey, 0n, 0n)]);
  const ledgerOf = () => ({
    round: chain.round,
    auth_nonce: chain.authNonce,
    booted: true,
    device_count: 1n,
    device_epoch: 0n,
    inbox_count: 0n,
    enc_key: new Uint8Array(32),
    evm_domain_salt: new Uint8Array(32),
    devices: {
      member: (e: Uint8Array) => live.has(hex(e)),
      [Symbol.iterator]: () => [...live].map((x) => Uint8Array.from(Buffer.from(x, 'hex')))[Symbol.iterator](),
    },
    inbox: { member: () => false, lookup: () => new Uint8Array(192) },
  });
  // The REAL runtime's methods (providers, keysOnlyProviders, ledgerState) over stand-in providers.
  const watched: string[] = [];
  const rt = Object.assign(Object.create(PassportRuntime.prototype) as object, {
    options: { txTtlMs: 60_000, log, managedPath: root },
    shared: {
      publicDataProvider: {
        queryContractState: async (a: string) => {
          chain.reads++;
          return a === ACCOUNT ? { data: 'state' } : null;
        },
        watchForTxData: async (id: string) => {
          watched.push(id);
          return { status: 'SucceedEntirely', txId: id };
        },
      },
      zkConfigProvider: {},
      proofProvider: provider,
    },
    client: {
      contract: { ledger: () => ledgerOf() },
      witnesses: { withCoin: (_s: unknown, c: unknown) => ({ coin: c }), emptyCoinStore: () => ({}) },
      account: { CustodyAccount: { connect: async () => ({ privateStateId: 'ps-1' }) } },
    },
    compiledAccount: () => ({ compiled: true }),
  }) as unknown as PassportRuntime;
  const cp = new ClientProving({
    desk,
    proveFirst,
    sponsor,
    readState: async (a) => {
      const l = await rt.ledgerState(a);
      return l ? { round: l.round, auth_nonce: l.auth_nonce } : null;
    },
    log,
  });
  /** What a build saw: the providers hold only the sponsor's public keys (balancing throws). */
  const builds: { coinPublicKey: string; balance: unknown; options: Record<string, unknown> }[] = [];
  const buildCallFor =
    (name: VectorName): NonNullable<AccountActionDeps['buildCall']> =>
    async (providers, options) => {
      const w = (
        providers as { walletProvider: { getCoinPublicKey(): string; balanceTx(t: unknown): Promise<unknown> } }
      ).walletProvider;
      builds.push({
        coinPublicKey: w.getCoinPublicKey(),
        balance: await w.balanceTx({}).then(
          () => 'balanced!',
          (e: unknown) => String(e),
        ),
        options,
      });
      return {
        private: {
          unprovenTx: fl.unproven(name),
          result: {
            is_some: true,
            value: { nonce: new Uint8Array(32), color: new Uint8Array(32).fill(0xa1), value: 5n },
          },
        },
      };
    };
  const replay = new DigestReplayGuard(3600, () => now);
  const accountDeps = (name: VectorName = 'withdraw', extra: Partial<AccountActionDeps> = {}): AccountActionDeps => ({
    runtime: () => rt,
    arm: testArm,
    sponsor,
    network: 'undeployed',
    replay,
    entitlements: testEntitlements(),
    log,
    clientProving: cp,
    buildCall: buildCallFor(name),
    dustRetryDelayMs: 1,
    ...extra,
  });
  const withdrawPayload = () => ({
    recipient: 'ab'.repeat(32),
    recipientEncryptionKey: 'cd'.repeat(32),
    color: 'a1'.repeat(32),
    amount: '5',
    coin: { nonce: '33'.repeat(32), color: 'a1'.repeat(32), value: '10', mtIndex: '9' },
    authNonce: String(chain.authNonce),
  });
  /** A signed withdrawal as the route queues it (the same body can be sent again). */
  const signedWithdrawal = (payload = withdrawPayload()) => ({
    raw: {
      ...payload,
      account: ACCOUNT,
      passportAuth: signer.passportAuth('withdraw', ACCOUNT, payload),
      signer: signer.deviceKey,
    },
    digest: hex(testCallMessage('withdraw', ACCOUNT, payload)),
  });
  const failures = new FailureBudget({ perOwner: 5, perAccount: 5 });
  /** Queue a withdrawal on its account's lane (as `required` does), with the failure budget. */
  const submitWithdrawal = (body = signedWithdrawal(), name: VectorName = 'withdraw') =>
    queue.submit({
      action: 'withdraw',
      lane: 'account',
      account: ACCOUNT,
      payload: body.raw,
      executor: guarded(withdrawExecutor(accountDeps(name)), {
        action: 'withdraw',
        owner: signer.deviceKey,
        account: ACCOUNT,
        failures,
      }),
    })!;
  /** Move the clock; the ticket timers that are due fire unless `fire` is false. */
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
  const getRequest = (id: string, app = h.app) => app.request(API_PATHS.clientProof(id));
  const postProof = (id: string, body: unknown, type = 'application/json', app = h.app) =>
    app.request(API_PATHS.clientProof(id), {
      method: 'POST',
      headers: { 'content-type': type },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  const awaitTicket = async (id: string) => {
    await vi.waitFor(() => expect(view(id).clientProof).toBeDefined(), { timeout: 5000, interval: 2 });
    return view(id).clientProof!;
  };
  const code = async (res: Response) => [res.status, ((await res.json()) as { error: { code: string } }).error.code];
  return {
    queue,
    desk,
    verify,
    h,
    server,
    provider,
    proveFirst,
    ledgerState: fl.state,
    unproven: fl.unproven,
    wallet,
    sponsor,
    chain,
    signer,
    rt,
    cp,
    builds,
    replay,
    failures,
    watched,
    accountDeps,
    signedWithdrawal,
    submitWithdrawal,
    withdrawPayload,
    advance,
    view,
    stages,
    getRequest,
    postProof,
    awaitTicket,
    code,
    log,
    now: () => now,
  };
}
type Rig = Awaited<ReturnType<typeof rig>>;
const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');

// ── P3.6: the ticket, end to end through the queue, the routes and the REAL withdraw executor ─

describe('prove first, a sponsored action (the real withdraw executor)', () => {
  it('prepares, parks, takes one proof, checks it and the account, then finalizes and submits', async () => {
    const r = await rig();
    const job = r.submitWithdrawal();
    const open = await r.awaitTicket(job.requestId);
    expect(open).toMatchObject({ circuit: 'withdraw_shielded_with_ed25519', attempt: 1, fetched: false });
    expect(open.deadline).toBe(r.now() + 600);
    expect(r.view(job.requestId).state).toBe('running');
    expect(JobViewSchema.parse(r.view(job.requestId)).clientProof).toEqual(open);
    // Prepare built the call with the sponsor's PUBLIC keys only: balancing through them throws.
    expect(r.builds).toHaveLength(1);
    expect(r.builds[0]!.coinPublicKey).toBe('c0'.repeat(32));
    expect(r.builds[0]!.balance).toMatch(/balanced and submitted at finalize/);
    expect(r.builds[0]!.options).toMatchObject({
      circuitId: 'withdraw_shielded_with_ed25519',
      contractAddress: ACCOUNT,
    });
    expect((r.builds[0]!.options.additionalCoinEncPublicKeyMappings as Map<string, string>).get('ab'.repeat(32))).toBe(
      'cd'.repeat(32),
    );
    // Nothing was proven: the proof server saw only the capture's /check.
    expect(r.server.calls).toEqual(['/check']);

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
    expect(sha256(Buffer.from(body.proofRequest, 'base64'))).toBe(sha256(VECTORS.withdraw().request));
    expect(r.view(job.requestId).clientProof?.fetched).toBe(true);

    const proof = REAL_PROOFS.withdraw();
    const posted = await r.postProof(job.requestId, { proofId: open.proofId, proof: b64(proof) });
    expect(posted.status).toBe(200);
    const answer = (await posted.json()) as { job: JobView };
    expect(answer.job.stage).toBe('client-proof-checked');
    expect(answer.job.state).toBe('running');
    expect(answer.job.clientProof).toBeUndefined();
    expect(r.verify).toHaveBeenCalledTimes(1);
    const input = r.verify.mock.calls[0]![0];
    expect(input.circuit).toBe('withdraw_shielded_with_ed25519');
    expect(sha256(input.proofRequest)).toBe(sha256(VECTORS.withdraw().request));
    expect(sha256(input.proof)).toBe(sha256(proof));
    expect(sha256(input.verifierKey)).toBe('0af6b9754da02f4b9dd919e5127de96b7d8a44ff318f23b3f4ed6429ad21ed91');

    const done = await r.queue.settled(job.requestId);
    expect(done?.state, JSON.stringify(done?.error)).toBe('succeeded');
    expect(done?.result).toMatchObject({ txId: 'tx-1', change: { value: '5' } });
    // Submitted once, with exactly the user's proof in its k≥18 call; balanced under the wallet.
    expect(r.wallet.submitted.map((s) => sha256(s.proof))).toEqual([sha256(proof)]);
    expect(r.watched).toEqual(['tx-1']);
    expect(r.sponsor.holds).toBe(2); // the public keys, read once; then balance + submit
    // Finalize proved only the builtins on the server.
    expect(r.server.calls).toEqual(['/check', '/check', '/prove', '/prove']);
    const s = r.stages(job.requestId);
    const order = CLIENT_PROOF_STAGES.map((x) => s.indexOf(x));
    expect(order.every((i, k) => i >= 0 && (k === 0 || i > order[k - 1]!))).toBe(true);
    expect(s.indexOf('proving')).toBeGreaterThan(s.indexOf('client-proof-checked'));
    expect(s[s.length - 2]).toBe('submitted');
    // The request is gone once the ticket ended.
    expect((await r.getRequest(job.requestId)).status).toBe(409);
  });

  it('holds NOTHING while it waits: another user opens an account and claims demo tokens meanwhile', async () => {
    const r = await rig();
    // The sponsor's public keys are read once, the first time (milliseconds); later prepares hold nothing.
    await r.cp.sponsorPublic();
    const holdsBefore = r.sponsor.holds;
    const job = r.submitWithdrawal();
    const open = await r.awaitTicket(job.requestId);
    expect(r.sponsor.holds).toBe(holdsBefore);
    // Parked: no prover lane, no sponsor wallet; only its account's slot.
    expect(r.queue.stats().lanes.prover).toEqual({ running: 0, waiting: 0 });
    expect(r.sponsor.holding).toBe(0);
    expect(r.queue.laneLoad('account', ACCOUNT)).toEqual({ running: 1, waiting: 0 });
    // Another user's account opening and demo tokens: each takes the prover lane AND the sponsor wallet.
    const other = (action: 'register' | 'demo-tokens') =>
      r.queue.submit({
        action,
        lane: 'prover',
        payload: {},
        executor: async (_p, ctx) => ctx.prove(() => r.sponsor.withWallet(async () => ({ ok: action }))),
      })!;
    const register = other('register');
    const demo = other('demo-tokens');
    expect((await r.queue.settled(register.requestId))?.state).toBe('succeeded');
    expect((await r.queue.settled(demo.requestId))?.state).toBe('succeeded');
    // The withdrawal still waits for its proof, untouched.
    expect(r.view(job.requestId).state).toBe('running');
    expect(r.view(job.requestId).clientProof?.proofId).toBe(open.proofId);
    // The same account's next request waits for the account's slot (the route's gate refuses it first).
    const next = r.queue.submit({
      action: 'append-inbox',
      lane: 'account',
      account: ACCOUNT,
      payload: {},
      executor: async () => ({ next: true }),
    })!;
    expect(r.queue.laneLoad('account', ACCOUNT)).toEqual({ running: 1, waiting: 1 });
    const posted = await r.postProof(job.requestId, { proofId: open.proofId, proof: b64(GOLDEN_PROOF()) });
    expect(posted.status).toBe(200);
    expect((await r.queue.settled(job.requestId))?.state).toBe('succeeded');
    expect((await r.queue.settled(next.requestId))?.state).toBe('succeeded');
  });

  it('takes exactly one proof: a second one, or one for another id, is refused', async () => {
    const r = await rig({ verdict: () => new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 20)) });
    const job = r.submitWithdrawal();
    const open = await r.awaitTicket(job.requestId);
    const proof = b64(GOLDEN_PROOF());
    expect(await r.code(await r.postProof(job.requestId, { proofId: 'f'.repeat(32), proof }))).toEqual([
      409,
      'client-proof-wrong-id',
    ]);
    // Two posts at once: the first holds the ticket while it is checked, the second is refused.
    const [a, b] = await Promise.all([
      r.postProof(job.requestId, { proofId: open.proofId, proof }),
      r.postProof(job.requestId, { proofId: open.proofId, proof }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(((await (a.status === 409 ? a : b).json()) as { error: { code: string } }).error.code).toBe(
      'client-proof-already-received',
    );
    await r.queue.settled(job.requestId);
    expect((await r.postProof(job.requestId, { proofId: open.proofId, proof })).status).toBe(409);
    expect(r.verify).toHaveBeenCalledTimes(1);
  });

  it('an invalid proof (the test-double verifier says no): client-proof-invalid, charged, nothing submitted', async () => {
    const r = await rig({ verdict: async () => ({ ok: false, reason: 'pairing check failed' }) });
    const job = r.submitWithdrawal();
    const open = await r.awaitTicket(job.requestId);
    await r.getRequest(job.requestId);
    const res = await r.postProof(job.requestId, { proofId: open.proofId, proof: b64(GOLDEN_PROOF()) });
    expect(await r.code(res)).toEqual([422, 'client-proof-invalid']);
    const done = await r.queue.settled(job.requestId);
    expect(done?.state).toBe('failed');
    expect(done?.error?.code).toBe('client-proof-invalid');
    expect(done?.error?.message).toMatch(/your proof server returned an invalid proof/);
    expect(r.wallet.submitted).toEqual([]);
    expect(r.server.calls).toEqual(['/check']);
    expect(r.sponsor.holding).toBe(0);
    // The requester's failure, never the market's, though the relay's prover was never used.
    expect(r.failures.failures(OWNER_KEY(r.signer))).toBe(1);
    for (const c of ['client-proof-invalid', 'client-proof-missing', 'client-proof-late']) {
      expect(countsAgainstBudget(new PublicError(c, 'x'), false)).toBe(true);
      expect(countsAgainstBudget(new PublicError(c, 'x'), true)).toBe(true);
    }
  });

  it('refuses a proof that is not a proof (wrong tag, too large) as invalid, without calling the verifier', async () => {
    for (const bad of [
      Buffer.from('not a proof at all'),
      Buffer.concat([Buffer.from(PROOF_TAG), randomBytes(64 * 1024)]),
    ]) {
      const r = await rig();
      const job = r.submitWithdrawal();
      const open = await r.awaitTicket(job.requestId);
      const res = await r.postProof(job.requestId, { proofId: open.proofId, proof: bad.toString('base64') });
      expect(res.status).toBe(422);
      expect((await r.queue.settled(job.requestId))?.error?.code).toBe('client-proof-invalid');
      expect(r.verify).not.toHaveBeenCalled();
      expect(r.wallet.submitted).toEqual([]);
    }
  });

  it('a request never fetched before its deadline fails client-proof-missing; nothing is submitted', async () => {
    const r = await rig({ timeoutSeconds: 120 });
    const job = r.submitWithdrawal();
    const open = await r.awaitTicket(job.requestId);
    expect(open.deadline).toBe(r.now() + 120);
    r.advance(119);
    expect(r.view(job.requestId).clientProof).toBeDefined();
    r.advance(1);
    const done = await r.queue.settled(job.requestId);
    expect(done?.error?.code).toBe('client-proof-missing');
    expect(done?.clientProof).toBeUndefined();
    expect(r.wallet.submitted).toEqual([]);
    expect(r.server.calls).toEqual(['/check']);
    const late = await r.postProof(job.requestId, { proofId: open.proofId, proof: b64(GOLDEN_PROOF()) });
    expect(late.status).toBe(410);
    expect(r.verify).not.toHaveBeenCalled();
    expect(r.failures.failures(OWNER_KEY(r.signer))).toBe(1);
  });

  it('a fetched request whose proof misses the deadline fails client-proof-late; a late proof is refused', async () => {
    const r = await rig();
    const job = r.submitWithdrawal();
    const open = await r.awaitTicket(job.requestId);
    expect((await r.getRequest(job.requestId)).status).toBe(200);
    r.advance(600);
    expect((await r.queue.settled(job.requestId))?.error?.code).toBe('client-proof-late');
    const late = await r.postProof(job.requestId, { proofId: open.proofId, proof: b64(GOLDEN_PROOF()) });
    expect(await r.code(late)).toEqual([410, 'client-proof-late']);
    expect(r.wallet.submitted).toEqual([]);
  });

  it('a proof posted at the deadline, before the timer fires, is late too', async () => {
    const r = await rig();
    const job = r.submitWithdrawal();
    const open = await r.awaitTicket(job.requestId);
    await r.getRequest(job.requestId);
    r.advance(600, false);
    const res = await r.postProof(job.requestId, { proofId: open.proofId, proof: b64(GOLDEN_PROOF()) });
    expect(res.status).toBe(410);
    expect((await r.queue.settled(job.requestId))?.error?.code).toBe('client-proof-late');
    expect(r.wallet.submitted).toEqual([]);
  });
});

describe('stale calls (I-62a v2: `round` and `auth_nonce` read at finalize)', () => {
  it('a deposit lands between prepare and finalize: 409 client-proof-stale, nothing submitted, not charged', async () => {
    const r = await rig();
    const body = r.signedWithdrawal();
    expect(r.replay.claim(body.digest)).toBe(true); // the route's passport-call authoriser claims it
    const job = r.submitWithdrawal(body);
    const open = await r.awaitTicket(job.requestId);
    // A third party's deposit into the account: its `round` moves (5 → 6), `auth_nonce` does not.
    r.chain.round = 6n;
    const res = await r.postProof(job.requestId, { proofId: open.proofId, proof: b64(GOLDEN_PROOF()) });
    const [status, codeOf] = await r.code(res);
    expect([status, codeOf]).toEqual([409, 'client-proof-stale']);
    const done = await r.queue.settled(job.requestId);
    expect(done?.error?.code).toBe('client-proof-stale');
    expect(done?.error?.message).toMatch(/your account changed while your proof server was proving/);
    // Nothing was finalized, balanced or submitted; the sponsor and the prover lane were never taken.
    expect(r.wallet.submitted).toEqual([]);
    expect(r.server.calls).toEqual(['/check']);
    expect(r.sponsor.holding).toBe(0);
    expect(r.failures.failures(OWNER_KEY(r.signer))).toBe(0);
    expect(countsAgainstBudget(new PublicError('client-proof-stale', 'x'), true)).toBe(false);
    // The replay guard was given back: the SAME signed request goes through when sent again.
    expect(r.replay.claim(body.digest)).toBe(true);
    const again = r.submitWithdrawal(body);
    const second = await r.awaitTicket(again.requestId);
    expect(second.proofId).not.toBe(open.proofId);
    expect((await r.postProof(again.requestId, { proofId: second.proofId, proof: b64(GOLDEN_PROOF()) })).status).toBe(
      200,
    );
    expect((await r.queue.settled(again.requestId))?.state).toBe('succeeded');
    expect(r.wallet.submitted).toHaveLength(1);
  });

  it('another approval landed (auth_nonce moved): stale; sent again it is stale-authorisation (sign again)', async () => {
    const r = await rig();
    const body = r.signedWithdrawal();
    const job = r.submitWithdrawal(body);
    const open = await r.awaitTicket(job.requestId);
    r.chain.authNonce = 3n;
    r.chain.round = 6n;
    expect(
      await r.code(await r.postProof(job.requestId, { proofId: open.proofId, proof: b64(GOLDEN_PROOF()) })),
    ).toEqual([409, 'client-proof-stale']);
    expect((await r.queue.settled(job.requestId))?.error?.code).toBe('client-proof-stale');
    const again = r.submitWithdrawal(body);
    expect((await r.queue.settled(again.requestId))?.error?.code).toBe('stale-authorisation');
    expect(r.wallet.submitted).toEqual([]);
  });

  it('the account moves after the proof was accepted, while finalize waits for the prover lane: stale, nothing submitted', async () => {
    const r = await rig();
    const job = r.submitWithdrawal();
    const open = await r.awaitTicket(job.requestId);
    // Another job holds the prover lane.
    let release!: () => void;
    const blocker = r.queue.submit({
      action: 'register',
      lane: 'prover',
      payload: {},
      executor: () => new Promise((resolve) => (release = () => resolve({}))),
    })!;
    await vi.waitFor(() => expect(r.queue.stats().lanes.prover.running).toBe(1));
    expect((await r.postProof(job.requestId, { proofId: open.proofId, proof: b64(GOLDEN_PROOF()) })).status).toBe(200);
    await vi.waitFor(() => expect(r.stages(job.requestId)).toContain('waiting-for-prover'));
    r.chain.round = 6n; // demo tokens land meanwhile
    release();
    await r.queue.settled(blocker.requestId);
    const done = await r.queue.settled(job.requestId);
    expect(done?.error?.code).toBe('client-proof-stale');
    expect(r.wallet.submitted).toEqual([]);
    expect(r.wallet.submitTransaction).not.toHaveBeenCalled();
    expect(r.failures.failures(OWNER_KEY(r.signer))).toBe(0);
  });

  it('the node refusing a stale call (code 104, ReadMismatch) ends client-proof-stale: never a DUST race, the spend reverted', async () => {
    const r = await rig({ submitErrors: [nodeRejection(104)] });
    const job = r.submitWithdrawal();
    const open = await r.awaitTicket(job.requestId);
    expect((await r.postProof(job.requestId, { proofId: open.proofId, proof: b64(GOLDEN_PROOF()) })).status).toBe(200);
    const done = await r.queue.settled(job.requestId);
    expect(done?.error?.code).toBe('client-proof-stale');
    expect(r.wallet.submitTransaction).toHaveBeenCalledTimes(1); // not retried
    expect(r.wallet.revert).toHaveBeenCalledTimes(1);
    expect(r.wallet.submitted).toEqual([]);
    expect(done?.stages.filter((s) => s.stage === 'awaiting-client-proof')).toHaveLength(1);
    expect(r.failures.failures(OWNER_KEY(r.signer))).toBe(0);
  });

  it('tells a stale refusal (104) and a proof refusal (115/179) from the other node refusals and from a DUST race', () => {
    expect(isStaleRefusal(nodeRejection(104))).toBe(true);
    expect(
      isStaleRefusal(
        new Error('guaranteed execution would fail: Transcript(Execution(ReadMismatch { expected: <[05]: b8> }))'),
      ),
    ).toBe(true);
    for (const other of [115, 179, 196, 117, 138, 1040, 10]) expect(isStaleRefusal(nodeRejection(other))).toBe(false);
    expect(isProofRefusal(nodeRejection(115))).toBe(true);
    expect(isProofRefusal(nodeRejection(179))).toBe(true);
    for (const other of [104, 196, 117, 138, 231, 235, 1150, 11])
      expect(isProofRefusal(nodeRejection(other))).toBe(false);
    expect(isProofRefusal(new Error('fetch failed'))).toBe(false);
    // A DUST race is any other submission refusal; the desk's own verdicts never are.
    expect(isDustRace(nodeRejection(196))).toBe(true);
    expect(isDustRace(new Error('DustDoubleSpend'))).toBe(true);
    for (const c of ['client-proof-stale', 'client-proof-invalid'])
      expect(isDustRace(new PublicError(c, 'x'))).toBe(false);
  });

  it('the failures cannot match Passport’s DUST-race retry, as thrown or as midnight-js wraps them', () => {
    const retry = passportRetryPattern();
    // Today's node rejection DOES match (so Passport would rebuild a stale call three more times).
    expect(retry.test(String(nodeRejection(104)))).toBe(true);
    // Every message the desk can end a job with (read from its source, so a new one is covered too).
    const desk = readFileSync(join(SRC, 'client-proving', 'desk.ts'), 'utf8');
    const block = /const MESSAGES = \{([\s\S]*?)\} as const;/.exec(desk)![1]!;
    const messages = [...block.matchAll(/'([^']+)'|"([^"]+)"/g)].map((m) => m[1] ?? m[2]!);
    expect(messages.length).toBeGreaterThanOrEqual(8);
    for (const m of messages) {
      const e = new PublicError('client-proof-stale', m);
      expect(retry.test(e.message)).toBe(false);
      expect(retry.test(`Unexpected error submitting scoped transaction 'withdraw': ${String(e)}`)).toBe(false);
      // Nor Passport's offer builder's placement words (a make's error must stay the desk's).
      expect(/segment|imbalance|artefact|DUST/i.test(m), m).toBe(false);
    }
  });
});

describe('DUST races and refused proofs at finalize', () => {
  it('a DUST race re-balances with the SAME proof: one ticket, one check, finalized twice, submitted once', async () => {
    const r = await rig({ submitErrors: [nodeRejection(196)] });
    const job = r.submitWithdrawal();
    const open = await r.awaitTicket(job.requestId);
    const proof = REAL_PROOFS.withdraw();
    expect((await r.postProof(job.requestId, { proofId: open.proofId, proof: b64(proof) })).status).toBe(200);
    const done = await r.queue.settled(job.requestId);
    expect(done?.state, JSON.stringify(done?.error)).toBe('succeeded');
    expect(r.verify).toHaveBeenCalledTimes(1);
    expect(done?.stages.filter((s) => s.stage === 'awaiting-client-proof')).toHaveLength(1);
    expect(r.wallet.submitTransaction).toHaveBeenCalledTimes(2);
    expect(r.wallet.submitted.map((s) => sha256(s.proof))).toEqual([sha256(proof)]);
    expect(r.wallet.revert).not.toHaveBeenCalled(); // a DUST race is the wallet's own, not a refused proof
    // Captured once, finalized twice (the builtins proven again); the user proved once.
    expect(r.server.calls).toEqual(['/check', '/check', '/prove', '/prove', '/check', '/prove', '/prove']);
    expect(r.ledgerState.deserialized).toBe(3);
  });

  it('a proof the network refuses as invalid ends client-proof-invalid: no retry, the spend reverted, charged', async () => {
    for (const c of [115, 179]) {
      const r = await rig({ submitErrors: [nodeRejection(c)] });
      const job = r.submitWithdrawal();
      const open = await r.awaitTicket(job.requestId);
      expect((await r.postProof(job.requestId, { proofId: open.proofId, proof: b64(GOLDEN_PROOF()) })).status).toBe(
        200,
      );
      const done = await r.queue.settled(job.requestId);
      expect(done?.error?.code).toBe('client-proof-invalid');
      expect(done?.error?.message).toMatch(/the network refused the proof/);
      expect(r.wallet.submitTransaction).toHaveBeenCalledTimes(1);
      expect(r.wallet.revert).toHaveBeenCalledTimes(1);
      expect(r.failures.failures(OWNER_KEY(r.signer))).toBe(1);
    }
  });
});

describe('the other sponsored actions', () => {
  it('append-inbox parks and finalizes the same way (with its entitlement)', async () => {
    const r = await rig();
    const entitlements = testEntitlements();
    const entitlement = entitlements.issue(ACCOUNT, 'withdraw:tx-0');
    const payload = { entry: '77'.repeat(192), authNonce: '2', entitlement };
    const job = r.queue.submit({
      action: 'append-inbox',
      lane: 'account',
      account: ACCOUNT,
      payload: {
        ...payload,
        account: ACCOUNT,
        passportAuth: r.signer.passportAuth('append-inbox', ACCOUNT, payload),
        signer: r.signer.deviceKey,
      },
      executor: appendInboxExecutor(r.accountDeps('withdraw', { entitlements })),
    })!;
    const open = await r.awaitTicket(job.requestId);
    expect(r.builds[0]!.options).toMatchObject({ circuitId: 'append_inbox_with_ed25519' });
    expect(r.builds[0]!.options).not.toHaveProperty('additionalCoinEncPublicKeyMappings');
    expect((await r.postProof(job.requestId, { proofId: open.proofId, proof: b64(GOLDEN_PROOF()) })).status).toBe(200);
    expect((await r.queue.settled(job.requestId))?.result).toEqual({ txId: 'tx-1' });
  });
});

// ── P3.6: makes and takes (the real trade executors) ───────────────────────────

const BASE = 'a1'.repeat(32);
const QUOTE = 'b2'.repeat(32);
const OFFER_ID = 'cd'.repeat(32);

/** A FakeTx that also answers the ledger's cost questions. */
function costly(tx: FakeTx): FakeTx {
  return Object.assign(tx, {
    cost: () => ({ readTime: 1n, computeTime: 2n, blockUsage: 3n }),
    fees: () => 42n,
    serialize: () => new Uint8Array([1, 2, 3]),
    merge(other: FakeTx) {
      return costly(Object.getPrototypeOf(tx).merge.call(tx, other) as FakeTx);
    },
  });
}

function proven(tx: FakeTx, id = 'ef'.repeat(32)): ProvenAccountOffer {
  return {
    tx: tx as never,
    bytes: new Uint8Array(30),
    blob: 'swapoffer1fake',
    offerId: id,
    proveMs: 25_000,
    structure: describeTx(tx),
    steering: null,
    expiresAt: 1_800_000_600_000,
  };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function tradeRig(r: Rig, o: { kernelStatus?: () => string } = {}) {
  const calls: { url: string; method: string }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, method: init?.method ?? 'GET' });
    if (u.startsWith('http://batcher.test')) return json(200, { success: true, transactionHash: 'aa'.repeat(32) });
    if (init?.method === 'POST' && u.endsWith('/v1/offers'))
      return json(200, { success: true, offerId: 'ef'.repeat(32) });
    if (u.endsWith('/status')) return json(200, { offerId: u.split('/').at(-2), status: o.kernelStatus?.() ?? 'live' });
    if (u.endsWith(`/v1/offers/${OFFER_ID}`))
      return json(200, {
        offerId: OFFER_ID,
        offerBech32: encodeOffer(new Uint8Array([9, 9, 9])),
        computed: { gives: [], wants: [], status: o.kernelStatus?.() ?? 'live' },
      });
    return json(404, {});
  }) as unknown as typeof fetch;
  /** Upstream's offer builder, standing in: build (here: the vector's stand-in call), then `proveTx`. */
  const proveWith = (name: VectorName, tx: FakeTx) =>
    vi.fn(async (args: { providers: { proofProvider: unknown } }) => {
      const out = (await (args.providers.proofProvider as { proveTx(t: unknown): Promise<unknown> }).proveTx(
        r.unproven(name),
      )) as { name: string; proof: Uint8Array };
      expect(out.name).toBe(name);
      return { ...proven(tx), injected: out.proof };
    });
  const deps = (extra: Partial<TradeDeps>): TradeDeps => ({
    runtime: () => r.rt,
    arm: testArm,
    sponsor: r.sponsor,
    kernelUrl: 'http://kernel.test',
    batcherUrl: 'http://batcher.test',
    batcherTarget: 'midnight-balancer',
    replay: r.replay,
    log: r.log,
    fetchImpl,
    timings: { publishRetryMs: 1, statusPollMs: 1, statusTimeoutMs: 50 },
    now: r.now,
    clientProving: r.cp,
    ...extra,
  });
  const payload = (validUntil: number): OpenSwapPayload => ({
    giveColor: BASE,
    giveAmount: '2000000',
    wantColor: QUOTE,
    wantAmount: '2100000',
    wantNonce: '11'.repeat(32),
    wantEntry: '22'.repeat(192),
    changeEntry: '00'.repeat(192),
    validUntil: String(validUntil),
    coin: { nonce: '33'.repeat(32), color: BASE, value: '3000000', mtIndex: '9' },
    authNonce: '2',
  });
  const takePayload = (validUntil: number): TakePayload => ({
    ...payload(validUntil),
    giveColor: QUOTE,
    giveAmount: '2100000',
    wantColor: BASE,
    wantAmount: '2000000',
    coin: { nonce: '44'.repeat(32), color: QUOTE, value: '4000000', mtIndex: '12' },
    offerId: OFFER_ID,
  });
  const submit = (action: 'open-swap' | 'take', p: OpenSwapPayload, executor: JobExecutor) =>
    r.queue.submit({
      action,
      lane: 'account',
      account: ACCOUNT,
      payload: {
        ...p,
        account: ACCOUNT,
        passportAuth: r.signer.passportAuth(action, ACCOUNT, p as unknown as Record<string, unknown>),
        signer: r.signer.deviceKey,
      },
      executor,
    })!;
  return { calls, proveWith, deps, payload, takePayload, submit };
}

describe('prove first, a make and a take (the real trade executors)', () => {
  it('a make parks (deadline: the signed expiry minus 60 s), then is finalized, checked fresh and listed', async () => {
    const r = await rig({ real: true });
    const t = tradeRig(r);
    const prove = t.proveWith('maker', accountOffer(4711, 0, BASE, 2_000_000n, QUOTE, 2_100_000n));
    const job = t.submit('open-swap', t.payload(r.now() + 400), openSwapExecutor(t.deps({ prove })));
    const open = await r.awaitTicket(job.requestId);
    expect(open.circuit).toBe('open_swap_shielded_with_ed25519');
    expect(open.deadline).toBe(r.now() + 340);
    expect(r.queue.stats().lanes.prover.running).toBe(0);
    expect(r.sponsor.holding).toBe(0);
    expect(t.calls.filter((c) => c.method === 'POST')).toEqual([]);
    // The real verifier checks the maker's node-accepted golden proof.
    const res = await r.postProof(job.requestId, { proofId: open.proofId, proof: b64(REAL_PROOFS.maker()) });
    expect(res.status).toBe(200);
    expect(await r.verify.mock.results[0]!.value).toEqual({ ok: true });
    const done = await r.queue.settled(job.requestId);
    expect(done?.state, JSON.stringify(done?.error)).toBe('succeeded');
    expect(done?.result).toMatchObject({ offerId: 'ef'.repeat(32), kernel: { accepted: true, status: 'live' } });
    expect(sha256((await prove.mock.results[0]!.value).injected)).toBe(sha256(REAL_PROOFS.maker()));
    const s = r.stages(job.requestId);
    expect(s.indexOf('posted')).toBeGreaterThan(s.indexOf('client-proof-checked'));
    expect(r.wallet.submitTransaction).not.toHaveBeenCalled(); // a make is never balanced or submitted
  });

  it('a make whose account moved after its proof was accepted is not listed: client-proof-stale', async () => {
    const r = await rig();
    const t = tradeRig(r);
    const prove = vi.fn(async (args: { providers: { proofProvider: unknown } }) => {
      await (args.providers.proofProvider as { proveTx(t: unknown): Promise<unknown> }).proveTx(r.unproven('maker'));
      r.chain.round = 6n; // a deposit lands while the make is being finalized
      return proven(accountOffer(4711, 0, BASE, 2_000_000n, QUOTE, 2_100_000n));
    });
    const job = t.submit('open-swap', t.payload(r.now() + 400), openSwapExecutor(t.deps({ prove })));
    const open = await r.awaitTicket(job.requestId);
    expect((await r.postProof(job.requestId, { proofId: open.proofId, proof: b64(GOLDEN_PROOF()) })).status).toBe(200);
    expect((await r.queue.settled(job.requestId))?.error?.code).toBe('client-proof-stale');
    expect(t.calls.filter((c) => c.method === 'POST')).toEqual([]); // never posted to the exchange
  });

  it('a make with under 30 s left at prepare fails client-proof-late at once and hands nothing out', async () => {
    const r = await rig();
    const t = tradeRig(r);
    const prove = t.proveWith('maker', accountOffer(4711, 0, BASE, 2_000_000n, QUOTE, 2_100_000n));
    const job = t.submit('open-swap', t.payload(r.now() + 89), openSwapExecutor(t.deps({ prove })));
    const done = await r.queue.settled(job.requestId);
    expect(done?.error?.code).toBe('client-proof-late');
    expect(done?.stages.map((s) => s.stage)).not.toContain('awaiting-client-proof');
    expect((await r.getRequest(job.requestId)).status).toBe(409);
  });

  it('a take keeps its settle margin, holds nothing, and hands the batcher the call with the user’s proof', async () => {
    const r = await rig();
    const t = tradeRig(r);
    const maker = costly(walletOffer(BASE, 2_000_000n, QUOTE, 2_100_000n));
    const prove = t.proveWith('taker', costly(accountOffer(62921, 0, QUOTE, 2_100_000n, BASE, 2_000_000n)));
    const exec = takeExecutor(t.deps({ prove, deserialize: async () => maker, ledgerParameters: async () => ({}) }));
    const job = t.submit('take', t.takePayload(r.now() + 200), exec);
    const open = await r.awaitTicket(job.requestId);
    expect(open.deadline).toBe(r.now() + 140);
    expect(r.queue.stats().lanes.prover.running).toBe(0);
    expect(r.sponsor.holding).toBe(0);
    expect((await r.postProof(job.requestId, { proofId: open.proofId, proof: b64(GOLDEN_PROOF()) })).status).toBe(200);
    const done = await r.queue.settled(job.requestId);
    expect(done?.state, JSON.stringify(done?.error)).toBe('succeeded');
    expect(done?.result).toMatchObject({ offerId: OFFER_ID, txHash: 'aa'.repeat(32), path: 'batcher' });
    expect(t.calls.filter((c) => c.url.startsWith('http://batcher.test'))).toHaveLength(1);
    expect(r.wallet.submitTransaction).not.toHaveBeenCalled(); // the batcher pays and submits
  });

  it('a take whose maker offer is gone by the time the proof arrives: 409 client-proof-stale, no settlement', async () => {
    const r = await rig();
    let status = 'live';
    const t = tradeRig(r, { kernelStatus: () => status });
    const maker = costly(walletOffer(BASE, 2_000_000n, QUOTE, 2_100_000n));
    const prove = t.proveWith('taker', costly(accountOffer(62921, 0, QUOTE, 2_100_000n, BASE, 2_000_000n)));
    const exec = takeExecutor(t.deps({ prove, deserialize: async () => maker, ledgerParameters: async () => ({}) }));
    const job = t.submit('take', t.takePayload(r.now() + 300), exec);
    const open = await r.awaitTicket(job.requestId);
    status = 'consumed'; // another taker settled it while this one proved
    expect(
      await r.code(await r.postProof(job.requestId, { proofId: open.proofId, proof: b64(GOLDEN_PROOF()) })),
    ).toEqual([409, 'client-proof-stale']);
    expect((await r.queue.settled(job.requestId))?.error?.code).toBe('client-proof-stale');
    expect(t.calls.filter((c) => c.url.startsWith('http://batcher.test'))).toEqual([]);
  });
});

// ── P3.6: a restart drops the tickets ──────────────────────────────────────────

describe('a relay restart drops every ticket with its job', () => {
  it('the restarted relay answers both client-proof routes 404 with a clear message', async () => {
    const before = await rig();
    const job = before.submitWithdrawal();
    const open = await before.awaitTicket(job.requestId);
    // The relay restarts: a new queue, desk and app (jobs and tickets live in memory only).
    const after = await rig();
    for (const res of [
      await after.getRequest(job.requestId),
      await after.postProof(job.requestId, { proofId: open.proofId, proof: b64(GOLDEN_PROOF()) }),
    ]) {
      expect(res.status).toBe(404);
      const err = ((await res.json()) as { error: { code: string; message: string } }).error;
      expect(err.code).toBe('not-found');
      expect(err.message).toMatch(/the relay restarted \(it keeps proof requests in memory only\)/);
      expect(err.message).toMatch(/Nothing was sent for this request and no fee was spent; send the action again/);
    }
    expect((await after.h.app.request(API_PATHS.job(job.requestId))).status).toBe(404);
    expect(after.wallet.submitted).toEqual([]);
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
    const r = await rig({ timeoutSeconds: 900 });
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
      timeoutSeconds: 900,
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

  it('refuse malformed requests before touching the ticket', async () => {
    const r = await rig();
    const job = r.submitWithdrawal();
    const open = await r.awaitTicket(job.requestId);
    const proof = b64(GOLDEN_PROOF());
    expect(await r.code(await r.getRequest('zz'))).toEqual([400, 'bad-request']);
    expect(await r.code(await r.getRequest('e'.repeat(32)))).toEqual([404, 'not-found']);
    expect(await r.code(await r.postProof('zz', { proofId: open.proofId, proof }))).toEqual([400, 'bad-request']);
    expect(await r.code(await r.postProof('e'.repeat(32), { proofId: open.proofId, proof }))).toEqual([
      404,
      'not-found',
    ]);
    expect(await r.code(await r.postProof(job.requestId, 'not json'))).toEqual([400, 'bad-request']);
    expect(await r.code(await r.postProof(job.requestId, { proofId: open.proofId, proof }, 'text/plain'))).toEqual([
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
      expect(await r.code(await r.postProof(job.requestId, body))).toEqual([400, 'bad-request']);
    }
    const huge = { proofId: open.proofId, proof: 'A'.repeat(130 * 1024) };
    expect(await r.code(await r.postProof(job.requestId, huge))).toEqual([413, 'payload-too-large']);
    // None of those consumed the ticket: the real proof is still taken.
    expect(r.view(job.requestId).clientProof?.proofId).toBe(open.proofId);
    expect((await r.postProof(job.requestId, { proofId: open.proofId, proof })).status).toBe(200);
    expect((await r.queue.settled(job.requestId))?.state).toBe('succeeded');
  });

  it('non-k≥18 actions are unchanged in required mode: no ticket, no new field, proven by the relay', async () => {
    const r = await rig();
    const executor: JobExecutor = async (_p, ctx) =>
      ctx.prove(async () => {
        await r.provider.provingProvider().prove(builtin('midnight/zswap/output'), 'midnight/zswap/output', 1n);
        return { ok: true };
      });
    const job = r.queue.submit({ action: 'register', lane: 'prover', payload: {}, executor })!;
    const done = await r.queue.settled(job.requestId);
    expect(done?.state).toBe('succeeded');
    expect(done?.stages.map((s) => s.stage)).toEqual(['queued', 'running', 'succeeded']);
    expect(r.server.calls).toEqual(['/prove']);
    expect((await r.getRequest(job.requestId)).status).toBe(409);
  });

  it('a job that ends while its ticket is open abandons it; a proof posted then is ignored', async () => {
    const r = await rig();
    let fail!: (e: Error) => void;
    const executor: JobExecutor = async (_p, ctx) => {
      const parked = r.cp
        .park({
          ctx,
          action: 'withdraw',
          account: ACCOUNT,
          baseline: { round: 5n, authNonce: 2n },
          unprovenTx: r.unproven('withdraw'),
        })
        .catch(() => undefined);
      await new Promise((_resolve, reject) => (fail = reject));
      return { parked };
    };
    const job = r.queue.submit({ action: 'withdraw', lane: 'account', account: ACCOUNT, payload: {}, executor })!;
    const open = await r.awaitTicket(job.requestId);
    fail(new PublicError('chain-unavailable', 'the chain could not be read'));
    expect((await r.queue.settled(job.requestId))?.error?.code).toBe('chain-unavailable');
    const res = await r.postProof(job.requestId, { proofId: open.proofId, proof: b64(GOLDEN_PROOF()) });
    expect(res.status).toBe(410);
    expect(r.verify).not.toHaveBeenCalled();
  });
});

// ── P3.5: the ticket with the built-in verifier (the pinned WASM) ──────────────

describe('the ticket with the built-in verifier (P3.5, questions Q3 → A)', () => {
  it('a node-accepted golden proof is checked and the withdrawal completes with exactly those bytes', async () => {
    const r = await rig({ real: true });
    const job = r.submitWithdrawal();
    const open = await r.awaitTicket(job.requestId);
    await r.getRequest(job.requestId);
    const posted = await r.postProof(job.requestId, { proofId: open.proofId, proof: b64(REAL_PROOFS.withdraw()) });
    expect(posted.status).toBe(200);
    expect(((await posted.json()) as { job: JobView }).job.stage).toBe('client-proof-checked');
    expect(await r.verify.mock.results[0]!.value).toEqual({ ok: true });
    expect((await r.queue.settled(job.requestId))?.state).toBe('succeeded');
    expect(r.wallet.submitted.map((s) => sha256(s.proof))).toEqual([sha256(REAL_PROOFS.withdraw())]);
  });

  for (const [what, bad] of [
    [
      'a flipped byte',
      () => {
        const p = REAL_PROOFS.withdraw();
        p[4000] ^= 0x01;
        return p;
      },
    ],
    ['another circuit’s valid proof (a make’s, for a withdrawal)', REAL_PROOFS.maker],
  ] as [string, () => Uint8Array][]) {
    it(`${what}: client-proof-invalid, charged to the requester, nothing submitted`, async () => {
      const r = await rig({ real: true });
      const job = r.submitWithdrawal();
      const open = await r.awaitTicket(job.requestId);
      const res = await r.postProof(job.requestId, { proofId: open.proofId, proof: b64(bad()) });
      expect(await r.code(res)).toEqual([422, 'client-proof-invalid']);
      expect(((await r.verify.mock.results[0]!.value) as ClientProofVerdict).ok).toBe(false);
      expect((await r.queue.settled(job.requestId))?.error?.code).toBe('client-proof-invalid');
      expect(r.wallet.submitted).toEqual([]);
      expect(r.server.calls).toEqual(['/check']);
      expect(r.failures.failures(OWNER_KEY(r.signer))).toBe(1);
    });
  }
});

// ── P3.3: the relay never fetches a user-supplied URL ──────────────────────────

describe('no user URL is ever fetched (P3.3, spec FR-003)', () => {
  it('a whole ticket, fed URLs everywhere it takes input, makes no request at all', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    const r = await rig();
    const job = r.submitWithdrawal();
    const open = await r.awaitTicket(job.requestId);
    const url = 'http://127.0.0.1:6300/prove-circuit';
    expect(
      (await r.h.app.request(`${API_PATHS.clientProof(job.requestId)}?url=${encodeURIComponent(url)}`)).status,
    ).toBe(200);
    const withUrl = Buffer.concat([Buffer.from(PROOF_TAG), Buffer.from(` ${url} https://prover.example/`)]);
    for (const body of [
      { proofId: open.proofId, proof: b64(GOLDEN_PROOF()), proverUrl: url },
      { proofId: open.proofId, proof: b64(GOLDEN_PROOF()), callback: url },
    ]) {
      expect((await r.postProof(job.requestId, body)).status).toBe(400);
    }
    const res = await r.postProof(job.requestId, { proofId: open.proofId, proof: withUrl.toString('base64') });
    expect(res.status).toBe(200); // the test double accepts it; the bytes are only handed to the ledger
    await r.queue.settled(job.requestId);
    expect(spy).not.toHaveBeenCalled();
  });

  it('the client-proving code makes no network request and reads no URL from its input', () => {
    const dir = join(SRC, 'client-proving');
    const sources = readdirSync(dir).filter((f) => f.endsWith('.ts'));
    expect(sources).toEqual(expect.arrayContaining(['desk.ts', 'prove-first.ts', 'verifier.ts']));
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
      app.indexOf('AA 00062 (I-62a v2, "prove first"): the client-proof ticket'),
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
