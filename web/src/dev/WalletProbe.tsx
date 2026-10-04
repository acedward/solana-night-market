// The WALLET PROBE (AA 00060 P1.6, gate G-NIGHTLY): a dev-only page at `#wallet-probe`, served only when
// `config.json` has `devProbe: true` (the production configs never set it). It needs no relay and no
// Midnight stack: only a Solana wallet and, for the transaction checks, the configured Solana RPC.
//
// It shows exactly what a wallet offers through the Wallet Standard and how it signs:
//   - every registered wallet's name, version, chains and features, and each account's features (raw),
//     plus how the SITE'S own discovery offers it (`via: wallet-standard` or `injected`);
//   - it signs each message Night Market signs at 10b29b1 (the P0.4 goldens), an I-5 sample (twice,
//     through the landing-key library itself: "identical: yes/no") and an I-4 placeholder, showing the
//     text, the fingerprint and the page's verdict (`ok` / `hardware` / `mismatch`) for each;
//   - it builds a harmless transaction (a Memo signed by the wallet) for the configured RPC and
//     cluster, sends it once with `solana:signAndSendTransaction` and once with
//     `solana:signTransaction` plus the page's own send, and shows each one's confirmation.
// The goldens are NOT bundled (the production image builds web/ alone): the page loads them at run time
// from `./wallet-probe-goldens.json`, which test/gates/nightly/run-probe.sh copies next to config.json from
// test/fixtures/messages-10b29b1.json. Without that file the probe signs the I-5 and I-4 samples only.
// The JSON report holds NO signature of any message (the I-5 signature is a secret key, and the
// landing master it derives is wiped at once); transaction signatures are public chain data.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  LANDING_KEY_FIRST_LINE,
  LandingKeyError,
  deriveLandingMaster,
  landingMessage,
  registrationMessageText,
} from '@nightmarket/core/bridge';
import { classifyWalletSignature, type SignatureVerdict } from '@nightmarket/core';
import {
  compileLegacyMessage,
  encodeKey,
  memoInstruction,
  splitTransaction,
  toBase64,
  unsignedTransaction,
} from '@nightmarket/core/solana';

import type { SiteConfig } from '../config.js';
import { Button, ButtonRow, Notice, PageHead, Panel } from '../design/index.js';
import { messageFingerprint } from '../wallet/sign-prompt.js';
import { discoverSolanaWallets, type SolanaWalletHandle } from '../wallet/solana-wallets.js';

interface RawAccount {
  address: string;
  publicKey: Uint8Array;
  chains: readonly string[];
  features: readonly string[];
  label?: string;
}
interface RawWallet {
  name: string;
  version: string;
  icon?: string;
  chains: readonly string[];
  accounts: readonly RawAccount[];
  features: Record<string, { version?: string } & Record<string, unknown>>;
}

interface GoldenMessage {
  id: string;
  network: string;
  family: string;
  hex: string;
}

/** Where run-probe.sh puts the P0.4 goldens (never bundled). */
export const GOLDENS_FILE = './wallet-probe-goldens.json';

interface ProbeMessage {
  id: string;
  family: string;
  bytes: Uint8Array;
}

interface MessageResult {
  id: string;
  family: string;
  bytes: number;
  fingerprint: string;
  verdict: SignatureVerdict | 'refused' | 'error';
  error?: string;
  ms: number;
}

interface TxResult {
  method: 'solana:signAndSendTransaction' | 'solana:signTransaction';
  chain: string;
  ok: boolean;
  signature?: string;
  confirmation?: string | null;
  walletChangedTransaction?: boolean;
  error?: string;
  ms: number;
}

const hexToBytes = (h: string) => Uint8Array.from((h.match(/../g) ?? []).map((b) => parseInt(b, 16)));
const errorText = (e: unknown) =>
  e instanceof Error ? `${e.name}: ${e.message}` : typeof e === 'object' && e ? JSON.stringify(e) : String(e);
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Watch the Wallet Standard's registry directly (every wallet, usable or not). */
function useRawWallets(): RawWallet[] {
  const [wallets, setWallets] = useState<RawWallet[]>([]);
  useEffect(() => {
    const list: RawWallet[] = [];
    const api = Object.freeze({
      register(...ws: RawWallet[]) {
        for (const w of ws) if (w && !list.includes(w)) list.push(w);
        setWallets([...list]);
        return () => undefined;
      },
    });
    const onRegister = (event: Event) => {
      const cb = (event as CustomEvent<unknown>).detail;
      if (typeof cb === 'function') {
        try {
          (cb as (a: typeof api) => void)(api);
        } catch {
          /* a broken wallet must not break the probe */
        }
      }
    };
    window.addEventListener('wallet-standard:register-wallet', onRegister);
    window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: api }));
    return () => window.removeEventListener('wallet-standard:register-wallet', onRegister);
  }, []);
  return wallets;
}

const describeWallet = (w: RawWallet) => ({
  name: w.name,
  version: w.version,
  hasIcon: typeof w.icon === 'string' && w.icon.length > 0,
  chains: [...w.chains],
  features: Object.fromEntries(Object.entries(w.features).map(([k, v]) => [k, v?.version ?? null])),
  accounts: w.accounts.map((a) => ({
    address: a.address,
    chains: [...a.chains],
    features: [...a.features],
    label: a.label ?? null,
  })),
});

async function rpcCall<T>(rpcUrl: string, method: string, params: unknown[] = []): Promise<T> {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(body.error.message);
  return body.result as T;
}

async function waitConfirmed(rpcUrl: string, signature: string, ms = 60_000): Promise<string | null> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const r = await rpcCall<{ value: ({ confirmationStatus?: string; err: unknown } | null)[] }>(
      rpcUrl,
      'getSignatureStatuses',
      [[signature], { searchTransactionHistory: true }],
    );
    const s = r.value[0];
    if (s?.err) return `failed: ${JSON.stringify(s.err)}`;
    if (s?.confirmationStatus === 'confirmed' || s?.confirmationStatus === 'finalized') return s.confirmationStatus;
    await new Promise((r2) => setTimeout(r2, 1000));
  }
  return null;
}

export default function WalletProbe({ config }: { config: SiteConfig }) {
  const raw = useRawWallets();
  const [site, setSite] = useState<{ name: string; via: string }[]>([]);
  useEffect(
    () =>
      discoverSolanaWallets(window, (hs: SolanaWalletHandle[]) =>
        setSite(hs.map((h) => ({ name: h.name, via: h.via }))),
      ),
    [],
  );
  const [chosen, setChosen] = useState<RawWallet | null>(null);
  const [account, setAccount] = useState<RawAccount | null>(null);
  const [genesis, setGenesis] = useState<string | null>(null);
  const [rpcError, setRpcError] = useState<string | null>(null);
  const [withStagenet, setWithStagenet] = useState(false);
  const [goldens, setGoldens] = useState<GoldenMessage[] | null>(null);
  useEffect(() => {
    fetch(GOLDENS_FILE, { cache: 'no-store' })
      .then((r) => (r.ok ? (r.json() as Promise<{ messages?: GoldenMessage[] }>) : { messages: [] }))
      .then(
        (j) => setGoldens(Array.isArray(j.messages) ? j.messages : []),
        () => setGoldens([]),
      );
  }, []);
  const [results, setResults] = useState<Record<string, MessageResult>>({});
  const [landing, setLanding] = useState<{
    verdicts: SignatureVerdict[];
    identical: boolean | null;
    error?: string;
  } | null>(null);
  const [txs, setTxs] = useState<TxResult[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [chain, setChain] = useState(config.solana?.cluster ?? 'solana:devnet');
  /** Unix seconds when the account connected: the I-4 placeholder expires 10 minutes after it. */
  const [connectedAt, setConnectedAt] = useState(0);
  const reportRef = useRef<HTMLTextAreaElement>(null);
  const rpcUrl = config.solana?.rpcUrl ?? null;
  const network = config.network.name;

  useEffect(() => {
    if (!rpcUrl) return;
    rpcCall<string>(rpcUrl, 'getGenesisHash').then(setGenesis, (e: unknown) => setRpcError(errorText(e)));
  }, [rpcUrl]);

  const messages = useMemo<ProbeMessage[]>(() => {
    if (!account) return [];
    const wallet = encodeKey(account.publicKey);
    const out: ProbeMessage[] = (goldens ?? [])
      .filter((m) => m.network === network || withStagenet)
      .map((m) => ({ id: `golden:${m.id}`, family: m.family, bytes: hexToBytes(m.hex) }));
    out.push({
      id: 'i4-placeholder',
      family: 'rpc-registration',
      bytes: new TextEncoder().encode(
        registrationMessageText({
          origin: config.injector?.url ? new URL(config.injector.url).origin : 'http://127.0.0.1:18899',
          networkId: network,
          solanaAddress: wallet,
          accountAddress: '11'.repeat(32),
          expires: connectedAt + 600,
        }),
      ),
    });
    return out;
  }, [account, network, withStagenet, config.injector, connectedAt, goldens]);

  const landingSample = useMemo(() => {
    if (!account) return null;
    try {
      return landingMessage({
        origin: window.location.origin,
        midnightNetwork: network,
        // Without a reachable RPC the sample still shows the text, over a placeholder genesis hash.
        solanaGenesisHash: genesis ?? '11111111111111111111111111111111',
        walletAddress: encodeKey(account.publicKey),
      });
    } catch (e) {
      return errorText(e);
    }
  }, [account, genesis, network]);

  const connect = useCallback(async (w: RawWallet) => {
    setBusy('connect');
    try {
      const connectFeature = w.features['standard:connect'] as unknown as {
        connect(): Promise<{ accounts: readonly RawAccount[] }>;
      };
      const { accounts } = await connectFeature.connect();
      const list = accounts.length > 0 ? accounts : w.accounts;
      setChosen(w);
      setConnectedAt(Math.floor(Date.now() / 1000));
      setAccount(list[0] ?? null);
    } catch (e) {
      setRpcError(`connect: ${errorText(e)}`);
    } finally {
      setBusy(null);
    }
  }, []);

  const signRaw = useCallback(
    async (message: Uint8Array) => {
      if (!chosen || !account) throw new Error('not connected');
      const f = chosen.features['solana:signMessage'] as unknown as {
        signMessage(i: {
          account: RawAccount;
          message: Uint8Array;
        }): Promise<ReadonlyArray<{ signature: Uint8Array; signedMessage?: Uint8Array }>>;
      };
      if (!f) throw new Error('the wallet has no solana:signMessage');
      const [out] = await f.signMessage({ account, message });
      if (!out) throw new Error('the wallet returned nothing');
      return {
        signature: Uint8Array.from(out.signature),
        ...(out.signedMessage ? { signedMessage: Uint8Array.from(out.signedMessage) } : {}),
      };
    },
    [chosen, account],
  );

  const signOne = useCallback(
    async (m: ProbeMessage) => {
      if (!account) return;
      const t0 = now();
      let result: MessageResult;
      try {
        const { signature, signedMessage } = await signRaw(m.bytes);
        const verdict = classifyWalletSignature(m.bytes, signature, account.publicKey, signedMessage);
        signature.fill(0);
        result = {
          id: m.id,
          family: m.family,
          bytes: m.bytes.length,
          fingerprint: messageFingerprint(m.bytes),
          verdict,
          ms: Math.round(now() - t0),
        };
      } catch (e) {
        result = {
          id: m.id,
          family: m.family,
          bytes: m.bytes.length,
          fingerprint: messageFingerprint(m.bytes),
          verdict: (e as { code?: number }).code === 4001 ? 'refused' : 'error',
          error: errorText(e),
          ms: Math.round(now() - t0),
        };
      }
      setResults((r) => ({ ...r, [m.id]: result }));
    },
    [account, signRaw],
  );

  const signLanding = useCallback(async () => {
    if (!account || !genesis) return;
    setBusy('landing');
    const verdicts: SignatureVerdict[] = [];
    try {
      const master = await deriveLandingMaster(
        (m) => signRaw(m),
        {
          origin: window.location.origin,
          midnightNetwork: network,
          solanaGenesisHash: genesis,
          walletAddress: encodeKey(account.publicKey),
        },
        account.publicKey,
        {
          classify: (m, s, pk, sm) => {
            const v = classifyWalletSignature(m, s, pk, sm);
            verdicts.push(v);
            return v;
          },
        },
      );
      master.wipe();
      setLanding({ verdicts, identical: true });
    } catch (e) {
      const notDeterministic = e instanceof LandingKeyError && e.code === 'not-deterministic';
      setLanding({ verdicts, identical: notDeterministic ? false : null, error: errorText(e) });
    } finally {
      setBusy(null);
    }
  }, [account, genesis, network, signRaw]);

  const signAll = useCallback(async () => {
    setBusy('all');
    try {
      for (const m of messages) await signOne(m);
    } finally {
      setBusy(null);
    }
    await signLanding();
  }, [messages, signOne, signLanding]);

  const sendTx = useCallback(
    async (method: TxResult['method']) => {
      if (!chosen || !account || !rpcUrl) return;
      setBusy(method);
      const t0 = now();
      const record = (r: Omit<TxResult, 'method' | 'chain' | 'ms'>) =>
        setTxs((list) => [...list, { method, chain, ms: Math.round(now() - t0), ...r }]);
      try {
        const payer = encodeKey(account.publicKey);
        const { value } = await rpcCall<{ value: { blockhash: string } }>(rpcUrl, 'getLatestBlockhash', [
          { commitment: 'confirmed' },
        ]);
        const message = compileLegacyMessage(payer, value.blockhash, [
          memoInstruction(payer, `Night Market wallet probe ${method} ${Date.now()}`),
        ]);
        const transaction = unsignedTransaction(message);
        const feature = chosen.features[method] as unknown as
          Record<string, (...a: unknown[]) => Promise<unknown[]>> | undefined;
        if (!feature) {
          record({ ok: false, error: `the wallet has no ${method}` });
          return;
        }
        let signature: string;
        let changed = false;
        if (method === 'solana:signAndSendTransaction') {
          const [out] = (await feature.signAndSendTransaction!({
            account,
            transaction,
            chain,
            options: { preflightCommitment: 'confirmed' },
          })) as {
            signature: Uint8Array;
          }[];
          signature = encodeKey(Uint8Array.from(out!.signature));
        } else {
          const [out] = (await feature.signTransaction!({ account, transaction, chain })) as {
            signedTransaction: Uint8Array;
          }[];
          const signed = Uint8Array.from(out!.signedTransaction);
          const parts = splitTransaction(signed);
          changed = toBase64(parts.message) !== toBase64(message.bytes);
          signature = await rpcCall<string>(rpcUrl, 'sendTransaction', [
            toBase64(signed),
            { encoding: 'base64', preflightCommitment: 'confirmed' },
          ]);
        }
        const confirmation = await waitConfirmed(rpcUrl, signature);
        record({
          ok: confirmation === 'confirmed' || confirmation === 'finalized',
          signature,
          confirmation,
          walletChangedTransaction: changed,
        });
      } catch (e) {
        record({ ok: false, error: errorText(e) });
      } finally {
        setBusy(null);
      }
    },
    [chosen, account, rpcUrl, chain],
  );

  const report = useMemo(
    () => ({
      probe: 'night-market-wallet-probe/v1',
      at: new Date().toISOString(),
      origin: window.location.origin,
      userAgent: navigator.userAgent,
      network,
      solana: { rpcUrl, cluster: config.solana?.cluster ?? null, chainUsed: chain, genesisHash: genesis, rpcError },
      wallets: raw.map(describeWallet),
      siteDiscovery: site,
      connected:
        chosen && account
          ? {
              wallet: chosen.name,
              address: account.address,
              chains: [...account.chains],
              features: [...account.features],
            }
          : null,
      goldensLoaded: goldens?.length ?? 0,
      messages: messages.map((m) => results[m.id] ?? { id: m.id, family: m.family, verdict: 'not signed yet' }),
      landingKey: landing,
      transactions: txs,
    }),
    [
      network,
      rpcUrl,
      config.solana,
      chain,
      genesis,
      rpcError,
      raw,
      site,
      chosen,
      account,
      messages,
      results,
      landing,
      txs,
    ],
  );

  return (
    <section className="wrap" data-testid="wallet-probe">
      <PageHead title="Wallet probe (development only)" />
      <Notice tone="warning">
        A development page for checking a Solana wallet against Night Market (AA 00060, G-NIGHTLY). It signs test
        messages only: none of them authorises anything. Use a TEST wallet account.
      </Notice>
      <Panel title="1. Wallets this browser registered">
        <p className="small">
          RPC: <code data-testid="probe-rpc">{rpcUrl ?? 'none configured'}</code> · genesis hash:{' '}
          <code data-testid="probe-genesis">{genesis ?? rpcError ?? '…'}</code>
        </p>
        <ul data-testid="probe-wallets">
          {raw.map((w) => {
            const via = site.find((s) => s.name === w.name)?.via ?? 'not offered by the site';
            return (
              <li key={w.name}>
                <strong>{w.name}</strong> {w.version} · site: <span data-testid={`probe-via-${w.name}`}>{via}</span>{' '}
                <Button
                  size="small"
                  onClick={() => void connect(w)}
                  disabled={busy !== null}
                  data-testid={`probe-connect-${w.name}`}
                >
                  Connect
                </Button>
              </li>
            );
          })}
        </ul>
        {raw.length === 0 && <p>No Wallet Standard wallet registered yet.</p>}
      </Panel>
      {account && chosen && (
        <>
          <Panel title={`2. Messages (${chosen.name}, ${account.address})`}>
            {goldens !== null && goldens.length === 0 && (
              <Notice tone="warning" data-testid="probe-no-goldens">
                No {GOLDENS_FILE} next to this page: only the landing-key and registration samples can be signed.
              </Notice>
            )}
            <ButtonRow>
              <Button
                variant="primary"
                onClick={() => void signAll()}
                disabled={busy !== null}
                data-testid="probe-sign-all"
              >
                Sign every message
              </Button>
              <label className="small">
                <input type="checkbox" checked={withStagenet} onChange={(e) => setWithStagenet(e.target.checked)} />{' '}
                also the stagenet copies
              </label>
            </ButtonRow>
            <ol>
              {messages.map((m) => {
                const r = results[m.id];
                return (
                  <li key={m.id} data-testid="probe-message">
                    <div>
                      <code>{m.id}</code> · fingerprint <code>{messageFingerprint(m.bytes)}</code> · verdict{' '}
                      <strong data-testid={`probe-verdict-${m.id}`}>{r?.verdict ?? '—'}</strong>{' '}
                      <Button size="small" onClick={() => void signOne(m)} disabled={busy !== null}>
                        Sign
                      </Button>
                    </div>
                    <pre className="small">{String.fromCharCode(...m.bytes)}</pre>
                  </li>
                );
              })}
              <li data-testid="probe-landing">
                <div>
                  <code>i5-landing-key</code> ({LANDING_KEY_FIRST_LINE}) · signed twice · identical:{' '}
                  <strong data-testid="probe-landing-identical">
                    {landing ? (landing.identical === null ? 'error' : landing.identical ? 'yes' : 'no') : '—'}
                  </strong>{' '}
                  · verdicts <span data-testid="probe-landing-verdicts">{landing?.verdicts.join(', ') ?? '—'}</span>{' '}
                  <Button size="small" onClick={() => void signLanding()} disabled={busy !== null || !genesis}>
                    Sign twice
                  </Button>
                </div>
                <pre className="small">
                  {typeof landingSample === 'string'
                    ? landingSample
                    : landingSample
                      ? String.fromCharCode(...landingSample)
                      : ''}
                </pre>
              </li>
            </ol>
          </Panel>
          <Panel title="3. A harmless Solana transaction (a Memo)">
            <p className="small">
              Chain the wallet is asked to use:{' '}
              <input
                value={chain}
                onChange={(e) => setChain(e.target.value)}
                data-testid="probe-chain"
                aria-label="Wallet Standard chain"
              />
            </p>
            <ButtonRow>
              <Button
                onClick={() => void sendTx('solana:signAndSendTransaction')}
                disabled={busy !== null || !rpcUrl}
                data-testid="probe-sign-and-send"
              >
                Sign and send (wallet sends)
              </Button>
              <Button
                onClick={() => void sendTx('solana:signTransaction')}
                disabled={busy !== null || !rpcUrl}
                data-testid="probe-sign-then-send"
              >
                Sign, then the page sends
              </Button>
            </ButtonRow>
            <ul data-testid="probe-txs">
              {txs.map((t, i) => (
                <li key={i}>
                  {t.method}: {t.ok ? 'confirmed' : 'not confirmed'} {t.signature ? <code>{t.signature}</code> : null}{' '}
                  {t.error ?? ''}
                </li>
              ))}
            </ul>
          </Panel>
        </>
      )}
      <Panel title="4. Report (copy this into the chat)">
        <textarea
          ref={reportRef}
          readOnly
          rows={16}
          style={{ width: '100%' }}
          value={JSON.stringify(report, null, 2)}
          data-testid="probe-report"
        />
        <ButtonRow>
          <Button
            onClick={() => {
              reportRef.current?.select();
              void navigator.clipboard?.writeText(JSON.stringify(report, null, 2)).catch(() => undefined);
            }}
          >
            Copy the report
          </Button>
        </ButtonRow>
      </Panel>
    </section>
  );
}
