// "Mint Solana tokens" (AA 00060 P13, spec FR-024): the flow of FR-023's Portfolio action 5.
//
//   useSplFaucetOffer(relayUrl)        whether the market offers it (and why not): for the action's
//                                      enabled/disabled state ("not available on this market")
//   <MintSolanaTokensDialog open …/>   the flow itself, in a dialog: what you get, the claim, then the result
//                                      with the transaction signature and the new Solana balance
//   <MintSolanaTokensAction …/>        a self-contained entry (a button that opens the dialog, disabled with
//                                      the reason when not offered), until the Portfolio's action list
//                                      (lane 00060-lane-portfolio, FR-023) mounts the dialog itself
//
// The wallet is asked for nothing: the market's faucet key signs and pays. Balances come from the SITE's
// Solana RPC (config.json `solana`), read before and after the claim.

import { useCallback, useEffect, useMemo, useState } from 'react';

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

/** The market's faucet offer for the connected wallet; `reload` reads it again. */
export function useSplFaucetOffer(relayUrl: string) {
  const wallet = useWallet();
  const relay = useMemo(() => new RelayClient(relayUrl), [relayUrl]);
  const address = wallet.address;
  const [info, setInfo] = useState<SplFaucetInfo | null | 'loading'>('loading');
  const reload = useCallback(() => {
    if (!address) return;
    void faucetOffer(relay, address).then(setInfo, () => setInfo(null));
  }, [relay, address]);
  useEffect(() => {
    const t = setTimeout(reload, 0);
    return () => clearTimeout(t);
  }, [reload]);
  return { info, availability: faucetAvailability(info), reload, relay, wallet: address };
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

export function MintSolanaTokensDialog({
  relayUrl,
  open,
  onClose,
}: {
  relayUrl: string;
  open: boolean;
  onClose(): void;
}) {
  const { info, availability, reload, relay, wallet } = useSplFaucetOffer(relayUrl);
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
    if (!open) return;
    const t = setTimeout(reload, 0);
    return () => clearTimeout(t);
  }, [open, reload]);
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => void readBalances(), 0);
    return () => clearTimeout(t);
  }, [open, readBalances]);

  const close = () => {
    if (busy) return;
    setResult(null);
    setError(null);
    setJob(null);
    onClose();
  };

  const claim = async () => {
    if (!wallet) return;
    setBusy(true);
    setError(null);
    setResult(null);
    setJob(null);
    try {
      setResult(await claimSolanaTokens(relay, wallet, setJob));
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

  return (
    <Dialog
      open={open}
      title="Mint Solana tokens"
      onClose={close}
      testId="mint-solana-dialog"
      actions={
        <>
          <Button variant="secondary" onClick={close} disabled={busy} data-testid="mint-solana-close">
            {result ? 'Done' : 'Close'}
          </Button>
          {!result && (
            <Button onClick={() => void claim()} disabled={!canClaim} data-testid="mint-solana-claim">
              {busy ? 'Minting…' : tokens.length > 0 ? `Mint ${faucetAmountsText(tokens)}` : 'Mint'}
            </Button>
          )}
        </>
      }
    >
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
                  {balances ? amount(balances.get(t.mint), t.decimals) : rpc ? '…' : 'unavailable'}
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
                  {balances ? amount(balances.get(m.mint), m.decimals) : rpc ? '…' : 'unavailable'}
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
