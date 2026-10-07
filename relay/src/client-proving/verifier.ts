// The check of a client's proof (AA 00062, I-62a: `ClientProofVerifier.verify`), run inside the
// hand-off, before the ledger receives the proof: so before any fee proof, balance, `bind`,
// `POST /v1/offers` or submission (spec FR-002, SC-004).
//
// THE VERIFIER (questions Q3, owner: option A; plan task P3.5). The relay's own ledger cannot check a
// proof (research R3: the published ledger-v9 WASM is built without the ledger's `proof-verifying`
// feature, so its `wellFormed` accepts any contract proof). So the relay carries a verifier-only
// WebAssembly module of its own, ./verifier-wasm/, built by relay/verifier/build.sh from midnight-ledger
// tag `ledger-9.1.0.0-rc.3` (the node's ledger, `proof-verifying` ON) and midnight-zkir tag
// `zkir-3.1.0-rc.1` (the evaluator proof server 9.0.0-rc.8 proves with). For one call it rebuilds the
// public inputs the node checks (the ledger's `ContractCall::public_inputs`: the binding input, the
// communications commitment, the transcript with a zero `noop` for each impact the circuit skipped)
// and runs the ledger's own `proof_verify` against the PINNED verifier key (relay/verifier/src/lib.rs).
//
// PINNED. The module's SHA-256 is fixed below and checked before it is compiled: on a mismatch, or if
// it cannot be loaded, `builtInClientProofVerifier` throws and `required` mode refuses to start (exit
// 78). Nothing in the configuration can swap it; tests hand the desk a test double through dependency
// injection only (./desk.ts `ClientProofDeskOptions.verifier`).
//
// THE CIRCUIT'S ZKIR (questions Q8). Which impacts a call skipped is known only from the circuit's
// ZKIR, which the frozen `verify` inputs do not carry. The verifier reads it from the key volume: the
// `zkir/<circuit>.bzkir` of the bundle whose `keys/<circuit>.verifier` is byte for byte the pinned key
// it was given (the relay proves with the same files). It is a pure function of (the proof, the proof
// request, the circuit, the pinned verifier key and that key's ZKIR), so it does not depend on how the
// hand-off holds the job (questions Q4).
//
// NO NETWORK. The module is instantiated from bytes read here (`initSync`); its imports hold no
// network API, and the glue's URL-fetching initialiser is never called.

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { ClientProvenCircuit, ClientProvingMode } from '@nightmarket/core';

import type { Logger } from '../log.js';
import { findArtefactBundles } from '../prover/proving-provider.js';
import type * as GlueModule from './verifier-wasm/client_proof_verifier.js';

export interface ClientProofVerifierInput {
  circuit: ClientProvenCircuit;
  /** The I-62a proof request the page was given (the ledger's key-less `/prove` body). */
  proofRequest: Uint8Array;
  /** The page's proof, decoded (`midnight:proof-versioned:` …). */
  proof: Uint8Array;
  /** The PINNED `keys/<circuit>.verifier` of the relay's key volume: its sha256 is the key location's
   *  `?vk=`, which FR-005 already pins against the chain. */
  verifierKey: Uint8Array;
}

/** `reason` is logged (never shown to customers): a short technical cause, never the request's or the
 *  proof's bytes (a proof request carries the call's private inputs). */
export type ClientProofVerdict = { ok: true } | { ok: false; reason: string };

export interface ClientProofVerifier {
  /** A short name for the log (never shown to customers). */
  readonly name: string;
  verify(input: ClientProofVerifierInput): Promise<ClientProofVerdict>;
}

/** The SHA-256 of ./verifier-wasm/client_proof_verifier_bg.wasm, as relay/verifier/build.sh built it
 *  (and as ./verifier-wasm/SHA256SUMS lists it). A rebuild that changes the bytes changes this pin. */
export const CLIENT_PROOF_VERIFIER_WASM_SHA256 = '600e74044a3a9824af4cd809f999c5e1aee9c7ac11673dc2e896d835b396baf3';

const WASM_DIR = join(dirname(fileURLToPath(import.meta.url)), 'verifier-wasm');
/** Where the pinned module is. */
export const CLIENT_PROOF_VERIFIER_WASM_PATH = join(WASM_DIR, 'client_proof_verifier_bg.wasm');
const GLUE_PATH = join(WASM_DIR, 'client_proof_verifier.js');

/** How often a trapped module is replaced by a fresh instance before the verifier gives up. */
const MAX_INSTANCES = 8;

/** The pinned module could not be loaded: `required` mode must not start. */
export class ClientProofVerifierLoadError extends Error {
  override readonly name = 'ClientProofVerifierLoadError';
}

/** Why `required` mode cannot start: the verifier did not load. */
export const NO_CLIENT_PROOF_VERIFIER =
  'CLIENT_PROVING=required needs the built-in client-proof verifier, and it did not load (AA 00062 P3.5: ' +
  'relay/src/client-proving/verifier-wasm/, rebuilt by relay/verifier/build.sh)';

/** The wasm-bindgen glue (./verifier-wasm/client_proof_verifier.js). */
type Glue = typeof GlueModule;

export interface BuiltInVerifierOptions {
  /** The key volume (MIDNIGHT_MANAGED_PATH): each circuit's ZKIR is read from it (questions Q8). */
  managedPath: string | null;
  log?: Logger;
  /** Tests only: read the module from another file. Its SHA-256 is still checked against the pin. */
  wasmPath?: string;
}

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** A fresh instance of the glue and the module: a separate module record per instance, so a trapped
 *  instance (a WebAssembly `unreachable`, e.g. a panic) is never used again. */
async function instantiate(module: WebAssembly.Module, n: number): Promise<Glue> {
  const specifier = `${pathToFileURL(GLUE_PATH).href}?instance=${n}`;
  const glue = (await import(/* @vite-ignore */ specifier)) as Glue;
  glue.initSync({ module });
  glue.warmUp();
  return glue;
}

/**
 * The verifier built into this relay: the pinned WebAssembly module (its SHA-256 checked first),
 * instantiated and warmed up. Throws `ClientProofVerifierLoadError` when the file is missing, its
 * SHA-256 is not the pin, or it does not compile or instantiate: main.ts then refuses to start in
 * `required` mode (exit 78). Never a verifier that accepts without checking.
 */
export async function builtInClientProofVerifier(options: BuiltInVerifierOptions): Promise<ClientProofVerifier> {
  const path = options.wasmPath ?? CLIENT_PROOF_VERIFIER_WASM_PATH;
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(path));
  } catch (e) {
    throw new ClientProofVerifierLoadError(
      `the client-proof verifier module cannot be read (${(e as { code?: string }).code ?? 'error'})`,
    );
  }
  const digest = sha256(bytes);
  if (digest !== CLIENT_PROOF_VERIFIER_WASM_SHA256) {
    throw new ClientProofVerifierLoadError(
      `the client-proof verifier module's SHA-256 is ${digest}, not the pinned ${CLIENT_PROOF_VERIFIER_WASM_SHA256}`,
    );
  }
  let module: WebAssembly.Module;
  let glue: Glue;
  let instances = 1;
  try {
    module = new WebAssembly.Module(bytes as BufferSource);
    glue = await instantiate(module, instances);
  } catch (e) {
    throw new ClientProofVerifierLoadError(
      `the client-proof verifier module does not load: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const buildInfo = glue.verifierBuildInfo();
  let poisoned = false;

  // The circuit's ZKIR, from the key-volume bundle holding exactly this verifier key (questions Q8).
  const zkir = new Map<string, Promise<Uint8Array>>();
  const zkirFor = (circuit: string, verifierKey: Uint8Array): Promise<Uint8Array> => {
    const id = `${circuit}:${sha256(verifierKey)}`;
    let p = zkir.get(id);
    if (!p) {
      p = (async () => {
        if (!options.managedPath) throw new Error('no key volume: the circuit ZKIR cannot be read');
        for (const dir of await findArtefactBundles(options.managedPath)) {
          const vk = await readFile(join(dir, 'keys', `${circuit}.verifier`)).catch(() => null);
          if (vk && Buffer.compare(vk, verifierKey) === 0) {
            return new Uint8Array(await readFile(join(dir, 'zkir', `${circuit}.bzkir`)));
          }
        }
        throw new Error(`no key-volume bundle holds this verifier key for ${circuit}`);
      })();
      zkir.set(id, p);
      p.catch(() => zkir.delete(id));
    }
    return p;
  };

  options.log?.info('client-proof verifier loaded', { sha256: digest, bytes: bytes.length, build: buildInfo });

  return {
    name: `wasm ${digest.slice(0, 12)} (${buildInfo})`,
    async verify({ circuit, proofRequest, proof, verifierKey }) {
      if (poisoned) throw new Error('the client-proof verifier is out of service (it trapped too often)');
      const ir = await zkirFor(circuit, verifierKey);
      try {
        // undefined: verified; a string: the client's proof failed (the requester's failure). It
        // THROWS when the relay's own inputs do not belong together (the desk: market-unavailable).
        const reason = glue.verifyClientProof(circuit, proofRequest, proof, verifierKey, ir);
        return reason === undefined ? { ok: true } : { ok: false, reason };
      } catch (e) {
        if (e instanceof WebAssembly.RuntimeError) {
          // The module trapped: never use this instance again (its memory may be inconsistent).
          options.log?.error('the client-proof verifier trapped; replacing its instance', {
            circuit,
            error: e.message,
          });
          if (instances >= MAX_INSTANCES) poisoned = true;
          else glue = await instantiate(module, ++instances);
        }
        throw e;
      }
    },
  };
}

/**
 * Whether the relay may start with this client-proving mode and verifier: null when it may, else the
 * reason it must not (main.ts exits 78 with it). `off` never needs a verifier.
 */
export function clientProvingStartProblem(
  mode: ClientProvingMode,
  verifier: ClientProofVerifier | null,
  keyVolume: { loaded: boolean; fingerprint: string | null },
): string | null {
  if (mode === 'off') return null;
  if (!verifier) return NO_CLIENT_PROOF_VERIFIER;
  if (!keyVolume.loaded || !keyVolume.fingerprint) {
    return 'CLIENT_PROVING=required needs the key volume (MIDNIGHT_MANAGED_PATH): a client proof is checked against its pinned verifier keys, and the page is told its key set';
  }
  return null;
}
