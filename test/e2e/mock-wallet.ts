// A MOCK Wallet Standard wallet with a chosen PROFILE (AA 00060; it generalises ./mock-phantom.ts): its
// name, version, chains and features, and each account's features, so the page can be run against
// "Phantom" and against "Nightly" (NIGHTLY_PROFILE is the profile the owner's G-NIGHTLY part A recorded
// on 2026-10-05: evidence/00060-night-market-bridge-wallet/p2/report-2-pass-20261005T003042Z.md). The key lives in the TEST process; message signing has a
// software wallet's semantics (tweetnacl RFC 8032 over exactly the bytes), and the transaction features
// sign the wire transaction's message in the fee-payer slot. `solana:signAndSendTransaction` hands the
// signed transaction to `send` (the test's mock RPC).
//
// Modes: 'software'; 'hedged' (valid signatures with a random nonce: differ every time, as MPC or
// hedged signers do); 'ledger' (the off-chain message wrapping); 'reject' (4001); 'other-key'; 'drop'
// (the request never answers and no prompt shows). `dropWithinMs` models G-NIGHTLY run 1: a request
// that arrives within that many ms after the previous one answered is dropped the same way.
// `extraWallets` registers more wallets under other chains (Nightly also registers Sui, Aptos, IOTA and
// Cedra wallets named "Nightly"); they have no Solana feature.
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

/** Nightly's Solana wallet as G-NIGHTLY part A recorded it (owner run 2, 2026-10-05): no
 *  `solana:localnet` in either chain list, yet it accepted `solana:localnet` as a transaction's chain. */
export const NIGHTLY_PROFILE: WalletProfile = {
  name: 'Nightly',
  version: '1.0.0',
  chains: ['solana:mainnet', 'solana:mainnet-beta', 'solana:testnet', 'solana:devnet'],
  features: {
    'standard:connect': '1.0.0',
    'standard:disconnect': '1.0.0',
    'standard:events': '1.0.0',
    'solana:signAndSendTransaction': '1.0.0',
    'solana:signTransaction': '1.0.0',
    'solana:signMessage': '1.1.0',
    'solana:signIn': '1.0.0',
  },
  accountFeatures: ['solana:signAndSendTransaction', 'solana:signMessage', 'solana:signTransaction'],
  accountChains: ['solana:devnet', 'solana:testnet', 'solana:mainnet'],
};

/** The other wallets Nightly registers under the same name (their chains only; no Solana feature). */
export const NIGHTLY_OTHER_WALLETS: WalletProfile[] = (
  ['sui:mainnet', 'aptos:mainnet', 'iota:mainnet', 'cedra:mainnet'] as const
).map((chain) => ({
  name: 'Nightly',
  version: '1.0.0',
  chains: [chain],
  features: { 'standard:connect': '1.0.0', 'standard:disconnect': '1.0.0', 'standard:events': '1.0.0' },
  accountFeatures: [],
  accountChains: [chain],
}));

export type MockWalletMode = 'software' | 'hedged' | 'ledger' | 'reject' | 'other-key' | 'drop';

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
  /** Drop a request that arrives within this many ms after the previous one answered (0: never). */
  dropWithinMs: number;
  /** For each request: when it arrived and when it answered (ms; null when dropped). */
  timings: { at: number; answeredAt: number | null; dropped: boolean }[];
  /** Keep the NEXT request waiting (its window "open"); call the returned function to let it answer. */
  holdNext(): () => void;
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
  opts: {
    profile?: WalletProfile;
    seed?: Uint8Array;
    send?: (wireBase64: string) => Promise<string>;
    extraWallets?: WalletProfile[];
  } = {},
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
    dropWithinMs: 0,
    timings: [],
    holdNext() {
      let release!: () => void;
      hold = new Promise<void>((r) => (release = r));
      return () => release();
    },
  };
  let hold: Promise<void> | null = null;
  const waitIfHeld = async () => {
    if (!hold) return;
    const h = hold;
    hold = null;
    await h;
  };
  let lastAnswered = Number.NEGATIVE_INFINITY;
  /** Records the request's timing; true when it must be dropped (it then never answers). */
  const arrive = (): { drop: boolean; done: () => void } => {
    const at = Date.now();
    const drop = wallet.mode === 'drop' || (wallet.dropWithinMs > 0 && at - lastAnswered < wallet.dropWithinMs);
    const t = { at, answeredAt: null as number | null, dropped: drop };
    wallet.timings.push(t);
    return {
      drop,
      done: () => {
        t.answeredAt = Date.now();
        lastAnswered = t.answeredAt;
      },
    };
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
    const req = arrive();
    if (req.drop) return { hang: true };
    await waitIfHeld();
    req.done();
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
    const req = arrive();
    if (req.drop) return { hang: true };
    await waitIfHeld();
    req.done();
    if (wallet.mode === 'reject') return { error: { code: 4001, message: 'User rejected the request.' } };
    const signed = signWire(wireHex);
    if (!send) return { signedTransaction: bytesToHex(signed) };
    if (!opts.send) return { error: { code: -32603, message: 'the mock wallet has no RPC' } };
    await opts.send(Buffer.from(signed).toString('base64'));
    return { signature: bytesToHex(splitTransaction(signed).signatures[0]!) };
  });

  await page.addInitScript(
    ({ profile: p, address, publicKeyHex, extras }) => {
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
                if (r.hang) await new Promise<never>(() => undefined);
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
                if (r.hang) await new Promise<never>(() => undefined);
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
                if (r.hang) await new Promise<never>(() => undefined);
                if (r.error) throw fail(r.error as { code: number; message: string });
                return { signature: hex(r.signature as string) };
              }),
            ),
        },
        // Night Market never uses Sign In With Solana; the feature is listed as Nightly lists it.
        'solana:signIn': {
          signIn: async () => {
            throw fail({ code: -32601, message: 'the mock wallet does not sign in' });
          },
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
      // Wallets for other chains, under any name (no Solana feature, no account).
      for (const x of extras) {
        const other = {
          version: x.version,
          name: x.name,
          icon: wallet.icon,
          chains: x.chains,
          accounts: [],
          features: {
            'standard:connect': { version: '1.0.0', connect: async () => ({ accounts: [] }) },
            'standard:events': { version: '1.0.0', on: () => () => undefined },
          },
        };
        const reg = (api: { register(w: unknown): void }) => api.register(other);
        window.addEventListener('wallet-standard:app-ready', (e) =>
          reg((e as CustomEvent<{ register(w: unknown): void }>).detail),
        );
        window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: reg }));
      }
    },
    {
      profile,
      address: wallet.address,
      publicKeyHex: bytesToHex(kp.publicKey),
      extras: (opts.extraWallets ?? []).map((x) => ({ name: x.name, version: x.version, chains: x.chains })),
    },
  );
  return wallet;
}
