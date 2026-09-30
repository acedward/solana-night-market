// B1.5: the relay's Ed25519 arm seam (../src/passport/ed25519-arm.ts) on Track A's client, and the
// relay's runtime split (spike 3 §6): the SDK (compact-js, midnight-js) resolves compact-runtime
// 0.19.0, the compiled account module 0.20.0, over one onchain-runtime-v4.

import { createRequire } from 'node:module';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { registryFor } from '@nightmarket/core';
import { describe, expect, it } from 'vitest';

import {
  Ed25519Device,
  ed25519AuthArgs,
  type Ed25519Authorisation,
} from '../../vendor/passport/contract/src/wallet/ed25519.js';
import {
  ED25519_SWAP_CIRCUIT,
  contractForEd25519Account,
  ed25519AccountCircuits,
  ed25519AccountWaves,
} from '../../vendor/passport/contract/src/wallet/wave-deploy.js';
import { makeWitnesses } from '../../vendor/passport/contract/src/wallet/witnesses.js';
import { SWAP_CIRCUIT, accountCircuitIds, accountWaves } from '../src/passport/account-shape.js';
import { ARM_CIRCUITS, DEVICE_ARM } from '../src/passport/arm.js';
import { CHECK_NOT_WIRED, ed25519Arm, ed25519ArmAuthArgs } from '../src/passport/ed25519-arm.js';
import type { PassportRuntime } from '../src/passport/runtime.js';

const tokens = registryFor('stagenet');
const arm = ed25519Arm({ network: 'stagenet', tokens });
const rt = {} as PassportRuntime;

describe("the relay's Ed25519 arm (B1.5 seam on Track A's client)", () => {
  it("names Track A's circuits, and the market account is Track A's ed25519 account with the offer circuit", () => {
    expect(arm.name).toBe(DEVICE_ARM);
    expect(DEVICE_ARM).toBe('ed25519');
    expect(SWAP_CIRCUIT).toBe(ED25519_SWAP_CIRCUIT);
    expect(ARM_CIRCUITS.openSwap).toBe(ED25519_SWAP_CIRCUIT);
    const shape = ed25519AccountCircuits({ withSwap: true });
    expect(accountCircuitIds()).toEqual(shape);
    expect(accountWaves()).toEqual(ed25519AccountWaves({ withSwap: true }));
    for (const c of Object.values(ARM_CIRCUITS)) expect(shape).toContain(c);
    // The compiled account restricted to that shape keeps exactly those circuits.
    const Restricted = contractForEd25519Account({ withSwap: true });
    const ours = new Restricted(makeWitnesses() as never) as unknown as { provableCircuits: object };
    expect(Object.keys(ours.provableCircuits).sort()).toEqual([...shape].sort());
  });

  it("expands an authorisation to the circuit's trailing arguments exactly as Track A's client does", () => {
    const auth = {
      arm: 'ed25519',
      pk: { x: 1n, y: 2n },
      use_counter: 7n,
      sig: { r: { x: 3n, y: 4n }, s: 5n },
      show: { label: [], nonce: { digits: [], top: 0n } },
    } as unknown as Ed25519Authorisation;
    expect(ed25519ArmAuthArgs(auth)).toEqual(ed25519AuthArgs(auth));
    expect(arm.authArgs(auth)).toEqual([auth.pk, 7n, auth.sig, auth.show]);
  });

  it("enrols the wallet's key as Track A's device, with the arm's own entry derivation", async () => {
    const seed = new Uint8Array(32).fill(7);
    const wallet = Ed25519Device.fromSeed(seed);
    const { device, entryAt } = await arm.registrationDevice(rt, { deviceKey: wallet.publicKeyHex, body: {} });
    expect(device).toBeInstanceOf(Ed25519Device);
    expect(device.publicKeyHex).toBe(wallet.publicKeyHex);
    expect(device.label).toBe('Night Market - stagenet');
    const account = new Uint8Array(32).fill(9);
    expect(entryAt(account, 0n, 1n)).toEqual(wallet.entryAt(account, 0n, 1n));
    // A key that is not a prime-order point is refused at enrolment.
    await expect(arm.registrationDevice(rt, { deviceKey: `01${'00'.repeat(31)}`, body: {} })).rejects.toThrow(
      /identity/,
    );
  });

  it('does not check calls yet (lane B3): every call is refused as not supported', async () => {
    for (const r of [
      await arm.checkGatedCall(rt, 'withdraw', 'ab'.repeat(32), {}, {}),
      await arm.checkTradeCall(rt, 'open-swap', 'ab'.repeat(32), {}, {}),
    ]) {
      expect(r).toEqual({ ok: false, code: 'not-supported', reason: CHECK_NOT_WIRED });
    }
  });
});

describe('compact-runtime isolation on the relay (spike 3 §6)', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const version = (req: NodeJS.Require, pkg: string) =>
    JSON.parse(readFileSync(req.resolve(`${pkg}/package.json`), 'utf8')).version as string;
  const dirOf = (req: NodeJS.Require, pkg: string) => realpathSync(dirname(req.resolve(`${pkg}/package.json`)));

  it('the SDK resolves 0.19.0; the account module (and Track A’s client) 0.20.0; one onchain-runtime-v4', () => {
    const relay = createRequire(join(here, '../src/main.ts'));
    const compactJs = createRequire(relay.resolve('@midnight-ntwrk/compact-js'));
    const midnightJs = createRequire(relay.resolve('@midnight-ntwrk/midnight-js-contracts'));
    expect(version(compactJs, '@midnight-ntwrk/compact-runtime')).toBe('0.19.0');
    expect(version(midnightJs, '@midnight-ntwrk/compact-runtime')).toBe('0.19.0');
    const accountModule = join(here, '../../vendor/passport/contract/contracts/managed/account/contract/index.js');
    expect(readFileSync(accountModule, 'utf8')).not.toMatch(/from '@midnight-ntwrk\/compact-runtime'/);
    const fromAccount = createRequire(accountModule);
    expect(version(fromAccount, '@midnight-ntwrk/compact-runtime-0.20')).toBe('0.20.0');
    const client = createRequire(join(here, '../../vendor/passport/contract/src/wallet/ed25519.ts'));
    expect(version(client, '@midnight-ntwrk/compact-runtime-0.20')).toBe('0.20.0');
    const onchain = (dir: string) =>
      realpathSync(createRequire(join(dir, 'package.json')).resolve('@midnightntwrk/onchain-runtime-v4'));
    expect(onchain(dirOf(fromAccount, '@midnight-ntwrk/compact-runtime-0.20'))).toBe(
      onchain(dirOf(compactJs, '@midnight-ntwrk/compact-runtime')),
    );
  });
});
