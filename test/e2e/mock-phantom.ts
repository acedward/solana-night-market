// A MOCK PHANTOM for the browser walkthroughs (AA 00047 lane B2): a Wallet Standard wallet named
// "Phantom" (and, on request, Phantom's injected `window.phantom.solana`) whose key lives in the
// TEST process. Signing has Phantom's byte semantics for a software account: tweetnacl RFC 8032
// Ed25519 over exactly the bytes the page passes, no prefix, no pre-hash. Modes reproduce what the
// page must survive: a Ledger account (the signature is over the `\xff"solana offchain"` v0
// wrapping, and `signedMessage` is that wrapping), a declined request (4001), a locked wallet
// (4100), a wallet that never answers, and a wallet that signs with another key.
//
// Every request the page makes is recorded (the exact bytes, which API, and the display asked for),
// and `holdNext()` keeps the next signature waiting until the test releases it, so a test can read
// the page's signing panel while "Phantom's window" is open.

import { randomBytes } from 'node:crypto';

import type { Page } from '@playwright/test';
import nacl from 'tweetnacl';

import { bytesToHex, hexToBytes } from '../../packages/core/src/hex.js';
import { solanaAddressOf } from '../../packages/core/src/signing.js';
import { offchainWrappings } from '../../web/src/wallet/solana-signature.js';

export type PhantomMode = 'software' | 'ledger' | 'reject' | 'locked' | 'hang' | 'other-key';

/**
 * AA 00060 P5 (T5.1): which wallet the mock plays through the Wallet Standard. `E2E_WALLET=nightly` runs
 * every spec against Nightly's recorded profile (G-NIGHTLY part A, 2026-10-05): its name, its chains,
 * `solana:signIn` listed, and its Sui, Aptos, IOTA and Cedra wallets also registered as "Nightly"
 * (no Solana feature). The default is Phantom. Phantom's injected provider exists only for Phantom.
 */
export const E2E_WALLET: 'phantom' | 'nightly' = process.env.E2E_WALLET === 'nightly' ? 'nightly' : 'phantom';
export const E2E_WALLET_NAME = E2E_WALLET === 'nightly' ? 'Nightly' : 'Phantom';

export interface PhantomRequest {
  via: 'wallet-standard' | 'injected';
  display: string | null;
  bytes: Uint8Array;
  text: string;
}

export interface MockPhantom {
  deviceKey: string;
  address: string;
  secretKey: Uint8Array;
  /** Every signature request, in order. */
  requests: PhantomRequest[];
  mode: PhantomMode;
  /** What `standard:connect` answers: connect, or decline (4001). */
  connectMode: 'ok' | 'reject';
  /** Keep the NEXT signature waiting; call the returned function to let the wallet answer. */
  holdNext(): () => void;
}

const ascii = (b: Uint8Array) => String.fromCharCode(...b);

export async function installMockPhantom(
  page: Page,
  opts: { seed?: Uint8Array; standard?: boolean; injected?: boolean } = {},
): Promise<MockPhantom> {
  const kp = nacl.sign.keyPair.fromSeed(opts.seed ?? randomBytes(32));
  const other = nacl.sign.keyPair.fromSeed(randomBytes(32));
  const deviceKey = bytesToHex(kp.publicKey);
  let hold: Promise<void> | null = null;
  const phantom: MockPhantom = {
    deviceKey,
    address: solanaAddressOf(deviceKey),
    secretKey: kp.secretKey,
    requests: [],
    mode: 'software',
    connectMode: 'ok',
    holdNext() {
      let release!: () => void;
      hold = new Promise<void>((r) => (release = r));
      return () => release();
    },
  };

  await page.exposeFunction('__mockPhantomConnect', () =>
    phantom.connectMode === 'reject' ? { error: { code: 4001, message: 'User rejected the request.' } } : { ok: true },
  );
  await page.exposeFunction(
    '__mockPhantomSign',
    async (messageHex: string, via: PhantomRequest['via'], display: string | null) => {
      const bytes = hexToBytes(messageHex);
      phantom.requests.push({ via, display, bytes, text: ascii(bytes) });
      if (hold) {
        const h = hold;
        hold = null;
        await h;
      }
      switch (phantom.mode) {
        case 'reject':
          return { error: { code: 4001, message: 'User rejected the request.' } };
        case 'locked':
          return { error: { code: 4100, message: 'The requested method and/or account has not been authorized.' } };
        case 'hang':
          return { hang: true };
        case 'ledger': {
          // The Ledger Solana app's off-chain message (v0, ASCII format), as Ledger Live returns it.
          const wrapped = offchainWrappings(bytes, kp.publicKey)[0]!;
          return {
            signature: bytesToHex(nacl.sign.detached(wrapped, kp.secretKey)),
            signedMessage: bytesToHex(wrapped),
          };
        }
        case 'other-key':
          return { signature: bytesToHex(nacl.sign.detached(bytes, other.secretKey)), signedMessage: messageHex };
        default:
          return { signature: bytesToHex(nacl.sign.detached(bytes, kp.secretKey)), signedMessage: messageHex };
      }
    },
  );

  await page.addInitScript(
    ({ address, publicKeyHex, standard, injected, walletKind }) => {
      const hex = (h: string) => Uint8Array.from((h.match(/../g) ?? []).map((b) => parseInt(b, 16)));
      const toHex = (u: Uint8Array) => Array.from(u, (b) => b.toString(16).padStart(2, '0')).join('');
      const w = window as unknown as {
        __mockPhantomSign(m: string, via: string, display: string | null): Promise<Record<string, unknown>>;
        __mockPhantomConnect(): Promise<{ error?: { code: number; message: string } }>;
        __mockPhantomSwitch?: () => void;
        phantom?: unknown;
      };
      const fail = (e: { code: number; message: string }) => Object.assign(new Error(e.message), { code: e.code });
      const pk = hex(publicKeyHex);
      async function sign(message: Uint8Array, via: string, display: string | null) {
        const r = await w.__mockPhantomSign(toHex(message), via, display);
        if (r.hang) return new Promise<never>(() => undefined);
        if (r.error) throw fail(r.error as { code: number; message: string });
        return { signature: hex(r.signature as string), signedMessage: hex(r.signedMessage as string) };
      }
      const nightly = walletKind === 'nightly';
      const account = {
        address,
        publicKey: pk,
        chains: nightly
          ? ['solana:devnet', 'solana:testnet', 'solana:mainnet']
          : ['solana:mainnet', 'solana:devnet', 'solana:testnet'],
        features: ['solana:signMessage', 'solana:signTransaction', 'solana:signAndSendTransaction'],
        label: 'Mock account',
      };
      if (standard) {
        const listeners = new Set<(p: { accounts?: unknown[] }) => void>();
        let connected = false;
        const wallet = {
          version: '1.0.0',
          name: nightly ? 'Nightly' : 'Phantom',
          icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxIDEiLz4=',
          chains: nightly
            ? ['solana:mainnet', 'solana:mainnet-beta', 'solana:testnet', 'solana:devnet']
            : ['solana:mainnet', 'solana:devnet', 'solana:testnet'],
          get accounts() {
            return connected ? [account] : [];
          },
          features: {
            'standard:connect': {
              version: '1.0.0',
              connect: async () => {
                const r = await w.__mockPhantomConnect();
                if (r.error) throw fail(r.error);
                connected = true;
                return { accounts: [account] };
              },
            },
            'standard:disconnect': {
              version: '1.0.0',
              disconnect: async () => {
                connected = false;
              },
            },
            'standard:events': {
              version: '1.0.0',
              on: (_event: string, listener: (p: { accounts?: unknown[] }) => void) => {
                listeners.add(listener);
                return () => listeners.delete(listener);
              },
            },
            'solana:signMessage': {
              version: '1.1.0',
              signMessage: (...inputs: Array<{ message: Uint8Array }>) =>
                Promise.all(inputs.map((i) => sign(i.message, 'wallet-standard', null))),
            },
            ...(nightly
              ? {
                  'solana:signIn': {
                    version: '1.0.0',
                    signIn: async () => {
                      throw fail({ code: -32601, message: 'the mock wallet does not sign in' });
                    },
                  },
                }
              : {}),
          },
        };
        const announce = (w2: unknown) => {
          const register = (api: { register(w: unknown): void }) => api.register(w2);
          window.addEventListener('wallet-standard:app-ready', (e) =>
            register((e as CustomEvent<{ register(w: unknown): void }>).detail),
          );
          window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: register }));
        };
        announce(wallet);
        // Nightly also registers wallets for other chains under the same name; none is a Solana signer.
        if (nightly) {
          for (const chain of ['sui:mainnet', 'aptos:mainnet', 'iota:mainnet', 'cedra:mainnet']) {
            announce({
              version: '1.0.0',
              name: 'Nightly',
              icon: wallet.icon,
              chains: [chain],
              accounts: [],
              features: {
                'standard:connect': { version: '1.0.0', connect: async () => ({ accounts: [] }) },
                'standard:events': { version: '1.0.0', on: () => () => undefined },
              },
            });
          }
        }
        w.__mockPhantomSwitch = () => listeners.forEach((l) => l({ accounts: [] }));
      }
      if (injected) {
        const publicKey = { toBytes: () => pk, toBase58: () => address, toString: () => address };
        const provider = {
          isPhantom: true,
          publicKey: null as unknown,
          async connect() {
            const r = await w.__mockPhantomConnect();
            if (r.error) throw fail(r.error);
            provider.publicKey = publicKey;
            return { publicKey };
          },
          async disconnect() {
            provider.publicKey = null;
          },
          async signMessage(message: Uint8Array, display?: string) {
            const r = await sign(message, 'injected', display ?? null);
            return { signature: r.signature, publicKey };
          },
          on() {},
          off() {},
        };
        w.phantom = { solana: provider };
      }
    },
    {
      address: phantom.address,
      publicKeyHex: deviceKey,
      standard: opts.standard ?? true,
      injected: opts.injected ?? false,
      walletKind: E2E_WALLET,
    },
  );
  return phantom;
}

/** Connect the mock wallet (Phantom, or Nightly under E2E_WALLET=nightly) through the page's own menu. */
export async function connectPhantom(page: Page): Promise<void> {
  await page.getByTestId('connect').click();
  await page.getByTestId('wallet-option').filter({ hasText: E2E_WALLET_NAME }).click();
}
