// The Account section (plan L-ACC, carried over from MN Bank): the connected Solana wallet's
// Passport account on Midnight. Open one (one signature, with the relay's stages and queue
// position), or, when this browser does not hold it, the way back through Import. Balances come
// from the coins this browser keeps, rebuilt from chain data by an inbox walk decrypted here. Each
// token is shown in its own units: nothing is totalled in a "home" currency (no token is special).
//
// The trading itself is on Trade; this page is the holdings side panel of the market, the pending
// items, the job tracker and the "Open your account" card. Signing goes through the Solana wallet
// (lane B2); until a wallet can connect, the page says so.

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';

import {
  formatUnits,
  holdingsByColour,
  parseUnits,
  shortSolanaAddress,
  solanaAddressOf,
  type JobView,
  type NetworkProfile,
  type StoredCoin,
  type TokenRegistry,
} from '@nightmarket/core';

import {
  AssetCell,
  Button,
  Card,
  Cell,
  EmptyState,
  Field,
  Hash,
  Notice,
  PageHead,
  Panel,
  PendingItem,
  Select,
  StageTracker,
  StatementTable,
  StatusPill,
  Sub,
  TextInput,
  UnitInput,
  type Column,
  type TrackerStage,
} from '../design/index.js';
import { useAssetFilter } from '../assets/AssetFilterContext.js';
import { useTokenRegistry } from '../market/MarketContext.js';
import {
  openAccount,
  recipientOf,
  secureChange,
  syncAccount,
  unsecuredCoins,
  withdrawToWallet,
  type OperationEnv,
} from '../passport/operations.js';
import { findAccount, listJobs, readCoins, readSecret } from '../passport/records.js';
import { useRelayStatus } from '../relay/RelayStatus.js';
import { RelayClient } from '../relay/client.js';
import { storageText } from '../store/messages.js';
import { useStore } from '../store/StoreContext.js';
import { confirmCancelsOffer as confirmOffer, markLiveOffersCancelled } from '../trade/operations.js';
import { useWallet } from '../wallet/WalletContext.js';

const short = (s: string, head = 8, tail = 6) =>
  s.length <= head + tail + 1 ? s : `${s.slice(0, head)}…${s.slice(-tail)}`;

const STAGE_TEXT: Record<string, string> = {
  queued: 'Waiting in line',
  running: 'Started',
  deploying: 'Creating your account',
  'wave-1-submitted': 'Account created (step 1 of 2)',
  'wave-2-submitted': 'Account features added (step 2 of 2)',
  deployed: 'Account created',
  activating: 'Activating your wallet as the account key',
  'activation-submitted': 'Activation sent',
  activated: 'Activated',
  proving: 'Preparing the transaction proof',
  submitted: 'Sent to the network',
  succeeded: 'Done',
  failed: 'Failed',
};

const JOB_TITLE: Record<string, string> = {
  register: 'Opening your account',
  withdraw: 'Sending from your account',
  'append-inbox': 'Recording the change in your inbox',
};

/** "14:06" UTC from the relay's Unix seconds. */
const clock = (unixSeconds: number) => new Date(unixSeconds * 1000).toISOString().slice(11, 16);

const HOLDING_COLUMNS: Column[] = [{ label: 'Token' }, { label: 'Quantity', align: 'right' }];

function JobTracker({ job }: { job: JobView }) {
  const last = job.stages.length - 1;
  const stages: TrackerStage[] = job.stages.map((s, i) => ({
    key: `${s.stage}-${i}`,
    title: STAGE_TEXT[s.stage] ?? s.stage,
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
        <strong>{STAGE_TEXT[job.stage] ?? job.stage}</strong>
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

function PassportHoldings({ coins, tokens }: { coins: StoredCoin[]; tokens: TokenRegistry | null }) {
  // Listed in the market's token order (the registry's); unknown colours last.
  const order = (colour: string) => {
    const i = tokens?.tokens.findIndex((t) => t.midnightColour === colour) ?? -1;
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  const rows = holdingsByColour(coins)
    .map((h) => ({ h, token: tokens?.byColour(h.color) }))
    .sort((a, b) => order(a.h.color) - order(b.h.color));
  if (rows.length === 0) {
    return (
      <EmptyState data-testid="passport-empty" title="No tokens in this account yet">
        Tokens sent to your account appear here once they land.
      </EmptyState>
    );
  }
  return (
    <StatementTable columns={HOLDING_COLUMNS} caption="Account holdings" data-testid="passport-holdings">
      {rows.map(({ h, token: t }) => {
        const dec = t?.decimals ?? 0;
        return (
          <tr key={h.color} data-testid="passport-row" data-colour={h.color} data-symbol={t?.symbol ?? ''}>
            <AssetCell
              symbol={t?.symbol ?? short(h.color)}
              name={t?.name}
              origin={t ? (t.privacy === 'shielded' ? 'shielded' : 'unshielded') : undefined}
            />
            <Cell label="Quantity" align="right">
              <span className="num-wrap">
                <span className="num" data-testid="passport-amount" data-raw={h.total.toString()}>
                  {formatUnits(h.total, dec, { minFractionDigits: 2, grouping: true })}
                </span>
                <Sub>
                  largest single payment{' '}
                  <span data-testid="passport-largest" data-raw={h.largest.toString()}>
                    {formatUnits(h.largest, dec, { minFractionDigits: 2, grouping: true })}
                  </span>
                </Sub>
              </span>
            </Cell>
          </tr>
        );
      })}
    </StatementTable>
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
          `The largest single payment is ${formatUnits(largest, token?.decimals ?? 0)}: the account pays from one coin at a time.`,
        );
        return;
      }
      recipientOf(recipient, network); // throws a readable message for a bad address
      onSend(chosen, raw, recipient.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Enter an amount.');
    }
  };
  if (held.length === 0) return null;
  return (
    <details className="disclosure" data-testid="send-midnight">
      <summary>Send to a Midnight wallet (advanced)</summary>
      <form className="disclosure-body" onSubmit={submit}>
        <p className="panel-intro small">Pays a shielded Midnight wallet straight from your account.</p>
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
            hint={
              <span data-testid="send-largest">
                Largest single payment: {formatUnits(largest, token?.decimals ?? 0)}
              </span>
            }
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
        <Field label="Recipient" htmlFor="send-recipient" hint="A shielded wallet address, mn_shield-addr_…">
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
          You sign twice to send: once for the payment, and once to confirm the recipient&apos;s address to the market.
          The change stays in your account; the market then asks for one more signature to record it in your
          account&apos;s inbox, so it can be restored from the chain.
        </p>
        {error && (
          <Notice tone="danger" role="alert" data-testid="send-error" className="panel-intro">
            {error}
          </Notice>
        )}
        <Button type="submit" disabled={busy} data-testid="send-submit">
          Send
        </Button>
      </form>
    </details>
  );
}

export function Accounts({ network, relayUrl }: { network: NetworkProfile; relayUrl: string }) {
  const tokens = useTokenRegistry();
  const { store, revision, status: storageStatus } = useStore();
  const { spendingPaused } = useRelayStatus();
  const wallet = useWallet();
  const relay = useMemo(() => new RelayClient(relayUrl), [relayUrl]);
  const [job, setJob] = useState<JobView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [syncing, setSyncing] = useState(false);

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
  // The holdings and Send list show only the assets the filter shows (plan 00042); what needs the
  // customer's action (an unrecorded change coin, under Pending) shows whatever it is.
  const assets = useAssetFilter();
  const shownCoins = useMemo(() => coins.filter((c) => assets.showsColour(c.color)), [coins, assets]);
  const pendingJobs = useMemo(
    () => (store && scope ? listJobs(store, scope) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store, scope, revision],
  );

  const env = useCallback((): OperationEnv | null => {
    if (!store || !scope || !wallet.signing) return null;
    return { relay, store, scope, signing: wallet.signing, onJob: setJob };
  }, [store, scope, wallet.signing, relay]);

  const sync = useCallback(async () => {
    const e = env();
    if (!e || !account || !hasSecret) return;
    setSyncing(true);
    try {
      await syncAccount(e, account.address);
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

  const run = async (label: string, fn: (e: OperationEnv) => Promise<void>) => {
    const e = env();
    if (!e) return;
    setBusy(label);
    setMessage(null);
    setJob(null);
    try {
      await fn(e);
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

  const send = (color: string, amount: bigint, recipient: string) =>
    run('withdraw', async (e) => {
      if (!account) return;
      if (!confirmCancelsOffer('withdraw')) return;
      const r = await withdrawToWallet(e, account.address, { color, amount, recipient });
      markLiveOffersCancelled(e, account.address);
      setMessage({ kind: 'ok', text: `Sent (tx ${short(r.txId)}). Recording the change in your inbox…` });
      await syncAccount(e, account.address);
      // Q13 default A: file the change's inbox entry right away (a second signature).
      if (r.change) {
        await secureChange(e, account.address, r.change);
        await syncAccount(e, account.address);
        setMessage({ kind: 'ok', text: `Sent (tx ${short(r.txId)}); the change is recorded in your inbox.` });
      }
    });

  const secure = (coin: StoredCoin) =>
    run('append-inbox', async (e) => {
      if (!account) return;
      if (!confirmCancelsOffer('append-inbox')) return;
      await secureChange(e, account.address, coin);
      markLiveOffersCancelled(e, account.address);
      await syncAccount(e, account.address);
      setMessage({ kind: 'ok', text: 'The coin is recorded in your inbox.' });
    });

  const lede =
    'Your account on Midnight, controlled by your Solana wallet. Balances come from the coins this browser keeps, checked against your account’s inbox.';

  if (wallet.status !== 'connected' || !scope) {
    return (
      <section data-testid="section-account">
        <PageHead eyebrow="Your holdings" title="Account" lede={lede} />
        <EmptyState title="Connect your Solana wallet">
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

  return (
    <section data-testid="section-account">
      <PageHead eyebrow="Your holdings" title="Account" lede={lede} />
      {message && (
        <Notice
          tone={message.kind === 'error' ? 'danger' : 'success'}
          role={message.kind === 'error' ? 'alert' : 'status'}
          className="panel-intro"
          data-testid="accounts-message"
        >
          {message.text}
        </Notice>
      )}

      <div className="accounts-grid">
        <div className="area-stmt stack-gap">
          {account && (
            <Panel
              title="Account on Midnight"
              data-testid="passport-section"
              meta={
                <>
                  <span>
                    {shownCoins.filter((c) => !c.spent).length} coin
                    {shownCoins.filter((c) => !c.spent).length === 1 ? '' : 's'}
                  </span>
                  <Button
                    variant="secondary"
                    size="small"
                    data-testid="refresh-balances"
                    disabled={syncing || !!busy}
                    onClick={() => void sync()}
                  >
                    {syncing ? 'Refreshing…' : 'Refresh balances'}
                  </Button>
                </>
              }
            >
              {!hasSecret && (
                <Notice tone="danger" role="alert" className="panel-intro" data-testid="account-not-found">
                  This browser does not hold this account&apos;s key. Import your export on{' '}
                  <a href="#local">Local data</a>.
                </Notice>
              )}
              <div data-testid="account" data-account={account.address}>
                <PassportHoldings coins={shownCoins} tokens={tokens} />
                <p className="table-note">
                  One payment can use only one coin, so the largest single payment can be less than the balance.
                </p>
                <p className="account-number">
                  Account number{' '}
                  <span className="mono break" data-testid="account-address">
                    {account.address}
                  </span>
                  <br />
                  <span className="xsmall muted">
                    Key: your Solana wallet {shortSolanaAddress(solanaAddressOf(account.device))}
                  </span>
                </p>
                <SendForm
                  coins={shownCoins}
                  tokens={tokens}
                  network={network.name}
                  onSend={(c, a, r) => void send(c, a, r)}
                  busy={!!busy}
                />
              </div>
            </Panel>
          )}
        </div>

        <div className="area-side stack-gap">
          {account && (
            <Panel tone="quiet" as="aside" title="Pending" data-testid="pending-box">
              <p className="small muted">Not yet in the balances above, or waiting for you.</p>
              {unsecured.length === 0 && !job ? <p className="pending-item small muted">Nothing pending.</p> : null}
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
                      state="Change not yet recorded in your inbox."
                      meta="Record it so an export can always restore it from the chain. One signature."
                    >
                      <Button
                        variant="secondary"
                        size="small"
                        disabled={!!busy}
                        onClick={() => void secure(c)}
                        data-testid="secure-change"
                      >
                        Record it now
                      </Button>
                    </PendingItem>
                  ))}
                </div>
              )}
            </Panel>
          )}

          {job && <JobTracker job={job} />}

          {!account && (
            <Card title="Open your account" data-testid="no-account">
              <p className="panel-intro">
                This wallet has no Night Market account in this browser. Your Solana wallet signs once to open one; the
                market pays every Midnight fee, and you need no Midnight wallet and no SOL.
              </p>
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
                data-testid="open-account"
                disabled={!!busy || !store || store.readOnly || !!spendingPaused}
                onClick={() => void open()}
              >
                {registering || busy === 'register' ? 'Opening your account…' : 'Open account'}
              </Button>
              <p className="table-note">
                Opened one on another computer or browser? <a href="#local">Import your data on Local data</a> to use it
                here instead: opening a new account creates a second, separate account.
              </p>
            </Card>
          )}
        </div>
      </div>
    </section>
  );
}
