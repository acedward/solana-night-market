// AA 00060 P1 (T1.1-T1.4): I-5, the landing key, against its independent vectors
// (fixtures/landing-key-v1.json, written by scripts/landing-key-vectors.ts from the interface text).

import { randomBytes } from 'node:crypto';

import { ed25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import { base58 } from '@scure/base';
import nacl from 'tweetnacl';
import { describe, expect, it, vi } from 'vitest';

import {
  LANDING_KEY_FIRST_LINE,
  LandingKeyError,
  deriveLandingMaster,
  isLandingOrigin,
  landingCheck,
  landingMasterFromSignature,
  landingMessage,
  landingMessageText,
  landingSeed,
  type LandingMessageParams,
} from '../src/bridge/landing-key.js';
import { landingKeyFor, landingKeysFromSeed } from '../src/bridge/landing-wallet.js';
import { MARKET_LABELS } from '../src/market-label.js';
import { offchainWrappings } from '../src/solana-signature.js';
import { assertSafeEd25519Message, ed25519PossessionMessage } from '../src/passport/ed25519.js';
import vectors from './fixtures/landing-key-v1.json';
import goldens from '../../../test/fixtures/messages-10b29b1.json';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const unhex = (h: string) => new Uint8Array(Buffer.from(h, 'hex'));
const SEED = unhex(vectors.inputs.signingKeySeed);
const kp = nacl.sign.keyPair.fromSeed(SEED);
const PARAMS: LandingMessageParams = {
  origin: vectors.inputs.origin,
  midnightNetwork: vectors.inputs.midnightNetwork,
  solanaGenesisHash: vectors.inputs.solanaGenesisHash,
  walletAddress: vectors.inputs.walletAddress,
};
/** A software wallet: RFC 8032 over exactly the bytes, returning a FRESH buffer each time. */
const software =
  (secretKey = kp.secretKey) =>
  (m: Uint8Array) =>
    nacl.sign.detached(m, secretKey);

/** A valid Ed25519 signature by the vector key whose nonce is RANDOM (an MPC or hedged signer):
 *  R = r·B for a random r, S = r + SHA-512(R ‖ A ‖ M)·a mod L. It verifies, but differs every time. */
function hedgedSign(message: Uint8Array): Uint8Array {
  const L = ed25519.Point.Fn.ORDER;
  const le = (b: Uint8Array) => b.reduceRight((v, x) => (v << 8n) | BigInt(x), 0n);
  const toLe = (v: bigint) => Uint8Array.from({ length: 32 }, (_, i) => Number((v >> (8n * BigInt(i))) & 0xffn));
  const { scalar } = ed25519.utils.getExtendedPublicKey(SEED);
  const r = le(randomBytes(64)) % L;
  const R = ed25519.Point.BASE.multiply(r).toBytes();
  const k = le(sha512(new Uint8Array([...R, ...kp.publicKey, ...message]))) % L;
  return new Uint8Array([...R, ...toLe((r + k * scalar) % L)]);
}

describe('T1.1 the I-5 vectors reproduce byte for byte', () => {
  it('the message', () => {
    const m = landingMessage(PARAMS);
    expect(hex(m)).toBe(vectors.message.hex);
    expect(landingMessageText(PARAMS)).toBe(vectors.message.text);
    expect(m.length).toBe(vectors.message.bytes);
    expect(vectors.inputs.walletAddress).toBe(base58.encode(kp.publicKey));
  });

  it('the master key and its check value from the signature', () => {
    expect(hex(nacl.sign.detached(landingMessage(PARAMS), kp.secretKey))).toBe(vectors.signature);
    expect(hex(landingMasterFromSignature(unhex(vectors.signature)))).toBe(vectors.master);
    expect(landingCheck(unhex(vectors.master))).toBe(vectors.check);
  });

  it('deriveLandingMaster gives the same check and per-transfer seeds', async () => {
    const master = await deriveLandingMaster(software(), PARAMS, kp.publicKey);
    expect(master.check).toBe(vectors.check);
    for (const t of vectors.transfers) {
      expect(hex(master.seedFor(t.account, BigInt(t.authNonce)))).toBe(t.seed);
      expect(hex(landingSeed(unhex(vectors.master), unhex(t.account), BigInt(t.authNonce)))).toBe(t.seed);
    }
    master.wipe();
    expect(master.live).toBe(false);
    expect(() => master.seedFor(vectors.transfers[0]!.account, 7n)).toThrow(/forgotten/);
  });

  it('the per-transfer keys (AA 00048 HD layout)', async () => {
    const master = await deriveLandingMaster(software(), PARAMS, kp.publicKey);
    for (const t of vectors.transfers) {
      const keys = landingKeyFor(master, t.account, BigInt(t.authNonce));
      expect(hex(keys.seed)).toBe(t.seed);
      expect(keys.coinPublicKey).toBe(t.coinPublicKey);
      expect(keys.encryptionPublicKey).toBe(t.encryptionPublicKey);
      expect(String(keys.dustSecretKey.publicKey)).toBe(t.dustPublicKey);
      keys.clear();
      expect(keys.seed.every((b) => b === 0)).toBe(true);
    }
    master.wipe();
  });
});

const randomField = (n: number, alphabet: string) =>
  Array.from({ length: n }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');

function randomParams(): LandingMessageParams {
  const local = ['127.0.0.1', 'localhost', '[::1]'][Math.floor(Math.random() * 3)]!;
  const origin =
    Math.random() < 0.5
      ? `https://${randomField(1 + Math.floor(Math.random() * 20), 'abcdefghijklmnopqrstuvwxyz0123456789')}.example`
      : `http://${local}:${10_000 + Math.floor(Math.random() * 50_000)}`;
  return {
    origin,
    midnightNetwork: randomField(1 + Math.floor(Math.random() * 32), 'abcdefghijklmnopqrstuvwxyz0123456789-'),
    solanaGenesisHash: base58.encode(randomBytes(32)),
    walletAddress: base58.encode(randomBytes(32)),
  };
}

describe('T1.2 domain separation', () => {
  it('the first line is reserved: never `Site: …` nor a market label', () => {
    expect(LANDING_KEY_FIRST_LINE.startsWith('Site: ')).toBe(false);
    for (const label of Object.values(MARKET_LABELS)) expect(LANDING_KEY_FIRST_LINE).not.toBe(label);
    expect(LANDING_KEY_FIRST_LINE.startsWith('solana-token-injector')).toBe(false);
  });

  it('1,000 random I-5 messages pass the arm guard and equal no golden or possession message', () => {
    const golden = new Set(goldens.messages.map((g) => g.hex));
    const firstLines = new Set(goldens.messages.map((g) => g.text.split('\n')[0]));
    for (let i = 0; i < 1000; i++) {
      const p = randomParams();
      const m = landingMessage(p);
      expect(() => assertSafeEd25519Message(m)).not.toThrow();
      expect(golden.has(hex(m))).toBe(false);
      const text = String.fromCharCode(...m);
      expect(firstLines.has(text.split('\n')[0])).toBe(false);
      const possession = ed25519PossessionMessage({
        label: MARKET_LABELS.undeployed,
        publicKeyBase58: p.walletAddress,
        purpose: 'Open a Night Market account',
        nonce: randomField(64, '0123456789abcdef'),
      });
      expect(hex(possession)).not.toBe(hex(m));
    }
  });

  it('the builder refuses each field outside its rule (one negative per rule)', () => {
    const cases: [Partial<LandingMessageParams>, keyof LandingMessageParams][] = [
      [{ origin: 'http://example.com' }, 'origin'], // http only for the local hosts
      [{ origin: 'https://Example.com' }, 'origin'], // lowercase
      [{ origin: 'https://example.com:443' }, 'origin'], // not canonical
      [{ origin: 'https://example.com/path' }, 'origin'],
      [{ origin: `https://${'a'.repeat(95)}.com` }, 'origin'], // over 100 characters
      [{ origin: 'https://exaémple.com' }, 'origin'], // not ASCII
      [{ midnightNetwork: 'Undeployed' }, 'midnightNetwork'],
      [{ midnightNetwork: 'a'.repeat(33) }, 'midnightNetwork'],
      [{ solanaGenesisHash: 'not-base58!' }, 'solanaGenesisHash'],
      [{ solanaGenesisHash: base58.encode(randomBytes(31)) }, 'solanaGenesisHash'],
      [{ walletAddress: base58.encode(randomBytes(33)) }, 'walletAddress'],
    ];
    for (const [patch, field] of cases) {
      let caught: unknown;
      try {
        landingMessage({ ...PARAMS, ...patch });
      } catch (e) {
        caught = e;
      }
      expect(caught, JSON.stringify(patch)).toBeInstanceOf(LandingKeyError);
      expect((caught as LandingKeyError).code).toBe('bad-field');
      expect((caught as LandingKeyError).field).toBe(field);
    }
    expect(isLandingOrigin('https://night-market.example:8443')).toBe(true);
    expect(isLandingOrigin('http://[::1]:5173')).toBe(true);
    expect(isLandingOrigin('https://[::1]')).toBe(false);
  });

  it('the expected values must match: the site network, the RPC genesis hash and the connected key', () => {
    const other = base58.encode(randomBytes(32));
    expect(() => landingMessage(PARAMS, { siteNetwork: 'stagenet' })).toThrow(/site's network/);
    expect(() => landingMessage(PARAMS, { rpcGenesisHash: other })).toThrow(/genesis hash/);
    expect(() => landingMessage(PARAMS, { publicKey: randomBytes(32) })).toThrow(/connected key/);
  });
});

describe('T1.3 signer cases', () => {
  it('a hedged signer → not-deterministic, nothing derived, both signatures zeroed', async () => {
    const given: Uint8Array[] = [];
    const copies: string[] = [];
    const hedged = (m: Uint8Array) => {
      const sig = hedgedSign(m);
      expect(nacl.sign.detached.verify(m, sig, kp.publicKey)).toBe(true);
      given.push(sig);
      copies.push(hex(sig));
      return sig;
    };
    let caught: unknown;
    try {
      await deriveLandingMaster(hedged, PARAMS, kp.publicKey);
    } catch (e) {
      caught = e;
    }
    expect((caught as LandingKeyError).code).toBe('not-deterministic');
    expect(given).toHaveLength(2);
    // Two valid signatures that differ (the wallet's own buffers), then both zeroed by the refusal.
    expect(copies[0]).not.toBe(copies[1]);
    expect(copies[0]).not.toBe('00'.repeat(64));
    for (const s of given) expect(s.every((b) => b === 0)).toBe(true);
  });

  it('a signature by another key → bad-signature, and the second prompt is never shown', async () => {
    const other = nacl.sign.keyPair();
    const asked = vi.fn(software(other.secretKey));
    await expect(deriveLandingMaster(asked, PARAMS, kp.publicKey)).rejects.toMatchObject({ code: 'bad-signature' });
    expect(asked).toHaveBeenCalledTimes(1);
  });

  it('a Ledger off-chain wrapping → hardware', async () => {
    const ledger = (m: Uint8Array) => {
      const wrapped = offchainWrappings(m, kp.publicKey)[0]!;
      return { signature: nacl.sign.detached(wrapped, kp.secretKey), signedMessage: wrapped };
    };
    await expect(deriveLandingMaster(ledger, PARAMS, kp.publicKey)).rejects.toMatchObject({ code: 'hardware' });
  });

  it('a stored check that differs → landing-key-changed (nothing returned)', async () => {
    await expect(
      deriveLandingMaster(software(), PARAMS, kp.publicKey, { storedCheck: '00'.repeat(16) }),
    ).rejects.toMatchObject({ code: 'landing-key-changed' });
    const ok = await deriveLandingMaster(software(), PARAMS, kp.publicKey, { storedCheck: vectors.check });
    expect(ok.check).toBe(vectors.check);
    ok.wipe();
  });

  it('a wallet returning the Wallet Standard shape works, and its signatures are wiped after derivation', async () => {
    const given: Uint8Array[] = [];
    const standard = (m: Uint8Array) => {
      const signature = nacl.sign.detached(m, kp.secretKey);
      given.push(signature);
      return { signature, signedMessage: m };
    };
    const master = await deriveLandingMaster(standard, PARAMS, kp.publicKey);
    expect(master.check).toBe(vectors.check);
    for (const s of given) expect(s.every((b) => b === 0)).toBe(true);
    master.wipe();
  });
});

describe('T1.4 per-transfer keys', () => {
  it('the same (account, nonce) gives the same keys; another account or nonce another coin key (100 samples)', () => {
    const master = unhex(vectors.master);
    const seen = new Set<string>();
    const base = landingKeysFromSeed(landingSeed(master, '11'.repeat(32), 7n));
    const again = landingKeysFromSeed(landingSeed(master, '11'.repeat(32), 7n));
    expect(again.coinPublicKey).toBe(base.coinPublicKey);
    seen.add(base.coinPublicKey);
    for (let i = 0; i < 100; i++) {
      const account = i % 2 === 0 ? hex(randomBytes(32)) : '11'.repeat(32);
      const nonce = i % 2 === 0 ? 7n : BigInt(8 + i);
      const k = landingKeysFromSeed(landingSeed(master, account, nonce));
      expect(seen.has(k.coinPublicKey)).toBe(false);
      seen.add(k.coinPublicKey);
      k.clear();
    }
    base.clear();
    again.clear();
  });

  it('seed_t is HKDF over the master with the transfer salt and info, never the master itself', () => {
    const master = unhex(vectors.master);
    const seed = landingSeed(master, '11'.repeat(32), 7n);
    // Structural: the only HKDF call takes the master as IKM, the transfer salt, and account ‖ u64be(nonce).
    const info = new Uint8Array(40);
    info.set(unhex('11'.repeat(32)));
    info[39] = 7;
    const expected = hkdf(sha256, master, new TextEncoder().encode('night-market/landing-key/v1/transfer'), info, 32);
    expect(hex(seed)).toBe(hex(expected));
    expect(hex(seed)).not.toBe(hex(master));
    expect(hex(seed)).not.toContain(hex(master).slice(0, 16));
  });
});
