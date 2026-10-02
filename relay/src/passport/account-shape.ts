// The shape of every Night Market account: Track A's market account (`ed25519AccountWaves({ withSwap:
// true })`, `contractForEd25519Account`): the deposits, the Ed25519 arm's activation and seven gated
// circuits, and the offer circuit, in the client's two waves (the offer circuit rides the
// maintenance update that retires the authority). MN Bank's accounts also carried the five bridge
// circuits and the `evm` arm; Night Market has no bridge and no EVM arm (AA 00047).
//
// The circuit ids are the deployed contract's IDENTITY: a client whose compiled contract lists
// circuits the account does not carry cannot connect to it (findDeployedContract compares every
// verifier key), so this list must stay equal to what is deployed. relay/test/account-shape.test.ts
// checks it against the compiled contract once the submodule carries the arm (plan P6.1).

import {
  ED25519_SWAP_CIRCUIT,
  ed25519AccountCircuits,
  ed25519AccountWaves,
} from '../../../vendor/passport/contract/src/wallet/wave-deploy.js';

/** The offer circuit, the arm's make/take call (Track A's `ED25519_SWAP_CIRCUIT`). */
export const SWAP_CIRCUIT: string = ED25519_SWAP_CIRCUIT;

/** A market account: Track A's Ed25519 account shape with the offer circuit. */
const MARKET_ACCOUNT = { withSwap: true } as const;

/** Wave 1 (the node's measured ceiling of 8 operations: the deposits, the activation and five gated
 *  circuits) and wave 2 (the device-lifecycle pair and the offer circuit, inserted by the
 *  maintenance update that retires the authority). */
export function accountWaves(): { waveOne: string[]; waveTwo: string[] } {
  return ed25519AccountWaves(MARKET_ACCOUNT);
}

/** Every circuit a Night Market account carries. */
export function accountCircuitIds(): string[] {
  return ed25519AccountCircuits(MARKET_ACCOUNT);
}

/** The compiled account contract restricted to the circuits a Night Market account carries. */
export function restrictToAccountShape<C extends new (...args: never[]) => object>(Contract: C): C {
  const keep = new Set(accountCircuitIds());
  const Base = Contract as unknown as new (...args: unknown[]) => { provableCircuits: Record<string, unknown> };
  class NightMarketAccountContract extends Base {
    constructor(...args: unknown[]) {
      super(...args);
      for (const id of Object.keys(this.provableCircuits)) if (!keep.has(id)) delete this.provableCircuits[id];
    }
  }
  return NightMarketAccountContract as unknown as C;
}
