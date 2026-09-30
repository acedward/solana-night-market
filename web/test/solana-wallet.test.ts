// AA 00047 lane B2: the Solana wallet adapter in the browser (happy-dom), against a fake Wallet
// Standard wallet and a fake injected Phantom that sign with tweetnacl, exactly as Phantom's software
// accounts do (RFC 8032 over the raw bytes), or as a Ledger does (over the off-chain-message
// wrapping). Covers discovery, connect, the signature check (Ledger refusal, mismatch), the wallet's
// errors (rejection, lock, timeout) and the page's signing panel.

import nacl from 'tweetnacl';
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildRelayActionMessage,
  bytesToHex,
  hexToBytes,
  registryFor,
  solanaAddressOf,
  type RelayActionMessage,
} from '@nightmarket/core';
import { solanaRelayActionScheme } from '@nightmarket/core/solana-auth';

import { solanaWalletAdapter } from '../src/wallet/phantom-adapter.js';
import { SignPromptStore, messageFingerprint, type SignPrompt } from '../src/wallet/sign-prompt.js';
import { OFFCHAIN_SIGNING_DOMAIN, classifyWalletSignature, offchainWrappings } from '../src/wallet/solana-signature.js';
import {
  discoverSolanaWallets,
  type InjectedSolanaProvider,
  type SolanaWalletHandle,
  type StandardWallet,
} from '../src/wallet/solana-wallets.js';
import type { WalletSession, WalletSessionEvent } from '../src/wallet/WalletContext.js';
import { WalletError, walletErrorFrom, withWalletTimeout } from '../src/wallet/wallet-errors.js';

type Mode = 'software' | 'ledger-v0' | 'ledger-v1' | 'ledger-legacy' | 'reject' | 'locked' | 'hang' | 'other-key';

const display = { network: 'stagenet', tokens: registryFor('stagenet') } as const;
const cleanups: Array<() => void> = [];
const utf8 = (s: string) => new TextEncoder().encode(s);

function keyPair(seed: number) {
  return nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(seed));
}

/** What a wallet in `mode` returns for `message`. */
function signAs(
  mode: Mode,
  message: Uint8Array,
  kp: nacl.SignKeyPair,
): { signature: Uint8Array; signedMessage: Uint8Array } {
  const wraps = offchainWrappings(message, kp.publicKey);
  const bytes =
    mode === 'ledger-v0'
      ? wraps[0]!
      : mode === 'ledger-v1'
        ? wraps[5]!
        : mode === 'ledger-legacy'
          ? wraps[3]!
          : message;
  const signer = mode === 'other-key' ? keyPair(99) : kp;
  return { signature: nacl.sign.detached(bytes, signer.secretKey), signedMessage: bytes };
}

function fakeStandardWallet(
  opts: { name?: string; seed?: number; accountFeatures?: string[]; chains?: string[] } = {},
) {
  const kp = keyPair(opts.seed ?? 7);
  const account = {
    address: solanaAddressOf(bytesToHex(kp.publicKey)),
    publicKey: kp.publicKey,
    chains: ['solana:mainnet'],
    features: opts.accountFeatures ?? ['solana:signMessage'],
  };
  const listeners = new Set<(p: { accounts?: readonly (typeof account)[] }) => void>();
  const state = { mode: 'software' as Mode, asked: [] as Uint8Array[], onSign: (() => undefined) as () => void };
  const wallet: StandardWallet = {
    version: '1.0.0',
    name: opts.name ?? 'Phantom',
    icon: 'data:image/svg+xml;base64,PHN2Zy8+',
    chains: opts.chains ?? ['solana:mainnet', 'solana:devnet'],
    accounts: [account],
    features: {
      'standard:connect': { version: '1.0.0', connect: async () => ({ accounts: [account] }) },
      'standard:disconnect': { version: '1.0.0', disconnect: async () => undefined },
      'standard:events': {
        version: '1.0.0',
        on: (_e: 'change', l: (p: { accounts?: readonly (typeof account)[] }) => void) => {
          listeners.add(l);
          return () => listeners.delete(l);
        },
      },
      'solana:signMessage': {
        version: '1.1.0',
        signMessage: async ({ message }: { account: unknown; message: Uint8Array }) => {
          state.asked.push(message);
          state.onSign();
          if (state.mode === 'reject') throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
          if (state.mode === 'locked') throw Object.assign(new Error('Wallet is locked'), { code: 4100 });
          if (state.mode === 'hang') return new Promise(() => undefined);
          return [signAs(state.mode, message, kp)];
        },
      },
    },
  };
  return {
    wallet,
    kp,
    state,
    switchAccount: () => listeners.forEach((l) => l({ accounts: [{ ...account, address: 'other' }] })),
  };
}

/** Announce a wallet the way a Wallet Standard wallet does (`@wallet-standard/wallet`
 *  registerWallet): answer every later app-ready event, and announce itself now. */
function registerWallet(w: StandardWallet) {
  const register = (api: { register(w: StandardWallet): void }) => api.register(w);
  const onReady = (e: Event) => register((e as CustomEvent<{ register(w: StandardWallet): void }>).detail);
  window.addEventListener('wallet-standard:app-ready', onReady);
  cleanups.push(() => window.removeEventListener('wallet-standard:app-ready', onReady));
  window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: register }));
}

function fakeInjected(mode: Mode = 'software', seed = 8) {
  const kp = keyPair(seed);
  const pk = { toBytes: () => kp.publicKey, toBase58: () => solanaAddressOf(bytesToHex(kp.publicKey)) };
  const displays: Array<string | undefined> = [];
  const provider: InjectedSolanaProvider = {
    isPhantom: true,
    publicKey: pk,
    connect: async () => ({ publicKey: pk }),
    disconnect: async () => undefined,
    signMessage: async (message, show) => {
      displays.push(show);
      if (mode === 'reject') throw { code: 4001, message: 'User rejected the request.' };
      return { signature: signAs(mode, message, kp).signature, publicKey: pk };
    },
  };
  return { provider, kp, displays };
}

const envelopeFor = (owner: string): RelayActionMessage =>
  buildRelayActionMessage({
    action: 'register',
    network: 'stagenet',
    owner,
    payload: { encPublicKey: 'ab'.repeat(32) },
    nonce: `0x${'34'.repeat(32)}`,
    expiry: 1_900_000_000,
  });

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  delete (window as unknown as { phantom?: unknown }).phantom;
});

async function connectFirst(adapter: ReturnType<typeof solanaWalletAdapter>) {
  let options: Array<{ id: string; name: string }> = [];
  cleanups.push(adapter.discover((o) => (options = o)));
  await new Promise((r) => setTimeout(r, 0));
  expect(options.length).toBeGreaterThan(0);
  return adapter.connect(options[0]!);
}

describe('the signature check (Ledger refusal)', () => {
  const kp = keyPair(3);
  const message = utf8('Night Market - stagenet\nWithdraw shielded\nDigest ' + 'ab'.repeat(32));

  it('accepts a signature over exactly the bytes asked for', () => {
    expect(classifyWalletSignature(message, nacl.sign.detached(message, kp.secretKey), kp.publicKey)).toBe('ok');
  });

  it.each(['ledger-v0', 'ledger-v1', 'ledger-legacy'] as const)(
    'recognises a %s off-chain-message signature as a hardware account',
    (mode) => {
      const { signature } = signAs(mode, message, kp);
      expect(classifyWalletSignature(message, signature, kp.publicKey)).toBe('hardware');
    },
  );

  it("recognises a hardware account from the wallet's own signedMessage", () => {
    const wrapped = Uint8Array.from([...OFFCHAIN_SIGNING_DOMAIN, 0, 9, 9, ...message]); // a header we do not rebuild
    const signature = nacl.sign.detached(wrapped, kp.secretKey);
    expect(classifyWalletSignature(message, signature, kp.publicKey)).toBe('mismatch');
    expect(classifyWalletSignature(message, signature, kp.publicKey, wrapped)).toBe('hardware');
  });

  it('calls anything else a mismatch: another key, other bytes, a short signature', () => {
    expect(classifyWalletSignature(message, signAs('other-key', message, kp).signature, kp.publicKey)).toBe('mismatch');
    expect(classifyWalletSignature(message, nacl.sign.detached(utf8('other'), kp.secretKey), kp.publicKey)).toBe(
      'mismatch',
    );
    expect(classifyWalletSignature(message, new Uint8Array(63), kp.publicKey)).toBe('mismatch');
    // A signed message that is NOT an off-chain envelope proves nothing.
    const other = utf8('something else');
    expect(classifyWalletSignature(message, nacl.sign.detached(other, kp.secretKey), kp.publicKey, other)).toBe(
      'mismatch',
    );
  });
});

describe("the wallet's errors, in words", () => {
  it('maps rejection, lock and anything else', () => {
    expect(walletErrorFrom({ code: 4001, message: 'User rejected the request.' }).kind).toBe('rejected');
    expect(walletErrorFrom(new Error('The user declined')).kind).toBe('rejected');
    expect(walletErrorFrom({ code: 4100, message: 'Unauthorized' }).kind).toBe('locked');
    expect(walletErrorFrom(new Error('Wallet is locked')).message).toMatch(/locked/);
    const other = walletErrorFrom(new Error('boom'));
    expect(other.kind).toBe('failed');
    expect(other.message).toMatch(/the wallet said: boom/);
    expect(walletErrorFrom({ code: 4001 }, 'connect').message).toMatch(/declined the connection/);
  });

  it('times out a wallet that never answers', async () => {
    const e = await withWalletTimeout(new Promise(() => undefined), 20).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(WalletError);
    expect((e as WalletError).kind).toBe('timeout');
  });
});

describe('the fingerprint', () => {
  it("is the first 8 hex digits of the message's Digest or Nonce line", () => {
    expect(messageFingerprint(utf8(`Label\nSwap offer\nDigest ${'82d206a4'.padEnd(64, '0')}`))).toBe('82d2 06a4');
    expect(messageFingerprint(utf8(`Label\nProve you hold this key\nNonce ${'1234abcd'.padEnd(64, 'f')}\nx`))).toBe(
      '1234 abcd',
    );
    expect(messageFingerprint(utf8('no digest line'))).toMatch(/^[0-9a-f]{4} [0-9a-f]{4}$/);
  });
});

describe('discovery', () => {
  it('finds Wallet Standard wallets registered before and after the page, Solana signers only', async () => {
    const early = fakeStandardWallet({ name: 'Early' });
    // A wallet loaded before the page answers the page's app-ready event.
    const onReady = (e: Event) =>
      (e as CustomEvent<{ register(w: StandardWallet): void }>).detail.register(early.wallet);
    window.addEventListener('wallet-standard:app-ready', onReady);
    cleanups.push(() => window.removeEventListener('wallet-standard:app-ready', onReady));
    let seen: SolanaWalletHandle[] = [];
    cleanups.push(discoverSolanaWallets(window, (h) => (seen = h)));
    expect(seen.map((h) => h.name)).toEqual(['Early']);
    registerWallet(fakeStandardWallet({ name: 'Later' }).wallet);
    registerWallet(fakeStandardWallet({ name: 'EVM only', chains: ['eip155:1'] }).wallet);
    expect(seen.map((h) => h.name)).toEqual(['Early', 'Later']);
  });

  it("offers Phantom's injected provider only when Phantom did not register through the standard", async () => {
    (window as unknown as { phantom: unknown }).phantom = { solana: fakeInjected().provider };
    let seen: SolanaWalletHandle[] = [];
    cleanups.push(discoverSolanaWallets(window, (h) => (seen = h)));
    expect(seen.map((h) => [h.name, h.via])).toEqual([['Phantom', 'injected']]);
    registerWallet(fakeStandardWallet({ name: 'Phantom' }).wallet);
    expect(seen.map((h) => [h.name, h.via])).toEqual([['Phantom', 'wallet-standard']]);
  });
});

describe('the adapter (connect, sign, refuse)', () => {
  function adapter(timeoutMs = 2_000) {
    const prompts = new SignPromptStore();
    return { prompts, adapter: solanaWalletAdapter({ display, prompts, timeoutMs, win: window }) };
  }

  it('connects a software account and signs the relay envelope, showing the same text in the page', async () => {
    const w = fakeStandardWallet();
    registerWallet(w.wallet);
    const { prompts, adapter: a } = adapter();
    const session = await connectFirst(a);
    expect(session.address).toBe(solanaAddressOf(bytesToHex(w.kp.publicKey)));
    let during: SignPrompt | null = null;
    w.state.onSign = () => (during = prompts.get());
    const message = envelopeFor(session.signing.deviceKey);
    const sig = await session.signing.relayAction(message);
    expect(solanaRelayActionScheme.verify(message, hexToBytes(sig, 64))).toBe(true);
    const text = new TextDecoder().decode(w.state.asked[0]);
    expect(during).toMatchObject({ wallet: 'Phantom', text, kind: 'relay-envelope' });
    expect(during!.fingerprint).toBe(messageFingerprint(w.state.asked[0]!));
    expect(prompts.get()).toBeNull(); // closed once the wallet answered
  });

  it("refuses a Ledger account's wrapped signature, and ends the session with the hardware reason", async () => {
    const w = fakeStandardWallet();
    registerWallet(w.wallet);
    const { adapter: a } = adapter();
    const session: WalletSession = await connectFirst(a);
    const events: WalletSessionEvent[] = [];
    session.subscribe?.((e) => events.push(e));
    w.state.mode = 'ledger-v1';
    const e = await session.signing.relayAction(envelopeFor(session.signing.deviceKey)).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(WalletError);
    expect((e as WalletError).kind).toBe('hardware');
    expect((e as Error).message).toMatch(/Hardware \(Ledger\) accounts aren't supported yet/);
    expect(events).toEqual(['hardware']);
  });

  it('says clearly when the wallet declines, is locked, answers with another key, or never answers', async () => {
    const w = fakeStandardWallet();
    registerWallet(w.wallet);
    const { adapter: a, prompts } = adapter(50);
    const session = await connectFirst(a);
    const kindOf = async (mode: Mode) => {
      w.state.mode = mode;
      const e = await session.signing.relayAction(envelopeFor(session.signing.deviceKey)).catch((x: unknown) => x);
      return (e as WalletError).kind;
    };
    expect(await kindOf('reject')).toBe('rejected');
    expect(await kindOf('locked')).toBe('locked');
    expect(await kindOf('other-key')).toBe('bad-signature');
    expect(await kindOf('hang')).toBe('timeout');
    expect(prompts.get()).toBeNull();
  });

  it('refuses at connect an account that cannot sign messages', async () => {
    registerWallet(fakeStandardWallet({ accountFeatures: ['solana:signTransaction'] }).wallet);
    const { adapter: a } = adapter();
    const e = await connectFirst(a).catch((x: unknown) => x);
    expect((e as WalletError).kind).toBe('hardware');
    expect((e as Error).message).toMatch(/cannot sign messages/);
  });

  it('ends the session when the wallet switches accounts', async () => {
    const w = fakeStandardWallet();
    registerWallet(w.wallet);
    const { adapter: a } = adapter();
    const session = await connectFirst(a);
    const events: WalletSessionEvent[] = [];
    session.subscribe?.((e) => events.push(e));
    w.switchAccount();
    expect(events).toEqual(['account-changed']);
  });

  it("uses Phantom's injected provider with display 'utf8', and recognises a Ledger there too", async () => {
    const good = fakeInjected('software', 11);
    (window as unknown as { phantom: unknown }).phantom = { solana: good.provider };
    const { adapter: a } = adapter();
    const session = await connectFirst(a);
    await session.signing.relayAction(envelopeFor(session.signing.deviceKey));
    expect(good.displays).toEqual(['utf8']);
    cleanups.pop()!();

    const ledger = fakeInjected('ledger-v0', 12);
    (window as unknown as { phantom: unknown }).phantom = { solana: ledger.provider };
    const b = adapter();
    const s2 = await connectFirst(b.adapter);
    const e = await s2.signing.relayAction(envelopeFor(s2.signing.deviceKey)).catch((x: unknown) => x);
    expect((e as WalletError).kind).toBe('hardware');
  });
});
