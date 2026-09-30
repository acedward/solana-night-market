// The application shell: the Night Market masthead (brand, the connected Solana wallet, the
// account with its "Midnight stagenet" badge), the tab bar, the four sections and the testnet
// footer, in the design system carried over from MN Bank. The pieces come from ./design; this file
// only wires them to the wallet and the store.
//
// A create-and-trade market: the order books (Markets) and making and taking offers (Trade) come
// first; the holdings (Account) and the browser's records (Local data) after.

import { useEffect, useMemo, useState } from 'react';

import { shortSolanaAddress, type NetworkProfile } from '@nightmarket/core';

import { AssetFilterNote, AssetFilterProvider } from './assets/AssetFilterContext.js';
import { loadSiteConfig, type SiteConfig } from './config.js';
import {
  Button,
  EmptyState,
  IdentityChip,
  Masthead,
  NetworkBadge,
  Notice,
  PageHead,
  SiteFooter,
  TabNav,
  shortHex,
} from './design/index.js';
import { MarketProvider } from './market/MarketContext.js';
import { Accounts } from './pages/Accounts.js';
import { LocalData } from './pages/LocalData.js';
import { Markets } from './pages/Markets.js';
import { Trade } from './pages/Trade.js';
import { findAccount } from './passport/records.js';
import { RelayNotices, RelayStatusProvider } from './relay/RelayStatus.js';
import { storageText } from './store/messages.js';
import { StoreProvider, useStore } from './store/StoreContext.js';
import { WalletProvider, useWallet, type WalletAdapter } from './wallet/WalletContext.js';

export const SECTIONS = [
  { id: 'markets', label: 'Markets' },
  { id: 'trade', label: 'Trade' },
  { id: 'account', label: 'Account' },
  { id: 'local', label: 'Local data' },
] as const;
type SectionId = (typeof SECTIONS)[number]['id'];

const sectionFromHash = (): SectionId => {
  // A section may carry parameters after '?' (#trade?pair=twBTC/twUSDC&offer=…, from the Markets page).
  const h = window.location.hash.replace(/^#/, '').split('?')[0] ?? '';
  return (SECTIONS.find((s) => s.id === h)?.id ?? 'markets') as SectionId;
};

/** The right-hand side of the masthead: who is connected, on which network. */
function Identity({ network }: { network: NetworkProfile }) {
  const w = useWallet();
  const { store, revision } = useStore();
  const [choosing, setChoosing] = useState(false);
  // The account this wallet has in this browser (read-only; `revision` follows writes).
  const account = useMemo(
    () =>
      store && w.status === 'connected' && w.deviceKey
        ? findAccount(store, { network: network.name, owner: w.deviceKey })
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store, w.status, w.deviceKey, network.name, revision],
  );
  const midnight = (
    <NetworkBadge network="midnight" data-testid="network-name">
      Midnight {network.name}
    </NetworkBadge>
  );

  if (w.status === 'connected' && w.address) {
    return (
      <>
        <IdentityChip
          label="Solana wallet"
          data-testid="wallet-connected"
          value={
            <span className="id-value" data-testid="wallet-address" title={w.address}>
              {shortSolanaAddress(w.address)}
            </span>
          }
        >
          <Button variant="link" onClick={w.disconnect}>
            Disconnect
          </Button>
        </IdentityChip>
        <IdentityChip
          label="Account"
          value={
            account ? (
              <span className="id-value" title={account.address} data-testid="masthead-account">
                {shortHex(account.address, 4, 4)}
              </span>
            ) : (
              <span className="id-none">none in this browser</span>
            )
          }
          badge={midnight}
        />
      </>
    );
  }
  return (
    <>
      <IdentityChip label="Network" badge={midnight} />
      <div className="wallet-area">
        <Button
          variant="inverse"
          data-testid="connect"
          aria-expanded={choosing}
          aria-haspopup="menu"
          disabled={w.status === 'connecting'}
          onClick={() => setChoosing((c) => !c)}
        >
          {w.status === 'connecting' ? 'Connecting…' : 'Connect Solana wallet'}
        </Button>
        {choosing && (
          <div className="wallet-menu" role="menu" aria-label="Choose a wallet" data-testid="wallet-menu">
            {!w.supported ? (
              <p className="small" data-testid="wallet-unsupported">
                Solana wallets (Phantom) are coming to this site. You can already browse the order books.
              </p>
            ) : w.options.length === 0 ? (
              <p className="small">No Solana wallet found in this browser. Install Phantom, then reload.</p>
            ) : (
              <>
                <p className="wallet-menu-title">Choose a wallet</p>
                {w.options.map((o) => (
                  <Button
                    variant="secondary"
                    role="menuitem"
                    key={o.id}
                    data-testid="wallet-option"
                    onClick={() => {
                      setChoosing(false);
                      void w.connect(o);
                    }}
                  >
                    {o.icon && <img src={o.icon} alt="" width={20} height={20} />} {o.name}
                  </Button>
                ))}
              </>
            )}
          </div>
        )}
      </div>
    </>
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

function Shell({ network, config }: { network: NetworkProfile; config: SiteConfig }) {
  const [section, setSection] = useState<SectionId>(sectionFromHash);
  useEffect(() => {
    const on = () => setSection(sectionFromHash());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const { status } = useStore();
  const wallet = useWallet();
  const pending = SECTIONS.find((s) => s.id === section)?.label ?? '';
  const storage = status === 'ok' ? null : storageText(status);
  return (
    <div className="app">
      <Masthead>
        <Identity network={network} />
      </Masthead>
      <TabNav items={SECTIONS} current={section} />
      <div className="wrap app-banner app-banner-stack">
        {storage && (
          <Notice tone="danger" role="alert" title={storage.title} data-testid="storage-banner" data-status={status}>
            {storage.text}
          </Notice>
        )}
        {wallet.error && (
          <Notice tone="danger" role="alert" data-testid="wallet-error">
            {wallet.error}
          </Notice>
        )}
        <RelayNotices place="shell" />
        <AssetFilterNote />
      </div>
      <main className="wrap">
        {section === 'local' ? (
          <LocalData network={network.name} relayUrl={config.relayUrl} />
        ) : section === 'account' ? (
          <Accounts network={network} relayUrl={config.relayUrl} />
        ) : section === 'markets' ? (
          <Markets />
        ) : section === 'trade' ? (
          <Trade network={network} relayUrl={config.relayUrl} />
        ) : (
          <section data-testid={`section-${section}`}>
            <PageHead title={pending} />
            <EmptyState title="Coming soon">
              This section is being built. Your records are under <a href="#local">Local data</a>.
            </EmptyState>
          </section>
        )}
      </main>
      <SiteFooter networkName={`Midnight ${network.name}`} />
      <ProfileRecorder network={network.name} />
    </div>
  );
}

/** The wallet adapter this build ships: none yet (lane B2 adds Phantom's). */
const WALLET_ADAPTER: WalletAdapter | null = null;

export function App() {
  const [config, setConfig] = useState<SiteConfig | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    loadSiteConfig().then(setConfig, (e: unknown) => setFailed(e instanceof Error ? e.message : 'configuration error'));
  }, []);
  if (failed)
    return (
      <div className="wrap app-banner">
        <Notice tone="danger" role="alert">
          Night Market could not start: {failed}
        </Notice>
      </div>
    );
  if (!config)
    return (
      <p className="wrap app-banner muted" role="status">
        Loading…
      </p>
    );
  return (
    <StoreProvider>
      <WalletProvider adapter={WALLET_ADAPTER}>
        <RelayStatusProvider relayUrl={config.relayUrl}>
          <MarketProvider network={config.network} tokens={config.tokens} pairs={config.pairs}>
            <AssetFilterProvider site={config.assets}>
              <Shell network={config.network} config={config} />
            </AssetFilterProvider>
          </MarketProvider>
        </RelayStatusProvider>
      </WalletProvider>
    </StoreProvider>
  );
}
