// AA 00060 P8 (T8.1 text, T8.5, P8.2): Night Market's I-4 renderer against 00059's FROZEN vectors
// (test/fixtures/00059-account-registration-vectors.json, copied byte for byte from the injector
// @ f4d215c), the id, the expiry and origin rules, and the domain separation from every other text a
// wallet signs for this site (a build-time test: it fails the build if I-4's text ever collides).

import { createHash } from 'node:crypto';

import { base58 } from '@scure/base';
import nacl from 'tweetnacl';
import { describe, expect, it } from 'vitest';

import vectors from '../../../test/fixtures/00059-account-registration-vectors.json';
import {
  I4_STATUS,
  REGISTRATION_ERROR_CODES,
  REGISTRATION_FIRST_LINE,
  REGISTRATION_MAX_BYTES,
  injectorOrigin,
  parseRegistrationText,
  registrationExpiresAt,
  registrationExpiry,
  registrationId,
  registrationMessageText,
} from '../src/bridge/injector.js';
import { LANDING_KEY_FIRST_LINE } from '../src/bridge/landing-key.js';
import { MARKET_LABELS } from '../src/market-label.js';
import { assertSafeEd25519Message } from '../src/passport/ed25519.js';
import { verifyEd25519Strict } from '../src/solana-auth.js';

const utf8 = (s: string) => new TextEncoder().encode(s);
const sha = (s: string | Uint8Array) => createHash('sha256').update(s).digest();

describe("P8.2 00059's frozen I-4 vectors", () => {
  it('is the frozen version', () => {
    expect(I4_STATUS).toBe('FROZEN 2026-10-04 (00059 @ f4d215c)');
    expect(vectors.format).toBe(REGISTRATION_FIRST_LINE);
    expect(vectors.maxBytes).toBe(REGISTRATION_MAX_BYTES);
    expect(vectors.firstLineBytes).toBe(utf8(REGISTRATION_FIRST_LINE).length);
    expect(REGISTRATION_ERROR_CODES).toContain('method-not-allowed');
  });

  it('every valid text: rendered byte for byte from its fields, its size, its SHA-256 and its test signature', () => {
    expect(vectors.valid).toHaveLength(4);
    for (const v of vectors.valid) {
      const text = registrationMessageText({ ...v.fields, expires: v.fields.expiresAt });
      expect(text).toBe(v.text);
      expect(utf8(text).length).toBe(v.bytes);
      expect(sha(text).toString('hex')).toBe(v.sha256);
      expect(parseRegistrationText(v.text)).toEqual({ ...v.fields, expires: v.fields.expiresAt, expiresAt: undefined });
      // The test key: seed = sha256(<the note's quoted string>); Ed25519 is deterministic.
      const seed = sha(/seed sha256\("([^"]+)"\)/.exec(v.signer.note)![1]!);
      const kp = nacl.sign.keyPair.fromSeed(new Uint8Array(seed));
      expect(Buffer.from(kp.publicKey).toString('hex')).toBe(v.signer.publicKeyHex);
      expect(base58.encode(kp.publicKey)).toBe(v.fields.solanaAddress);
      expect(Buffer.from(nacl.sign.detached(utf8(text), kp.secretKey)).toString('hex')).toBe(v.signature);
      expect(verifyEd25519Strict(v.signer.publicKeyHex, utf8(text), Buffer.from(v.signature, 'hex'))).toBe(true);
      expect(() => assertSafeEd25519Message(utf8(text))).not.toThrow();
    }
  });

  it('every invalid text is refused by the strict re-render rule', () => {
    expect(vectors.invalid.length).toBeGreaterThanOrEqual(8);
    for (const v of vectors.invalid) expect(parseRegistrationText(v.text), v.why).toBeNull();
  });
});

describe('P8 the page-side rules', () => {
  it("the origin is WHATWG's serialisation of the configured injector URL", () => {
    expect(injectorOrigin('http://127.0.0.1:18899/')).toBe('http://127.0.0.1:18899');
    expect(injectorOrigin('https://RPC.example.org:443/path?q')).toBe('https://rpc.example.org');
    expect(injectorOrigin('http://[::1]:1234')).toBe('http://[::1]:1234');
    expect(injectorOrigin('ftp://x')).toBeNull();
    expect(injectorOrigin('not a url')).toBeNull();
  });

  it('the registration id is the injector’s', () => {
    const v = vectors.valid[0]!.fields;
    expect(registrationId(v.solanaAddress, v.accountAddress)).toBe(
      sha(`account:${v.solanaAddress}:${v.accountAddress}`).toString('hex').slice(0, 16),
    );
    expect(registrationId(v.solanaAddress, `0x${v.accountAddress.toUpperCase()}`)).toBe(
      registrationId(v.solanaAddress, v.accountAddress),
    );
  });

  it('the expiry stays inside now < Expires <= now + maxTtl, with a margin, in the years 1970-9999', () => {
    expect(registrationExpiresAt(1000, 600)).toBe(1540);
    expect(registrationExpiresAt(1000, 100)).toBe(1075);
    expect(registrationExpiresAt(1000.7, 1)).toBe(1001);
    for (const ttl of [1, 2, 5, 60, 600, 3600]) {
      const e = registrationExpiresAt(5000, ttl);
      expect(e > 5000 && e <= 5000 + ttl, String(ttl)).toBe(true);
    }
    expect(registrationExpiry(253_402_300_799)).toBe('9999-12-31 23:59:59 UTC');
    expect(() => registrationExpiry(253_402_300_800)).toThrow(RangeError);
    expect(() => registrationExpiry(-1)).toThrow(RangeError);
    expect(() => registrationExpiry(1.5)).toThrow(RangeError);
  });
});

describe('T8.5 domain separation (fails the build if I-4 ever collides)', () => {
  const first = REGISTRATION_FIRST_LINE;
  it("I-4's first line is not I-5's, not a Passport arm message's, not a market label (the envelope)", () => {
    expect(first).not.toBe(LANDING_KEY_FIRST_LINE);
    expect(LANDING_KEY_FIRST_LINE.startsWith(first)).toBe(false);
    expect(first.startsWith(LANDING_KEY_FIRST_LINE)).toBe(false);
    expect(first.startsWith('Site: ')).toBe(false);
    // An arm message's first line is `Site: ` + a 24-byte padded label (30 bytes); an envelope's is the
    // bare label (1-24 bytes): I-4's is 45 bytes.
    expect(utf8(first).length).toBe(45);
    for (const label of Object.values(MARKET_LABELS)) {
      expect(first).not.toBe(label);
      expect(first).not.toBe(`Site: ${label.padEnd(24, ' ')}`);
    }
  });
});
