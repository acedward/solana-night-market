// AA 00060 P4.2 (spec FR-014): the relay's start-up checks of a configured journey registry (I-1,
// BRIDGE_REGISTRY_FILE). The relay refuses to start when:
//   1. a bridged token is not in its own token list (TOKENS_FILE) with the same colour, symbol and
//      decimals: every message naming it would render differently on the site and the relay, and the
//      relay would refuse the site's signatures (`tokenListProblems`, checked in ../config.ts);
//   2. a bridge's DEPLOYED `lockForSolana` verifier key differs from the one in the key volume's bridge
//      bundle (`<managedPath>/bridge/keys/lockForSolana.verifier`), or the bridge is not deployed on
//      this network: Bridge out's second transaction would be proven with keys the contract does not
//      accept (`bridgeKeyProblems`, checked in ../main.ts once the key volume is loaded);
//   3. (AA 00060 P10.3, audit C11 / F-A10) a bridge's sealed `sourceMint` is not the registry's SPL mint:
//      the site would lock SPL tokens the bridge never mints.

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { TokenRegistry } from '@nightmarket/core';
import { encodeKey } from '@nightmarket/core/solana';
import type { BridgeRegistry } from '@nightmarket/core/bridge';

import { deployedVerifierDigests, verifierDigests } from '../prover/key-volume.js';

/** The circuit Bridge out proves on each bridge. */
export const BRIDGE_LOCK_CIRCUIT = 'lockForSolana';
/** The key volume's bridge bundle (the 00050 template's compiled bridge, AA 00060 P0.6). */
export const BRIDGE_BUNDLE = 'bridge';

/** Check 1: every bridged entry is in the relay's token list with the same colour, symbol and decimals. */
export function tokenListProblems(bridges: BridgeRegistry, tokens: TokenRegistry): string[] {
  const problems: string[] = [];
  for (const b of bridges.entries) {
    const t = tokens.byColour(b.colour);
    if (!t) problems.push(`${b.symbol} (colour ${b.colour}) is not in TOKENS_FILE's token list`);
    else {
      if (t.symbol !== b.symbol)
        problems.push(`${b.symbol} (colour ${b.colour}) is listed as ${t.symbol} in TOKENS_FILE`);
      if (t.decimals !== b.decimals) {
        problems.push(
          `${b.symbol} (colour ${b.colour}) has ${b.decimals} decimals in the registry, ${t.decimals} in TOKENS_FILE`,
        );
      }
    }
  }
  return problems;
}

/** A deployed contract's state, as the indexer's public data provider gives it (or null: none). */
export type ReadContractState = (address: string) => Promise<{
  operations(): unknown[];
  operation(op: never): { verifierKey?: Uint8Array } | undefined;
  data?: unknown;
} | null>;

/** Check 2: each bridge's deployed `lockForSolana` verifier key equals the key volume's. */
export async function bridgeKeyProblems(
  bridges: BridgeRegistry,
  managedPath: string,
  readState: ReadContractState,
  /** The bridge module's `ledger(state.data)` (check 3); without it the mint is not checked. */
  bridgeLedger?: (data: unknown) => { sourceMint: Uint8Array },
): Promise<string[]> {
  const bundle = join(managedPath, BRIDGE_BUNDLE);
  if (!existsSync(join(bundle, 'keys'))) {
    return [`the key volume has no bridge bundle (${BRIDGE_BUNDLE}/keys): Bridge out cannot be proven`];
  }
  const ours = verifierDigests(bundle)[BRIDGE_LOCK_CIRCUIT];
  if (!ours) return [`the key volume's bridge bundle has no ${BRIDGE_LOCK_CIRCUIT} verifier key`];
  const problems: string[] = [];
  for (const b of bridges.entries) {
    const state = await readState(b.bridgeContract);
    if (!state) {
      problems.push(`${b.symbol}: no bridge contract at ${b.bridgeContract} on this network`);
      continue;
    }
    const deployed = deployedVerifierDigests(state)[BRIDGE_LOCK_CIRCUIT];
    if (deployed === undefined)
      problems.push(`${b.symbol}: the bridge at ${b.bridgeContract} has no ${BRIDGE_LOCK_CIRCUIT} operation`);
    else if (deployed !== ours) {
      problems.push(
        `${b.symbol}: the bridge at ${b.bridgeContract} was deployed with another ${BRIDGE_LOCK_CIRCUIT} verifier key than the key volume's`,
      );
    }
    if (bridgeLedger) {
      let sealed: string | null = null;
      try {
        sealed = encodeKey(Uint8Array.from(bridgeLedger(state.data).sourceMint));
      } catch {
        problems.push(`${b.symbol}: the bridge at ${b.bridgeContract} has no readable source mint`);
      }
      if (sealed !== null && sealed !== b.splMint) {
        problems.push(
          `${b.symbol}: the bridge at ${b.bridgeContract} seals another SPL mint (${sealed}) than the registry's ${b.splMint}`,
        );
      }
    }
  }
  return problems;
}
