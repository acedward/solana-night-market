// AA 00060 P4.3 (spec FR-018): the site's journey registry (config.json `bridges`, I-1) checked against
// the site's own Midnight network and its Solana RPC's genesis hash. Bridge in and Bridge out (lanes
// L-IN, L-OUT) act only on a registry this check accepts; otherwise the page says why and offers neither.
//
// P10.3 (audit C11 / F-A10): each token is also checked against its bridge's own deployment record
// (I-3 `GET /deployment`): a bridge that names another SPL mint, program, contract, colour or decimals
// than the registry refuses bridging, naming the token. A bridge that does not answer (or answers no
// record) does not stop the page: following a transfer needs the bridge anyway, and the market's relay
// checks its own copy of the registry against the bridge contract's sealed ledger at start.

import { PROFILES, type NetworkName } from '@nightmarket/core';
import {
  BridgeRegistryError,
  parseJourneyRegistry,
  type BridgeEntry,
  type BridgeRegistry,
} from '@nightmarket/core/bridge';

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

const hexOf = (v: unknown) => (typeof v === 'string' ? v.toLowerCase().replace(/^0x/, '') : v);

/** What a bridge's own deployment record (I-3 `GET /deployment`) says differently from the registry's
 *  entry: the field names, or [] (also when the bridge does not answer or answers no record). */
export async function deploymentMismatch(entry: BridgeEntry, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  let d: Record<string, unknown>;
  try {
    const res = await fetchImpl(`${entry.bridgeApi}/deployment`, {
      headers: { accept: 'application/json' },
      redirect: 'error',
      credentials: 'omit',
      signal: AbortSignal.timeout(8_000),
    });
    if (res.status !== 200) return [];
    const body: unknown = await res.json();
    if (!body || typeof body !== 'object') return [];
    d = body as Record<string, unknown>;
  } catch {
    return [];
  }
  const out: string[] = [];
  if (d.splMint !== entry.splMint) out.push('SPL mint');
  if (d.bridgeProgram !== entry.bridgeProgram) out.push('Solana program');
  if (hexOf(d.bridgeContract) !== entry.bridgeContract) out.push('Midnight contract');
  if (hexOf(d.colour) !== entry.colour) out.push('colour');
  if (d.splMintDecimals !== entry.decimals) out.push('decimals');
  return out;
}

/** Check `bridges` (I-1) for this site: its Midnight network, the Solana RPC's genesis hash, and each
 *  token's bridge deployment record. */
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
    const mismatches = await Promise.all(
      registry.entries.map(async (e) => ({ e, fields: await deploymentMismatch(e, fetchImpl) })),
    );
    const bad = mismatches.filter((m) => m.fields.length > 0);
    if (bad.length > 0) {
      return {
        state: 'refused',
        reason: `Bridging is unavailable: ${bad
          .map((m) => `the bridge for ${m.e.symbol} names another ${m.fields.join(', ')} than this site's token list`)
          .join('; ')}.`,
      };
    }
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
