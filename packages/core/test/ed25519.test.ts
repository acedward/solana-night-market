// B1.5: the market's glue over Track A's Ed25519 arm client (../src/passport/ed25519.ts), run on the
// light-compiled account (compactc 0.35.0, its module on compact-runtime 0.20.0). The browser signs
// with `ed25519DeviceOf` and the relay rebuilds with `ed25519DeviceForCheck`: both must render the
// same bytes, and every refusal of the arm must reach the market.

import { createRequire } from 'node:module';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ed25519 } from '@noble/curves/ed25519.js';
import nacl from 'tweetnacl';
import { describe, expect, it } from 'vitest';

import { bytesToHex, hexToBytes } from '../src/hex.js';
import { NETWORK_NAMES } from '../src/network.js';
import { registryFor } from '../src/tokens/registry.js';
import type { OpenSwapPayload } from '../src/trade.js';
import {
  ED25519_LABEL_BYTES,
  ED25519_MESSAGE_BYTES,
  MARKET_LABELS,
  PASSPORT_CLIENT_COMMIT,
  assertDeviceKeyDecodes,
  assertSafeEd25519Message,
  callContext,
  ed25519DeviceForCheck,
  ed25519DeviceForKey,
  ed25519DeviceOf,
  ed25519SignatureHex,
  ed25519TokenResolver,
  marketLabel,
  openSwapArgs,
  passportAuthOf,
  pureCircuits,
  withdrawRequest,
} from '../src/passport/index.js';
import { testDevice } from './fixtures/test-signing.js';

const tokens = registryFor('stagenet');
const display = { network: 'stagenet', tokens } as const;
const twUSDC = tokens.bySymbol('twUSDC')!.midnightColour;
const twBTC = tokens.bySymbol('twBTC')!.midnightColour;
const ACCOUNT = '7775594c1df2808a'.padEnd(64, '3');
const ctx = { account: ACCOUNT, authNonce: 17n, networkSalt: '5a'.repeat(32) };

const withdraw = withdrawRequest({
  recipient: '11'.repeat(32),
  color: twUSDC,
  amount: '10000000',
  coin: { nonce: '33'.repeat(32), color: twUSDC, value: '25000000', mtIndex: '42' },
  authNonce: '17',
});

describe('what the browser and the relay agree on', () => {
  it('the label: one per network, at most 24 printable ASCII characters', () => {
    for (const n of NETWORK_NAMES) {
      expect(marketLabel(n)).toBe(MARKET_LABELS[n]);
      expect(marketLabel(n).length).toBeLessThanOrEqual(ED25519_LABEL_BYTES);
      expect(marketLabel(n)).toMatch(/^[\x20-\x7e]+$/);
    }
    expect(marketLabel('stagenet')).toBe('Night Market - stagenet');
  });

  it('the token display: symbol and decimals from the registry; an unrenderable symbol shows as unknown', () => {
    const resolve = ed25519TokenResolver(tokens);
    expect(resolve(twUSDC)).toEqual({ symbol: 'twUSDC', decimals: 6 });
    expect(resolve(twBTC)).toEqual({ symbol: 'twBTC', decimals: 8 });
    expect(resolve('00'.repeat(32))).toBeUndefined();
    for (const t of tokens.tokens) expect(resolve(t.midnightColour)?.symbol).toBe(t.symbol);
    const long = registryFor('undeployed', {
      tokens: [{ symbol: 'LONGSYMBOL', decimals: 6, midnightColour: 'ab'.repeat(32) }],
    });
    expect(ed25519TokenResolver(long)('ab'.repeat(32))).toBeUndefined();
  });

  it('the pinned client is Track A’s branch head', () => {
    expect(PASSPORT_CLIENT_COMMIT).toBe('451f7610e90000e0c5550877418122a04b85d0e6');
  });
});

describe('a gated call: the wallet signs the readable message, the relay re-checks it', () => {
  it('signs exactly the F3 text, and the relay rebuilds and accepts the same signature', async () => {
    const wallet = testDevice();
    const asked: Uint8Array[] = [];
    const device = ed25519DeviceOf(
      { ...wallet, signMessage: async (m) => (asked.push(m), wallet.signMessage(m)) },
      display,
    );
    const auth = await device.sign(callContext(ctx), withdraw, 3n);
    expect(asked).toHaveLength(1);
    const text = new TextDecoder().decode(asked[0]);
    expect(text.split('\n').slice(0, 3)).toEqual([
      'Night Market - stagenet ',
      'Withdraw shielded',
      `Amount ${'10.000000'.padStart(25)} twUSDC   [${twUSDC.slice(0, 8)}]`,
    ]);
    expect(asked[0]).toHaveLength(ED25519_MESSAGE_BYTES.withdrawShielded);
    expect(() => assertSafeEd25519Message(asked[0]!)).not.toThrow();

    // The wire form carries the wallet's own 64 bytes (R canonical, s unreduced), and they verify.
    const wire = passportAuthOf(auth);
    expect(wire.owner).toBe(wallet.deviceKey);
    expect(wire.useCounter).toBe('3');
    expect(wire.signature).toBe(bytesToHex(await wallet.signMessage(asked[0]!)));
    expect(ed25519SignatureHex(auth.sig)).toBe(wire.signature);
    expect(nacl.sign.detached.verify(asked[0]!, hexToBytes(wire.signature), hexToBytes(wallet.deviceKey))).toBe(true);

    // The relay: the same call, rebuilt from its arguments, with the browser's signature.
    const onRelay = ed25519DeviceForCheck(wire, display);
    const rebuilt = await onRelay.sign(callContext(ctx), withdraw, 3n);
    expect(bytesToHex(rebuilt.message)).toBe(bytesToHex(asked[0]!));
    expect(rebuilt.sig).toEqual(auth.sig);
    expect(rebuilt.show).toEqual(auth.show);
  });

  it('the relay refuses the signature for any other call, nonce, account, network salt or label', async () => {
    const wallet = testDevice();
    const wire = passportAuthOf(await ed25519DeviceOf(wallet, display).sign(callContext(ctx), withdraw, 0n));
    const check = (c: typeof ctx, d = display as { network: 'stagenet' | 'undeployed'; tokens: typeof tokens }) =>
      ed25519DeviceForCheck(wire, d).sign(callContext(c), withdraw, 0n);
    await expect(check(ctx)).resolves.toBeTruthy();
    const refused = /tweetnacl pre-check/;
    await expect(check({ ...ctx, authNonce: 18n })).rejects.toThrow(refused);
    await expect(check({ ...ctx, account: '44'.repeat(32) })).rejects.toThrow(refused);
    await expect(check({ ...ctx, networkSalt: '5b'.repeat(32) })).rejects.toThrow(refused);
    await expect(check(ctx, { network: 'undeployed', tokens })).rejects.toThrow(refused);
    // Another key's signature over the very same bytes.
    const other = testDevice();
    const forged = { ...wire, signature: bytesToHex(await other.signMessage(hexToBytes('00'))) };
    await expect(ed25519DeviceForCheck(forged, display).sign(callContext(ctx), withdraw, 0n)).rejects.toThrow();
  });

  it('a wallet that signs something else (a Ledger-wrapped message, another key) fails before any proof', async () => {
    const wallet = testDevice();
    const wrapped = ed25519DeviceOf(
      {
        ...wallet,
        signMessage: (m) =>
          wallet.signMessage(Uint8Array.from([0xff, ...new TextEncoder().encode('solana offchain'), ...m])),
      },
      display,
    );
    await expect(wrapped.sign(callContext(ctx), withdraw, 0n)).rejects.toThrow(/tweetnacl pre-check/);
  });
});

describe('an offer: the swap call is signed once, over its readable terms', () => {
  it('renders give and get with each token’s decimals and verifies on the relay', async () => {
    const payload: OpenSwapPayload = {
      giveColor: twUSDC,
      giveAmount: '10000000',
      wantColor: twBTC,
      wantAmount: '20000',
      wantNonce: '44'.repeat(32),
      wantEntry: '55'.repeat(192),
      changeEntry: '66'.repeat(192),
      validUntil: '0',
      coin: { nonce: '33'.repeat(32), color: twUSDC, value: '25000000', mtIndex: '7' },
      authNonce: '17',
    };
    const wallet = testDevice();
    const { call, coin } = openSwapArgs(payload);
    const device = ed25519DeviceOf(wallet, display);
    const preview = device.previewOffer(callContext(ctx), call, coin);
    expect(preview.text.split('\n').slice(1, 6)).toEqual([
      'Swap offer',
      `Give ${'10.000000'.padStart(25)} twUSDC   [${twUSDC.slice(0, 8)}]`,
      `Get  ${'0.00020000'.padStart(25)} twBTC    [${twBTC.slice(0, 8)}]`,
      `Taker ${'anyone'.padEnd(16)}`,
      `Expires ${'never'.padStart(20)}`,
    ]);
    const auth = await device.signOffer(callContext(ctx), call, coin, 1n);
    expect(bytesToHex(auth.message)).toBe(bytesToHex(preview.bytes));
    const rebuilt = await ed25519DeviceForCheck(passportAuthOf(auth), display).signOffer(
      callContext(ctx),
      call,
      coin,
      1n,
    );
    expect(rebuilt.sig).toEqual(auth.sig);
  });
});

describe('device keys: strict decoding', () => {
  it('accepts a wallet key, refuses the identity, small-order and non-canonical encodings', () => {
    expect(() => assertDeviceKeyDecodes(testDevice().deviceKey)).not.toThrow();
    const identity = `01${'00'.repeat(31)}`;
    expect(() => assertDeviceKeyDecodes(identity)).toThrow(/identity|small order/);
    // A small-order point (order 8): y = 0 is not on the curve for that x, so use the order-4 point (0, -1).
    const orderFour = `ec${'ff'.repeat(30)}7f`;
    expect(() => assertDeviceKeyDecodes(orderFour)).toThrow();
    // y >= p (non-canonical): p + 1 encodes the identity's y out of range.
    const nonCanonical = `ee${'ff'.repeat(30)}7f`;
    expect(() => assertDeviceKeyDecodes(nonCanonical)).toThrow();
    expect(() => assertDeviceKeyDecodes('zz')).toThrow(/64 hex/);
  });

  it('a device known by its key alone derives the arm’s own rolling entries (the contract’s pure circuit)', () => {
    const key = testDevice().deviceKey;
    const device = ed25519DeviceForKey(key, display);
    const account = hexToBytes(ACCOUNT, 32);
    const entry = device.entryAt(account, 0n, 2n);
    expect(entry).toHaveLength(32);
    const pk = ed25519.Point.fromBytes(hexToBytes(key, 32)).toAffine();
    expect(bytesToHex(entry)).toBe(
      bytesToHex(
        (pureCircuits as unknown as Record<string, (...a: unknown[]) => Uint8Array>).derive_device_entry_with_ed25519!(
          { bytes: account },
          { x: pk.x, y: pk.y },
          0n,
          2n,
        ),
      ),
    );
    expect(bytesToHex(device.entryAt(account, 0n, 3n))).not.toBe(bytesToHex(entry));
  });
});

describe('compact-runtime isolation (spike 3 §6)', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const account = join(here, '../../../vendor/passport/contract/contracts/managed/account/contract/index.js');

  it('the compiled account module imports compact-runtime 0.20.0, through the alias only', () => {
    const source = readFileSync(account, 'utf8');
    expect(source).toContain("checkRuntimeVersion('0.20.0')");
    expect(source).toContain("from '@midnight-ntwrk/compact-runtime-0.20'");
    expect(source).not.toMatch(/from '@midnight-ntwrk\/compact-runtime'/);
    const req = createRequire(account);
    expect(
      JSON.parse(readFileSync(req.resolve('@midnight-ntwrk/compact-runtime-0.20/package.json'), 'utf8')).version,
    ).toBe('0.20.0');
  });

  it('everything else keeps 0.19.0, and both wrap ONE onchain-runtime-v4', () => {
    const req = createRequire(import.meta.url);
    const v019 = realpathSync(dirname(req.resolve('@midnight-ntwrk/compact-runtime/package.json')));
    const v020 = realpathSync(dirname(req.resolve('@midnight-ntwrk/compact-runtime-0.20/package.json')));
    expect(JSON.parse(readFileSync(join(v019, 'package.json'), 'utf8')).version).toBe('0.19.0');
    const onchain = (dir: string) =>
      realpathSync(createRequire(join(dir, 'package.json')).resolve('@midnightntwrk/onchain-runtime-v4'));
    expect(onchain(v020)).toBe(onchain(v019));
  });
});
