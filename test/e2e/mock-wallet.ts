// A MOCK Wallet Standard wallet with a chosen PROFILE (AA 00060; it generalises ./mock-phantom.ts): its
// name, version, chains and features, and each account's features, so the page can be run against
// "Phantom" and against "Nightly" (P2: the profile comes from the owner's G-NIGHTLY report; until then
// NIGHTLY_PROFILE is a placeholder, UNVERIFIED). The key lives in the TEST process; message signing has a
// software wallet's semantics (tweetnacl RFC 8032 over exactly the bytes), and the transaction features
// sign the wire transaction's message in the fee-payer slot. `solana:signAndSendTransaction` hands the
// signed transaction to `send` (the test's mock RPC).
//
// Modes: 'software'; 'hedged' (valid signatures with a random nonce: differ every time, as MPC or
// hedged signers do); 'ledger' (the off-chain message wrapping); 'reject' (4001); 'other-key'.
// Every request is recorded, and every signature it returned, so a test can check none leaks.

import { randomBytes } from 'node:crypto';

import { ed25519 } from '@noble/curves/ed25519.js';
import { sha512 } from '@noble/hashes/sha2.js';
import type { Page } from '@playwright/test';
import nacl from 'tweetnacl';

import { bytesToHex, hexToBytes } from '../../packages/core/src/hex.js';
import { offchainWrappings } from '../../packages/core/src/solana-signature.js';
import { solanaAddressOf } from '../../packages/core/src/signing.js';
import { splitTransaction } from '../../packages/core/src/solana/tx.js';

export interface WalletProfile {
  name: string;
  version: string;
  chains: string[];
  /** Feature name → version. */
  features: Record<string, string>;
  accountFeatures: string[];
  accountChains: string[];
}

export const PHANTOM_PROFILE: WalletProfile = {
  name: 'Phantom',
  version: '1.0.0',
  chains: ['solana:mainnet', 'solana:devnet', 'solana:testnet'],
  features: {
    'standard:connect': '1.0.0',
    'standard:disconnect': '1.0.0',
    'standard:events': '1.0.0',
    'solana:signMessage': '1.1.0',
    'solana:signTransaction': '1.0.0',
    'solana:signAndSendTransaction': '1.0.0',
  },
  accountFeatures: ['solana:signMessage', 'solana:signTransaction', 'solana:signAndSendTransaction'],
  accountChains: ['solana:mainnet', 'solana:devnet', 'solana:testnet'],
};

/** PLACEHOLDER (UNVERIFIED): replaced by the feature set the owner's G-NIGHTLY report records (P2). */
export const NIGHTLY_PROFILE: WalletProfile = {
  ...PHANTOM_PROFILE,
  name: 'Nightly',
  chains: ['solana:mainnet', 'solana:devnet', 'solana:testnet', 'solana:localnet'],
  accountChains: ['solana:mainnet', 'solana:devnet', 'solana:testnet', 'solana:localnet'],
};

export type MockWalletMode = 'software' | 'hedged' | 'ledger' | 'reject' | 'other-key';

export interface MockWalletRequest {
  kind: 'signMessage' | 'signTransaction' | 'signAndSendTransaction';
  bytes: Uint8Array;
  chain?: string;
}

export interface MockWallet {
  profile: WalletProfile;
  address: string;
  publicKey: Uint8Array;
  mode: MockWalletMode;
  requests: MockWalletRequest[];
  /** Every signature it returned (hex), messages and transactions alike. */
  signatures: string[];
}

function hedgedSign(message: Uint8Array, seed: Uint8Array, publicKey: Uint8Array): Uint8Array {
  const L = ed25519.Point.Fn.ORDER;
  const le = (b: Uint8Array) => b.reduceRight((v, x) => (v << 8n) | BigInt(x), 0n);
  const toLe = (v: bigint) => Uint8Array.from({ length: 32 }, (_, i) => Number((v >> (8n * BigInt(i))) & 0xffn));
  const { scalar } = ed25519.utils.getExtendedPublicKey(seed);
  const r = le(randomBytes(64)) % L;
  const R = ed25519.Point.BASE.multiply(r).toBytes();
  const k = le(sha512(new Uint8Array([...R, ...publicKey, ...message]))) % L;
  return new Uint8Array([...R, ...toLe((r + k * scalar) % L)]);
}

export async function installMockWallet(
  page: Page,
  opts: { profile?: WalletProfile; seed?: Uint8Array; send?: (wireBase64: string) => Promise<string> } = {},
): Promise<MockWallet> {
  const profile = opts.profile ?? PHANTOM_PROFILE;
  const seed = opts.seed ?? randomBytes(32);
  const kp = nacl.sign.keyPair.fromSeed(seed);
  const other = nacl.sign.keyPair();
  const wallet: MockWallet = {
    profile,
    address: solanaAddressOf(bytesToHex(kp.publicKey)),
    publicKey: kp.publicKey,
    mode: 'software',
    requests: [],
    signatures: [],
  };
  const sign = (bytes: Uint8Array): { signature: Uint8Array; signedMessage: Uint8Array } => {
    switch (wallet.mode) {
      case 'hedged':
        return { signature: hedgedSign(bytes, seed, kp.publicKey), signedMessage: bytes };
      case 'ledger': {
        const wrapped = offchainWrappings(bytes, kp.publicKey)[0]!;
        return { signature: nacl.sign.detached(wrapped, kp.secretKey), signedMessage: wrapped };
      }
      case 'other-key':
        return { signature: nacl.sign.detached(bytes, other.secretKey), signedMessage: bytes };
      default:
        return { signature: nacl.sign.detached(bytes, kp.secretKey), signedMessage: bytes };
    }
  };
  const signWire = (wireHex: string): Uint8Array => {
    const wire = hexToBytes(wireHex);
    const { message } = splitTransaction(wire);
    const signature = nacl.sign.detached(message, kp.secretKey);
    wallet.signatures.push(bytesToHex(signature));
    const out = Uint8Array.from(wire);
    out.set(signature, 1); // the fee payer's slot (the probe's transactions have one signer)
    return out;
  };

  await page.exposeFunction('__mockWalletSign', async (messageHex: string) => {
    const bytes = hexToBytes(messageHex);
    wallet.requests.push({ kind: 'signMessage', bytes });
    if (wallet.mode === 'reject') return { error: { code: 4001, message: 'User rejected the request.' } };
    const r = sign(bytes);
    wallet.signatures.push(bytesToHex(r.signature));
    return { signature: bytesToHex(r.signature), signedMessage: bytesToHex(r.signedMessage) };
  });
  await page.exposeFunction('__mockWalletSignTx', async (wireHex: string, chain: string, send: boolean) => {
    wallet.requests.push({
      kind: send ? 'signAndSendTransaction' : 'signTransaction',
      bytes: hexToBytes(wireHex),
      chain,
    });
    if (wallet.mode === 'reject') return { error: { code: 4001, message: 'User rejected the request.' } };
    const signed = signWire(wireHex);
    if (!send) return { signedTransaction: bytesToHex(signed) };
    if (!opts.send) return { error: { code: -32603, message: 'the mock wallet has no RPC' } };
    await opts.send(Buffer.from(signed).toString('base64'));
    return { signature: bytesToHex(splitTransaction(signed).signatures[0]!) };
  });

  await page.addInitScript(
    ({ profile: p, address, publicKeyHex }) => {
      const hex = (h: string) => Uint8Array.from((h.match(/../g) ?? []).map((b) => parseInt(b, 16)));
      const toHex = (u: Uint8Array) => Array.from(u, (b) => b.toString(16).padStart(2, '0')).join('');
      const w = window as unknown as {
        __mockWalletSign(m: string): Promise<Record<string, unknown>>;
        __mockWalletSignTx(t: string, chain: string, send: boolean): Promise<Record<string, unknown>>;
      };
      const fail = (e: { code: number; message: string }) => Object.assign(new Error(e.message), { code: e.code });
      const account = {
        address,
        publicKey: hex(publicKeyHex),
        chains: p.accountChains,
        features: p.accountFeatures,
        label: 'Mock account',
      };
      let connected = false;
      const all: Record<string, unknown> = {
        'standard:connect': {
          connect: async () => {
            connected = true;
            return { accounts: [account] };
          },
        },
        'standard:disconnect': { disconnect: async () => void (connected = false) },
        'standard:events': { on: () => () => undefined },
        'solana:signMessage': {
          signMessage: (...inputs: Array<{ message: Uint8Array }>) =>
            Promise.all(
              inputs.map(async (i) => {
                const r = await w.__mockWalletSign(toHex(i.message));
                if (r.error) throw fail(r.error as { code: number; message: string });
                return { signature: hex(r.signature as string), signedMessage: hex(r.signedMessage as string) };
              }),
            ),
        },
        'solana:signTransaction': {
          signTransaction: (...inputs: Array<{ transaction: Uint8Array; chain?: string }>) =>
            Promise.all(
              inputs.map(async (i) => {
                const r = await w.__mockWalletSignTx(toHex(i.transaction), i.chain ?? '', false);
                if (r.error) throw fail(r.error as { code: number; message: string });
                return { signedTransaction: hex(r.signedTransaction as string) };
              }),
            ),
        },
        'solana:signAndSendTransaction': {
          signAndSendTransaction: (...inputs: Array<{ transaction: Uint8Array; chain: string }>) =>
            Promise.all(
              inputs.map(async (i) => {
                const r = await w.__mockWalletSignTx(toHex(i.transaction), i.chain, true);
                if (r.error) throw fail(r.error as { code: number; message: string });
                return { signature: hex(r.signature as string) };
              }),
            ),
        },
      };
      const features = Object.fromEntries(
        Object.entries(p.features)
          .filter(([name]) => name in all)
          .map(([name, version]) => [name, { version, ...(all[name] as object) }]),
      );
      const wallet = {
        version: p.version,
        name: p.name,
        icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxIDEiLz4=',
        chains: p.chains,
        get accounts() {
          return connected ? [account] : [];
        },
        features,
      };
      const register = (api: { register(w: unknown): void }) => api.register(wallet);
      window.addEventListener('wallet-standard:app-ready', (e) =>
        register((e as CustomEvent<{ register(w: unknown): void }>).detail),
      );
      window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: register }));
    },
    { profile, address: wallet.address, publicKeyHex: bytesToHex(kp.publicKey) },
  );
  return wallet;
}
