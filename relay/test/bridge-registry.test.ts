// AA 00060 P4.2 (T4.2, unit): the relay's journey-registry checks. A bridged token must be in TOKENS_FILE
// with the same colour, symbol and decimals (else the config refuses, naming it); each bridge's deployed
// `lockForSolana` verifier key must be the key volume's; GET /v1/config publishes the token list's digest;
// without BRIDGE_REGISTRY_FILE nothing changes.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { tokensDigest } from '@nightmarket/core';
import { parseJourneyRegistry } from '@nightmarket/core/bridge';

import { BRIDGE_LOCK_CIRCUIT, bridgeKeyProblems, tokenListProblems } from '../src/bridge/registry-check.js';
import { ConfigError, loadConfig } from '../src/config.js';
import { harness } from './harness.js';

const journey = JSON.parse(
  readFileSync(join(__dirname, '../../test/fixtures/journey-registry.undeployed.json'), 'utf8'),
) as { tokens: { colour: string; symbol: string; decimals: number; bridgeContract: string }[] };
const X = journey.tokens[0]!;
const Y = journey.tokens[1]!;
const BASE = [{ symbol: 'twUSDC', decimals: 6, midnightColour: 'a1'.repeat(32) }];
const listed = (over: Partial<Record<'X' | 'Y', Record<string, unknown> | null>> = {}) => ({
  mode: 'replace',
  tokens: [
    ...BASE,
    ...(['X', 'Y'] as const)
      .map((s) => {
        const e = s === 'X' ? X : Y;
        if (over[s] === null) return null;
        return { symbol: e.symbol, decimals: e.decimals, midnightColour: e.colour, ...(over[s] ?? {}) };
      })
      .filter((t) => t !== null),
  ],
});

function load(tokens: unknown, env: Record<string, string> = {}) {
  const files: Record<string, string> = {
    '/tokens.json': JSON.stringify(tokens),
    '/journey.json': JSON.stringify(journey),
  };
  return loadConfig(
    { RELAY_NETWORK: 'undeployed', TOKENS_FILE: '/tokens.json', MIDNIGHT_MANAGED_PATH: '/keys', ...env },
    (p: string) => {
      if (!(p in files)) throw new Error(`no ${p}`);
      return files[p]!;
    },
  ).config;
}
const refusal = (fn: () => unknown): string => {
  try {
    fn();
    return 'started';
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    return e.message;
  }
};

describe('BRIDGE_REGISTRY_FILE against TOKENS_FILE', () => {
  it('matching lists: the registry is loaded', () => {
    const c = load(listed(), { BRIDGE_REGISTRY_FILE: '/journey.json' });
    expect(c.bridges?.entries.map((e) => e.symbol)).toEqual(['X', 'Y']);
  });

  it('a missing bridged colour: refused, naming it', () => {
    expect(refusal(() => load(listed({ Y: null }), { BRIDGE_REGISTRY_FILE: '/journey.json' }))).toBe(
      `BRIDGE_REGISTRY_FILE: Y (colour ${Y.colour}) is not in TOKENS_FILE's token list`,
    );
  });

  it('other decimals, or another symbol: refused, naming it', () => {
    expect(refusal(() => load(listed({ X: { decimals: 8 } }), { BRIDGE_REGISTRY_FILE: '/journey.json' }))).toBe(
      `BRIDGE_REGISTRY_FILE: X (colour ${X.colour}) has 6 decimals in the registry, 8 in TOKENS_FILE`,
    );
    expect(refusal(() => load(listed({ X: { symbol: 'XX' } }), { BRIDGE_REGISTRY_FILE: '/journey.json' }))).toMatch(
      /X \(colour [0-9a-f]{64}\) is listed as XX in TOKENS_FILE/,
    );
  });

  it('another network, or no key volume: refused', () => {
    expect(refusal(() => load(listed(), { BRIDGE_REGISTRY_FILE: '/journey.json', RELAY_NETWORK: 'stagenet' }))).toMatch(
      /BRIDGE_REGISTRY_FILE: wrong-network/,
    );
    expect(refusal(() => load(listed(), { BRIDGE_REGISTRY_FILE: '/journey.json', MIDNIGHT_MANAGED_PATH: '' }))).toMatch(
      /needs the key volume/,
    );
  });

  it('without BRIDGE_REGISTRY_FILE nothing changes', () => {
    expect(load(listed()).bridges).toBeNull();
    expect(load(listed({ X: null, Y: null })).bridges).toBeNull();
  });

  it('tokenListProblems lists every problem', () => {
    const c = load(listed());
    const r = parseJourneyRegistry(journey, { midnightNetwork: 'undeployed' });
    expect(tokenListProblems(r, c.tokens)).toEqual([]);
    expect(tokenListProblems(r, load(listed({ X: null, Y: { decimals: 2 } })).tokens)).toHaveLength(2);
  });
});

describe("each bridge's deployed lockForSolana verifier key", () => {
  const root = mkdtempSync(join(tmpdir(), 'aa00060-bridge-keys-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const vk = new Uint8Array(64).fill(3);
  mkdirSync(join(root, 'bridge', 'keys'), { recursive: true });
  writeFileSync(join(root, 'bridge', 'keys', `${BRIDGE_LOCK_CIRCUIT}.verifier`), vk);
  const registry = parseJourneyRegistry(journey, { midnightNetwork: 'undeployed' });
  const stateWith = (key: Uint8Array | null) => ({
    operations: () => (key ? [BRIDGE_LOCK_CIRCUIT, 'mintFromSolana'] : ['mintFromSolana']),
    operation: (op: never) => ({
      verifierKey: (op as string) === BRIDGE_LOCK_CIRCUIT ? (key ?? undefined) : new Uint8Array(8),
    }),
  });

  it('equal keys: no problem', async () => {
    expect(await bridgeKeyProblems(registry, root, async () => stateWith(vk))).toEqual([]);
  });

  it('another deployed key, no contract, no operation, or no bundle: named problems', async () => {
    const other = await bridgeKeyProblems(registry, root, async () => stateWith(new Uint8Array(64).fill(4)));
    expect(other).toEqual([
      `X: the bridge at ${X.bridgeContract} was deployed with another lockForSolana verifier key than the key volume's`,
      `Y: the bridge at ${Y.bridgeContract} was deployed with another lockForSolana verifier key than the key volume's`,
    ]);
    expect(await bridgeKeyProblems(registry, root, async () => null)).toEqual([
      `X: no bridge contract at ${X.bridgeContract} on this network`,
      `Y: no bridge contract at ${Y.bridgeContract} on this network`,
    ]);
    expect((await bridgeKeyProblems(registry, root, async () => stateWith(null)))[0]).toMatch(
      /has no lockForSolana operation/,
    );
    expect(await bridgeKeyProblems(registry, join(root, 'nowhere'), async () => stateWith(vk))).toEqual([
      'the key volume has no bridge bundle (bridge/keys): Bridge out cannot be proven',
    ]);
  });
});

describe('GET /v1/config', () => {
  it("publishes the token list's digest", async () => {
    const config = load(listed());
    const body = (await (await harness({ config }).app.request('/v1/config')).json()) as { tokensDigest?: string };
    expect(body.tokensDigest).toBe(tokensDigest(config.tokens));
    expect(body.tokensDigest).toMatch(/^[0-9a-f]{64}$/);
    const other = load(listed({ X: { decimals: 9 } }));
    expect(tokensDigest(other.tokens)).not.toBe(body.tokensDigest);
  });
});
