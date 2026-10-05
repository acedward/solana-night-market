// AA 00057 P3: the oracle table's data and its EXACT comparison, and the SC-005 prompt summary, offline.

import { describe, expect, it } from 'vitest';

import {
  CHECKPOINTS,
  ORACLE,
  UNDELIVERABLE_LOCK,
  UNIT,
  compareCheckpoint,
  compareSurface,
  formatWhole,
  oracleRowText,
  type Observed,
} from './oracle.js';
import { readPromptLog, summarisePrompts, type PromptEntry } from './prompt-log.js';

const u = (n: number) => BigInt(n) * UNIT;
const copy = (o: Observed): Observed =>
  JSON.parse(
    JSON.stringify(o, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v)),
    (_k, v) => (typeof v === 'string' && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v),
  );

describe('the oracle table is the spec’s US5 table', () => {
  it('rows Start, II, IV and V, as the spec writes them', () => {
    const row = (c: keyof typeof ORACLE) => ({
      walletASolana: oracleRowText(ORACLE[c].solanaA),
      accountA: oracleRowText(ORACLE[c].accountA),
      rpc: [oracleRowText(ORACLE[c].rpcA.spl), oracleRowText(ORACLE[c].rpcA.midnight, ' (Midnight)')]
        .filter((t) => t !== '—')
        .join(', '),
      accountB: oracleRowText(ORACLE[c].accountB),
    });
    expect(row('start')).toEqual({ walletASolana: 'X 600', accountA: '—', rpc: 'X 600', accountB: 'Y 50' });
    // Row II's RPC column is checked once A is registered (III).
    expect(row('III')).toEqual({
      walletASolana: 'X 100',
      accountA: 'X 500',
      rpc: 'X 100, X (Midnight) 500',
      accountB: 'Y 50',
    });
    expect(row('IV')).toEqual({
      walletASolana: 'X 100',
      accountA: 'X 300, Y 50',
      rpc: 'X 100, X (Midnight) 300, Y (Midnight) 50',
      accountB: 'X 200',
    });
    expect(row('V')).toEqual({
      walletASolana: 'X 100, Y 50',
      accountA: 'X 300',
      rpc: 'X 100, Y 50, X (Midnight) 300',
      accountB: 'X 200',
    });
  });

  it('II before registration: the RPC shows the real SPL only', () => {
    expect(ORACLE.II.rpcA).toEqual({ spl: { X: u(100) }, midnight: {} });
    expect(ORACLE.II.solanaA).toEqual(ORACLE.III.solanaA);
    expect(ORACLE.II.accountA).toEqual(ORACLE.III.accountA);
  });

  it('the vaults back every bridged unit 1:1, and the negatives change only the X vault', () => {
    for (const c of CHECKPOINTS) {
      const o = ORACLE[c];
      const bridgedX = (o.accountA.X ?? 0n) + (o.accountB.X ?? 0n);
      const bridgedY = (o.accountA.Y ?? 0n) + (o.accountB.Y ?? 0n);
      const extra = c === 'after-negatives' ? UNDELIVERABLE_LOCK : 0n;
      expect(o.vaults.X).toBe(bridgedX + extra);
      expect(o.vaults.Y).toBe(bridgedY);
    }
    const { vaults: v1, ...rest1 } = ORACLE.V;
    const { vaults: v2, ...rest2 } = ORACLE['after-negatives'];
    expect(rest2).toEqual(rest1);
    expect(v2.X! - v1.X!).toBe(UNDELIVERABLE_LOCK);
  });

  it('every unit of X and Y is somewhere: wallet A + accounts + B’s side = what was minted to the journey', () => {
    // X: 600 to A's wallet. Y: 50 bridged in by B (B's wallet then holds 0 Y).
    for (const c of CHECKPOINTS) {
      const o = ORACLE[c];
      const x = (o.solanaA.X ?? 0n) + (o.accountA.X ?? 0n) + (o.accountB.X ?? 0n);
      const y = (o.solanaA.Y ?? 0n) + (o.accountA.Y ?? 0n) + (o.accountB.Y ?? 0n);
      expect(x).toBe(u(600));
      expect(y).toBe(u(50));
    }
  });
});

describe('compareSurface is exact', () => {
  it('equal sets and amounts', () => {
    expect(compareSurface('accountA', { X: u(300), Y: u(50) }, { Y: u(50), X: u(300) }).exact).toBe(true);
  });
  it('an extra token, a missing token or another amount is a difference', () => {
    expect(compareSurface('accountA', { X: u(300) }, { X: u(300), Y: 1n }).diff).toEqual(['Y: not expected, got 1']);
    expect(compareSurface('accountA', { X: u(300), Y: u(50) }, { X: u(300) }).diff).toEqual([
      `Y: expected ${u(50)}, missing`,
    ]);
    expect(compareSurface('rpcA.midnight', { X: u(300) }, { X: u(300) - 1n }).exact).toBe(false);
    expect(compareSurface('solanaA', { X: u(100) }, { X: u(100), 'mint:abc': 5n }).exact).toBe(false);
  });
  it('a zero holding is not a holding; a vault of zero is a fact', () => {
    expect(compareSurface('solanaA', { X: u(100) }, { X: u(100), Y: 0n }).exact).toBe(true);
    expect(compareSurface('accountA', {}, { X: 0n }).exact).toBe(true);
    expect(compareSurface('vaults', { X: u(500), Y: 0n }, { X: u(500), Y: 0n }).exact).toBe(true);
    expect(compareSurface('vaults', { X: u(500), Y: 0n }, { X: u(500) }).exact).toBe(false);
  });
});

describe('compareCheckpoint', () => {
  const asObserved = (c: keyof typeof ORACLE): Observed => copy(ORACLE[c] as Observed);
  it('the oracle row itself is exact, at every checkpoint', () => {
    for (const c of CHECKPOINTS) expect(compareCheckpoint(c, asObserved(c)).exact).toBe(true);
  });
  it('one surface off makes the checkpoint not exact, and names it', () => {
    const o = asObserved('IV');
    o.rpcA = { spl: o.rpcA.spl, midnight: { X: u(500), Y: u(50) } }; // unfiled change: the RPC over-reports
    const r = compareCheckpoint('IV', o);
    expect(r.exact).toBe(false);
    expect(r.surfaces.filter((s) => !s.exact).map((s) => s.surface)).toEqual(['rpcA.midnight']);
  });
  it('a neighbouring row is never mistaken for this one', () => {
    expect(compareCheckpoint('II', asObserved('III')).exact).toBe(false);
    expect(compareCheckpoint('V', asObserved('after-negatives')).exact).toBe(false);
  });
});

describe('formatWhole', () => {
  it('whole tokens at 6 decimals', () => {
    expect(formatWhole(u(600))).toBe('600');
    expect(formatWhole(500_000n)).toBe('0.5');
    expect(formatWhole(1n)).toBe('0.000001');
  });
});

describe('SC-005 prompt summary', () => {
  const e = (step: string, wallet = 'A', kind: PromptEntry['kind'] = 'message'): PromptEntry => ({
    at: '2026-10-05T00:00:00Z',
    step,
    wallet,
    kind,
    what: '',
  });
  const journey = [
    e('I'),
    e('prefund', 'B'),
    e('prefund', 'B', 'transaction'),
    e('II', 'A', 'transaction'),
    e('III'),
    e('IV'),
    e('IV', 'B'),
    e('V'),
    e('V'),
    e('V'),
    e('neg'),
    e('neg'),
  ];
  it('A: 1, 1, 1, 1, 3 = 7, within the limit; negatives and B are apart', () => {
    const s = summarisePrompts(journey, 'A');
    expect(s.perStep).toEqual({ I: 1, II: 1, III: 1, IV: 1, V: 3 });
    expect(s.journeyTotal).toBe(7);
    expect(s.other).toEqual({ neg: 2 });
    expect(s.withinLimit).toBe(true);
    expect(s.matchesExpected).toBe(true);
  });
  it('an eighth prompt fails the limit; a moved prompt fails the expectation', () => {
    expect(summarisePrompts([...journey, e('II')], 'A').withinLimit).toBe(false);
    const moved = journey.map((x, i) => (i === 4 ? { ...x, step: 'II' } : x));
    const s = summarisePrompts(moved, 'A');
    expect(s.withinLimit).toBe(true);
    expect(s.matchesExpected).toBe(false);
  });
  it('reads the ledger’s JSON lines', () => {
    const text = `${journey.map((x) => JSON.stringify(x)).join('\n')}\n`;
    expect(readPromptLog(text)).toEqual(journey);
  });
});
