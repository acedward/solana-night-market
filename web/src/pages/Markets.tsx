// The Markets section (AA 00047 P8.1, spec FR-006/FR-006b): every listed pair (BASE/QUOTE, any two
// tokens, none special) as a card with its best prices from the live offers ("Buy at" = the best
// ask, "Sell at" = the best bid), and a per-pair order book. Each book line's Buy or Sell opens the
// Trade section on that offer, which shows the exact amounts and whether one coin can pay. The
// portfolio sits beside the cards on a wide screen, and one tap away on a phone. Every word on the
// page comes from ../market/view.ts.

import { useState } from 'react';

import type { FeedState, Market, NetworkProfile } from '@nightmarket/core';

import { PortfolioDock, PortfolioToggle } from '../account/PortfolioDock.js';
import { assetFilterText, useAssetFilter } from '../assets/AssetFilterContext.js';
import {
  Badge,
  Button,
  ButtonLink,
  EmptyState,
  Icon,
  NoValue,
  Notice,
  PageHead,
  PairIcon,
  Panel,
  Skeleton,
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
  type MarketRowView,
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

/** A price, or the words for its absence ("no buyers", "—"). */
const isPrice = (text: string) => /^-?[0-9]/.test(text);
const tradeHref = (pair: string, offer?: string) =>
  `#trade?${new URLSearchParams(offer ? { pair, offer } : { pair }).toString()}`;

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

/** One side's best price on a card: "Buy at" (the best ask) or "Sell at" (the best bid). */
function Quote({
  side,
  value,
  quote,
  base,
  loading,
}: {
  side: 'buy' | 'sell';
  value: string;
  quote: string;
  base: string;
  loading: boolean;
}) {
  const testId = side === 'buy' ? 'best-ask' : 'best-bid';
  return (
    <div className={`quote quote-${side}`}>
      <span className="quote-label">{side === 'buy' ? 'Buy at' : 'Sell at'}</span>
      {loading ? (
        <span className="quote-value">
          <Skeleton width="5.5em" />
          <span className="sr-only" data-testid={testId}>
            {value}
          </span>
        </span>
      ) : isPrice(value) ? (
        <span className="quote-value" data-testid={testId}>
          {value}
        </span>
      ) : (
        <NoValue className="quote-value" data-testid={testId}>
          {value}
        </NoValue>
      )}
      {isPrice(value) && (
        <span className="quote-unit">
          {quote} per {base}
        </span>
      )}
    </div>
  );
}

function MarketCard({
  r,
  selected,
  canOpen,
  onToggle,
}: {
  r: MarketRowView;
  selected: boolean;
  canOpen: boolean;
  onToggle(): void;
}) {
  const loading = r.status === 'loading';
  return (
    <article
      className="market-card"
      data-testid="market-row"
      data-pair={r.pair}
      data-selected={selected}
      aria-label={`${r.base} / ${r.quote}`}
    >
      <div className="market-card-head">
        <PairIcon base={r.base} quote={r.quote} />
        <div className="market-card-title">
          <h3>
            {r.base} / {r.quote}
          </h3>
          <span className="name">{r.baseName}</span>
        </div>
        <span data-testid="market-status" data-status={r.status}>
          <Badge tone={STATUS_TONE[r.status]}>{STATUS_TEXT[r.status]}</Badge>
        </span>
      </div>
      <div className="quotes">
        <Quote side="buy" value={r.bestAsk} quote={r.quote} base={r.base} loading={loading} />
        <Quote side="sell" value={r.bestBid} quote={r.quote} base={r.base} loading={loading} />
      </div>
      <dl className="market-facts">
        <div>
          <dt>Last trade</dt>
          <dd data-testid="last-trade">
            {isPrice(r.lastTrade) ? r.lastTrade : <NoValue>{r.lastTrade}</NoValue>}
            {r.lastTradeAt && <Sub>{r.lastTradeAt}</Sub>}
          </dd>
        </div>
        <div>
          <dt>Buyers / sellers</dt>
          <dd data-testid="offer-counts">
            {r.bids} / {r.asks}
          </dd>
        </div>
      </dl>
      {r.status === 'no-liquidity' && (
        <p className="market-card-empty" data-testid="market-no-offers">
          No offers yet. Be the first: <a href={tradeHref(r.pair)}>create an offer</a>.
        </p>
      )}
      <div className="market-card-actions">
        <Button
          variant="secondary"
          data-testid="open-book"
          aria-expanded={selected}
          disabled={!canOpen}
          onClick={onToggle}
        >
          <Icon name="book" />
          {selected ? 'Hide book' : 'Order book'}
        </Button>
        <ButtonLink variant="primary" href={tradeHref(r.pair)} data-testid="trade-market">
          Trade
        </ButtonLink>
      </div>
    </article>
  );
}

const BOOK_COLUMNS = (base: string, quote: string, side: 'asks' | 'bids'): Column[] => [
  { label: 'Price', sub: quote },
  { label: 'Amount', sub: base, align: 'right' },
  { label: side === 'asks' ? 'You pay' : 'You get', sub: quote, align: 'right' },
  { label: 'Action', srOnly: true, align: 'right' },
];

function BookSide({ market, side }: { market: Market; side: 'asks' | 'bids' }) {
  const base = market.base.symbol;
  const quote = market.quote.symbol;
  const lines = bookLines(market, side);
  const headId = `book-${side}-title`;
  return (
    <div>
      <div className="book-side-head">
        <h4 id={headId}>
          {side === 'asks' ? 'Sellers' : 'Buyers'}{' '}
          <span className="small muted">{side === 'asks' ? '— you buy from them' : '— you sell to them'}</span>
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
              <NoValue>{side === 'asks' ? 'nobody is selling' : 'nobody is buying'}</NoValue>
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
                <ButtonLink
                  size="small"
                  variant={side === 'asks' ? 'buy' : 'sell'}
                  href={tradeHref(market.pair.id, l.offerId)}
                  data-testid="take"
                >
                  {side === 'asks' ? 'Buy' : 'Sell'}
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
      title={`${base} / ${quote} order book`}
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
      <div className="btn-row panel-intro">
        <ButtonLink variant="primary" size="small" href={tradeHref(market.pair.id)} data-testid="book-make">
          <Icon name="plus" /> Create an offer on {base} / {quote}
        </ButtonLink>
      </div>
      {market.status === 'no-liquidity' && (
        <Notice className="panel-intro" data-testid="book-empty">
          No offers yet: nobody is buying or selling {base} for {quote} right now. Create the first one.
        </Notice>
      )}
      <div className="book-grid">
        <BookSide market={market} side="asks" />
        <BookSide market={market} side="bids" />
      </div>
      <p className="table-note">
        Offers are listed on the market, not on-chain. Taking one is all or nothing: you pay and get the whole amount
        shown, settled on Midnight in one transaction.
      </p>
    </Panel>
  );
}

export function Markets({ network, relayUrl }: { network: NetworkProfile; relayUrl: string }) {
  const { state, registry, pairs, error } = useMarkets();
  const assets = useAssetFilter();
  const [selected, setSelected] = useState<string | null>(null);
  const [drawer, setDrawer] = useState(false);

  const head = (
    <PageHead
      eyebrow="Create and trade on Midnight"
      title="Markets"
      lede="Pick a pair to buy or sell, straight from your Phantom wallet. Prices come only from live offers: nothing is estimated."
      actions={
        <>
          <FeedStatus state={state} />
          <PortfolioToggle open={drawer} onClick={() => setDrawer(true)} />
        </>
      }
    />
  );

  if (!registry) {
    return (
      <section data-testid="section-markets">
        {head}
        <Notice tone="danger" role="alert" data-testid="markets-config-error">
          Markets are not set up for this network: {error ?? 'no token list'}.
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
      <div className="market-layout">
        <div className="market-main">
          {state.status === 'unavailable' && (
            <Notice tone="danger" role="alert" className="panel-intro" data-testid="exchange-unavailable">
              Exchange unavailable: {state.reason}. Prices come back as soon as it answers; your tokens are not
              affected.
            </Notice>
          )}
          {state.status === 'ready' && !state.complete && (
            <Notice tone="warning" className="panel-intro" data-testid="book-incomplete">
              The exchange has more offers than this page reads, so the best prices may miss some of them.
            </Notice>
          )}
          <div className="market-cards" data-testid="markets-table" aria-label="Markets" role="region">
            {rows.length === 0 && assets.filtering && (
              <EmptyState
                className="markets-empty"
                icon="markets"
                title="No market in this view"
                data-testid="markets-filtered-empty"
              >
                A market shows only when both of its tokens are listed. {assetFilterText(assets)}
              </EmptyState>
            )}
            {rows.map((r) => (
              <MarketCard
                key={r.pair}
                r={r}
                selected={selected === r.pair}
                canOpen={state.status === 'ready'}
                onToggle={() => setSelected(selected === r.pair ? null : r.pair)}
              />
            ))}
          </div>
          <p className="table-note">Prices are in the second token of each pair, per whole first token.</p>
          {ignored && (
            <p className="table-note" data-testid="ignored-offers">
              {ignored}
            </p>
          )}
          {market && <Book market={market} onClose={() => setSelected(null)} />}
        </div>
        <PortfolioDock network={network} relayUrl={relayUrl} open={drawer} onClose={() => setDrawer(false)} />
      </div>
    </section>
  );
}
