// AA 00060 P6.0 (Q5 A): every Zswap event of the chain, oldest first, read from the PUBLIC indexer's
// `zswapLedgerEvents` subscription (the same stream the wallet SDK's shielded sync replays). The page
// replays them into keys_t's own Zswap local state to find the landing coin's position and spend it
// (@nightmarket/core/bridge/landing-spend), whatever key tx1 sealed it to. Nothing secret is sent: the
// subscription names only an event id.

import { readSubscription } from '../../chain/subscription.js';

const QUERY = 'subscription ($id: Int) { zswapLedgerEvents(id: $id) { id raw maxId } }';

export interface ZswapEvent {
  id: number;
  raw: Uint8Array;
}

const fromHex = (h: string): Uint8Array => {
  const s = h.replace(/^0x/i, '');
  if (s.length % 2 !== 0 || /[^0-9a-f]/i.test(s)) throw new Error('an event is not hex');
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
  return out;
};

/**
 * Every Zswap event from `fromId` (default: the first) up to the newest one the indexer had when the
 * stream reached it (`maxId`), in order. The ids are the indexer's ledger-event ids, shared with the
 * DUST events, so they are increasing but not contiguous (G-LANDING Q5 gate run 1: the first Zswap
 * event of a localnet is id 2). Rejects ids that do not increase.
 */
export async function readZswapEvents(
  wsUrl: string,
  o: { fromId?: number; timeoutMs?: number; WebSocketImpl?: typeof WebSocket } = {},
): Promise<ZswapEvent[]> {
  const out: ZswapEvent[] = [];
  let next = o.fromId ?? 1;
  await readSubscription({
    url: wsUrl,
    query: QUERY,
    variables: { id: next },
    timeoutMs: o.timeoutMs ?? 120_000,
    ...(o.WebSocketImpl ? { WebSocketImpl: o.WebSocketImpl } : {}),
    onData: (data) => {
      const e = (data as { zswapLedgerEvents?: { id: number; raw: string; maxId: number } } | null)?.zswapLedgerEvents;
      if (!e) throw new Error('the indexer sent no Zswap event');
      if (e.id < next) return false; // a repeat of the boundary
      out.push({ id: e.id, raw: fromHex(e.raw) });
      next = e.id + 1;
      return e.id >= e.maxId;
    },
  });
  return out;
}
