// Finding and connecting Solana wallets in the browser (AA 00047 lane B2): the Wallet Standard
// first, Phantom's injected `window.phantom.solana` as the fallback. No wallet library: the
// Wallet Standard's discovery is two window events, and the page needs only four features.
//
// WALLET STANDARD (github.com/wallet-standard/wallet-standard, `@wallet-standard/app` getWallets()):
//   - the page dispatches `wallet-standard:app-ready` with `{ register(...wallets) }` as its detail,
//     and listens for `wallet-standard:register-wallet`, whose detail is a callback the page calls
//     with the same `{ register }`; a wallet loaded before or after the page registers either way;
//   - a usable wallet has `standard:connect` and `solana:signMessage` (and a `solana:*` chain);
//     `standard:disconnect` and `standard:events` ("change") are used when present;
//   - `solana:signMessage` signs `{ account, message }` and returns `{ signedMessage, signature }`.
//     The standard lets a wallet "prefix or otherwise modify" the message: the page checks every
//     signature over its own bytes (./solana-signature.ts) and refuses anything else.
// INJECTED (Phantom's documented provider, docs.phantom.com/solana): `connect()`, `disconnect()`,
//   `signMessage(message, 'utf8')` → `{ signature, publicKey }`, events `accountChanged` and
//   `disconnect`. Offered only when no Wallet Standard wallet of the same name registered.
//
// Every market action is a signed MESSAGE (no SOL needed). AA 00060 adds ONE kind of Solana transaction:
// Bridge in's lock, which the page builds itself from the journey registry and checks before the wallet
// is asked (`solana:signAndSendTransaction`, or `solana:signTransaction` and the page sends it). A wallet
// with neither keeps every message flow; Bridge in then says why it is unavailable.

import { bytesToHex, deviceKeyFromSolanaAddress, hexToBytes, solanaAddressOf } from '@nightmarket/core';

import { WalletError } from './wallet-errors.js';

// ── The page's view of a wallet ───────────────────────────────────────────────

/** A wallet the page can offer. */
export interface SolanaWalletHandle {
  id: string;
  name: string;
  icon?: string;
  /** Which API the page talks to. */
  via: 'wallet-standard' | 'injected';
  connect(): Promise<ConnectedSolanaWallet>;
}

/** A connected account of a wallet. */
export interface ConnectedSolanaWallet {
  /** The Solana address (base58). */
  address: string;
  /** The same key, 32 bytes. */
  publicKey: Uint8Array;
  /** False when the wallet says this account cannot sign messages (the page then refuses it). */
  canSignMessages: boolean;
  /** Sign exactly `message`, shown as text (Phantom's `display: 'utf8'`). */
  signMessage(message: Uint8Array): Promise<{ signature: Uint8Array; signedMessage?: Uint8Array }>;
  disconnect(): Promise<void>;
  /** Called when the wallet switches away from this account, or disconnects. */
  onChange(listener: () => void): () => void;
  /** AA 00060 (Bridge in): sign and SEND a wire transaction on `chain` (`solana:<cluster>`); resolves with
   *  its first signature. Absent when the wallet has no `solana:signAndSendTransaction`. */
  signAndSendTransaction?(transaction: Uint8Array, chain: string): Promise<Uint8Array>;
  /** AA 00060 (Bridge in): sign a wire transaction (the page sends it); resolves with the signed wire
   *  transaction. Absent when the wallet has no `solana:signTransaction`. */
  signTransaction?(transaction: Uint8Array, chain: string): Promise<Uint8Array>;
}

// ── Wallet Standard (the subset used) ────────────────────────────────────────

export interface StandardWalletAccount {
  readonly address: string;
  readonly publicKey: Uint8Array;
  readonly chains: readonly string[];
  readonly features: readonly string[];
  readonly label?: string;
}

export interface StandardWallet {
  readonly version: string;
  readonly name: string;
  readonly icon: string;
  readonly chains: readonly string[];
  readonly accounts: readonly StandardWalletAccount[];
  readonly features: Readonly<Record<string, unknown>>;
}

interface ConnectFeature {
  connect(input?: { silent?: boolean }): Promise<{ accounts: readonly StandardWalletAccount[] }>;
}
interface DisconnectFeature {
  disconnect(): Promise<void>;
}
interface EventsFeature {
  on(event: 'change', listener: (props: { accounts?: readonly StandardWalletAccount[] }) => void): () => void;
}
interface SignAndSendTransactionFeature {
  signAndSendTransaction(
    ...inputs: Array<{ account: StandardWalletAccount; transaction: Uint8Array; chain: string }>
  ): Promise<ReadonlyArray<{ signature: Uint8Array }>>;
}
interface SignTransactionFeature {
  signTransaction(
    ...inputs: Array<{ account: StandardWalletAccount; transaction: Uint8Array; chain?: string }>
  ): Promise<ReadonlyArray<{ signedTransaction: Uint8Array }>>;
}
interface SignMessageFeature {
  signMessage(
    ...inputs: Array<{ account: StandardWalletAccount; message: Uint8Array }>
  ): Promise<ReadonlyArray<{ signedMessage: Uint8Array; signature: Uint8Array; signatureType?: string }>>;
}

const feature = <T>(w: StandardWallet, name: string): T | null => (w.features[name] as T | undefined) ?? null;

/** A Wallet Standard wallet the market can use: it connects, signs Solana messages, and is Solana's. */
export const isSolanaSigningWallet = (w: StandardWallet): boolean =>
  !!feature<ConnectFeature>(w, 'standard:connect') &&
  !!feature<SignMessageFeature>(w, 'solana:signMessage') &&
  (w.chains.length === 0 || w.chains.some((c) => c.startsWith('solana:')));

const bytesOf = (v: unknown): Uint8Array | null =>
  v instanceof Uint8Array ? v : Array.isArray(v) ? Uint8Array.from(v as number[]) : null;

/** The account's key, from its `publicKey` bytes or its base58 address; must agree when both exist. */
function keyOf(account: { address?: unknown; publicKey?: unknown }): { address: string; publicKey: Uint8Array } {
  const fromBytes = bytesOf(account.publicKey);
  const address = typeof account.address === 'string' ? account.address : null;
  if (fromBytes && fromBytes.length === 32) {
    const derived = solanaAddressOf(bytesToHex(fromBytes));
    if (address && address !== derived)
      throw new WalletError('unavailable', 'The wallet reported an inconsistent account key.');
    return { address: derived, publicKey: fromBytes };
  }
  if (address) return { address, publicKey: hexToBytes(deviceKeyFromSolanaAddress(address), 32) };
  throw new WalletError('unavailable', 'The wallet did not share an account.');
}

function standardHandle(w: StandardWallet, index: number): SolanaWalletHandle {
  return {
    id: `ws:${index}:${w.name}`,
    name: w.name,
    icon: w.icon,
    via: 'wallet-standard',
    async connect() {
      const { accounts } = await feature<ConnectFeature>(w, 'standard:connect')!.connect();
      const list = accounts.length > 0 ? accounts : w.accounts;
      const account = list.find((a) => a.features.length === 0 || a.features.includes('solana:signMessage')) ?? list[0];
      if (!account) throw new WalletError('unavailable', 'The wallet did not share an account.');
      const key = keyOf(account);
      const sign = feature<SignMessageFeature>(w, 'solana:signMessage')!;
      // AA 00060: the transaction features, when the wallet AND the account offer them.
      const accountHas = (f: string) => account.features.length === 0 || account.features.includes(f);
      const signAndSend = accountHas('solana:signAndSendTransaction')
        ? feature<SignAndSendTransactionFeature>(w, 'solana:signAndSendTransaction')
        : null;
      const signTx = accountHas('solana:signTransaction')
        ? feature<SignTransactionFeature>(w, 'solana:signTransaction')
        : null;
      return {
        ...(signAndSend
          ? {
              async signAndSendTransaction(transaction: Uint8Array, chain: string) {
                const [out] = await signAndSend.signAndSendTransaction({ account, transaction, chain });
                const signature = bytesOf(out?.signature);
                if (!signature || signature.length !== 64) throw new WalletError('bad-signature');
                return signature;
              },
            }
          : {}),
        ...(signTx
          ? {
              async signTransaction(transaction: Uint8Array, chain: string) {
                const [out] = await signTx.signTransaction({ account, transaction, chain });
                const signed = bytesOf(out?.signedTransaction);
                if (!signed) throw new WalletError('bad-signature');
                return signed;
              },
            }
          : {}),
        ...key,
        canSignMessages: account.features.length === 0 || account.features.includes('solana:signMessage'),
        async signMessage(message) {
          const [out] = await sign.signMessage({ account, message });
          const signature = bytesOf(out?.signature);
          if (!out || !signature) throw new WalletError('bad-signature');
          const signedMessage = bytesOf(out.signedMessage) ?? undefined;
          return signedMessage ? { signature, signedMessage } : { signature };
        },
        async disconnect() {
          await feature<DisconnectFeature>(w, 'standard:disconnect')
            ?.disconnect()
            .catch(() => undefined);
        },
        onChange(listener) {
          const events = feature<EventsFeature>(w, 'standard:events');
          if (!events) return () => undefined;
          return events.on('change', (props) => {
            if (!props.accounts) return;
            if (!props.accounts.some((a) => a.address === key.address)) listener();
          });
        },
      };
    },
  };
}

// ── Phantom's injected provider (the fallback) ───────────────────────────────

interface InjectedPublicKey {
  toBytes?(): Uint8Array;
  toBase58?(): string;
}
export interface InjectedSolanaProvider {
  isPhantom?: boolean;
  publicKey?: InjectedPublicKey | null;
  connect(opts?: { onlyIfTrusted?: boolean }): Promise<{ publicKey: InjectedPublicKey }>;
  disconnect(): Promise<void>;
  signMessage(message: Uint8Array, display?: 'utf8' | 'hex'): Promise<{ signature: Uint8Array; publicKey?: unknown }>;
  on?(event: string, listener: (arg?: unknown) => void): void;
  off?(event: string, listener: (arg?: unknown) => void): void;
  removeListener?(event: string, listener: (arg?: unknown) => void): void;
}

const injectedKey = (pk: InjectedPublicKey | null | undefined) => {
  if (!pk) throw new WalletError('unavailable', 'The wallet did not share an account.');
  const bytes = typeof pk.toBytes === 'function' ? pk.toBytes() : null;
  const address = typeof pk.toBase58 === 'function' ? pk.toBase58() : undefined;
  return keyOf({ address, publicKey: bytes });
};

function injectedHandle(provider: InjectedSolanaProvider): SolanaWalletHandle {
  return {
    id: 'injected:phantom',
    name: 'Phantom',
    via: 'injected',
    async connect() {
      const { publicKey } = await provider.connect();
      const key = injectedKey(publicKey);
      return {
        ...key,
        canSignMessages: typeof provider.signMessage === 'function',
        async signMessage(message) {
          const out = await provider.signMessage(message, 'utf8');
          const signature = bytesOf(out?.signature);
          if (!signature) throw new WalletError('bad-signature');
          return { signature };
        },
        async disconnect() {
          await provider.disconnect().catch(() => undefined);
        },
        onChange(listener) {
          const onAccount = (next?: unknown) => {
            try {
              if (!next || injectedKey(next as InjectedPublicKey).address !== key.address) listener();
            } catch {
              listener();
            }
          };
          const onDisconnect = () => listener();
          provider.on?.('accountChanged', onAccount);
          provider.on?.('disconnect', onDisconnect);
          return () => {
            const off = (provider.off ?? provider.removeListener)?.bind(provider);
            off?.('accountChanged', onAccount);
            off?.('disconnect', onDisconnect);
          };
        },
      };
    },
  };
}

type PhantomWindow = Window & { phantom?: { solana?: InjectedSolanaProvider }; solana?: InjectedSolanaProvider };

/** Phantom's injected Solana provider, if the extension put one on the page. */
export function injectedPhantom(win: Window): InjectedSolanaProvider | null {
  const w = win as PhantomWindow;
  const p = w.phantom?.solana ?? (w.solana?.isPhantom ? w.solana : undefined);
  return p && p.isPhantom && typeof p.connect === 'function' && typeof p.signMessage === 'function' ? p : null;
}

// ── Discovery ────────────────────────────────────────────────────────────────

/**
 * Watch for Solana wallets: every Wallet Standard wallet that can sign Solana messages, plus
 * Phantom's injected provider when Phantom has not registered through the standard. `onChange` gets
 * the current list at once and whenever it changes. Returns the stop function.
 */
export function discoverSolanaWallets(win: Window, onChange: (wallets: SolanaWalletHandle[]) => void): () => void {
  const standard: StandardWallet[] = [];
  const emit = () => {
    const usable = standard.filter(isSolanaSigningWallet);
    const handles = usable.map((w, i) => standardHandle(w, i));
    const phantom = injectedPhantom(win);
    if (phantom && !usable.some((w) => w.name.toLowerCase() === 'phantom')) handles.push(injectedHandle(phantom));
    onChange(handles);
  };
  const api = Object.freeze({
    register(...wallets: StandardWallet[]) {
      const added = wallets.filter((w) => w && !standard.includes(w));
      standard.push(...added);
      if (added.length) emit();
      return () => {
        for (const w of added) {
          const i = standard.indexOf(w);
          if (i >= 0) standard.splice(i, 1);
        }
        emit();
      };
    },
  });
  const onRegister = (event: Event) => {
    const callback = (event as CustomEvent<unknown>).detail;
    if (typeof callback === 'function') {
      try {
        (callback as (a: typeof api) => void)(api);
      } catch {
        /* a broken wallet must not break the page */
      }
    }
  };
  win.addEventListener('wallet-standard:register-wallet', onRegister);
  win.dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: api }));
  emit();
  // Phantom injects its provider at document start, but look again once the page has loaded.
  const late = setTimeout(emit, 500);
  return () => {
    clearTimeout(late);
    win.removeEventListener('wallet-standard:register-wallet', onRegister);
  };
}
