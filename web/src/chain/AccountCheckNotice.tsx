// What the page says about the market-account check (AA 00047 P9.S, audit C3): this browser read the
// account from Midnight itself and it is the market's own, with this wallet as its only device; or it
// is not, and nothing will be signed or sent for it.

import { Notice } from '../design/index.js';
import type { AccountCheckState } from './ChainContext.js';

export function AccountCheckNotice({ check, className }: { check: AccountCheckState; className?: string }) {
  if (check.status === 'ok')
    return (
      <p className={className ?? 'table-note'} data-testid="account-check" data-state="ok">
        Checked on Midnight by this browser: this site&apos;s account contract, with your wallet as its only device and
        your encryption key.
      </p>
    );
  if (check.status === 'failed')
    return (
      <Notice
        tone="danger"
        role="alert"
        title="This account does not pass this site's checks."
        className={className ?? 'panel-intro'}
        data-testid="account-check"
        data-state="failed"
      >
        <ul className="check-problems">
          {check.problems.map((p, i) => (
            <li key={`${p.code}-${i}`} data-testid="account-check-problem" data-code={p.code}>
              {p.message}
            </li>
          ))}
        </ul>
        Night Market will not sign anything for it. Do not send tokens to it.
      </Notice>
    );
  if (check.status === 'error')
    return (
      <Notice tone="warning" className={className ?? 'panel-intro'} data-testid="account-check" data-state="error">
        This browser could not read your account from Midnight: {check.message} Actions wait until it can.
      </Notice>
    );
  return check.status === 'checking' ? (
    <p className={className ?? 'table-note'} data-testid="account-check" data-state="checking">
      Checking your account on Midnight…
    </p>
  ) : null;
}
