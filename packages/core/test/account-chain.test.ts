// AA 00047 P9.S (spec FR-004b, audit C3, questions Q26 and Q31): the browser reads its account from
// the public indexer and checks it is the market's own, controlled by this wallet alone.
//
// Every state here is REAL serialised ContractState: built by the compiled account's constructor with
// the fields a case needs (./fixtures/account-state.ts), or the live stagenet account A as the public
// indexer served it (test/fixtures/stagenet-account-a.json, read-only, 2026-10-01).

import { readFileSync } from 'node:fs';

import { sha256 } from '@noble/hashes/sha2.js';
import { x25519 } from '@noble/curves/ed25519.js';
import nacl from 'tweetnacl';
import { describe, expect, it } from 'vitest';

import { bytesToHex, hexToBytes } from '../src/hex.js';
import {
  PINNED_ACCOUNT_KEYS,
  accountCheckText,
  checkMarketAccount,
  compareVerifierKeys,
  decodeAccountState,
  ed25519DeviceForKey,
  networkSaltFor,
  type MarketAccountExpectation,
} from '../src/passport/index.js';
import { FIXTURE_VERIFIER_KEYS, accountStateHex, type AccountStateSpec } from './fixtures/account-state.js';

const ACCOUNT = '7e'.repeat(32);
const STAGENET_SALT = networkSaltFor('stagenet');
const device = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
const DEVICE = bytesToHex(device.publicKey);
const ENC = bytesToHex(x25519.getPublicKey(new Uint8Array(32).fill(9)));

const honest: AccountStateSpec = { account: ACCOUNT, deviceKey: DEVICE, encKey: ENC, salt: STAGENET_SALT };
const expectation = (over: Partial<MarketAccountExpectation> = {}): MarketAccountExpectation => ({
  deviceKey: DEVICE,
  encPublicKey: ENC,
  networkSalt: STAGENET_SALT,
  verifierKeys: PINNED_ACCOUNT_KEYS.circuits,
  ...over,
});
const decode = async (spec: AccountStateSpec) => decodeAccountState(spec.account, await accountStateHex(spec));
const codes = (c: { problems: Array<{ code: string }> }) => c.problems.map((p) => p.code);

describe('the pinned verifier keys of this build', () => {
  // relay/test/pinned-account-keys.test.ts checks the circuits are exactly the market shape the relay
  // deploys (Track A's `ed25519AccountCircuits({ withSwap: true })`).
  it('are each the SHA-256 of the key set’s verifier key', () => {
    expect(Object.keys(FIXTURE_VERIFIER_KEYS).sort()).toEqual(Object.keys(PINNED_ACCOUNT_KEYS.circuits).sort());
    for (const [circuit, digest] of Object.entries(PINNED_ACCOUNT_KEYS.circuits)) {
      expect([circuit, bytesToHex(sha256(hexToBytes(FIXTURE_VERIFIER_KEYS[circuit]!)))]).toEqual([circuit, digest]);
    }
    expect(PINNED_ACCOUNT_KEYS.keySet).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('decodeAccountState (the indexer’s serialised ContractState, decoded in the page)', () => {
  it('reads every field a gated call binds, the operations’ key digests, the authority and the balances', async () => {
    const entry = 'ab'.repeat(192);
    const s = await decode({
      ...honest,
      authNonce: 7n,
      useCounter: 3n,
      inbox: [entry, 'cd'.repeat(192)],
      unshielded: [['ef'.repeat(32), 25_000_000n]],
    });
    expect(s.view).toEqual({
      account: ACCOUNT,
      booted: true,
      deviceCount: 1,
      deviceEpoch: '0',
      devices: [bytesToHex(ed25519DeviceForKey(DEVICE).entryAt(hexToBytes(ACCOUNT), 0n, 3n))],
      authNonce: '7',
      inboxCount: '2',
      encKey: ENC,
      networkSalt: STAGENET_SALT,
    });
    expect(s.operations).toEqual(PINNED_ACCOUNT_KEYS.circuits);
    expect(s.authority).toEqual({ committee: 0, threshold: 1 });
    expect(s.inbox).toEqual([entry, 'cd'.repeat(192)]);
    expect(s.unshielded).toEqual([{ colour: 'ef'.repeat(32), amount: '25000000' }]);
  });

  it('refuses bytes that are not a contract state', () => {
    expect(() => decodeAccountState(ACCOUNT, 'deadbeef')).toThrow(/does not decode/);
  });

  it('reads the LIVE stagenet market account A as the public indexer served it', () => {
    const f = JSON.parse(
      readFileSync(new URL('../../../test/fixtures/stagenet-account-a.json', import.meta.url), 'utf8'),
    ) as {
      account: string;
      state: string;
    };
    const s = decodeAccountState(f.account, f.state);
    // Deployed by the market with the key set this build pins, authority retired, one device.
    expect(compareVerifierKeys(s.operations, PINNED_ACCOUNT_KEYS.circuits)).toMatchObject({ equal: true });
    expect(s.authority).toEqual({ committee: 0, threshold: 1 });
    expect(s.view).toMatchObject({ booted: true, deviceCount: 1, networkSalt: STAGENET_SALT });
    expect(s.view.devices).toHaveLength(1);
    // Checked as if this browser held its key: everything but the device (whose key is not ours) passes.
    const c = checkMarketAccount(s, expectation({ deviceKey: DEVICE, encPublicKey: s.view.encKey }));
    expect(codes(c)).toEqual(['devices']);
  });
});

describe('checkMarketAccount (audit C3: the account the relay made, checked by the browser)', () => {
  it('passes the honest account, fresh and later, and finds the device’s use counter', async () => {
    const fresh = checkMarketAccount(await decode(honest), expectation({ fresh: true }));
    expect(fresh).toEqual({ ok: true, problems: [], useCounter: 0n });
    const later = checkMarketAccount(await decode({ ...honest, authNonce: 12n, useCounter: 12n }), expectation());
    expect(later).toEqual({ ok: true, problems: [], useCounter: 12n });
  });

  it('refuses a second device, an empty device set, and another wallet’s device', async () => {
    const second = bytesToHex(
      ed25519DeviceForKey(bytesToHex(nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(8)).publicKey)).entryAt(
        hexToBytes(ACCOUNT),
        0n,
        0n,
      ),
    );
    expect(codes(checkMarketAccount(await decode({ ...honest, extraDevices: [second] }), expectation()))).toEqual([
      'devices',
    ]);
    expect(codes(checkMarketAccount(await decode({ ...honest, noDevice: true }), expectation()))).toEqual([
      'not-booted',
      'devices',
    ]);
    const other = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(5));
    const c = checkMarketAccount(await decode({ ...honest, deviceKey: bytesToHex(other.publicKey) }), expectation());
    expect(codes(c)).toEqual(['devices']);
    expect(accountCheckText(c)).toBe('Its one device is not your wallet.');
  });

  it('refuses a live maintenance authority (its circuits could still be changed)', async () => {
    expect(
      codes(checkMarketAccount(await decode({ ...honest, authority: { committee: 1, threshold: 1 } }), expectation())),
    ).toEqual(['authority-live']);
    expect(
      codes(checkMarketAccount(await decode({ ...honest, authority: { committee: 0, threshold: 0 } }), expectation())),
    ).toEqual(['authority-live']);
  });

  it('refuses another verifier key, a missing circuit and an extra circuit', async () => {
    const swapped = {
      ...FIXTURE_VERIFIER_KEYS,
      withdraw_shielded_with_ed25519: FIXTURE_VERIFIER_KEYS.append_inbox_with_ed25519!,
    };
    const c1 = checkMarketAccount(await decode({ ...honest, operations: swapped }), expectation());
    expect(codes(c1)).toEqual(['verifier-keys']);
    expect(c1.problems[0]!.detail).toBe('different: withdraw_shielded_with_ed25519');
    const { add_device_with_ed25519: _drop, ...missing } = FIXTURE_VERIFIER_KEYS;
    expect(
      checkMarketAccount(await decode({ ...honest, operations: missing }), expectation()).problems[0]!.detail,
    ).toBe('missing: add_device_with_ed25519');
    const extra = { ...FIXTURE_VERIFIER_KEYS, bridge_withdraw_refund: FIXTURE_VERIFIER_KEYS.deposit_shielded! };
    expect(checkMarketAccount(await decode({ ...honest, operations: extra }), expectation()).problems[0]!.detail).toBe(
      'extra: bridge_withdraw_refund',
    );
  });

  it('refuses another encryption key and another network’s salt', async () => {
    const otherEnc = bytesToHex(x25519.getPublicKey(new Uint8Array(32).fill(3)));
    expect(codes(checkMarketAccount(await decode({ ...honest, encKey: otherEnc }), expectation()))).toEqual([
      'enc-key',
    ]);
    expect(
      codes(checkMarketAccount(await decode({ ...honest, salt: networkSaltFor('undeployed') }), expectation())),
    ).toEqual(['network-salt']);
  });

  it('refuses a "fresh" account that has already signed something or whose device moved on', async () => {
    expect(codes(checkMarketAccount(await decode({ ...honest, authNonce: 1n }), expectation({ fresh: true })))).toEqual(
      ['not-fresh'],
    );
    expect(
      codes(checkMarketAccount(await decode({ ...honest, useCounter: 1n }), expectation({ fresh: true }))),
    ).toEqual(['devices']);
  });

  it('knows the stagenet salt (keccak256 of "midnight:stagenet"), as account A carries it', () => {
    expect(networkSaltFor('stagenet')).toBe('f2358ecb621d3ac4f112375eedb0cda74bbcae8af2991dd5577d22f8acef44a3');
  });
});
