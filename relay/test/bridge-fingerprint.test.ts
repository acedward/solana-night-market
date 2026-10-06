// AA 00060 P16: the bridge bundle (`<key volume>/bridge/`, the 00050 template's compiled bridge that Bridge
// out proves `lockForSolana` with) is not part of the key set's fingerprint. The pin
// (RELAY_KEYS_FINGERPRINT, `21493588…` in deploy/.env.example) covers the key set's own bundles, the account
// and the demo faucet, so a pinned relay with bridging starts, and the key job's `verify` still says VERIFIED,
// with the bridge bundle installed beside them. The bridge bundle keeps its own start-up checks
// (../src/bridge/registry-check.ts): each bridge's deployed `lockForSolana` verifier key against the bundle,
// and the sealed SPL mint against the registry.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseJourneyRegistry } from '@nightmarket/core/bridge';
import { afterEach, describe, expect, it } from 'vitest';

import { BRIDGE_BUNDLE, BRIDGE_LOCK_CIRCUIT, bridgeKeyProblems } from '../src/bridge/registry-check.js';
import { checkKeyVolume, keyVolumeComplete, keyVolumeProblems, scanKeyTree } from '../src/prover/keys.js';
import { RELAY_PROVEN_CIRCUITS } from '../src/prover/required.js';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const KEY_VOLUME_TOOL = here('../src/tools/key-volume.ts');
const REPO = here('../..');

const sha = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex');
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** The key set's own bundles, as the key job installs them: every circuit with its verifier key and ZKIR,
 *  the kept ones with their prover key, and each bundle's compiled `contract/index.js` with its
 *  `expectedVk` table (what `key-volume.ts verify` compares the files with). */
const SET: Record<string, { circuits: string[]; provers: string[] }> = {
  account: {
    circuits: [...RELAY_PROVEN_CIRCUITS.map((id) => id.split('/')[1]!), 'deposit_shielded', 'add_device_with_evm'],
    provers: [...RELAY_PROVEN_CIRCUITS.map((id) => id.split('/')[1]!), 'deposit_shielded'],
  },
  faucet: { circuits: ['mint', 'name', 'symbol'], provers: ['mint'] },
};

function writeBundle(
  root: string,
  bundle: string,
  circuits: string[],
  provers: string[],
  vk = (c: string) => `vk:${bundle}/${c}`,
) {
  for (const d of ['keys', 'zkir', 'contract', 'compiler']) mkdirSync(join(root, bundle, d), { recursive: true });
  const expectedVk: Record<string, string> = {};
  for (const c of circuits) {
    writeFileSync(join(root, bundle, 'keys', `${c}.verifier`), vk(c));
    writeFileSync(join(root, bundle, 'zkir', `${c}.bzkir`), `ir:${bundle}/${c}`);
    expectedVk[c] = sha(vk(c));
  }
  for (const c of provers) writeFileSync(join(root, bundle, 'keys', `${c}.prover`), `pk:${bundle}/${c}`);
  writeFileSync(
    join(root, bundle, 'contract', 'index.js'),
    `export const expectedVk = ${JSON.stringify(expectedVk)};\nexport function ledger() { return { sourceMint: new Uint8Array(32) }; }\n`,
  );
}

function keySet(): string {
  const root = mkdtempSync(join(tmpdir(), 'aa00060-p16-keys-'));
  dirs.push(root);
  for (const [bundle, { circuits, provers }] of Object.entries(SET)) writeBundle(root, bundle, circuits, provers);
  return root;
}

/** The bridge bundle beside the set, as RUNBOOK 17.3 installs it (`<key volume>/bridge/`). */
const BRIDGE_LOCK_VK = 'vk:bridge/lockForSolana';
function addBridge(root: string): void {
  writeBundle(root, BRIDGE_BUNDLE, [BRIDGE_LOCK_CIRCUIT, 'mintFromSolana'], [BRIDGE_LOCK_CIRCUIT, 'mintFromSolana']);
}

const KEPT = Object.entries(SET)
  .flatMap(([b, { provers }]) => provers.map((c) => `${b}/${c}`))
  .join(',');

/** `bun relay/src/tools/key-volume.ts verify <root>` as the key job runs it (deploy/key-volume/build.sh). */
function verify(root: string, pin: string | null) {
  const r = spawnSync('bun', [KEY_VOLUME_TOOL, 'verify', root], {
    cwd: REPO,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '/tmp',
      RELAY_NETWORK: 'stagenet',
      KEYS_KEEP_PROVERS: KEPT,
      ...(pin ? { RELAY_KEYS_FINGERPRINT: pin } : {}),
    },
    encoding: 'utf8',
    timeout: 60_000,
  });
  const report = JSON.parse(r.stdout || '{}') as { verdict?: string; fingerprint?: string; problems?: string[] };
  return { code: r.status, report, stderr: r.stderr };
}

describe('the key set fingerprint with the bridge bundle (P16)', () => {
  it('is the same with and without the bridge bundle', () => {
    const root = keySet();
    const pin = scanKeyTree(root).fingerprint;
    addBridge(root);
    expect(scanKeyTree(root).fingerprint).toBe(pin);
    // The scan lists the key set's circuits only: none of the bridge's.
    expect(scanKeyTree(root).circuits.filter((c) => c.contract === BRIDGE_BUNDLE)).toEqual([]);
  });

  it('still changes when a key of the set changes, or when any other bundle is added', () => {
    const root = keySet();
    addBridge(root);
    const pin = scanKeyTree(root).fingerprint;
    writeFileSync(join(root, 'faucet', 'keys', 'mint.verifier'), 'another key');
    expect(scanKeyTree(root).fingerprint).not.toBe(pin);

    const other = keySet();
    const before = scanKeyTree(other).fingerprint;
    writeBundle(other, 'Erc20Vault', ['startDeposit'], []);
    expect(scanKeyTree(other).fingerprint).not.toBe(before);
  });

  it("a relay pinned to the set's fingerprint finds no problem with the bridge bundle present", () => {
    const root = keySet();
    const pin = scanKeyTree(root).fingerprint;
    addBridge(root);
    const k = checkKeyVolume(root, pin, RELAY_PROVEN_CIRCUITS);
    expect(k).toMatchObject({ present: true, fingerprint: pin, pinned: true, matchesPin: true });
    expect(keyVolumeProblems(k, { root, pin })).toEqual([]);
    expect(keyVolumeComplete(k)).toBe(true);
  });

  it('a bridge bundle never stands in for the set: a volume holding only it has no key set', () => {
    const root = mkdtempSync(join(tmpdir(), 'aa00060-p16-only-bridge-'));
    dirs.push(root);
    addBridge(root);
    const k = checkKeyVolume(root, null, RELAY_PROVEN_CIRCUITS);
    expect(k.present).toBe(false);
    expect(keyVolumeProblems(k, { root, pin: null })[0]).toMatch(/no compiled contracts with keys were found/);
  });

  it('the bridge bundle keeps its own check: a bridge deployed with another lockForSolana key is refused', async () => {
    const root = keySet();
    addBridge(root);
    const journey = JSON.parse(readFileSync(join(REPO, 'test/fixtures/journey-registry.undeployed.json'), 'utf8'));
    const registry = parseJourneyRegistry(journey, { midnightNetwork: 'undeployed' });
    const state = (vk: string) => ({
      operations: () => [BRIDGE_LOCK_CIRCUIT],
      operation: () => ({ verifierKey: new TextEncoder().encode(vk) }),
    });
    expect(await bridgeKeyProblems(registry, root, async () => state(BRIDGE_LOCK_VK))).toEqual([]);
    expect(await bridgeKeyProblems(registry, root, async () => state('another key'))).toEqual(
      registry.entries.map(
        (b) =>
          `${b.symbol}: the bridge at ${b.bridgeContract} was deployed with another lockForSolana verifier key than the key volume's`,
      ),
    );
  });
});

describe('key-volume.ts verify (the key job) with the bridge bundle (P16)', () => {
  it("reports VERIFIED with the set's pin, the bridge bundle present", () => {
    const root = keySet();
    const pin = scanKeyTree(root).fingerprint;
    expect(verify(root, pin)).toMatchObject({ code: 0, report: { verdict: 'VERIFIED', fingerprint: pin } });
    addBridge(root);
    const r = verify(root, pin);
    expect(r.report.problems).toEqual([]);
    expect(r).toMatchObject({ code: 0, report: { verdict: 'VERIFIED', fingerprint: pin } });
  }, 120_000);

  it('still reports MISMATCH, exit 1, for another pin', () => {
    const root = keySet();
    addBridge(root);
    const r = verify(root, '0'.repeat(64));
    expect(r.code).toBe(1);
    expect(r.report.verdict).toBe('MISMATCH');
    expect(r.report.problems).toEqual([
      `fingerprint ${scanKeyTree(root).fingerprint} differs from RELAY_KEYS_FINGERPRINT ${'0'.repeat(64)}`,
    ]);
  }, 120_000);
});
