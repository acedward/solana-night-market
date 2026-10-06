// Plan P4-A, key-volume completeness: the relay's start-up check covers EVERY circuit it proves
// (the device arm's calls and the offer circuit, ../src/passport/arm.ts), refuses to start with a
// clear message when any key is missing, is not the deployed contract's or is not the pinned set,
// and the list cannot silently fall behind the code.

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { SWAP_CIRCUIT, accountCircuitIds } from '../src/passport/account-shape.js';
import { ARM_CIRCUITS, DEVICE_ARM } from '../src/passport/arm.js';
import { checkKeyVolume, keyVolumeComplete, keyVolumeProblems, scanKeyTree } from '../src/prover/keys.js';
import { ACCOUNT_PROVEN_CIRCUITS, RELAY_PROVEN_CIRCUITS } from '../src/prover/required.js';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const SRC = here('../src');
const CONTRACT = here('../../vendor/passport/contract');

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
  });
}

/** The proof-bearing circuits a compiled contract declares (from compactc's contract-info.json). */
function proofCircuits(managed: string): string[] {
  const info = JSON.parse(readFileSync(join(managed, 'compiler', 'contract-info.json'), 'utf8')) as {
    circuits: Array<{ name: string; proof: boolean }>;
  };
  return info.circuits.filter((c) => c.proof).map((c) => c.name);
}

const ACCOUNT_MANAGED = join(CONTRACT, 'contracts/managed/account');

describe('the list of circuits the relay proves', () => {
  // The pinned submodule predates the Ed25519 arm: the arm's circuits exist in the compiled account
  // only once P6.1 points vendor/passport at Track A's branch. Until then the checks against the
  // compiled contract are skipped, and the rest hold on the names alone.
  const compiled = new Set(proofCircuits(ACCOUNT_MANAGED));
  const armCompiled = compiled.has(ARM_CIRCUITS.activate);

  it("names exactly the device arm's circuits and the offer circuit, all in the account shape", () => {
    expect([...ACCOUNT_PROVEN_CIRCUITS].sort()).toEqual(Object.values(ARM_CIRCUITS).sort());
    expect(RELAY_PROVEN_CIRCUITS).toEqual(ACCOUNT_PROVEN_CIRCUITS.map((c) => `account/${c}`));
    const shape = new Set(accountCircuitIds());
    for (const c of ACCOUNT_PROVEN_CIRCUITS) expect(shape.has(c), `account/${c} is in the account shape`).toBe(true);
    expect(ACCOUNT_PROVEN_CIRCUITS).toContain(SWAP_CIRCUIT);
    for (const c of ACCOUNT_PROVEN_CIRCUITS) expect(c).toMatch(new RegExp(`_with_${DEVICE_ARM}$`));
  });

  it.skipIf(!armCompiled)('names only real proof-bearing circuits of the compiled account (P6.1)', () => {
    for (const c of ACCOUNT_PROVEN_CIRCUITS) expect(compiled.has(c), `account/${c} is a circuit`).toBe(true);
  });

  it('no relay code names a circuit outside the arm seam: no EVM arm, no bridge, no vault', () => {
    const forbidden =
      /_with_evm\b|\bbridge_[a-z_]+\b|\b(startDeposit|completeDeposit|abandonDeposit|startWithdraw|completeWithdraw|refundWithdraw|signBidirectional)\b/;
    for (const file of walk(SRC)) {
      // Drop comments: a circuit mentioned in prose is not a call.
      const code = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
      expect(forbidden.test(code), file).toBe(false);
    }
  });
});

/** A fake key volume holding every circuit the relay proves (or `except`), with made-up keys. */
function volume(
  opts: { except?: Record<string, Array<'prover' | 'verifier' | 'zkir'>>; vk?: (id: string) => string } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'nm-vol-'));
  dirs.push(root);
  for (const id of RELAY_PROVEN_CIRCUITS) {
    const [contract, circuit] = id.split('/') as [string, string];
    mkdirSync(join(root, contract, 'keys'), { recursive: true });
    mkdirSync(join(root, contract, 'zkir'), { recursive: true });
    const skip = opts.except?.[id] ?? [];
    if (!skip.includes('verifier'))
      writeFileSync(join(root, contract, 'keys', `${circuit}.verifier`), opts.vk?.(id) ?? `vk:${id}`);
    if (!skip.includes('prover')) writeFileSync(join(root, contract, 'keys', `${circuit}.prover`), 'pk');
    if (!skip.includes('zkir')) writeFileSync(join(root, contract, 'zkir', `${circuit}.bzkir`), 'ir');
  }
  return root;
}

describe('the key-volume check', () => {
  it('passes a volume with every key, and names each missing prover key, verifier key and ZKIR', () => {
    const full = volume();
    const ok = checkKeyVolume(full, null, RELAY_PROVEN_CIRCUITS);
    expect(keyVolumeComplete(ok)).toBe(true);
    expect(keyVolumeProblems(ok, { root: full, pin: null })).toEqual([]);

    const holes = volume({
      except: {
        [`account/${ARM_CIRCUITS.openSwap}`]: ['prover'],
        [`account/${ARM_CIRCUITS.appendInbox}`]: ['verifier', 'prover', 'zkir'],
        [`account/${ARM_CIRCUITS.activate}`]: ['zkir'],
      },
    });
    const k = checkKeyVolume(holes, null, RELAY_PROVEN_CIRCUITS);
    expect(keyVolumeComplete(k)).toBe(false);
    expect(k.missingProverKeys).toEqual([`account/${ARM_CIRCUITS.appendInbox}`, `account/${ARM_CIRCUITS.openSwap}`]);
    expect(k.missingVerifierKeys).toEqual([`account/${ARM_CIRCUITS.appendInbox}`]);
    expect(k.missingZkir).toEqual([`account/${ARM_CIRCUITS.activate}`, `account/${ARM_CIRCUITS.appendInbox}`]);
    expect(keyVolumeProblems(k, { root: holes, pin: null })).toEqual([
      `missing verifier keys (1): account/${ARM_CIRCUITS.appendInbox}`,
      `missing prover keys (1): account/${ARM_CIRCUITS.openSwap}`,
      `missing ZKIR (1): account/${ARM_CIRCUITS.activate}`,
    ]);
  });

  it('refuses keys that are not the deployed ones, and a fingerprint other than the pin', () => {
    const swap = `account/${ARM_CIRCUITS.openSwap}`;
    const deployed = { [swap]: 'b5'.repeat(32) };
    const root = volume();
    const k = checkKeyVolume(root, '0'.repeat(64), RELAY_PROVEN_CIRCUITS, deployed);
    expect(k.mismatchedVerifierKeys).toEqual([swap]);
    const problems = keyVolumeProblems(k, { root, pin: '0'.repeat(64), deployed });
    expect(problems[0]).toMatch(/fingerprint [0-9a-f]{64} is not RELAY_KEYS_FINGERPRINT 0{64}/);
    expect(problems).toContain(
      `${swap}: the verifier key does not match the deployed contract's (sha256 ${'b5'.repeat(32)}); the keys were built from other sources`,
    );
    // With the pinned fingerprint and no deployed record, the same volume passes.
    const fp = scanKeyTree(root).fingerprint;
    expect(keyVolumeComplete(checkKeyVolume(root, fp, RELAY_PROVEN_CIRCUITS))).toBe(true);
  });
});

/** Start the relay (Bun, as deployed) with `env`; resolve with its exit code and output, or with
 *  'served' once it answers /v1/config when `expectServe` (then it is stopped). */
function startRelay(
  env: Record<string, string>,
  timeoutMs = 60_000,
  expectServe = false,
): Promise<{ code: number | null | 'served'; out: string }> {
  const port = 10_000 + Math.floor(Math.random() * 40_000);
  return new Promise((resolve, reject) => {
    const tokens = join(mkdtempSync(join(tmpdir(), 'nm-tok-')), 'tokens.json');
    dirs.push(join(tokens, '..'));
    writeFileSync(
      tokens,
      JSON.stringify({
        tokens: [
          { symbol: 'tA', decimals: 6, midnightColour: 'aa'.repeat(32) },
          { symbol: 'tB', decimals: 8, midnightColour: 'bb'.repeat(32) },
        ],
      }),
    );
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
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`the relay did not exit within ${timeoutMs} ms:\n${out}`));
    }, timeoutMs);
    let served = false;
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code: served ? 'served' : code, out });
    });
    if (expectServe) {
      const poll = async () => {
        for (;;) {
          if (child.exitCode !== null) return;
          const ok = await fetch(`http://127.0.0.1:${port}/v1/config`).then(
            (r) => r.ok,
            () => false,
          );
          if (ok) {
            served = true;
            child.kill('SIGTERM');
            return;
          }
          await new Promise((r) => setTimeout(r, 200));
        }
      };
      void poll();
    }
  });
}

describe('the relay at start-up (Bun)', () => {
  it('refuses to start when a circuit it proves has no key, naming it', async () => {
    const root = volume({ except: { [`account/${ARM_CIRCUITS.openSwap}`]: ['prover'] } });
    const r = await startRelay({ MIDNIGHT_MANAGED_PATH: root });
    expect(r.code).toBe(78);
    expect(r.out).toContain('the key volume is incomplete or does not match; refusing to start');
    expect(r.out).toContain(`missing prover keys (1): account/${ARM_CIRCUITS.openSwap}`);
  }, 90_000);

  it('refuses to start when the key set is not the pinned one', async () => {
    const r = await startRelay({
      RELAY_NETWORK: 'stagenet',
      MIDNIGHT_MANAGED_PATH: volume(),
      RELAY_KEYS_FINGERPRINT: '0'.repeat(64),
    });
    expect(r.code).toBe(78);
    expect(r.out).toMatch(/fingerprint [0-9a-f]{64} is not RELAY_KEYS_FINGERPRINT/);
  }, 90_000);

  it('AA 00060 P16: pinned to the key set, with bridging on and the bridge bundle beside the set, passes the key check', async () => {
    const root = volume();
    const pin = scanKeyTree(root).fingerprint;
    // The bridge bundle as RUNBOOK 17.3 installs it: `<key volume>/bridge/`.
    for (const d of ['keys', 'zkir', 'contract']) mkdirSync(join(root, 'bridge', d), { recursive: true });
    for (const c of ['lockForSolana', 'mintFromSolana']) {
      writeFileSync(join(root, 'bridge', 'keys', `${c}.verifier`), `vk:bridge/${c}`);
      writeFileSync(join(root, 'bridge', 'keys', `${c}.prover`), 'pk');
      writeFileSync(join(root, 'bridge', 'zkir', `${c}.bzkir`), 'ir');
    }
    const journeyFile = here('../../test/fixtures/journey-registry.undeployed.json');
    const journey = JSON.parse(readFileSync(journeyFile, 'utf8')) as {
      tokens: { colour: string; symbol: string; decimals: number }[];
    };
    const cfg = mkdtempSync(join(tmpdir(), 'nm-p16-'));
    dirs.push(cfg);
    writeFileSync(
      join(cfg, 'tokens.json'),
      JSON.stringify({
        tokens: journey.tokens.map((t) => ({ symbol: t.symbol, decimals: t.decimals, midnightColour: t.colour })),
      }),
    );
    mkdirSync(join(cfg, 'data'), { mode: 0o700 });
    const r = await startRelay({
      MIDNIGHT_MANAGED_PATH: root,
      RELAY_KEYS_FINGERPRINT: pin,
      TOKENS_FILE: join(cfg, 'tokens.json'),
      BRIDGE_REGISTRY_FILE: journeyFile,
      RELAY_DATA_DIR: join(cfg, 'data'),
    });
    expect(r.out).not.toMatch(/is not RELAY_KEYS_FINGERPRINT/);
    expect(r.out).toContain('"msg":"key volume complete"');
    expect(r.out).toContain(`"fingerprint":"${pin}"`);
    // The made-up account keys then fail the NEXT check, the Passport client's own binding: the key check
    // passed. (The real key set, pinned to 21493588…, starts with bridging on: P16's run, evidence p16/.)
    expect(r.code).toBe(78);
    expect(r.out).toContain('the key volume does not match the Passport client');
  }, 90_000);

  it('with RELAY_REQUIRE_KEYS, refuses to start without a key volume or on an empty one', async () => {
    const r = await startRelay({ RELAY_REQUIRE_KEYS: 'true' });
    expect(r.code).toBe(78);
    expect(r.out).toContain('RELAY_REQUIRE_KEYS is set but MIDNIGHT_MANAGED_PATH names no key volume');
    const empty = mkdtempSync(join(tmpdir(), 'nm-empty-'));
    dirs.push(empty);
    const e = await startRelay({ MIDNIGHT_MANAGED_PATH: empty, RELAY_REQUIRE_KEYS: 'true' });
    expect(e.code).toBe(78);
    expect(e.out).toContain('no compiled contracts with keys were found');
  }, 90_000);

  it('without it, an empty key path (the image default, nothing mounted) starts keyless and says so', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'nm-empty-'));
    dirs.push(empty);
    const r = await startRelay({ MIDNIGHT_MANAGED_PATH: empty }, 60_000, true);
    expect(r.code).toBe('served');
    expect(r.out).toContain('no key volume at MIDNIGHT_MANAGED_PATH');
  }, 90_000);
});
