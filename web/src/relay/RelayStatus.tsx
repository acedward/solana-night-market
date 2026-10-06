// The market's status as the page knows it (plan P4-A error states): /health read when the page
// opens, every minute, and when the tab comes back into view. Pages ask `useRelayStatus()` for the
// notices of their place (./status.ts) and for whether an action would be refused, so a paused
// action is explained BEFORE the wallet is asked to sign anything.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { Notice } from '../design/index.js';
import { RelayClient } from './client.js';
import { relayNotices, spendingPaused, type RelayState, type NoticePlace } from './status.js';

export const HEALTH_POLL_MS = 60_000;

interface RelayStatusValue extends RelayState {
  refresh(): Promise<void>;
}

const Ctx = createContext<RelayStatusValue | null>(null);

export function RelayStatusProvider({
  relayUrl,
  pollMs = HEALTH_POLL_MS,
  siteTokensDigest = null,
  children,
}: {
  relayUrl: string;
  pollMs?: number;
  /** AA 00060 P4.3: this site's token-list digest (core `tokensDigest`), compared with the relay's. */
  siteTokensDigest?: string | null;
  children: ReactNode;
}) {
  const relay = useMemo(() => new RelayClient(relayUrl), [relayUrl]);
  const [state, setState] = useState<RelayState>({ health: null, reachable: null, checkedAt: null });
  const [relayTokensDigest, setRelayTokensDigest] = useState<string | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);

  const refresh = useCallback(() => {
    if (!inFlight.current) {
      inFlight.current = relay
        .health()
        .then(
          (health) => setState({ health, reachable: true, checkedAt: Date.now() }),
          (e: unknown) => {
            const unreachable = (e as { code?: string } | null)?.code === 'unreachable';
            setState((s) => ({
              // A body that is not a health report (a proxy error page): keep the last report.
              health: unreachable ? null : s.health,
              reachable: unreachable ? false : s.reachable,
              checkedAt: Date.now(),
            }));
          },
        )
        .then(() =>
          // AA 00060 P4.3: the relay's token-list digest, read with every refresh (it changes only
          // with the relay's configuration). An unreadable answer keeps the last one.
          relay.tokensDigest().then(setRelayTokensDigest, () => undefined),
        )
        .finally(() => {
          inFlight.current = null;
        });
    }
    return inFlight.current;
  }, [relay]);

  useEffect(() => {
    const first = setTimeout(() => void refresh(), 0);
    const every = setInterval(() => void refresh(), pollMs);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearTimeout(first);
      clearInterval(every);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh, pollMs]);

  const value = useMemo(
    () => ({ ...state, siteTokensDigest, relayTokensDigest, refresh }),
    [state, siteTokensDigest, relayTokensDigest, refresh],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Outside a provider (a component test), the market is simply "not read yet". */
const UNKNOWN: RelayStatusValue = { health: null, reachable: null, checkedAt: null, refresh: async () => {} };

export function useRelayStatus(): RelayStatusValue & {
  /** Why actions the market pays fees for are paused now, or null. */
  spendingPaused: string | null;
} {
  const v = useContext(Ctx) ?? UNKNOWN;
  return { ...v, spendingPaused: spendingPaused(v) };
}

/** The notices of one place, as design-system Notices (each with its own test id). */
export function RelayNotices({ place, className }: { place: NoticePlace; className?: string }) {
  const s = useRelayStatus();
  const notices = relayNotices(s).filter((n) => n.place === place);
  if (notices.length === 0) return null;
  return (
    <>
      {notices.map((n) => (
        <Notice
          key={n.id}
          tone={n.tone}
          role="status"
          title={n.title}
          className={className}
          data-testid={`market-${n.id}`}
        >
          {n.text}
        </Notice>
      ))}
    </>
  );
}
