// Spec FR-005, the account half: before the relay spends a proof (or a demo-token pack) on an
// account, the account's ON-CHAIN verifier keys must be the relay's pinned key set, and its
// maintenance authority must be retired.
//
// The key volume's fingerprint pin (./../prover/keys.ts) ties the relay to one compiled key set;
// this check ties each ACCOUNT to it: every operation the account carries on chain must have exactly
// the verifier key the volume has for that circuit, and the account must carry exactly the market
// shape (./account-shape.ts: the deposits, the Ed25519 activation and seven gated circuits, the offer
// circuit). An account deployed from another build, with another arm, with an extra operation, or
// whose deployer kept a maintenance authority (so its circuits could still be swapped) is refused as
// "not a Night Market account" before any signature work.
//
// A verdict can only change through a maintenance update, and a retired authority can never make
// one, so an account that passes is remembered for the relay's lifetime; a failure is not cached
// (the next request reads the chain again).

import { join } from 'node:path';

import type { Logger } from '../log.js';
import { compareDeployed, deployedVerifierDigests, verifierDigests } from '../prover/key-volume.js';
import type { AccountKeysCheck } from './arm.js';

/** The slice of a deserialised on-chain `ContractState` this check reads. */
export interface OnChainAccountState {
  operations(): unknown[];
  operation(op: never): { verifierKey?: Uint8Array } | undefined;
  maintenanceAuthority?: { committee?: readonly unknown[]; threshold?: number | bigint };
}

export interface AccountKeysOptions {
  /** The key volume root (MIDNIGHT_MANAGED_PATH); the account bundle is `<root>/account`. */
  managedPath: string;
  /** The account's on-chain state, or null when there is no contract at the address. */
  readState(account: string): Promise<OnChainAccountState | null>;
  log?: Logger;
  /** The market shape's circuits (./account-shape.ts `accountCircuitIds`, which loads the compiled
   *  account: the caller passes them from the loaded runtime, so a keyless relay can import this). */
  circuits: readonly string[];
  /** For tests: the volume's verifier-key digests (default: read from `<managedPath>/account`). */
  ours?: Record<string, string>;
}

export const NOT_A_MARKET_ACCOUNT = "this is not a Night Market account deployed with this market's key set";

/** Whether the authority is retired: an empty committee that no threshold can ever satisfy. */
export function authorityRetired(state: OnChainAccountState): boolean | null {
  const a = state.maintenanceAuthority;
  if (!a || !Array.isArray(a.committee)) return null;
  return a.committee.length === 0 && Number(a.threshold ?? 0) > 0;
}

export function accountKeysChecker(o: AccountKeysOptions): AccountKeysCheck {
  const shape = new Set(o.circuits);
  let ours: Record<string, string> | null = null;
  const pinned = () => {
    if (ours) return ours;
    const all = o.ours ?? verifierDigests(join(o.managedPath, 'account'));
    ours = Object.fromEntries(Object.entries(all).filter(([c]) => shape.has(c)));
    const missing = [...shape].filter((c) => ours![c] === undefined);
    if (missing.length > 0) throw new Error(`the key volume lacks the verifier keys of ${missing.join(', ')}`);
    return ours;
  };
  const passed = new Set<string>();

  return async (accountRaw: string) => {
    const account = accountRaw.replace(/^0x/, '').toLowerCase();
    if (passed.has(account)) return { ok: true };
    const state = await o.readState(account);
    if (!state) return { ok: false, reason: 'no contract at this address' };
    const cmp = compareDeployed('account', pinned(), deployedVerifierDigests(state));
    if (!cmp.equal) {
      o.log?.info('account refused: its verifier keys are not the pinned set', {
        problems: cmp.problems.length,
        extraOnChain: cmp.extraOnChain.length,
      });
      return { ok: false, reason: NOT_A_MARKET_ACCOUNT };
    }
    const retired = authorityRetired(state);
    if (retired !== true) {
      o.log?.info('account refused: its maintenance authority is not retired', { readable: retired !== null });
      return {
        ok: false,
        reason: `${NOT_A_MARKET_ACCOUNT}: its maintenance authority is still live, so its circuits could be changed`,
      };
    }
    passed.add(account);
    return { ok: true };
  };
}
