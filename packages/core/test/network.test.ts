import { describe, expect, it } from 'vitest';

import {
  NETWORK_DEFAULT_ASSETS,
  NETWORK_DEFAULT_PAIRS,
  NetworkConfigError,
  PROFILES,
  resolveNetwork,
} from '../src/network.js';
import { resolvePairs } from '../src/tokens/pairs.js';
import { stagenetRegistry } from '../src/tokens/registry.js';

describe('network profiles', () => {
  it('stagenet points at the live staging endpoints', () => {
    const s = resolveNetwork('stagenet');
    expect(s.midnightNetworkId).toBe('stagenet');
    expect(s.midnight.nodeUrl).toBe('https://rpc.stagenet.shielded.tools');
    expect(s.midnight.indexerUrl).toBe('https://indexer.stagenet.shielded.tools/api/v4/graphql');
    expect(s.zswap.kernelUrl).toBe('https://stagenet.api-zswap.zkdojo.com');
    expect(s.zswap.batcherUrl).toBe('https://stagenet.batcher-zswap.zkdojo.com');
    expect(s.zswap.batcherTarget).toBe('midnight-balancer');
  });

  it('undeployed uses the local stack DNS names', () => {
    const u = resolveNetwork('undeployed');
    expect(u.midnight.nodeUrl).toBe('http://node:9944');
    expect(u.midnight.indexerUrl).toBe('http://indexer:8088/api/v4/graphql');
    expect(u.zswap.kernelUrl).toBe('http://kernel:9999');
    expect(u.zswap.batcherUrl).toBe('http://batcher:3334');
  });

  it('has nothing of Sepolia, EVM wallets or a bridge (AA 00047)', () => {
    for (const p of Object.values(PROFILES)) expect(Object.keys(p).sort()).toEqual(['midnight', 'midnightNetworkId', 'name', 'zswap']);
    expect(JSON.stringify(PROFILES)).not.toMatch(/sepolia|evm|vault|bridge|mpc/i);
  });

  it('every endpoint can be overridden, and the rest keep their defaults', () => {
    const s = resolveNetwork('stagenet', {
      midnight: { indexerUrl: 'https://indexer.example.test/api/v4/graphql' },
      zswap: { kernelUrl: 'https://kernel.example.test' },
    });
    expect(s.midnight.indexerUrl).toBe('https://indexer.example.test/api/v4/graphql');
    expect(s.midnight.nodeUrl).toBe(PROFILES.stagenet.midnight.nodeUrl);
    expect(s.zswap.kernelUrl).toBe('https://kernel.example.test');
    expect(s.zswap.batcherUrl).toBe(PROFILES.stagenet.zswap.batcherUrl);
  });

  it('refuses unknown networks, unknown keys and invalid values', () => {
    expect(() => resolveNetwork('mainnet')).toThrow(NetworkConfigError);
    expect(() => resolveNetwork('stagenet', { nope: {} } as never)).toThrow(/unknown network setting "nope"/);
    expect(() => resolveNetwork('stagenet', { bridge: {} } as never)).toThrow(/unknown network setting "bridge"/);
    expect(() => resolveNetwork('stagenet', { zswap: { kernel: 'x' } } as never)).toThrow(/zswap.kernel/);
    expect(() => resolveNetwork('stagenet', { zswap: { kernelUrl: 'not a url' } })).toThrow(/zswap.kernelUrl/);
  });

  it('the default asset sets (plan 00046, data): every token on stagenet and on the local stack', () => {
    expect(NETWORK_DEFAULT_ASSETS.stagenet).toBeNull();
    expect(NETWORK_DEFAULT_ASSETS.undeployed).toBeNull();
  });

  it('the default pairs (data): four stagenet pairs the vendored registry can trade, one without twUSDC', () => {
    const pairs = NETWORK_DEFAULT_PAIRS.stagenet!;
    expect(pairs).toEqual(['twBTC/twUSDC', 'twETH/twUSDC', 'twUSDM/twUSDC', 'twETH/twBTC']);
    const { pairs: resolved, warnings } = resolvePairs(stagenetRegistry(), undefined, pairs);
    expect(warnings).toEqual([]);
    expect(resolved.map((p) => p.id)).toEqual(pairs);
    expect(NETWORK_DEFAULT_PAIRS.undeployed).toBeNull();
  });

  it('never carries a keyed RPC', () => {
    const json = JSON.stringify(PROFILES);
    expect(json).not.toMatch(/infura|alchemy|apikey|api_key/i);
  });
});
