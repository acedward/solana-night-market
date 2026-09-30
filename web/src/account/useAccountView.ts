// The connected wallet's account on this network, as the market's side panels read it (AA 00047
// lane B2): who is connected, the account this browser holds for them, its coins, and an operation
// environment for signed actions. The Accounts and Trade pages keep their own copies of this logic
// (carried over from MN Bank); the newer panels (holdings, demo tokens, withdraw) share this one.

import { useCallback, useEffect, useMemo, useState } from 'react';

import type { NetworkProfile, UnshieldedBalancesView } from '@nightmarket/core';

import type { OperationEnv } from '../passport/operations.js';
import { findAccount, readCoins, readSecret } from '../passport/records.js';
import { RelayClient } from '../relay/client.js';
import { useStore } from '../store/StoreContext.js';
import { useWallet } from '../wallet/WalletContext.js';

export function useAccountView(network: NetworkProfile, relayUrl: string) {
  const { store, revision } = useStore();
  const wallet = useWallet();
  const relay = useMemo(() => new RelayClient(relayUrl), [relayUrl]);
  const owner = wallet.status === 'connected' ? wallet.deviceKey : null;
  const scope = useMemo(() => (owner ? { network: network.name, owner } : null), [owner, network.name]);
  // `revision` changes on every store write, here or in another tab: the reads below follow it.
  const account = useMemo(
    () => (store && scope ? findAccount(store, scope) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store, scope, revision],
  );
  const hasSecret = !!(store && scope && account && readSecret(store, scope, account.address));
  const coins = useMemo(
    () => (store && scope && account ? readCoins(store, scope, account.address) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store, scope, account, revision],
  );
  const env = useCallback(
    (onJob?: OperationEnv['onJob']): OperationEnv | null => {
      if (!store || !scope || !wallet.signing) return null;
      return { relay, store, scope, signing: wallet.signing, ...(onJob ? { onJob } : {}) };
    },
    [store, scope, wallet.signing, relay],
  );
  return { wallet, store, scope, account, hasSecret, coins, relay, env };
}

/**
 * The account's unshielded balances from the relay (packages/core/src/unshielded.ts). `view` is null
 * while unknown or when the relay does not serve them (`served` false then); `reload` reads again.
 */
export function useUnshieldedBalances(relay: RelayClient, account: string | null, revision = 0) {
  const [state, setState] = useState<{ view: UnshieldedBalancesView | null; served: boolean; error: string | null }>({
    view: null,
    served: true,
    error: null,
  });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!account) return;
    let live = true;
    relay.unshieldedBalances(account).then(
      (view) => live && setState({ view, served: view !== null, error: null }),
      (e: unknown) =>
        live && setState((s) => ({ ...s, error: e instanceof Error ? e.message : 'The balances could not be read.' })),
    );
    return () => {
      live = false;
    };
  }, [relay, account, tick, revision]);
  return { ...state, reload: () => setTick((t) => t + 1) };
}
