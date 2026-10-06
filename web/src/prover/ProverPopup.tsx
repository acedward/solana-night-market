// AA 00062 P4.2 (spec US1 scenarios 1-2, FR-009): the popup. It opens only for a k>=18 action, when
// the market requires the customer's own prover and no saved one passes, and BEFORE anything is signed
// or sent (./client-prover.ts `ensure`). It carries the owner's words, the package's command, the URL
// field (http://localhost:6300 by default), Test, and Continue, which works only after a Test of the
// URL shown passed. Closing it stops the action.

import { useEffect, useState } from 'react';

import { Button, Dialog, Icon, Notice } from '../design/index.js';
import type { ClientProver, PopupRequest, TestOutcome } from './client-prover.js';
import { elapsedClock } from './client-prover.js';
import { DEFAULT_PROVER_URL } from './constants.js';
import { ProverSetup } from './ProverSetup.js';
import type { ProverSettings } from './settings.js';
import { checkProverUrl } from './url.js';

/** The owner's words (spec FR-009), verbatim in meaning. */
export const POPUP_TEXT =
  'You need to prove the ZK transaction. About 12 GB of memory are needed for this operation. You can start your own local proof server by running this command, or get an online ZK proof server and paste its URL.';
export const POPUP_DEMO_TEXT = 'This is a tech demo; on a real network this will be provided.';

const ACTION_WORDS: Record<PopupRequest['circuit'], string> = {
  open_swap_shielded_with_ed25519: 'making or taking an offer',
  withdraw_shielded_with_ed25519: 'a shielded withdrawal (or a Bridge out)',
  withdraw_unshielded_with_ed25519: 'an unshielded withdrawal',
  append_inbox_with_ed25519: 'saving your change in your inbox',
};

export function ProverPopup({
  request,
  engine,
  settings,
  onContinue,
  onCancel,
}: {
  request: PopupRequest;
  engine: ClientProver;
  settings: ProverSettings;
  onContinue: (url: string) => void;
  onCancel: () => void;
}) {
  const [saved] = useState(() => settings.read());
  const initialUrl = saved?.url ?? DEFAULT_PROVER_URL;
  const [passed, setPassed] = useState<string | null>(null);
  const [current, setCurrent] = useState(initialUrl);
  const shownUrl = checkProverUrl(current);
  const canContinue = shownUrl.ok && passed === shownUrl.url;
  const waiting = request.reason !== 'start';

  // While the market waits (a hand-off), the time it still waits.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (request.deadlineMs === null) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [request.deadlineMs]);
  const left = request.deadlineMs !== null ? Math.max(0, (request.deadlineMs - now) / 1000) : null;

  return (
    <Dialog
      open
      title={
        <>
          <Icon name="shield" />
          <span>Prove this action on your own proof server</span>
        </>
      }
      onClose={onCancel}
      testId="prover-popup"
      className="prover-dialog"
      actions={
        <>
          <Button variant="secondary" onClick={onCancel} data-testid="prover-popup-cancel">
            {waiting ? 'Stop this action' : 'Cancel'}
          </Button>
          <Button
            disabled={!canContinue}
            data-testid="prover-popup-continue"
            onClick={() => shownUrl.ok && onContinue(shownUrl.url)}
          >
            Continue
          </Button>
        </>
      }
    >
      <p data-testid="prover-popup-text">{POPUP_TEXT}</p>
      <p className="small muted" data-testid="prover-popup-demo">
        {POPUP_DEMO_TEXT}
      </p>
      <p className="small" data-testid="prover-popup-action" data-circuit={request.circuit}>
        This market asks you to prove {ACTION_WORDS[request.circuit]} yourself.{' '}
        {waiting
          ? 'You already approved it; the market is waiting for the proof.'
          : 'Nothing is signed or sent until you continue.'}
      </p>
      {request.failure && (
        <Notice tone="danger" role="alert" data-testid="prover-popup-failure">
          {request.failure}
        </Notice>
      )}
      {left !== null && (
        <p className="small" data-testid="prover-popup-deadline">
          The market waits <span className="num">{elapsedClock(left)}</span> more; then it stops this action, sends
          nothing and spends no fee.
        </p>
      )}
      <ProverSetup
        engine={engine}
        expected={request.expected}
        circuit={request.circuit}
        initialUrl={initialUrl}
        initialConfirmed={!!saved?.privacyConfirmed}
        testIdPrefix="prover-popup"
        onUrlChange={setCurrent}
        onTested={(o: TestOutcome) => setPassed(o.ok ? o.url : null)}
      />
    </Dialog>
  );
}
