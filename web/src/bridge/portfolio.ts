// AA 00060 P12.1 (spec FR-020): the Portfolio's bridged holdings. For every token the site's journey
// registry lists (I-1, config.json `bridges`), ONE row: the total, the private (shielded) balance on
// Midnight, and the connected wallet's balance of the SPL mint on Solana, with the mint's address.
//
//   Midnight  the page's own balance of the colour (the coins the CHAIN confirms, `holdingsByColour`),
//             including change only this browser holds; the part not saved in the inbox yet is named.
//   Solana    the sum of the wallet's token accounts of the mint (`getTokenAccountsByOwner`), read on the
//             site's configured Solana RPC (`solana.rpcUrl`, the one Bridge in uses), NEVER the RPC
//             injector: an injector adds Midnight tokens to what it reports, so a site whose Solana RPC
//             is its injector's origin gets "unavailable" (the config check, `solanaLineRpc`).
//   Total     only when both reads succeeded; otherwise the failing line says "unavailable" and there is
//             no total. Both amounts use the I-1 entry's decimals (the bridge is 1:1).
//
// Tokens without a Solana version (not in I-1) are not touched: they keep their rows as before.

import { useEffect, useState } from 'react';

import { confirmedOnChain, holdingsByColour, type StoredCoin } from '@nightmarket/core';
import type { BridgeEntry } from '@nightmarket/core/bridge';

import type { SolanaRpcConfig } from '../config.js';
import { SolanaRpc } from './solana-rpc.js';

/** One read: still running, its amount in base units, or why it could not be made. */
export type LineRead = { state: 'loading' } | { state: 'ok'; amount: bigint } | { state: 'unavailable'; why: string };

/** The Midnight line: the page's own balance, and the part of it not saved in the inbox yet. */
export type MidnightRead = { state: 'ok'; amount: bigint; unsaved: bigint } | { state: 'unavailable'; why: string };

export interface BridgedHolding {
  entry: BridgeEntry;
  midnight: MidnightRead;
  solana: LineRead;
  /** Midnight + Solana, in base units of the entry's decimals; null unless both reads succeeded. */
  total: bigint | null;
}

/** The page's own balance of `colour` (chain-confirmed, unspent coins) and the part with no inbox entry. */
export function midnightBalance(coins: readonly StoredCoin[], colour: string): { amount: bigint; unsaved: bigint } {
  const amount = holdingsByColour(coins).find((h) => h.color === colour)?.total ?? 0n;
  const unsaved = coins
    .filter((c) => c.color === colour && !c.spent && confirmedOnChain(c) && !c.inInbox)
    .reduce((sum, c) => sum + BigInt(c.value), 0n);
  return { amount, unsaved };
}

/** One row per I-1 entry, in the registry's order. `coins` null: the page cannot read the account's coins
 *  (this browser does not hold its key). `solana` is keyed by SPL mint (absent: still loading). */
export function bridgedHoldings(
  entries: readonly BridgeEntry[],
  coins: readonly StoredCoin[] | null,
  solana: ReadonlyMap<string, LineRead>,
): BridgedHolding[] {
  return entries.map((entry) => {
    const midnight: MidnightRead = coins
      ? { state: 'ok', ...midnightBalance(coins, entry.colour) }
      : { state: 'unavailable', why: 'this browser does not hold your account’s key' };
    const s = solana.get(entry.splMint) ?? { state: 'loading' };
    const total = midnight.state === 'ok' && s.state === 'ok' ? midnight.amount + s.amount : null;
    return { entry, midnight, solana: s, total };
  });
}

const originOf = (url: string): string | null => {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
};

/** The config check: the RPC the Solana line reads, or why there is none. It is the site's Solana RPC,
 *  and never the RPC injector (`injector.url`): one on the injector's origin is refused. */
export function solanaLineRpc(
  solana: SolanaRpcConfig | null | undefined,
  injectorUrl: string | null | undefined,
): { url: string } | { refused: string } {
  if (!solana) return { refused: 'this site has no Solana RPC' };
  const rpc = originOf(solana.rpcUrl);
  if (!rpc) return { refused: 'the site’s Solana RPC address is not valid' };
  if (injectorUrl && originOf(injectorUrl) === rpc) {
    return { refused: 'the site’s Solana RPC is its wallet RPC injector, which does not report real balances' };
  }
  return { url: solana.rpcUrl };
}

/** The wallet's balance of each entry's mint, read on `rpc`; a failed read is "unavailable" with its reason. */
export async function readSolanaLines(
  rpc: SolanaRpc,
  owner: string,
  entries: readonly BridgeEntry[],
): Promise<Map<string, LineRead>> {
  const out = new Map<string, LineRead>();
  await Promise.all(
    entries.map(async (e) => {
      try {
        out.set(e.splMint, { state: 'ok', amount: await rpc.ownerMintBalance(owner, e.splMint) });
      } catch (err) {
        out.set(e.splMint, {
          state: 'unavailable',
          why: err instanceof Error && err.message ? err.message : 'the Solana RPC could not be read',
        });
      }
    }),
  );
  return out;
}

/**
 * The Solana lines for `entries`, read when the wallet, the RPC or `refreshKey` changes. A refresh keeps
 * the previous lines until the new read ends (no flicker), but never another wallet's or RPC's lines.
 * With a refused RPC every line is "unavailable".
 */
export function useSolanaLines(
  rpc: { url: string } | { refused: string } | null,
  owner: string | null,
  entries: readonly BridgeEntry[],
  refreshKey: string,
  fetchImpl?: typeof fetch,
): ReadonlyMap<string, LineRead> {
  const url = rpc && 'url' in rpc ? rpc.url : null;
  const refused = rpc && 'refused' in rpc ? rpc.refused : null;
  const mints = entries.map((e) => e.splMint).join(',');
  const key = `${owner ?? ''}|${url ?? ''}|${refused ?? ''}|${mints}`;
  const [read, setRead] = useState<{ key: string; lines: ReadonlyMap<string, LineRead> }>({
    key: '',
    lines: new Map(),
  });
  useEffect(() => {
    if (!owner || entries.length === 0) return;
    let live = true;
    const t = setTimeout(() => {
      if (refused !== null) {
        setRead({ key, lines: new Map(entries.map((e) => [e.splMint, { state: 'unavailable', why: refused }])) });
        return;
      }
      if (!url) return;
      void readSolanaLines(new SolanaRpc(url, fetchImpl), owner, entries).then(
        (lines) => live && setRead({ key, lines }),
      );
    }, 0);
    return () => {
      live = false;
      clearTimeout(t);
    };
    // `entries` is read through `mints` (its identity changes with every registry render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, refreshKey, fetchImpl]);
  return read.key === key ? read.lines : EMPTY;
}

const EMPTY: ReadonlyMap<string, LineRead> = new Map();

/** The account's coins of the bridged colours, as a key: a Solana read follows when it changes (a bridge in
 *  or out landed). Every view computes it the same way, over the whole registry. */
export function bridgedCoinsKey(coins: readonly StoredCoin[], entries: readonly BridgeEntry[]): string {
  const colours = new Set(entries.map((e) => e.colour));
  return coins
    .filter((c) => colours.has(c.color))
    .map((c) => `${c.commitment}:${c.spent ? 1 : 0}:${c.mtIndex ?? ''}`)
    .sort()
    .join(',');
}

// ── P12.1d (spec FR-025): the compact "Your tokens" list beside the books ─────────────────────────────

/** One row of the compact list: a token with one version (a private or a public balance), or a bridged
 *  token with its two (Midnight private + Solana). */
export type CompactRow =
  | { kind: 'shielded' | 'unshielded'; colour: string; amount: bigint }
  | {
      kind: 'bridged';
      colour: string;
      entry: BridgeEntry;
      midnight: bigint;
      solana: LineRead;
      /** The value shown: the total when the Solana read succeeded, else the Midnight value alone. */
      value: bigint;
      /** Whether `value` is the total (both reads succeeded). */
      total: boolean;
    };

/**
 * The compact list's rows (FR-025): every token's FULL value, a bridged one as ONE row whose value is the
 * FR-020 total, and only rows whose value is above zero. When the Solana read failed or is still running,
 * a bridged row shows its Midnight value alone (marked by the view), never a total; with no Midnight value
 * either, it is not shown. `shielded` are the chain-confirmed holdings by colour, `unshielded` the public
 * balances; `order` sorts by the market's token order.
 */
export function compactRows(
  shielded: ReadonlyArray<{ colour: string; amount: bigint }>,
  unshielded: ReadonlyArray<{ colour: string; amount: bigint }>,
  entries: readonly BridgeEntry[],
  lines: ReadonlyMap<string, LineRead>,
  order: (colour: string) => number,
): CompactRow[] {
  const bridgedColours = new Set(entries.map((e) => e.colour));
  const rows: CompactRow[] = [
    ...shielded
      .filter((h) => !bridgedColours.has(h.colour))
      .map((h) => ({ kind: 'shielded' as const, colour: h.colour, amount: h.amount })),
    ...entries.map((entry): CompactRow => {
      const midnight = shielded.find((h) => h.colour === entry.colour)?.amount ?? 0n;
      const solana = lines.get(entry.splMint) ?? { state: 'loading' };
      const total = solana.state === 'ok';
      return {
        kind: 'bridged',
        colour: entry.colour,
        entry,
        midnight,
        solana,
        value: total ? midnight + solana.amount : midnight,
        total,
      };
    }),
    ...unshielded.map((u) => ({ kind: 'unshielded' as const, colour: u.colour, amount: u.amount })),
  ];
  const value = (r: CompactRow) => (r.kind === 'bridged' ? r.value : r.amount);
  const rank = { shielded: 0, bridged: 0, unshielded: 1 } as const;
  return rows
    .filter((r) => value(r) > 0n)
    .sort((a, b) => order(a.colour) - order(b.colour) || rank[a.kind] - rank[b.kind]);
}
