// The market's side panel (AA 00047 lane B2: "a create-and-trade market, not a bank": the books and
// making or taking offers come first, holdings beside them). Who is connected, what the account
// holds (each token in its own units, shielded coins and unshielded balances; nothing is totalled in
// a "home" token), the way to get demo tokens, and the way to the full Account page (withdrawals,
// pending items). Before a wallet or an account exists it says what to do next.

import { useMemo } from 'react';

import { formatUnits, holdingsByColour, shortSolanaAddress, type NetworkProfile } from '@nightmarket/core';

import { useAssetFilter } from '../assets/AssetFilterContext.js';
import { DemoTokens } from '../demo/DemoTokens.js';
import { ButtonLink, Panel } from '../design/index.js';
import { useTokenRegistry } from '../market/MarketContext.js';
import { useStore } from '../store/StoreContext.js';
import { useAccountView, useUnshieldedBalances } from './useAccountView.js';

const short = (s: string) => (s.length <= 15 ? s : `${s.slice(0, 8)}…${s.slice(-6)}`);

export function HoldingsPanel({ network, relayUrl }: { network: NetworkProfile; relayUrl: string }) {
  const { wallet, account, hasSecret, coins, relay } = useAccountView(network, relayUrl);
  const { revision } = useStore();
  const tokens = useTokenRegistry();
  const assets = useAssetFilter();
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
      <Panel title="Your holdings" tone="quiet" as="aside" data-testid="holdings-panel" data-state="no-wallet">
        <p className="small">
          {wallet.supported
            ? 'Connect your Solana wallet (top right) to make and take offers. It only signs messages: it needs no SOL, and the market pays every Midnight fee.'
            : 'Accounts controlled by a Solana wallet (Phantom) are coming to this site.'}
        </p>
      </Panel>
    );
  }
  if (!account || !hasSecret) {
    return (
      <Panel title="Your holdings" tone="quiet" as="aside" data-testid="holdings-panel" data-state="no-account">
        <p className="small">
          {account
            ? 'This browser does not hold your account’s key: import your export on Local data.'
            : 'Open your account to trade: one signature, no SOL, and the market pays the fees.'}
        </p>
        <ButtonLink variant="primary" href={account ? '#local' : '#account'} data-testid="holdings-next">
          {account ? 'Import your data' : 'Open your account'}
        </ButtonLink>
      </Panel>
    );
  }
  return (
    <div className="stack-gap" data-testid="holdings-side">
      <Panel
        title="Your holdings"
        tone="quiet"
        as="aside"
        data-testid="holdings-panel"
        data-state="account"
        meta={
          <span className="xsmall muted" title={wallet.address}>
            {shortSolanaAddress(wallet.address)}
          </span>
        }
      >
        {rows.length === 0 ? (
          <p className="small muted" data-testid="holdings-empty">
            No tokens yet. Get the demo pack below, or deposit from a Midnight wallet.
          </p>
        ) : (
          <ul className="holdings-list">
            {rows.map((r) => {
              const t = tokens?.byColour(r.colour);
              return (
                <li
                  key={`${r.kind}-${r.colour}`}
                  data-testid="holding"
                  data-symbol={t?.symbol ?? ''}
                  data-kind={r.kind}
                  data-raw={r.amount.toString()}
                >
                  <span className="sym">
                    {t?.symbol ?? short(r.colour)}
                    {r.kind === 'unshielded' && <span className="xsmall muted"> unshielded</span>}
                  </span>
                  <span className="num">
                    {formatUnits(r.amount, t?.decimals ?? 0, { minFractionDigits: 2, grouping: true })}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        <p className="xsmall muted section-gap">
          <a href="#account" data-testid="holdings-withdraw">
            Withdraw or see pending items
          </a>
        </p>
      </Panel>
      <DemoTokens network={network} relayUrl={relayUrl} />
    </div>
  );
}
