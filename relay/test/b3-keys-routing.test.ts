// B3 (spec FR-005): the key-set fingerprint pin with the demo-token faucet bundle, the on-chain
// verifier-key check of every account the relay acts on, and proof routing (the account's circuits
// and the faucet's mint go to the CONTRACT prover, rc.8; the sponsor's DUST goes to the DUST prover,
// rc.6, through the wallet: relay/test/security.test.ts covers the two settings).

import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as ledger from '@midnightntwrk/ledger-v9';
import { encodeContractKeyLocation, hashVerifierKey } from '@midnight-ntwrk/midnight-js-types';
import { afterEach, describe, expect, it } from 'vitest';

import { accountCircuitIds } from '../src/passport/account-shape.js';
import { NOT_A_MARKET_ACCOUNT, accountKeysChecker, type OnChainAccountState } from '../src/passport/account-keys.js';
import { DEMO_TOKEN_PROVEN_CIRCUITS, RELAY_PROVEN_CIRCUITS } from '../src/prover/required.js';
import { checkKeyVolume, keyVolumeProblems, scanKeyTree } from '../src/prover/keys.js';
import { relayProofProvider } from '../src/prover/proving-provider.js';

const sha256 = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

/** A key volume with the account's shape and the faucet's mint, every key present. */
function volume(opts: { faucetVk?: Uint8Array } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'nm-b3-keys-'));
  roots.push(root);
  const material: Record<string, { prover: Uint8Array; verifier: Uint8Array; ir: Uint8Array }> = {};
  const bundle = (name: string, circuits: string[], vk?: (c: string) => Uint8Array) => {
    const dir = join(root, name);
    for (const d of ['keys', 'zkir', 'compiler']) mkdirSync(join(dir, d), { recursive: true });
    const files: Record<string, unknown> = { type: 'directory' };
    const zkir: Record<string, unknown> = { type: 'directory' };
    for (const c of circuits) {
      const m = { prover: randomBytes(4096), verifier: vk?.(c) ?? randomBytes(1200), ir: randomBytes(512) };
      material[`${name}/${c}`] = m;
      writeFileSync(join(dir, 'keys', `${c}.prover`), m.prover);
      writeFileSync(join(dir, 'keys', `${c}.verifier`), m.verifier);
      writeFileSync(join(dir, 'zkir', `${c}.bzkir`), m.ir);
      files[`${c}.prover`] = { type: 'file', size: m.prover.length, hash: sha256(m.prover) };
      files[`${c}.verifier`] = { type: 'file', size: m.verifier.length, hash: sha256(m.verifier) };
      zkir[`${c}.bzkir`] = { type: 'file', size: m.ir.length, hash: sha256(m.ir) };
    }
    writeFileSync(
      join(dir, 'compiler', 'contract-manifest.json'),
      JSON.stringify({ 'manifest-version': '1', 'compiler-version': '0.35.0', keys: files, zkir }),
    );
  };
  bundle('account', accountCircuitIds());
  bundle('faucet', ['mint'], () => opts.faucetVk ?? randomBytes(1200));
  return { root, material };
}

describe('the key-set fingerprint pin, with the demo faucet bundle (B3)', () => {
  it('covers the faucet key: another faucet build is another key set, and the relay refuses it', () => {
    const vk = randomBytes(1200);
    const a = volume({ faucetVk: vk });
    const pin = scanKeyTree(a.root).fingerprint;
    const same = checkKeyVolume(a.root, pin, [...RELAY_PROVEN_CIRCUITS, ...DEMO_TOKEN_PROVEN_CIRCUITS]);
    expect(same).toMatchObject({ present: true, matchesPin: true, missingProverKeys: [] });
    expect(keyVolumeProblems(same, { root: a.root, pin })).toEqual([]);

    // The same account keys, another faucet mint key: another fingerprint, refused.
    const b = volume({ faucetVk: randomBytes(1200) });
    for (const [id, m] of Object.entries(a.material)) {
      if (id.startsWith('account/')) {
        const c = id.slice('account/'.length);
        writeFileSync(join(b.root, 'account', 'keys', `${c}.verifier`), m.verifier);
      }
    }
    const other = checkKeyVolume(b.root, pin, RELAY_PROVEN_CIRCUITS);
    expect(other.matchesPin).toBe(false);
    expect(keyVolumeProblems(other, { root: b.root, pin })[0]).toMatch(/is not RELAY_KEYS_FINGERPRINT/);
  });

  it('requires the faucet mint and the deposit only when demo tokens are on', () => {
    const v = volume();
    rmSync(join(v.root, 'faucet', 'keys', 'mint.prover'));
    expect(checkKeyVolume(v.root, null, RELAY_PROVEN_CIRCUITS).missingProverKeys).toEqual([]);
    expect(
      checkKeyVolume(v.root, null, [...RELAY_PROVEN_CIRCUITS, ...DEMO_TOKEN_PROVEN_CIRCUITS]).missingProverKeys,
    ).toEqual(['faucet/mint']);
  });
});

// ── FR-005: the account's on-chain verifier keys are the pinned set ──────────

function chainState(
  keys: Record<string, Uint8Array>,
  authority: { committee: unknown[]; threshold: number } = { committee: [], threshold: 1 },
): OnChainAccountState {
  return {
    operations: () => Object.keys(keys),
    operation: (op: never) => (keys[op as string] ? { verifierKey: keys[op as string] } : undefined),
    maintenanceAuthority: authority,
  };
}

describe('the account key check (FR-005)', () => {
  const circuits = accountCircuitIds();
  const keys = Object.fromEntries(circuits.map((c) => [c, new TextEncoder().encode(`vk:${c}`)]));
  const ours = Object.fromEntries(circuits.map((c) => [c, sha256(`vk:${c}`)]));
  const ACCOUNT = 'ab'.repeat(32);

  const checker = (state: OnChainAccountState | null) => {
    let reads = 0;
    const check = accountKeysChecker({
      managedPath: '/unused',
      circuits,
      ours: { ...ours, some_other_arm_circuit: sha256('x') },
      readState: async () => {
        reads++;
        return state;
      },
    });
    return { check, reads: () => reads };
  };

  it('accepts an account with exactly the market shape, the pinned keys and a retired authority (once read)', async () => {
    const c = checker(chainState(keys));
    expect(await c.check(ACCOUNT)).toEqual({ ok: true });
    expect(await c.check(`0x${ACCOUNT.toUpperCase()}`)).toEqual({ ok: true });
    expect(c.reads()).toBe(1); // a retired account cannot change: remembered
  });

  it('refuses another build, a missing or extra operation, a live authority, and no contract', async () => {
    const other = { ...keys, [circuits[0]!]: new TextEncoder().encode('vk:from another build') };
    const missing = Object.fromEntries(Object.entries(keys).slice(1));
    const extra = { ...keys, withdraw_unshielded_with_evm: new Uint8Array([1]) };
    for (const state of [chainState(other), chainState(missing), chainState(extra)]) {
      expect(await checker(state).check(ACCOUNT)).toEqual({ ok: false, reason: NOT_A_MARKET_ACCOUNT });
    }
    const live = await checker(chainState(keys, { committee: ['a key'], threshold: 1 })).check(ACCOUNT);
    expect(live).toMatchObject({ ok: false });
    expect(!live.ok && live.reason).toMatch(/maintenance authority is still live/);
    expect(await checker(null).check(ACCOUNT)).toEqual({ ok: false, reason: 'no contract at this address' });
  });

  it('does not remember a refusal', async () => {
    const c = checker(chainState({}));
    await c.check(ACCOUNT);
    await c.check(ACCOUNT);
    expect(c.reads()).toBe(2);
  });
});

// ── Proof routing ────────────────────────────────────────────────────────────

describe('proof routing: every contract circuit, the faucet mint included, goes to the contract prover', () => {
  it('sends the account circuits and the faucet mint to the one CONTRACT prover URL (rc.8)', async () => {
    const v = volume();
    const urls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      await new Response(init?.body as BodyInit).arrayBuffer();
      urls.push(String(input));
      return new Response(Uint8Array.of(1));
    }) as unknown as typeof fetch;
    const p = await relayProofProvider('http://proof-server-contracts:6300', v.root, { fetch: fetchImpl });
    const aligned = { value: [], alignment: [] };
    for (const id of ['faucet/mint', 'account/deposit_shielded', 'account/open_swap_shielded_with_ed25519']) {
      const circuitId = id.split('/')[1]!;
      const loc = encodeContractKeyLocation({
        contractAddress: 'cd'.repeat(32),
        circuitId,
        verifierKeyHash: hashVerifierKey(v.material[id]!.verifier),
      });
      const pre = ledger.proofDataIntoSerializedPreimage(aligned as never, aligned as never, [], [], loc);
      await p.provingProvider().prove(pre, loc);
      // The body carries that bundle's own key material.
      const body = await p.proveBody(pre, loc);
      expect(sha256(body)).toBe(
        sha256(
          ledger.createProvingPayload(pre, undefined, {
            proverKey: v.material[id]!.prover,
            verifierKey: v.material[id]!.verifier,
            ir: v.material[id]!.ir,
          }),
        ),
      );
    }
    expect(urls).toEqual(Array(3).fill('http://proof-server-contracts:6300/prove'));
  });
});
