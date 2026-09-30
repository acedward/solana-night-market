// The portfolio beside the books (AA 00047 P8.1, questions Q21): docked as a side column on a wide
// screen (from 1180 px), and a drawer from the right below that, opened by the page's "Portfolio"
// button. ONE panel either way (the holdings panel, ./HoldingsPanel.tsx), so every test id stays
// unique; CSS decides where it sits (components.css, "the portfolio dock").
//
// The open drawer is a modal dialog (P8.2, accessibility): it takes the focus (its close button),
// keeps Tab and Shift+Tab inside it, closes on Escape or a tap on the scrim, and gives the focus
// back to what opened it. Where the panel is docked there is nothing to open: an open request
// there (the window widened while the drawer was open) just closes it.

import { useEffect, useId, useRef } from 'react';

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
  const panel = useRef<HTMLElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  // The pages pass a new closure on every render: the effect below must not re-run for it (that
  // would pull the focus back to the close button on every re-render).
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });
  useEffect(() => {
    if (!open) return;
    if (window.matchMedia && !window.matchMedia(DRAWER_MEDIA).matches) {
      onCloseRef.current();
      return;
    }
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    close.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      const root = panel.current;
      if (e.key !== 'Tab' || !root) return;
      const items = focusables(root);
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;
      const inside = root.contains(document.activeElement);
      if (e.shiftKey && (!inside || document.activeElement === first)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (!inside || document.activeElement === last)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      // Back to what opened the drawer (the Portfolio button), unless the page it was on has gone.
      if (opener?.isConnected) opener.focus();
    };
  }, [open]);
  return (
    <>
      {open && (
        <button type="button" className="scrim" tabIndex={-1} aria-label="Close the portfolio" onClick={onClose} />
      )}
      <aside
        ref={panel}
        className={cx('dock', open && 'dock-open')}
        id="portfolio-dock"
        {...(open
          ? { role: 'dialog', 'aria-modal': true, 'aria-labelledby': titleId }
          : { 'aria-label': 'Your portfolio' })}
        data-testid="portfolio-dock"
      >
        <div className="dock-head">
          <h2 className="panel-title" id={titleId}>
            Portfolio
          </h2>
          <button ref={close} type="button" className="icon-btn" aria-label="Close the portfolio" onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
        <HoldingsPanel network={network} relayUrl={relayUrl} />
      </aside>
    </>
  );
}

/** Where the panel is a drawer, not docked (components.css, "the portfolio dock"). */
const DRAWER_MEDIA = '(max-width: 1179px)';

/** The drawer's keyboard stops, in order: what Tab can reach and is on screen. */
function focusables(root: HTMLElement): HTMLElement[] {
  const all = root.querySelectorAll<HTMLElement>(
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  );
  return Array.from(all).filter((el) => el.tabIndex >= 0 && el.getClientRects().length > 0);
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
