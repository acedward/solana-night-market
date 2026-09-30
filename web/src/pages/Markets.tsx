// The Markets section: every listed pair (BASE/QUOTE, any two tokens, none special), priced only
// from the live offers on the exchange, and a per-pair order book. Each book line's Take opens the
// Trade section on that offer (plan L-TRD), which shows the exact legs and whether one coin can
// pay. Styled with the design system carried over from MN Bank; every word on the page comes from
// ../market/view.ts.

import { useState } from 'react';

import type { FeedState, Market } from '@nightmarket/core';

import { assetFilterText, useAssetFilter } from '../assets/AssetFilterContext.js';
import {
  AssetCell,
  Badge,
  Button,
  ButtonLink,
  Cell,
  NoValue,
  Notice,
  PageHead,
  Panel,
  StatementTable,
  StatusPill,
  Sub,
  type BadgeTone,
  type Column,
} from '../design/index.js';
import { useMarkets } from '../market/MarketContext.js';
import {
  STATUS_TEXT,
  bookLines,
  depthText,
  ignoredText,
  lastTradeText,
  marketRows,
  spreadText,
  type MarketStatus,
} from '../market/view.js';

const clock = (ms: number) => new Date(ms).toISOString().slice(11, 19);

const STATUS_TONE: Record<MarketStatus, BadgeTone> = {
  'two-sided': 'green',
  'bids-only': 'navy',
  'asks-only': 'navy',
  'no-liquidity': 'grey',
  unavailable: 'red',
  loading: 'grey',
};

/** A price, or the words for its absence ("no bids", "—") in the quiet italic style. */
const isPrice = (text: string) => /^-?[0-9]/.test(text);

function FeedStatus({ state }: { state: FeedState }) {
  const stream =
    state.stream === 'live'
      ? 'Live'
      : state.stream === 'polling'
        ? 'Updating every 15 s'
        : state.stream === 'connecting'
          ? 'Connecting…'
          : '';
  const updated =
    state.status === 'ready'
      ? `updated ${clock(state.updatedAt)} UTC`
      : state.status === 'unavailable' && state.lastUpdatedAt !== null
        ? `last read ${clock(state.lastUpdatedAt)} UTC`
        : '';
  return (
    <p className="feed" data-testid="market-feed-status" data-stream={state.stream} data-status={state.status}>
      {stream ? (
        <StatusPill status={state.stream === 'live' ? 'live' : state.stream === 'polling' ? 'progress' : 'idle'}>
          {stream}
        </StatusPill>
      ) : null}
      {updated ? <span>{updated}</span> : null}
    </p>
  );
}

const BOOK_COLUMNS = (base: string, quote: string, side: 'asks' | 'bids'): Column[] => [
  { label: 'Price', sub: quote },
  { label: 'Quantity', sub: base, align: 'right' },
  { label: side === 'asks' ? 'You pay' : 'You get', sub: quote, align: 'right' },
  { label: 'Action', srOnly: true, align: 'right' },
];

function BookSide({ market, side }: { market: Market; side: 'asks' | 'bids' }) {
  const base = market.base.symbol;
  const quote = market.quote.symbol;
  const lines = bookLines(market, side);
  const takeHref = (offerId: string) =>
    `#trade?${new URLSearchParams({ pair: market.pair.id, offer: offerId }).toString()}`;
  const headId = `book-${side}-title`;
  return (
    <div>
      <div className="book-side-head">
        <h4 id={headId}>
          {side === 'asks' ? 'Asks' : 'Bids'}{' '}
          <span className="small muted">{side === 'asks' ? '— sellers; you buy' : '— buyers; you sell'}</span>
        </h4>
        <span className="small muted">
          {lines.length} {lines.length === 1 ? 'offer' : 'offers'}
        </span>
        {lines.length > 0 && <span className="depth">{depthText(market, side)}</span>}
      </div>
      <StatementTable
        variant="book"
        columns={BOOK_COLUMNS(base, quote, side)}
        aria-labelledby={headId}
        data-testid={side === 'asks' ? 'book-asks' : 'book-bids'}
      >
        {lines.length === 0 ? (
          <tr className="row-empty">
            <td colSpan={4}>
              <NoValue>{side === 'asks' ? 'no asks' : 'no bids'}</NoValue>
            </td>
          </tr>
        ) : (
          lines.map((l) => (
            <tr key={l.offerId} data-testid="book-line" data-offer={l.offerId}>
              <td className="num">
                <span className={side === 'asks' ? 'price-ask' : 'price-bid'} data-testid="line-price">
                  {l.price}
                </span>
              </td>
              <td className="num" data-testid="line-quantity">
                {l.quantity}
              </td>
              <td className="num" data-testid="line-total">
                {l.total}
              </td>
              <td className="act">
                <ButtonLink size="small" href={takeHref(l.offerId)} data-testid="take">
                  Take
                </ButtonLink>
              </td>
            </tr>
          ))
        )}
      </StatementTable>
    </div>
  );
}

function Book({ market, onClose }: { market: Market; onClose(): void }) {
  const base = market.base.symbol;
  const quote = market.quote.symbol;
  const spread = spreadText(market);
  return (
    <Panel
      className="section-gap"
      data-testid="book"
      data-pair={market.pair.id}
      title={`${base} / ${quote}`}
      meta={
        <>
          <span data-testid="book-summary">
            {[
              spread !== null ? `Spread ${spread}` : null,
              `last trade ${lastTradeText(market.lastTrade)}`,
              `prices in ${quote} per ${base}`,
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
          <Button variant="link" onClick={onClose}>
            Close
          </Button>
        </>
      }
    >
      {market.status === 'no-liquidity' && (
        <Notice className="panel-intro" data-testid="book-empty">
          No liquidity: nobody is offering to buy or sell {base} for {quote} right now.
        </Notice>
      )}
      <div className="book-grid">
        <BookSide market={market} side="asks" />
        <BookSide market={market} side="bids" />
      </div>
      <Notice className="section-gap">
        <strong>Offers are all or nothing:</strong> you pay and receive the whole amount shown.
      </Notice>
    </Panel>
  );
}

export function Markets() {
  const { state, registry, pairs, error } = useMarkets();
  const assets = useAssetFilter();
  const [selected, setSelected] = useState<string | null>(null);

  const head = (
    <PageHead
      eyebrow="Every pair, from the live book"
      title="Markets"
      lede="Each market is one token against another, priced in the second. Prices come only from live offers on the exchange: a pair without offers shows “no liquidity”; prices are never estimated."
      actions={<FeedStatus state={state} />}
    />
  );

  if (!registry) {
    return (
      <section data-testid="section-markets">
        {head}
        <Notice tone="danger" role="alert" data-testid="markets-config-error">
          Markets are not configured for this network: {error ?? 'no token list'}.
        </Notice>
      </section>
    );
  }

  // A market shows only when the asset filter shows both of its tokens (plan 00042).
  const rows = marketRows(state, pairs, assets.showsPair);
  const market =
    state.status === 'ready'
      ? (state.snapshot.markets.find((m) => m.pair.id === selected && assets.showsPair(m.base, m.quote)) ?? null)
      : null;
  const ignored = ignoredText(state);

  return (
    <section data-testid="section-markets">
      {head}
      {state.status === 'unavailable' && (
        <Notice tone="danger" role="alert" className="panel-intro" data-testid="exchange-unavailable">
          Exchange unavailable: {state.reason}. Prices are not shown until it answers again; your holdings are not
          affected.
        </Notice>
      )}
      {state.status === 'ready' && !state.complete && (
        <Notice tone="warning" className="panel-intro" data-testid="book-incomplete">
          The exchange has more offers than this page reads; the best prices may be missing some of them.
        </Notice>
      )}
      <Panel>
        <StatementTable
          data-testid="markets-table"
          caption="Markets"
          columns={[
            { label: 'Market' },
            { label: 'Best bid', sub: 'in the quote', align: 'right' },
            { label: 'Best ask', sub: 'in the quote', align: 'right' },
            { label: 'Last trade', sub: 'in the quote', align: 'right' },
            { label: 'Offers', sub: 'bids / asks', align: 'right' },
            { label: 'Status', align: 'right' },
          ]}
        >
          {rows.length === 0 && assets.filtering && (
            <tr className="row-empty" data-testid="markets-filtered-empty">
              <td colSpan={6}>
                <NoValue>
                  No market in this view: a market shows only when both of its tokens are listed.{' '}
                  {assetFilterText(assets)}
                </NoValue>
              </td>
            </tr>
          )}
          {rows.map((r) => {
            return (
              <tr
                key={r.pair}
                data-testid="market-row"
                data-pair={r.pair}
                aria-selected={selected === r.pair}
                className={selected === r.pair ? 'row-selected' : undefined}
              >
                <AssetCell
                  symbol={
                    <Button
                      variant="link"
                      className="sym"
                      data-testid="open-book"
                      aria-expanded={selected === r.pair}
                      disabled={state.status !== 'ready'}
                      onClick={() => setSelected(selected === r.pair ? null : r.pair)}
                    >
                      {r.base} / {r.quote}
                    </Button>
                  }
                  name={r.baseName}
                  origin={`priced in ${r.quote}`}
                />
                <Cell label="Best bid" align="right" num>
                  {isPrice(r.bestBid) ? (
                    <span className="price-bid" data-testid="best-bid">
                      {r.bestBid}
                    </span>
                  ) : (
                    <NoValue data-testid="best-bid">{r.bestBid}</NoValue>
                  )}
                </Cell>
                <Cell label="Best ask" align="right" num>
                  {isPrice(r.bestAsk) ? (
                    <span className="price-ask" data-testid="best-ask">
                      {r.bestAsk}
                    </span>
                  ) : (
                    <NoValue data-testid="best-ask">{r.bestAsk}</NoValue>
                  )}
                </Cell>
                <Cell label="Last trade" align="right" num data-testid="last-trade">
                  <span className="num-wrap">
                    {isPrice(r.lastTrade) ? r.lastTrade : <NoValue>{r.lastTrade}</NoValue>}
                    {r.lastTradeAt && <Sub>{r.lastTradeAt}</Sub>}
                  </span>
                </Cell>
                <Cell label="Offers" align="right" num data-testid="offer-counts">
                  {r.bids} / {r.asks}
                </Cell>
                <Cell label="Status" align="right" data-testid="market-status" data-status={r.status}>
                  <Badge tone={STATUS_TONE[r.status]}>{STATUS_TEXT[r.status]}</Badge>
                </Cell>
              </tr>
            );
          })}
        </StatementTable>
        <p className="table-note">Prices are in the second token of each pair, per whole first token.</p>
        {ignored && (
          <p className="table-note" data-testid="ignored-offers">
            {ignored}
          </p>
        )}
      </Panel>
      {market && <Book market={market} onClose={() => setSelected(null)} />}
    </section>
  );
}
