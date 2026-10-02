// The About page (route #about; AA 00047 P11.D, questions Q48 A and Q58): what the market is, in a
// few lines, and its known limitations in plain words. It matches the README's "Known limitations"
// section. It is reached from the footer on every page; the header keeps its four sections.
//
// It names no per-account allowance (the owner's decision Q46: the page explains the withdrawal
// allowance only once a customer reaches it).

import { useEffect } from 'react';

import { Notice, PageHead, Panel } from '../design/index.js';

/** One known limitation: a short title and one or two plain sentences. */
const LIMITS: ReadonlyArray<{ id: string; title: string; text: string }> = [
  {
    id: 'refused-account',
    title: 'A refused new account stays refused.',
    text: 'If this site refuses your new account when it opens (for example because someone sent a deposit to it in its first few blocks), it stays refused, and this wallet cannot open another account here. Nothing is lost: the account held nothing yet.',
  },
  {
    id: 'key-change',
    title: 'Approve "Rotate encryption key" only on this site.',
    text: "That message changes the key that reads your account's private notes. A page that pays for the change itself could read the notes that come after it. It cannot move your funds, and this site will offer to put your own key back.",
  },
  {
    id: 'withdraw-key',
    title: 'Withdrawals: the market could hide a coin, not take it.',
    text: "Your approval names the recipient, the token and the amount. The key the recipient's wallet uses to find the coin is not part of it, so a dishonest market server could make the coin hard for that wallet to find. It cannot send it anywhere else or spend it.",
  },
  {
    id: 'indexer',
    title: "The page trusts Midnight's public indexer.",
    text: "Your browser reads your account and its history from Midnight's public indexer and checks what it can, but it is not a full node: it trusts the indexer to report the chain faithfully.",
  },
  {
    id: 'long-history',
    title: 'Very long histories.',
    text: 'An account with more than 500 actions is read in parts. That path is tested with recorded histories, not yet with a live account that large.',
  },
  {
    id: 'sign-in',
    title: 'Sign-in messages.',
    text: 'Opening an account and claiming demo tokens use a one-time sign-in message. In rare cases a copy of your own sign-in message could be accepted again for up to 10 minutes. Only you hold it, and it moves no funds.',
  },
  {
    id: 'fees',
    title: 'The market pays every fee, within limits.',
    text: 'To stay open for everyone, the market limits the actions it pays for, per account and per day. If you reach a limit, the page says when you can try again. The counts start over when the market restarts.',
  },
  {
    id: 'busy-prover',
    title: 'One prover for the whole market.',
    text: "Every action waits its turn on the market's one prover. Trades go first, and a trade that could not start before the expiry you approved is refused at once, so you can approve it again. When many accounts keep the prover busy, a withdrawal or a cancel can wait a few minutes; when the exchange stops taking settlements for the day, trades pause for a few minutes.",
  },
  {
    id: 'busy-takes',
    title: 'Many trades at once can make the market say "busy".',
    text: 'When many new accounts send trades at the same moment, the market may answer that its prover is busy instead of queuing yours. Nothing is sent or charged; try again a little later.',
  },
  {
    id: 'exchange-limit',
    title: "The exchange's daily limit is shared.",
    text: 'The test exchange settles a limited number of trades a day for everyone who uses it, not only for this market. If others use it up, trades pause here until it resets. Your coins stay where they are, and offers, cancels and withdrawals still work.',
  },
  {
    id: 'restarts',
    title: 'Restarts.',
    text: "The market's prover is restarted from time to time. An action caught by a restart fails without counting against you, and you can try again.",
  },
  {
    id: 'demo-tokens',
    title: 'Demo tokens.',
    text: 'If this market is set to deliver demo tokens through its own wallet (not the default), a delivery retried after a failure may be held back for the operator to finish.',
  },
  {
    id: 'one-offer',
    title: 'One live offer at a time, one coin per payment.',
    text: 'Coins are not merged. Phantom accounts on a Ledger device are not supported yet.',
  },
  {
    id: 'your-data',
    title: 'Your data lives only in this browser.',
    text: 'Export it on Your data after every change: without it, clearing this browser loses the key that finds your coins.',
  },
  {
    id: 'stagenet-check',
    title: 'A final check is still to come.',
    text: "The full flow worked on Midnight stagenet with an earlier version of the account's keys. The same check with the current keys is still to be run.",
  },
];

export function About({ networkName }: { networkName: string }) {
  // Reached from the footer, at the bottom of a page: start at the top.
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, []);
  return (
    <section aria-labelledby="about-title" data-testid="about">
      <PageHead
        eyebrow="About"
        title="About Night Market"
        titleId="about-title"
        lede="A create-and-trade market on Midnight that your Solana wallet controls. Your wallet only signs short messages you can read; it needs no SOL."
      />

      <Notice tone="warning" title="A test, with test tokens." className="panel-intro" data-testid="about-testnet">
        Night Market is a proof of concept on {networkName}, a test network. Its tokens are free test tokens from public
        faucets and have no value. Do not use it for anything real.
      </Notice>

      <Panel title="How it works" data-testid="about-how">
        <ul className="onboarding">
          <li>
            <strong>Your Solana wallet controls a Midnight account</strong>
            Phantom signs one readable message per action. The account checks that signature itself, on Midnight. Night
            Market never sends a Solana transaction.
          </li>
          <li>
            <strong>The market proves and pays</strong>
            Its server builds each action&apos;s proof and pays the Midnight fee. It cannot act without your
            wallet&apos;s approval.
          </li>
          <li>
            <strong>Your browser checks the chain</strong>
            The page reads your account, its coins and its trades from Midnight&apos;s public indexer itself, not from
            the market&apos;s server.
          </li>
        </ul>
      </Panel>

      <Panel title="Known limitations" data-testid="about-limits">
        <ul className="about-limits">
          {LIMITS.map((l) => (
            <li key={l.id} data-testid="about-limit" data-limit={l.id}>
              <strong>{l.title}</strong> {l.text}
            </li>
          ))}
        </ul>
      </Panel>
    </section>
  );
}
