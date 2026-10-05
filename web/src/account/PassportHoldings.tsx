// The Portfolio's "Your tokens" list (moved out of pages/Accounts.tsx in AA 00060 P12.1): each token in
// its own units, private (shielded) coins and public (unshielded) balances, in the market's token order.
//
// AA 00060 P12.1 (spec FR-020): a token with a Solana version (an I-1 entry, ../bridge/portfolio.ts) is ONE
// row with its total, its private balance on Midnight and the wallet's SPL balance on Solana, with the
// mint's address (shortened, copyable in full). The total shows only when both reads succeeded; a failed
// line says "unavailable". Every other token's row is exactly as before.
// P12.1b (FR-022): each token shows its configured icon (the wallet's own image), else its text badge.

import { formatUnits, holdingsByColour, type StoredCoin, type TokenRegistry } from '@nightmarket/core';

import type { BridgedHolding } from '../bridge/portfolio.js';
import { EmptyState, Hash, Sub, TokenIcon } from '../design/index.js';

const short = (s: string, head = 8, tail = 6) =>
  s.length <= head + tail + 1 ? s : `${s.slice(0, head)}…${s.slice(-tail)}`;

const fmt = (raw: bigint, decimals: number) => formatUnits(raw, decimals, { minFractionDigits: 2, grouping: true });

/** One bridged token: the total, then the Midnight line and the Solana line. */
export function BridgedHoldingRow({ row, tokens }: { row: BridgedHolding; tokens: TokenRegistry | null }) {
  const { entry, midnight, solana, total } = row;
  const t = tokens?.byColour(entry.colour);
  const dec = entry.decimals;
  return (
    <li
      className="token-row token-row-bridged"
      data-testid="passport-row"
      data-kind="bridged"
      data-colour={entry.colour}
      data-symbol={entry.symbol}
    >
      <TokenIcon symbol={entry.symbol} src={t?.icon ?? null} />
      <span className="token-meta">
        <span className="token-sym">
          {entry.symbol}
          <span className="kind-chip">Midnight + Solana</span>
        </span>
        <span className="token-name">{t?.name ?? entry.name}</span>
      </span>
      <span className="token-amount">
        {total !== null ? (
          <>
            <Sub>Total</Sub>
            <span className="num" data-testid="bridged-total" data-raw={total.toString()}>
              {fmt(total, dec)}
            </span>
          </>
        ) : (
          <Sub data-testid="bridged-no-total">{solana.state === 'loading' ? 'Totalling…' : 'No total'}</Sub>
        )}
      </span>
      <ul className="bridged-lines" aria-label={`${entry.symbol} on each network`}>
        <li data-testid="bridged-midnight" data-state={midnight.state}>
          {midnight.state === 'ok' ? (
            <>
              <span className="num" data-testid="passport-amount" data-raw={midnight.amount.toString()}>
                {fmt(midnight.amount, dec)}
              </span>{' '}
              (Private) on Midnight
              {midnight.unsaved > 0n && (
                <span className="muted" data-testid="bridged-unsaved" data-raw={midnight.unsaved.toString()}>
                  {' '}
                  · {fmt(midnight.unsaved, dec)} not saved in your inbox yet
                </span>
              )}
            </>
          ) : (
            <>
              Midnight: unavailable <span className="muted">({midnight.why})</span>
            </>
          )}
        </li>
        <li data-testid="bridged-solana" data-state={solana.state}>
          {entry.icon ? <TokenIcon symbol={entry.symbol} src={entry.icon} small /> : null}
          {solana.state === 'ok' ? (
            <span>
              <span className="num" data-testid="bridged-solana-amount" data-raw={solana.amount.toString()}>
                {fmt(solana.amount, dec)}
              </span>{' '}
              on Solana
            </span>
          ) : solana.state === 'loading' ? (
            <span className="muted">Reading your Solana wallet…</span>
          ) : (
            <span data-testid="bridged-solana-unavailable">
              Solana: unavailable <span className="muted">({solana.why})</span>
            </span>
          )}{' '}
          <span className="bridged-mint">
            (<Hash value={entry.splMint} head={6} tail={6} data-testid="bridged-mint" />)
          </span>
        </li>
      </ul>
    </li>
  );
}

export function PassportHoldings({
  coins,
  tokens,
  unshielded,
  bridged = [],
}: {
  coins: StoredCoin[];
  tokens: TokenRegistry | null;
  unshielded: Array<{ colour: string; amount: bigint }>;
  /** FR-020: one row per I-1 token (../bridge/portfolio.ts); these colours get no plain row. */
  bridged?: readonly BridgedHolding[];
}) {
  // Listed in the market's token order (the registry's); unknown colours last.
  const order = (colour: string) => {
    const i = tokens?.tokens.findIndex((t) => t.midnightColour === colour) ?? -1;
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  const bridgedColours = new Set(bridged.map((b) => b.entry.colour));
  const rows = holdingsByColour(coins)
    .filter((h) => !bridgedColours.has(h.color))
    .map((h) => ({ h, token: tokens?.byColour(h.color) }))
    .sort((a, b) => order(a.h.color) - order(b.h.color));
  const open = unshielded
    .filter((u) => u.amount > 0n)
    .map((u) => ({ u, token: tokens?.byColour(u.colour) }))
    .sort((a, b) => order(a.u.colour) - order(b.u.colour));
  if (rows.length === 0 && open.length === 0 && bridged.length === 0) {
    return (
      <EmptyState data-testid="passport-empty" icon="gift" title="No tokens yet">
        Get the free demo pack (Mint Midnight tokens below), or send tokens to your account. They show here once they
        land.
      </EmptyState>
    );
  }
  return (
    <ul className="token-list" aria-label="Your tokens" data-testid="passport-holdings">
      {rows.map(({ h, token: t }) => {
        const dec = t?.decimals ?? 0;
        const symbol = t?.symbol ?? short(h.color);
        return (
          <li
            key={h.color}
            className="token-row"
            data-testid="passport-row"
            data-colour={h.color}
            data-symbol={t?.symbol ?? ''}
          >
            <TokenIcon symbol={symbol} src={t?.icon ?? null} />
            <span className="token-meta">
              <span className="token-sym">
                {symbol}
                <span className="kind-chip">{t && t.privacy !== 'shielded' ? 'public' : 'private'}</span>
              </span>
              {t?.name ? <span className="token-name">{t.name}</span> : null}
            </span>
            <span className="token-amount">
              <span className="num" data-testid="passport-amount" data-raw={h.total.toString()}>
                {fmt(h.total, dec)}
              </span>
              <Sub>
                up to{' '}
                <span data-testid="passport-largest" data-raw={h.largest.toString()}>
                  {fmt(h.largest, dec)}
                </span>{' '}
                in one go
              </Sub>
            </span>
          </li>
        );
      })}
      {bridged.map((b) => (
        <BridgedHoldingRow key={`b-${b.entry.colour}`} row={b} tokens={tokens} />
      ))}
      {open.map(({ u, token: t }) => {
        const symbol = t?.symbol ?? short(u.colour);
        return (
          <li
            key={`u-${u.colour}`}
            className="token-row"
            data-testid="passport-row"
            data-kind="unshielded"
            data-colour={u.colour}
            data-symbol={t?.symbol ?? ''}
          >
            <TokenIcon symbol={symbol} src={t?.icon ?? null} />
            <span className="token-meta">
              <span className="token-sym">
                {symbol}
                <span className="kind-chip">public</span>
              </span>
              <span className="token-name">{t?.name ? `${t.name} · public balance` : 'public balance'}</span>
            </span>
            <span className="token-amount">
              <span className="num" data-testid="passport-amount" data-raw={u.amount.toString()}>
                {fmt(u.amount, t?.decimals ?? 0)}
              </span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}
