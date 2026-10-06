// AA 00062 P4.2 / P4.3: the app's one client prover (./client-prover.ts), its popup and its progress.
// The pages put `useClientProver()` into their OperationEnv; the operations call it before anything
// is signed and while the market waits for a proof. Outside a provider (a component test) there is
// no client prover: the operations then behave exactly as before.

import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';

import { useActivity } from '../activity/ActivityContext.js';
import { Toast } from '../design/index.js';
import { RelayClient } from '../relay/client.js';
import { useStore } from '../store/StoreContext.js';
import {
  ClientProver,
  elapsedClock,
  progressWords,
  type ClientProofProgress,
  type PopupAnswer,
  type PopupRequest,
} from './client-prover.js';
import { browserPackageDeps } from './package-client.js';
import { ProverPopup } from './ProverPopup.js';
import { ProverSettings, type ProverSetting } from './settings.js';

interface ProverContextValue {
  engine: ClientProver;
  settings: ProverSettings;
}

const Ctx = createContext<ProverContextValue | null>(null);

export function ProverProvider({ relayUrl, children }: { relayUrl: string; children: ReactNode }) {
  const { store } = useStore();
  const activity = useActivity();
  const settings = useMemo(() => new ProverSettings(store), [store]);
  const [asking, setAsking] = useState<{ req: PopupRequest; answer: (a: PopupAnswer) => void } | null>(null);
  const [progress, setProgress] = useState<ClientProofProgress | null>(null);
  const engine = useMemo(
    () =>
      new ClientProver({
        relay: new RelayClient(relayUrl),
        settings,
        pkg: browserPackageDeps(),
        popup: (req) =>
          new Promise<PopupAnswer>((resolve) =>
            setAsking({
              req,
              answer: (a) => {
                setAsking(null);
                resolve(a);
              },
            }),
          ),
        progress: (p) => {
          setProgress(p);
          activity.clientProof(p);
        },
      }),
    [relayUrl, settings, activity],
  );
  const value = useMemo(() => ({ engine, settings }), [engine, settings]);
  return (
    <Ctx.Provider value={value}>
      {children}
      {asking && (
        <ProverPopup
          key={`${asking.req.circuit}-${asking.req.reason}-${asking.req.failure ?? ''}`}
          request={asking.req}
          engine={engine}
          settings={settings}
          onContinue={(url) => asking.answer({ url })}
          onCancel={() => asking.answer(null)}
        />
      )}
      <ProvingStatus progress={progress} />
    </Ctx.Provider>
  );
}

/** The hooks for an OperationEnv (`prover`), or undefined outside a provider. */
export function useClientProver(): ClientProver | undefined {
  return useContext(Ctx)?.engine;
}

/** The engine and the setting, for Local Data's section. */
export function useProverContext(): ProverContextValue | null {
  return useContext(Ctx);
}

/** The saved setting, following every change (this tab's Test or Forget, another tab, CLEAR ALL). */
export function useProverSetting(settings: ProverSettings | null): ProverSetting | null {
  const [rev, setRev] = useState(0);
  const { revision } = useStore();
  useEffect(() => settings?.subscribe(() => setRev((r) => r + 1)), [settings]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => settings?.read() ?? null, [settings, rev, revision]);
}

/**
 * "Proving on your prover…" with its elapsed time, wherever the customer is, when the action's own
 * progress window is not showing (sent to the background, or an action that has none: Bridge out).
 */
function ProvingStatus({ progress }: { progress: ClientProofProgress | null }) {
  const activity = useActivity();
  const shown = useSyncExternalStore(activity.subscribe, activity.get, activity.get);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!progress) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [progress]);
  if (!progress || shown) return null;
  return (
    <Toast tone="info" title={progressWords(progress)} data-testid="client-proving-status" data-state={progress.state}>
      <span data-testid="client-proving-elapsed">{elapsedClock((now - progress.startedAt) / 1000)}</span> · your proof
      server at <span className="mono break">{progress.url}</span>. Keep this page open.
    </Toast>
  );
}
