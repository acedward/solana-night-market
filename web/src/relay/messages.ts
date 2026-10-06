// What the page says when the market's relay refuses or fails (plan P4-A, error states). One place,
// unit-tested: the relay's error codes (relay/src/app.ts, relay/src/queue/jobs.ts `PublicError`)
// become one clear sentence each, saying what happened and what the customer can do. Anything the
// relay words itself is kept, as a sentence.

import { WHOLE_COIN_EXIT, WITHDRAWS_DAILY_CAP_CODE } from '@nightmarket/core';

import { proverProblemText } from '../prover/messages.js';

/** "the market is low …" → "The market is low ….": the relay's messages start lower-case. */
export function sentence(text: string): string {
  const t = text.trim();
  if (!t) return t;
  const s = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?]$/.test(s) ? s : `${s}.`;
}

/** The coin a request pays with was already spent on Midnight (AA 00047 P11, `coin-spent`). */
const COIN_SPENT =
  'The coin this pays with was already spent on Midnight, so nothing was proven or sent. Refresh your balances and try again: this browser then picks another coin.';

/** "12 s", "5 minutes", "about 3 hours": a Retry-After in the customer's words. */
export function waitText(seconds: number | null | undefined, otherwise = 'a while'): string {
  if (!seconds || seconds <= 0) return otherwise;
  if (seconds < 90) return `${Math.ceil(seconds)} s`;
  if (seconds < 90 * 60) return `${Math.ceil(seconds / 60)} minutes`;
  return `about ${Math.round(seconds / 3600)} hours`;
}

/**
 * The customer's words for a refused request (an HTTP error from the relay). `retryAfterSeconds`
 * comes from the Retry-After header of a 429.
 */
export function relayErrorText(e: {
  status: number;
  code: string;
  message: string;
  detail?: string;
  retryAfterSeconds?: number | null;
}): string {
  switch (e.code) {
    case 'unreachable':
      return 'The market could not be reached. Check your connection and try again; nothing was sent.';
    case 'rate-limited': {
      const wait = e.retryAfterSeconds && e.retryAfterSeconds > 0 ? `${e.retryAfterSeconds} s` : 'a minute';
      return `The market is getting too many requests from this connection. Wait ${wait} and try again; nothing was sent.`;
    }
    case 'sponsor-low':
      return 'The market is low on the network-fee funds (DUST) it pays your fees with, so it has paused new actions. Nothing was sent and your balances are safe; try again later.';
    case 'sponsor-unavailable':
      return "The market's fee wallet is still starting up and cannot pay network fees yet. Nothing was sent; try again in a few minutes.";
    case 'busy':
      return 'The market is at capacity right now. Nothing was sent; try again in a few minutes.';
    case 'chain-unavailable':
      return 'The market cannot read Midnight right now. Try again shortly; your records in this browser are safe.';
    case 'history-too-long':
      // A known limit of this version: retrying does not help. Since AA 00047 P11 (R3-5) the relay reads
      // past the indexer's newest page and refuses only a history past its bound (100,000 actions).
      return 'Your account has more history than this version of Night Market can read (more than 100,000 actions on Midnight), so its balances can no longer be refreshed: they show the last refresh, and new coins will not appear. Nothing is lost: your coins stay on Midnight and your Export keeps the key to them. Keep your Export and ask the market; a later version reads the account again.';
    case 'payload-too-large':
      return 'The request was too large for the market to accept.';
    // AA 00047 P10 (audit round 2, R2-1/R2-2; relay lane P10.R): one request at a time per account,
    // per-account caps, and the failure budget. Each refuses BEFORE anything runs.
    case 'account-busy':
      return `Your account already has a request in progress at the market. Wait for it to finish (about ${waitText(e.retryAfterSeconds, 'a minute')}), then try again; nothing was sent.`;
    case 'open-offers-cap':
      return 'Your account already has as many open offers as the market lists at once. Cancel them, or wait until one is taken or expires; nothing was sent.';
    case 'makes-daily-cap':
      return `Your account has made as many offers in the last 24 hours as the market allows. Try again in ${waitText(e.retryAfterSeconds)}; nothing was sent.`;
    case 'cancels-daily-cap':
      return `Your account has cancelled as many times in the last 24 hours as the market pays for. Your open offers still stop working at the expiry you approved; you can cancel again in ${waitText(e.retryAfterSeconds)}. Nothing was sent.`;
    // AA 00047 P11 (owner decision Q46 A; relay lane P11.R, @nightmarket/core `withdraw-allowance`):
    // the daily allowance of withdrawals the market pays for. Said only once the market refuses one
    // for it; `detail` says whether this token's one whole-coin withdrawal of the day is still open.
    case WITHDRAWS_DAILY_CAP_CODE:
      return e.detail === WHOLE_COIN_EXIT.open
        ? `The market pays the network fee for a limited number of withdrawals per account each day, and your account has used today's. Nothing was sent, and your tokens are safe in your account. You can still withdraw one whole coin of this token today (all of it, so nothing is left over), or withdraw as usual again in ${waitText(e.retryAfterSeconds)}.`
        : `The market pays the network fee for a limited number of withdrawals per account each day. Your account has used today's, and its one extra withdrawal of this token today as well. Nothing was sent, and your tokens are safe in your account. You can withdraw again in ${waitText(e.retryAfterSeconds)}.`;
    // AA 00047 P11 (relay lane P11.R, R3-7): takes the exchange refused for a reason the market could
    // not pin on the taker are capped per account and day.
    case 'takes-unsettled-cap':
      return `Several of your takes in the last 24 hours could not be settled by the exchange, so the market is pausing new takes from your account. Try again in ${waitText(e.retryAfterSeconds, 'a day')}; your other actions still work, and nothing was sent.`;
    case 'coin-spent':
      return COIN_SPENT;
    // AA 00062 (I-62a): the market's answers to a proof from the customer's prover.
    case 'client-proof-invalid':
      return proverProblemText('invalid');
    case 'client-proof-late':
      return proverProblemText('late');
    // AA 00047 P11.F (audit round 4, R4-1 / R4-3): refused up front, before anything runs.
    case 'prover-busy':
      return `The market's prover is busy right now, so your request could not start before the expiry you approved. Nothing was sent; try again in ${waitText(e.retryAfterSeconds, 'a minute')} and approve it once more.`;
    case 'exchange-busy':
      return `The exchange's settlement service is not taking more settlements right now (it allows a limited number a day). Nothing was sent and your coins did not move; try again in ${waitText(e.retryAfterSeconds, 'a few minutes')}.`;
    case 'restores-daily-cap':
      return `Your account's encryption key was restored as many times in the last 24 hours as the market pays for. Try again in ${waitText(e.retryAfterSeconds)}; nothing was sent.`;
    case 'failure-budget':
      return `Several recent requests from this wallet or account failed, so the market is pausing new ones for ${waitText(e.retryAfterSeconds)}. Withdrawals, cancels and key restores still work; nothing was sent.`;
    case 'registration-daily-cap':
      return 'The market has opened as many accounts today as it can. Try again tomorrow (UTC); nothing was sent.';
    case 'registration-client-cap':
      return 'This connection has opened as many accounts today as the market allows. Try again tomorrow (UTC); nothing was sent.';
    case 'registration-busy':
      return `The market is opening other accounts right now. Try again in ${waitText(e.retryAfterSeconds, 'a minute')}; nothing was sent.`;
    // The demo-token claim (AA 00047, packages/core/src/demo-tokens.ts).
    case 'demo-disabled':
      return 'This market is not handing out demo tokens right now. Nothing was sent.';
    case 'demo-already-claimed':
      return 'This wallet has already had its demo tokens: the market gives one pack per wallet.';
    case 'demo-daily-cap':
      return 'Today’s demo tokens are all given out. Try again tomorrow (UTC); nothing was sent.';
    case 'unauthorised':
      switch (e.detail) {
        case 'expired':
          return 'Your signature is for an older state of your account (another action went through, or it expired). Nothing was sent: try again and sign once more.';
        case 'replayed':
          return 'This signature was already used, so the market did not act on it again.';
        case 'wrong-signer':
          return 'The signature is not from a device of this account. Connect the wallet that owns the account and try again.';
        case 'unknown-nonce':
          return 'The market restarted since this was signed, so the signature is no longer valid. Try again and sign once more.';
        case 'not-supported':
          return 'This market is not accepting wallet signatures right now. Nothing was sent.';
        case 'bad-signature':
          return 'The market could not verify your wallet’s signature for this request. Nothing was sent; try again.';
        default:
          return sentence(e.message);
      }
    default:
      return e.status >= 500 && !e.message
        ? `The market answered with an error (HTTP ${e.status}). Try again later.`
        : sentence(e.message || `The market answered ${e.status}`);
  }
}

/**
 * The customer's words for a job that failed at the relay (`JobView.error`). The relay words these
 * itself (PublicError); a few get a lead that says what it means for the customer.
 */
export function jobErrorText(error: { code: string; message: string } | undefined, fallback: string): string {
  if (!error) return fallback;
  switch (error.code) {
    case 'internal-error':
      return 'The market could not complete this. Nothing more will happen to it; try again, and if it keeps failing ask the market.';
    case 'exchange-busy':
    case 'exchange-error':
    case 'exchange-unavailable':
    case 'take-refused':
      return sentence(error.message);
    // AA 00047 P10 (relay lane P10.R): failures that are the market's, never the customer's.
    case 'market-unavailable':
      return "The market's prover or its connection to Midnight failed while working on this. It does not count against you: try again shortly. Your balances always come from Midnight.";
    case 'failure-budget':
      return 'The market paused this request because several recent requests from this wallet or account failed. Nothing ran; you can send it again later. Withdrawals, cancels and key restores are never paused.';
    // AA 00047 P11 (relay lane P11.R, R3-7): the coin was spent before anything was proven.
    case 'coin-spent':
      return COIN_SPENT;
    // AA 00047 P11.F2 (audit round 4b R4b-1): a take that asks to be paid a coin the account already
    // received can never settle. This page never sends one (a new coin every time).
    case 'want-reused':
      return 'This take asked to be paid a coin your account has already received once, so it could never settle. Nothing was proven or sent, and it counts as a failed request. Take again from this page: it asks for a new coin every time.';
    // AA 00047 P11.F (R4-2): the account's own offer was taken while this take was settling.
    case 'take-raced':
      return 'One of your own offers was taken at the same moment, so this take could no longer settle. It does not count against you: refresh your balances and take again.';
    case 'demo-tokens-settling':
      return 'An earlier delivery of your demo tokens may still land on Midnight, so the market is not minting them again yet. Refresh in a few minutes; it does not count against you.';
    // AA 00062 (I-62a "Job errors"): the customer's own prover. Nothing was submitted, no fee was
    // proven and no DUST was spent for any of them.
    case 'client-proof-missing':
      return 'The market waited for your proof server, but this page never asked it for the proof (it was closed, or lost its connection). Nothing was sent and no fee was spent: try again with this page open.';
    case 'client-proof-late':
      return proverProblemText('late');
    case 'client-proof-invalid':
      return proverProblemText('invalid');
    default:
      return sentence(error.message);
  }
}
