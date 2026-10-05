// The Portfolio section (route #account; plan L-ACC, carried over from MN Bank, restyled for end
// users in AA 00047 P8.1): the connected Solana wallet's account on Midnight. Open one (one
// signature, with the relay's stages and queue position), or, when this browser does not hold it,
// the way back through Import. Balances come from the coins this browser keeps, rebuilt from chain
// data by an inbox walk decrypted here. Each token is shown in its own units: nothing is totalled
// in a "home" currency (no token is special).
//
// The trading itself is on Trade; this page is the account's full view: opening it (one Solana
// wallet signature, the relay deploys and activates), the tokens (private shielded coins and public
// unshielded balances), withdrawals to a Midnight wallet (one signature each), demo tokens, the
// pending items and the job tracker (AA 00047 lane B2).

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';

import {
  confirmedOnChain,
  formatUnits,
  holdingsByColour,
  parseUnits,
  shortSolanaAddress,
  solanaAddressOf,
  type JobView,
  type NetworkProfile,
  type StoredCoin,
  type TokenRegistry,
  type UnshieldedBalancesView,
  WHOLE_COIN_EXIT,
  WITHDRAWS_DAILY_CAP_CODE,
} from '@nightmarket/core';
import type { AccountCheckProblem } from '@nightmarket/core/passport';

import { useActivity } from '../activity/ActivityContext.js';
import { stageWords, type ActivityKind } from '../activity/activity.js';
import { RestoreKeyDialog } from '../account/RestoreKeyDialog.js';
import { useUnshieldedBalances } from '../account/useAccountView.js';
import { WholeCoinExit, type WholeCoinExitOffer } from '../account/WholeCoinExit.js';
import { AccountCheckNotice, keyRestorable } from '../chain/AccountCheckNotice.js';
import { useAccountCheck, useChain } from '../chain/ChainContext.js';
import { DemoTokens } from '../demo/DemoTokens.js';

import {
  Avatar,
  Button,
  Card,
  EmptyState,
  Field,
  Hash,
  Icon,
  Notice,
  PageHead,
  Panel,
  PendingItem,
  Segmented,
  Select,
  StageTracker,
  StatusPill,
  Sub,
  TextInput,
  Toast,
  TokenIcon,
  UnitInput,
  type TrackerStage,
} from '../design/index.js';
import { useAssetFilter } from '../assets/AssetFilterContext.js';
import { useBridges } from '../bridge/BridgeContext.js';
import { BridgeIn } from '../bridge/in/BridgeIn.js';
import { useTokenRegistry } from '../market/MarketContext.js';
import {
  awaitChange,
  CHANGE_PENDING,
  openAccount,
  pendingChanges,
  recipientOf,
  restoreEncryptionKey,
  secureChange,
  syncAccount,
  unconfirmedNotes,
  unsecuredCoins,
  withdrawToWallet,
  withdrawUnshieldedToWallet,
  type OperationEnv,
} from '../passport/operations.js';
import { findAccount, listJobs, readCoins, readSecret } from '../passport/records.js';
import { useRelayStatus } from '../relay/RelayStatus.js';
import { RelayClient, RelayError } from '../relay/client.js';
import { storageText } from '../store/messages.js';
import { useStore } from '../store/StoreContext.js';
import { confirmCancelsOffer as confirmOffer, reconcileFromChain } from '../trade/operations.js';
import { useConnectPrompt } from '../wallet/connect-prompt.js';
import { useWallet } from '../wallet/WalletContext.js';

const short = (s: string, head = 8, tail = 6) =>
  s.length <= head + tail + 1 ? s : `${s.slice(0, head)}…${s.slice(-tail)}`;

const JOB_TITLE: Record<string, string> = {
  register: 'Opening your account',
  withdraw: 'Withdrawing',
  'withdraw-unshielded': 'Withdrawing public tokens',
  'append-inbox': 'Saving your change',
  'demo-tokens': 'Delivering your demo tokens',
  'cancel-offers': 'Cancelling your offer',
  'restore-enc-key': 'Restoring your encryption key',
};

/** "14:06" UTC from the relay's Unix seconds. */
const clock = (unixSeconds: number) => new Date(unixSeconds * 1000).toISOString().slice(11, 16);

function JobTracker({ job }: { job: JobView }) {
  const last = job.stages.length - 1;
  const stages: TrackerStage[] = job.stages.map((s, i) => ({
    key: `${s.stage}-${i}`,
    title: stageWords(s.stage, job.action),
    state: i < last || job.state === 'succeeded' ? 'done' : job.state === 'failed' ? 'failed' : 'current',
    time: <span title={new Date(s.at * 1000).toISOString()}>{clock(s.at)}</span>,
    detail: s.detail?.tx ? (
      <>
        tx <Hash value={s.detail.tx} head={8} tail={6} />
      </>
    ) : undefined,
    data: { testid: 'job-stage', stage: s.stage },
  }));
  return (
    <Panel
      title={JOB_TITLE[job.action] ?? 'Market job'}
      data-testid="job-tracker"
      data-state={job.state}
      data-stage={job.stage}
      meta={
        <StatusPill
          status={
            job.state === 'succeeded'
              ? 'done'
              : job.state === 'failed'
                ? 'failed'
                : job.state === 'queued'
                  ? 'idle'
                  : 'progress'
          }
        >
          {job.state === 'succeeded'
            ? 'Done'
            : job.state === 'failed'
              ? 'Failed'
              : job.state === 'queued'
                ? 'Queued'
                : 'In progress'}
        </StatusPill>
      }
    >
      <p className="tracker-summary">
        <strong>{stageWords(job.stage, job.action)}</strong>
        {job.state === 'queued' && job.position !== undefined && (
          <span data-testid="queue-position"> — position {job.position} in the queue</span>
        )}
        <br />
        <span className="muted">Safe to leave this page open; the market does the work.</span>
      </p>
      <StageTracker stages={stages} label="Progress" />
      {job.error && (
        <Notice tone="danger" role="alert" data-testid="job-error">
          {job.error.message}
        </Notice>
      )}
    </Panel>
  );
}

function PassportHoldings({
  coins,
  tokens,
  unshielded,
}: {
  coins: StoredCoin[];
  tokens: TokenRegistry | null;
  unshielded: Array<{ colour: string; amount: bigint }>;
}) {
  // Listed in the market's token order (the registry's); unknown colours last.
  const order = (colour: string) => {
    const i = tokens?.tokens.findIndex((t) => t.midnightColour === colour) ?? -1;
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  const rows = holdingsByColour(coins)
    .map((h) => ({ h, token: tokens?.byColour(h.color) }))
    .sort((a, b) => order(a.h.color) - order(b.h.color));
  const open = unshielded
    .filter((u) => u.amount > 0n)
    .map((u) => ({ u, token: tokens?.byColour(u.colour) }))
    .sort((a, b) => order(a.u.colour) - order(b.u.colour));
  if (rows.length === 0 && open.length === 0) {
    return (
      <EmptyState data-testid="passport-empty" icon="gift" title="No tokens yet">
        Get the free demo pack, or send tokens to your account. They show here once they land.
      </EmptyState>
    );
  }
  return (
    <ul className="token-list" aria-label="Your tokens" data-testid="passport-holdings">
      {rows.map(({ h, token: t }) => {
        const dec = t?.decimals ?? 0;
        const symbol = t?.symbol ?? short(h.color);
        return (
          <li
            key={h.color}
            className="token-row"
            data-testid="passport-row"
            data-colour={h.color}
            data-symbol={t?.symbol ?? ''}
          >
            <TokenIcon symbol={symbol} />
            <span className="token-meta">
              <span className="token-sym">
                {symbol}
                <span className="kind-chip">{t && t.privacy !== 'shielded' ? 'public' : 'private'}</span>
              </span>
              {t?.name ? <span className="token-name">{t.name}</span> : null}
            </span>
            <span className="token-amount">
              <span className="num" data-testid="passport-amount" data-raw={h.total.toString()}>
                {formatUnits(h.total, dec, { minFractionDigits: 2, grouping: true })}
              </span>
              <Sub>
                up to{' '}
                <span data-testid="passport-largest" data-raw={h.largest.toString()}>
                  {formatUnits(h.largest, dec, { minFractionDigits: 2, grouping: true })}
                </span>{' '}
                in one go
              </Sub>
            </span>
          </li>
        );
      })}
      {open.map(({ u, token: t }) => {
        const symbol = t?.symbol ?? short(u.colour);
        return (
          <li
            key={`u-${u.colour}`}
            className="token-row"
            data-testid="passport-row"
            data-kind="unshielded"
            data-colour={u.colour}
            data-symbol={t?.symbol ?? ''}
          >
            <TokenIcon symbol={symbol} />
            <span className="token-meta">
              <span className="token-sym">
                {symbol}
                <span className="kind-chip">public</span>
              </span>
              <span className="token-name">{t?.name ? `${t.name} · public balance` : 'public balance'}</span>
            </span>
            <span className="token-amount">
              <span className="num" data-testid="passport-amount" data-raw={u.amount.toString()}>
                {formatUnits(u.amount, t?.decimals ?? 0, { minFractionDigits: 2, grouping: true })}
              </span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** A withdrawal from the public (unshielded) balance to an unshielded wallet (`mn_addr_…`): one signature. */
function UnshieldedWithdrawForm({
  balances,
  tokens,
  onSend,
  busy,
}: {
  balances: Array<{ colour: string; amount: bigint }>;
  tokens: TokenRegistry | null;
  onSend: (color: string, amount: bigint, recipient: string, balance: bigint) => void;
  busy: boolean;
}) {
  const [color, setColor] = useState('');
  const [amount, setAmount] = useState('');
  const [recipient, setRecipient] = useState('');
  const [error, setError] = useState<string | null>(null);
  const chosen = color || balances[0]?.colour || '';
  const token = tokens?.byColour(chosen);
  const balance = balances.find((b) => b.colour === chosen)?.amount ?? 0n;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const raw = parseUnits(amount, token?.decimals ?? 0);
      if (raw > balance) {
        setError(`You hold ${formatUnits(balance, token?.decimals ?? 0)} ${token?.symbol ?? ''} as public tokens.`);
        return;
      }
      onSend(chosen, raw, recipient.trim(), balance);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Enter an amount.');
    }
  };
  if (balances.length === 0)
    return (
      <p className="small muted" data-testid="withdraw-unshielded-empty">
        You have no public (unshielded) tokens to withdraw.
      </p>
    );
  return (
    <form onSubmit={submit} data-testid="withdraw-unshielded">
      <div className="form-grid">
        <Field label="Token" htmlFor="wu-token">
          <Select id="wu-token" value={chosen} onChange={(e) => setColor(e.target.value)} data-testid="wu-token">
            {balances.map((b) => (
              <option key={b.colour} value={b.colour}>
                {tokens?.byColour(b.colour)?.symbol ?? short(b.colour)}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="Amount"
          htmlFor="wu-amount"
          hint={<span data-testid="wu-balance">Balance: {formatUnits(balance, token?.decimals ?? 0)}</span>}
        >
          <UnitInput
            id="wu-amount"
            unit={token?.symbol ?? 'units'}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="decimal"
            autoComplete="off"
            data-testid="wu-amount"
          />
        </Field>
      </div>
      <Field label="Send to" htmlFor="wu-recipient" hint="A public Midnight wallet address, mn_addr_…">
        <TextInput
          id="wu-recipient"
          className="mono"
          value={recipient}
          onChange={(e) => setRecipient(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          data-testid="wu-recipient"
        />
      </Field>
      <p className="small muted panel-intro">
        You approve once: Phantom shows the amount, the token and the recipient before you approve.
      </p>
      {error && (
        <Notice tone="danger" role="alert" data-testid="wu-error" className="panel-intro">
          {error}
        </Notice>
      )}
      <Button type="submit" className="btn-block" disabled={busy} data-testid="wu-submit">
        <Icon name="arrowUp" /> Withdraw
      </Button>
    </form>
  );
}

function SendForm({
  coins,
  tokens,
  network,
  onSend,
  busy,
}: {
  coins: StoredCoin[];
  tokens: TokenRegistry | null;
  network: string;
  onSend: (color: string, amount: bigint, recipient: string) => void;
  busy: boolean;
}) {
  const held = holdingsByColour(coins);
  const [color, setColor] = useState('');
  const [amount, setAmount] = useState('');
  const [recipient, setRecipient] = useState('');
  const [error, setError] = useState<string | null>(null);
  const chosen = color || held[0]?.color || '';
  const token = tokens?.byColour(chosen);
  const largest = held.find((h) => h.color === chosen)?.largest ?? 0n;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const raw = parseUnits(amount, token?.decimals ?? 0);
      if (raw > largest) {
        setError(
          `You can send up to ${formatUnits(largest, token?.decimals ?? 0)} in one go: each payment comes from one coin.`,
        );
        return;
      }
      recipientOf(recipient, network); // throws a readable message for a bad address
      onSend(chosen, raw, recipient.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Enter an amount.');
    }
  };
  if (held.length === 0)
    return (
      <p className="small muted" data-testid="send-empty">
        You have no private (shielded) tokens to withdraw yet.
      </p>
    );
  return (
    <div data-testid="send-midnight">
      <form onSubmit={submit}>
        <p className="panel-intro small muted">Send private tokens to a shielded Midnight wallet, such as Lace.</p>
        <div className="form-grid">
          <Field label="Token" htmlFor="send-token">
            <Select id="send-token" value={chosen} onChange={(e) => setColor(e.target.value)} data-testid="send-token">
              {held.map((h) => (
                <option key={h.color} value={h.color}>
                  {tokens?.byColour(h.color)?.symbol ?? short(h.color)}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Amount"
            htmlFor="send-amount"
            hint={<span data-testid="send-largest">Up to {formatUnits(largest, token?.decimals ?? 0)} in one go</span>}
          >
            <UnitInput
              id="send-amount"
              unit={token?.symbol ?? 'units'}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal"
              autoComplete="off"
              data-testid="send-amount"
            />
          </Field>
        </div>
        <Field label="Send to" htmlFor="send-recipient" hint="A shielded Midnight wallet address, mn_shield-addr_…">
          <TextInput
            id="send-recipient"
            className="mono"
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            data-testid="send-recipient"
          />
        </Field>
        <p className="small muted panel-intro">
          You approve once for the payment: Phantom shows the amount, the token and the recipient. Any change stays in
          your account, and Phantom asks for one more approval to save it in your account&apos;s inbox, so a backup can
          always restore it.
        </p>
        {error && (
          <Notice tone="danger" role="alert" data-testid="send-error" className="panel-intro">
            {error}
          </Notice>
        )}
        <Button type="submit" className="btn-block" disabled={busy} data-testid="send-submit">
          <Icon name="arrowUp" /> Withdraw
        </Button>
      </form>
    </div>
  );
}

export function Accounts({ network, relayUrl }: { network: NetworkProfile; relayUrl: string }) {
  const tokens = useTokenRegistry();
  const activity = useActivity();
  const connect = useConnectPrompt();
  const { store, revision, status: storageStatus } = useStore();
  const { spendingPaused } = useRelayStatus();
  const wallet = useWallet();
  const relay = useMemo(() => new RelayClient(relayUrl), [relayUrl]);
  const chain = useChain();
  // AA 00060 P7: the site's journey registry passed its checks, so Bridge in is offered.
  const bridging = useBridges().state === 'ready';
  const [job, setJob] = useState<JobView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [syncing, setSyncing] = useState(false);
  // AA 00047 P11.B: why the page could not read the account's whole history from Midnight, if so.
  const [historyGap, setHistoryGap] = useState<string | null>(null);

  const owner = wallet.status === 'connected' ? wallet.deviceKey : null;
  const scope = useMemo(() => (owner ? { network: network.name, owner } : null), [owner, network.name]);
  // `revision` changes on every store write, here or in another tab: the reads below follow it.
  const account = useMemo(
    () => (store && scope ? findAccount(store, scope) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store, scope, revision],
  );
  const secret = store && scope && account ? readSecret(store, scope, account.address) : null;
  const hasSecret = !!secret;
  const coins = useMemo(
    () => (store && scope && account ? readCoins(store, scope, account.address) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store, scope, account, revision],
  );
  // The market-account check on the chain (AA 00047 P9.S, audit C3).
  const accountCheck = useAccountCheck(
    account && hasSecret ? account.address : null,
    owner,
    secret?.encPublicKey ?? null,
    revision,
    (account?.refusedAtOpen ?? null) as AccountCheckProblem[] | null,
    account?.txs?.waveOne ?? null,
  );
  // The holdings and Send list show only the assets the filter shows (plan 00042); what needs the
  // customer's action (an unrecorded change coin, under Pending) shows whatever it is.
  const assets = useAssetFilter();
  const shownCoins = useMemo(() => coins.filter((c) => assets.showsColour(c.color)), [coins, assets]);
  // The unshielded balances (public contract balances, read from the chain; AA 00047 P9.S).
  const unshieldedRead = useUnshieldedBalances(chain, account && hasSecret ? account.address : null, revision);
  const unshielded = useMemo(
    () =>
      (unshieldedRead.view as UnshieldedBalancesView | null)?.balances
        .map((b) => ({ colour: b.colour, amount: BigInt(b.amount) }))
        .filter((b) => b.amount > 0n && assets.showsColour(b.colour)) ?? [],
    [unshieldedRead.view, assets],
  );
  const [withdrawKind, setWithdrawKind] = useState<'shielded' | 'unshielded'>('shielded');
  // Whether a withdrawal to a wallet also needs F-B6's envelope (questions Q13: off by default).
  const [recipientEnvelope, setRecipientEnvelope] = useState(false);
  useEffect(() => {
    let live = true;
    relay.signingPolicy().then((p) => live && setRecipientEnvelope(p.withdrawRecipientEnvelope));
    return () => {
      live = false;
    };
  }, [relay]);
  const pendingJobs = useMemo(
    () => (store && scope ? listJobs(store, scope) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store, scope, revision],
  );

  const env = useCallback((): OperationEnv | null => {
    if (!store || !scope || !wallet.signing) return null;
    return {
      relay,
      chain,
      store,
      scope,
      signing: wallet.signing,
      onJob: (j) => {
        setJob(j);
        activity.job(j);
      },
    };
  }, [store, scope, wallet.signing, relay, chain, activity]);
  const dismiss = useCallback(() => setMessage(null), []);
  // AA 00060 P7 (FR-003): Bridge in's completion is the page's own decode, from a fresh walk.
  const bridgePageCoins = useCallback(async () => {
    const e = env();
    if (!e || !account || !hasSecret) return [];
    return (await syncAccount(e, account.address)).coins;
  }, [env, account, hasSecret]);

  const sync = useCallback(async () => {
    const e = env();
    if (!e || !account || !hasSecret) return;
    setSyncing(true);
    try {
      const r = await syncAccount(e, account.address);
      setHistoryGap(r.history.complete ? null : (r.history.gap ?? 'the read did not finish'));
    } catch (err) {
      setMessage({ kind: 'error', text: err instanceof Error ? err.message : 'The balances could not be refreshed.' });
    } finally {
      setSyncing(false);
    }
  }, [env, account, hasSecret]);

  // Walk the inbox whenever the account (or this wallet) changes. Deferred, so no state is set
  // during the effect itself.
  const accountAddress = account?.address;
  useEffect(() => {
    if (!accountAddress) return;
    const t = setTimeout(() => void sync(), 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountAddress, owner]);

  const run = async (label: ActivityKind, fn: (e: OperationEnv) => Promise<void>) => {
    const e = env();
    if (!e) return;
    setBusy(label);
    setMessage(null);
    setJob(null);
    try {
      await activity.run(label, () => fn(e));
    } catch (err) {
      setMessage({ kind: 'error', text: err instanceof Error ? err.message : 'Something went wrong.' });
    } finally {
      setBusy(null);
    }
  };

  const open = () =>
    run('register', async (e) => {
      const rec = await openAccount(e);
      setMessage({ kind: 'ok', text: `Your account ${short(rec.address)} is open.` });
    });

  /** L-TRD.3 (Q9): a signed action cancels the account's live offer; say so and ask first. */
  const confirmCancelsOffer = (action: 'withdraw' | 'append-inbox'): boolean => {
    const e = env();
    if (!e || !account) return false;
    return confirmOffer(e, account.address, action);
  };

  // AA 00047 P11 (owner decision Q46 A): the market pays for a daily allowance of withdrawals per
  // account, and the page says NOTHING about it until the market refuses one for it (`429
  // withdraws-daily-cap`, P11.R). Then it explains it (`relayErrorText`) and, while this token's
  // whole-coin exit is open, offers it: one withdrawal of a WHOLE coin per token per day.
  const [exitOffer, setExitOffer] = useState<WholeCoinExitOffer | null>(null);

  const send = (color: string, amount: bigint, recipient: string) =>
    run('withdraw', async (e) => {
      if (!account) return;
      if (!confirmCancelsOffer('withdraw')) return;
      setExitOffer(null);
      let r: Awaited<ReturnType<typeof withdrawToWallet>>;
      try {
        r = await withdrawToWallet(e, account.address, { color, amount, recipient }, { recipientEnvelope });
      } catch (err) {
        if (err instanceof RelayError && err.code === WITHDRAWS_DAILY_CAP_CODE && err.detail === WHOLE_COIN_EXIT.open)
          setExitOffer({ color, recipient });
        throw err;
      }
      // Whether a live offer ended is the chain's to say, not the relay's "sent" (AA 00047 P10, R2-4).
      await reconcileFromChain(e, account.address).catch(() => undefined);
      if (r.changeMismatch) {
        // Q28 A: the market reported another change coin than this withdrawal creates. The browser
        // keeps the one it computed, and says so; the coin is still recorded below.
        setMessage({
          kind: 'error',
          text: `Sent (tx ${short(r.txId)}), but the market reported a different change coin than this withdrawal creates. Night Market kept the correct one, computed in this browser. Tell the market's operator.`,
        });
      } else {
        setMessage({
          kind: 'ok',
          text: r.change
            ? `Sent (tx ${short(r.txId)}). Recording the change in your inbox…`
            : `Sent (tx ${short(r.txId)}).`,
        });
      }
      if (!r.change) return void (await syncAccount(e, account.address));
      // R2-5: the change counts, pays and is filed only once the CHAIN shows it. Q13 default A: then
      // file its inbox entry right away (a second signature).
      const outcome = await awaitChange(e, account.address, r.change.commitment);
      if (outcome.state === 'pending') {
        setMessage({ kind: 'ok', text: `Sent (tx ${short(r.txId)}). ${CHANGE_PENDING}` });
        return;
      }
      if (outcome.state === 'void') {
        setMessage({
          kind: 'error',
          text: 'The market reported the withdrawal sent, but Midnight shows it never happened: your account moved on without it. Nothing left your account.',
        });
        return;
      }
      await secureChange(e, account.address, outcome.coin);
      await syncAccount(e, account.address);
      if (!r.changeMismatch)
        setMessage({ kind: 'ok', text: `Sent (tx ${short(r.txId)}); the change is recorded in your inbox.` });
    });

  const sendUnshielded = (color: string, amount: bigint, recipient: string, balance: bigint) =>
    run('withdraw-unshielded', async (e) => {
      if (!account) return;
      if (!confirmCancelsOffer('withdraw')) return;
      const r = await withdrawUnshieldedToWallet(e, account.address, { color, amount, recipient, balance });
      await reconcileFromChain(e, account.address).catch(() => undefined);
      unshieldedRead.reload();
      setMessage({ kind: 'ok', text: `Withdrawn (tx ${short(r.txId)}).` });
    });

  const secure = (coin: StoredCoin) =>
    run('append-inbox', async (e) => {
      if (!account) return;
      if (!confirmCancelsOffer('append-inbox')) return;
      await secureChange(e, account.address, coin);
      await reconcileFromChain(e, account.address).catch(() => undefined);
      await syncAccount(e, account.address);
      setMessage({ kind: 'ok', text: 'The coin is recorded in your inbox on Midnight.' });
    });

  // "Restore my encryption key" (AA 00047 P10, audit round 2 R2-3): the account's key on Midnight is no
  // longer this browser's, while this wallet is still its one device. AA 00047 P11 (R3-9): explained in
  // plain words before Phantom opens (`RestoreKeyDialog`); only its "Continue to Phantom" asks the wallet.
  const [restoreAsked, setRestoreAsked] = useState(false);
  const restore = () =>
    run('restore-enc-key', async (e) => {
      if (!account) return;
      const r = await restoreEncryptionKey(e, account.address);
      await reconcileFromChain(e, account.address).catch(() => undefined);
      accountCheck.reload();
      setMessage({
        kind: 'ok',
        text: `Your encryption key is restored (tx ${short(r.txId)}): Midnight shows this browser's key on your account again.`,
      });
    });

  const lede =
    'Your tokens on Midnight, controlled by your Phantom wallet. Balances come from the coins this browser keeps, checked against your account’s inbox on Midnight.';

  if (wallet.status !== 'connected' || !scope) {
    return (
      <section data-testid="section-account">
        <PageHead eyebrow="Your holdings" title="Portfolio" lede={lede} />
        <EmptyState
          icon="wallet"
          title="Connect your wallet to see your portfolio"
          action={
            connect ? (
              <Button data-testid="account-connect-cta" onClick={connect}>
                <Icon name="wallet" /> Connect Phantom
              </Button>
            ) : undefined
          }
        >
          <span data-testid="account-connect">
            {wallet.supported
              ? 'Connect your Solana wallet to see your account. It only signs messages: it needs no SOL, and the market pays every Midnight fee.'
              : 'Accounts controlled by a Solana wallet (Phantom) are coming to this site. Until then, browse the order books on Markets.'}
          </span>
        </EmptyState>
      </section>
    );
  }

  const registering = pendingJobs.find((j) => j.job.action === 'register' && j.account === null);
  const unsecured = unsecuredCoins(coins);
  // R2-5 / R2-6: changes the chain does not show yet, and inbox notes it does not confirm (counted only).
  const waiting = pendingChanges(coins);
  const unconfirmed = unconfirmedNotes(coins).length;
  const coinCount = shownCoins.filter((c) => !c.spent && confirmedOnChain(c)).length;

  return (
    <section data-testid="section-account">
      <PageHead
        eyebrow="Your holdings"
        title="Portfolio"
        lede={lede}
        actions={
          account ? (
            <Button
              variant="secondary"
              data-testid="refresh-balances"
              disabled={syncing || !!busy}
              onClick={() => void sync()}
            >
              {syncing ? 'Refreshing…' : 'Refresh balances'}
            </Button>
          ) : undefined
        }
      />
      {message && (
        <Toast
          tone={message.kind === 'error' ? 'error' : 'success'}
          onClose={dismiss}
          timerKey={message.text}
          data-testid="accounts-message"
        >
          {message.text}
        </Toast>
      )}

      <div className="accounts-grid">
        <div className="area-stmt stack-gap">
          {account && (
            <Panel data-testid="passport-section" aria-label="Your tokens">
              <div className="balance-hero">
                <div className="who">
                  <Avatar seed={wallet.address ?? account.address} size="lg" />
                  <div>
                    <p className="who-name">Your tokens</p>
                    <p className="xsmall muted">
                      {coinCount} {coinCount === 1 ? 'coin' : 'coins'} · private and public balances
                    </p>
                  </div>
                </div>
              </div>
              {!hasSecret && (
                <Notice tone="danger" role="alert" className="panel-intro" data-testid="account-not-found">
                  This browser does not hold this account&apos;s key. Import your backup file on{' '}
                  <a href="#local">Your data</a>.
                </Notice>
              )}
              {hasSecret && (
                <AccountCheckNotice
                  check={accountCheck}
                  restore={
                    keyRestorable(accountCheck) ? (
                      <Button
                        size="small"
                        className="gap-top"
                        data-testid="restore-key"
                        disabled={!!busy || !!spendingPaused}
                        onClick={() => setRestoreAsked(true)}
                      >
                        {busy === 'restore-enc-key' ? 'Restoring…' : 'Restore my encryption key'}
                      </Button>
                    ) : undefined
                  }
                />
              )}
              {hasSecret && secret && (
                <RestoreKeyDialog
                  open={restoreAsked}
                  browserKey={secret.encPublicKey}
                  onCancel={() => setRestoreAsked(false)}
                  onContinue={() => {
                    setRestoreAsked(false);
                    void restore();
                  }}
                />
              )}
              <div data-testid="account" data-account={account.address}>
                <PassportHoldings coins={shownCoins} tokens={tokens} unshielded={unshielded} />
                {!unshieldedRead.served && (
                  <p className="table-note" data-testid="unshielded-not-served">
                    This market does not report public (unshielded) balances yet.
                  </p>
                )}
                <p className="table-note">
                  Each trade or withdrawal pays from one coin, so the most you can use in one go can be less than your
                  balance.
                </p>
                <p className="account-number">
                  Your Night Market account{' '}
                  <span className="mono break" data-testid="account-address">
                    {account.address}
                  </span>
                  <br />
                  <span className="xsmall muted">
                    Controlled by your Solana wallet {shortSolanaAddress(solanaAddressOf(account.device))}
                  </span>
                </p>
              </div>
            </Panel>
          )}
          {account && hasSecret && (
            <Panel title="Withdraw to a Midnight wallet" data-testid="withdraw-section">
              <Field label="From">
                <Segmented<'shielded' | 'unshielded'>
                  label="From"
                  options={[
                    { value: 'shielded', label: 'Private tokens', testId: 'withdraw-kind-shielded' },
                    { value: 'unshielded', label: 'Public tokens', testId: 'withdraw-kind-unshielded' },
                  ]}
                  value={withdrawKind}
                  onChange={setWithdrawKind}
                />
              </Field>
              {withdrawKind === 'shielded' && exitOffer && (
                <WholeCoinExit
                  offer={exitOffer}
                  coins={coins}
                  tokens={tokens}
                  busy={!!busy}
                  onWithdraw={(c, a, r) => void send(c, a, r)}
                  onDismiss={() => setExitOffer(null)}
                />
              )}
              {withdrawKind === 'shielded' ? (
                <SendForm
                  coins={shownCoins}
                  tokens={tokens}
                  network={network.name}
                  onSend={(c, a, r) => void send(c, a, r)}
                  busy={!!busy}
                />
              ) : (
                <UnshieldedWithdrawForm
                  balances={unshielded}
                  tokens={tokens}
                  onSend={(c, a, r, b) => void sendUnshielded(c, a, r, b)}
                  busy={!!busy}
                />
              )}
            </Panel>
          )}
          {account && hasSecret && bridging && (
            <BridgeIn
              network={network.name}
              account={account.address}
              accountCheck={
                accountCheck.status === 'ok'
                  ? 'ok'
                  : accountCheck.status === 'failed' || accountCheck.status === 'error'
                    ? 'failed'
                    : 'pending'
              }
              pageCoins={bridgePageCoins}
              busy={!!busy}
            />
          )}
          {!account && (
            <Card title="Open your free account" data-testid="no-account">
              <ul className="onboarding">
                <li>
                  <strong>One approval in Phantom</strong>
                  It proves you own this wallet. It moves no funds and costs nothing.
                </li>
                <li>
                  <strong>The market does the rest</strong>
                  It creates your account on Midnight and pays every fee. You need no SOL and no Midnight wallet.
                </li>
                <li>
                  <strong>About a minute</strong>
                  Then grab the free demo pack and start trading.
                </li>
              </ul>
              {storageStatus !== 'ok' && (
                <Notice tone="danger" className="panel-intro" data-testid="open-account-storage">
                  Not here: {storageText(storageStatus).title} Your account&apos;s secret would have nowhere to live.
                </Notice>
              )}
              {spendingPaused && (
                <Notice tone="warning" className="panel-intro" data-testid="open-account-paused">
                  Not now: {spendingPaused}
                </Notice>
              )}
              <Button
                className="btn-block btn-lg"
                data-testid="open-account"
                disabled={!!busy || !store || store.readOnly || !!spendingPaused}
                onClick={() => void open()}
              >
                {registering || busy === 'register' ? 'Opening your account…' : 'Open account'}
              </Button>
              <p className="table-note">
                Opened one on another computer or browser? <a href="#local">Import your data</a> to use it here instead:
                opening a new account creates a second, separate account.
              </p>
            </Card>
          )}
        </div>

        <div className="area-side stack-gap">
          {job && <JobTracker job={job} />}

          {account && <DemoTokens network={network} relayUrl={relayUrl} />}

          {account && (
            <Panel tone="quiet" as="aside" title="Pending" data-testid="pending-box">
              <p className="small muted">Not in your balances yet, or waiting for you.</p>
              {unsecured.length === 0 && waiting.length === 0 && unconfirmed === 0 && historyGap === null && !job ? (
                <p className="pending-item small muted">Nothing pending.</p>
              ) : null}
              {waiting.length > 0 && (
                <div data-testid="pending-changes">
                  {waiting.map((c) => (
                    <PendingItem
                      key={c.commitment}
                      data-testid="pending-change"
                      what={
                        <>
                          {formatUnits(BigInt(c.value), tokens?.byColour(c.color)?.decimals ?? 0, {
                            minFractionDigits: 2,
                            grouping: true,
                          })}{' '}
                          {tokens?.byColour(c.color)?.symbol ?? short(c.color)}
                        </>
                      }
                      state="Change of a withdrawal, not on Midnight yet."
                      meta="Not in your balances or usable until Midnight shows it. Kept in this browser and checked on every refresh."
                    />
                  ))}
                </div>
              )}
              {historyGap !== null && (
                <p className="pending-item small muted" data-testid="history-incomplete">
                  This page could not read your account&apos;s whole history from Midnight ({historyGap}). Coins it
                  could not confirm are not counted, and it does not say how an offer ended until it can. It tries again
                  on every refresh.
                </p>
              )}
              {unconfirmed > 0 && (
                <p className="pending-item small muted" data-testid="unconfirmed-notes" data-count={unconfirmed}>
                  {unconfirmed === 1 ? 'One note' : `${unconfirmed} notes`} in your account&apos;s inbox{' '}
                  {unconfirmed === 1 ? 'describes a coin' : 'describe coins'} Midnight does not show. Not counted in
                  your balances.
                </p>
              )}
              {unsecured.length > 0 && (
                <div data-testid="pending-items">
                  {unsecured.map((c) => (
                    <PendingItem
                      key={c.commitment}
                      data-testid="unsecured-coin"
                      what={
                        <>
                          {formatUnits(BigInt(c.value), tokens?.byColour(c.color)?.decimals ?? 0, {
                            minFractionDigits: 2,
                            grouping: true,
                          })}{' '}
                          {tokens?.byColour(c.color)?.symbol ?? short(c.color)}
                        </>
                      }
                      state="Change not saved in your inbox yet."
                      meta="Save it so a backup can always restore it from Midnight. One approval."
                    >
                      <Button
                        variant="secondary"
                        size="small"
                        disabled={!!busy}
                        onClick={() => void secure(c)}
                        data-testid="secure-change"
                      >
                        Save it now
                      </Button>
                    </PendingItem>
                  ))}
                </div>
              )}
            </Panel>
          )}

          {!account && (
            <Panel tone="quiet" as="aside" title="How it works">
              <ul className="onboarding">
                <li>
                  <strong>Your keys stay in Phantom</strong>
                  Phantom only signs short messages you can read.{' '}
                  {bridging
                    ? 'It signs a Solana transaction only when you bridge tokens in, after the page shows you what it does.'
                    : 'Night Market never sends a Solana transaction.'}
                </li>
                <li>
                  <strong>Private by default</strong>
                  Your tokens live in your own account on Midnight, a privacy-first chain.
                </li>
                <li>
                  <strong>Your data stays here</strong>
                  Your account&apos;s records live in this browser. Back them up on Your data.
                </li>
              </ul>
            </Panel>
          )}
        </div>
      </div>
    </section>
  );
}
