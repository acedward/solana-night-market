// AA 00062 P4.3 (plan I-62b, R4): the page's client of the customer's prover package. Only the page
// calls the customer's URL (spec FR-003): `GET /version` for the Test, `POST /prove-circuit` for a
// proof, and nothing else. Request and answer bodies are never logged.
//
// Browsers (plan P0.5, R4): Chrome >= 142 and Firefox >= 153 ask the customer before an https page
// reaches http://localhost; Brave blocks it until the customer turns it on; Safari blocks it outright
// (mixed content). Every refusal looks like a network failure (`TypeError`), the same as "nothing is
// listening", so before the first call to a localhost URL the page asks the browser for the
// permission's state (`loopback-network`, then the older `local-network-access`; an unknown name
// throws and is skipped), and after a failure it asks again to say which it was.

import { z } from 'zod';

import { MAX_BASE64_CHARS, POST_MARGIN_MS, VERSION_TIMEOUT_MS, type ClientCircuit } from './constants.js';
import { ProverError, proverProblemText, type ProverProblemCode } from './messages.js';
import { isLocalProverUrl } from './url.js';

/** I-62b `GET /version`. */
export const PackageVersionSchema = z.object({
  api: z.number().int(),
  package: z.string().max(64),
  proofServer: z.string().max(64),
  keySet: z.string().max(80),
  circuits: z.array(z.string().max(80)).max(32),
  busy: z.boolean().optional(),
  machine: z
    .object({
      cpus: z.number().int().nonnegative().nullable().optional(),
      memoryBytes: z.number().nonnegative().nullable().optional(),
    })
    .nullable()
    .optional(),
});
export type PackageVersion = z.infer<typeof PackageVersionSchema>;

/** The body of I-62b `POST /prove-circuit`: I-62a's fields, verbatim. */
export interface ProveCircuitBody {
  circuit: ClientCircuit;
  proofRequest: string;
  keyMaterialOffset: number;
}

export type PermissionStateName = 'granted' | 'prompt' | 'denied';

export interface PackageDeps {
  fetchImpl: typeof fetch;
  /** `navigator.permissions`, or null where there is none. */
  permissions: Pick<Permissions, 'query'> | null;
  userAgent: string;
  /** Brave says so on `navigator.brave`. */
  brave: boolean;
  /** Where the browser reports Content-Security-Policy violations (`document`), or null. */
  cspEvents: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> | null;
  /** Whether the page itself is https (Safari then refuses http://localhost). */
  securePage: boolean;
  /** Whether the page itself is served from this computer (a developer's localhost): the browser's
   *  local-network permission does not apply to loopback-to-loopback calls, so it is not asked. */
  loopbackPage: boolean;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export function browserPackageDeps(): PackageDeps {
  const nav = typeof navigator === 'undefined' ? null : navigator;
  return {
    fetchImpl: (...a) => fetch(...a),
    permissions: nav?.permissions ?? null,
    userAgent: nav?.userAgent ?? '',
    brave: !!(nav as unknown as { brave?: unknown } | null)?.brave,
    cspEvents: typeof document === 'undefined' ? null : document,
    securePage: typeof location !== 'undefined' && location.protocol === 'https:',
    loopbackPage: typeof location !== 'undefined' && ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname),
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

/** The local-network permission's state for this site, or null when the browser has none to ask about. */
export async function loopbackPermission(permissions: PackageDeps['permissions']): Promise<PermissionStateName | null> {
  if (!permissions) return null;
  for (const name of ['loopback-network', 'local-network-access']) {
    try {
      const s = await permissions.query({ name } as unknown as PermissionDescriptor);
      if (s.state === 'granted' || s.state === 'prompt' || s.state === 'denied') return s.state;
    } catch {
      /* an unknown permission name throws: try the next one */
    }
  }
  return null;
}

/** Safari (desktop or iOS), and not a Chromium or Firefox that says "Safari" too. */
export const isSafari = (ua: string) =>
  /Safari\//.test(ua) && !/(Chrome|Chromium|CriOS|FxiOS|Edg|OPR|Firefox)\//.test(ua);

/** Collects this site's Content-Security-Policy refusals of one origin while a call runs. */
function watchCsp(events: PackageDeps['cspEvents'], url: string) {
  let origin = '';
  try {
    origin = new URL(url).origin;
  } catch {
    /* checked before */
  }
  let seen = false;
  const on = (e: Event) => {
    const v = e as SecurityPolicyViolationEvent;
    const directive = v.effectiveDirective || v.violatedDirective || '';
    if (!directive.startsWith('connect-src')) return;
    try {
      if (new URL(v.blockedURI).origin === origin) seen = true;
    } catch {
      if (v.blockedURI && origin.startsWith(v.blockedURI)) seen = true;
    }
  };
  events?.addEventListener('securitypolicyviolation', on);
  return {
    seen: () => seen,
    stop: () => events?.removeEventListener('securitypolicyviolation', on),
  };
}

/** Why a call to the customer's URL failed at the network level (R4). */
async function networkProblem(url: string, deps: PackageDeps, csp: { seen(): boolean }): Promise<ProverProblemCode> {
  // The browser reports a CSP refusal as an event, queued beside the failed fetch: let it arrive.
  await deps.sleep(50);
  if (csp.seen()) return 'blocked-csp';
  if (isLocalProverUrl(url)) {
    if (!deps.loopbackPage && (await loopbackPermission(deps.permissions)) === 'denied') return 'blocked-permission';
    if (deps.securePage && isSafari(deps.userAgent)) return 'blocked-safari';
  }
  return 'unreachable';
}

const errorBody = z.object({ error: z.object({ code: z.string(), message: z.string() }) });

/** The package's error answer: its code and words (at most 300 characters of them). */
async function packageError(res: Response): Promise<{ code: string; message: string }> {
  const body: unknown = await res.json().catch(() => null);
  const e = errorBody.safeParse(body);
  return e.success
    ? { code: e.data.error.code, message: e.data.error.message.slice(0, 300) }
    : { code: '', message: `HTTP ${res.status}` };
}

export type VersionResult =
  { ok: true; version: PackageVersion } | { ok: false; code: ProverProblemCode; detail?: string };

/**
 * `GET <url>/version` within 5 s (I-62b). A localhost URL whose permission is denied is not called
 * at all.
 */
export async function fetchPackageVersion(url: string, deps: PackageDeps): Promise<VersionResult> {
  if (isLocalProverUrl(url) && !deps.loopbackPage && (await loopbackPermission(deps.permissions)) === 'denied')
    return { ok: false, code: 'blocked-permission' };
  const csp = watchCsp(deps.cspEvents, url);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), VERSION_TIMEOUT_MS);
  try {
    let res: Response;
    try {
      res = await deps.fetchImpl(`${url}/version`, { cache: 'no-store', signal: ctl.signal, credentials: 'omit' });
    } catch {
      if (ctl.signal.aborted) return { ok: false, code: 'unreachable', detail: 'no answer within 5 s' };
      return { ok: false, code: await networkProblem(url, deps, csp) };
    }
    if (!res.ok) return { ok: false, code: 'not-a-package', detail: `HTTP ${res.status}` };
    const body: unknown = await res.json().catch(() => null);
    const v = PackageVersionSchema.safeParse(body);
    if (!v.success || v.data.api !== 1) return { ok: false, code: 'not-a-package' };
    return { ok: true, version: v.data };
  } finally {
    clearTimeout(timer);
    csp.stop();
  }
}

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const PROOF_TAG = 'midnight:proof-versioned:';

/** Whether a base64 string decodes to bytes that start with `tag`. */
export function base64StartsWith(b64: string, tag: string): boolean {
  const head = b64.slice(0, Math.ceil(tag.length / 3) * 4 + 4);
  let text: string;
  try {
    text = atob(head.length % 4 === 0 ? head : head.slice(0, head.length - (head.length % 4)));
  } catch {
    return false;
  }
  return text.startsWith(tag);
}

/** What the package answered for one proof. */
export interface ProvedCircuit {
  /** The tagged ProofVersioned bytes, standard base64 (I-62a `proof`). */
  proof: string;
  proveMs: number | null;
}

const ProveAnswerSchema = z.object({ proof: z.string().max(MAX_BASE64_CHARS), proveMs: z.number().optional() });

/**
 * `POST <url>/prove-circuit` (I-62b) until the hand-off's deadline (`deadlineMs`, unix ms), keeping
 * `POST_MARGIN_MS` to send the proof on. A busy prover (429) or one still starting (503 `starting`)
 * is asked again while there is time (`onWait` says so). Throws a `ProverError`.
 */
export async function proveOnPackage(
  url: string,
  body: ProveCircuitBody,
  deadlineMs: number,
  deps: PackageDeps,
  onWait?: (code: 'busy' | 'starting', seconds: number) => void,
): Promise<ProvedCircuit> {
  function fail(code: ProverProblemCode, detail?: string): never {
    throw new ProverError(code, proverProblemText(code, { url, ...(detail ? { detail } : {}), brave: deps.brave }));
  }
  for (;;) {
    const left = deadlineMs - POST_MARGIN_MS - deps.now();
    if (left <= 0) fail('late');
    const csp = watchCsp(deps.cspEvents, url);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), left);
    let res: Response;
    try {
      res = await deps.fetchImpl(`${url}/prove-circuit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          circuit: body.circuit,
          proofRequest: body.proofRequest,
          keyMaterialOffset: body.keyMaterialOffset,
        }),
        cache: 'no-store',
        credentials: 'omit',
        signal: ctl.signal,
      });
    } catch {
      if (ctl.signal.aborted) fail('late');
      fail(await networkProblem(url, deps, csp));
    } finally {
      clearTimeout(timer);
      csp.stop();
    }
    if (res.ok) {
      const answer = ProveAnswerSchema.safeParse(await res.json().catch(() => null));
      if (!answer.success || !BASE64_RE.test(answer.data.proof) || !base64StartsWith(answer.data.proof, PROOF_TAG))
        fail('invalid');
      return { proof: answer.data.proof, proveMs: answer.data.proveMs ?? null };
    }
    const e = await packageError(res);
    const retry = (code: 'busy' | 'starting', seconds: number) => {
      // Ask again only when a proof (about 20 s, often more) still fits before the deadline.
      if (deadlineMs - POST_MARGIN_MS - deps.now() - seconds * 1000 < 30_000) return false;
      onWait?.(code, seconds);
      return true;
    };
    if (res.status === 429) {
      const after = Number(res.headers.get('retry-after') ?? '');
      const seconds = Number.isFinite(after) && after > 0 ? Math.min(after, 120) : 30;
      if (retry('busy', seconds)) {
        await deps.sleep(seconds * 1000);
        continue;
      }
      fail('busy');
    }
    if (res.status === 503 && e.code === 'starting') {
      if (retry('starting', 5)) {
        await deps.sleep(5_000);
        continue;
      }
      fail('starting');
    }
    if (res.status === 503) fail('out-of-memory');
    if (res.status === 422 && e.code === 'wrong-key') fail('wrong-key');
    if (res.status === 404 && e.code === 'unknown-circuit') fail('missing-circuit');
    if (res.status === 504) fail('prover-error', 'it timed out');
    fail('prover-error', e.message);
  }
}
