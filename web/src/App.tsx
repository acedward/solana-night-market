// The application shell (AA 00047 P8.1, spec FR-006b): a wallet-first header (the Night Market
// mark, the network, the sections, and Connect Phantom or the connected wallet's pill), the
// market's standing notices, the four sections, the testnet footer, the toasts and the signing
// modal. The pieces come from ./design; this file only wires them to the wallet and the store.
//
// A create-and-trade market: the order books (Markets) and making and taking offers (Trade) come
// first; the holdings (Portfolio, route #account) and the browser's records (Your data, route
// #local) after. The routes are the ones MN Bank had, so links and bookmarks keep working. The About
// page (route #about, AA 00047 P11.D, questions Q58) is linked from the footer, not the header.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';

import { registryFor, shortSolanaAddress, type NetworkProfile } from '@nightmarket/core';

import { ActivityProvider } from './activity/ActivityContext.js';
import { ActivityStore } from './activity/activity.js';
import { AssetFilterNote, AssetFilterProvider } from './assets/AssetFilterContext.js';
import { ChainProvider } from './chain/ChainContext.js';
import { loadSiteConfig, type SiteConfig } from './config.js';
import {
  Avatar,
  Button,
  EmptyState,
  Icon,
  LogoMark,
  Masthead,
  Notice,
  PageHead,
  SiteFooter,
  Spinner,
  TabNav,
  Toast,
  ToastProvider,
  copyText,
  shortHex,
  type TabItem,
} from './design/index.js';
import { MarketProvider } from './market/MarketContext.js';
import { About } from './pages/About.js';
import { Accounts } from './pages/Accounts.js';
import { LocalData } from './pages/LocalData.js';
import { Markets } from './pages/Markets.js';
import { Trade } from './pages/Trade.js';
import { findAccount } from './passport/records.js';
import { RelayNotices, RelayStatusProvider } from './relay/RelayStatus.js';
import { storageText } from './store/messages.js';
import { StoreProvider, useStore } from './store/StoreContext.js';
import { WalletProvider, useWallet, type WalletAdapter } from './wallet/WalletContext.js';
import { ConnectPromptContext } from './wallet/connect-prompt.js';
import { solanaWalletAdapter } from './wallet/phantom-adapter.js';
import { SignPromptStore } from './wallet/sign-prompt.js';
import { SigningPrompt } from './wallet/SigningPrompt.js';

export const SECTIONS = [
  { id: 'markets', label: 'Markets', icon: 'markets' },
  { id: 'trade', label: 'Trade', icon: 'trade' },
  { id: 'account', label: 'Portfolio', icon: 'portfolio' },
  { id: 'local', label: 'Your data', icon: 'data' },
] as const satisfies ReadonlyArray<TabItem>;
type SectionId = (typeof SECTIONS)[number]['id'];
/** Pages linked from the footer, not from the header's sections (questions Q58). */
const FOOTER_PAGES = ['about'] as const;
type PageId = SectionId | (typeof FOOTER_PAGES)[number];

const sectionFromHash = (): PageId => {
  // A section may carry parameters after '?' (#trade?pair=twBTC/twUSDC&offer=…, from the Markets page).
  const h = window.location.hash.replace(/^#/, '').split('?')[0] ?? '';
  const footerPage = FOOTER_PAGES.find((p) => p === h);
  if (footerPage) return footerPage;
  return (SECTIONS.find((s) => s.id === h)?.id ?? 'markets') as SectionId;
};

/**
 * A header menu's keyboard and dismissal (the ARIA menu button; P8.2 accessibility): the first item
 * takes the focus when the menu opens; the arrow keys, Home and End move between its items; Escape
 * closes it and gives the focus back to its button; a click outside it, or the focus leaving it
 * (Tab), closes it.
 */
function useMenu(open: boolean, close: () => void, ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    const items = () => Array.from(ref.current?.querySelectorAll<HTMLElement>('[role=menuitem]') ?? []);
    items()[0]?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        close();
        ref.current?.querySelector<HTMLElement>('[aria-haspopup]')?.focus();
        return;
      }
      const list = items();
      const i = list.indexOf(document.activeElement as HTMLElement);
      if (i < 0) return;
      const next =
        e.key === 'ArrowDown'
          ? list[(i + 1) % list.length]
          : e.key === 'ArrowUp'
            ? list[(i - 1 + list.length) % list.length]
            : e.key === 'Home'
              ? list[0]
              : e.key === 'End'
                ? list[list.length - 1]
                : undefined;
      if (next) {
        e.preventDefault();
        next.focus();
      }
    };
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const onFocus = (e: FocusEvent) => {
      if (ref.current && e.target instanceof Node && !ref.current.contains(e.target)) close();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('focusin', onFocus);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('focusin', onFocus);
    };
  }, [open, close, ref]);
}

/** The right-hand side of the header: Connect Phantom, or the connected wallet. */
function WalletArea({
  network,
  choosing,
  setChoosing,
}: {
  network: NetworkProfile;
  choosing: boolean;
  setChoosing: (v: boolean) => void;
}) {
  const w = useWallet();
  const { store, revision } = useStore();
  const [menu, setMenu] = useState(false);
  const [copied, setCopied] = useState(false);
  const area = useRef<HTMLDivElement>(null);
  const closeAll = useCallback(() => {
    setMenu(false);
    setChoosing(false);
  }, [setChoosing]);
  useMenu(menu || choosing, closeAll, area);
  // The account this wallet has in this browser (read-only; `revision` follows writes).
  const account = useMemo(
    () =>
      store && w.status === 'connected' && w.deviceKey
        ? findAccount(store, { network: network.name, owner: w.deviceKey })
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store, w.status, w.deviceKey, network.name, revision],
  );

  if (w.status === 'connected' && w.address) {
    const address = w.address;
    return (
      <div className="wallet-area" ref={area}>
        <button
          type="button"
          className="wallet-pill"
          data-testid="wallet-connected"
          aria-haspopup="menu"
          aria-expanded={menu}
          onClick={() => setMenu((m) => !m)}
        >
          <Avatar seed={address} />
          <span className="wallet-pill-text">
            <span className="id-value" data-testid="wallet-address" title={address}>
              {shortSolanaAddress(address)}
            </span>
            {account ? (
              <span className="id-sub">
                Account{' '}
                <span className="mono" title={account.address} data-testid="masthead-account">
                  {shortHex(account.address, 4, 4)}
                </span>
              </span>
            ) : (
              <span className="id-sub">No account yet</span>
            )}
          </span>
          <Icon name="chevron" className="chevron" />
        </button>
        {menu && (
          <div className="menu" role="menu" aria-label="Your wallet" data-testid="account-menu">
            <div className="menu-head">
              <Avatar seed={address} size="lg" />
              <div>
                <p className="mono small break">{shortSolanaAddress(address)}</p>
                <p className="xsmall muted">Solana wallet · {w.walletName ?? 'connected'}</p>
              </div>
            </div>
            <button
              type="button"
              role="menuitem"
              className="menu-item"
              data-testid="copy-address"
              onClick={() => void copyText(address).then(setCopied)}
            >
              <Icon name={copied ? 'check' : 'copy'} />
              {copied ? 'Address copied' : 'Copy address'}
            </button>
            <a role="menuitem" className="menu-item" href="#account" onClick={() => setMenu(false)}>
              <Icon name="portfolio" /> Portfolio
            </a>
            <a role="menuitem" className="menu-item" href="#local" onClick={() => setMenu(false)}>
              <Icon name="data" /> Your data
            </a>
            <div className="menu-sep" />
            <button
              type="button"
              role="menuitem"
              className="menu-item menu-danger"
              data-testid="disconnect"
              onClick={() => {
                setMenu(false);
                w.disconnect();
              }}
            >
              <Icon name="logout" /> Disconnect
            </button>
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="wallet-area" ref={area}>
      <Button
        data-testid="connect"
        aria-expanded={choosing}
        aria-haspopup="menu"
        disabled={w.status === 'connecting'}
        onClick={() => setChoosing(!choosing)}
      >
        <Icon name="wallet" />
        {w.status === 'connecting' ? (
          'Connecting…'
        ) : (
          <>
            <span className="connect-long">Connect Phantom</span>
            <span className="connect-short">Connect</span>
          </>
        )}
      </Button>
      {choosing && (
        <div className="menu" role="menu" aria-label="Choose a wallet" data-testid="wallet-menu">
          {!w.supported ? (
            <p className="small" data-testid="wallet-unsupported">
              Solana wallets (Phantom) are coming to this site. You can already browse the order books.
            </p>
          ) : w.options.length === 0 ? (
            <p className="small" data-testid="wallet-none">
              No Solana wallet found in this browser. Install Phantom, then reload.
            </p>
          ) : (
            <>
              <p className="menu-title">Choose a wallet</p>
              {w.options.map((o) => (
                <button
                  type="button"
                  className="menu-item"
                  role="menuitem"
                  key={o.id}
                  data-testid="wallet-option"
                  onClick={() => {
                    setChoosing(false);
                    void w.connect(o);
                  }}
                >
                  {o.icon ? <img src={o.icon} alt="" width={20} height={20} /> : <Icon name="wallet" />} {o.name}
                </button>
              ))}
              <p className="xsmall muted">Night Market only asks your wallet to sign messages. It needs no SOL.</p>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** Remember that this wallet has used the market on this network (its first record here). */
function ProfileRecorder({ network }: { network: string }) {
  const { store } = useStore();
  const { deviceKey, status } = useWallet();
  useEffect(() => {
    if (!store || store.readOnly || status !== 'connected' || !deviceKey) return;
    const scope = { network, owner: deviceKey };
    const existing = store
      .list(scope)
      .find((r) => r.parsed.kind === 'profile' && !r.parsed.scope.global && r.parsed.scope.account === null);
    const firstSeen = (existing?.record?.data as { firstSeen?: number } | undefined)?.firstSeen ?? Date.now();
    store.put(scope, 'profile', { firstSeen, lastSeen: Date.now() });
  }, [store, deviceKey, status, network]);
  return null;
}

function Shell({
  network,
  config,
  prompts,
  activity,
}: {
  network: NetworkProfile;
  config: SiteConfig;
  prompts: SignPromptStore;
  activity: ActivityStore;
}) {
  const [section, setSection] = useState<PageId>(sectionFromHash);
  useEffect(() => {
    const on = () => setSection(sectionFromHash());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  // The wallet signed: the modal moves on to the market's part of the action.
  useEffect(() => prompts.onSigned(() => activity.approved()), [prompts, activity]);
  const [choosing, setChoosing] = useState(false);
  const openConnect = useCallback(() => {
    window.scrollTo({ top: 0 });
    setChoosing(true);
  }, []);
  const { status } = useStore();
  const wallet = useWallet();
  const pending = SECTIONS.find((s) => s.id === section)?.label ?? '';
  const storage = status === 'ok' ? null : storageText(status);
  return (
    <ConnectPromptContext.Provider value={openConnect}>
      <div className="app">
        <Masthead
          network={
            <span className="net-pill" data-testid="network-name">
              Midnight {network.name}
            </span>
          }
          nav={<TabNav items={SECTIONS} current={section} />}
        >
          <WalletArea network={network} choosing={choosing} setChoosing={setChoosing} />
        </Masthead>
        <div className="wrap app-banner app-banner-stack">
          {storage && (
            <Notice tone="danger" role="alert" title={storage.title} data-testid="storage-banner" data-status={status}>
              {storage.text}
            </Notice>
          )}
          <RelayNotices place="shell" />
          <AssetFilterNote />
        </div>
        {wallet.error && (
          <Toast tone="error" title="Wallet" onClose={wallet.dismissError} data-testid="wallet-error">
            {wallet.error}
          </Toast>
        )}
        <main className="wrap app-main">
          {section === 'about' ? (
            <About networkName={`Midnight ${network.name}`} />
          ) : section === 'local' ? (
            <LocalData network={network.name} />
          ) : section === 'account' ? (
            <Accounts network={network} relayUrl={config.relayUrl} />
          ) : section === 'markets' ? (
            <Markets network={network} relayUrl={config.relayUrl} />
          ) : section === 'trade' ? (
            <Trade network={network} relayUrl={config.relayUrl} />
          ) : (
            <section data-testid={`section-${section}`}>
              <PageHead title={pending} />
              <EmptyState title="Coming soon">
                This section is being built. Your records are under <a href="#local">Your data</a>.
              </EmptyState>
            </section>
          )}
        </main>
        <SiteFooter networkName={`Midnight ${network.name}`} />
        <ProfileRecorder network={network.name} />
        <SigningPrompt prompts={prompts} activity={activity} timeoutSeconds={config.walletTimeoutSeconds} />
      </div>
    </ConnectPromptContext.Provider>
  );
}

/** The Solana wallet adapter (AA 00047 lane B2): Phantom, and any Wallet Standard wallet that signs
 *  Solana messages. Its messages use the network's label and the site's token list (the same one the
 *  relay renders with, questions Q12); without a token list there is nothing to trade, and no adapter. */
function walletAdapterFor(config: SiteConfig, prompts: SignPromptStore): WalletAdapter | null {
  let tokens;
  try {
    tokens = registryFor(config.network.name, config.tokens);
  } catch {
    return null;
  }
  return solanaWalletAdapter({
    display: { network: config.network.name, tokens },
    prompts,
    timeoutMs: config.walletTimeoutSeconds * 1000,
  });
}

function Loading({ children }: { children: ReactNode }) {
  return (
    <div className="wrap app-loading" role="status">
      <LogoMark />
      <p className="small">
        <Spinner /> {children}
      </p>
    </div>
  );
}

export function App() {
  const [config, setConfig] = useState<SiteConfig | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    loadSiteConfig().then(setConfig, (e: unknown) => setFailed(e instanceof Error ? e.message : 'configuration error'));
  }, []);
  const prompts = useMemo(() => new SignPromptStore(), []);
  const activity = useMemo(() => new ActivityStore(), []);
  const adapter = useMemo(() => (config ? walletAdapterFor(config, prompts) : null), [config, prompts]);
  if (failed)
    return (
      <div className="wrap app-banner">
        <Notice tone="danger" role="alert">
          Night Market could not start: {failed}
        </Notice>
      </div>
    );
  if (!config) return <Loading>Loading Night Market…</Loading>;
  return (
    <StoreProvider>
      <WalletProvider adapter={adapter}>
        <RelayStatusProvider relayUrl={config.relayUrl}>
          <ChainProvider network={config.network}>
            <MarketProvider network={config.network} tokens={config.tokens} pairs={config.pairs}>
              <AssetFilterProvider site={config.assets}>
                <ActivityProvider store={activity}>
                  <ToastProvider>
                    <Shell network={config.network} config={config} prompts={prompts} activity={activity} />
                  </ToastProvider>
                </ActivityProvider>
              </AssetFilterProvider>
            </MarketProvider>
          </ChainProvider>
        </RelayStatusProvider>
      </WalletProvider>
    </StoreProvider>
  );
}
