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
import { LABEL_RULE } from '../src/market-label.js';
import { registryFor } from '../src/tokens/registry.js';
import type { OpenSwapPayload } from '../src/trade.js';
import {
  ED25519_LABEL_BYTES,
  ED25519_MESSAGE_BYTES,
  ED25519_MESSAGE_FORMAT,
  MARKET_LABELS,
  SITE_LINE_PREFIX,
  siteLine,
  PASSPORT_CLIENT_COMMIT,
  ED25519_SITE_PREFIX,
  assertDeviceKeyDecodes,
  assertSafeEd25519Message,
  callContext,
  cancelOffersRequest,
  ed25519DeviceForCheck,
  ed25519DeviceForKey,
  ed25519DeviceOf,
  ed25519SignatureHex,
  ed25519TokenResolver,
  isRenderableLabel,
  isRenderableTokenDisplay,
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
const ctx = { account: ACCOUNT, authNonce: 17n, networkSalt: '5a'.repeat(32), encKey: '6b'.repeat(32) };

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

  // AA 00047 P10 (questions Q36; P10.C's F3 v3, passport `599327b`): the circuit puts a fixed
  // "Site: " in front of the label and refuses a label with a leading space, a run of spaces, or no
  // text; the market's labels follow that rule, and the signing gate requires the exact site line.
  it('the label is words with single spaces, and the site line is the client’s prefix + the label (Q36)', () => {
    for (const n of NETWORK_NAMES) expect(marketLabel(n)).toMatch(LABEL_RULE);
    for (const bad of ['', ' Night Market', 'Night  Market', 'Night Market ', 'Night\tMarket'])
      expect(LABEL_RULE.test(bad)).toBe(false);
    // Pinned at F3 v3 (passport `599327b`, P10.I): the prefix is the client's `ED25519_SITE_PREFIX`.
    expect(ED25519_MESSAGE_FORMAT).toBe('F3 v3');
    expect(SITE_LINE_PREFIX).toBe('Site: ');
    expect(SITE_LINE_PREFIX).toBe(ED25519_SITE_PREFIX);
    expect(siteLine('stagenet')).toBe('Site: Night Market - stagenet');
    expect(siteLine('undeployed')).toBe('Site: Night Market - local');
  });

  it('the market’s label rule is the pinned client’s own (`isRenderableLabel`, the circuit’s rule)', () => {
    for (const n of NETWORK_NAMES) expect(isRenderableLabel(marketLabel(n))).toBe(true);
    // The client and the market agree on every case P10.C's parity corpus names.
    for (const label of [
      'Night Market - stagenet',
      'Cancel all open offers',
      'a',
      '',
      ' ',
      ' Night Market',
      '   Night Market',
      'Night  Market',
      'Night\tMarket',
      'Night\u007fMarket',
      'Night Märket',
      'Night\nMarket',
      'Night\u0000Market',
    ])
      expect([label, isRenderableLabel(label)]).toEqual([label, LABEL_RULE.test(label)]);
    // Trailing spaces are the padding the circuit adds, which the client accepts; the market's labels
    // carry none (LABEL_RULE is stricter there, never looser).
    expect(isRenderableLabel('Night Market ')).toBe(true);
    expect(LABEL_RULE.test('Night Market ')).toBe(false);
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

  it('the token display follows the F3 v2 client’s own rule (isRenderableTokenDisplay): no space in a symbol', () => {
    // The registry refuses a symbol with a space; the rule is the client's all the same, so a
    // registry built another way can never make the page and the circuit disagree.
    const spaced = {
      byColour: (c: string) => (c === 'ab'.repeat(32) ? { symbol: 'tw USD', decimals: 6 } : undefined),
    } as unknown as typeof tokens;
    expect(ed25519TokenResolver(spaced)('ab'.repeat(32))).toBeUndefined();
    expect(isRenderableTokenDisplay({ symbol: 'tw USD', decimals: 6 })).toBe(false);
    expect(isRenderableTokenDisplay({ symbol: 'twUSDC', decimals: 19 })).toBe(false);
    expect(isRenderableTokenDisplay({ symbol: 'twUSDC', decimals: 6 })).toBe(true);
  });

  it('the pinned client is Track A’s branch head', () => {
    expect(PASSPORT_CLIENT_COMMIT).toBe('599327b918b55afc95d6c98a89bcd15f4e8b0d53');
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
    // F3 v3 (questions Q25 B′, Q32, Q36): the site line "Site: <label>", then the enforced base units
    // and the full token id, then the site's name and decimals marked as the site's label.
    expect(text.split('\n').slice(0, 7)).toEqual([
      'Site: Night Market - stagenet ',
      'Withdraw shielded',
      `Base units ${'10000000'.padEnd(24)}`,
      `Token ${twUSDC}`,
      `This site labels it: ${'10.000000 twUSDC'.padEnd(34)}`,
      `To key ${'11'.repeat(8)}`,
      `Account ${ACCOUNT.slice(0, 16)} nonce ${'17'.padEnd(20)}`,
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
    expect(preview.text.split('\n').slice(1, 10)).toEqual([
      'Swap offer',
      `Give base units ${'10000000'.padEnd(24)}`,
      `Give token ${twUSDC}`,
      `This site labels it: ${'10.000000 twUSDC'.padEnd(34)}`,
      `Get base units ${'20000'.padEnd(24)}`,
      `Get token ${twBTC}`,
      `This site labels it: ${'0.00020000 twBTC'.padEnd(34)}`,
      `Taker ${'anyone'.padEnd(16)}`,
      `Expires ${'never'.padEnd(23)}`,
    ]);
    // A real signed expiry reads as a UTC date and time (audit C6).
    const until = openSwapArgs({ ...payload, validUntil: '1790868312' });
    expect(device.previewOffer(callContext(ctx), until.call, until.coin).text).toContain(
      '\nExpires 2026-10-01 15:25:12 UTC\n',
    );
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

describe('the cancel (questions Q30): rotate_enc_key with the account’s current key', () => {
  it('reads "Cancel all open offers" for the current key, and a key change for any other', async () => {
    const wallet = testDevice();
    const device = ed25519DeviceOf(wallet, display);
    const same = cancelOffersRequest({ newKey: ctx.encKey, authNonce: '17' });
    const lines = device.preview(callContext(ctx), same).text.split('\n');
    expect(lines.slice(1, 3)).toEqual(['Cancel all open offers', 'Your key does not change']);
    const other = cancelOffersRequest({ newKey: '7d'.repeat(32), authNonce: '17' });
    expect(device.preview(callContext(ctx), other).text.split('\n')[1]).toBe('Rotate encryption key ');
    // The relay rebuilds with the account's on-chain key: a cancel signed against another "current"
    // key is other bytes, and is refused.
    const wire = passportAuthOf(await device.sign(callContext(ctx), same, 0n));
    await expect(ed25519DeviceForCheck(wire, display).sign(callContext(ctx), same, 0n)).resolves.toBeTruthy();
    await expect(
      ed25519DeviceForCheck(wire, display).sign(callContext({ ...ctx, encKey: '7d'.repeat(32) }), same, 0n),
    ).rejects.toThrow(/tweetnacl pre-check/);
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
