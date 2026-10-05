// AA 00057 P3: the US5 oracle table (spec "User Story 5"), as data, and its EXACT comparison. Pure: no
// I/O, so the comparison itself is unit-tested (oracle.test.ts); journey.ts reads the surfaces and calls
// `compareCheckpoint`.
//
//   | After | Wallet A Solana | Account A on Midnight | Wallet A through RPC                      | Account B on Midnight |
//   |-------|-----------------|-----------------------|-------------------------------------------|-----------------------|
//   | Start | X 600           | —                     | X 600                                     | Y 50 (bridged in by B)|
//   | II    | X 100           | X 500                 | X 100, X (Midnight) 500                   | Y 50                  |
//   | IV    | X 100           | X 300, Y 50           | X 100, X (Midnight) 300, Y (Midnight) 50  | X 200                 |
//   | V     | X 100, Y 50     | X 300                 | X 100, Y 50, X (Midnight) 300             | X 200                 |
//
// The surfaces, each compared EXACTLY (the same tokens, nothing more, the same base units):
//   solanaA    A's wallet on the Solana validator itself (classic SPL Token accounts, non-zero);
//   accountA   account A's holdings by the PAGE's own code (web/src/passport/operations.ts syncAccount);
//   rpcA       A's wallet through the injector's `getTokenAccountsByOwner`: the real SPL accounts (Token
//              program, passed through) and the synthetic "<name> (Midnight)" accounts (Token-2022);
//   accountB   account B's holdings by the page's own code;
//   vaults     each bridge's SPL vault on Solana (not in the spec's table; it proves the 1:1 backing).
//
// Row II's RPC column needs A registered (step III), so the checkpoints are: start, II (A not yet
// registered: the RPC must show exactly the real SPL, and nothing synthetic), III (row II's RPC column),
// IV, V, and after-negatives (row V again; the X vault holds the 1 X the non-account lock left there,
// the known limitation of spec US1-2); then, beyond the spec's table, after-partial (P3b.4, FR-021).

export type Holdings = Readonly<Record<string, bigint>>;

export interface Checkpoint {
  solanaA: Holdings;
  accountA: Holdings;
  rpcA: { spl: Holdings; midnight: Holdings };
  accountB: Holdings;
  vaults: Holdings;
}

/** One whole token (both journey tokens have 6 decimals, the spec's assumption). */
export const UNIT = 1_000_000n;
const u = (n: number) => BigInt(n) * UNIT;

export const CHECKPOINTS = ['start', 'II', 'III', 'IV', 'V', 'after-negatives', 'after-partial'] as const;
export type CheckpointName = (typeof CHECKPOINTS)[number];

/** The base units the non-account lock (the SC-004 `undeliverable` negative) leaves in X's vault. */
export const UNDELIVERABLE_LOCK = u(1);

export const ORACLE: Readonly<Record<CheckpointName, Checkpoint>> = {
  start: {
    solanaA: { X: u(600) },
    accountA: {},
    rpcA: { spl: { X: u(600) }, midnight: {} },
    accountB: { Y: u(50) },
    vaults: { X: 0n, Y: u(50) },
  },
  II: {
    solanaA: { X: u(100) },
    accountA: { X: u(500) },
    rpcA: { spl: { X: u(100) }, midnight: {} },
    accountB: { Y: u(50) },
    vaults: { X: u(500), Y: u(50) },
  },
  III: {
    solanaA: { X: u(100) },
    accountA: { X: u(500) },
    rpcA: { spl: { X: u(100) }, midnight: { X: u(500) } },
    accountB: { Y: u(50) },
    vaults: { X: u(500), Y: u(50) },
  },
  IV: {
    solanaA: { X: u(100) },
    accountA: { X: u(300), Y: u(50) },
    rpcA: { spl: { X: u(100) }, midnight: { X: u(300), Y: u(50) } },
    accountB: { X: u(200) },
    vaults: { X: u(500), Y: u(50) },
  },
  V: {
    solanaA: { X: u(100), Y: u(50) },
    accountA: { X: u(300) },
    rpcA: { spl: { X: u(100), Y: u(50) }, midnight: { X: u(300) } },
    accountB: { X: u(200) },
    vaults: { X: u(500), Y: 0n },
  },
  'after-negatives': {
    solanaA: { X: u(100), Y: u(50) },
    accountA: { X: u(300) },
    rpcA: { spl: { X: u(100), Y: u(50) }, midnight: { X: u(300) } },
    accountB: { X: u(200) },
    vaults: { X: u(500) + UNDELIVERABLE_LOCK, Y: 0n },
  },
  // P3b.4 (spec FR-021, beyond the spec's table): A bridges 100 X out of its 300 X coin; the 200 X change is
  // saved in the inbox, so the injector shows exactly the page's 200; the release lands 100 X more on Solana.
  'after-partial': {
    solanaA: { X: u(200), Y: u(50) },
    accountA: { X: u(200) },
    rpcA: { spl: { X: u(200), Y: u(50) }, midnight: { X: u(200) } },
    accountB: { X: u(200) },
    vaults: { X: u(400) + UNDELIVERABLE_LOCK, Y: 0n },
  },
};

/** P3b.4: the partial Bridge out of 'after-partial' (base units of X). */
export const PARTIAL_OUT = u(100);

export type SurfaceName = 'solanaA' | 'accountA' | 'rpcA.spl' | 'rpcA.midnight' | 'accountB' | 'vaults';

export interface SurfaceResult {
  surface: SurfaceName;
  expected: Record<string, string>;
  got: Record<string, string>;
  exact: boolean;
  /** Tokens whose amounts differ, are missing, or are not expected at all. */
  diff: string[];
}

const str = (h: Holdings): Record<string, string> =>
  Object.fromEntries(
    Object.entries(h)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => [k, v.toString()]),
  );

/** Drop zero amounts: a wallet does not list an empty holding (token accounts with 0 are recorded apart). */
export const nonZero = (h: Holdings): Holdings => Object.fromEntries(Object.entries(h).filter(([, v]) => v !== 0n));

/**
 * EXACT equality of one surface: the same set of tokens and the same amounts. For holdings, zero amounts
 * are dropped first (an empty token account is not a holding); vault balances are compared as they are,
 * zeros included (a vault is one account whose balance is the fact).
 */
export function compareSurface(surface: SurfaceName, expected: Holdings, got: Holdings): SurfaceResult {
  const keepZeros = surface === 'vaults';
  const e = keepZeros ? expected : nonZero(expected);
  const g = keepZeros ? got : nonZero(got);
  const diff: string[] = [];
  for (const k of new Set([...Object.keys(e), ...Object.keys(g)])) {
    if (!(k in g)) diff.push(`${k}: expected ${e[k]}, missing`);
    else if (!(k in e)) diff.push(`${k}: not expected, got ${g[k]}`);
    else if (e[k] !== g[k]) diff.push(`${k}: expected ${e[k]}, got ${g[k]}`);
  }
  return { surface, expected: str(e), got: str(g), exact: diff.length === 0, diff: diff.sort() };
}

export interface Observed {
  solanaA: Holdings;
  accountA: Holdings;
  rpcA: { spl: Holdings; midnight: Holdings };
  accountB: Holdings;
  vaults: Holdings;
}

/** Every surface of a checkpoint against the oracle; `exact` only when all are. */
export function compareCheckpoint(
  name: CheckpointName,
  got: Observed,
): { checkpoint: CheckpointName; exact: boolean; surfaces: SurfaceResult[] } {
  const want = ORACLE[name];
  const surfaces = [
    compareSurface('solanaA', want.solanaA, got.solanaA),
    compareSurface('accountA', want.accountA, got.accountA),
    compareSurface('rpcA.spl', want.rpcA.spl, got.rpcA.spl),
    compareSurface('rpcA.midnight', want.rpcA.midnight, got.rpcA.midnight),
    compareSurface('accountB', want.accountB, got.accountB),
    compareSurface('vaults', want.vaults, got.vaults),
  ];
  return { checkpoint: name, exact: surfaces.every((s) => s.exact), surfaces };
}

/** The row of the spec's table a checkpoint shows, as text (for the evidence table). */
export function oracleRowText(h: Holdings, suffix = ''): string {
  const e = Object.entries(nonZero(h)).sort(([a], [b]) => (a < b ? -1 : 1));
  return e.length === 0 ? '—' : e.map(([k, v]) => `${k}${suffix} ${formatWhole(v)}`).join(', ');
}

/** Base units → whole tokens at 6 decimals ("600", "0.5"). */
export function formatWhole(v: bigint): string {
  const whole = v / UNIT;
  const frac = v % UNIT;
  return frac === 0n ? whole.toString() : `${whole}.${frac.toString().padStart(6, '0').replace(/0+$/, '')}`;
}
