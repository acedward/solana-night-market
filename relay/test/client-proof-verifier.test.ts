// AA 00062 P3.5 (questions Q3 → A): the relay's built-in client-proof verifier, the pinned
// verifier-only WASM in relay/src/client-proving/verifier-wasm/ (built by relay/verifier/build.sh from
// midnight-ledger `ledger-9.1.0.0-rc.3` with proof verification on, and midnight-zkir `zkir-3.1.0-rc.1`).
//
//   - the module is the build's (its SHA-256 is the pin; SHA256SUMS lists every generated file), it
//     imports no network API, and a different or missing module is refused (`required` cannot start);
//   - the P1.2 golden proofs pass: the three proofs the node accepted and the three fresh re-proofs;
//   - tampered proofs fail: flipped bytes, a truncated or extended proof, another circuit's proof, a
//     key volume whose key is not the one the request names, a public-input mismatch;
//   - the time per check is measured (printed; evidence p3.5/).

import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ClientProvenCircuit } from '@nightmarket/core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  builtInClientProofVerifier,
  CLIENT_PROOF_VERIFIER_WASM_PATH,
  CLIENT_PROOF_VERIFIER_WASM_SHA256,
  ClientProofVerifierLoadError,
  type ClientProofVerifier,
} from '../src/client-proving/verifier.js';
import * as glue from '../src/client-proving/verifier-wasm/client_proof_verifier.js';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const FIXTURES = here('./fixtures/client-proof/');
const WASM_DIR = here('../src/client-proving/verifier-wasm/');
const fixture = (name: string) => new Uint8Array(readFileSync(join(FIXTURES, name)));
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

const OPEN_SWAP: ClientProvenCircuit = 'open_swap_shielded_with_ed25519';
const WITHDRAW: ClientProvenCircuit = 'withdraw_shielded_with_ed25519';

interface Vector {
  name: string;
  circuit: ClientProvenCircuit;
  request: string;
  proofs: string[];
}
const VECTORS: Vector[] = [
  {
    name: 'make',
    circuit: OPEN_SWAP,
    request: 'open_swap_shielded_with_ed25519.maker.request.bin',
    proofs: ['open_swap_shielded_with_ed25519.maker.proof.bin', 'open_swap_shielded_with_ed25519.maker.reproof.bin'],
  },
  {
    name: 'take',
    circuit: OPEN_SWAP,
    request: 'open_swap_shielded_with_ed25519.taker.request.bin',
    proofs: ['open_swap_shielded_with_ed25519.taker.proof.bin', 'open_swap_shielded_with_ed25519.taker.reproof.bin'],
  },
  {
    name: 'shielded withdrawal',
    circuit: WITHDRAW,
    request: 'withdraw_shielded_with_ed25519.request.bin',
    proofs: ['withdraw_shielded_with_ed25519.proof.bin', 'withdraw_shielded_with_ed25519.reproof.bin'],
  },
];
const [MAKE, TAKE, WITHDRAWAL] = VECTORS as [Vector, Vector, Vector];
const vk = (c: string) => fixture(`${c}.verifier`);

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});
const shared: string[] = [];
afterAll(() => {
  for (const d of shared) rmSync(d, { recursive: true, force: true });
});
/** A temporary directory removed after this test, or (`keep`) after the whole file. */
const tempRoot = (keep = false) => {
  const d = mkdtempSync(join(tmpdir(), 'nm-client-proof-verifier-'));
  (keep ? shared : dirs).push(d);
  return d;
};

/** A key volume `<root>/account/{keys,zkir}` with the two golden circuits' PUBLIC verifier keys and ZKIR. */
function volume(): string {
  const root = tempRoot(true);
  for (const d of ['keys', 'zkir']) mkdirSync(join(root, 'account', d), { recursive: true });
  for (const c of [OPEN_SWAP, WITHDRAW]) {
    writeFileSync(join(root, 'account', 'keys', `${c}.verifier`), vk(c));
    writeFileSync(join(root, 'account', 'zkir', `${c}.bzkir`), fixture(`${c}.bzkir`));
  }
  return root;
}

const check = (v: ClientProofVerifier, circuit: ClientProvenCircuit, request: Uint8Array, proof: Uint8Array) =>
  v.verify({ circuit, proofRequest: request, proof, verifierKey: vk(circuit) });

describe('the pinned module (P3.5.1)', () => {
  it('is the build’s: its SHA-256 is the pin, and SHA256SUMS lists every generated file', () => {
    const wasm = new Uint8Array(readFileSync(CLIENT_PROOF_VERIFIER_WASM_PATH));
    expect(sha256(wasm)).toBe(CLIENT_PROOF_VERIFIER_WASM_SHA256);
    const sums = readFileSync(join(WASM_DIR, 'SHA256SUMS'), 'utf8').trim().split('\n');
    expect(sums.map((l) => l.split(/\s+/)[1]).sort()).toEqual([
      'client_proof_verifier.d.ts',
      'client_proof_verifier.js',
      'client_proof_verifier_bg.wasm',
      'client_proof_verifier_bg.wasm.d.ts',
    ]);
    for (const line of sums) {
      const [hash, file] = line.split(/\s+/) as [string, string];
      expect(sha256(new Uint8Array(readFileSync(join(WASM_DIR, file)))), file).toBe(hash);
    }
  });

  it('imports no network API, and says what it is built from', () => {
    const module = new WebAssembly.Module(readFileSync(CLIENT_PROOF_VERIFIER_WASM_PATH) as BufferSource);
    const imports = WebAssembly.Module.imports(module).map((i) => `${i.module}.${i.name}`);
    expect(imports.length).toBeGreaterThan(0);
    const network = /fetch|xmlhttprequest|websocket|eventsource|sendbeacon|node:(?:http|https|net|tls|dgram)/i;
    expect(imports.filter((n) => network.test(n))).toEqual([]);
    // What the module can call is exactly the glue's import shims: none of them is a network API.
    const glueSource = readFileSync(join(WASM_DIR, 'client_proof_verifier.js'), 'utf8');
    const shims = glueSource.slice(
      glueSource.indexOf('function __wbg_get_imports()'),
      glueSource.indexOf('return imports;'),
    );
    expect(shims.length).toBeGreaterThan(1000);
    expect(shims).not.toMatch(network);
    glue.initSync({ module });
    expect(glue.verifierBuildInfo()).toMatch(
      /midnight-ledger ledger-9\.1\.0\.0-rc\.3 \(proof-verifying on\); midnight-zkir zkir-3\.1\.0-rc\.1/,
    );
  });

  it('a different module (one flipped byte) or a missing one is refused: `required` cannot start', async () => {
    const root = tempRoot();
    const bad = new Uint8Array(readFileSync(CLIENT_PROOF_VERIFIER_WASM_PATH));
    bad[bad.length >> 1] ^= 0x01;
    writeFileSync(join(root, 'bad.wasm'), bad);
    await expect(builtInClientProofVerifier({ managedPath: null, wasmPath: join(root, 'bad.wasm') })).rejects.toThrow(
      ClientProofVerifierLoadError,
    );
    await expect(builtInClientProofVerifier({ managedPath: null, wasmPath: join(root, 'bad.wasm') })).rejects.toThrow(
      `not the pinned ${CLIENT_PROOF_VERIFIER_WASM_SHA256}`,
    );
    await expect(
      builtInClientProofVerifier({ managedPath: null, wasmPath: join(root, 'missing.wasm') }),
    ).rejects.toThrow(/cannot be read \(ENOENT\)/);
    // The pinned one loads.
    const v = await builtInClientProofVerifier({ managedPath: null });
    expect(v.name).toContain(CLIENT_PROOF_VERIFIER_WASM_SHA256.slice(0, 12));
  });
});

describe('the P1 golden proofs pass (P3.5.3; closes P1.2’s “the verifier accepts”)', () => {
  let verifier: ClientProofVerifier;
  beforeAll(async () => {
    verifier = await builtInClientProofVerifier({ managedPath: volume() });
  });

  it('the three proofs the node accepted and the three fresh re-proofs, each timed', async () => {
    const times: Record<string, number> = {};
    for (const v of VECTORS) {
      const request = fixture(v.request);
      for (const p of v.proofs) {
        const t0 = performance.now();
        const verdict = await check(verifier, v.circuit, request, fixture(p));
        times[p] = Math.round((performance.now() - t0) * 10) / 10;
        expect(verdict, p).toEqual({ ok: true });
      }
    }
    // The first check of a circuit also reads its ZKIR from the volume; the rest are the check alone.
    console.log(`client-proof check times (ms): ${JSON.stringify(times)}`);
    for (const ms of Object.values(times)) expect(ms).toBeLessThan(10_000);
  });

  it('the vectors are the evidence’s, byte for byte', () => {
    const expected: Record<string, string> = {
      'open_swap_shielded_with_ed25519.maker.request.bin':
        '4fa20f225578d27f699061b2eb6bb804026c26df24c067480850051703357a3e',
      'open_swap_shielded_with_ed25519.maker.proof.bin':
        '4c5b517736655ebc4cff34c7a1e26e81d2132ed0a0081129f29417b4b853de29',
      'open_swap_shielded_with_ed25519.maker.reproof.bin':
        '56c153f7ba52c81fe736a62ee8efe83dd324bd18e5a436f7a81cb8925aaf1663',
      'open_swap_shielded_with_ed25519.taker.request.bin':
        '75b8e0259f8d430355dfa865d14423b27e1ed45084f6666d5d11eda72bc80413',
      'open_swap_shielded_with_ed25519.taker.proof.bin':
        '954362eefcbabbe8019fae1c93305128bc0fab94a52adf6ddb7e88bc28319861',
      'open_swap_shielded_with_ed25519.taker.reproof.bin':
        '35dbc32d2d8c5ba32b7f0e1b81d86f968bd6133a5e698e50c12b20844f12a6d6',
      'withdraw_shielded_with_ed25519.request.bin': '7876e77821f117af04ad14588910e227e9b701f110fcb6b517c183258e5bb063',
      'withdraw_shielded_with_ed25519.proof.bin': '0e233f3b340ea886366ed64aa338ec58215f4d61d8f3865755b7b7a02a912760',
      'withdraw_shielded_with_ed25519.reproof.bin': '0be250a2b2059ee60d7162eb1159af0e4be14ddf4bd79a2279c15fec34586059',
      'open_swap_shielded_with_ed25519.bzkir': '97574dce813d642673a393eea3774832a985577e9b7e67bcc08117af3f1d0997',
      'withdraw_shielded_with_ed25519.bzkir': '456924009fd98c0e200cd87e1035dea6375fefb3ea38d045efbaec86731533d5',
    };
    for (const [f, h] of Object.entries(expected)) expect(sha256(fixture(f)), f).toBe(h);
  });
});

describe('tampered proofs fail (P3.5.3)', () => {
  let verifier: ClientProofVerifier;
  beforeAll(async () => {
    verifier = await builtInClientProofVerifier({ managedPath: volume() });
  });

  it('one flipped byte, anywhere (the tag, the body, the last byte)', async () => {
    const request = fixture(MAKE.request);
    const proof = fixture(MAKE.proofs[0]!);
    for (const i of [0, 10, 26, 27, 100, 1000, 2500, 4013, 6000, 8000, proof.length - 1]) {
      const bad = proof.slice();
      bad[i] ^= 0x01;
      const verdict = await check(verifier, OPEN_SWAP, request, bad);
      expect(verdict.ok, `byte ${i}`).toBe(false);
    }
  });

  it('a truncated or extended proof', async () => {
    const request = fixture(WITHDRAWAL.request);
    const proof = fixture(WITHDRAWAL.proofs[0]!);
    for (const bad of [proof.slice(0, -1), proof.slice(0, 4000), Uint8Array.from([...proof, 0])]) {
      expect(await check(verifier, WITHDRAW, request, bad)).toEqual({ ok: false, reason: 'the proof does not decode' });
    }
  });

  it('the wrong circuit: another circuit’s valid proof (a make’s, for a withdrawal)', async () => {
    expect(await check(verifier, WITHDRAW, fixture(WITHDRAWAL.request), fixture(MAKE.proofs[0]!))).toEqual({
      ok: false,
      reason: 'the proof does not verify against the pinned verifier key',
    });
  });

  it('a public-input mismatch: the taker’s valid proof for the maker’s request, and the other way round', async () => {
    for (const [request, proof] of [
      [MAKE.request, TAKE.proofs[0]!],
      [TAKE.request, MAKE.proofs[1]!],
    ] as const) {
      expect(await check(verifier, OPEN_SWAP, fixture(request), fixture(proof))).toEqual({
        ok: false,
        reason: 'the proof does not verify against the pinned verifier key',
      });
    }
  });

  it('the wrong verifier key: the relay’s inputs do not belong together, so the check refuses (throws)', async () => {
    // A key volume whose open_swap key is NOT the one the request names: the module refuses it.
    const root = tempRoot();
    for (const d of ['keys', 'zkir']) mkdirSync(join(root, 'account', d), { recursive: true });
    writeFileSync(join(root, 'account', 'keys', `${OPEN_SWAP}.verifier`), vk(WITHDRAW));
    writeFileSync(join(root, 'account', 'zkir', `${OPEN_SWAP}.bzkir`), fixture(`${OPEN_SWAP}.bzkir`));
    const wrong = await builtInClientProofVerifier({ managedPath: root });
    await expect(
      wrong.verify({
        circuit: OPEN_SWAP,
        proofRequest: fixture(MAKE.request),
        proof: fixture(MAKE.proofs[0]!),
        verifierKey: vk(WITHDRAW),
      }),
    ).rejects.toThrow('the verifier key is not the one the proof request names');
    // A key the volume does not hold at all.
    await expect(
      verifier.verify({
        circuit: OPEN_SWAP,
        proofRequest: fixture(MAKE.request),
        proof: fixture(MAKE.proofs[0]!),
        verifierKey: vk(WITHDRAW),
      }),
    ).rejects.toThrow(/no key-volume bundle holds this verifier key/);
  });

  it('the module itself: a request for another circuit, or a request that does not decode, throws', () => {
    glue.initSync({ module: new WebAssembly.Module(readFileSync(CLIENT_PROOF_VERIFIER_WASM_PATH) as BufferSource) });
    const ir = fixture(`${OPEN_SWAP}.bzkir`);
    const request = fixture(MAKE.request);
    const proof = fixture(MAKE.proofs[0]!);
    expect(glue.verifyClientProof(OPEN_SWAP, request, proof, vk(OPEN_SWAP), ir)).toBeUndefined();
    expect(() => glue.verifyClientProof(WITHDRAW, request, proof, vk(OPEN_SWAP), ir)).toThrow(
      'the proof request is for another circuit',
    );
    expect(() => glue.verifyClientProof(OPEN_SWAP, request.slice(0, -1), proof, vk(OPEN_SWAP), ir)).toThrow(
      'the proof request does not decode',
    );
    expect(() =>
      glue.verifyClientProof(OPEN_SWAP, request, proof, vk(OPEN_SWAP), fixture(`${WITHDRAW}.bzkir`)),
    ).toThrow();
    // A changed binding input (the request's last byte): the statement moves, the proof no longer fits.
    const moved = request.slice();
    moved[moved.length - 1] ^= 0x01;
    const refused = (() => {
      try {
        return glue.verifyClientProof(OPEN_SWAP, moved, proof, vk(OPEN_SWAP), ir) !== undefined;
      } catch {
        return true;
      }
    })();
    expect(refused).toBe(true);
  });
});
