// The frame every page sits in (AA 00047 P8.1, spec FR-006b): a wallet-first header (the Night
// Market mark and name, the network, the sections, and the wallet on the right), and a short
// testnet footer, which links the About page (#about, AA 00047 P11.D). On a phone the sections move
// to a tab bar at the bottom of the screen.
//
//   <Masthead network={<span className="net-pill">Midnight stagenet</span>}
//             nav={<TabNav items={SECTIONS} current="markets" />}>
//     <ConnectButton />                         the wallet area (App.tsx)
//   </Masthead>
//   <SiteFooter networkName="Midnight stagenet" />

import type { ReactNode } from 'react';

import { Icon, LogoMark, type IconName } from './Icon.js';

export function Masthead({
  homeHref = '#markets',
  network,
  nav,
  children,
}: {
  homeHref?: string;
  /** The network pill, beside the name. */
  network?: ReactNode;
  /** The sections (a TabNav). */
  nav?: ReactNode;
  /** The wallet area, at the right. */
  children?: ReactNode;
}) {
  return (
    <header className="app-header">
      <div className="wrap app-header-inner">
        <div className="brand-block">
          <h1 className="brand">
            <a href={homeHref}>
              <LogoMark />
              <span className="brand-name">Night Market</span>
            </a>
          </h1>
          {network}
        </div>
        {nav}
        <div className="header-end">{children}</div>
      </div>
    </header>
  );
}

export interface TabItem {
  id: string;
  label: ReactNode;
  icon?: IconName;
}

export function TabNav({
  items,
  current,
  label = 'Sections',
}: {
  items: ReadonlyArray<TabItem>;
  current: string;
  label?: string;
}) {
  return (
    <nav className="nav" aria-label={label}>
      <ul>
        {items.map((t) => (
          <li key={t.id}>
            <a href={`#${t.id}`} aria-current={current === t.id ? 'page' : undefined} data-testid={`tab-${t.id}`}>
              {t.icon ? <Icon name={t.icon} className="nav-icon" /> : null}
              <span>{t.label}</span>
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export function SiteFooter({ networkName = 'Midnight stagenet' }) {
  return (
    <footer className="site-foot">
      <div className="wrap">
        <p className="testnet" data-testid="testnet-notice">
          Testnet only — {networkName}. Tokens have no real value. A proof of concept.
        </p>
        <p>
          The tokens are Midnight test tokens from public faucets. Your Solana wallet only signs messages: Night Market
          never sends a Solana transaction, and never asks for your seed phrase or private key.
        </p>
        <p>
          <a href="#about" data-testid="about-link">
            About Night Market and its known limitations
          </a>
        </p>
      </div>
    </footer>
  );
}
