// The portfolio beside the books (AA 00047 P8.1, questions Q21): docked as a side column on a wide
// screen (from 1180 px), and a drawer from the right below that, opened by the page's "Portfolio"
// button. ONE panel either way (the holdings panel, ./HoldingsPanel.tsx), so every test id stays
// unique; CSS decides where it sits (components.css, "the portfolio dock").

import { useEffect, useRef } from 'react';

import type { NetworkProfile } from '@nightmarket/core';

import { Button, Icon, cx } from '../design/index.js';
import { useWallet } from '../wallet/WalletContext.js';
import { HoldingsPanel } from './HoldingsPanel.js';

export function PortfolioDock({
  network,
  relayUrl,
  open,
  onClose,
}: {
  network: NetworkProfile;
  relayUrl: string;
  /** The drawer is open (narrow screens; a docked panel is always shown). */
  open: boolean;
  onClose(): void;
}) {
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    close.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  return (
    <>
      {open && (
        <button type="button" className="scrim" tabIndex={-1} aria-label="Close the portfolio" onClick={onClose} />
      )}
      <aside
        className={cx('dock', open && 'dock-open')}
        id="portfolio-dock"
        aria-label="Your portfolio"
        data-testid="portfolio-dock"
      >
        <div className="dock-head">
          <h2 className="panel-title">Portfolio</h2>
          <button ref={close} type="button" className="icon-btn" aria-label="Close the portfolio" onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
        <HoldingsPanel network={network} relayUrl={relayUrl} />
      </aside>
    </>
  );
}

/** The page's "Portfolio" button ("Get started" before a wallet connects): opens the drawer
 *  (hidden where the panel is docked). */
export function PortfolioToggle({ open, onClick }: { open: boolean; onClick(): void }) {
  const connected = useWallet().status === 'connected';
  return (
    <Button
      variant="secondary"
      className="portfolio-toggle"
      aria-controls="portfolio-dock"
      aria-expanded={open}
      data-testid="portfolio-toggle"
      onClick={onClick}
    >
      <Icon name={connected ? 'portfolio' : 'spark'} /> {connected ? 'Portfolio' : 'Get started'}
    </Button>
  );
}
