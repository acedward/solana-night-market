// AA 00060 P6.2 / P6.5 (spec US2): "Bridge out to Solana" on the Portfolio page, for every bridged token
// the account holds. Before anything is asked, the panel says what happens: the wallet signs the
// landing-key text TWICE (the same text), then approves ONE withdrawal; the market proves and pays the
// rest. It then runs derive → tx1 → the lock, writing the record before each step, and follows the
// release on Solana. Open transfers (a reload, an interruption) can be finished or returned to the
// account; "Find my transfers" finds them from the chain alone. The landing key's master stays in this
// tab's memory until "Forget", a disconnect, or leaving the page.

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';

import {
  chooseCoin,
  formatUnits,
  holdingsByColour,
  parseUnits,
  type NetworkProfile,
  type StoredCoin,
} from '@nightmarket/core';
import type { BridgeEntry, LandingMaster } from '@nightmarket/core/bridge';

import { indexerWsUrlOf } from '../../chain/indexer.js';
import { Button, Field, Notice, Panel, Select, UnitInput } from '../../design/index.js';
import type { OperationEnv } from '../../passport/operations.js';
import { useStore } from '../../store/StoreContext.js';
import { useWallet } from '../../wallet/WalletContext.js';
import { useBridges } from '../BridgeContext.js';
import { SolanaRpc } from '../solana-rpc.js';
import {
  adoptTransfer,
  finishLock,
  findTransfers,
  transfersToAdopt,
  followBridgeOut,
  landingMasterFor,
  returnToAccount,
  startBridgeOut,
  type BridgeOutContext,
} from './operations.js';
import { isFinalOut, putBridgeOut, readBridgeOuts, type BridgeOutRecord } from './records.js';

/** How often a lock is followed until it arrives on Solana (ms). */
export const BRIDGE_OUT_POLL_MS = 6_000;

const STATE_TEXT: Record<BridgeOutRecord['state'], string> = {
  'tx1-signing': 'Waiting for your approval',
  'tx1-sent': 'Sent to your landing key',
  landed: 'At your landing key',
  'tx2-sent': 'Locking',
  locked: 'Locked; on its way to Solana',
  arrived: 'In your wallet on Solana',
  returning: 'Returning to your account',
  returned: 'Back in your account',
  failed: 'Stopped',
};

const errorText = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong.');

export function BridgeOut({
  network,
  account,
  accountChecked,
  coins,
  env,
  busy,
}: {
  network: NetworkProfile;
  account: string;
  accountChecked: boolean;
  /** The account's coins (the page's own decode). */
  coins: readonly StoredCoin[];
  env: () => OperationEnv | null;
  busy: boolean;
}) {
  const bridges = useBridges();
  const wallet = useWallet();
  const { store, revision } = useStore();
  const ready = bridges.state === 'ready' ? bridges : null;
  const owner = wallet.status === 'connected' ? wallet.deviceKey : null;
  const scope = useMemo(() => (owner ? { network: network.name, owner } : null), [owner, network.name]);
  const records = useMemo(
    () => (store && scope ? readBridgeOuts(store, scope, account) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store, scope, account, revision],
  );
  const held = useMemo(() => holdingsByColour(coins), [coins]);
  const entries = useMemo(
    () => (ready?.registry.entries ?? []).filter((e) => (held.find((h) => h.color === e.colour)?.largest ?? 0n) > 0n),
    [ready, held],
  );
  const [colour, setColour] = useState('');
  const [amount, setAmount] = useState('');
  const [asking, setAsking] = useState<{ entry: BridgeEntry; raw: bigint } | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  /** P12.2 (FR-021): what the customer should know after the flow (the change not saved yet). */
  const [note, setNote] = useState<string | null>(null);
  const masterRef = useRef<LandingMaster | null>(null);
  const [hasMaster, setHasMaster] = useState(false);
  const chosen = entries.find((e) => e.colour === colour) ?? entries[0] ?? null;

  // The master never outlives the wallet connection or this page.
  useEffect(
    () => () => {
      masterRef.current?.wipe();
      masterRef.current = null;
    },
    [owner],
  );

  const ctx = useCallback((): BridgeOutContext | null => {
    const e = env();
    if (!e || !ready || !wallet.address || !owner) return null;
    return {
      env: e,
      network: network.name,
      networkId: network.midnightNetworkId,
      indexerUrl: network.midnight.indexerUrl,
      indexerWsUrl: indexerWsUrlOf(network.midnight),
      origin: window.location.origin,
      solanaGenesisHash: ready.registry.solanaGenesisHash,
      wallet: wallet.address,
      deviceKey: owner,
      rpc: new SolanaRpc(ready.solana.rpcUrl),
      onProgress: setProgress,
      onNote: setNote,
    };
  }, [env, ready, wallet.address, owner, network]);

  const master = async (c: BridgeOutContext): Promise<LandingMaster> => {
    if (masterRef.current?.live) return masterRef.current;
    setProgress('Your wallet asks you twice to sign the landing-key text (the same text both times)');
    masterRef.current = await landingMasterFor(c, account);
    setHasMaster(true);
    return masterRef.current;
  };

  const run = async (label: string, fn: (c: BridgeOutContext) => Promise<string | void>) => {
    const c = ctx();
    if (!c) return;
    setError(null);
    setOk(null);
    setNote(null);
    setWorking(label);
    try {
      const msg = await fn(c);
      if (msg) setOk(msg);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setWorking(null);
      setProgress(null);
    }
  };

  // Follow every lock until the bridge releases it on Solana (also after a reload).
  const following = records
    .filter((r) => r.state === 'locked')
    .map((r) => r.authNonce)
    .join(',');
  useEffect(() => {
    if (!following || !store || !scope || !ready) return;
    let live = true;
    const rpc = new SolanaRpc(ready.solana.rpcUrl);
    const step = async () => {
      for (const r of readBridgeOuts(store, scope, account).filter((x) => x.state === 'locked')) {
        const next = await followBridgeOut({ rpc }, r).catch(() => r);
        if (live && (next.state !== r.state || next.progress !== r.progress)) putBridgeOut(store, scope, account, next);
      }
    };
    void step();
    const t = setInterval(() => void step(), BRIDGE_OUT_POLL_MS);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [following, store, scope, account, ready]);

  if (!ready) return null;

  const review = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setOk(null);
    if (!chosen) return;
    let raw: bigint;
    try {
      raw = parseUnits(amount, chosen.decimals);
    } catch (err) {
      setError(errorText(err));
      return;
    }
    if (raw <= 0n) return setError('Enter an amount above zero.');
    const largest = held.find((h) => h.color === chosen.colour)?.largest ?? 0n;
    if (raw > largest) {
      return setError(
        `One bridge-out pays from one coin: the most you can send now is ${formatUnits(largest, chosen.decimals)} ${chosen.symbol}.`,
      );
    }
    setAsking({ entry: chosen, raw });
  };

  const go = () => {
    const a = asking;
    setAsking(null);
    if (!a) return;
    void run('bridge-out', async (c) => {
      const m = await master(c);
      const coin = chooseCoin(coins, a.entry.colour, a.raw);
      setProgress('Approve the withdrawal to your landing key in your wallet');
      const r = await startBridgeOut(c, m, { account, entry: a.entry, amount: a.raw, coin });
      setAmount('');
      const done = await finishLock(c, m, account, r);
      return `Locked: ${formatUnits(BigInt(done.amount), a.entry.decimals)} ${done.symbol} are on their way to your wallet on Solana.`;
    });
  };

  const entryOf = (r: BridgeOutRecord) => ready.registry.byColour(r.colour);
  /** P12.2 (FR-021): whether the coin this Bridge out spends is larger than the amount (it leaves change). */
  const leavesChange = (a: { entry: BridgeEntry; raw: bigint }): boolean => {
    try {
      return BigInt(chooseCoin(coins, a.entry.colour, a.raw).value) > a.raw;
    } catch {
      return false;
    }
  };
  const open = records.filter((r) => !isFinalOut(r) && r.state !== 'locked');

  return (
    <Panel title="Bridge out to Solana" data-testid="bridge-out-section">
      <form onSubmit={review}>
        <p className="panel-intro small muted">
          Send a bridged token back to its SPL form in your Solana wallet. Your wallet signs a landing-key text twice
          and approves one withdrawal, plus one more approval to save the change when only part of a coin goes out; the
          market pays every Midnight fee.
        </p>
        {!accountChecked && (
          <Notice tone="warning" role="status" className="panel-intro" data-testid="bridge-out-waiting">
            Bridge out waits until this page has checked your account on Midnight.
          </Notice>
        )}
        {entries.length === 0 ? (
          <p className="small muted" data-testid="bridge-out-none">
            Your account holds no bridged token.
          </p>
        ) : (
          <div className="form-grid">
            <Field label="Token" htmlFor="bridge-out-token">
              <Select
                id="bridge-out-token"
                value={chosen?.colour ?? ''}
                onChange={(e) => setColour(e.target.value)}
                data-testid="bridge-out-token"
              >
                {entries.map((e) => (
                  <option key={e.colour} value={e.colour}>
                    {e.symbol}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Amount" htmlFor="bridge-out-amount">
              <UnitInput
                id="bridge-out-amount"
                unit={chosen?.symbol ?? ''}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                inputMode="decimal"
                autoComplete="off"
                data-testid="bridge-out-amount"
              />
            </Field>
          </div>
        )}
        {progress && (
          <p className="small" role="status" data-testid="bridge-out-progress">
            {progress}
          </p>
        )}
        {error && (
          <Notice tone="danger" role="alert" className="panel-intro" data-testid="bridge-out-error">
            {error}
          </Notice>
        )}
        {ok && (
          <Notice tone="success" role="status" className="panel-intro" data-testid="bridge-out-ok">
            {ok}
          </Notice>
        )}
        {note && (
          <Notice tone="warning" role="status" className="panel-intro" data-testid="bridge-out-note">
            {note}
          </Notice>
        )}
        {entries.length > 0 && !asking && (
          <Button
            type="submit"
            className="btn-block"
            disabled={busy || working !== null || !accountChecked}
            data-testid="bridge-out-review"
          >
            {working === 'bridge-out' ? 'Bridging out…' : 'Review'}
          </Button>
        )}
      </form>
      {asking && (
        <div data-testid="bridge-out-confirm">
          <ul className="small">
            <li>
              <strong>Two signatures of the same landing-key text.</strong> They create the private key your tokens land
              on for a moment. The key is permanent for this site, network and wallet: anyone who gets this signature
              can take the tokens in transit now and in every future Bridge out from this wallet on this site. Sign it
              only on this site.
            </li>
            <li>
              <strong>One approval</strong> of a withdrawal of {formatUnits(asking.raw, asking.entry.decimals)}{' '}
              {asking.entry.symbol} to that key.
            </li>
            {leavesChange(asking) && (
              <li data-testid="bridge-out-confirm-change">
                <strong>One more approval</strong> to save the change of that coin in your inbox, as every withdrawal
                does, so your other browsers and a backup can always find it.
              </li>
            )}
            <li>
              Then the market locks it in the bridge for your wallet {wallet.address}. It sees this one transfer&apos;s
              key while it proves the lock (a known limitation).
            </li>
          </ul>
          <div className="row">
            <Button variant="secondary" onClick={() => setAsking(null)} data-testid="bridge-out-cancel">
              Cancel
            </Button>
            <Button variant="primary" onClick={go} data-testid="bridge-out-send">
              Bridge out
            </Button>
          </div>
        </div>
      )}
      {records.length > 0 && (
        <ul className="small" data-testid="bridge-out-records">
          {records.map((r) => {
            const e = entryOf(r);
            return (
              <li key={r.authNonce} data-testid="bridge-out-record" data-state={r.state}>
                {formatUnits(BigInt(r.amount), e?.decimals ?? 0)} {r.symbol}: <strong>{STATE_TEXT[r.state]}</strong>
                {r.progress && !isFinalOut(r) ? ` · ${r.progress}` : ''}
                {open.includes(r) && e && r.entitlement && (
                  <span className="row gap-top">
                    <Button
                      size="small"
                      disabled={working !== null}
                      onClick={() =>
                        void run('finish', async (c) => {
                          await finishLock(c, await master(c), account, r);
                          return 'Locked: on its way to your wallet on Solana.';
                        })
                      }
                      data-testid="bridge-out-finish"
                    >
                      Finish
                    </Button>
                    <Button
                      size="small"
                      variant="secondary"
                      disabled={working !== null}
                      onClick={() =>
                        void run('return', async (c) => {
                          await returnToAccount(c, await master(c), account, r);
                          return 'Back in your account.';
                        })
                      }
                      data-testid="bridge-out-return"
                    >
                      Return to my account
                    </Button>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <div className="row gap-top">
        <Button
          variant="secondary"
          size="small"
          disabled={working !== null || !accountChecked}
          onClick={() =>
            void run('find', async (c) => {
              const m = await master(c);
              const found = await findTransfers(c, m, account);
              let adopted = 0;
              for (const f of transfersToAdopt(found, readBridgeOuts(c.env.store, c.env.scope, account))) {
                const e = ready.registry.byColour(f.spentCoin.color);
                if (!e) continue;
                await adoptTransfer(c, m, account, f, e);
                adopted++;
              }
              const openCount = found.filter((x) => x.open).length;
              return openCount === 0
                ? 'No open transfer: every bridge-out of this account has finished.'
                : `Found ${openCount} open transfer${openCount === 1 ? '' : 's'}${adopted ? ` (${adopted} new)` : ''}: finish or return ${openCount === 1 ? 'it' : 'them'} below.`;
            })
          }
          data-testid="bridge-out-find"
        >
          {working === 'find' ? 'Searching…' : 'Find my transfers'}
        </Button>
        {hasMaster && (
          <Button
            variant="secondary"
            size="small"
            onClick={() => {
              masterRef.current?.wipe();
              masterRef.current = null;
              setHasMaster(false);
              setOk('The landing key is forgotten in this tab.');
            }}
            data-testid="bridge-out-forget"
          >
            Forget the landing key
          </Button>
        )}
      </div>
    </Panel>
  );
}
