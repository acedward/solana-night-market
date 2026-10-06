// AA 00062 P4.4 (spec FR-011, US3): which prover URLs the page accepts. `http://localhost:*` and
// `http://127.0.0.1:*` (the package on this machine), or any `https://…` (an online prover). Anything
// else is refused before the page contacts it. A prover that is not on this machine sees the
// transaction's private details (amounts, coins), so the page asks the customer to confirm first.

export type ProverUrlCheck =
  | { ok: true; url: string; local: boolean }
  | { ok: false; reason: 'empty' | 'invalid' | 'http-remote' | 'scheme' | 'credentials' };

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

/** Check and normalise a prover URL as the customer typed it (no trailing slash, no query or hash). */
export function checkProverUrl(text: string): ProverUrlCheck {
  const t = text.trim();
  if (!t) return { ok: false, reason: 'empty' };
  let u: URL;
  try {
    u = new URL(t);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (u.username || u.password) return { ok: false, reason: 'credentials' };
  if (u.search || u.hash) return { ok: false, reason: 'invalid' };
  const local = u.protocol === 'http:' && LOCAL_HOSTS.has(u.hostname);
  if (u.protocol === 'http:' && !local) return { ok: false, reason: 'http-remote' };
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, reason: 'scheme' };
  if (!u.hostname) return { ok: false, reason: 'invalid' };
  const path = u.pathname.replace(/\/+$/, '');
  return { ok: true, url: `${u.protocol}//${u.host}${path}`, local };
}

/** Whether a (checked) URL is on this machine's loopback: no privacy confirmation, and the browser's
 *  local-network permission applies. */
export function isLocalProverUrl(url: string): boolean {
  const c = checkProverUrl(url);
  return c.ok && c.local;
}

/** The customer's words for a refused URL. */
export function proverUrlProblem(reason: Extract<ProverUrlCheck, { ok: false }>['reason']): string {
  switch (reason) {
    case 'empty':
      return 'Enter your proof server’s URL, for example http://localhost:6300.';
    case 'http-remote':
      return 'An online proof server must use https://. Plain http:// is allowed only for this computer (http://localhost or http://127.0.0.1).';
    case 'credentials':
      return 'Leave the user name and password out of the URL.';
    case 'scheme':
      return 'Use an http://localhost, http://127.0.0.1 or https:// URL.';
    default:
      return 'This is not a URL the page can use. Use http://localhost:<port>, http://127.0.0.1:<port> or https://….';
  }
}

/** What the page says before it uses a prover that is not on this computer (spec US3 scenario 1). */
export const PRIVACY_WARNING =
  'A proof server that is not on this computer sees the private details of every transaction it proves: the amounts, the tokens and the coins your account spends and receives. Use only one you trust.';
export const PRIVACY_CONFIRM = 'I understand: this proof server will see my transactions’ private details.';
