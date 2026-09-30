// The connected Solana wallet (AA 00047 lane B2: ./phantom-adapter.ts wires Phantom, and any Wallet
// Standard wallet that signs Solana messages, through `solana:signMessage`, or Phantom's injected
// `window.phantom.solana`; Ledger-backed accounts are refused).
//
// A wallet here only SIGNS MESSAGES: it never sends a Solana transaction, so it needs no SOL. What the
// rest of the site reads is its Solana address, its device key (the same 32 bytes as hex) and its
// `ActionSigning` (./signing.ts). MN Bank's EIP-1193 wallet, network switch and Sepolia reads are
// gone (AA 00047).
//
// THE SEAM: `WalletAdapter`. The site ships the Solana adapter; the browser tests drive it with a
// mock Phantom (test/e2e/mock-phantom.ts), and a build without an adapter says wallets are coming.

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

import { deviceKeyFromSolanaAddress } from '@nightmarket/core';

import { HARDWARE_NOT_SUPPORTED } from './wallet-errors.js';
import type { ActionSigning } from './signing.js';

export type WalletStatus = 'disconnected' | 'connecting' | 'connected';

/** A wallet the page can offer (a Wallet Standard wallet that signs Solana messages). */
export interface WalletOption {
  id: string;
  name: string;
  icon?: string;
}

/** What a connected session reports on its own: the wallet switched away from the account (or
 *  disconnected), or a signature showed it is a hardware (Ledger) account, which v1 refuses. */
export type WalletSessionEvent = 'account-changed' | 'hardware';

/** A connected wallet session, as an adapter returns it. */
export interface WalletSession {
  /** The Solana address (base58). */
  address: string;
  signing: ActionSigning;
  disconnect(): void;
  subscribe?(listener: (event: WalletSessionEvent) => void): () => void;
}

/** What a wallet integration implements (./phantom-adapter.ts for Solana wallets). */
export interface WalletAdapter {
  /** The wallets in this browser; `onChange` is called when one registers later. */
  discover(onChange: (options: WalletOption[]) => void): () => void;
  connect(option: WalletOption): Promise<WalletSession>;
}

export interface WalletState {
  status: WalletStatus;
  options: WalletOption[];
  /** The connected wallet's Solana address (base58), or null. */
  address: string | null;
  /** The same key as 64 lowercase hex: the account's device key, and the local data scope. */
  deviceKey: string | null;
  walletName: string | null;
  /** How the site asks the wallet for signatures, while connected. */
  signing: ActionSigning | null;
  /** False when the site has no wallet adapter (no token list for the network). */
  supported: boolean;
  error: string | null;
  connect(option: WalletOption): Promise<void>;
  disconnect(): void;
}

const WalletCtx = createContext<WalletState | null>(null);

export function WalletProvider({ adapter = null, children }: { adapter?: WalletAdapter | null; children: ReactNode }) {
  const [options, setOptions] = useState<WalletOption[]>([]);
  const [status, setStatus] = useState<WalletStatus>('disconnected');
  const [session, setSession] = useState<(WalletSession & { name: string }) | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => adapter?.discover(setOptions), [adapter]);

  const disconnect = useCallback(() => {
    session?.disconnect();
    setSession(null);
    setStatus('disconnected');
  }, [session]);

  // The session's own events: another account in the wallet, or a hardware account found at the
  // first signature. Either way this session ends, and the page says why.
  useEffect(() => {
    if (!session?.subscribe) return;
    return session.subscribe((event) => {
      session.disconnect();
      setSession(null);
      setStatus('disconnected');
      setError(
        event === 'hardware'
          ? HARDWARE_NOT_SUPPORTED
          : 'Your wallet switched to another account, or disconnected. Connect again to continue.',
      );
    });
  }, [session]);

  const connect = useCallback(
    async (option: WalletOption) => {
      setError(null);
      if (!adapter) {
        setError('Solana wallets are not supported on this site yet.');
        return;
      }
      setStatus('connecting');
      try {
        const s = await adapter.connect(option);
        deviceKeyFromSolanaAddress(s.address); // a real Solana address, or refuse
        setSession({ ...s, name: option.name });
        setStatus('connected');
      } catch (e) {
        setStatus('disconnected');
        setError(e instanceof Error && e.message ? e.message : 'The wallet did not connect.');
      }
    },
    [adapter],
  );

  const connected = status === 'connected' && session !== null;
  const value: WalletState = {
    status,
    options,
    address: connected ? session.address : null,
    deviceKey: connected ? deviceKeyFromSolanaAddress(session.address) : null,
    walletName: connected ? session.name : null,
    signing: connected ? session.signing : null,
    supported: adapter !== null,
    error,
    connect,
    disconnect,
  };
  return <WalletCtx.Provider value={value}>{children}</WalletCtx.Provider>;
}

export function useWallet(): WalletState {
  const v = useContext(WalletCtx);
  if (!v) throw new Error('useWallet outside WalletProvider');
  return v;
}
