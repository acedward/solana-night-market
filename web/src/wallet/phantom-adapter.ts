// The Solana wallet adapter (AA 00047 lane B2): Phantom (and any Wallet Standard wallet that signs
// Solana messages) behind B1.5's `WalletAdapter` / `ActionSigning` seams.
//
// Connecting shares the account's Solana address; nothing else. The wallet only ever SIGNS
// MESSAGES (never a Solana transaction), so it needs no SOL. Each signature:
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
import type { SignPromptStore } from './sign-prompt.js';
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
  win?: Window;
}

/** The DeviceSigner of a connected wallet, with the page's checks around the wallet's signMessage. */
export function walletSigner(
  wallet: ConnectedSolanaWallet,
  name: string,
  opts: Pick<SolanaAdapterOptions, 'prompts' | 'timeoutMs'>,
  onHardware: () => void = () => undefined,
): DeviceSigner {
  const deviceKey = bytesToHex(wallet.publicKey);
  return {
    deviceKey,
    address: wallet.address,
    async signMessage(message: Uint8Array): Promise<Uint8Array> {
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
    },
  };
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
      const signer = walletSigner(wallet, handle.name, opts, () => emit('hardware'));
      const stopWatching = wallet.onChange(() => emit('account-changed'));
      return {
        address: wallet.address,
        signing: ed25519ActionSigning(signer, opts.display),
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
