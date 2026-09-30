// What the market's /health says the customer can and cannot do right now (plan P4-A error states),
// as specific notices. Pure and unit-tested; ./RelayStatus.tsx polls /health and pages show the
// notices where they matter:
//   - everywhere (the shell): the market unreachable, its prover down, its fee wallet low or syncing;
//   - Trade: the exchange's settlement service down or refusing (429, 500).

import type { HealthResponse } from '@nightmarket/core';

export type NoticePlace = 'shell' | 'trade';

export interface RelayNotice {
  id: 'relay-down' | 'prover-down' | 'sponsor-low' | 'sponsor-syncing' | 'batcher-down' | 'batcher-refusing';
  place: NoticePlace;
  tone: 'danger' | 'warning' | 'info';
  title: string;
  text: string;
}

/** The market as last read: its health, or why it could not be read. */
export interface RelayState {
  health: HealthResponse | null;
  /** False when /health could not be reached at all; null before the first read. */
  reachable: boolean | null;
  /** Unix ms of the last read. */
  checkedAt: number | null;
}

/** A refusal of the batcher counts for this long after it happened (seconds). */
export const BATCHER_REFUSAL_RECENT_S = 3_600;

export function relayNotices(s: RelayState, nowS = Math.floor(Date.now() / 1000)): RelayNotice[] {
  if (s.reachable === false) {
    return [
      {
        id: 'relay-down',
        place: 'shell',
        tone: 'danger',
        title: "The market's server cannot be reached.",
        text: 'Your balances and the records in this browser are safe. Opening an account, withdrawals and trading need the market, and work again as soon as it answers.',
      },
    ];
  }
  const h = s.health;
  if (!h) return [];
  const out: RelayNotice[] = [];
  if (!h.proofServer.reachable) {
    out.push({
      id: 'prover-down',
      place: 'shell',
      tone: 'danger',
      title: "The market's prover is not available.",
      text: 'Opening accounts, withdrawals and offers are paused until it is back. Your balances are safe.',
    });
  }
  if (h.sponsor.configured && !h.sponsor.synced) {
    out.push({
      id: 'sponsor-syncing',
      place: 'shell',
      tone: 'warning',
      title: "The market's fee wallet is starting up.",
      text: 'It pays the network fees of every action; until it has caught up with the chain, new actions wait. Try again in a few minutes.',
    });
  } else if (h.sponsor.configured && h.sponsor.dustLow) {
    out.push({
      id: 'sponsor-low',
      place: 'shell',
      tone: 'danger',
      title: 'The market is low on network-fee funds.',
      text: 'It pays your fees in DUST, and it has too little left, so opening accounts, withdrawals and offers are paused until the market tops it up. Your balances are safe.',
    });
  }
  if (!h.batcher.reachable) {
    out.push({
      id: 'batcher-down',
      place: 'trade',
      tone: 'warning',
      title: "The exchange's settlement service is not answering.",
      text: 'Taking an offer is paused until it is back. You can still place your own offer; it is settled when someone takes it.',
    });
  } else if (h.batcher.lastRefusal && nowS - h.batcher.lastRefusal.at < BATCHER_REFUSAL_RECENT_S) {
    const r = h.batcher.lastRefusal;
    out.push({
      id: 'batcher-refusing',
      place: 'trade',
      tone: 'warning',
      title:
        r.httpStatus === 429
          ? "The exchange's settlement service is at its limit."
          : "The exchange's settlement service is failing.",
      text:
        r.httpStatus === 429
          ? 'It refused a recent settlement because it allows only a limited number a day (HTTP 429). A take may be refused until the limit resets; nothing moves when it is.'
          : `It answered a recent settlement with an error (HTTP ${r.httpStatus}). A take may fail; nothing moves when it does, and you can try again.`,
    });
  }
  return out;
}

/** Whether the market can take actions that it pays fees for (register, withdrawals, offers) now. */
export function spendingPaused(s: RelayState): string | null {
  const n = relayNotices(s).find((x) => ['relay-down', 'prover-down', 'sponsor-low', 'sponsor-syncing'].includes(x.id));
  return n ? `${n.title} ${n.text}` : null;
}
