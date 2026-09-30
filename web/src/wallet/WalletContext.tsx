// The connected Solana wallet (lane B2 wires Phantom through the Wallet Standard's
// `solana:signMessage`, or `window.phantom.solana`, and refuses Ledger-backed accounts).
//
// A wallet here only SIGNS MESSAGES: it never sends a Solana transaction, so it needs no SOL. What the
// rest of the site reads is its Solana address, its device key (the same 32 bytes as hex) and its
// `ActionSigning` (./signing.ts). MN Bank's EIP-1193 wallet, network switch and Sepolia reads are
// gone (AA 00047).
//
// THE SEAM: `WalletAdapter`. This build has none, so the site lists no wallet and says Solana
// wallets are coming; lane B2 provides the Phantom adapter (and tests a mock one).

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

import { deviceKeyFromSolanaAddress } from '@nightmarket/core';

import type { ActionSigning } from './signing.js';

export type WalletStatus = 'disconnected' | 'connecting' | 'connected';

/** A wallet the page can offer (a Wallet Standard wallet that signs Solana messages). */
export interface WalletOption {
  id: string;
  name: string;
  icon?: string;
}

/** A connected wallet session, as an adapter returns it. */
export interface WalletSession {
  /** The Solana address (base58). */
  address: string;
  signing: ActionSigning;
  disconnect(): void;
}

/** What lane B2 implements for Phantom (and a mock for the browser tests). */
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
  /** False when this build has no wallet adapter (Solana wallets arrive with lane B2). */
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
