// The live markets: reads the exchange, derives every listed pair's market, and keeps it fresh
// on the kernel's offer stream, polling when the stream is down.
//
// One refresh is: the live offers of each pair's quote token (`/v1/offers?token=<quote>`, one
// keyset-paged read per DISTINCT quote token, merged by offer id: every offer a pair prices has a
// leg in its quote token), `/v1/pairs`, and `/v1/chart/stats` per pair, in parallel. The books
// decide whether the exchange is available; a failed pairs or stats request only makes the last
// trade "unknown". No token is special: the quote tokens are whatever the listed pairs name.
//
// Cadence: an offer event on the stream triggers a (debounced) refresh, with a slow safety
// refresh while the stream is live; without the stream the feed polls. A 429 cool-down
// stretches the next refresh. With the stagenet default pairs (two quote tokens, four pairs) a
// refresh is 7 requests at one page per book, far inside the kernel's 600 a minute.

import type { MarketPair } from '../tokens/pairs.js';
import type { TokenRegistry } from '../tokens/registry.js';
import { type AllOffers, KernelError, type KernelClient } from './kernel-client.js';
import { type MarketsSnapshot, type TradeData, deriveMarkets } from './prices.js';
import { BOOK_EVENTS, type ChartStats, type Pair } from './wire.js';

export type StreamState = 'off' | 'connecting' | 'live' | 'polling';

export type FeedState =
  | { status: 'loading'; stream: StreamState }
  | {
      status: 'ready';
      snapshot: MarketsSnapshot;
      /** False when the book had more pages than the feed reads (`maxPages`). */
      complete: boolean;
      /** Offer rows the market could not read. */
      skipped: number;
      /** False when the pair list or a pair's stats could not be read (last trade unknown). */
      tradeDataOk: boolean;
      updatedAt: number;
      stream: StreamState;
    }
  | {
      /** The book could not be read: "exchange unavailable". Prices are not shown stale. */
      status: 'unavailable';
      reason: string;
      since: number;
      lastUpdatedAt: number | null;
      stream: StreamState;
    };

export interface MarketFeedOptions {
  client: KernelClient;
  registry: TokenRegistry;
  /** The listed pairs (../tokens/pairs.ts), in display order. */
  pairs: readonly MarketPair[];
  /** Follow `/v1/offers/stream` (default true). */
  useStream?: boolean;
  /** Refresh interval while the stream is down, ms (default 15 s). */
  pollMs?: number;
  /** Refresh interval while the stream is live, ms (default 60 s). */
  safetyRefreshMs?: number;
  /** Quiet time after an offer event before refreshing, ms (default 750). */
  debounceMs?: number;
  /** First stream reconnect delay, ms (default 5 s); doubles up to `maxReconnectMs`. */
  reconnectMs?: number;
  maxReconnectMs?: number;
  /** Book pages read per refresh, 100 offers each (default 20). */
  maxPages?: number;
  now?: () => number;
}

/** A short, customer-facing reason for "exchange unavailable". */
export function describeKernelError(err: unknown): string {
  if (!(err instanceof KernelError)) return 'the exchange could not be read';
  switch (err.kind) {
    case 'timeout':
    case 'network':
      return 'the exchange did not answer';
    case 'rate-limited':
      return 'the exchange asked this browser to slow down';
    case 'invalid-response':
      return 'the exchange sent data the market cannot read';
    case 'http':
      return `the exchange answered ${err.details.status ?? 'with an error'}`;
    case 'aborted':
      return 'the request was cancelled';
  }
}

/** Several book reads as one: offers merged by id (an offer with legs in two quote tokens is read
 *  twice), complete only when every read was, skipped rows summed. */
function mergeBooks(books: readonly AllOffers[]): AllOffers {
  const seen = new Set<string>();
  const offers: AllOffers['offers'][number][] = [];
  for (const b of books)
    for (const o of b.offers) {
      const id = o.offerId.toLowerCase();
      if (seen.has(id)) continue;
      seen.add(id);
      offers.push(o);
    }
  return {
    offers,
    complete: books.every((b) => b.complete),
    pages: books.reduce((t, b) => t + b.pages, 0),
    skipped: books.reduce((t, b) => t + b.skipped, 0),
  };
}

export class MarketFeed {
  private readonly client: KernelClient;
  private readonly registry: TokenRegistry;
  private readonly pairs: readonly MarketPair[];
  private readonly useStream: boolean;
  private readonly pollMs: number;
  private readonly safetyRefreshMs: number;
  private readonly debounceMs: number;
  private readonly reconnectMs: number;
  private readonly maxReconnectMs: number;
  private readonly maxPages: number;
  private readonly now: () => number;

  private state: FeedState = { status: 'loading', stream: 'off' };
  private readonly listeners = new Set<() => void>();
  private running = false;
  private abort: AbortController | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<void> | null = null;
  private again = false;
  private stream: StreamState = 'off';
  private reconnectDelay: number;
  private streamOpenedBefore = false;
  /** Refreshes completed since start (for tests and diagnostics). */
  refreshes = 0;

  constructor(options: MarketFeedOptions) {
    this.client = options.client;
    this.registry = options.registry;
    this.pairs = options.pairs;
    this.useStream = options.useStream ?? true;
    this.pollMs = options.pollMs ?? 15_000;
    this.safetyRefreshMs = options.safetyRefreshMs ?? 60_000;
    this.debounceMs = options.debounceMs ?? 750;
    this.reconnectMs = options.reconnectMs ?? 5_000;
    this.maxReconnectMs = options.maxReconnectMs ?? 60_000;
    this.maxPages = options.maxPages ?? 20;
    this.now = options.now ?? Date.now;
    this.reconnectDelay = this.reconnectMs;
  }

  getState(): FeedState {
    return this.state;
  }

  /** Called after every state change. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.abort = new AbortController();
    this.streamOpenedBefore = false;
    this.reconnectDelay = this.reconnectMs;
    void this.refresh();
    if (this.useStream) this.connect();
    else this.setStream('polling');
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.abort?.abort();
    this.abort = null;
    clearTimeout(this.refreshTimer);
    clearTimeout(this.debounceTimer);
    clearTimeout(this.reconnectTimer);
    this.setStream('off');
  }

  /** Refresh now; a refresh requested while one runs is coalesced into one more after it. */
  refresh(): Promise<void> {
    if (!this.running) return Promise.resolve();
    if (this.inFlight) {
      this.again = true;
      return this.inFlight;
    }
    this.inFlight = (async () => {
      try {
        do {
          this.again = false;
          await this.readOnce();
        } while (this.again && this.running);
      } finally {
        this.inFlight = null;
        this.schedule();
      }
    })();
    return this.inFlight;
  }

  private emit(): void {
    for (const l of [...this.listeners]) l();
  }

  private setState(next: FeedState): void {
    this.state = next;
    this.emit();
  }

  private setStream(stream: StreamState): void {
    if (this.stream === stream) return;
    this.stream = stream;
    this.setState({ ...this.state, stream });
  }

  private async readOnce(): Promise<void> {
    const signal = this.abort?.signal;
    const pairs = this.pairs;
    const quotes = [...new Set(pairs.map((p) => p.quote.midnightColour))];
    const [pairRows, ...rest] = await Promise.allSettled([
      this.client.pairs(signal),
      ...quotes.map((q) => this.client.allOffers({ token: q, maxPages: this.maxPages }, signal)),
      ...pairs.map((p) => this.client.chartStats(p.base.midnightColour, p.quote.midnightColour, signal)),
    ]);
    const books = rest.slice(0, quotes.length) as Array<PromiseSettledResult<AllOffers>>;
    const stats = rest.slice(quotes.length);
    const failed = books.find((b) => b.status === 'rejected');
    const book: PromiseSettledResult<AllOffers> =
      failed ??
      ({
        status: 'fulfilled',
        value: mergeBooks(books.map((b) => (b as PromiseFulfilledResult<AllOffers>).value)),
      } as const);
    if (!this.running) return;
    this.refreshes++;
    const at = this.now();
    if (book.status === 'rejected') {
      const prev = this.state;
      this.setState({
        status: 'unavailable',
        reason: describeKernelError(book.reason),
        since: prev.status === 'unavailable' ? prev.since : at,
        lastUpdatedAt:
          prev.status === 'ready' ? prev.updatedAt : prev.status === 'unavailable' ? prev.lastUpdatedAt : null,
        stream: this.stream,
      });
      return;
    }
    const pairList: Pair[] | null = pairRows.status === 'fulfilled' ? (pairRows.value as Pair[]) : null;
    const statsBy = new Map<string, ChartStats | null>();
    pairs.forEach((p, i) => {
      const r = stats[i]!;
      statsBy.set(p.id, r.status === 'fulfilled' ? (r.value as ChartStats) : null);
    });
    const snapshot = deriveMarkets(book.value.offers, this.registry, pairs, (pair): TradeData => ({
      pairs: pairList,
      stats: statsBy.get(pair.id) ?? null,
    }));
    this.setState({
      status: 'ready',
      snapshot,
      complete: book.value.complete,
      skipped: book.value.skipped,
      tradeDataOk: pairList !== null && [...statsBy.values()].every((s) => s !== null),
      updatedAt: at,
      stream: this.stream,
    });
  }

  /** The next timed refresh: slow while the stream is live, the poll interval otherwise, and
   *  never before a 429 cool-down ends. */
  private schedule(): void {
    clearTimeout(this.refreshTimer);
    if (!this.running) return;
    const base = this.stream === 'live' ? this.safetyRefreshMs : this.pollMs;
    const delay = Math.max(base, this.client.cooldownRemaining());
    this.refreshTimer = setTimeout(() => void this.refresh(), delay);
  }

  private onBookEvent(): void {
    clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => void this.refresh(), this.debounceMs);
  }

  private connect(): void {
    if (!this.running || !this.abort) return;
    this.setStream('connecting');
    const signal = this.abort.signal;
    this.client
      .offerStream(
        {
          onOpen: () => {
            this.reconnectDelay = this.reconnectMs;
            this.setStream('live');
            if (this.streamOpenedBefore)
              void this.refresh(); // catch up on events missed while down
            else if (!this.inFlight) this.schedule(); // switch to the slow cadence
            this.streamOpenedBefore = true;
          },
          onEvent: (ev) => {
            if (BOOK_EVENTS.has(ev.type)) this.onBookEvent();
          },
        },
        signal,
      )
      .then(
        () => this.streamEnded(null),
        (err: unknown) => this.streamEnded(err),
      );
  }

  private streamEnded(err: unknown): void {
    if (!this.running) return;
    this.setStream('polling');
    if (!this.inFlight) this.schedule();
    const hinted = err instanceof KernelError ? (err.details.retryAfterMs ?? 0) : 0;
    const delay = Math.max(this.reconnectDelay, hinted);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectMs);
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }
}
