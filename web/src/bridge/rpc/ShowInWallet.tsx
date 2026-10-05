// AA 00060 P8.1 (spec US3, FR-012): "Show in my wallet" on the Portfolio page, when the site names an RPC
// injector (config.json `injector.url`). Before anything is asked, a dialog says what is shared (the
// account's viewing key), with which RPC origin, and what that RPC can and cannot do. Only "Continue"
// reads the injector's registration info, asks the wallet for ONE signature over the text this page
// renders (I-4 v1), and sends ONE registration. Afterwards: the wallet's custom-RPC steps with the URL to
// copy, the registration's status until it is `synced`, `unseenCoins` as a hint, and "Register again" on
// `stale-key`. An error is shown in plain words and never retried by the page.
//
// Nothing is sent to the injector until the customer acts: the page does not look up the registration on
// load ("Check my registration" does, on request).

import { useCallback, useEffect, useMemo, useState } from 'react';

import { PROFILES, type NetworkName } from '@nightmarket/core';
import { injectorOrigin, type RegistrationView } from '@nightmarket/core/bridge';

import { Button, CopyField, Dialog, Notice, Panel } from '../../design/index.js';
import { useWallet } from '../../wallet/WalletContext.js';
import {
  checkInjector,
  readRegistrationStatus,
  registerAccount,
  registrationErrorText,
  type RegistrationContext,
} from './operations.js';

/** How often the status is read while the RPC is still syncing (ms). */
export const REGISTRATION_POLL_MS = 3_000;

const STATUS_TEXT: Record<RegistrationView['status'], string> = {
  syncing: 'Registered. The RPC is reading your account…',
  synced: 'Registered. Your wallet shows your Night Market balances once it uses this RPC.',
  incomplete: 'Registered, but the RPC could not read your whole history yet; it keeps trying.',
  'stale-key':
    "The RPC no longer holds your account's current key (it changed since you registered). Register again to keep your balances showing.",
  error: 'Registered, but the RPC could not read your account the last time it tried.',
};

export function ShowInWallet({
  injectorUrl,
  network,
  account,
  viewingKey,
  accountChecked,
  busy,
}: {
  injectorUrl: string;
  network: NetworkName;
  account: string;
  /** The account's X25519 inbox secret from this browser's record (64 hex). */
  viewingKey: string;
  accountChecked: boolean;
  busy: boolean;
}) {
  const wallet = useWallet();
  const origin = injectorOrigin(injectorUrl);
  const ctx = useMemo((): RegistrationContext | null => {
    if (!wallet.address || !origin) return null;
    return {
      injectorUrl,
      midnightNetworkId: PROFILES[network].midnightNetworkId,
      wallet: wallet.address,
      account,
    };
  }, [wallet.address, origin, injectorUrl, network, account]);
  const [asking, setAsking] = useState(false);
  const [working, setWorking] = useState<'register' | 'status' | null>(null);
  const [view, setView] = useState<RegistrationView | null>(null);
  const [none, setNone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Follow the status until the RPC has read the account (or says why not).
  const poll = view?.status === 'syncing';
  useEffect(() => {
    if (!poll || !ctx) return;
    let live = true;
    const t = setInterval(() => {
      void readRegistrationStatus(ctx).then(
        (v) => live && v && setView(v),
        () => undefined,
      );
    }, REGISTRATION_POLL_MS);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [poll, ctx]);

  const register = useCallback(async () => {
    setAsking(false);
    if (!ctx || !wallet.signing) return;
    setError(null);
    setNone(false);
    setWorking('register');
    try {
      const info = await checkInjector(ctx);
      setView(await registerAccount(ctx, info, wallet.signing, viewingKey));
    } catch (e) {
      setError(registrationErrorText(e));
    } finally {
      setWorking(null);
    }
  }, [ctx, wallet.signing, viewingKey]);

  const checkStatus = async () => {
    if (!ctx) return;
    setError(null);
    setWorking('status');
    try {
      const v = await readRegistrationStatus(ctx);
      setView(v);
      setNone(v === null);
    } catch (e) {
      setError(registrationErrorText(e));
    } finally {
      setWorking(null);
    }
  };

  if (!origin) return null;
  const blocked = !accountChecked
    ? 'Show in my wallet waits until this page has checked your account on Midnight.'
    : !wallet.signing?.rpcRegistration
      ? 'This wallet connection cannot sign the registration.'
      : null;
  const registered = view !== null;

  return (
    <Panel title="Show in my wallet" data-testid="show-in-wallet-section">
      <p className="panel-intro small muted">
        See your Night Market balances in your Solana wallet: register your account with the RPC at{' '}
        <span className="mono" data-testid="show-in-wallet-origin">
          {origin}
        </span>
        , then set that RPC in your wallet. One signature; it moves no funds.
      </p>
      {blocked && (
        <Notice tone="warning" role="status" className="panel-intro" data-testid="show-in-wallet-blocked">
          {blocked}
        </Notice>
      )}
      {error && (
        <Notice tone="danger" role="alert" className="panel-intro" data-testid="show-in-wallet-error">
          {error}
        </Notice>
      )}
      {none && (
        <p className="small" data-testid="show-in-wallet-none">
          This RPC has no registration for your account yet.
        </p>
      )}
      {view && (
        <div data-testid="show-in-wallet-result">
          <Notice
            tone={view.status === 'synced' ? 'success' : view.status === 'syncing' ? 'info' : 'warning'}
            role="status"
            data-testid="show-in-wallet-status"
            data-status={view.status}
          >
            {STATUS_TEXT[view.status]}
          </Notice>
          {view.unseenCoins > 0 && (
            <p className="small" data-testid="show-in-wallet-unseen" data-count={view.unseenCoins}>
              {view.unseenCoins === 1 ? 'One coin' : `${view.unseenCoins} coins`} in your account{' '}
              {view.unseenCoins === 1 ? 'is' : 'are'} not saved in its inbox yet (usually a withdrawal&apos;s change),
              so your wallet shows less until you save {view.unseenCoins === 1 ? 'it' : 'them'} under Pending.
            </p>
          )}
          <p className="small">
            <strong>In Nightly:</strong> turn on Developer Mode, then pick Custom as the Solana RPC endpoint and paste:
          </p>
          <CopyField value={origin} data-testid="show-in-wallet-url" />
          <p className="small muted">Other wallets: set a custom Solana RPC to the same address.</p>
        </div>
      )}
      <div className="row gap-top">
        {(!registered || view?.status === 'stale-key') && (
          <Button
            disabled={busy || working !== null || !!blocked}
            onClick={() => setAsking(true)}
            data-testid={registered ? 'show-in-wallet-again' : 'show-in-wallet-start'}
          >
            {working === 'register' ? 'Registering…' : registered ? 'Register again' : 'Show in my wallet'}
          </Button>
        )}
        <Button
          variant="secondary"
          disabled={working !== null}
          onClick={() => void checkStatus()}
          data-testid="show-in-wallet-check"
        >
          {working === 'status' ? 'Checking…' : 'Check my registration'}
        </Button>
      </div>
      <Dialog
        open={asking}
        title="Share your account's viewing key?"
        onClose={() => setAsking(false)}
        testId="show-in-wallet-disclosure"
        actions={
          <>
            <Button variant="secondary" data-testid="show-in-wallet-cancel" onClick={() => setAsking(false)}>
              Cancel
            </Button>
            <Button data-testid="show-in-wallet-continue" onClick={() => void register()}>
              Continue to your wallet
            </Button>
          </>
        }
      >
        <ul className="small">
          <li>
            <strong>What is shared:</strong> your account&apos;s viewing key, the key this browser uses to read your
            account&apos;s coins.
          </li>
          <li>
            <strong>With whom:</strong> the RPC at <span className="mono">{origin}</span>, and no one else.
          </li>
          <li>
            <strong>What it can do:</strong> see this account&apos;s balances and history, and show them in your wallet.
            It cannot spend or move anything: every spend needs your wallet&apos;s approval.
          </li>
          <li>
            <strong>What you sign:</strong> one message naming that RPC, your wallet and your account. It authorises
            nothing on chain and moves no funds.
          </li>
        </ul>
      </Dialog>
    </Panel>
  );
}
