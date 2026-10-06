// The portfolio panel beside the books (AA 00047 lane B2: "a create-and-trade market, not a bank":
// the books and making or taking offers come first, holdings beside them; restyled in P8.1). What
// the account holds (each token in its own units, shielded coins and unshielded balances; nothing
// is totalled in a "home" token), and the way to the Portfolio's actions. Before a wallet or an
// account exists it walks the newcomer through the three steps to their first trade.
//
// AA 00060 FR-023 (owner, 2026-10-05: "Keep Free demo tokens only in the Portfolio View"): the free demo
// pack is no longer claimed here; this panel links to the Portfolio's "Mint Midnight tokens". FR-022:
// each token shows its configured icon (the wallet's own image), else its text badge.
//
// AA 00060 P12.1d (spec FR-025): each token's FULL value. A bridged token (an I-1 entry) is ONE row whose
// value is the FR-020 total (Midnight private + the wallet's SPL on Solana, read once for every view:
// ../bridge/SolanaLinesContext.tsx); a click (or Enter / Space) expands it into its two versions, with the
// mint shortened and copyable. A token with one version does not expand. Only values above zero show. When
// the Solana read failed, the row shows the Midnight value marked "Solana unavailable", never a total.

import { useId, useMemo, useState } from 'react';

import { formatUnits, holdingsByColour, shortSolanaAddress, type NetworkProfile } from '@nightmarket/core';

import { useAssetFilter } from '../assets/AssetFilterContext.js';
import { compactRows, type CompactRow } from '../bridge/portfolio.js';
import { useSolanaHoldings } from '../bridge/SolanaLinesContext.js';
import { Button, ButtonLink, Hash, Icon, Panel, TokenIcon } from '../design/index.js';
import { useTokenRegistry } from '../market/MarketContext.js';
import { useStore } from '../store/StoreContext.js';
import { useConnectPrompt } from '../wallet/connect-prompt.js';
import { useMidnightReadFailure } from '../passport/read-status.js';
import { actionHref } from './PortfolioActions.js';
import { useAccountView, useUnshieldedBalances } from './useAccountView.js';

const short = (s: string) => (s.length <= 15 ? s : `${s.slice(0, 8)}…${s.slice(-6)}`);
const fmt = (raw: bigint, decimals: number) => formatUnits(raw, decimals, { minFractionDigits: 2, grouping: true });

/** A bridged token: its full value; expands (a disclosure button) into Midnight and Solana. */
export function BridgedHolding({
  row,
  symbol,
  icon,
}: {
  row: Extract<CompactRow, { kind: 'bridged' }>;
  symbol: string;
  icon: string | null;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const dec = row.entry.decimals;
  const mark =
    row.midnight === null
      ? 'Midnight unavailable'
      : row.solana.state === 'unavailable'
        ? 'Solana unavailable'
        : row.solana.state === 'loading'
          ? 'Reading Solana…'
          : null;
  return (
    <li
      className="holding-bridged"
      data-testid="holding"
      data-symbol={symbol}
      data-kind="bridged"
      data-raw={row.value.toString()}
      data-total={row.total ? 'yes' : 'no'}
      data-expanded={open ? 'true' : 'false'}
    >
      <button
        type="button"
        className="holding-toggle"
        aria-expanded={open}
        aria-controls={id}
        data-testid="holding-toggle"
        onClick={() => setOpen((o) => !o)}
      >
        <TokenIcon symbol={symbol} src={icon} small />
        <span className="sym">
          {symbol}
          {mark && (
            <span
              className="kind-chip"
              data-testid="holding-solana-mark"
              data-state={row.midnight === null ? 'midnight-unavailable' : row.solana.state}
            >
              {mark}
            </span>
          )}
        </span>
        <span className="num" data-testid="holding-value">
          {fmt(row.value, dec)}
        </span>
        <Icon name="chevron" className={open ? 'holding-chevron is-open' : 'holding-chevron'} />
        <span className="sr-only">{open ? ' (hide Midnight and Solana)' : ' (show Midnight and Solana)'}</span>
      </button>
      <ul className="holding-versions" id={id} hidden={!open} data-testid="holding-versions">
        <li data-testid="holding-midnight" data-state={row.midnight === null ? 'unavailable' : 'ok'}>
          {row.midnight === null ? 'Midnight: unavailable' : `${fmt(row.midnight, dec)} (Private) on Midnight`}
        </li>
        <li data-testid="holding-solana" data-state={row.solana.state}>
          {row.solana.state === 'ok'
            ? `${fmt(row.solana.amount, dec)} on Solana`
            : row.solana.state === 'loading'
              ? 'Solana: reading…'
              : 'Solana: unavailable'}{' '}
          <span className="holding-mint">
            (<Hash value={row.entry.splMint} head={6} tail={6} data-testid="holding-mint" />)
          </span>
        </li>
      </ul>
    </li>
  );
}

/** The three steps from a visit to a first trade. */
function Onboarding({ done }: { done: 0 | 1 }) {
  return (
    <ol className="onboarding">
      <li>
        <strong>{done > 0 ? 'Wallet connected' : 'Connect your Solana wallet'}</strong>
        It only signs messages: no SOL needed.
      </li>
      <li>
        <strong>Open your free account</strong>
        One approval. The market pays every network fee.
      </li>
      <li>
        <strong>Get demo tokens</strong>A free pack of test tokens to trade with, on your Portfolio.
      </li>
    </ol>
  );
}

export function HoldingsPanel({ network, relayUrl }: { network: NetworkProfile; relayUrl: string }) {
  const { wallet, account, hasSecret, coins, chain } = useAccountView(network, relayUrl);
  const { revision } = useStore();
  const tokens = useTokenRegistry();
  const assets = useAssetFilter();
  const connect = useConnectPrompt();
  const unshielded = useUnshieldedBalances(chain, account && hasSecret ? account.address : null, revision);
  // FR-025: the same Solana lines as the Portfolio's rows (one read for both views).
  const solana = useSolanaHoldings(coins);
  // P11 (light review L-B1): after a failed read on Midnight, no total from the stale coins.
  const midnightFailure = useMidnightReadFailure(account && hasSecret ? account.address : null);

  const rows = useMemo(() => {
    const order = (colour: string) => {
      const i = tokens?.tokens.findIndex((t) => t.midnightColour === colour) ?? -1;
      return i < 0 ? Number.MAX_SAFE_INTEGER : i;
    };
    const shielded = holdingsByColour(coins)
      .map((h) => ({ colour: h.color, amount: h.total }))
      .filter((h) => assets.showsColour(h.colour));
    const open = (unshielded.view?.balances ?? [])
      .map((b) => ({ colour: b.colour, amount: BigInt(b.amount) }))
      .filter((b) => assets.showsColour(b.colour));
    const entries = solana.entries.filter((e) => assets.showsColour(e.colour));
    return compactRows(shielded, open, entries, solana.lines, order, midnightFailure);
  }, [coins, unshielded.view, tokens, assets, solana.entries, solana.lines, midnightFailure]);

  if (wallet.status !== 'connected' || !wallet.address) {
    return (
      <Panel title="Start trading" tone="accent" data-testid="holdings-panel" data-state="no-wallet">
        {wallet.supported ? (
          <>
            <p className="small muted">
              Connect your Solana wallet to make and take offers. It only signs messages: it needs no SOL, and the
              market pays every Midnight fee.
            </p>
            <Onboarding done={0} />
            {connect && (
              <Button className="btn-block" data-testid="connect-cta" onClick={connect}>
                <Icon name="wallet" /> Connect wallet
              </Button>
            )}
          </>
        ) : (
          <p className="small">Accounts controlled by a Solana wallet are coming to this site.</p>
        )}
      </Panel>
    );
  }
  if (!account || !hasSecret) {
    return (
      <Panel
        title={account ? 'Restore your account' : 'Open your free account'}
        tone="accent"
        data-testid="holdings-panel"
        data-state="no-account"
      >
        {account ? (
          <p className="small muted">
            This browser does not hold your account&apos;s key. Import your backup file on Local Data.
          </p>
        ) : (
          <>
            <p className="small muted">You&apos;re connected. Two more steps to your first trade:</p>
            <Onboarding done={1} />
          </>
        )}
        <ButtonLink
          variant="primary"
          className="btn-block"
          href={account ? '#local' : '#account'}
          data-testid="holdings-next"
        >
          {account ? 'Import your data' : 'Open your account'}
        </ButtonLink>
      </Panel>
    );
  }
  return (
    <div className="stack-gap" data-testid="holdings-side">
      <Panel
        title="Your tokens"
        data-testid="holdings-panel"
        data-state="account"
        meta={
          <span className="xsmall muted mono" title={wallet.address}>
            {shortSolanaAddress(wallet.address)}
          </span>
        }
      >
        {rows.length === 0 ? (
          <p className="small muted" data-testid="holdings-empty">
            No tokens yet. Get the free demo pack on your Portfolio (
            <a href={actionHref('mint-midnight')} data-testid="holdings-get-demo">
              Mint Midnight tokens
            </a>
            ) to start trading.
          </p>
        ) : (
          <ul className="holdings-list">
            {rows.map((r) => {
              const t = tokens?.byColour(r.colour);
              if (r.kind === 'bridged')
                return (
                  <BridgedHolding
                    key={`bridged-${r.colour}`}
                    row={r}
                    symbol={t?.symbol ?? r.entry.symbol}
                    icon={t?.icon ?? null}
                  />
                );
              const symbol = t?.symbol ?? short(r.colour);
              return (
                <li
                  key={`${r.kind}-${r.colour}`}
                  data-testid="holding"
                  data-symbol={t?.symbol ?? ''}
                  data-kind={r.kind}
                  data-raw={r.amount.toString()}
                >
                  <TokenIcon symbol={symbol} src={t?.icon ?? null} small />
                  <span className="sym">
                    {symbol}
                    {r.kind === 'unshielded' && <span className="kind-chip">public</span>}
                  </span>
                  <span className="num">
                    {formatUnits(r.amount, t?.decimals ?? 0, { minFractionDigits: 2, grouping: true })}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        <div className="btn-row gap-top">
          <ButtonLink variant="secondary" size="small" href={actionHref('send')} data-testid="holdings-withdraw">
            <Icon name="arrowUp" /> Withdraw
          </ButtonLink>
          <a className="xsmall" href="#account">
            Full portfolio
          </a>
        </div>
      </Panel>
    </div>
  );
}
