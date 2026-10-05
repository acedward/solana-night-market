// AA 00060 P4.3 (spec FR-018): the site's journey registry (config.json `bridges`, I-1) checked against
// the site's own Midnight network and its Solana RPC's genesis hash. Bridge in and Bridge out (lanes
// L-IN, L-OUT) act only on a registry this check accepts; otherwise the page says why and offers neither.

import { PROFILES, type NetworkName } from '@nightmarket/core';
import { BridgeRegistryError, parseJourneyRegistry, type BridgeRegistry } from '@nightmarket/core/bridge';

import type { SolanaRpcConfig } from '../config.js';

export type BridgeCheck =
  | { state: 'none' }
  | { state: 'ready'; registry: BridgeRegistry; genesisHash: string; solana: SolanaRpcConfig }
  | { state: 'refused'; reason: string };

/** The Solana RPC's genesis hash (`getGenesisHash`). */
export async function rpcGenesisHash(rpcUrl: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const res = await fetchImpl(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getGenesisHash', params: [] }),
  });
  const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
  if (typeof body.result !== 'string') throw new Error(body.error?.message ?? 'no genesis hash');
  return body.result;
}

/** Check `bridges` (I-1) for this site: its Midnight network, and the Solana RPC's genesis hash. */
export async function checkBridges(
  bridges: unknown,
  network: NetworkName,
  solana: SolanaRpcConfig | null | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<BridgeCheck> {
  if (bridges === undefined || bridges === null) return { state: 'none' };
  if (!solana)
    return { state: 'refused', reason: 'Bridging is not set up: this site has no Solana RPC (config.json `solana`).' };
  let genesisHash: string;
  try {
    genesisHash = await rpcGenesisHash(solana.rpcUrl, fetchImpl);
  } catch {
    return { state: 'refused', reason: "Bridging is unavailable: the site's Solana RPC does not answer." };
  }
  if (solana.genesisHash && solana.genesisHash !== genesisHash) {
    return {
      state: 'refused',
      reason: "Bridging is unavailable: the site's Solana RPC is on another Solana network than the site expects.",
    };
  }
  try {
    const registry = parseJourneyRegistry(bridges, {
      midnightNetwork: PROFILES[network].midnightNetworkId,
      solanaGenesisHash: genesisHash,
    });
    return { state: 'ready', registry, genesisHash, solana };
  } catch (e) {
    if (!(e instanceof BridgeRegistryError)) throw e;
    const why =
      e.reason === 'wrong-network'
        ? `the token registry is for another Midnight network than this site's (${PROFILES[network].midnightNetworkId})`
        : e.reason === 'wrong-genesis-hash'
          ? "the token registry is for another Solana network than the site's Solana RPC"
          : `the token registry is not valid (${e.reason})`;
    return { state: 'refused', reason: `Bridging is unavailable: ${why}.` };
  }
}
