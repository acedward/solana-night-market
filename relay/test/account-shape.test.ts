// The Night Market account shape (relay/src/passport/account-shape.ts): the device arm's circuits
// and the offer circuit, no bridge and no EVM arm. The circuit list IS a deployed account's
// identity. The checks against the compiled contract run once the submodule carries the arm
// (plan P6.1: vendor/passport at Track A's branch); until then they are skipped.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { Contract } from '../../vendor/passport/contract/src/wallet/contract.js';
import { makeWitnesses } from '../../vendor/passport/contract/src/wallet/witnesses.js';
import {
  SWAP_CIRCUIT,
  accountCircuitIds,
  accountWaves,
  restrictToAccountShape,
} from '../src/passport/account-shape.js';
import { ARM_CIRCUITS, DEVICE_ARM } from '../src/passport/arm.js';

const info = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL('../../vendor/passport/contract/contracts/managed/account/compiler/contract-info.json', import.meta.url),
    ),
    'utf8',
  ),
) as { circuits: Array<{ name: string; proof: boolean }> };
const armCompiled = info.circuits.some((c) => c.name === ARM_CIRCUITS.activate);

describe('the Night Market account shape', () => {
  it("is the device arm's circuits and the offer circuit: no bridge, no EVM arm", () => {
    const ids = accountCircuitIds();
    expect(ids).toContain(SWAP_CIRCUIT);
    for (const c of Object.values(ARM_CIRCUITS)) expect(ids).toContain(c);
    for (const c of ids) {
      expect(c).not.toMatch(/_with_evm$|^bridge_/);
      if (c !== 'deposit_shielded' && c !== 'deposit_unshielded') expect(c).toMatch(new RegExp(`_with_${DEVICE_ARM}$`));
    }
    const { waveOne, waveTwo } = accountWaves();
    expect([...waveOne, ...waveTwo].sort()).toEqual([...ids].sort());
    expect(waveOne).toContain(ARM_CIRCUITS.activate);
  });

  it.skipIf(!armCompiled)('keeps exactly those circuits of the compiled contract (P6.1)', () => {
    const ours = new (restrictToAccountShape(Contract))(makeWitnesses() as never) as { provableCircuits: object };
    expect(Object.keys(ours.provableCircuits).sort()).toEqual([...accountCircuitIds()].sort());
  });
});
