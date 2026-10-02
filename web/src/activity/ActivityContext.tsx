// The app's one ActivityStore (./activity.ts), for the pages (to report their actions and jobs) and
// the signing modal (to show them). Outside a provider (a component test) a private store is used,
// so a page works the same without the modal.

import { createContext, useContext, useMemo, type ReactNode } from 'react';

import { ActivityStore } from './activity.js';

const Ctx = createContext<ActivityStore | null>(null);

export function ActivityProvider({ store, children }: { store: ActivityStore; children: ReactNode }) {
  return <Ctx.Provider value={store}>{children}</Ctx.Provider>;
}

export function useActivity(): ActivityStore {
  const v = useContext(Ctx);
  const own = useMemo(() => new ActivityStore(), []);
  return v ?? own;
}
