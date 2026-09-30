// The relay-action envelope's rules, with a TEST scheme (./fixtures/test-signing.ts): the Solana
// scheme is lane B3's, and until one is given every envelope is refused as `not-supported`.

import { describe, expect, it } from 'vitest';

import {
  CanonicalJsonError,
  NOT_SUPPORTED_REASON,
  NO_ACCOUNT,
  RELAY_ACTIONS,
  buildRelayActionMessage,
  canonicalJson,
  checkRelayActionBinding,
  payloadHash,
  verifyRelayAction,
  type VerifyRelayActionOptions,
} from '../src/auth.js';
import { bytesToHex } from '../src/hex.js';
import { testDevice, testScheme } from './fixtures/test-signing.js';

const NOW = 1_800_000_000;
const newNonce = () => bytesToHex(globalThis.crypto.getRandomValues(new Uint8Array(32)), true);

/** A nonce book like the relay's: issued nonces, each usable once. */
function nonceBook() {
  const issued = new Set<string>();
  const used = new Set<string>();
  return {
    issue(): string {
      const n = newNonce();
      issued.add(n);
      return n;
    },
    consume: (n: string): 'ok' | 'unknown' | 'used' => {
      if (used.has(n)) return 'used';
      if (!issued.has(n)) return 'unknown';
      issued.delete(n);
      used.add(n);
      return 'ok';
    },
  };
}

describe('canonical JSON and the payload hash', () => {
  it('sorts keys, drops undefined, renders bigints as strings', () => {
    expect(canonicalJson({ b: 1, a: [true, null, 'x'], c: undefined, d: 10n })).toBe(
      '{"a":[true,null,"x"],"b":1,"d":"10"}',
    );
    expect(payloadHash({ x: 1, y: 2 })).toBe(payloadHash({ y: 2, x: 1 }));
    expect(payloadHash({ x: 1 })).not.toBe(payloadHash({ x: 2 }));
  });

  it('is SHA-256 of the canonical JSON', () => {
    // sha256('{}') = 44136fa3…
    expect(payloadHash({})).toBe('0x44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a');
  });

  it('refuses values that do not have one JSON form', () => {
    expect(() => canonicalJson({ b: new Uint8Array(2) })).toThrow(CanonicalJsonError);
    expect(() => canonicalJson({ n: Number.NaN })).toThrow(CanonicalJsonError);
    expect(() => canonicalJson({ f: () => 1 })).toThrow(CanonicalJsonError);
  });
});

describe('the RelayAction envelope', () => {
  it('knows only Night Market actions (no bridge)', () => {
    expect([...RELAY_ACTIONS]).toEqual([
      'register',
      'withdraw',
      'append-inbox',
      'open-swap',
      'take',
      'demo-tokens',
      'withdraw-unshielded',
    ]);
  });

  it('names the device key as the owner, lowercase, and no account for registration', () => {
    const d = testDevice();
    const msg = buildRelayActionMessage({
      action: 'register',
      network: 'stagenet',
      owner: `0x${d.deviceKey.toUpperCase()}`,
      payload: { encPublicKey: 'ab' },
      nonce: newNonce(),
      expiry: NOW + 60,
    });
    expect(msg.owner).toBe(d.deviceKey);
    expect(msg.account).toBe(NO_ACCOUNT);
    expect(() =>
      buildRelayActionMessage({
        action: 'register',
        network: 'stagenet',
        owner: '0x0000000000000000000000000000000000000001',
        payload: {},
        nonce: newNonce(),
        expiry: NOW,
      }),
    ).toThrow();
  });
});

describe('verifyRelayAction', () => {
  const setup = (over: Partial<Parameters<typeof buildRelayActionMessage>[0]> = {}) => {
    const device = testDevice();
    const book = nonceBook();
    const payload = { encPublicKey: 'aa'.repeat(32), amount: '1000000' };
    const message = buildRelayActionMessage({
      action: 'register',
      network: 'stagenet',
      owner: device.deviceKey,
      payload,
      nonce: book.issue(),
      expiry: NOW + 120,
      ...over,
    });
    const signature = device.signEnvelope(message);
    const options: VerifyRelayActionOptions = {
      expectedAction: 'register',
      network: 'stagenet',
      payload,
      scheme: testScheme,
      now: NOW,
      maxTtlSeconds: 600,
      consumeNonce: book.consume,
    };
    return { device, book, payload, message, signature, options };
  };

  it('accepts a valid authorisation once, naming the device key as the signer', () => {
    const { device, message, signature, options } = setup();
    expect(verifyRelayAction({ message, signature }, options)).toMatchObject({ ok: true, signer: device.deviceKey });
  });

  it('refuses everything, as not supported, while no signature scheme is wired (lane B3)', () => {
    const { message, signature, options } = setup();
    let consumed = 0;
    const r = verifyRelayAction(
      { message, signature },
      { ...options, scheme: undefined, consumeNonce: () => (consumed++, 'ok') },
    );
    expect(r).toEqual({ ok: false, code: 'not-supported', reason: NOT_SUPPORTED_REASON });
    expect(consumed).toBe(0);
  });

  it('refuses a replay of the same authorisation', () => {
    const { message, signature, options } = setup();
    expect(verifyRelayAction({ message, signature }, options).ok).toBe(true);
    expect(verifyRelayAction({ message, signature }, options)).toMatchObject({ ok: false, code: 'replayed' });
  });

  it('refuses a nonce the relay never issued (or forgot on restart)', () => {
    const { device, payload, options } = setup();
    const message = buildRelayActionMessage({
      action: 'register',
      network: 'stagenet',
      owner: device.deviceKey,
      payload,
      nonce: newNonce(),
      expiry: NOW + 60,
    });
    expect(verifyRelayAction({ message, signature: device.signEnvelope(message) }, options)).toMatchObject({
      ok: false,
      code: 'unknown-nonce',
    });
  });

  it("refuses another device's signature", () => {
    const { message, options } = setup();
    expect(verifyRelayAction({ message, signature: testDevice().signEnvelope(message) }, options)).toMatchObject({
      ok: false,
      code: 'bad-signature',
    });
  });

  it('refuses an expired authorisation, and one that expires too far ahead', () => {
    const expired = setup({ expiry: NOW - 1 });
    expect(
      verifyRelayAction({ message: expired.message, signature: expired.signature }, expired.options),
    ).toMatchObject({ ok: false, code: 'expired' });
    const now = setup({ expiry: NOW });
    expect(verifyRelayAction({ message: now.message, signature: now.signature }, now.options)).toMatchObject({
      ok: false,
      code: 'expired',
    });
    const far = setup({ expiry: NOW + 601 });
    expect(verifyRelayAction({ message: far.message, signature: far.signature }, far.options)).toMatchObject({
      ok: false,
      code: 'expiry-too-far',
    });
  });

  it('refuses a body the signature does not cover', () => {
    const { message, signature, options } = setup();
    expect(
      verifyRelayAction(
        { message, signature },
        { ...options, payload: { ...(options.payload as object), amount: '999' } },
      ),
    ).toMatchObject({ ok: false, code: 'payload-mismatch' });
  });

  it('refuses another action, network or account', () => {
    const { message, signature, options } = setup();
    expect(verifyRelayAction({ message, signature }, { ...options, expectedAction: 'withdraw' })).toMatchObject({
      code: 'wrong-action',
    });
    expect(verifyRelayAction({ message, signature }, { ...options, network: 'undeployed' })).toMatchObject({
      code: 'wrong-network',
    });
    expect(verifyRelayAction({ message, signature }, { ...options, expectedAccount: '11'.repeat(32) })).toMatchObject({
      code: 'wrong-account',
    });
  });

  it('refuses a tampered message (another owner, or a later expiry)', () => {
    const { message, signature, options } = setup();
    const forged = { ...message, owner: testDevice().deviceKey };
    expect(verifyRelayAction({ message: forged, signature }, options)).toMatchObject({
      ok: false,
      code: 'bad-signature',
    });
    const later = { ...message, expiry: String(NOW + 300) };
    expect(verifyRelayAction({ message: later, signature }, options)).toMatchObject({
      ok: false,
      code: 'bad-signature',
    });
  });

  it('refuses a missing, malformed or garbage signature without consuming the nonce', () => {
    const { message, options, book } = setup();
    let consumed = 0;
    const counting = { ...options, consumeNonce: (n: string) => (consumed++, book.consume(n)) };
    expect(verifyRelayAction(undefined, counting)).toMatchObject({ code: 'malformed' });
    expect(verifyRelayAction({ message }, counting)).toMatchObject({ code: 'malformed' });
    expect(verifyRelayAction({ message, signature: `0x${'00'.repeat(65)}` }, counting)).toMatchObject({
      code: 'malformed',
    });
    expect(verifyRelayAction({ message, signature: '00'.repeat(64) }, counting)).toMatchObject({
      code: 'bad-signature',
    });
    expect(consumed).toBe(0);
  });

  it('checkRelayActionBinding: the same binding, without expiry or nonce (an executor re-check)', () => {
    const { message, signature, options } = setup({ expiry: NOW - 1000 });
    const { consumeNonce: _c, now: _n, maxTtlSeconds: _m, ...binding } = options;
    expect(checkRelayActionBinding({ message, signature }, binding)).toMatchObject({ ok: true });
    expect(checkRelayActionBinding({ message, signature }, { ...binding, payload: {} })).toMatchObject({
      code: 'payload-mismatch',
    });
    expect(checkRelayActionBinding({ message, signature }, { ...binding, scheme: undefined })).toMatchObject({
      code: 'not-supported',
    });
  });
});
