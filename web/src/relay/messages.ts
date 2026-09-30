// What the page says when the market's relay refuses or fails (plan P4-A, error states). One place,
// unit-tested: the relay's error codes (relay/src/app.ts, relay/src/queue/jobs.ts `PublicError`)
// become one clear sentence each, saying what happened and what the customer can do. Anything the
// relay words itself is kept, as a sentence.

/** "the market is low …" → "The market is low ….": the relay's messages start lower-case. */
export function sentence(text: string): string {
  const t = text.trim();
  if (!t) return t;
  const s = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?]$/.test(s) ? s : `${s}.`;
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
      // A known limit of this version (RUNBOOK §12, plan question Q27): retrying does not help.
      return 'Your account has more history than this version of Night Market can read (500 or more actions on Midnight), so its balances can no longer be refreshed: they show the last refresh, and new coins will not appear. Nothing is lost: your coins stay on Midnight and your Export keeps the key to them. Keep your Export and ask the market; a later version reads the account again.';
    case 'payload-too-large':
      return 'The request was too large for the market to accept.';
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
          return 'Signing with a Solana wallet is not available on this site yet. Nothing was sent.';
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
    default:
      return sentence(error.message);
  }
}
