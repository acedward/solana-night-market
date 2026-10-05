// The Solana wallet adapter (AA 00047 lane B2): Phantom (and any Wallet Standard wallet that signs
// Solana messages) behind B1.5's `WalletAdapter` / `ActionSigning` seams.
//
// Connecting shares the account's Solana address; nothing else. The wallet only ever SIGNS
// MESSAGES for every market action (no SOL needed; Bridge in's lock is its only transaction, AA 00060).
// Each signature:
//   1. opens the page's signing panel with the exact text and its fingerprint (./sign-prompt.ts);
//   2. asks the wallet to sign exactly those bytes (Phantom shows them as text), within a timeout;
//   3. checks the signature with tweetnacl over those bytes and the connected key
//      (./solana-signature.ts): a Ledger-wrapped signature is refused as "hardware (Ledger) accounts
//      aren't supported yet", any other mismatch as a bad signature: neither is ever passed on, so
//      nothing is proven on a bad signature (spec FR-004);
//   4. hands it to Track A's device, which checks it again (the arm's tweetnacl pre-check, strict R,
//      s unreduced) before the market is asked for anything.

import { bytesToHex, type DeviceSigner } from '@nightmarket/core';
import { assertDeviceKeyDecodes, type Ed25519Display } from '@nightmarket/core/passport';

import { ed25519ActionSigning } from './signing.js';
import type { SignPromptStore, TransactionFacts } from './sign-prompt.js';
import { classifyWalletSignature } from './solana-signature.js';
import { discoverSolanaWallets, type ConnectedSolanaWallet, type SolanaWalletHandle } from './solana-wallets.js';
import type { WalletAdapter, WalletSessionEvent } from './WalletContext.js';
import { WalletError, walletErrorFrom, withWalletTimeout } from './wallet-errors.js';

export interface SolanaAdapterOptions {
  /** What the arm's messages show besides the call: the network (its label) and the token list. */
  display: Ed25519Display;
  /** Where the page's signing panel reads the open request. */
  prompts: SignPromptStore;
  /** How long the page waits for the wallet (connect or sign), in ms. */
  timeoutMs: number;
  /** AA 00060 P4.3: why the wallet must not be asked now (the token lists differ), or null. Checked before
   *  EVERY request, so a paused site never opens a wallet prompt. */
  gate?: () => string | null;
  win?: Window;
}

/** AA 00060 P5 (G-NIGHTLY run 1): the pause between the end of one wallet request and the start of the
 *  next. Nightly showed no prompt for a `signMessage` asked the moment the previous one answered (the
 *  request hung); the page now never asks back to back, and asks one request at a time. */
export const WALLET_REQUEST_GAP_MS = 750;

/** Runs wallet requests one at a time, each at least `gapMs` after the previous one ended. */
export function walletPacer(
  gapMs = WALLET_REQUEST_GAP_MS,
  now: () => number = () => Date.now(),
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): <T>(fn: () => Promise<T>) => Promise<T> {
  let queue: Promise<unknown> = Promise.resolve();
  let lastEnded = Number.NEGATIVE_INFINITY;
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = async (): Promise<T> => {
      const wait = lastEnded + gapMs - now();
      if (wait > 0) await sleep(wait);
      try {
        return await fn();
      } finally {
        lastEnded = now();
      }
    };
    const p = queue.then(run, run);
    queue = p.catch(() => undefined);
    return p;
  };
}

type Pace = <T>(fn: () => Promise<T>) => Promise<T>;
const unpaced: Pace = (fn) => fn();

/** The DeviceSigner of a connected wallet, with the page's checks around the wallet's signMessage. */
export function walletSigner(
  wallet: ConnectedSolanaWallet,
  name: string,
  opts: Pick<SolanaAdapterOptions, 'prompts' | 'timeoutMs' | 'gate'> & { pace?: Pace },
  onHardware: () => void = () => undefined,
): DeviceSigner {
  const deviceKey = bytesToHex(wallet.publicKey);
  const pace = opts.pace ?? unpaced;
  return {
    deviceKey,
    address: wallet.address,
    signMessage: (message: Uint8Array) => pace(() => signOnce(message)),
  };
  async function signOnce(message: Uint8Array): Promise<Uint8Array> {
    const paused = opts.gate?.() ?? null;
    if (paused) throw new WalletError('paused', paused);
    opts.prompts.open(message, name);
    let signed = false;
    try {
      let out: { signature: Uint8Array; signedMessage?: Uint8Array };
      try {
        out = await withWalletTimeout(wallet.signMessage(message), opts.timeoutMs);
      } catch (e) {
        throw walletErrorFrom(e, 'sign');
      }
      const verdict = classifyWalletSignature(message, out.signature, wallet.publicKey, out.signedMessage);
      if (verdict === 'hardware') {
        onHardware();
        throw new WalletError('hardware');
      }
      if (verdict !== 'ok') throw new WalletError('bad-signature');
      signed = true;
      return out.signature;
    } finally {
      opts.prompts.close(signed ? 'signed' : 'ended');
    }
  }
}

export function solanaWalletAdapter(opts: SolanaAdapterOptions): WalletAdapter {
  const win = opts.win ?? window;
  let handles = new Map<string, SolanaWalletHandle>();
  return {
    discover(onChange) {
      return discoverSolanaWallets(win, (list) => {
        handles = new Map(list.map((h) => [h.id, h]));
        onChange(list.map((h) => ({ id: h.id, name: h.name, ...(h.icon ? { icon: h.icon } : {}) })));
      });
    },
    async connect(option) {
      const handle = handles.get(option.id);
      if (!handle) throw new WalletError('unavailable', 'This wallet is no longer available. Reload the page.');
      let wallet: ConnectedSolanaWallet;
      try {
        wallet = await withWalletTimeout(handle.connect(), opts.timeoutMs);
      } catch (e) {
        throw walletErrorFrom(e, 'connect');
      }
      if (!wallet.canSignMessages) {
        await wallet.disconnect();
        throw new WalletError(
          'hardware',
          "This wallet account cannot sign messages, so it cannot control a Night Market account. Hardware (Ledger) accounts aren't supported yet: switch to a software account in your wallet and connect again.",
        );
      }
      try {
        assertDeviceKeyDecodes(bytesToHex(wallet.publicKey));
      } catch {
        await wallet.disconnect();
        throw new WalletError('unavailable', 'This wallet account’s key cannot control a Night Market account.');
      }
      const listeners = new Set<(e: WalletSessionEvent) => void>();
      const emit = (e: WalletSessionEvent) => listeners.forEach((l) => l(e));
      // One request at a time, never back to back (WALLET_REQUEST_GAP_MS): messages and transactions alike.
      const pace = walletPacer();
      const signer = walletSigner(wallet, handle.name, { ...opts, pace }, () => emit('hardware'));
      const stopWatching = wallet.onChange(() => emit('account-changed'));
      // AA 00060 (Bridge in): the wallet's transaction features, behind the same gate and timeout as its
      // messages (the page builds and checks every transaction before it asks; ../bridge/in/operations.ts).
      // The signing panel shows the transaction's decoded facts while the wallet is open (P5.3).
      // P10.3 (audit C3): a timeout here does NOT mean nothing was sent: a sign-and-send may still send.
      // The timeout error carries the wallet's own request as `late`, so the caller keeps its answer, and
      // its words claim nothing about what was sent (the caller says that, ../bridge/in/operations.ts).
      const guarded =
        (fn: (t: Uint8Array, c: string) => Promise<Uint8Array>) =>
        (t: Uint8Array, c: string, facts?: TransactionFacts): Promise<Uint8Array> =>
          pace(async () => {
            const paused = opts.gate?.() ?? null;
            // Refused BEFORE the wallet is called (audit F1): nothing can have been sent.
            if (paused) throw new WalletError('paused', paused, { beforeCall: true });
            if (facts) opts.prompts.openTransaction(facts, handle.name);
            let signed = false;
            const request = fn(t, c);
            request.catch(() => undefined); // a late failure is nobody's unhandled rejection
            try {
              const out = await withWalletTimeout(request, opts.timeoutMs);
              signed = true;
              return out;
            } catch (e) {
              const error = walletErrorFrom(e, 'sign');
              if (error.kind !== 'timeout') throw error;
              throw Object.assign(
                new WalletError(
                  'timeout',
                  `Your wallet did not answer within ${Math.round(opts.timeoutMs / 1000)} seconds.`,
                ),
                { late: request },
              );
            } finally {
              if (facts) opts.prompts.close(signed ? 'signed' : 'ended');
            }
          });
      const transactions = {
        ...(wallet.signAndSendTransaction
          ? { signAndSend: guarded((t, c) => wallet.signAndSendTransaction!(t, c)) }
          : {}),
        ...(wallet.signTransaction ? { sign: guarded((t, c) => wallet.signTransaction!(t, c)) } : {}),
      };
      return {
        address: wallet.address,
        transactions,
        signing: ed25519ActionSigning(signer, opts.display, undefined, (facts) => opts.prompts.setFacts(facts)),
        disconnect() {
          stopWatching();
          listeners.clear();
          void wallet.disconnect();
        },
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };
    },
  };
}
