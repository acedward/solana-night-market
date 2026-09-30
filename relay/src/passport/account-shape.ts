// The shape of every Night Market account: the device arm's circuits (./arm.ts, Track A's Ed25519
// arm) and the offer circuit, deployed in the Passport client's default waves for that arm. MN
// Bank's accounts also carried the five bridge circuits and the `evm` arm; Night Market has no
// bridge and no EVM arm (AA 00047).
//
// The circuit ids are the deployed contract's IDENTITY: a client whose compiled contract lists
// circuits the account does not carry cannot connect to it (findDeployedContract compares every
// verifier key), so this list must stay equal to what is deployed. relay/test/account-shape.test.ts
// checks it against the compiled contract once the submodule carries the arm (plan P6.1).

import { accountCircuits, defaultWaves } from '../../../vendor/passport/contract/src/wallet/wave-deploy.js';
import { ARM_CIRCUITS, DEVICE_ARM } from './arm.js';

/** The offer circuit, the arm's make/take call. */
export const SWAP_CIRCUIT = ARM_CIRCUITS.openSwap;

// The pinned client's `Arm` type predates the Ed25519 arm: lane B3 / P6.1 moves the pin to the arm's
// branch, whose client names it.
const arm = DEVICE_ARM as never;

/** Wave 1 (the node's measured ceiling of 8 operations) and wave 2 (the arm's overflow and the
 *  offer circuit, inserted by the maintenance update that retires the authority). */
export function accountWaves(): { waveOne: string[]; waveTwo: string[] } {
  const waves = defaultWaves(arm);
  return { waveOne: waves.waveOne, waveTwo: [...waves.waveTwo, SWAP_CIRCUIT] };
}

/** Every circuit a Night Market account carries. */
export function accountCircuitIds(): string[] {
  return [...accountCircuits([arm]), SWAP_CIRCUIT];
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
