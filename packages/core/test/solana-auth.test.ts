// B3 (questions Q14): the relay envelope's Solana scheme. The wallet signs Track A's possession
// message whose nonce field is the envelope's digest; the relay verifies strictly. Valid → accepted;
// another key, another network, another account, another body, another relay nonce, a replay, a
// malleated or small-order signature → refused.

import { ed25519 } from '@noble/curves/ed25519.js';
import nacl from 'tweetnacl';
import { describe, expect, it } from 'vitest';

import { ED25519_LABEL_BYTES } from '../../../vendor/passport/contract/src/wallet/ed25519-message.js';
import {
  NO_ACCOUNT,
  RELAY_ACTIONS,
  buildRelayActionMessage,
  verifyRelayAction,
  type RelayActionMessage,
} from '../src/auth.js';
import { bytesToHex, hexToBytes } from '../src/hex.js';
import { MARKET_LABELS, MARKET_LABEL_BYTES, marketLabel } from '../src/market-label.js';
import { solanaAddressOf } from '../src/signing.js';
import {
  SOLANA_ENVELOPE_PURPOSES,
  isStrictEd25519Key,
  solanaEnvelopeDigest,
  solanaEnvelopeMessage,
  solanaEnvelopeText,
  solanaRelayActionScheme as scheme,
  verifyEd25519Strict,
} from '../src/solana-auth.js';

const L = ed25519.Point.Fn.ORDER;

function wallet(seed = nacl.randomBytes(32)) {
  const kp = nacl.sign.keyPair.fromSeed(seed);
  return {
    deviceKey: bytesToHex(kp.publicKey),
    sign: (m: Uint8Array) => nacl.sign.detached(m, kp.secretKey),
  };
}

const ACCOUNT = 'ab'.repeat(32);
const NONCE = `0x${'4e'.repeat(32)}`;

function envelope(
  owner: string,
  over: Partial<Parameters<typeof buildRelayActionMessage>[0]> = {},
): RelayActionMessage {
  return buildRelayActionMessage({
    action: 'demo-tokens',
    network: 'stagenet',
    owner,
    account: ACCOUNT,
    payload: {},
    nonce: NONCE,
    expiry: 1_900_000_000,
    ...over,
  });
}

describe('the market label (moved to the package root; Q12)', () => {
  it("is the arm's width and printable, one per network", () => {
    expect(MARKET_LABEL_BYTES).toBe(ED25519_LABEL_BYTES);
    expect(marketLabel('stagenet')).toBe('Night Market - stagenet');
    expect(marketLabel('undeployed')).toBe('Night Market - local');
    for (const l of Object.values(MARKET_LABELS)) expect(l.length).toBeLessThanOrEqual(24);
  });
});

describe('the Solana envelope message (what Phantom shows)', () => {
  it("is Track A's possession message: label, address, purpose, the envelope digest, no funds moved", () => {
    const w = wallet();
    const m = envelope(w.deviceKey);
    const text = solanaEnvelopeText(m);
    expect(text.split('\n')).toEqual([
      'Night Market - stagenet',
      'Prove you hold this key',
      `Key ${solanaAddressOf(w.deviceKey)}`,
      `For ${SOLANA_ENVELOPE_PURPOSES['demo-tokens']}`,
      `Nonce ${solanaEnvelopeDigest(m)}`,
      'This signature authorises nothing and moves no funds.',
    ]);
    // Printable ASCII only: never a Solana transaction, an off-chain message or SIWS (Track A's guard).
    for (const b of solanaEnvelopeMessage(m)) expect(b === 10 || (b >= 0x20 && b <= 0x7e)).toBe(true);
  });

  it('has a purpose line of at most 64 printable characters for every action', () => {
    for (const a of RELAY_ACTIONS) {
      expect(SOLANA_ENVELOPE_PURPOSES[a].length).toBeLessThanOrEqual(64);
      expect(SOLANA_ENVELOPE_PURPOSES[a]).toMatch(/^[\x20-\x7e]+$/);
    }
    expect(SOLANA_ENVELOPE_PURPOSES.register).toBe('Open a Night Market account');
  });

  it('binds every envelope field into the digest', () => {
    const w = wallet();
    const base = envelope(w.deviceKey);
    const d = solanaEnvelopeDigest(base);
    const variants: RelayActionMessage[] = [
      envelope(w.deviceKey, { action: 'register', account: undefined }),
      envelope(w.deviceKey, { network: 'undeployed' }),
      envelope(w.deviceKey, { account: 'cd'.repeat(32) }),
      envelope(w.deviceKey, { payload: { x: '1' } }),
      envelope(w.deviceKey, { nonce: `0x${'4f'.repeat(32)}` }),
      envelope(w.deviceKey, { expiry: 1_900_000_001 }),
      envelope(wallet().deviceKey),
    ];
    for (const v of variants) expect(solanaEnvelopeDigest(v)).not.toBe(d);
  });
});

describe('verification (the relay side)', () => {
  it('accepts the wallet signature over exactly those bytes', () => {
    const w = wallet();
    const m = envelope(w.deviceKey);
    expect(scheme.verify(m, w.sign(scheme.messageBytes(m)))).toBe(true);
  });

  it('refuses another key, another message, and every envelope field changed after signing', () => {
    const w = wallet();
    const m = envelope(w.deviceKey);
    const sig = w.sign(scheme.messageBytes(m));
    // Another key signs in the owner's name.
    expect(scheme.verify(m, wallet().sign(scheme.messageBytes(m)))).toBe(false);
    // The owner signed other bytes (for example the raw digest, or a Ledger-wrapped message).
    expect(scheme.verify(m, w.sign(hexToBytes(solanaEnvelopeDigest(m))))).toBe(false);
    for (const changed of [
      { ...m, network: 'undeployed' },
      { ...m, account: `0x${'cd'.repeat(32)}` },
      { ...m, payloadHash: `0x${'00'.repeat(32)}` },
      { ...m, nonce: `0x${'4f'.repeat(32)}` },
      { ...m, expiry: '1900000001' },
      { ...m, action: 'register' as const },
    ]) {
      expect(scheme.verify(changed, sig)).toBe(false);
    }
    // An unknown network has no label: refused, never thrown.
    expect(scheme.verify({ ...m, network: 'mainnet' }, sig)).toBe(false);
  });

  it('refuses a malleated signature (s + L), a truncated one, and R = identity', () => {
    const w = wallet();
    const m = envelope(w.deviceKey);
    const bytes = scheme.messageBytes(m);
    const sig = w.sign(bytes);
    const s = sig.slice(32);
    let v = 0n;
    for (let i = 31; i >= 0; i--) v = (v << 8n) | BigInt(s[i]!);
    v += L;
    const sPlusL = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
      sPlusL[i] = Number(v & 0xffn);
      v >>= 8n;
    }
    const malleated = new Uint8Array(64);
    malleated.set(sig.slice(0, 32));
    malleated.set(sPlusL, 32);
    expect(scheme.verify(m, malleated)).toBe(false);
    expect(scheme.verify(m, sig.slice(0, 63))).toBe(false);
    const identityR = new Uint8Array(64);
    identityR[0] = 1; // the identity's encoding (y = 1)
    identityR.set(sig.slice(32), 32);
    expect(scheme.verify(m, identityR)).toBe(false);
  });

  it('refuses owner keys that are not prime-order points (identity, small order, non-canonical)', () => {
    expect(isStrictEd25519Key(wallet().deviceKey)).toBe(true);
    expect(isStrictEd25519Key(`01${'00'.repeat(31)}`)).toBe(false); // the identity
    // A small-order point (order 8), a known torsion encoding.
    expect(isStrictEd25519Key('c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a')).toBe(false);
    expect(isStrictEd25519Key('ff'.repeat(32))).toBe(false); // y >= p
    const msg = new Uint8Array([1, 2, 3]);
    expect(verifyEd25519Strict(`01${'00'.repeat(31)}`, msg, new Uint8Array(64))).toBe(false);
  });

  it('works through the envelope rules: nonce single use, expiry, and the route binding', () => {
    const w = wallet();
    const issued = new Set([NONCE]);
    const used = new Set<string>();
    const consumeNonce = (n: string) => {
      if (used.has(n)) return 'used' as const;
      if (!issued.has(n)) return 'unknown' as const;
      used.add(n);
      return 'ok' as const;
    };
    const m = envelope(w.deviceKey);
    const signed = { message: m, signature: bytesToHex(w.sign(scheme.messageBytes(m))) };
    const opts = {
      expectedAction: 'demo-tokens' as const,
      network: 'stagenet',
      expectedAccount: ACCOUNT,
      payload: {},
      scheme,
      now: 1_899_999_900,
      maxTtlSeconds: 600,
      consumeNonce,
    };
    expect(verifyRelayAction(signed, opts)).toMatchObject({ ok: true, signer: w.deviceKey });
    expect(verifyRelayAction(signed, opts)).toMatchObject({ ok: false, code: 'replayed' });
    expect(verifyRelayAction(signed, { ...opts, expectedAccount: 'cd'.repeat(32) })).toMatchObject({
      ok: false,
      code: 'wrong-account',
    });
    expect(verifyRelayAction(signed, { ...opts, network: 'undeployed' })).toMatchObject({
      ok: false,
      code: 'wrong-network',
    });
    // Registration binds no account.
    const reg = envelope(w.deviceKey, {
      action: 'register',
      account: undefined,
      payload: { encPublicKey: 'ab'.repeat(32) },
    });
    expect(reg.account).toBe(NO_ACCOUNT);
    expect(scheme.verify(reg, w.sign(scheme.messageBytes(reg)))).toBe(true);
  });
});
