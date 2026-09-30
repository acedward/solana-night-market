// The Trade section (plan L-TRD, generic since AA 00047): on any listed pair BASE/QUOTE, buy or sell
// the base at a price in the quote, either by making an offer ("Sell N at P" / "Buy N at P",
// pre-filled from the best ask or bid) or by taking one whole offer from the book. Every trade is
// ONE wallet signature (the Solana wallet's, lane B2); the exact legs are shown before it. The
// account's offers (My offers) are reconciled from the chain and the exchange.
//
// The seam limits are enforced and explained here (Q9, FR-019): one live offer at a time, each
// payment from one coin (an offer the account cannot pay keeps a greyed Buy or Sell that says why
// on hover, focus and tap: "Not enough twBTC. You hold 0.10 twBTC.", AA 00044), and a warning
// before a take cancels a live offer (L-TRD.3).
//
// Styled with the design system carried over from MN Bank (web/README.md "Adopting the design
// system"): the order form and the book side by side, statement tables for the book and My
// offers, the stage tracker for a trade in progress. The market's status (plan P4-A error states)
// pauses the actions it cannot carry out, with the reason, before anything is signed.

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';

import {
  type BookEntry,
  type JobView,
  KernelClient,
  type Market,
  type MarketPair,
  type NetworkProfile,
  type OrderLegs,
  type TokenEntry,
  type TradeSide,
  formatPrice,
  formatUnits,
  fundWithOneCoin,
  orderLegs,
  parsePrice,
  parseUnits,
  takeLegs,
} from '@nightmarket/core';

import {
  Button,
  ButtonRow,
  Cell,
  EmptyState,
  Field,
  Hash,
  NoValue,
  Notice,
  PageHead,
  Panel,
  Segmented,
  Select,
  StageTracker,
  StatementTable,
  StatusPill,
  Sub,
  Tooltip,
  UnitInput,
  YoursBadge,
  type Column,
  type PillStatus,
  type TrackerStage,
} from '../design/index.js';
import { assetFilterText, useAssetFilter } from '../assets/AssetFilterContext.js';
import { useMarkets } from '../market/MarketContext.js';
import { askText, bidText } from '../market/view.js';
import { syncAccount, type OperationEnv } from '../passport/operations.js';
import { findAccount, readCoins, readSecret } from '../passport/records.js';
import { RelayNotices, useRelayStatus } from '../relay/RelayStatus.js';
import { RelayClient } from '../relay/client.js';
import { useStore } from '../store/StoreContext.js';
import { guardFor, makeOffer, reconcileOffers, takeOffer } from '../trade/operations.js';
import { liveOffer, readTrades, type TradeRecord } from '../trade/records.js';
import { useWallet } from '../wallet/WalletContext.js';

const short = (s: string, head = 8, tail = 6) =>
  s.length <= head + tail + 1 ? s : `${s.slice(0, head)}…${s.slice(-tail)}`;
const amt = (raw: bigint, t: TokenEntry) => formatUnits(raw, t.decimals, { minFractionDigits: 2, grouping: true });
const clock = (ms: number) => `${new Date(ms).toISOString().slice(11, 16)} UTC`;
const placed = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');

const STAGE_TEXT: Record<string, string> = {
  queued: 'Waiting in line',
  running: 'Started',
  proving: 'Preparing the offer’s proof (about a minute)',
  proven: 'Offer proven',
  posted: 'Sent to the exchange',
  listed: 'Listed on the exchange',
  'offer-checked': 'The offer is still there and is exactly the one you chose',
  merged: 'Your side and the offer combined into one transaction',
  settled: 'Settled',
  succeeded: 'Done',
  failed: 'Failed',
};

const STATE_TEXT: Record<TradeRecord['status'], string> = {
  live: 'Live',
  filled: 'Filled',
  expired: 'Expired',
  cancelled: 'Cancelled',
  refused: 'Refused',
};

const STATE_PILL: Record<TradeRecord['status'], PillStatus> = {
  live: 'live',
  filled: 'filled',
  expired: 'idle',
  cancelled: 'cancelled',
  refused: 'failed',
};

const PREFILL_HINT: Record<TradeSide, string> = {
  sell: 'Use the best ask',
  buy: 'Use the best bid',
};

/** `#trade?pair=twBTC/twUSDC&offer=<id>`: the Markets page's Take buttons link here. */
function hashParams(): URLSearchParams {
  const q = window.location.hash.split('?')[1] ?? '';
  return new URLSearchParams(q);
}

/** A trade job in progress, as the market reports it (the stage tracker of the design system). */
function Tracker({ job }: { job: JobView }) {
  const shown = job.stages.filter((s) => s.stage !== 'queued' || job.stages.length === 1);
  const stages: TrackerStage[] = shown.map((s, i) => ({
    key: `${s.stage}-${i}`,
    title: STAGE_TEXT[s.stage] ?? s.stage,
    state: i < shown.length - 1 || job.state === 'succeeded' ? 'done' : job.state === 'failed' ? 'failed' : 'current',
    time: clock(s.at * 1000),
    detail:
      s.detail?.tx || s.detail?.offerId ? (
        <>
          {s.detail.tx && (
            <>
              tx <Hash value={s.detail.tx} head={8} tail={6} />
            </>
          )}
          {s.detail.offerId && (
            <>
              {' '}
              offer <Hash value={s.detail.offerId} head={8} tail={6} />
            </>
          )}
        </>
      ) : undefined,
    data: { testid: 'trade-stage', stage: s.stage },
  }));
  return (
    <Panel
      className="section-gap"
      title="Your trade"
      meta={
        <span className="small">
          {STAGE_TEXT[job.stage] ?? job.stage}
          {job.state === 'queued' && job.position !== undefined ? ` · position ${job.position} in the queue` : ''}
        </span>
      }
      data-testid="trade-tracker"
      data-state={job.state}
      data-stage={job.stage}
    >
      <StageTracker stages={stages} label="Your trade" />
    </Panel>
  );
}

/** The exact legs of an order or a take, as in the mockup: what leaves the account, what arrives. */
function LegsPreview({
  legs,
  base,
  quote,
  foot,
}: {
  legs: OrderLegs;
  base: TokenEntry;
  quote: TokenEntry;
  foot?: string;
}) {
  const giveT = legs.side === 'sell' ? base : quote;
  const wantT = legs.side === 'sell' ? quote : base;
  return (
    <div className="legs" data-testid="legs" aria-label="What this trade does">
      <div className="leg">
        <span className="k">You give</span>
        <span className="v num" data-testid="legs-give" data-raw={legs.give.amount.toString()}>
          {amt(legs.give.amount, giveT)} {giveT.symbol}
        </span>
      </div>
      <div className="leg">
        <span className="k">You receive</span>
        <span className="v num" data-testid="legs-want" data-raw={legs.want.amount.toString()}>
          {amt(legs.want.amount, wantT)} {wantT.symbol}
        </span>
      </div>
      <div className="foot" data-testid="legs-price">
        Price {formatPrice(legs.effectivePrice, { round: legs.side === 'sell' ? 'up' : 'down' }).text} {quote.symbol}{' '}
        per {base.symbol}
        {legs.rounded && (
          <span data-testid="legs-rounded"> (rounded to a whole unit of {quote.symbol}, in your favour)</span>
        )}
        {foot ? <>. {foot}</> : null}
      </div>
    </div>
  );
}

export function Trade({ network, relayUrl }: { network: NetworkProfile; relayUrl: string }) {
  const { state, registry, pairs: allPairs } = useMarkets();
  const { store, revision } = useStore();
  const wallet = useWallet();
  const relayStatus = useRelayStatus();
  const relay = useMemo(() => new RelayClient(relayUrl), [relayUrl]);
  const kernel = useMemo(() => new KernelClient({ baseUrl: network.zswap.kernelUrl }), [network]);
  const assets = useAssetFilter();
  const params = hashParams();
  // Only the pairs whose two tokens the asset filter shows (plan 00042).
  const pairs: MarketPair[] = allPairs.filter((p) => assets.showsPair(p.base, p.quote));
  const [pairId, setPairId] = useState<string>(params.get('pair') ?? pairs[0]?.id ?? '');
  const [picked, setPicked] = useState<string | null>(params.get('offer'));
  const [side, setSide] = useState<TradeSide>('sell');
  const [quantity, setQuantity] = useState('');
  const [price, setPrice] = useState('');
  const [job, setJob] = useState<JobView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [confirmTake, setConfirmTake] = useState<BookEntry | null>(null);

  const pair = pairs.find((p) => p.id === pairId) ?? pairs[0] ?? null;
  const base = pair?.base ?? null;
  const quote = pair?.quote ?? null;
  const market: Market | null =
    state.status === 'ready' && pair ? (state.snapshot.markets.find((m) => m.pair.id === pair.id) ?? null) : null;

  const owner = wallet.status === 'connected' ? wallet.deviceKey : null;
  const scope = useMemo(() => (owner ? { network: network.name, owner } : null), [owner, network.name]);
  const account = useMemo(
    () => (store && scope ? findAccount(store, scope) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store, scope, revision],
  );
  const hasSecret = !!(store && scope && account && readSecret(store, scope, account.address));
  const coins = useMemo(
    () => (store && scope && account ? readCoins(store, scope, account.address) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store, scope, account, revision],
  );
  const trades = useMemo(
    () => (store && scope && account ? readTrades(store, scope, account.address) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store, scope, account, revision],
  );
  // The clock the page reasons with (an offer's expiry), ticking so a live offer lapses on screen.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);
  const live = liveOffer(trades, now);
  // The history lists only the markets the filter shows; a live offer (the banner) always shows.
  const shownTrades = trades.filter((t) => assets.showsColour(t.base) && assets.showsColour(t.quote));

  const env = useCallback((): OperationEnv | null => {
    if (!store || !scope || !wallet.signing) return null;
    return { relay, store, scope, signing: wallet.signing, onJob: setJob };
  }, [store, scope, wallet.signing, relay]);

  // Reconcile My offers and the coins when the page opens, and every 30 s while an offer is live.
  const accountAddress = account?.address;
  const reconcile = useCallback(async () => {
    const e = env();
    if (!e || !accountAddress || !hasSecret) return;
    try {
      const changed = await reconcileOffers(e, accountAddress, kernel);
      if (changed.length === 0) await syncAccount(e, accountAddress);
      const filled = changed.find((c) => c.status === 'filled');
      if (filled) setMessage({ kind: 'ok', text: `Your offer (${filled.summary}) was filled.` });
    } catch {
      /* the next refresh tries again; the page keeps the last known state */
    }
  }, [env, accountAddress, hasSecret, kernel]);
  useEffect(() => {
    if (!accountAddress) return;
    const t = setTimeout(() => void reconcile(), 0);
    const every = live ? setInterval(() => void reconcile(), 30_000) : null;
    return () => {
      clearTimeout(t);
      if (every) clearInterval(every);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountAddress, owner, !!live]);

  const head = (
    <PageHead
      eyebrow="Make and take offers"
      title="Trade"
      lede={
        pair
          ? `Trade ${pair.base.symbol} for ${pair.quote.symbol}, at a price in ${pair.quote.symbol}, or pick another market. Take an existing offer now, or place your own at your price. You sign once per trade; the market pays the network fees.`
          : 'Every trade is one token against another, on a listed market. Take an existing offer now, or place your own at your price.'
      }
    />
  );

  if (registry && pairs.length === 0 && assets.filtering) {
    return (
      <section data-testid="section-trade">
        {head}
        <EmptyState data-testid="trade-filtered-empty" title="No market in this view">
          A market shows only when both of its tokens are listed. {assetFilterText(assets)}
        </EmptyState>
      </section>
    );
  }
  if (!registry || !pair || !base || !quote) {
    return (
      <section data-testid="section-trade">
        {head}
        <Notice tone="danger" role="alert">
          Trading is not configured for this network.
        </Notice>
      </section>
    );
  }
  if (wallet.status !== 'connected' || !scope) {
    return (
      <section data-testid="section-trade">
        {head}
        <EmptyState title="Connect your Solana wallet">
          <span data-testid="trade-connect">
            {wallet.supported
              ? 'Connect your Solana wallet to trade. It only signs messages: it needs no SOL.'
              : 'Trading with a Solana wallet is coming to this site. Until then, browse the order books on Markets.'}
          </span>
        </EmptyState>
      </section>
    );
  }
  if (!account || !hasSecret) {
    return (
      <section data-testid="section-trade">
        {head}
        <EmptyState title="No account in this browser">
          <span data-testid="trade-no-account">
            Open an account on <a href="#account">Account</a> (or import your export on <a href="#local">Local data</a>)
            to trade.
          </span>
        </EmptyState>
      </section>
    );
  }

  // Pre-fill the price from the book: a sell joins the best ask (else the best bid), a buy the best bid.
  const prefill = (s: TradeSide) => {
    if (!market) return;
    const bestAsk = market.asks.best?.price;
    const bestBid = market.bids.best?.price;
    const r = s === 'sell' ? (bestAsk ?? bestBid) : (bestBid ?? bestAsk);
    if (r) setPrice(s === 'sell' ? askText(r) : bidText(r));
  };

  // ── Make ──
  let legs: OrderLegs | null = null;
  let legsError: string | null = null;
  if (quantity.trim() !== '' && price.trim() !== '') {
    try {
      legs = orderLegs(side, base, quote, parseUnits(quantity, base.decimals), parsePrice(price, quote));
    } catch (e) {
      legsError = e instanceof Error ? e.message : 'Enter a quantity and a price.';
    }
  }
  const makeFunding = legs ? fundWithOneCoin(coins, legs.give, legs.side === 'sell' ? base : quote) : null;
  const makeGuard = guardFor({ store: store!, scope }, account.address, 'open-swap', now);

  // What the market's status says the page cannot do now (plan P4-A error states).
  const paused = relayStatus.spendingPaused;
  const batcherDown = relayStatus.health ? !relayStatus.health.batcher.reachable : false;
  const exchangeDown = state.status === 'unavailable';

  const run = async (label: string, fn: (e: OperationEnv) => Promise<void>) => {
    const e = env();
    if (!e) return;
    setBusy(label);
    setMessage(null);
    setJob(null);
    try {
      await fn(e);
    } catch (err) {
      setMessage({ kind: 'error', text: err instanceof Error ? err.message : 'Something went wrong.' });
    } finally {
      setBusy(null);
    }
  };

  const submitMake = (ev: FormEvent) => {
    ev.preventDefault();
    if (!legs || !makeFunding?.ok || makeGuard.kind === 'refuse' || paused) return;
    const l = legs;
    void run('make', async (e) => {
      const rec = await makeOffer(e, account.address, l, pair);
      setMessage({ kind: 'ok', text: `Your offer is on the exchange: ${rec.summary} (offer ${short(rec.offerId)}).` });
      setQuantity('');
    });
  };

  // ── Take ──
  const asks = market?.asks.entries ?? [];
  const bids = market?.bids.entries ?? [];
  const takeability = (e: BookEntry) => {
    const l = takeLegs(e, base, quote);
    return { legs: l, funding: fundWithOneCoin(coins, l.give, l.side === 'sell' ? base : quote) };
  };
  const cannotTake = !!busy || !!paused || batcherDown || exchangeDown;
  const startTake = (e: BookEntry) => {
    setMessage(null);
    setConfirmTake(e);
  };
  const doTake = (e: BookEntry) =>
    void run('take', async (env2) => {
      setConfirmTake(null);
      const rec = await takeOffer(env2, account.address, e, pair);
      setMessage({
        kind: 'ok',
        text: `Done: ${rec.summary}, settled in one transaction (tx ${short(rec.settledTx ?? '')}).`,
      });
      setPicked(null);
    });
  const takeGuard = guardFor({ store: store!, scope }, account.address, 'take', now);

  const pickedEntry = [...asks, ...bids].find((e) => e.offerId === picked) ?? null;
  const pickedGone = picked !== null && state.status === 'ready' && !pickedEntry;
  const bestAsk = market?.asks.best ?? null;
  const bestBid = market?.bids.best ?? null;

  const bookColumns = (kind: 'asks' | 'bids'): Column[] => [
    { label: 'Price', sub: quote.symbol },
    { label: 'Quantity', sub: base.symbol, align: 'right' },
    { label: kind === 'asks' ? 'You pay' : 'You get', sub: quote.symbol, align: 'right' },
    { label: 'Action', srOnly: true, align: 'right' },
  ];

  const bookSide = (entries: BookEntry[], kind: 'asks' | 'bids') => {
    const headId = `trade-book-${kind}-title`;
    return (
      <div>
        <div className="book-side-head">
          <h4 id={headId}>
            {kind === 'asks' ? 'Asks' : 'Bids'}{' '}
            <span className="small muted">{kind === 'asks' ? '— you buy' : '— you sell'}</span>
          </h4>
          <span className="small muted">
            {entries.length} {entries.length === 1 ? 'offer' : 'offers'}
          </span>
        </div>
        <StatementTable
          variant="book"
          groups
          columns={bookColumns(kind)}
          aria-labelledby={headId}
          data-testid={`trade-book-${kind}`}
        >
          {entries.length === 0 ? (
            <tbody>
              <tr className="row-empty">
                <td colSpan={4}>
                  <NoValue>no {kind}</NoValue>
                </td>
              </tr>
            </tbody>
          ) : (
            entries.map((e) => {
              const t = takeability(e);
              const own = trades.some((x) => x.role === 'make' && x.offerId === e.offerId);
              const action = kind === 'asks' ? 'Buy' : 'Sell';
              return (
                // One row group per offer.
                <tbody key={e.offerId} data-testid="trade-line" data-offer={e.offerId}>
                  <tr
                    aria-selected={picked === e.offerId}
                    className={picked === e.offerId ? 'row-selected' : undefined}
                  >
                    <td className="num">
                      <span className={kind === 'asks' ? 'price-ask' : 'price-bid'}>
                        {kind === 'asks' ? askText(e.price) : bidText(e.price)}
                      </span>
                    </td>
                    <td className="num">{amt(e.baseRaw, base)}</td>
                    <td className="num">{amt(e.quoteRaw, quote)}</td>
                    <td className="act">
                      {own ? (
                        <YoursBadge data-testid="own-offer" />
                      ) : t.funding.ok ? (
                        <Button
                          size="small"
                          variant={picked === e.offerId ? 'primary' : 'secondary'}
                          data-testid="take-line"
                          disabled={cannotTake}
                          onClick={() => startTake(e)}
                        >
                          {action}
                        </Button>
                      ) : (
                        // One coin cannot pay it (Q9): greyed out, and it says why (AA 00044).
                        <Tooltip id={`nt-${e.offerId}`} text={t.funding.reason} data-testid="not-enough">
                          <Button
                            size="small"
                            variant="secondary"
                            disabled
                            aria-describedby={`nt-${e.offerId}`}
                            data-testid="take-line-not-enough"
                          >
                            {action}
                          </Button>
                        </Tooltip>
                      )}
                    </td>
                  </tr>
                </tbody>
              );
            })
          )}
        </StatementTable>
      </div>
    );
  };

  const takeConfirm = (() => {
    if (!confirmTake) return null;
    const t = takeability(confirmTake);
    return (
      <Panel
        as="div"
        tone="quiet"
        headingLevel={4}
        className="section-gap"
        title={`${t.legs.side === 'buy' ? 'Buy' : 'Sell'} — the whole offer`}
        data-testid="take-confirm"
        data-offer={confirmTake.offerId}
      >
        <LegsPreview
          legs={t.legs}
          base={base}
          quote={quote}
          foot="All or nothing: you pay and receive exactly these amounts, from one coin"
        />
        {!t.funding.ok && (
          <Notice tone="danger" role="alert" className="panel-intro" data-testid="take-not-fundable">
            {t.funding.reason}
          </Notice>
        )}
        {takeGuard.kind === 'warn' && (
          <Notice tone="warning" role="alert" className="panel-intro" data-testid="take-cancels-offer">
            {takeGuard.message}
          </Notice>
        )}
        <ButtonRow stretch>
          <Button data-testid="take-sign" disabled={cannotTake || !t.funding.ok} onClick={() => doTake(confirmTake)}>
            {takeGuard.kind === 'warn' ? 'Cancel my offer and sign' : 'Sign and take'}
          </Button>
          <Button variant="secondary" onClick={() => setConfirmTake(null)}>
            Back
          </Button>
        </ButtonRow>
      </Panel>
    );
  })();

  return (
    <section data-testid="section-trade">
      {head}
      {message && (
        <Notice
          tone={message.kind === 'error' ? 'danger' : 'success'}
          role={message.kind === 'error' ? 'alert' : 'status'}
          className="panel-intro"
          data-testid="trade-message"
        >
          {message.text}
        </Notice>
      )}
      {exchangeDown && state.status === 'unavailable' && (
        <Notice tone="danger" role="alert" className="panel-intro" data-testid="trade-exchange-unavailable">
          Exchange unavailable: {state.reason}. You cannot trade until it answers again.
        </Notice>
      )}
      <RelayNotices place="trade" className="panel-intro" />
      {paused && (
        <Notice tone="warning" className="panel-intro" data-testid="trade-paused">
          Not now: {paused}
        </Notice>
      )}
      {live && (
        <Notice
          tone="warning"
          title="One live offer per account."
          className="panel-intro"
          data-testid="live-offer-banner"
        >
          You have a live offer: {live.summary}, until {clock(live.expiresAt)}. Any other signed action (a take or a
          withdrawal) cancels it; we ask you before it happens.
        </Notice>
      )}

      <div className="trade-grid">
        <Panel as="form" title="New offer" onSubmit={submitMake} data-testid="make-section" noValidate>
          <Field label="Side">
            <Segmented
              label="Side"
              options={[
                { value: 'buy', label: `Buy ${base.symbol}`, testId: 'side-buy' },
                { value: 'sell', label: `Sell ${base.symbol}`, testId: 'side-sell' },
              ]}
              value={side}
              onChange={(v) => {
                setSide(v);
                prefill(v);
              }}
            />
          </Field>
          <Field label="Market" htmlFor="tr-pair">
            <Select
              id="tr-pair"
              value={pair.id}
              onChange={(e) => {
                setPairId(e.target.value);
                setPicked(null);
              }}
              data-testid="trade-pair"
            >
              {pairs.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.base.symbol} / {p.quote.symbol} — {p.base.name}
                </option>
              ))}
            </Select>
          </Field>
          <div className="form-grid">
            <Field label="Quantity" htmlFor="tr-qty">
              <UnitInput
                id="tr-qty"
                unit={base.symbol}
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                inputMode="decimal"
                autoComplete="off"
                data-testid="make-quantity"
              />
            </Field>
            <Field
              label={`Price per ${base.symbol}`}
              htmlFor="tr-price"
              hint={
                <Button variant="link" onClick={() => prefill(side)} data-testid="make-prefill">
                  {PREFILL_HINT[side]}
                  {side === 'sell' && bestAsk ? ` (${askText(bestAsk.price)})` : ''}
                  {side === 'buy' && bestBid ? ` (${bidText(bestBid.price)})` : ''}
                </Button>
              }
            >
              <UnitInput
                id="tr-price"
                unit={quote.symbol}
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                inputMode="decimal"
                autoComplete="off"
                data-testid="make-price"
              />
            </Field>
          </div>
          {legsError && (
            <Notice tone="danger" role="alert" className="panel-intro" data-testid="make-error">
              {legsError}
            </Notice>
          )}
          {legs && (
            <LegsPreview
              legs={legs}
              base={base}
              quote={quote}
              {...(makeFunding?.ok
                ? { foot: 'Paid from one coin; any change stays in your account. Fees: none, the market pays them' }
                : {})}
            />
          )}
          {legs && makeFunding && !makeFunding.ok && (
            <Notice tone="danger" role="alert" className="panel-intro" data-testid="make-not-fundable">
              {makeFunding.reason}
            </Notice>
          )}
          {makeGuard.kind === 'refuse' && (
            <Notice tone="warning" role="alert" className="panel-intro" data-testid="make-refused">
              {makeGuard.message}
            </Notice>
          )}
          <ButtonRow stretch>
            <Button
              type="submit"
              data-testid="make-sign"
              disabled={!!busy || !!paused || !legs || !makeFunding?.ok || makeGuard.kind === 'refuse'}
            >
              {busy === 'make' ? 'Publishing…' : 'Sign and publish offer'}
            </Button>
          </ButtonRow>
          <p className="small muted section-gap">
            Your offer stays on the exchange until someone takes it (all of it) or it expires, about an hour after you
            sign. Signing anything else from this account before then cancels it.
          </p>
        </Panel>

        <Panel title="Take an offer" meta={`${base.symbol} / ${quote.symbol}`} data-testid="take-section">
          <p className="small muted panel-intro">
            Offers are all or nothing: you pay and receive exactly the amounts shown, from one coin.
          </p>
          <ButtonRow stretch>
            <Button
              data-testid="buy-best-ask"
              disabled={!bestAsk || cannotTake || !takeability(bestAsk).funding.ok}
              onClick={() => bestAsk && startTake(bestAsk)}
            >
              Buy at best ask{bestAsk ? ` (${askText(bestAsk.price)})` : ''}
            </Button>
            <Button
              variant="secondary"
              data-testid="sell-best-bid"
              disabled={!bestBid || cannotTake || !takeability(bestBid).funding.ok}
              onClick={() => bestBid && startTake(bestBid)}
            >
              Sell at best bid{bestBid ? ` (${bidText(bestBid.price)})` : ''}
            </Button>
          </ButtonRow>
          {market?.status === 'no-liquidity' && (
            <Notice className="section-gap" data-testid="trade-no-liquidity">
              No liquidity: nobody is offering to buy or sell {base.symbol} for {quote.symbol} right now. You can make
              an offer instead.
            </Notice>
          )}
          {pickedGone && (
            <Notice tone="warning" className="section-gap" data-testid="picked-gone">
              The offer you picked is no longer on the exchange.
            </Notice>
          )}
          {pickedEntry && !confirmTake && (
            <ButtonRow className="section-gap">
              <Button
                variant="secondary"
                data-testid="take-picked"
                disabled={!!busy}
                onClick={() => startTake(pickedEntry)}
              >
                Review the offer you picked
              </Button>
            </ButtonRow>
          )}
          {takeConfirm}
          <div className="book-stack section-gap">
            {bookSide(asks, 'asks')}
            {bookSide(bids, 'bids')}
          </div>
        </Panel>
      </div>

      {job && <Tracker job={job} />}

      <Panel
        className="section-gap"
        title="My offers and trades"
        meta={
          <Button
            variant="secondary"
            size="small"
            data-testid="reconcile"
            disabled={!!busy}
            onClick={() => void reconcile()}
          >
            Refresh
          </Button>
        }
        data-testid="my-offers"
      >
        <StatementTable
          caption="My offers and trades"
          columns={[
            { label: 'Placed' },
            { label: 'Trade' },
            { label: 'Kind' },
            { label: 'Status', align: 'right' },
            { label: 'Offer', align: 'right' },
            { label: 'Settled by', align: 'right' },
          ]}
        >
          {shownTrades.length === 0 ? (
            <tr className="row-empty">
              <td colSpan={6}>
                <NoValue>No trades yet.</NoValue>
              </td>
            </tr>
          ) : (
            shownTrades.map((t) => (
              <tr key={`${t.role}-${t.offerId}`} data-testid="my-trade" data-role={t.role} data-state={t.status}>
                <Cell block num>
                  {placed(t.createdAt)}
                </Cell>
                <Cell label="Trade">{t.summary}</Cell>
                <Cell label="Kind">{t.role === 'make' ? 'Your offer' : 'Taken'}</Cell>
                <Cell label="Status" align="right" data-testid="my-trade-state">
                  <span className="num-wrap">
                    <StatusPill status={STATE_PILL[t.status]}>{STATE_TEXT[t.status]}</StatusPill>
                    {t.role === 'make' && t.status === 'live' && <Sub>until {clock(t.expiresAt)}</Sub>}
                  </span>
                </Cell>
                <Cell label="Offer" align="right">
                  <Hash value={t.offerId} head={8} tail={6} />
                </Cell>
                <Cell label="Settled by" align="right" data-testid="my-trade-tx">
                  {t.settledTx ? <Hash value={t.settledTx} head={8} tail={6} /> : <NoValue>—</NoValue>}
                </Cell>
              </tr>
            ))
          )}
        </StatementTable>
      </Panel>
    </section>
  );
}
