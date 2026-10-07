// AA 00062 P4.3 (spec Edge Cases, FR-010): every way the customer's prover can fail, in plain words.
// One place, unit-tested (web/test/prover-client.test.ts). Each says what happened and what to do.

import { PROVER_COMMAND, PROVER_MEMORY_GB } from './constants.js';

export type ProverProblemCode =
  /** Nothing answered (stopped, Docker closed, a wrong port), or the browser hid why. */
  | 'unreachable'
  /** The browser's local-network permission for this site is denied (Chrome, Firefox; R4). */
  | 'blocked-permission'
  /** Safari: an https page may not call http://localhost (mixed content; R4). */
  | 'blocked-safari'
  /** This site's Content-Security-Policy does not allow the URL (the operator's setting). */
  | 'blocked-csp'
  /** Something answers, but it is not the Night Market prover package (no or another /version). */
  | 'not-a-package'
  /** Another proof-server version than the market's. */
  | 'wrong-version'
  /** Another key set than the market's. */
  | 'wrong-key-set'
  /** It does not hold the circuit this action needs. */
  | 'missing-circuit'
  /** Busy with another proof (429), or out of memory (503 out-of-memory). */
  | 'busy'
  | 'out-of-memory'
  /** Still starting its internal proof server (503 starting). */
  | 'starting'
  /** The package refused the request's key location (422 wrong-key). */
  | 'wrong-key'
  /** The package or its proof server failed (400/413/502/504, an unexpected answer). */
  | 'prover-error'
  /** The proof did not arrive before the market's deadline. */
  | 'late'
  /** The market checked the proof and refused it. */
  | 'invalid'
  /** AA 00062 (I-62a v2): the account changed while the prover proved (a deposit or a trade landed). */
  | 'stale'
  /** The customer closed the prover window. */
  | 'cancelled';

export const UPDATE_PACKAGE = `Update the package: ${PROVER_COMMAND}`;

const OOM = `Your prover is busy or out of memory (it needs about ${PROVER_MEMORY_GB} GB).`;

/** The customer's words for a problem; `detail` is the package's or the browser's own words, if any. */
export function proverProblemText(
  code: ProverProblemCode,
  ctx: { url?: string; detail?: string; brave?: boolean; expected?: { proofServer: string; keySet: string } } = {},
): string {
  const at = ctx.url ? ` at ${ctx.url}` : '';
  switch (code) {
    case 'unreachable':
      return `Your proof server did not answer${at}. Start it with the command below (Docker must be running), or check the URL.${
        ctx.brave ? ' In Brave, also allow this site to reach localhost: brave://settings/content/localhostAccess.' : ''
      }`;
    case 'blocked-permission':
      return `Your browser blocks this site from reaching apps on this computer (localhost), so it cannot use your proof server. Allow it in this site's settings (the padlock in the address bar), or use an online proof server (https://…).${
        ctx.brave ? ' In Brave: brave://settings/content/localhostAccess.' : ''
      }`;
    case 'blocked-safari':
      return 'Safari does not let a secure (https) site reach http://localhost. Use an online proof server (https://…), or Chrome or Firefox with the local one.';
    case 'blocked-csp':
      return `This site's security policy does not allow it to connect to ${ctx.url ?? 'this URL'}. The site's operator must allow proof servers in its Content-Security-Policy.`;
    case 'not-a-package':
      return `Something answers${at}, but it is not the Night Market prover package (it has no keys for the market's circuits). ${UPDATE_PACKAGE}`;
    case 'wrong-version':
      return `Your prover runs another proof-server version${ctx.detail ? ` (${ctx.detail})` : ''}${
        ctx.expected ? `; the market needs ${ctx.expected.proofServer}` : ''
      }. ${UPDATE_PACKAGE}`;
    case 'wrong-key-set':
      return `Your prover holds another key set${ctx.detail ? ` (${ctx.detail})` : ''}${
        ctx.expected ? `; the market needs ${shortKeySet(ctx.expected.keySet)}` : ''
      }. ${UPDATE_PACKAGE}`;
    case 'missing-circuit':
      return `Your prover does not hold the circuit this action needs. ${UPDATE_PACKAGE}`;
    case 'busy':
    case 'out-of-memory':
      return `${OOM}${ctx.detail ? ` (${ctx.detail})` : ''} Close other programs or give Docker more memory, then try again.`;
    case 'starting':
      return 'Your prover is still starting. Wait a few seconds and try again.';
    case 'wrong-key':
      return `Your prover refused this proof: its keys are not the ones this account uses. ${UPDATE_PACKAGE}`;
    case 'prover-error':
      return `Your prover failed${ctx.detail ? `: ${ctx.detail}` : ''}. Try again; if it keeps failing, restart it with the command below.`;
    case 'late':
      return 'Your prover did not finish before this action’s deadline, so the market stopped it. Nothing was sent and no fee was spent. Try again; a faster computer or an online proof server helps.';
    case 'invalid':
      return 'Your proof server returned an invalid proof, so the market refused it. Nothing was sent and no fee was spent.';
    case 'stale':
      return 'Your account changed while your proof server was proving (a deposit or a trade landed), so that proof no longer fits it. Nothing was sent and no fee was spent: send it again, and your proof server proves it once more.';
    case 'cancelled':
      return 'You closed the proof-server window, so nothing was signed or sent.';
  }
}

/** "21493588…5c5e": a key-set fingerprint, short. */
export const shortKeySet = (k: string) => (k.length > 16 ? `${k.slice(0, 8)}…${k.slice(-4)}` : k);

/** An error the prover part of an action ended with: its code and the customer's sentence. */
export class ProverError extends Error {
  override name = 'ProverError';
  constructor(
    readonly code: ProverProblemCode,
    message: string,
  ) {
    super(message);
  }
}
