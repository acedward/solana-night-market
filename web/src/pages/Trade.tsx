// The Trade section (plan L-TRD, generic since AA 00047; the consumer layout of P8.1, spec FR-006b;
// ONE view since AA 00060 FR-026/FR-027): on any listed pair BASE/QUOTE, the order book
// `Order book <base> ⇄ <quote>` is the whole page. Each half lists the whole offers you can take and
// ends with a create row for your own offer at your price (./trade/book-view.ts):
//   "Sellers — you buy <base>"   take an ask (Buy), or create "Sell <quote>" (a buy offer, listed
//                                under Buyers);
//   "Buyers — you sell <base>"   take a bid (Sell), or create "Sell <base>" (a sell offer, listed
//                                under Sellers).
// Every trade is ONE wallet signature (the Solana wallet's, lane B2); the exact amounts are shown
// before it, and the signing modal follows the market's part to the end. The account's offers (Your
// offers and trades) are reconciled from the chain and the exchange.
//
// On-chain or not (P8.2, the owner's Q18 finding; questions Q24): creating an offer puts NOTHING on
// the chain. The relay proves the offer and the exchange lists it; the tokens stay in the account
// until someone takes it, and the take is the one Midnight transaction that settles it. The page
// says so wherever the account's own offers show (./trade/messages.ts).
//
// The seam limits are enforced and explained here (Q9, FR-019): one live offer at a time, each
// payment from one coin (an offer the account cannot pay keeps a greyed Buy or Sell that says why
// on hover, focus and tap: "Not enough twBTC. You hold 0.10 twBTC.", AA 00044), and a warning
// before a take ends a live offer (L-TRD.3). Your own offer stays in the book, marked "Your offer",
// with a short note and NO action: your own account cannot take it (AA 00060 P14.0, questions Q9), and
// offers cannot be cancelled in Night Market (spec FR-028, owner 2026-10-05: they expire; a future Offer
// Files feature will cancel them for every client). The market's status (plan P4-A error states) pauses
// the actions it cannot carry out, with the reason, before anything is signed.

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';

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
  TAKE_LIFETIME_SECONDS,
  deadlineText,
  formatPrice,
  formatUnits,
  fundWithOneCoin,
  orderLegs,
  parsePrice,
  parseUnits,
  takeLegs,
} from '@nightmarket/core';
import type { AccountCheckProblem } from '@nightmarket/core/passport';

import { useActivity } from '../activity/ActivityContext.js';
import { OFFER_OFF_CHAIN, stageWords, type ActivityKind } from '../activity/activity.js';
import { PortfolioDock, PortfolioToggle } from '../account/PortfolioDock.js';
import { assetFilterText, useAssetFilter } from '../assets/AssetFilterContext.js';
import { AccountCheckNotice } from '../chain/AccountCheckNotice.js';
import { useAccountCheck, useChain } from '../chain/ChainContext.js';
import {
  Button,
  ButtonLink,
  ButtonRow,
  Cell,
  EmptyState,
  Field,
  Hash,
  Icon,
  NoValue,
  Notice,
  PageHead,
  PairIcon,
  Panel,
  Select,
  Skeleton,
  StageTracker,
  StatementTable,
  StatusPill,
  Sub,
  Toast,
  Tooltip,
  UnitInput,
  YoursBadge,
  type Column,
  type PillStatus,
  type TrackerStage,
} from '../design/index.js';
import { useMarkets } from '../market/MarketContext.js';
import { askText, bidText, lastTradeText, spreadText } from '../market/view.js';
import { syncAccount, type OperationEnv } from '../passport/operations.js';
import { findAccount, readCoins, readSecret } from '../passport/records.js';
import { RelayNotices, useRelayStatus } from '../relay/RelayStatus.js';
import { useClientProver } from '../prover/ProverContext.js';
import { RelayClient } from '../relay/client.js';
import { useStore } from '../store/StoreContext.js';
import {
  CREATE_ROW,
  OWN_OFFER_NOTE,
  bestPriceText,
  bookMeta,
  bookTitle,
  createRowHint,
  createRowLabel,
  givenToken,
  halfHeading,
  listedUnder,
  rowAction,
  type BookHalf,
} from '../trade/book-view.js';
import { OPEN_OFFERS_NOTE, madeOfferText, tookOfferText } from '../trade/messages.js';
import { guardFor, makeOffer, offerShown, reconcileOffers, takeOffer } from '../trade/operations.js';
import { liveOffer, readTrades } from '../trade/records.js';
import { useConnectPrompt } from '../wallet/connect-prompt.js';
import { useWallet, useWalletName } from '../wallet/WalletContext.js';

const amt = (raw: bigint, t: TokenEntry) => formatUnits(raw, t.decimals, { minFractionDigits: 2, grouping: true });
const clock = (ms: number) => `${new Date(ms).toISOString().slice(11, 16)} UTC`;
const placed = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');

/** The take's own stages, in more words than the modal's (the tracker has the room). */
const TAKE_STAGE_TEXT: Record<string, string> = {
  'offer-checked': 'The offer is still there, and exactly the one you chose',
  merged: 'Your side and the offer combined into one transaction',
};
const stageText = (stage: string, action: string) =>
  (action === 'take' ? TAKE_STAGE_TEXT[stage] : undefined) ?? stageWords(stage, action);

type ShownState = ReturnType<typeof offerShown>['state'];

const STATE_TEXT: Record<ShownState, string> = {
  // A live offer is listed on the market, not on-chain (questions Q24); one the exchange has not
  // listed (yet) says so, never "Listed" (AA 00047 P9.S, the P8.2 follow-up).
  live: 'Listed',
  unlisted: 'Not listed yet',
  // The exchange (or the relay) says it is taken; the chain does not show it yet (AA 00047 P10, R2-4).
  settling: 'Settling',
  filled: 'Filled',
  expired: 'Expired',
  cancelled: 'Cancelled',
  // The nonce moved but the page has not read the account's whole history yet (AA 00047 P11.B).
  ended: 'Ended',
  refused: 'Refused',
};

const STATE_PILL: Record<ShownState, PillStatus> = {
  live: 'live',
  unlisted: 'progress',
  settling: 'progress',
  filled: 'filled',
  expired: 'idle',
  cancelled: 'cancelled',
  ended: 'idle',
  refused: 'failed',
};

/** `#trade?pair=twBTC/twUSDC&offer=<id>`: the Markets page's Buy and Sell links come here. */
function hashParams(): URLSearchParams {
  const q = window.location.hash.split('?')[1] ?? '';
  return new URLSearchParams(q);
}

/** A trade job in progress, as the market reports it (the stage tracker of the design system). */
function Tracker({ job }: { job: JobView }) {
  const make = job.action === 'open-swap';
  const shown = job.stages.filter((s) => s.stage !== 'queued' || job.stages.length === 1);
  const stages: TrackerStage[] = shown.map((s, i) => ({
    key: `${s.stage}-${i}`,
    title: stageText(s.stage, job.action),
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
      title={make ? 'Your offer' : 'Your trade'}
      meta={
        <span className="small">
          {stageText(job.stage, job.action)}
          {job.state === 'queued' && job.position !== undefined ? ` · position ${job.position} in line` : ''}
        </span>
      }
      data-testid="trade-tracker"
      data-state={job.state}
      data-stage={job.stage}
    >
      <StageTracker stages={stages} label={make ? 'Your offer' : 'Your trade'} />
      {make && <p className="table-note">{OFFER_OFF_CHAIN}</p>}
    </Panel>
  );
}

/** The exact amounts of an order or a take: what leaves the account, what arrives. */
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
        <span className="k">You pay</span>
        <span className="v num" data-testid="legs-give" data-raw={legs.give.amount.toString()}>
          {amt(legs.give.amount, giveT)} {giveT.symbol}
        </span>
      </div>
      <div className="leg">
        <span className="k">You get</span>
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

/** The pair's best prices at a glance, beside the market picker. */
function PairStats({ market, quote }: { market: Market | null; quote: TokenEntry }) {
  const value = (v: string | null | undefined, cls?: string) =>
    market === null ? <Skeleton width="4.5em" /> : v ? <span className={cls}>{v}</span> : <NoValue>—</NoValue>;
  return (
    <>
      <span className="sr-only">Prices in {quote.symbol}</span>
      <dl className="pair-stats" data-testid="pair-stats">
        <div>
          <dt>Buy at</dt>
          <dd>{value(market?.asks.best ? askText(market.asks.best.price) : null, 'price-ask')}</dd>
        </div>
        <div>
          <dt>Sell at</dt>
          <dd>{value(market?.bids.best ? bidText(market.bids.best.price) : null, 'price-bid')}</dd>
        </div>
        <div>
          <dt>Spread</dt>
          <dd>{value(market ? spreadText(market) : null)}</dd>
        </div>
        <div>
          <dt>Last trade</dt>
          <dd>{value(market ? lastTradeText(market.lastTrade) : null)}</dd>
        </div>
      </dl>
    </>
  );
}

export function Trade({ network, relayUrl }: { network: NetworkProfile; relayUrl: string }) {
  const { state, registry, pairs: allPairs, refresh: refreshBook } = useMarkets();
  const { store, revision } = useStore();
  const wallet = useWallet();
  const walletName = useWalletName();
  const connect = useConnectPrompt();
  const activity = useActivity();
  const relayStatus = useRelayStatus();
  const relay = useMemo(() => new RelayClient(relayUrl), [relayUrl]);
  const chain = useChain();
  const kernel = useMemo(() => new KernelClient({ baseUrl: network.zswap.kernelUrl }), [network]);
  const assets = useAssetFilter();
  const params = hashParams();
  // Only the pairs whose two tokens the asset filter shows (plan 00042).
  const pairs: MarketPair[] = allPairs.filter((p) => assets.showsPair(p.base, p.quote));
  const [pairId, setPairId] = useState<string>(params.get('pair') ?? pairs[0]?.id ?? '');
  const [picked, setPicked] = useState<string | null>(params.get('offer'));
  // The create row that is open (FR-026): the offer it makes, or none.
  const [creating, setCreating] = useState<TradeSide | null>(null);
  const [quantity, setQuantity] = useState('');
  const [price, setPrice] = useState('');
  const [job, setJob] = useState<JobView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [confirmTake, setConfirmTake] = useState<BookEntry | null>(null);
  const [drawer, setDrawer] = useState(false);
  const confirmRef = useRef<HTMLDivElement>(null);
  const dismiss = useCallback(() => setMessage(null), []);

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
  const secret = store && scope && account ? readSecret(store, scope, account.address) : null;
  const hasSecret = !!secret;
  const coins = useMemo(
    () => (store && scope && account ? readCoins(store, scope, account.address) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store, scope, account, revision],
  );
  // The market-account check on the chain (AA 00047 P9.S, audit C3): no trade without it.
  const accountCheck = useAccountCheck(
    account && hasSecret ? account.address : null,
    owner,
    secret?.encPublicKey ?? null,
    revision,
    (account?.refusedAtOpen ?? null) as AccountCheckProblem[] | null,
    account?.txs?.waveOne ?? null,
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
  // An approval the chain has not decided yet (a live make, a take the market reports settled): the
  // page keeps reconciling while there is one (AA 00047 P10, R2-4).
  const unsettled = trades.some((t) => t.status === 'live');
  // The history lists only the markets the filter shows; a live offer (the banner) always shows.
  const shownTrades = trades.filter((t) => assets.showsColour(t.base) && assets.showsColour(t.quote));

  // AA 00062: the customer's own prover, for the k>=18 actions when the market requires it.
  const prover = useClientProver();
  const env = useCallback((): OperationEnv | null => {
    if (!store || !scope || !wallet.signing) return null;
    return {
      relay,
      chain,
      store,
      scope,
      signing: wallet.signing,
      onJob: (j) => {
        setJob(j);
        activity.job(j);
      },
      ...(prover ? { prover } : {}),
    };
  }, [store, scope, wallet.signing, relay, chain, activity, prover]);

  // Reconcile My offers and the coins when the page opens, and every 30 s while an offer is live.
  const accountAddress = account?.address;
  const reconcile = useCallback(async () => {
    const e = env();
    if (!e || !accountAddress || !hasSecret) return;
    try {
      const changed = await reconcileOffers(e, accountAddress, kernel);
      if (changed.length === 0) await syncAccount(e, accountAddress);
      // A make someone else settled (a take's own result is the take's toast).
      const filled = changed.find((c) => c.status === 'filled' && c.role === 'make');
      if (filled) setMessage({ kind: 'ok', text: `Your offer (${filled.summary}) was filled.` });
    } catch {
      /* the next refresh tries again; the page keeps the last known state */
    }
  }, [env, accountAddress, hasSecret, kernel]);
  useEffect(() => {
    if (!accountAddress) return;
    const t = setTimeout(() => void reconcile(), 0);
    const every = live || unsettled ? setInterval(() => void reconcile(), 30_000) : null;
    return () => {
      clearTimeout(t);
      if (every) clearInterval(every);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountAddress, owner, !!live || unsettled]);

  // Bring the review into view when an offer is picked (it opens under the half it belongs to).
  useEffect(() => {
    if (confirmTake) confirmRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }, [confirmTake]);

  const head = (
    <PageHead
      eyebrow="Make and take offers"
      title="Trade"
      lede={
        pair
          ? `Buy or sell ${pair.base.symbol} for ${pair.quote.symbol} in one order book: take an offer from it now, or add your own at your price. One approval in ${walletName.name} per trade; the market pays the network fees.`
          : 'Every trade is one token against another. Take an offer from the order book now, or add your own at your price.'
      }
      actions={<PortfolioToggle open={drawer} onClick={() => setDrawer(true)} />}
    />
  );

  if (registry && pairs.length === 0 && assets.filtering) {
    return (
      <section data-testid="section-trade">
        {head}
        <EmptyState data-testid="trade-filtered-empty" icon="markets" title="No market in this view">
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
          Trading is not set up for this network.
        </Notice>
      </section>
    );
  }
  // The market layout: trading first, the portfolio beside it (docked, or a drawer on narrow screens).
  const layout = (main: ReactNode) => (
    <section data-testid="section-trade">
      {head}
      <div className="market-layout">
        <div className="market-main">{main}</div>
        <PortfolioDock network={network} relayUrl={relayUrl} open={drawer} onClose={() => setDrawer(false)} />
      </div>
    </section>
  );

  if (wallet.status !== 'connected' || !scope) {
    return layout(
      <EmptyState
        icon="wallet"
        title="Connect your wallet to trade"
        action={
          connect ? (
            <Button data-testid="trade-connect-cta" onClick={connect}>
              <Icon name="wallet" /> Connect wallet
            </Button>
          ) : undefined
        }
      >
        <span data-testid="trade-connect">
          {wallet.supported
            ? 'Connect your Solana wallet to trade. It only signs messages: it needs no SOL.'
            : 'Trading with a Solana wallet is coming to this site. Until then, browse the order books on Markets.'}
        </span>
      </EmptyState>,
    );
  }
  if (!account || !hasSecret) {
    return layout(
      <EmptyState
        icon="portfolio"
        title="Open your free account to trade"
        action={
          <ButtonLink variant="primary" href="#account" data-testid="trade-open-account">
            Open your account
          </ButtonLink>
        }
      >
        <span data-testid="trade-no-account">
          Open an account on <a href="#account">Portfolio</a> (or import your backup on <a href="#local">Local Data</a>)
          to trade. It takes one approval in {walletName.name}, and the market pays every fee.
        </span>
      </EmptyState>,
    );
  }

  // "Use the best price": a sell joins the best ask (else the best bid), a buy the best bid.
  const prefill = (s: TradeSide) => {
    const r = bestPriceText(s, market);
    if (r) setPrice(r);
  };
  // Open (or close) a create row; one thing open at a time in the view (FR-026).
  const toggleCreate = (s: TradeSide) => {
    setConfirmTake(null);
    if (creating === s) {
      setCreating(null);
      return;
    }
    setCreating(s);
    prefill(s);
  };

  // ── Make (the open create row) ──
  let legs: OrderLegs | null = null;
  let legsError: string | null = null;
  if (creating && quantity.trim() !== '' && price.trim() !== '') {
    try {
      legs = orderLegs(creating, base, quote, parseUnits(quantity, base.decimals), parsePrice(price, quote));
    } catch (e) {
      legsError = e instanceof Error ? e.message : 'Enter an amount and a price.';
    }
  }
  const makeFunding = legs ? fundWithOneCoin(coins, legs.give, legs.side === 'sell' ? base : quote) : null;
  const makeGuard = guardFor({ store: store!, scope }, account.address, 'open-swap', now);

  // What the market's status says the page cannot do now (plan P4-A error states).
  const paused = relayStatus.spendingPaused;
  const batcherDown = relayStatus.health ? !relayStatus.health.batcher.reachable : false;
  const exchangeDown = state.status === 'unavailable';
  // The account failed the market-account check on the chain: nothing is signed for it (P9.S).
  const refusedAccount = accountCheck.status === 'failed';

  const run = async (label: string, kind: ActivityKind, fn: (e: OperationEnv) => Promise<void>) => {
    const e = env();
    if (!e) return;
    setBusy(label);
    setMessage(null);
    setJob(null);
    try {
      await activity.run(kind, () => fn(e));
    } catch (err) {
      setMessage({ kind: 'error', text: err instanceof Error ? err.message : 'Something went wrong.' });
    } finally {
      setBusy(null);
    }
  };

  const submitMake = (ev: FormEvent) => {
    ev.preventDefault();
    if (!legs || !makeFunding?.ok || makeGuard.kind === 'refuse' || paused || refusedAccount) return;
    const l = legs;
    void run('make', 'open-swap', async (e) => {
      const rec = await makeOffer(e, account.address, l, pair);
      setMessage({ kind: 'ok', text: madeOfferText(rec) });
      setQuantity('');
      setCreating(null);
      // The exchange lists it now: read the book again, so the offer shows in its half at once.
      refreshBook();
    });
  };

  // ── Take ──
  const asks = market?.asks.entries ?? [];
  const bids = market?.bids.entries ?? [];
  const takeability = (e: BookEntry) => {
    const l = takeLegs(e, base, quote);
    return { legs: l, funding: fundWithOneCoin(coins, l.give, l.side === 'sell' ? base : quote) };
  };
  const cannotTake = !!busy || !!paused || batcherDown || exchangeDown || refusedAccount;
  const startTake = (e: BookEntry) => {
    setMessage(null);
    setCreating(null);
    setConfirmTake(e);
  };
  const doTake = (e: BookEntry) =>
    void run('take', 'take', async (env2) => {
      setConfirmTake(null);
      const rec = await takeOffer(env2, account.address, e, pair);
      setMessage({ kind: 'ok', text: tookOfferText(rec) });
      setPicked(null);
      refreshBook();
    });
  const takeGuard = guardFor({ store: store!, scope }, account.address, 'take', now);

  const pickedEntry = [...asks, ...bids].find((e) => e.offerId === picked) ?? null;
  const pickedGone = picked !== null && state.status === 'ready' && !pickedEntry;

  const bookColumns = (kind: BookHalf): Column[] => [
    { label: 'Price', sub: quote.symbol },
    { label: 'Amount', sub: base.symbol, align: 'right' },
    { label: kind === 'asks' ? 'You pay' : 'You get', sub: quote.symbol, align: 'right' },
    { label: 'Action', srOnly: true, align: 'right' },
  ];

  // The review of a take, under the half its offer is in.
  const takeConfirm = (entry: BookEntry) => {
    const t = takeability(entry);
    const verb = t.legs.side === 'buy' ? 'Buy' : 'Sell';
    return (
      <div ref={confirmRef} className="book-review" data-testid="take-confirm" data-offer={entry.offerId}>
        <p className="panel-intro small">
          <strong>
            {verb} {amt(entry.baseRaw, base)} {base.symbol}
          </strong>{' '}
          — the whole offer, in one step.
        </p>
        <LegsPreview
          legs={t.legs}
          base={base}
          quote={quote}
          foot="All or nothing: you pay and get exactly these amounts, from one coin"
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
          <Button
            variant={t.legs.side === 'buy' ? 'buy' : 'sell'}
            className="btn-block"
            data-testid="take-sign"
            disabled={cannotTake || !t.funding.ok}
            onClick={() => doTake(entry)}
          >
            {takeGuard.kind === 'warn' ? `Cancel my offer and ${verb.toLowerCase()}` : `${verb} now`}
          </Button>
          <Button variant="secondary" className="btn-block" onClick={() => setConfirmTake(null)}>
            Back
          </Button>
        </ButtonRow>
        <p className="xsmall muted gap-top" data-testid="take-validity">
          You approve once in {walletName.name}; the market pays the network fees. Your approval is valid for{' '}
          {Math.round(TAKE_LIFETIME_SECONDS / 60)} minutes: if the market has not settled it by then, nobody can.
        </p>
      </div>
    );
  };

  // The open create row's form (FR-026): the existing make, its validations and "Use the best price".
  const createForm = (s: TradeSide) => {
    const giveT = givenToken(s, pair);
    const best = bestPriceText(s, market);
    const formId = `tr-create-${s}`;
    return (
      <form
        id={formId}
        className="create-form"
        onSubmit={submitMake}
        data-testid="make-section"
        data-side={s}
        aria-label={`${createRowLabel(s, pair)}: create your own offer`}
        noValidate
      >
        <p className="panel-intro small muted" data-testid="make-listed-under">
          It is listed under {listedUnder(s) === 'asks' ? 'Sellers' : 'Buyers'} once the exchange has it.
        </p>
        <div className="form-grid">
          <Field
            label={s === 'sell' ? `Amount of ${base.symbol} to sell` : `Amount of ${base.symbol} to buy`}
            htmlFor="tr-qty"
          >
            <UnitInput
              id="tr-qty"
              unit={base.symbol}
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              inputMode="decimal"
              autoComplete="off"
              placeholder="0.00"
              data-testid="make-quantity"
            />
          </Field>
          <Field
            label={`Price per ${base.symbol}`}
            htmlFor="tr-price"
            hint={
              <Button variant="link" onClick={() => prefill(s)} data-testid="make-prefill">
                Use the best price{best ? ` (${best})` : ''}
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
              placeholder="0.00"
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
            variant={s === 'buy' ? 'buy' : 'sell'}
            className="btn-block"
            data-testid="make-sign"
            disabled={!!busy || !!paused || refusedAccount || !legs || !makeFunding?.ok || makeGuard.kind === 'refuse'}
          >
            {busy === 'make' ? 'Preparing your offer…' : `Create offer: sell ${giveT.symbol}`}
          </Button>
          <Button variant="secondary" className="btn-block" onClick={() => setCreating(null)} data-testid="make-close">
            Close
          </Button>
        </ButtonRow>
        <p className="xsmall muted gap-top" data-testid="make-off-chain">
          One approval in {walletName.name} lists your offer on the market; it puts nothing on-chain. Your tokens stay
          in your account until someone takes the whole offer (then it settles on Midnight in one transaction), until it
          expires one hour after you approve: the expiry is part of what you approve, so nobody can take it later.
          Offers cannot be cancelled: approving anything else from this account ends it too.
        </p>
      </form>
    );
  };

  // One half of the book: its offers (take, or your own: the badge and a note), then its create row (FR-026).
  const bookHalf = (entries: BookEntry[], kind: BookHalf) => {
    const headId = `trade-book-${kind}-title`;
    const h = halfHeading(kind, pair);
    const makes = CREATE_ROW[kind];
    const formId = `tr-create-${makes}`;
    const open = creating === makes;
    const review = confirmTake && (confirmTake.side === 'ask') === (kind === 'asks') ? takeConfirm(confirmTake) : null;
    return (
      <div className="book-half" data-testid={`trade-half-${kind}`}>
        <div className="book-side-head">
          <h4 id={headId}>
            {h.who} <span className="small muted">{h.you}</span>
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
                  <NoValue>{kind === 'asks' ? 'nobody is selling' : 'nobody is buying'}</NoValue>
                </td>
              </tr>
            </tbody>
          ) : (
            entries.map((e) => {
              const t = takeability(e);
              const what = rowAction(e, trades, live);
              const action = kind === 'asks' ? 'Buy' : 'Sell';
              const selected = picked === e.offerId || confirmTake?.offerId === e.offerId;
              return (
                // One row group per offer.
                <tbody
                  key={e.offerId}
                  data-testid="trade-line"
                  data-offer={e.offerId}
                  data-own={what !== 'take' ? 'yes' : 'no'}
                >
                  <tr aria-selected={selected} className={selected ? 'row-selected' : undefined}>
                    <td className="num">
                      <span className={kind === 'asks' ? 'price-ask' : 'price-bid'}>
                        {kind === 'asks' ? askText(e.price) : bidText(e.price)}
                      </span>
                    </td>
                    <td className="num">{amt(e.baseRaw, base)}</td>
                    <td className="num">{amt(e.quoteRaw, quote)}</td>
                    <td className="act">
                      {what === 'own' ? (
                        // FR-027 as amended (questions Q9): your own offer stays in the book; your own
                        // account cannot take it (P14.0), and offers cannot be cancelled (FR-028): no action.
                        <span className="own-act">
                          <YoursBadge data-testid="own-offer" />
                          <span className="xsmall muted" data-testid="own-offer-note">
                            {OWN_OFFER_NOTE}
                          </span>
                        </span>
                      ) : t.funding.ok ? (
                        <Button
                          size="small"
                          variant={kind === 'asks' ? 'buy' : 'sell'}
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
          <tbody className="create-row" data-testid="create-row" data-half={kind} data-side={makes}>
            <tr>
              <td colSpan={4}>
                <Button
                  variant="link"
                  className="create-row-open"
                  aria-expanded={open}
                  aria-controls={open ? formId : undefined}
                  data-testid={`side-${makes}`}
                  data-half={kind}
                  onClick={() => toggleCreate(makes)}
                >
                  <Icon name={open ? 'chevron' : 'plus'} /> {createRowLabel(makes, pair)}
                </Button>{' '}
                <span className="small muted create-row-hint">{createRowHint(makes, pair)}</span>
              </td>
            </tr>
          </tbody>
        </StatementTable>
        {review}
        {open && createForm(makes)}
      </div>
    );
  };

  return layout(
    <>
      {message && (
        <Toast
          tone={message.kind === 'error' ? 'error' : 'success'}
          onClose={dismiss}
          timerKey={message.text}
          data-testid="trade-message"
        >
          {message.text}
        </Toast>
      )}
      {exchangeDown && state.status === 'unavailable' && (
        <Notice tone="danger" role="alert" className="panel-intro" data-testid="trade-exchange-unavailable">
          Exchange unavailable: {state.reason}. You can trade again as soon as it answers.
        </Notice>
      )}
      <RelayNotices place="trade" className="panel-intro" />
      {accountCheck.status !== 'ok' && (
        <AccountCheckNotice
          check={accountCheck}
          restore={
            <a href="#account" data-testid="trade-restore-key">
              Restore it on Portfolio.
            </a>
          }
        />
      )}
      {paused && (
        <Notice tone="warning" className="panel-intro" data-testid="trade-paused">
          Not now: {paused}
        </Notice>
      )}
      {live && (
        <Notice
          tone="warning"
          title="One live offer at a time."
          className="panel-intro"
          data-testid="live-offer-banner"
          data-listed={offerShown(live).listed ? 'yes' : 'no'}
        >
          {offerShown(live).listed
            ? `Your offer is listed on the market: ${live.summary}, until ${live.validUntil ? deadlineText(live.validUntil) : clock(live.expiresAt)} (the expiry you approved).`
            : `Your offer is not listed on the market (yet): ${live.summary}. It can still be taken until ${live.validUntil ? deadlineText(live.validUntil) : clock(live.expiresAt)}, the expiry you approved.`}{' '}
          It is not on-chain: your tokens stay in your account until someone takes it. Offers cannot be cancelled in
          Night Market: it ends at that expiry, or sooner if this account approves anything else (a take, a withdrawal,
          a Bridge out, saving a change or restoring your key); we ask you first. A future Offer Files feature will let
          every client cancel offers.
        </Notice>
      )}

      <div className="pair-bar">
        <div className="pair-picker">
          <PairIcon base={base.symbol} quote={quote.symbol} />
          <label className="sr-only" htmlFor="tr-pair">
            Market
          </label>
          <Select
            id="tr-pair"
            value={pair.id}
            onChange={(e) => {
              setPairId(e.target.value);
              setPicked(null);
              setConfirmTake(null);
              setCreating(null);
            }}
            data-testid="trade-pair"
          >
            {pairs.map((p) => (
              <option key={p.id} value={p.id}>
                {p.base.symbol} / {p.quote.symbol}
              </option>
            ))}
          </Select>
          <span className="pair-name small muted">{base.name}</span>
        </div>
        <PairStats market={state.status === 'ready' ? market : null} quote={quote} />
      </div>

      <Panel
        title={
          // `Order book <base> ⇄ <quote>` (bookTitle), with the arrow drawn; its accessible name is the text.
          <>
            Order book {base.symbol}{' '}
            <span className="pair-arrow">
              <Icon name="trade" />
              <span className="sr-only">⇄</span>
            </span>{' '}
            {quote.symbol}
          </>
        }
        meta={bookMeta(pair)}
        data-testid="trade-book"
        data-title={bookTitle(pair)}
      >
        {market?.status === 'no-liquidity' && (
          <Notice className="panel-intro" data-testid="trade-no-liquidity">
            No offers yet: nobody is buying or selling {base.symbol} for {quote.symbol} right now. Create the first
            offer with a row below.
          </Notice>
        )}
        {pickedGone && (
          <Notice tone="warning" className="panel-intro" data-testid="picked-gone">
            The offer you picked is no longer on the exchange.
          </Notice>
        )}
        {pickedEntry && !confirmTake && rowAction(pickedEntry, trades, live) === 'take' && (
          <Notice className="panel-intro" data-testid="picked-offer">
            You picked an offer on Markets; it is highlighted below.{' '}
            <Button variant="link" data-testid="take-picked" disabled={!!busy} onClick={() => startTake(pickedEntry)}>
              Review the offer you picked
            </Button>
          </Notice>
        )}
        <div className="book-halves">
          {bookHalf(asks, 'asks')}
          {bookHalf(bids, 'bids')}
        </div>
        {market && spreadText(market) !== null && (
          <p className="spread-line">
            <span>Spread</span>
            <strong>
              {spreadText(market)} {quote.symbol}
            </strong>
          </p>
        )}
        <p className="table-note">
          Offers are listed on the market, not on-chain. Taking one is all or nothing: you pay and get exactly the
          amounts shown, from one coin, settled on Midnight in one transaction.
        </p>
      </Panel>

      {job && <Tracker job={job} />}

      <Panel
        className="section-gap"
        title="Your offers and trades"
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
        <p className="panel-intro small muted" data-testid="my-offers-off-chain">
          {OPEN_OFFERS_NOTE}
        </p>
        <StatementTable
          caption="Your offers and trades"
          columns={[
            { label: 'Placed', sub: 'UTC' },
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
                <NoValue>No trades yet. Your offers and takes show here.</NoValue>
              </td>
            </tr>
          ) : (
            shownTrades.map((t) => (
              <tr
                key={`${t.role}-${t.offerId}`}
                data-testid="my-trade"
                data-role={t.role}
                data-state={t.status}
                data-shown={offerShown(t).state}
              >
                <Cell block num>
                  {placed(t.createdAt)}
                </Cell>
                <Cell label="Trade">{t.summary}</Cell>
                <Cell label="Kind">{t.role === 'make' ? 'Your offer' : 'You took'}</Cell>
                <Cell label="Status" align="right" data-testid="my-trade-state">
                  <span className="num-wrap">
                    <StatusPill status={STATE_PILL[offerShown(t).state]}>{STATE_TEXT[offerShown(t).state]}</StatusPill>
                    {t.role === 'make' && t.status === 'live' && (
                      // The signed expiry: its time here (the table stays narrow), the full date and
                      // time on hover and in the banner (audit C6).
                      <Sub
                        data-testid="my-trade-expiry"
                        title={`Expires ${t.validUntil ? deadlineText(t.validUntil) : clock(t.expiresAt)}`}
                      >
                        until {clock(t.expiresAt)}
                      </Sub>
                    )}
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
    </>,
  );
}
