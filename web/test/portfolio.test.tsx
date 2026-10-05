// AA 00060 P12.1 / P12.1b / P12.1c (spec FR-020, FR-022, FR-023) at the unit level:
//   FR-020  the bridged rows: totals for X and Y from a Midnight balance and an SPL balance (decimals 6);
//           a failed (or malformed) Solana read says "unavailable" with no total; the Solana line reads the
//           site's Solana RPC and never the injector (the config check); copying the mint copies it whole;
//           tokens without a Solana version keep their rows exactly.
//   FR-022  a configured icon is rendered, an unknown token keeps its text badge, and the bundled icons
//           are byte-identical to the published set (SHA256SUMS).
//   FR-023  the five actions, in order and wording, with their reasons and open transfers.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { act, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { bytesToHex, contractCoinCommitment, registryFor, type StoredCoin } from '@nightmarket/core';
import { parseJourneyRegistry, type BridgeEntry } from '@nightmarket/core/bridge';

import { BridgedHoldingRow, PassportHoldings } from '../src/account/PassportHoldings.js';
import {
  NOT_ON_THIS_MARKET,
  PORTFOLIO_ACTIONS,
  PortfolioActionList,
  actionFromHash,
  actionHref,
  type ActionState,
  type PortfolioActionId,
} from '../src/account/PortfolioActions.js';
import {
  bridgedHoldings,
  readSolanaLines,
  solanaLineRpc,
  useSolanaLines,
  type LineRead,
} from '../src/bridge/portfolio.js';
import { SolanaRpc } from '../src/bridge/solana-rpc.js';
import { TokenIcon } from '../src/design/index.js';
import { asFetch } from '../../test/mocks/http.js';
import { mockSolanaRpc } from '../../test/mocks/solana-rpc.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ROOT = join(__dirname, '../..');
const FIX = join(ROOT, 'test/fixtures');
const ACCOUNT = '45'.repeat(32);
const RPC = 'http://solana-rpc.test/';
const INJECTOR = 'http://injector.test:8899';
// A wallet (base58 of 32 bytes); the mock RPC lists token accounts by this owner.
const WALLET = 'LbUiWL3xVV8hTFYBVdbTNrpDo41NKS6o3LHHuDzjfcY';

const journey = JSON.parse(readFileSync(join(FIX, 'journey-registry.undeployed.json'), 'utf8')) as unknown;
const registry = parseJourneyRegistry(journey, { midnightNetwork: 'undeployed' });
const [X, Y] = registry.entries as [BridgeEntry, BridgeEntry];
const TWUSDC = 'a13a505f63f56936e9bf500eab8602acc7d4f88992b734c46607418e02eca65e';
const tokens = registryFor('undeployed', {
  mode: 'replace',
  tokens: [
    { symbol: 'twUSDC', decimals: 6, midnightColour: TWUSDC, icon: 'token-icons/twusdc.png' },
    { symbol: 'X', name: 'Test X', decimals: 6, midnightColour: X.colour, icon: 'token-icons/x-midnight.png' },
    { symbol: 'Y', name: 'Test Y', decimals: 6, midnightColour: Y.colour },
  ],
});

let n = 0;
/** A coin the chain confirms (it has a position), in the inbox unless `inInbox: false`. */
function coin(color: string, value: bigint, o: { inInbox?: boolean; spent?: boolean } = {}): StoredCoin {
  const c = { nonce: bytesToHex(new Uint8Array(32).fill(++n)), color, value: value.toString() };
  return {
    ...c,
    mtIndex: String(n),
    commitment: contractCoinCommitment(c, ACCOUNT),
    origin: 'inbox',
    inInbox: o.inInbox ?? true,
    spent: o.spent ?? false,
  };
}

const M = 1_000_000n; // 10^6: decimals 6

/** The mock RPC with the wallet's X in two token accounts (60,000 + 30,000) and 25 Y; requests recorded. */
function solana() {
  const rpc = mockSolanaRpc();
  rpc.tokenBalances.set('X1111111111111111111111111111111111111111111', {
    amount: 60_000n * M,
    decimals: 6,
    owner: WALLET,
    mint: X.splMint,
  });
  rpc.tokenBalances.set('X2222222222222222222222222222222222222222222', {
    amount: 30_000n * M,
    decimals: 6,
    owner: WALLET,
    mint: X.splMint,
  });
  // Another wallet's X: not counted.
  rpc.tokenBalances.set('X3333333333333333333333333333333333333333333', {
    amount: 7n * M,
    decimals: 6,
    owner: '11111111111111111111111111111111',
    mint: X.splMint,
  });
  rpc.tokenBalances.set('Y1111111111111111111111111111111111111111111', {
    amount: 25n * M,
    decimals: 6,
    owner: WALLET,
    mint: Y.splMint,
  });
  const urls: string[] = [];
  const handler = asFetch(rpc.handler);
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    urls.push(String(input));
    return handler(input, init);
  }) as typeof fetch;
  return { rpc, urls, fetchImpl };
}

// X: 9,950 in the inbox + a 50 change only this browser holds = 10,000 private; a spent coin and an
// unconfirmed one do not count. Y: 3 private. twUSDC (no Solana version): 1,000.
const coins = (): StoredCoin[] => [
  coin(X.colour, 9_950n * M),
  coin(X.colour, 50n * M, { inInbox: false }),
  coin(X.colour, 400n * M, { spent: true }),
  { ...coin(X.colour, 1n * M), mtIndex: null },
  coin(Y.colour, 3n * M),
  coin(TWUSDC, 1_000n * M),
];

const html = (el: ReactElement) => renderToStaticMarkup(el);

describe('FR-020: a bridged token shows its total, Midnight and Solana', () => {
  it('X and Y: total = the private balance on Midnight + the wallet’s SPL balance (decimals 6)', async () => {
    const s = solana();
    const lines = await readSolanaLines(new SolanaRpc(RPC, s.fetchImpl), WALLET, registry.entries);
    const rows = bridgedHoldings(registry.entries, coins(), lines);
    const [x, y] = rows as [(typeof rows)[0], (typeof rows)[0]];
    expect(x.midnight).toEqual({ state: 'ok', amount: 10_000n * M, unsaved: 50n * M });
    expect(x.solana).toEqual({ state: 'ok', amount: 90_000n * M });
    expect(x.total).toBe(100_000n * M);
    expect(y.midnight).toEqual({ state: 'ok', amount: 3n * M, unsaved: 0n });
    expect(y.solana).toEqual({ state: 'ok', amount: 25n * M });
    expect(y.total).toBe(28n * M);
    // The owner's example: X TOTAL 100,000 / 10,000 (Private) on Midnight / 90,000 on Solana (<mint>).
    const out = html(<BridgedHoldingRow row={x} tokens={tokens} />);
    expect(out).toMatch(
      /Total<\/span><span class="num" data-testid="bridged-total" data-raw="100000000000">100,000\.00/,
    );
    expect(out).toContain('10,000.00</span> (Private) on Midnight');
    expect(out).toContain('50.00 not saved in your inbox yet');
    expect(out).toContain('90,000.00</span> on Solana');
    expect(out).toContain('cGfHiC…QPizuN');
    expect(out).toContain(`data-value="${X.splMint}"`);
    const outY = html(<BridgedHoldingRow row={y} tokens={tokens} />);
    expect(outY).toContain('data-raw="28000000">28.00');
    expect(outY).not.toContain('not saved in your inbox');
    // Every Solana read went to the site's RPC: one getTokenAccountsByOwner per mint.
    expect(s.rpc.calls).toEqual(['getTokenAccountsByOwner', 'getTokenAccountsByOwner']);
    expect(new Set(s.urls)).toEqual(new Set([RPC]));
  });

  it('a Solana read that fails says "unavailable" and shows no total; so does a malformed answer', async () => {
    const s = solana();
    s.rpc.failing.add('getTokenAccountsByOwner');
    const lines = await readSolanaLines(new SolanaRpc(RPC, s.fetchImpl), WALLET, registry.entries);
    const [x] = bridgedHoldings(registry.entries, coins(), lines);
    expect(x!.solana.state).toBe('unavailable');
    expect(x!.total).toBeNull();
    const out = html(<BridgedHoldingRow row={x!} tokens={tokens} />);
    expect(out).toContain('Solana: unavailable');
    expect(out).not.toContain('bridged-total');
    expect(out).toContain('No total');
    // The Midnight line is still shown, and the mint address.
    expect(out).toContain('10,000.00</span> (Private) on Midnight');
    expect(out).toContain(`data-value="${X.splMint}"`);

    // Malformed answers are never read as 0: no list, a token account of another owner or program.
    const answers: unknown[] = [
      { context: { slot: 1 }, value: null },
      {},
      {
        context: { slot: 1 },
        value: [
          {
            pubkey: 'x',
            account: { owner: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', data: ['AA==', 'base64'] },
          },
        ],
      },
    ];
    for (const result of answers) {
      const f = (async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }))) as typeof fetch;
      const l = await readSolanaLines(new SolanaRpc(RPC, f), WALLET, [X]);
      expect(l.get(X.splMint)?.state).toBe('unavailable');
    }
    const otherOwner = solana();
    otherOwner.rpc.tokenBalances.set('X4444444444444444444444444444444444444444444', {
      amount: 1n,
      decimals: 6,
      owner: WALLET,
      mint: X.splMint,
      program: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
    });
    const l2 = await readSolanaLines(new SolanaRpc(RPC, otherOwner.fetchImpl), WALLET, [X]);
    expect(l2.get(X.splMint)?.state).toBe('unavailable');
  });

  it('without the account’s key the Midnight line is "unavailable", and there is no total', () => {
    const lines = new Map<string, LineRead>([[X.splMint, { state: 'ok', amount: 5n * M }]]);
    const [x] = bridgedHoldings([X], null, lines);
    expect(x!.midnight.state).toBe('unavailable');
    expect(x!.total).toBeNull();
    const out = html(<BridgedHoldingRow row={x!} tokens={tokens} />);
    expect(out).toContain('Midnight: unavailable');
    expect(out).toContain('5.00</span> on Solana');
    expect(out).not.toContain('bridged-total');
  });

  it('the config check: the Solana line reads the site’s Solana RPC, never the RPC injector', async () => {
    const cfg = { rpcUrl: RPC, cluster: 'solana:localnet', genesisHash: null };
    expect(solanaLineRpc(cfg, INJECTOR)).toEqual({ url: RPC });
    expect(solanaLineRpc(cfg, null)).toEqual({ url: RPC });
    // A site whose Solana RPC is the injector's origin gets "unavailable", whatever the path.
    const onInjector = { ...cfg, rpcUrl: `${INJECTOR}/rpc` };
    expect(solanaLineRpc(onInjector, `${INJECTOR}/`)).toEqual({ refused: expect.stringContaining('injector') });
    expect(solanaLineRpc(null, INJECTOR)).toEqual({ refused: expect.stringContaining('no Solana RPC') });

    // The hook: with the site's RPC every request goes there; with the injector's, none is made.
    const s = solana();
    const seen = await renderLines(solanaLineRpc(cfg, INJECTOR), s.fetchImpl);
    expect(seen.get(X.splMint)).toEqual({ state: 'ok', amount: 90_000n * M });
    expect(s.urls.length).toBe(2);
    expect(s.urls.every((u) => u === RPC)).toBe(true);
    expect(s.urls.some((u) => u.startsWith(INJECTOR))).toBe(false);
    const t = solana();
    const refused = await renderLines(solanaLineRpc(onInjector, INJECTOR), t.fetchImpl);
    expect(refused.get(X.splMint)?.state).toBe('unavailable');
    expect(t.urls).toEqual([]);
  });

  it('copying the mint address copies the whole address', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const lines = new Map<string, LineRead>([[X.splMint, { state: 'ok', amount: 1n }]]);
    const [x] = bridgedHoldings([X], coins(), lines);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(<BridgedHoldingRow row={x!} tokens={tokens} />));
    const mint = host.querySelector('[data-testid=bridged-mint]')!;
    expect(mint.textContent).toContain('cGfHiC…QPizuN');
    const button = mint.querySelector('button')!;
    expect(button.getAttribute('aria-label')).toBe(`Copy ${X.splMint}`);
    await act(async () => button.click());
    expect(writeText).toHaveBeenCalledWith(X.splMint);
    expect(X.splMint).toBe('cGfHiC6Kgg3FpFZvgwGcswsCRtp4aBP2fzuXRQPizuN');
    await act(async () => root.unmount());
    host.remove();
  });

  it('tokens without a Solana version keep their rows exactly; a bridged colour gets no plain row', () => {
    const lines = new Map<string, LineRead>([[X.splMint, { state: 'ok', amount: 1n }]]);
    const bridged = bridgedHoldings([X], coins(), lines);
    const withBridges = html(<PassportHoldings coins={coins()} tokens={tokens} unshielded={[]} bridged={bridged} />);
    const without = html(<PassportHoldings coins={coins()} tokens={tokens} unshielded={[]} />);
    const rowOf = (out: string, colour: string) => {
      const at = out.indexOf(`data-colour="${colour}"`);
      const start = out.lastIndexOf('<li', at);
      return out.slice(start, out.indexOf('</li>', at) + 5);
    };
    expect(rowOf(withBridges, TWUSDC)).toBe(rowOf(without, TWUSDC));
    expect(rowOf(without, TWUSDC)).toContain('1,000.00');
    expect(withBridges.match(new RegExp(`data-colour="${X.colour}"`, 'g'))).toHaveLength(1);
    expect(withBridges).toContain('data-kind="bridged"');
    expect(without).not.toContain('data-kind="bridged"');
  });
});

/** Render `useSolanaLines` once and wait for its read. */
async function renderLines(rpc: ReturnType<typeof solanaLineRpc>, fetchImpl: typeof fetch) {
  let seen: ReadonlyMap<string, LineRead> = new Map();
  function Probe() {
    seen = useSolanaLines(rpc, WALLET, registry.entries, '0', fetchImpl);
    return null;
  }
  const host = document.createElement('div');
  const root = createRoot(host);
  await act(async () => root.render(<Probe />));
  for (let i = 0; i < 50 && seen.size < registry.entries.length; i++) {
    await act(async () => new Promise((r) => setTimeout(r, 10)));
  }
  await act(async () => root.unmount());
  return seen;
}

describe('FR-022: the wallet’s icons', () => {
  afterEach(() => vi.restoreAllMocks());

  it('a configured icon is rendered; a token without one keeps its text badge', () => {
    expect(html(<TokenIcon symbol="X" src="token-icons/x-midnight.png" />)).toMatch(
      /<img class="token-icon token-icon-img" src="token-icons\/x-midnight\.png" alt="" aria-hidden="true"/,
    );
    expect(html(<TokenIcon symbol="twBTC" />)).toMatch(
      /^<span class="token-icon" style="--tone:\d+" aria-hidden="true">BTC<\/span>$/,
    );
    const lines = new Map<string, LineRead>([[X.splMint, { state: 'ok', amount: 1n }]]);
    const all = html(
      <PassportHoldings
        coins={coins()}
        tokens={tokens}
        unshielded={[]}
        bridged={bridgedHoldings([X, Y], coins(), lines)}
      />,
    );
    // twUSDC's row and X's row (its Midnight image), X's Solana line (the SPL image from I-1, when set).
    expect(all).toContain('src="token-icons/twusdc.png"');
    expect(all).toContain('src="token-icons/x-midnight.png"');
    // Y has no icon configured: the text badge.
    const yRow = all.slice(all.indexOf(`data-colour="${Y.colour}"`));
    expect(yRow.slice(0, yRow.indexOf('token-meta'))).toContain('<span class="token-icon"');
    const withSpl = bridgedHoldings([{ ...X, icon: 'token-icons/x.png' }], coins(), lines);
    expect(html(<BridgedHoldingRow row={withSpl[0]!} tokens={tokens} />)).toContain('src="token-icons/x.png"');
  });

  it('an image that cannot load falls back to the text badge', async () => {
    const host = document.createElement('div');
    const root = createRoot(host);
    await act(async () => root.render(<TokenIcon symbol="X" src="token-icons/missing.png" />));
    const img = host.querySelector('img')!;
    expect(img).not.toBeNull();
    await act(async () => img.dispatchEvent(new Event('error')));
    expect(host.querySelector('img')).toBeNull();
    expect(host.textContent).toBe('X');
    await act(async () => root.unmount());
  });

  it('the bundled icons are byte-identical to the published set (SHA256SUMS)', () => {
    const sums = readFileSync(join(FIX, 'token-icons.SHA256SUMS'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => l.split(/\s+/) as [string, string]);
    const dir = join(ROOT, 'web/public/token-icons');
    expect(readdirSync(dir).sort()).toEqual(sums.map(([, f]) => f).sort());
    for (const [hash, file] of sums) {
      expect(
        createHash('sha256')
          .update(readFileSync(join(dir, file)))
          .digest('hex'),
        file,
      ).toBe(hash);
    }
    expect(sums.map(([, f]) => f).sort()).toEqual([
      'midnight.png',
      'twbtc.png',
      'twusdc.png',
      'x-midnight.png',
      'x.png',
      'y-midnight.png',
      'y.png',
    ]);
  });
});

describe('FR-023: the Portfolio’s actions', () => {
  const states = (over: Partial<Record<PortfolioActionId, ActionState>> = {}) =>
    ({
      send: { disabled: null },
      'bridge-in': { disabled: null },
      'bridge-out': { disabled: null },
      'mint-midnight': { disabled: null },
      'mint-solana': { disabled: NOT_ON_THIS_MARKET },
      ...over,
    }) as Record<PortfolioActionId, ActionState>;

  it('exactly five actions, in this order and wording, each a link to its own flow', () => {
    expect(PORTFOLIO_ACTIONS.map((a) => a.label)).toEqual([
      'Send tokens to a Midnight wallet',
      'Bridge in from Solana: make your tokens private',
      'Bridge out to Solana',
      'Mint Midnight tokens',
      'Mint Solana tokens',
    ]);
    const host = document.createElement('div');
    host.innerHTML = html(<PortfolioActionList states={states({ 'bridge-in': { disabled: null, pending: 2 } })} />);
    const items = [...host.querySelectorAll('[data-testid=portfolio-action]')];
    expect(items.map((i) => i.getAttribute('data-action'))).toEqual([
      'send',
      'bridge-in',
      'bridge-out',
      'mint-midnight',
      'mint-solana',
    ]);
    expect(items.slice(0, 4).map((i) => i.getAttribute('href'))).toEqual([
      '#account?action=send',
      '#account?action=bridge-in',
      '#account?action=bridge-out',
      '#account?action=mint-midnight',
    ]);
    // Mint Solana tokens is not offered by this market: listed, disabled, with the reason; no link.
    expect(items[4]!.tagName).toBe('DIV');
    expect(items[4]!.getAttribute('aria-disabled')).toBe('true');
    expect(items[4]!.textContent).toContain('Not available on this market.');
    expect(items[1]!.textContent).toContain('2 transfers in progress');
    expect(host.querySelectorAll('form, input, select')).toHaveLength(0);
  });

  it('the address names the open action', () => {
    expect(actionFromHash('#account?action=bridge-out')).toBe('bridge-out');
    expect(actionFromHash('#account')).toBeNull();
    expect(actionFromHash('#account?action=nope')).toBeNull();
    expect(actionFromHash('#trade?action=send')).toBeNull();
    expect(actionHref('mint-midnight')).toBe('#account?action=mint-midnight');
  });
});
