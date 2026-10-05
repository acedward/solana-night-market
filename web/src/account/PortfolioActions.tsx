// The Portfolio's actions (AA 00060 P12.1c, spec FR-023; owner, 2026-10-05: "On the portfolio let's show
// only a list of actions"). The page shows the holdings and EXACTLY these five actions, in this order;
// each opens its own flow as a sub-page (`#account?action=<id>`, with a way back), never an inline form:
//
//   1. send           Send tokens to a Midnight wallet (the withdrawal to a Midnight wallet)
//   2. bridge-in      Bridge in from Solana: make your tokens private
//   3. bridge-out     Bridge out to Solana
//   4. mint-midnight  Mint Midnight tokens (the free demo pack; offered ONLY here, owner: "Keep Free demo
//                     tokens only in the Portfolio View")
//   5. mint-solana    Mint Solana tokens (FR-024, plan P13, another lane: this page only offers the action.
//                     The seam is `SplFaucetSeam`, the Portfolio's `splFaucet` prop: enabled when the relay
//                     offers `spl-faucet`, otherwise shown disabled, "Not available on this market")
//
// An action this market cannot do is listed, disabled, with the reason. An action with open records (a
// bridge-in or bridge-out in progress) says so, so pending transfers stay one click away.

import { useEffect, useState, type ComponentType } from 'react';

import { Icon } from '../design/index.js';

export const PORTFOLIO_ACTIONS = [
  {
    id: 'send',
    label: 'Send tokens to a Midnight wallet',
    hint: 'Withdraw private or public tokens to a Midnight wallet, such as Lace.',
  },
  {
    id: 'bridge-in',
    label: 'Bridge in from Solana: make your tokens private',
    hint: 'Move SPL tokens from your Solana wallet into your private account.',
  },
  {
    id: 'bridge-out',
    label: 'Bridge out to Solana',
    hint: 'Send bridged tokens back to your Solana wallet.',
  },
  {
    id: 'mint-midnight',
    label: 'Mint Midnight tokens',
    hint: 'Free demo tokens: a test pack, minted into your account on Midnight.',
  },
  {
    id: 'mint-solana',
    label: 'Mint Solana tokens',
    hint: 'Test SPL tokens, minted to your Solana wallet.',
  },
] as const;

export type PortfolioActionId = (typeof PORTFOLIO_ACTIONS)[number]['id'];

const IDS: readonly string[] = PORTFOLIO_ACTIONS.map((a) => a.id);

/** The sub-page of an action. */
export const actionHref = (id: PortfolioActionId): string => `#account?action=${id}`;

/** The action the address names (`#account?action=<id>`), or null (the Portfolio itself). */
export function actionFromHash(hash: string = window.location.hash): PortfolioActionId | null {
  const [route, query = ''] = hash.replace(/^#/, '').split('?');
  if (route !== 'account') return null;
  const id = new URLSearchParams(query).get('action');
  return id && IDS.includes(id) ? (id as PortfolioActionId) : null;
}

/** The open action, following the address. */
export function usePortfolioAction(): PortfolioActionId | null {
  const [action, setAction] = useState<PortfolioActionId | null>(() => actionFromHash());
  useEffect(() => {
    const on = () => setAction(actionFromHash());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return action;
}

/** FR-024's flow, supplied by the "Mint Solana tokens" lane (plan P13). */
export interface SplFaucetSeam {
  /** Whether this market's relay offers the `spl-faucet` action (null while it is being checked). */
  offered: boolean | null;
  /** The flow the action opens. */
  Flow: ComponentType<{ account: string; walletAddress: string | null; onDone?: () => void }>;
}

/** What each action can do right now: null when it can be opened, else why not. `pending` counts open records. */
export interface ActionState {
  disabled: string | null;
  pending?: number;
}

export const NOT_ON_THIS_MARKET = 'Not available on this market.';

export function PortfolioActionList({ states }: { states: Readonly<Record<PortfolioActionId, ActionState>> }) {
  return (
    <ol className="portfolio-actions" aria-label="What you can do" data-testid="portfolio-actions">
      {PORTFOLIO_ACTIONS.map((a) => {
        const s = states[a.id];
        const body = (
          <>
            <span className="portfolio-action-text">
              <span className="portfolio-action-label" data-testid="portfolio-action-label">
                {a.label}
              </span>
              <span className="portfolio-action-hint">{s.disabled ?? a.hint}</span>
              {s.pending ? (
                <span
                  className="portfolio-action-pending"
                  data-testid="portfolio-action-pending"
                  data-count={s.pending}
                >
                  {s.pending === 1 ? 'One transfer in progress' : `${s.pending} transfers in progress`}
                </span>
              ) : null}
            </span>
            {s.disabled ? null : <Icon name="chevronRight" className="portfolio-action-go" />}
          </>
        );
        return (
          <li key={a.id}>
            {s.disabled ? (
              <div
                className="portfolio-action is-disabled"
                aria-disabled="true"
                data-testid="portfolio-action"
                data-action={a.id}
                data-enabled="false"
              >
                {body}
              </div>
            ) : (
              <a
                className="portfolio-action"
                href={actionHref(a.id)}
                data-testid="portfolio-action"
                data-action={a.id}
                data-enabled="true"
              >
                {body}
              </a>
            )}
          </li>
        );
      })}
    </ol>
  );
}
