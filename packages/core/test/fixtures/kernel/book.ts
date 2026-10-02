// A known offer book for the markets tests, in the exact wire shapes of the offer-files kernel
// (`ledger-v9` @ 5d46e8d: `GET /v1/offers` rows, `/v1/pairs` rows, `/v1/chart/stats`), with the
// stagenet registry's real colours (the mint-test-tokens faucets, which the staging kernel lists in
// ./staging-2026-09-27/known-tokens.json) and the stagenet default pairs (twBTC/twUSDC,
// twETH/twUSDC, twUSDM/twUSDC, twETH/twBTC). Amounts and block heights are strings, `last_price` a
// Postgres numeric string, stats JSON numbers, as the kernel's source serves them.
//
// The expected prices are written out by hand beside each scenario (never computed by the code
// under test). No token is special: every pair is exercised the same way.

export const COLOUR = {
  twBTC: 'ad2ba014014e6ec705357be9db5d3ad6f535d4bef6576f84a461f23b313a2e8e', // 8 decimals
  twETH: '2862f0f347068b6c4909079ab8e991067b71fe2263ef00c20f017eefb6e9477a', // 18 decimals
  twUSDC: 'e934b965a454ed6857080e9956ea83fb5542e0a860e96ce91daf35f5d7b02c9f', // 6 decimals
  twUSDM: '723e4cac789f6a9a39cc8eb104037ee0299e9fa7a3fcf58604cfbbc259748a87', // 6 decimals
  // Unshielded registry tokens: held and shown, never traded.
  utwUSDC: 'a9e63fe9160bbe0e5758b310db16644d7d147eed8757f13c05197c057538926d',
  // A colour the market does not list (MN Bank's bridged wStkA), and NIGHT.
  UNLISTED: '5eb2a3cebb2ebe7ba910c78f62c9e28e0d74acbd00c810730def3578860e6a02',
  NIGHT: '0000000000000000000000000000000000000000000000000000000000000000',
} as const;

/** The default pairs' ids, in the list's order. */
export const PAIR_IDS = ['twBTC/twUSDC', 'twETH/twUSDC', 'twUSDM/twUSDC', 'twETH/twBTC'] as const;
export type PairId = (typeof PAIR_IDS)[number];

export type WireLeg = { token: string; amount: string; type: 'SHIELDED' | 'UNSHIELDED' };
export type WireOffer = {
  version: 1;
  offerId: string;
  blobChars: number;
  blockHeight: string;
  computed: {
    gives: WireLeg[];
    wants: WireLeg[];
    expiresAt: string;
    inputNullifiers: string[];
    firstSeenAt: string;
    status: 'live';
  };
};

const hex64 = (n: number, tag: string) =>
  (tag + n.toString(16))
    .padStart(64, '0')
    .slice(-64)
    .replace(/[^0-9a-f]/g, '0');

export const leg = (token: string, amount: bigint | number, type: WireLeg['type'] = 'SHIELDED'): WireLeg => ({
  token,
  amount: String(amount),
  type,
});

/** One live row as `GET /v1/offers` serves it. `n` makes the id, height and nullifier unique. */
export function offerRow(n: number, gives: WireLeg[], wants: WireLeg[]): WireOffer {
  return {
    version: 1,
    offerId: hex64(n, 'a0'),
    blobChars: 24_000 + n,
    blockHeight: String(900_000 + n),
    computed: {
      gives,
      wants,
      expiresAt: '2026-10-11T12:00:00.000Z',
      inputNullifiers: [hex64(n, 'bb')],
      firstSeenAt: `2026-09-27T12:${String(n % 60).padStart(2, '0')}:00.000Z`,
      status: 'live',
    },
  };
}

/** The scenario book. Highest `n` first, as the kernel orders newest first. */
export const BOOK: WireOffer[] = [
  // twUSDM/twUSDC, both sides (6 and 6 decimals): ask 1.05, bid 0.95.
  offerRow(1, [leg(COLOUR.twUSDM, 10_000_000)], [leg(COLOUR.twUSDC, 10_500_000)]), // ask 10 @ 1.05
  offerRow(2, [leg(COLOUR.twUSDC, 9_500_000)], [leg(COLOUR.twUSDM, 10_000_000)]), // bid 10 @ 0.95
  offerRow(3, [leg(COLOUR.twUSDM, 20_000_000)], [leg(COLOUR.twUSDC, 22_000_000)]), // ask 20 @ 1.10
  offerRow(4, [leg(COLOUR.twUSDC, 4_500_000)], [leg(COLOUR.twUSDM, 5_000_000)]), // bid 5 @ 0.90
  // twBTC/twUSDC, asks only (8 and 6 decimals).
  offerRow(5, [leg(COLOUR.twBTC, 50_000_000)], [leg(COLOUR.twUSDC, 30_000_000_000)]), // ask 0.5 @ 60,000
  offerRow(6, [leg(COLOUR.twBTC, 25_000_000)], [leg(COLOUR.twUSDC, 16_250_000_000)]), // ask 0.25 @ 65,000
  // twETH/twBTC, a bid only (18 and 8 decimals): 0.04 twBTC for 1 twETH.
  offerRow(7, [leg(COLOUR.twBTC, 4_000_000)], [leg(COLOUR.twETH, 10n ** 18n)]), // bid 1 @ 0.04
  // Ignored: every one of these involves twETH against twUSDC or no listed pair, so twETH/twUSDC
  // has no liquidity.
  offerRow(8, [leg(COLOUR.twUSDM, 5_000_000)], [leg(COLOUR.twBTC, 5_000)]), // not-a-pair (twUSDM/twBTC)
  offerRow(9, [leg(COLOUR.twETH, 10n ** 18n), leg(COLOUR.twBTC, 1)], [leg(COLOUR.twUSDC, 2_000_000)]), // basket
  offerRow(10, [leg(COLOUR.twETH, 10n ** 18n)], [leg(COLOUR.twUSDC, 1_000_000, 'UNSHIELDED')]), // unshielded leg
  offerRow(11, [leg(COLOUR.twETH, 10n ** 18n)], [leg(COLOUR.UNLISTED, 1_000_000)]), // unknown colour
  offerRow(12, [leg(COLOUR.NIGHT, 1_000_000, 'UNSHIELDED')], [leg(COLOUR.twUSDC, 1_000_000)]), // NIGHT, unshielded
].reverse();

/** What a person computes by hand from BOOK: whole quote tokens per whole base token. */
export const EXPECTED: Record<
  PairId,
  { bestBid: string | null; bestAsk: string | null; bids: number; asks: number; last: string | null }
> = {
  'twBTC/twUSDC': { bestBid: null, bestAsk: '60,000.00', bids: 0, asks: 2, last: null },
  'twETH/twUSDC': { bestBid: null, bestAsk: null, bids: 0, asks: 0, last: '2,500.00' }, // no liquidity, one old fill
  'twUSDM/twUSDC': { bestBid: '0.95', bestAsk: '1.05', bids: 2, asks: 2, last: '1.02' },
  'twETH/twBTC': { bestBid: '0.04', bestAsk: null, bids: 1, asks: 0, last: null },
};

/** `GET /v1/pairs` for BOOK plus some fills, oriented by colour hex (LEAST = base). Every default
 *  pair's base sorts first, so each row's base is the pair's base:
 *  - twUSDM (723e…) < twUSDC (e934…): last_price = twUSDC ÷ twUSDM raw = 1.02;
 *  - twETH (2862…) < twUSDC: a fill of 1 twETH (10^18) for 2,500 twUSDC (2.5·10^9) is
 *    2.5·10^9 ÷ 10^18 = 0.0000000025 raw, 2,500 whole;
 *  - twBTC (ad2b…) < twUSDC: never filled (only open offers).
 *  twETH/twBTC has no row (the kernel has never seen a fill or an offer indexed for it here). */
export const PAIRS = [
  {
    pair_key: `${COLOUR.twUSDM}|${COLOUR.twUSDC}`,
    base_color: COLOUR.twUSDM,
    quote_color: COLOUR.twUSDC,
    trade_count: 3,
    last_price: '1.02000000000000000000',
    last_traded_at: '2026-09-27T11:00:00.000Z',
    open_count: 4,
  },
  {
    pair_key: `${COLOUR.twBTC}|${COLOUR.twUSDC}`,
    base_color: COLOUR.twBTC,
    quote_color: COLOUR.twUSDC,
    trade_count: 0,
    last_price: null,
    last_traded_at: null,
    open_count: 2,
  },
  {
    pair_key: `${COLOUR.twETH}|${COLOUR.twUSDC}`,
    base_color: COLOUR.twETH,
    quote_color: COLOUR.twUSDC,
    trade_count: 1,
    last_price: '0.00000000250000000000',
    last_traded_at: '2026-09-27T10:00:00.000Z',
    open_count: 0,
  },
];

/** The kernel's answer for a pair with no offers and no fills (./staging-2026-09-27/chart-stats-wstka-wusdc.json,
 *  captured while the staging book was empty). */
const emptyStats = (base: string, quote: string) => ({
  base,
  quote,
  last: 0,
  change24: 0,
  high: 0,
  low: 0,
  volume_base: 0,
  volume_quote: 0,
});

/** `GET /v1/chart/stats?base=<base>&quote=<quote>` per pair (JSON numbers, as trade-data.ts returns
 *  them; raw base-unit ratios). twBTC/twUSDC never filled, so the kernel reports the open-book MID
 *  (here the best ask, 60,000 whole = 600 raw, the only side) as `last` with zero volume: that is NOT
 *  a trade. twETH/twUSDC's fill is older than 24 h (zero volume). */
export const STATS: Record<PairId, object> = {
  'twBTC/twUSDC': {
    base: COLOUR.twBTC,
    quote: COLOUR.twUSDC,
    last: 600,
    change24: 0,
    high: 600,
    low: 600,
    volume_base: 0,
    volume_quote: 0,
  },
  'twETH/twUSDC': {
    base: COLOUR.twETH,
    quote: COLOUR.twUSDC,
    last: 2.5e-9,
    change24: 0,
    high: 2.5e-9,
    low: 2.5e-9,
    volume_base: 0,
    volume_quote: 0,
  },
  'twUSDM/twUSDC': {
    base: COLOUR.twUSDM,
    quote: COLOUR.twUSDC,
    last: 1.02,
    change24: 2,
    high: 1.02,
    low: 1,
    volume_base: 30000000,
    volume_quote: 30300000,
  },
  'twETH/twBTC': emptyStats(COLOUR.twETH, COLOUR.twBTC),
};

/** The kernel's filter semantics for `GET /v1/offers?token=&direction=` (getOpenOffersPage):
 *  an offer matches when it has a leg of `token` on the given side (either side for ANY). */
export function matchesFilter(o: WireOffer, token?: string, direction?: string): boolean {
  if (!token) return true;
  const inGives = o.computed.gives.some((l) => l.token === token);
  const inWants = o.computed.wants.some((l) => l.token === token);
  if (direction === 'GIVING') return inGives;
  if (direction === 'WANTING') return inWants;
  return inGives || inWants;
}
