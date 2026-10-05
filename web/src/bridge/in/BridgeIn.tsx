// AA 00060 P7.3 (spec US1): "Bridge in from Solana" on the Portfolio page, for every token the site's
// journey registry lists. The customer picks a token and an amount; the page runs every check of
// FR-002 (./operations.ts) and shows the transaction's facts (the program, the mint, the amount in base
// units and with the site's decimals, the token account it leaves, and the Midnight account it goes to)
// BEFORE the wallet is asked; then one Solana transaction; then its record, followed until the page's
// own decode shows the tokens (or the bridge says it cannot deliver, and that the SPL stays locked).

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';

import { formatUnits, parseUnits, type StoredCoin } from '@nightmarket/core';
import type { BridgeEntry } from '@nightmarket/core/bridge';

import { Button, Field, Notice, Panel, Select, UnitInput } from '../../design/index.js';
import { useStore } from '../../store/StoreContext.js';
import { useWallet } from '../../wallet/WalletContext.js';
import { useBridges } from '../BridgeContext.js';
import { SolanaRpc } from '../solana-rpc.js';
import {
  BridgeInRefused,
  followBridgeIn,
  isFinal,
  pageBalance,
  precheckBridgeIn,
  sendBridgeIn,
  type BridgeInContext,
  type Precheck,
} from './operations.js';
import { putBridgeIn, readBridgeIns, type BridgeInRecord } from './records.js';

/** How often an open Bridge-in record is followed (ms). */
export const BRIDGE_IN_POLL_MS = 4_000;

const STATE_TEXT: Record<BridgeInRecord['state'], string> = {
  sent: 'Sent to Solana',
  locked: 'Locked on Solana',
  bridging: 'Bridging',
  completed: 'In your account',
  undeliverable: 'Not delivered',
  failed: 'Failed on Solana',
};

const errorText = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong.');
/** The same record but for when it was last checked. */
const sameRecord = (a: BridgeInRecord, b: BridgeInRecord) =>
  JSON.stringify({ ...a, checkedAt: 0 }) === JSON.stringify({ ...b, checkedAt: 0 });

export function BridgeIn({
  network,
  account,
  accountCheck,
  pageCoins,
  busy,
}: {
  network: string;
  account: string;
  accountCheck: BridgeInContext['accountCheck'];
  /** The account's coins by the page's own decode (a fresh walk). */
  pageCoins: () => Promise<readonly StoredCoin[]>;
  busy: boolean;
}) {
  const bridges = useBridges();
  const wallet = useWallet();
  const { store, revision } = useStore();
  const owner = wallet.status === 'connected' ? wallet.deviceKey : null;
  const scope = useMemo(() => (owner ? { network, owner } : null), [owner, network]);
  const ready = bridges.state === 'ready' ? bridges : null;
  const rpc = useMemo(() => (ready ? new SolanaRpc(ready.solana.rpcUrl) : null), [ready]);
  const entries = ready?.registry.entries ?? [];
  const [colour, setColour] = useState('');
  const [amount, setAmount] = useState('');
  const [check, setCheck] = useState<{ entry: BridgeEntry; raw: bigint; pre: Precheck } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [working, setWorking] = useState<'check' | 'send' | null>(null);
  const records = useMemo(
    () => (store && scope ? readBridgeIns(store, scope, account) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store, scope, account, revision],
  );
  const chosen = entries.find((e) => e.colour === colour) ?? entries[0] ?? null;

  const ctx = useCallback((): BridgeInContext | null => {
    if (!rpc || !ready || !wallet.address) return null;
    return {
      rpc,
      chain: ready.solana.cluster,
      depositor: wallet.address,
      account,
      accountCheck,
      transactions: wallet.transactions,
    };
  }, [rpc, ready, wallet.address, wallet.transactions, account, accountCheck]);

  // Follow every open record (also after a reload): Solana's confirmation, the bridge's progress, the
  // page's own decode. The loop restarts only when the SET of open records changes (each step's own
  // writes, and the walk's coin writes, must not restart it); it reads the latest context through a ref.
  const latest = useRef({ ctx, pageCoins });
  useEffect(() => {
    latest.current = { ctx, pageCoins };
  });
  const openKey = records
    .filter((r) => !isFinal(r))
    .map((r) => r.signature)
    .join(',');
  useEffect(() => {
    if (!openKey || !store || !scope) return;
    let live = true;
    let running = false;
    const step = async () => {
      const c = latest.current.ctx();
      if (running || !c) return;
      running = true;
      try {
        for (const r of readBridgeIns(store, scope, account).filter((x) => !isFinal(x))) {
          if (!live) return;
          const next = await followBridgeIn(r, c, latest.current.pageCoins).catch((e: unknown): BridgeInRecord => ({
            ...r,
            progress: errorText(e).slice(0, 300),
          }));
          if (live && sameRecord(next, r) === false) putBridgeIn(store, scope, account, next);
        }
      } finally {
        running = false;
      }
    };
    void step();
    const t = setInterval(() => void step(), BRIDGE_IN_POLL_MS);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [openKey, store, scope, account]);

  if (bridges.state !== 'ready' || entries.length === 0) return null;

  const runCheck = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setOk(null);
    setCheck(null);
    const c = ctx();
    if (!c || !chosen) return;
    let raw: bigint;
    try {
      raw = parseUnits(amount, chosen.decimals);
    } catch (err) {
      setError(errorText(err));
      return;
    }
    setWorking('check');
    try {
      setCheck({ entry: chosen, raw, pre: await precheckBridgeIn(c, chosen, raw) });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setWorking(null);
    }
  };

  const send = async () => {
    const c = ctx();
    if (!c || !check || !store || !scope) return;
    setError(null);
    setWorking('send');
    try {
      const before = pageBalance(await pageCoins(), check.entry.colour);
      const rec = await sendBridgeIn(c, check.entry, check.raw, before);
      putBridgeIn(store, scope, account, rec);
      setOk(
        `Sent: ${formatUnits(check.raw, check.entry.decimals)} ${check.entry.symbol} are on their way to your account.`,
      );
      setCheck(null);
      setAmount('');
    } catch (err) {
      setError(err instanceof BridgeInRefused ? err.message : `${errorText(err)} Nothing was locked.`);
    } finally {
      setWorking(null);
    }
  };

  const f = check?.pre.facts;
  // A wallet with neither transaction feature keeps every message flow; only Bridge in is off (P5.1).
  const canSign = !!wallet.transactions?.signAndSend || !!wallet.transactions?.sign;
  return (
    <Panel title="Bridge in from Solana" data-testid="bridge-in-section">
      <form onSubmit={(e) => void runCheck(e)}>
        <p className="panel-intro small muted">
          Lock an SPL token in the bridge on Solana; the bridge delivers the same amount to your Night Market account.
          Your wallet asks you to approve one Solana transaction, which costs a small SOL fee.
        </p>
        <div className="form-grid">
          <Field label="Token" htmlFor="bridge-in-token">
            <Select
              id="bridge-in-token"
              value={chosen?.colour ?? ''}
              onChange={(e) => {
                setColour(e.target.value);
                setCheck(null);
              }}
              data-testid="bridge-in-token"
            >
              {entries.map((e) => (
                <option key={e.colour} value={e.colour}>
                  {e.symbol}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Amount" htmlFor="bridge-in-amount">
            <UnitInput
              id="bridge-in-amount"
              unit={chosen?.symbol ?? ''}
              value={amount}
              onChange={(e) => {
                setAmount(e.target.value);
                setCheck(null);
              }}
              inputMode="decimal"
              autoComplete="off"
              data-testid="bridge-in-amount"
            />
          </Field>
        </div>
        {!canSign && (
          <Notice tone="warning" role="status" data-testid="bridge-in-no-transactions" className="panel-intro">
            Your wallet cannot sign Solana transactions here, so Bridge in is unavailable. Your other actions are not
            affected.
          </Notice>
        )}
        {error && (
          <Notice tone="danger" role="alert" data-testid="bridge-in-error" className="panel-intro">
            {error}
          </Notice>
        )}
        {ok && (
          <Notice tone="success" role="status" data-testid="bridge-in-ok" className="panel-intro">
            {ok}
          </Notice>
        )}
        {!check && (
          <Button
            type="submit"
            className="btn-block"
            disabled={busy || working !== null || !canSign}
            data-testid="bridge-in-check"
          >
            {working === 'check' ? 'Checking…' : 'Review'}
          </Button>
        )}
      </form>
      {check && f && (
        <div data-testid="bridge-in-facts">
          <p className="small">Your wallet will be asked to approve exactly this Solana transaction:</p>
          <ul className="small mono">
            <li data-testid="bridge-in-fact-program">Program {f.program}</li>
            <li data-testid="bridge-in-fact-mint">Mint {f.mint}</li>
            <li data-testid="bridge-in-fact-amount">
              Amount {f.amount.toString()} base units ({formatUnits(f.amount, check.entry.decimals)}{' '}
              {check.entry.symbol})
            </li>
            <li data-testid="bridge-in-fact-source">From your token account {f.source}</li>
            <li data-testid="bridge-in-fact-account">To your Night Market account {f.account}</li>
          </ul>
          {check.pre.note && (
            <Notice tone="info" data-testid="bridge-in-note">
              {check.pre.note}
            </Notice>
          )}
          <Button
            className="btn-block"
            variant="primary"
            disabled={busy || working !== null}
            onClick={() => void send()}
            data-testid="bridge-in-send"
          >
            {working === 'send' ? 'Waiting for your wallet…' : 'Bridge in'}
          </Button>
        </div>
      )}
      {records.length > 0 && (
        <ul className="small" data-testid="bridge-in-records">
          {records.map((r) => (
            <li key={r.signature} data-testid="bridge-in-record" data-state={r.state}>
              {formatUnits(BigInt(r.amount), entries.find((e) => e.colour === r.colour)?.decimals ?? 0)} {r.symbol}:{' '}
              <strong>{STATE_TEXT[r.state]}</strong>
              {r.progress && r.state !== 'completed' ? ` · ${r.progress}` : ''}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
