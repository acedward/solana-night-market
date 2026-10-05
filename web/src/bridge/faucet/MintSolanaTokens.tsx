// "Mint Solana tokens" (AA 00060 P13, spec FR-024): the flow of FR-023's Portfolio action 5.
//
//   useSplFaucetOffer(relayUrl, wallet)  whether the market offers it (and why not), for the action's
//                                        enabled/disabled state ("Not available on this market")
//   useSplFaucetSeam(relayUrl)           the Portfolio's `splFaucet` seam (lane 00060-lane-portfolio,
//                                        `SplFaucetSeam` in web/src/account/PortfolioActions.tsx):
//                                        `{ offered, Flow }`, Flow taking `{ account, walletAddress, onDone }`
//   <MintSolanaTokensFlow …/>            the flow inline (a sub-page): what you get, the claim, then the result
//                                        with the transaction signature and the new Solana balance
//   <MintSolanaTokensDialog open …/>     the same flow in a dialog
//   <MintSolanaTokensAction …/>          a self-contained entry (a button that opens the dialog, disabled with
//                                        the reason when not offered), until the Portfolio's action list mounts
//                                        the flow through the seam
//
// The wallet is asked for nothing: the market's faucet key signs and pays. Balances come from the SITE's
// Solana RPC (config.json `solana`), read before and after the claim.

import { useCallback, useEffect, useMemo, useState, type ComponentType, type ReactNode } from 'react';

import { formatUnits, type JobView, type SplFaucetInfo, type SplFaucetResult } from '@nightmarket/core';

import { Button, CopyField, Dialog, Icon, Notice, Panel, shortHex } from '../../design/index.js';
import { RelayClient } from '../../relay/client.js';
import { useWallet } from '../../wallet/WalletContext.js';
import { useBridges } from '../BridgeContext.js';
import { SolanaRpc } from '../solana-rpc.js';
import {
  claimSolanaTokens,
  faucetAmountsText,
  faucetAvailability,
  faucetErrorText,
  faucetOffer,
  faucetTime,
  solanaBalances,
} from './operations.js';

/** The market's faucet offer for `wallet` (the connected one unless given); `reload` reads it again. */
export function useSplFaucetOffer(relayUrl: string, walletAddress?: string | null) {
  const connected = useWallet().address;
  const address = walletAddress === undefined ? connected : walletAddress;
  const relay = useMemo(() => new RelayClient(relayUrl), [relayUrl]);
  const [info, setInfo] = useState<SplFaucetInfo | null | 'loading'>('loading');
  const reload = useCallback(() => {
    // Without a wallet the offer still says whether the market has a faucet (the action's state).
    void faucetOffer(relay, address ?? undefined).then(setInfo, () => setInfo(null));
  }, [relay, address]);
  useEffect(() => {
    const t = setTimeout(reload, 0);
    return () => clearTimeout(t);
  }, [reload]);
  return { info, availability: faucetAvailability(info), reload, relay, wallet: address ?? null };
}

/** The props the Portfolio's seam gives the flow (`SplFaucetSeam['Flow']`). */
export interface SeamFlowProps {
  account: string;
  walletAddress: string | null;
  onDone?: () => void;
}

/** One flow component per relay URL, made once (outside any render), so React keeps its state. */
const seamFlows = new Map<string, ComponentType<SeamFlowProps>>();
function seamFlowFor(relayUrl: string): ComponentType<SeamFlowProps> {
  let flow = seamFlows.get(relayUrl);
  if (!flow) {
    flow = function SeamFlow({ walletAddress, onDone }: SeamFlowProps) {
      return <MintSolanaTokensFlow relayUrl={relayUrl} walletAddress={walletAddress} {...(onDone ? { onDone } : {})} />;
    };
    seamFlows.set(relayUrl, flow);
  }
  return flow;
}

/** The Portfolio's `splFaucet` seam: whether the relay offers the faucet (null while checking), and the flow. */
export function useSplFaucetSeam(relayUrl: string): { offered: boolean | null; Flow: ComponentType<SeamFlowProps> } {
  const { availability } = useSplFaucetOffer(relayUrl);
  return {
    offered: availability.state === 'loading' ? null : availability.state === 'offered',
    Flow: seamFlowFor(relayUrl),
  };
}

const STAGE_WORDS: Record<string, string> = {
  queued: 'Waiting for the market…',
  running: 'Starting…',
  checking: 'Checking the faucet and the tokens on Solana…',
  sending: 'Sending the transaction to Solana…',
  confirming: 'Waiting for Solana to confirm…',
  confirmed: 'Confirmed on Solana.',
};

function amount(raw: bigint | null | undefined, decimals: number): string {
  return raw === null || raw === undefined ? 'unavailable' : formatUnits(raw, decimals, { grouping: true });
}

/** The flow's state: the offer, the balances (read while `active`), the claim. */
function useFaucetFlow(
  relayUrl: string,
  walletAddress: string | null | undefined,
  active: boolean,
  onDone?: () => void,
) {
  const { info, availability, reload, relay, wallet } = useSplFaucetOffer(relayUrl, walletAddress);
  const bridges = useBridges();
  const rpc = useMemo(() => (bridges.state === 'ready' ? new SolanaRpc(bridges.solana.rpcUrl) : null), [bridges]);
  const [balances, setBalances] = useState<Map<string, bigint | null> | null>(null);
  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState<JobView | null>(null);
  const [result, setResult] = useState<SplFaucetResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const tokens = useMemo(() => (info && info !== 'loading' ? info.tokens : []), [info]);

  const readBalances = useCallback(async () => {
    if (!rpc || !wallet || tokens.length === 0) return;
    setBalances(await solanaBalances(rpc, wallet, tokens));
  }, [rpc, wallet, tokens]);

  useEffect(() => {
    if (!active) return;
    const t = setTimeout(reload, 0);
    return () => clearTimeout(t);
  }, [active, reload]);
  useEffect(() => {
    if (!active) return;
    const t = setTimeout(() => void readBalances(), 0);
    return () => clearTimeout(t);
  }, [active, readBalances]);

  const reset = () => {
    setResult(null);
    setError(null);
    setJob(null);
  };

  const claim = async () => {
    if (!wallet) return;
    setBusy(true);
    reset();
    try {
      setResult(await claimSolanaTokens(relay, wallet, setJob));
      onDone?.();
    } catch (e) {
      setError(faucetErrorText(e));
    } finally {
      setBusy(false);
      reload();
      void readBalances();
    }
  };

  // The relay names a claim only while its period runs: a `claimed` one means "not yet".
  const claimed = info && info !== 'loading' ? info.claim : undefined;
  const waiting = !result && claimed?.state === 'claimed';
  const canClaim = availability.state === 'offered' && !!wallet && !busy && !waiting && claimed?.state !== 'pending';
  return {
    info,
    availability,
    wallet,
    rpc,
    balances,
    busy,
    job,
    result,
    error,
    tokens,
    claimed,
    waiting,
    canClaim,
    claim,
    reset,
  };
}

type Flow = ReturnType<typeof useFaucetFlow>;

function ClaimButton({ f }: { f: Flow }) {
  return (
    <Button onClick={() => void f.claim()} disabled={!f.canClaim} data-testid="mint-solana-claim">
      {f.busy ? 'Minting…' : f.tokens.length > 0 ? `Mint ${faucetAmountsText(f.tokens)}` : 'Mint'}
    </Button>
  );
}

function FlowBody({ f }: { f: Flow }): ReactNode {
  const { info, availability, wallet, rpc, balances, busy, job, result, error, tokens, claimed, waiting } = f;
  const balance = (mint: string, decimals: number) =>
    balances ? amount(balances.get(mint), decimals) : rpc ? '…' : 'unavailable';
  return (
    <>
      {!wallet && <p className="small">Connect a Solana wallet first.</p>}
      {availability.state === 'loading' && wallet && (
        <p className="small muted" role="status">
          Checking what the market offers…
        </p>
      )}
      {availability.state === 'not-offered' && (
        <Notice tone="warning" role="status" data-testid="mint-solana-off" data-code={availability.code}>
          Not available on this market. {availability.reason}
        </Notice>
      )}
      {tokens.length > 0 && wallet && (
        <div data-testid="mint-solana-offer">
          <p className="small">
            <strong>What you get:</strong> <span data-testid="mint-solana-amounts">{faucetAmountsText(tokens)}</span>,
            test tokens on Solana, minted to your wallet <span className="mono">{shortHex(wallet, 6, 6)}</span>.
          </p>
          <p className="xsmall muted">
            The market pays the Solana fee and creates your token accounts if you have none. Your wallet is not asked to
            approve anything. One claim per wallet every {info && info !== 'loading' ? info.periodHours : 24} hours.
            These are test tokens with no value.
          </p>
          <ul className="small" data-testid="mint-solana-tokens">
            {tokens.map((t) => (
              <li key={t.mint} data-testid="mint-solana-token" data-symbol={t.symbol}>
                <strong>{t.symbol}</strong> ({t.name}) · you hold{' '}
                <span data-testid="mint-solana-balance" data-symbol={t.symbol}>
                  {balance(t.mint, t.decimals)}
                </span>{' '}
                on Solana <span className="mono xsmall muted">({shortHex(t.mint, 6, 6)})</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {waiting && claimed && (
        <Notice tone="info" role="status" data-testid="mint-solana-waiting">
          This wallet received its test tokens at {faucetTime(claimed.at)}. The next claim opens at{' '}
          {faucetTime(claimed.nextClaimAt)}.
        </Notice>
      )}
      {!result && claimed?.state === 'pending' && (
        <Notice tone="info" role="status" data-testid="mint-solana-pending">
          This wallet&apos;s last claim is still on its way to Solana. Check again in a minute.
        </Notice>
      )}
      {busy && (
        <p className="small" role="status" data-testid="mint-solana-stage" data-stage={job?.stage ?? 'sending'}>
          {(job && STAGE_WORDS[job.stage]) ?? 'Asking the market…'}
          {job?.state === 'queued' && job.position !== undefined ? ` · position ${job.position} in line` : ''}
        </p>
      )}
      {error && (
        <Notice tone="danger" role="alert" data-testid="mint-solana-error">
          {error}
        </Notice>
      )}
      {result && (
        <div data-testid="mint-solana-result">
          <Notice tone="success" role="status">
            <Icon name="success" /> Minted {faucetAmountsText(result.minted)} to your wallet.
          </Notice>
          <p className="small">Solana transaction:</p>
          <CopyField value={result.signature} data-testid="mint-solana-signature" />
          <p className="small">
            Your balance on Solana now:{' '}
            {result.minted.map((m, i) => (
              <span key={m.mint}>
                {i > 0 ? ' · ' : ''}
                <span data-testid="mint-solana-new-balance" data-symbol={m.symbol}>
                  {balance(m.mint, m.decimals)}
                </span>{' '}
                {m.symbol}
              </span>
            ))}
          </p>
          <p className="xsmall muted" data-testid="mint-solana-next">
            Next claim for this wallet from {faucetTime(result.nextClaimAt)}.
          </p>
        </div>
      )}
    </>
  );
}

/** The flow inline (the Portfolio's sub-page for action 5). */
export function MintSolanaTokensFlow({
  relayUrl,
  walletAddress,
  onDone,
}: {
  relayUrl: string;
  walletAddress?: string | null;
  onDone?: () => void;
}) {
  const f = useFaucetFlow(relayUrl, walletAddress, true, onDone);
  return (
    <Panel title="Mint Solana tokens" data-testid="mint-solana-flow">
      <FlowBody f={f} />
      {!f.result && (
        <div className="row gap-top">
          <ClaimButton f={f} />
        </div>
      )}
    </Panel>
  );
}

/** The flow in a dialog. */
export function MintSolanaTokensDialog({
  relayUrl,
  open,
  onClose,
}: {
  relayUrl: string;
  open: boolean;
  onClose(): void;
}) {
  const f = useFaucetFlow(relayUrl, undefined, open);
  const close = () => {
    if (f.busy) return;
    f.reset();
    onClose();
  };
  return (
    <Dialog
      open={open}
      title="Mint Solana tokens"
      onClose={close}
      testId="mint-solana-dialog"
      actions={
        <>
          <Button variant="secondary" onClick={close} disabled={f.busy} data-testid="mint-solana-close">
            {f.result ? 'Done' : 'Close'}
          </Button>
          {!f.result && <ClaimButton f={f} />}
        </>
      }
    >
      <FlowBody f={f} />
    </Dialog>
  );
}

/** A self-contained entry for the flow: shown disabled, with the reason, when the market does not offer it. */
export function MintSolanaTokensAction({ relayUrl }: { relayUrl: string }) {
  const { availability, info } = useSplFaucetOffer(relayUrl);
  const [open, setOpen] = useState(false);
  const tokens = info && info !== 'loading' ? info.tokens : [];
  const offered = availability.state === 'offered';
  return (
    <Panel
      title={
        <>
          <Icon name="spark" className="title-icon" /> Mint Solana tokens
        </>
      }
      tone="quiet"
      as="aside"
      data-testid="mint-solana-action"
      data-state={availability.state}
    >
      <p className="xsmall muted">
        {tokens.length > 0
          ? `${faucetAmountsText(tokens)} (test tokens) to your Solana wallet. The market pays the fee.`
          : 'Test tokens to your Solana wallet. The market pays the fee.'}
      </p>
      <Button
        variant="secondary"
        disabled={!offered}
        onClick={() => setOpen(true)}
        data-testid="mint-solana-open"
        aria-describedby={offered ? undefined : 'mint-solana-unavailable'}
      >
        Mint Solana tokens
      </Button>
      {availability.state === 'not-offered' && (
        <p
          className="small gap-top"
          id="mint-solana-unavailable"
          data-testid="mint-solana-unavailable"
          data-code={availability.code}
        >
          Not available on this market.
        </p>
      )}
      <MintSolanaTokensDialog relayUrl={relayUrl} open={open} onClose={() => setOpen(false)} />
    </Panel>
  );
}
