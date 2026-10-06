// AA 00062 P4.1 (spec US2, FR-008, FR-012): Local Data's "Proof server (optional)": the URL in use, its
// last Test, the package's command, Test and Forget. The setting lives in this browser only and is not
// part of the backup file (owner Q3).

import { useEffect, useState } from 'react';

import { Button, Icon, Notice, Panel } from '../design/index.js';
import type { ProverExpectation } from './client-prover.js';
import { DEFAULT_PROVER_URL, PROVER_MEMORY_GB } from './constants.js';
import { useProverContext, useProverSetting } from './ProverContext.js';
import { ProverSetup } from './ProverSetup.js';

const when = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

export function ProverSection() {
  const ctx = useProverContext();
  const setting = useProverSetting(ctx?.settings ?? null);
  const [expected, setExpected] = useState<ProverExpectation | null>(null);
  const [mode, setMode] = useState<'off' | 'required' | null>(null);
  const [forgotten, setForgotten] = useState(false);
  // Remount the form when the setting is forgotten, so it starts again from the default URL.
  const [formKey, setFormKey] = useState(0);
  useEffect(() => {
    if (!ctx) return;
    let live = true;
    void ctx.engine.config().then((c) => {
      if (!live) return;
      setMode(c.mode);
      void ctx.engine.expectation().then((e) => live && setExpected(e));
    });
    return () => {
      live = false;
    };
  }, [ctx]);
  if (!ctx) return null;
  const last = setting?.lastTest ?? null;

  return (
    <Panel title="Proof server (optional)" className="section-gap" data-testid="prover-section">
      <p className="panel-intro">
        Making and taking offers, withdrawals, saving your change and Bridge out need a zero-knowledge proof that takes
        about {PROVER_MEMORY_GB} GB of memory. A market can ask you to create these proofs on your own proof server:
        this page then uses the one set here. It is kept in this browser only, and is not part of your backup.
      </p>
      <p className="small" data-testid="prover-market-mode" data-mode={mode ?? 'unknown'}>
        {mode === 'required'
          ? 'This market asks you to prove these actions on your own proof server.'
          : mode === 'off'
            ? 'This market proves every action itself right now; a proof server set here is used if it starts asking.'
            : 'Reading what this market needs…'}
      </p>
      {!ctx.settings.persistent && (
        <Notice tone="warning" className="panel-intro" data-testid="prover-not-saved">
          This browser does not keep Night Market&apos;s data, so a proof server set here lasts only until you close
          this page.
        </Notice>
      )}
      <div className="prover-saved" data-testid="prover-saved" data-set={!!setting}>
        {setting ? (
          <>
            <p>
              In use:{' '}
              <span className="mono break" data-testid="prover-saved-url">
                {setting.url}
              </span>
            </p>
            {last ? (
              <p className="small" data-testid="prover-last-result" data-ok={last.ok}>
                <Icon name={last.ok ? 'success' : 'alert'} /> Last test {when(last.at)} UTC:{' '}
                {last.ok
                  ? `passed (package ${last.package ?? '?'}, proof server ${last.proofServer ?? '?'}).`
                  : `failed. ${last.problem ?? ''}`}
              </p>
            ) : (
              <p className="small muted" data-testid="prover-last-result" data-ok="none">
                Not tested yet.
              </p>
            )}
          </>
        ) : (
          <p className="small muted" data-testid="prover-none">
            {forgotten
              ? 'Forgotten. The next action that needs your proof server asks for one again.'
              : 'No proof server is set in this browser.'}
          </p>
        )}
      </div>
      <ProverSetup
        key={formKey}
        engine={ctx.engine}
        expected={expected}
        initialUrl={setting?.url ?? DEFAULT_PROVER_URL}
        initialConfirmed={!!setting?.privacyConfirmed}
        testIdPrefix="prover"
        onTested={() => setForgotten(false)}
      />
      <div className="danger-zone">
        <p className="explain">Forget removes the proof server from this browser. Nothing else changes.</p>
        <Button
          variant="secondary"
          data-testid="prover-forget"
          disabled={!setting}
          onClick={() => {
            ctx.settings.forget();
            setForgotten(true);
            setFormKey((k) => k + 1);
          }}
        >
          Forget
        </Button>
      </div>
    </Panel>
  );
}
