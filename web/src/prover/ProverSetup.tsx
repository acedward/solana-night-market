// AA 00062 P4.1 / P4.2 / P4.4: the proof-server form both the popup and Local Data use: the package's
// command (copy), the URL (http://localhost / http://127.0.0.1 / https:// only), the privacy
// confirmation for a prover that is not on this computer, Test, and its result line by line.

import { useId, useState } from 'react';

import { Button, CopyField, Field, Icon, Notice, Spinner, TextInput } from '../design/index.js';
import type { ClientProver, ProverExpectation, TestOutcome } from './client-prover.js';
import { PROVER_COMMAND, type ClientCircuit } from './constants.js';
import { PRIVACY_CONFIRM, PRIVACY_WARNING, checkProverUrl, proverUrlProblem } from './url.js';

export interface ProverSetupProps {
  engine: ClientProver;
  /** What the prover must be; null while the market's mode is read. */
  expected: ProverExpectation | null;
  /** The action's circuit (the popup); none: every circuit the market may hand over (Local Data). */
  circuit?: ClientCircuit;
  initialUrl: string;
  /** The privacy confirmation already given for `initialUrl`. */
  initialConfirmed: boolean;
  /** Each Test's outcome (the popup enables Continue on a pass for the URL shown). */
  onTested?: (outcome: TestOutcome) => void;
  /** Told when the URL field changes (a passed Test no longer applies). */
  onUrlChange?: (url: string) => void;
  /** data-testid prefix: `<p>-url`, `<p>-test`, `<p>-result`, `<p>-command`, … */
  testIdPrefix: string;
}

export function ProverSetup({
  engine,
  expected,
  circuit,
  initialUrl,
  initialConfirmed,
  onTested,
  onUrlChange,
  testIdPrefix: p,
}: ProverSetupProps) {
  const id = useId();
  const [text, setText] = useState(initialUrl);
  const [confirmed, setConfirmed] = useState<string | null>(initialConfirmed ? initialUrl : null);
  const [testing, setTesting] = useState(false);
  const [outcome, setOutcome] = useState<TestOutcome | null>(null);
  const check = checkProverUrl(text);
  const remote = check.ok && !check.local;
  const privacyOk = !remote || (check.ok && confirmed === check.url);
  const shown = outcome && check.ok && outcome.url === check.url ? outcome : null;

  const test = async () => {
    if (!check.ok || !privacyOk || !expected) return;
    setTesting(true);
    try {
      const r = await engine.test(check.url, expected, {
        ...(circuit ? { circuit } : {}),
        privacyConfirmed: remote,
      });
      setOutcome(r);
      onTested?.(r);
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="prover-form" data-testid={`${p}-form`}>
      <div>
        <p className="field-label">Start the Night Market prover package on this computer</p>
        <CopyField value={PROVER_COMMAND} data-testid={`${p}-command`} />
        <p className="field-hint">
          It needs Docker with about 12 GB of memory (on a Mac, raise Docker Desktop&apos;s memory limit). The first
          start downloads the package, about 2.6 GB.
        </p>
      </div>
      <Field
        label="Proof server URL"
        htmlFor={`${id}-url`}
        hint={
          check.ok && check.local
            ? 'Your browser may ask to let this site reach apps on this computer: allow it.'
            : 'The package on this computer is http://localhost:6300. An online proof server must use https://.'
        }
        error={
          !check.ok && text.trim() !== '' ? (
            <span data-testid={`${p}-url-error`}>{proverUrlProblem(check.reason)}</span>
          ) : undefined
        }
      >
        <TextInput
          id={`${id}-url`}
          type="url"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          value={text}
          data-testid={`${p}-url`}
          onChange={(e) => {
            setText(e.target.value);
            onUrlChange?.(e.target.value);
          }}
        />
      </Field>
      {remote && check.ok && (
        <Notice tone="warning" title="This proof server is not on this computer" data-testid={`${p}-privacy`}>
          <p>{PRIVACY_WARNING}</p>
          <label className="check-row">
            <input
              type="checkbox"
              checked={confirmed === check.url}
              onChange={(e) => setConfirmed(e.target.checked ? check.url : null)}
              data-testid={`${p}-privacy-confirm`}
            />
            <span>{PRIVACY_CONFIRM}</span>
          </label>
        </Notice>
      )}
      <div className="prover-test-row">
        <Button
          variant="secondary"
          data-testid={`${p}-test`}
          disabled={!check.ok || !privacyOk || !expected || testing}
          onClick={() => void test()}
        >
          {testing ? (
            <>
              <Spinner /> Testing…
            </>
          ) : (
            'Test'
          )}
        </Button>
        {shown && (
          <strong className={shown.ok ? 'prover-pass' : 'prover-fail'} data-testid={`${p}-verdict`} data-ok={shown.ok}>
            <Icon name={shown.ok ? 'success' : 'alert'} /> {shown.ok ? 'Test passed' : 'Test failed'}
          </strong>
        )}
      </div>
      {shown && <TestLines outcome={shown} testId={`${p}-result`} />}
    </div>
  );
}

/** A Test's result, one line per check (reachable, version, key set, circuits, the machine). */
export function TestLines({ outcome, testId }: { outcome: TestOutcome; testId: string }) {
  return (
    <ul className="prover-checks" data-testid={testId} data-ok={outcome.ok}>
      {outcome.lines.map((l) => (
        <li key={l.id} data-testid="prover-check" data-id={l.id} data-ok={l.ok === null ? 'info' : String(l.ok)}>
          <Icon name={l.ok === false ? 'alert' : l.ok === true ? 'check' : 'info'} />
          <span>{l.text}</span>
        </li>
      ))}
    </ul>
  );
}
