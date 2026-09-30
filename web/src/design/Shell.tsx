// The frame every page sits in: the navy masthead (the "NM" monogram, "Night Market", "Create and
// trade on Midnight", and the customer's identity on the right), the white tab bar, and the
// testnet footer. The design system is MN Bank's, carried over (AA 00047).
//
//   <Masthead>
//     <IdentityChip label="Solana wallet" value={<span title={addr}>7xKX…gAsU</span>} />
//     <IdentityChip label="Account" value="e8d3…2d09" badge={<NetworkBadge network="midnight">Midnight stagenet</NetworkBadge>} />
//   </Masthead>
//   <TabNav items={[{ id: 'markets', label: 'Markets' }, …]} current="markets" />
//   <SiteFooter />

import type { HTMLAttributes, ReactNode } from 'react';

import { cx } from './format.js';

export function Masthead({ homeHref = '#markets', children }: { homeHref?: string; children?: ReactNode }) {
  return (
    <header className="masthead">
      <div className="wrap masthead-inner">
        <h1 className="brand">
          <a href={homeHref}>
            <span className="monogram" aria-hidden="true">
              NM
            </span>
            <span>
              <span className="brand-name">Night Market</span>{' '}
              <span className="brand-tagline">Create and trade on Midnight</span>
            </span>
          </a>
        </h1>
        {children ? <div className="identity">{children}</div> : null}
      </div>
    </header>
  );
}

export function IdentityChip({
  label,
  value,
  badge,
  className,
  children,
  ...rest
}: Omit<HTMLAttributes<HTMLDivElement>, 'title'> & { label: ReactNode; value?: ReactNode; badge?: ReactNode }) {
  return (
    <div className={cx('id-chip', className)} {...rest}>
      <span className="id-label">{label}</span>
      {value}
      {badge}
      {children}
    </div>
  );
}

export interface TabItem {
  id: string;
  label: ReactNode;
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
    <nav className="tabs" aria-label={label}>
      <div className="wrap">
        <ul>
          {items.map((t) => (
            <li key={t.id}>
              <a href={`#${t.id}`} aria-current={current === t.id ? 'page' : undefined} data-testid={`tab-${t.id}`}>
                {t.label}
              </a>
            </li>
          ))}
        </ul>
      </div>
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
          The tokens are Midnight test tokens with public faucets. Your Solana wallet only signs messages: this app never
          sends a Solana transaction, and never asks for your wallet&apos;s seed or private key.
        </p>
      </div>
    </footer>
  );
}
