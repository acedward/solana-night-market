// The Local Data tab (route #local; spec US4, FR-004, Q11; "Your data" until AA 00062, spec FR-008):
// every record the market keeps in this browser, with secrets masked until revealed, and Export (back
// up), Import (restore) and CLEAR ALL. AA 00062 P4.1 adds "Proof server (optional)" (../prover/
// ProverSection.tsx): the customer's own prover, kept in this browser only, never in the backup.
// A record table that stacks on a phone, and the CLEAR ALL dialog with "Export first" and a typed
// confirmation (AA 00047 P8.1: the dark consumer design, plain words).

import { useCallback, useMemo, useRef, useState, type ChangeEvent } from 'react';

import { shortSolanaAddress, solanaAddressOf } from '@nightmarket/core';

import { assetFilterText, useAssetFilter } from '../assets/AssetFilterContext.js';
import {
  Button,
  ButtonRow,
  Cell,
  EmptyState,
  Icon,
  Notice,
  PageHead,
  Panel,
  StatementTable,
  Sub,
  Toast,
  TypedConfirmDialog,
} from '../design/index.js';
import { useChain } from '../chain/ChainContext.js';
import { ProverSection } from '../prover/ProverSection.js';
import type { AccountChain } from '../chain/indexer.js';
import { storageText } from '../store/messages.js';
import { useStore } from '../store/StoreContext.js';
import { MAX_IMPORT_READ_BYTES, SCHEMA_VERSION, STORE_PREFIX, type ExportFile } from '../store/schema.js';
import { ImportError, type LocalStore, type RecordView } from '../store/store.js';
import { useWallet } from '../wallet/WalletContext.js';

export const CLEAR_ALL_PHRASE = 'CLEAR ALL';

const short = (s: string, head = 6, tail = 4) =>
  s.length <= head + tail + 1 ? s : `${s.slice(0, head)}…${s.slice(-tail)}`;
const when = (ms: number | null) => (ms === null ? '—' : new Date(ms).toISOString().replace('T', ' ').slice(0, 19));
const size = (bytes: number) => (bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`);

/** The export file's text, as the page downloads it: compact JSON, so the file is about the size
 *  of its records and always within what Import reads (security review F-B8). */
export const exportFileText = (file: ExportFile): string => `${JSON.stringify(file)}\n`;

function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * Import as one change (security review F-B5): check the whole file first; an encryption secret it
 * would replace with a different one is accepted only when the new public key is the account's
 * on-chain key (so a file cannot swap in a key that opens nothing), read from the public indexer
 * itself, not the relay (AA 00047 P9.S, questions Q26); then write it all or nothing.
 */
export async function importFile(
  store: LocalStore,
  chain: Pick<AccountChain, 'accountState'>,
  file: unknown,
  scope: { network: string; owner: string },
): Promise<{ imported: number; replaced: number }> {
  const plan = store.prepareImport(file, scope);
  const approved = new Set<string>();
  for (const c of plan.secretChanges) {
    if (!c.account) continue;
    const state = await chain.accountState(c.account).catch(() => null);
    if (state && state.encKey === c.encPublicKey) approved.add(c.account);
  }
  return store.commitImport(plan, { approvedSecretReplacements: approved });
}

export function LocalData({ network }: { network: string }) {
  const { status, store, revision } = useStore();
  const chain = useChain();
  const wallet = useWallet();
  const assets = useAssetFilter();
  const [revealed, setRevealed] = useState<ReadonlySet<string>>(new Set());
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const dismiss = useCallback(() => setMessage(null), []);

  // `revision` changes on every write here or in another tab.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const records = useMemo<RecordView[]>(() => store?.list() ?? [], [store, revision]);
  const scope = wallet.deviceKey ? { network, owner: wallet.deviceKey } : null;
  const mine = scope
    ? records.filter(
        (r) => !r.parsed.scope.global && r.parsed.scope.network === network && r.parsed.scope.owner === scope.owner,
      )
    : [];
  const wallets = new Set(
    records
      .filter((r) => !r.parsed.scope.global)
      .map((r) => (r.parsed.scope.global ? '' : `${r.parsed.scope.network}/${r.parsed.scope.owner}`)),
  );
  const totalBytes = records.reduce((n, r) => n + r.bytes, 0);

  const exportMine = () => {
    if (!store || !scope) return;
    const file = store.exportWallet(scope);
    const date = new Date().toISOString().slice(0, 10);
    download(`night-market-${network}-${solanaAddressOf(scope.owner).slice(0, 8)}-${date}.json`, exportFileText(file));
    setMessage({
      kind: 'ok',
      text: `Backed up ${file.records.length} records. Keep the file private: it holds your account's viewing key.`,
    });
  };

  const onImport = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f || !store) return;
    if (!scope) {
      setMessage({ kind: 'error', text: 'Connect the wallet the file belongs to before importing it.' });
      return;
    }
    if (f.size > MAX_IMPORT_READ_BYTES) {
      setMessage({
        kind: 'error',
        text: 'This file is larger than a Night Market export can be (20 MB). Nothing was imported.',
      });
      return;
    }
    try {
      const json: unknown = JSON.parse(await f.text());
      const r = await importFile(store, chain, json, scope);
      setMessage({
        kind: 'ok',
        text: `Imported ${r.imported} records${r.replaced ? ` (${r.replaced} replaced)` : ''}.`,
      });
    } catch (err) {
      setMessage({
        kind: 'error',
        text:
          err instanceof ImportError
            ? err.message
            : 'This file could not be read as a Night Market export. Nothing was imported.',
      });
    }
  };

  const clearAll = () => {
    if (!store) return;
    const n = store.clearAll();
    setConfirming(false);
    setRevealed(new Set());
    setMessage({ kind: 'ok', text: `Removed ${n} keys. Night Market keeps nothing in this browser now.` });
  };

  const toggle = (key: string) =>
    setRevealed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <section aria-labelledby="local-data-title" data-testid="local-data">
      <PageHead
        eyebrow="Your records"
        title="Local Data"
        titleId="local-data-title"
        lede="Everything Night Market knows about you stays in this browser: your account, its viewing key, your coins and your offers. The market's servers keep none of it. You need this data to use your tokens, so back it up and keep the file private. An optional proof server is set here too."
      />

      {status !== 'ok' && (
        <Notice
          tone="danger"
          role="alert"
          className="panel-intro"
          data-testid="storage-blocked"
          data-status={status}
          title={storageText(status).title}
        >
          {storageText(status).text}
        </Notice>
      )}
      {store?.readOnly && (
        <Notice tone="danger" role="alert" className="panel-intro" data-testid="store-read-only">
          This browser holds data from a newer version of Night Market. This page will not change it.
        </Notice>
      )}
      {message && (
        <Toast
          tone={message.kind === 'error' ? 'error' : 'success'}
          onClose={dismiss}
          timerKey={message.text}
          data-testid="local-message"
        >
          {message.text}
        </Toast>
      )}

      <Panel>
        <p className="ns-line">
          Stored under <span className="mono">{STORE_PREFIX}v1/…</span> · schema version {SCHEMA_VERSION} ·{' '}
          {records.length} {records.length === 1 ? 'record' : 'records'} ·{' '}
          <span className="num">{size(totalBytes)}</span>
          {wallets.size > 1 ? ` · ${wallets.size} wallets` : ''}
        </p>

        {records.length === 0 ? (
          <EmptyState data-testid="records-empty" icon="data" title="Nothing stored">
            Night Market keeps nothing in this browser.
          </EmptyState>
        ) : (
          <StatementTable
            data-testid="records"
            caption="Records kept in this browser"
            columns={[
              { label: 'Record' },
              { label: 'Contents' },
              { label: 'Size', align: 'right' },
              { label: 'Updated', sub: 'UTC', align: 'right' },
            ]}
          >
            {records.map((r) => {
              const s = r.parsed.scope;
              const value = r.record ? JSON.stringify(r.record.data) : '(unreadable)';
              const shown = !r.sensitive || revealed.has(r.key);
              return (
                <tr key={r.key} data-testid="record-row" data-kind={r.parsed.kind} data-key={r.key}>
                  <Cell block>
                    <strong>
                      {r.parsed.kind}
                      {r.parsed.id ? ` / ${r.parsed.id}` : ''}
                    </strong>
                    <Sub multiline>
                      {s.global ? (
                        'all networks and wallets'
                      ) : (
                        <>
                          {s.network} · wallet{' '}
                          <span title={solanaAddressOf(s.owner)}>{shortSolanaAddress(solanaAddressOf(s.owner))}</span>
                          {s.account ? (
                            <>
                              {' '}
                              · account <span title={s.account}>{short(s.account, 8, 6)}</span>
                            </>
                          ) : null}
                        </>
                      )}
                    </Sub>
                  </Cell>
                  <Cell label="Contents">
                    <span className="record-contents">
                      {shown ? (
                        <code data-testid="record-value">{value.length > 240 ? `${value.slice(0, 240)}…` : value}</code>
                      ) : (
                        <span className="secret-mask" data-testid="record-masked">
                          <span aria-hidden="true">••••••••••••••••</span>
                          <span className="sr-only">hidden until you reveal it</span>
                        </span>
                      )}
                      {r.sensitive && (
                        <Button
                          variant="secondary"
                          size="small"
                          data-testid="reveal"
                          aria-pressed={shown}
                          onClick={() => toggle(r.key)}
                        >
                          {shown ? 'Hide' : 'Reveal'}
                        </Button>
                      )}
                    </span>
                  </Cell>
                  <Cell label="Size" align="right" num>
                    {r.bytes} B
                  </Cell>
                  <Cell label="Updated" align="right" num>
                    {when(r.updatedAt)}
                  </Cell>
                </tr>
              );
            })}
          </StatementTable>
        )}

        <div className="danger-zone">
          <div>
            <ButtonRow>
              <Button
                variant="secondary"
                data-testid="export"
                onClick={exportMine}
                disabled={!store || !scope || mine.length === 0}
              >
                <Icon name="arrowUp" /> Back up (export)
              </Button>
              <Button
                variant="secondary"
                data-testid="import"
                onClick={() => fileInput.current?.click()}
                disabled={!store || !scope}
              >
                Restore (import)
              </Button>
              <input
                ref={fileInput}
                type="file"
                accept="application/json,.json"
                hidden
                data-testid="import-file"
                onChange={(e) => void onImport(e)}
              />
            </ButtonRow>
            <p className="explain">
              {scope
                ? `Back up saves this wallet's records as a JSON file, including your account's viewing key: keep it private. Restore accepts only a file for ${network} and this wallet.`
                : 'Connect your Solana wallet to back up or restore its data.'}
            </p>
          </div>
          <Button
            variant="danger"
            data-testid="clear-all"
            onClick={() => setConfirming(true)}
            disabled={!store || records.length === 0}
          >
            Clear all data
          </Button>
        </div>
      </Panel>

      <ProverSection />

      {assets.listed.length > 0 && (
        <Panel title="Asset filter" className="section-gap" data-testid="asset-filter-panel">
          <p className="panel-intro">
            A link set the assets this browser shows:{' '}
            <span className="mono" data-testid="asset-filter-listed">
              ?assets={assets.listed.join(',')}
            </span>
            . {assetFilterText(assets)}
          </p>
          <p className="small muted" data-testid="asset-filter-disclaimer">
            This only changes what this page shows; it is not a security setting.
          </p>
          <Button variant="secondary" data-testid="asset-filter-clear" onClick={assets.showAll}>
            Show all assets
          </Button>
        </Panel>
      )}

      <TypedConfirmDialog
        open={confirming}
        title="Clear all Night Market data from this browser?"
        phrase={CLEAR_ALL_PHRASE}
        testIdPrefix="clear"
        warning={
          <>
            <strong>Without a backup you cannot use these tokens again.</strong> Your account&apos;s coins can only be
            spent with this data: unless you have a recent backup, back it up first.
          </>
        }
        onExportFirst={scope && mine.length > 0 ? exportMine : undefined}
        exportLabel="Back up this wallet's data first"
        confirmLabel="Clear all data"
        onConfirm={clearAll}
        onCancel={() => setConfirming(false)}
      >
        <p>
          This removes all {records.length} records Night Market keeps here, for {wallets.size} wallet
          {wallets.size === 1 ? '' : 's'}. The market&apos;s servers have no copy.
        </p>
      </TypedConfirmDialog>
    </section>
  );
}
