// The portfolio panel beside the books (AA 00047 lane B2: "a create-and-trade market, not a bank":
// the books and making or taking offers come first, holdings beside them; restyled in P8.1). What
// the account holds (each token in its own units, shielded coins and unshielded balances; nothing
// is totalled in a "home" token), the free demo pack, and the way to withdraw. Before a wallet or an
// account exists it walks the newcomer through the three steps to their first trade.

import { useMemo } from 'react';

import { formatUnits, holdingsByColour, shortSolanaAddress, type NetworkProfile } from '@nightmarket/core';

import { useAssetFilter } from '../assets/AssetFilterContext.js';
import { DemoTokens } from '../demo/DemoTokens.js';
import { Button, ButtonLink, Icon, Panel, TokenIcon } from '../design/index.js';
import { useTokenRegistry } from '../market/MarketContext.js';
import { useStore } from '../store/StoreContext.js';
import { useConnectPrompt } from '../wallet/connect-prompt.js';
import { useAccountView, useUnshieldedBalances } from './useAccountView.js';

const short = (s: string) => (s.length <= 15 ? s : `${s.slice(0, 8)}…${s.slice(-6)}`);

/** The three steps from a visit to a first trade. */
function Onboarding({ done }: { done: 0 | 1 }) {
  return (
    <ol className="onboarding">
      <li>
        <strong>{done > 0 ? 'Phantom connected' : 'Connect Phantom'}</strong>
        It only signs messages: no SOL needed.
      </li>
      <li>
        <strong>Open your free account</strong>
        One approval. The market pays every network fee.
      </li>
      <li>
        <strong>Get demo tokens</strong>A free pack of test tokens to trade with.
      </li>
    </ol>
  );
}

export function HoldingsPanel({ network, relayUrl }: { network: NetworkProfile; relayUrl: string }) {
  const { wallet, account, hasSecret, coins, relay } = useAccountView(network, relayUrl);
  const { revision } = useStore();
  const tokens = useTokenRegistry();
  const assets = useAssetFilter();
  const connect = useConnectPrompt();
  const unshielded = useUnshieldedBalances(relay, account && hasSecret ? account.address : null, revision);

  const rows = useMemo(() => {
    const order = (colour: string) => {
      const i = tokens?.tokens.findIndex((t) => t.midnightColour === colour) ?? -1;
      return i < 0 ? Number.MAX_SAFE_INTEGER : i;
    };
    const shielded = holdingsByColour(coins).map((h) => ({
      colour: h.color,
      amount: h.total,
      kind: 'shielded' as const,
    }));
    const open = (unshielded.view?.balances ?? []).map((b) => ({
      colour: b.colour,
      amount: BigInt(b.amount),
      kind: 'unshielded' as const,
    }));
    return [...shielded, ...open]
      .filter((r) => assets.showsColour(r.colour) && r.amount > 0n)
      .sort((a, b) => order(a.colour) - order(b.colour) || a.kind.localeCompare(b.kind));
  }, [coins, unshielded.view, tokens, assets]);

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
                <Icon name="wallet" /> Connect Phantom
              </Button>
            )}
          </>
        ) : (
          <p className="small">Accounts controlled by a Solana wallet (Phantom) are coming to this site.</p>
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
            This browser does not hold your account&apos;s key. Import your backup file on Your data.
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
            No tokens yet. Grab the free demo pack below to start trading.
          </p>
        ) : (
          <ul className="holdings-list">
            {rows.map((r) => {
              const t = tokens?.byColour(r.colour);
              const symbol = t?.symbol ?? short(r.colour);
              return (
                <li
                  key={`${r.kind}-${r.colour}`}
                  data-testid="holding"
                  data-symbol={t?.symbol ?? ''}
                  data-kind={r.kind}
                  data-raw={r.amount.toString()}
                >
                  <TokenIcon symbol={symbol} small />
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
          <ButtonLink variant="secondary" size="small" href="#account" data-testid="holdings-withdraw">
            <Icon name="arrowUp" /> Withdraw
          </ButtonLink>
          <a className="xsmall" href="#account">
            Full portfolio
          </a>
        </div>
      </Panel>
      <DemoTokens network={network} relayUrl={relayUrl} />
    </div>
  );
}
