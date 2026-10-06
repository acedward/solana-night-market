// AA 00062 P4 (spec FR-008-FR-013; plan I-62a, I-62b, R4), the page's side of "bring your own ZK prover":
// the URL rules, the per-browser setting (never in the backup), the package client and its errors, the
// Test, the gate before signing, the hand-off, and the words the customer reads. The walkthroughs in
// the browser are test/e2e/prover.spec.ts.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { JobView } from '@nightmarket/core';

import { ACTIVITY_TITLE, ActivityStore, stageWords } from '../src/activity/activity.js';
import { makeOffer, takeOffer } from '../src/trade/operations.js';
import {
  waitWithProver,
  withdrawToWallet,
  withdrawUnshieldedToWallet,
  type OperationEnv,
} from '../src/passport/operations.js';
import {
  ClientProver,
  PINNED_EXPECTATION,
  elapsedClock,
  progressWords,
  testProver,
  type ClientProofProgress,
  type PopupRequest,
} from '../src/prover/client-prover.js';
import {
  ACTION_CIRCUIT,
  CLIENT_CIRCUITS,
  DEFAULT_PROVER_URL,
  PINNED_KEY_SET,
  PROVER_COMMAND,
  PROVER_IMAGE,
} from '../src/prover/constants.js';
import { clientProvingOf, type ClientProofRequest, type HandOffJobView } from '../src/prover/i62a.js';
import { ProverError, proverProblemText } from '../src/prover/messages.js';
import {
  base64StartsWith,
  fetchPackageVersion,
  isSafari,
  loopbackPermission,
  proveOnPackage,
  type PackageDeps,
} from '../src/prover/package-client.js';
import { PROVER_SETTING_KEY, ProverSettings, type ProverSetting } from '../src/prover/settings.js';
import { checkProverUrl } from '../src/prover/url.js';
import { RelayClient, RelayError } from '../src/relay/client.js';
import { jobErrorText } from '../src/relay/messages.js';
import { LocalStore } from '../src/store/store.js';
import { formatShieldedAddress, formatUnshieldedAddress } from '@nightmarket/core';

import { fakeSigning } from './fake-signing.js';

const LOCAL = 'http://localhost:6300';
const ONLINE = 'https://prover.example';
const ME = { network: 'stagenet', owner: '48'.repeat(32) };
const PROOF = btoa('midnight:proof-versioned:' + 'x'.repeat(40));

const version = (over: Record<string, unknown> = {}) => ({
  api: 1,
  package: '0.1.0',
  proofServer: '9.0.0-rc.8',
  keySet: PINNED_KEY_SET,
  circuits: [...CLIENT_CIRCUITS],
  busy: false,
  machine: { cpus: 8, memoryBytes: 16 * 1024 ** 3 },
  ...over,
});

const reply = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;

function deps(handler: Handler, over: Partial<PackageDeps> = {}) {
  const calls: Array<{ url: string; method: string; body: string | null }> = [];
  const d: PackageDeps = {
    fetchImpl: (async (u: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(u), method: init?.method ?? 'GET', body: (init?.body as string) ?? null });
      return handler(String(u), init);
    }) as typeof fetch,
    permissions: null,
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/150.0 Safari/537.36',
    brave: false,
    cspEvents: null,
    securePage: true,
    loopbackPage: false,
    now: () => Date.now(),
    sleep: async () => {},
    ...over,
  };
  return { d, calls };
}

const refuse: Handler = () => {
  throw new TypeError('Failed to fetch');
};

beforeEach(() => window.localStorage.clear());

describe('the URL rules (P4.4, spec FR-011)', () => {
  it('accepts http://localhost, http://127.0.0.1 and https only, normalised', () => {
    expect(checkProverUrl(' http://localhost:6300/ ')).toEqual({ ok: true, url: LOCAL, local: true });
    expect(checkProverUrl('http://127.0.0.1:7000')).toEqual({ ok: true, url: 'http://127.0.0.1:7000', local: true });
    expect(checkProverUrl('http://localhost')).toEqual({ ok: true, url: 'http://localhost', local: true });
    expect(checkProverUrl('https://prover.example/base/')).toEqual({
      ok: true,
      url: 'https://prover.example/base',
      local: false,
    });
    expect(checkProverUrl('https://localhost:8443')).toMatchObject({ ok: true, local: false });
  });
  it('refuses plain http off this computer, other schemes, credentials, queries and garbage', () => {
    expect(checkProverUrl('http://prover.example:6300')).toEqual({ ok: false, reason: 'http-remote' });
    expect(checkProverUrl('http://192.168.1.10:6300')).toEqual({ ok: false, reason: 'http-remote' });
    expect(checkProverUrl('http://[::1]:6300')).toEqual({ ok: false, reason: 'http-remote' });
    expect(checkProverUrl('http://localhost.evil.example')).toEqual({ ok: false, reason: 'http-remote' });
    expect(checkProverUrl('ftp://prover.example')).toEqual({ ok: false, reason: 'scheme' });
    expect(checkProverUrl('https://user:pw@prover.example')).toEqual({ ok: false, reason: 'credentials' });
    expect(checkProverUrl('https://prover.example/?x=1')).toEqual({ ok: false, reason: 'invalid' });
    expect(checkProverUrl('localhost:6300')).toMatchObject({ ok: false });
    expect(checkProverUrl('')).toEqual({ ok: false, reason: 'empty' });
  });
});

describe('the setting: this browser only, never in the backup (P4.1, spec FR-012, owner Q3)', () => {
  const setting: ProverSetting = {
    url: LOCAL,
    privacyConfirmed: false,
    lastTest: { ok: true, at: 1, package: '0.1.0', proofServer: '9.0.0-rc.8', keySet: PINNED_KEY_SET, problem: null },
  };

  it('is a browser-wide record beside the local data, read back, forgotten, and cleared by CLEAR ALL', () => {
    const store = new LocalStore(localStorage);
    const s = new ProverSettings(store);
    expect(s.persistent).toBe(true);
    expect(s.write(setting)).toBe(true);
    expect(PROVER_SETTING_KEY).toBe('night-market/v1/_global/settings/prover');
    expect(JSON.parse(localStorage.getItem(PROVER_SETTING_KEY)!).data).toEqual(setting);
    expect(new ProverSettings(new LocalStore(localStorage)).read()).toEqual(setting);
    expect(store.list().map((r) => r.key)).toContain(PROVER_SETTING_KEY);
    s.forget();
    expect(localStorage.getItem(PROVER_SETTING_KEY)).toBeNull();
    expect(s.read()).toBeNull();
    s.write(setting);
    store.clearAll();
    expect(s.read()).toBeNull();
  });

  it('is not in an Export, and an Import that carries it is refused', () => {
    const store = new LocalStore(localStorage);
    store.put(ME, 'profile', { firstSeen: 1, lastSeen: 1 });
    new ProverSettings(store).write(setting);
    const file = store.exportWallet(ME);
    expect(file.records.map((r) => r.key)).not.toContain(PROVER_SETTING_KEY);
    expect(JSON.stringify(file)).not.toContain('localhost:6300');
    const forged = {
      ...file,
      records: [
        ...file.records,
        { key: PROVER_SETTING_KEY, value: { v: 1, kind: 'settings', updatedAt: 1, data: setting } },
      ],
    };
    expect(() => store.prepareImport(forged, ME)).toThrow(/does not belong to this wallet/);
  });

  it('a browser that keeps no data holds it for this page only, and says so', () => {
    const none = new ProverSettings(null);
    expect(none.persistent).toBe(false);
    expect(none.write(setting)).toBe(false);
    expect(none.read()).toEqual(setting);
    const map = new Map<string, string>();
    const full = {
      get length() {
        return map.size;
      },
      key: (i: number) => [...map.keys()][i] ?? null,
      getItem: (k: string) => map.get(k) ?? null,
      setItem: () => {
        const e = new Error('quota');
        e.name = 'QuotaExceededError';
        throw e;
      },
      removeItem: (k: string) => void map.delete(k),
      clear: () => map.clear(),
    } as Storage;
    const s = new ProverSettings(new LocalStore(full));
    expect(s.write(setting)).toBe(false);
    expect(s.read()).toEqual(setting);
  });

  it('ignores a stored URL the rules refuse', () => {
    const store = new LocalStore(localStorage);
    store.put('global', 'settings', { ...setting, url: 'http://evil.example' }, { id: 'prover' });
    expect(new ProverSettings(store).read()).toBeNull();
  });
});

describe('the package client (P4.3, I-62b, R4)', () => {
  it('reads /version within 5 s, and calls nothing but it', async () => {
    const { d, calls } = deps(() => reply(200, version()));
    const r = await fetchPackageVersion(LOCAL, d);
    expect(r).toMatchObject({ ok: true, version: { proofServer: '9.0.0-rc.8', keySet: PINNED_KEY_SET } });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([`GET ${LOCAL}/version`]);
  });

  it('tells "nothing listening" from "the browser blocks localhost" (the permission asked, R4)', async () => {
    expect(await fetchPackageVersion(LOCAL, deps(refuse).d)).toEqual({ ok: false, code: 'unreachable' });
    const denied = { query: vi.fn(async () => ({ state: 'denied' }) as PermissionStatus) };
    const blocked = deps(refuse, { permissions: denied });
    expect(await fetchPackageVersion(LOCAL, blocked.d)).toEqual({ ok: false, code: 'blocked-permission' });
    expect(blocked.calls).toEqual([]); // not called at all
    // A page on this computer: loopback to loopback, the permission does not apply.
    const dev = deps(() => reply(200, version()), { permissions: denied, loopbackPage: true });
    expect((await fetchPackageVersion(LOCAL, dev.d)).ok).toBe(true);
    // An online URL: the local-network permission is not asked.
    expect((await fetchPackageVersion(ONLINE, deps(() => reply(200, version()), { permissions: denied }).d)).ok).toBe(
      true,
    );
  });

  it('asks loopback-network first, then local-network-access; unknown names are skipped', async () => {
    const asked: string[] = [];
    const perms = {
      query: async (d: PermissionDescriptor) => {
        const name = (d as { name: string }).name;
        asked.push(name);
        if (name === 'loopback-network') throw new TypeError('unknown permission');
        return { state: 'prompt' } as PermissionStatus;
      },
    };
    expect(await loopbackPermission(perms)).toBe('prompt');
    expect(asked).toEqual(['loopback-network', 'local-network-access']);
    expect(await loopbackPermission({ query: async () => Promise.reject(new TypeError('x')) })).toBeNull();
    expect(await loopbackPermission(null)).toBeNull();
  });

  it('Safari on an https page: blocked as mixed content, said so', async () => {
    const safari =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
    expect(isSafari(safari)).toBe(true);
    expect(isSafari(deps(refuse).d.userAgent)).toBe(false);
    expect(await fetchPackageVersion(LOCAL, deps(refuse, { userAgent: safari }).d)).toEqual({
      ok: false,
      code: 'blocked-safari',
    });
  });

  it("the site's Content-Security-Policy refusal is named", async () => {
    const target = new EventTarget();
    const handler: Handler = () => {
      const e = new Event('securitypolicyviolation') as Event & Record<string, string>;
      Object.assign(e, {
        blockedURI: `${LOCAL}/version`,
        effectiveDirective: 'connect-src',
        violatedDirective: 'connect-src',
      });
      target.dispatchEvent(e);
      throw new TypeError('Failed to fetch');
    };
    expect(await fetchPackageVersion(LOCAL, deps(handler, { cspEvents: target }).d)).toEqual({
      ok: false,
      code: 'blocked-csp',
    });
  });

  it('something that is not the package (no JSON /version, another API, an HTTP error)', async () => {
    for (const h of [
      () => new Response('9.0.0-rc.8', { status: 200 }),
      () => reply(200, version({ api: 2 })),
      () => reply(404, { error: { code: 'not-found', message: 'x' } }),
    ] as Handler[])
      expect(await fetchPackageVersion(LOCAL, deps(h).d)).toMatchObject({ ok: false, code: 'not-a-package' });
  });

  const body = { circuit: 'open_swap_shielded_with_ed25519' as const, proofRequest: 'AAEC', keyMaterialOffset: 3 };

  it('proves: sends the I-62a fields verbatim, returns the proof', async () => {
    const { d, calls } = deps(() => reply(200, { proof: PROOF, proveMs: 21000 }));
    expect(await proveOnPackage(LOCAL, body, Date.now() + 300_000, d)).toEqual({ proof: PROOF, proveMs: 21000 });
    expect(calls).toEqual([{ url: `${LOCAL}/prove-circuit`, method: 'POST', body: JSON.stringify(body) }]);
  });

  it('a busy prover (429) and one still starting (503 starting) are asked again while there is time', async () => {
    const answers = [
      reply(429, { error: { code: 'busy', message: 'one at a time' } }, { 'retry-after': '30' }),
      reply(503, { error: { code: 'starting', message: 'not ready' } }),
      reply(200, { proof: PROOF }),
    ];
    const waits: string[] = [];
    const slept: number[] = [];
    const { d } = deps(() => answers.shift()!, { sleep: async (ms) => void slept.push(ms) });
    await proveOnPackage(LOCAL, body, Date.now() + 300_000, d, (code, s) => waits.push(`${code} ${s}`));
    expect(waits).toEqual(['busy 30', 'starting 5']);
    expect(slept).toEqual([30_000, 5_000]);
    // No time left for another try: busy.
    const late = deps(() => reply(429, { error: { code: 'busy', message: 'x' } }));
    await expect(proveOnPackage(LOCAL, body, Date.now() + 40_000, late.d)).rejects.toMatchObject({ code: 'busy' });
  });

  it('maps every package error (I-62b) to the spec’s words', async () => {
    const cases: Array<[Response, string, RegExp]> = [
      [
        reply(503, { error: { code: 'out-of-memory', message: 'died' } }),
        'out-of-memory',
        /busy or out of memory \(it needs about 12 GB\)/,
      ],
      [reply(422, { error: { code: 'wrong-key', message: 'x' } }), 'wrong-key', /Update the package/],
      [
        reply(404, { error: { code: 'unknown-circuit', message: 'x' } }),
        'missing-circuit',
        /does not hold the circuit/,
      ],
      [reply(502, { error: { code: 'prover-error', message: 'rc.8 said no' } }), 'prover-error', /rc\.8 said no/],
      [reply(504, { error: { code: 'timeout', message: 'x' } }), 'prover-error', /timed out/],
      [reply(200, { proof: btoa('not a proof at all, really') }), 'invalid', /returned an invalid proof/],
    ];
    for (const [res, code, words] of cases) {
      const e = await proveOnPackage(LOCAL, body, Date.now() + 300_000, deps(() => res).d).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(ProverError);
      expect((e as ProverError).code).toBe(code);
      expect((e as ProverError).message).toMatch(words);
    }
    const down = await proveOnPackage(LOCAL, body, Date.now() + 300_000, deps(refuse).d).catch((x: unknown) => x);
    expect(down).toMatchObject({ code: 'unreachable' });
  });

  it('stops at the deadline: late (the market would refuse it anyway)', async () => {
    const hang: Handler = (_u, init) =>
      new Promise((_, reject) =>
        init!.signal!.addEventListener('abort', () => reject(new DOMException('x', 'AbortError'))),
      );
    const e = await proveOnPackage(LOCAL, body, Date.now() + 3_150, deps(hang).d).catch((x: unknown) => x);
    expect(e).toMatchObject({ code: 'late' });
    expect(await proveOnPackage(LOCAL, body, Date.now() - 1, deps(hang).d).catch((x: unknown) => x)).toMatchObject({
      code: 'late',
    });
  });

  it('checks the ProofVersioned tag without decoding the whole proof', () => {
    expect(base64StartsWith(PROOF, 'midnight:proof-versioned:')).toBe(true);
    expect(base64StartsWith(btoa('midnight:proof-preimage'), 'midnight:proof-versioned:')).toBe(false);
    expect(base64StartsWith('!!!', 'midnight:')).toBe(false);
  });
});

describe('the Test (spec FR-010): each check in plain words', () => {
  it('passes for the pinned package, and reports the machine', async () => {
    const r = await testProver(LOCAL, PINNED_EXPECTATION, deps(() => reply(200, version())).d);
    expect(r.ok).toBe(true);
    expect(r.lines.map((l) => [l.id, l.ok])).toEqual([
      ['reach', true],
      ['version', true],
      ['key-set', true],
      ['circuits', true],
      ['machine', null],
    ]);
    expect(r.lines.find((l) => l.id === 'machine')!.text).toBe('It has 8 CPUs and 16.0 GB of memory.');
  });
  it('fails on the version, the key set or a missing circuit, each named; warns on little memory', async () => {
    const r = await testProver(
      LOCAL,
      PINNED_EXPECTATION,
      deps(() =>
        reply(
          200,
          version({
            proofServer: '9.0.0-rc.6',
            keySet: 'ff'.repeat(32),
            circuits: ['append_inbox_with_ed25519'],
            machine: { cpus: 4, memoryBytes: 8 * 1024 ** 3 },
          }),
        ),
      ).d,
    );
    expect(r.ok).toBe(false);
    expect(r.problem?.code).toBe('wrong-version');
    const by = Object.fromEntries(r.lines.map((l) => [l.id, l]));
    expect(by.version!.text).toMatch(
      /another proof-server version \(proof server 9\.0\.0-rc\.6\); the market needs 9\.0\.0-rc\.8\. Update the package: docker run/,
    );
    expect(by['key-set']!.text).toMatch(/another key set \(key set ffffffff…ffff\); the market needs 21493588…5c5e/);
    expect(by.circuits!.text).toMatch(/does not hold the circuit/);
    expect(by.machine).toMatchObject({ ok: false });
    expect(by.machine!.text).toMatch(/8\.0 GB of memory: a proof needs about 12 GB/);
    // For one action, only its circuit counts.
    const one = await testProver(
      LOCAL,
      PINNED_EXPECTATION,
      deps(() => reply(200, version({ circuits: ['append_inbox_with_ed25519'] }))).d,
      'append_inbox_with_ed25519',
    );
    expect(one.ok).toBe(true);
  });
  it('an unreachable prover: one line, the reason', async () => {
    const r = await testProver(LOCAL, PINNED_EXPECTATION, deps(refuse).d);
    expect(r).toMatchObject({ ok: false, problem: { code: 'unreachable' } });
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]!.text).toMatch(/^Your proof server did not answer at http:\/\/localhost:6300\. Start it/);
  });
});

/** A relay for the engine: the client-proving mode, and the hand-off routes. */
function fakeRelay(mode: 'off' | 'required' = 'required', circuits: readonly string[] = CLIENT_CIRCUITS) {
  const posted: Array<{ id: string; proofId: string; proof: string }> = [];
  const r = {
    clientProving: vi.fn(async () =>
      mode === 'off'
        ? { mode: 'off' as const }
        : {
            mode: 'required' as const,
            circuits: [...circuits],
            keySet: PINNED_KEY_SET,
            proofServer: '9.0.0-rc.8',
            timeoutSeconds: 300,
          },
    ),
    request: null as ClientProofRequest | null,
    postError: null as RelayError | null,
    clientProofRequest: vi.fn(async () => r.request),
    postClientProof: vi.fn(async (id: string, b: { proofId: string; proof: string }) => {
      if (r.postError) throw r.postError;
      posted.push({ id, ...b });
      return {} as HandOffJobView;
    }),
    posted,
  };
  return r;
}

const handOffRequest = (over: Partial<ClientProofRequest> = {}): ClientProofRequest => ({
  proofId: 'ab'.repeat(16),
  circuit: 'withdraw_shielded_with_ed25519',
  proofRequest: 'AAEC',
  keyMaterialOffset: 3,
  deadline: Math.floor(Date.now() / 1000) + 300,
  attempt: 1,
  keySet: PINNED_KEY_SET,
  proofServer: '9.0.0-rc.8',
  ...over,
});
const JOB = { requestId: '01'.repeat(16) } as HandOffJobView;

function engine(opts: {
  relay?: ReturnType<typeof fakeRelay>;
  handler?: Handler;
  popup?: (req: PopupRequest) => Promise<{ url: string } | null>;
  saved?: ProverSetting | null;
}) {
  const settings = new ProverSettings(new LocalStore(localStorage));
  if (opts.saved) settings.write(opts.saved);
  const popups: PopupRequest[] = [];
  const progress: Array<ClientProofProgress | null> = [];
  const { d, calls } = deps(opts.handler ?? (() => reply(200, version())));
  const relay = opts.relay ?? fakeRelay();
  const e = new ClientProver({
    relay,
    settings,
    pkg: d,
    popup: async (req) => {
      popups.push(req);
      return opts.popup ? opts.popup(req) : null;
    },
    progress: (p) => progress.push(p),
  });
  return { e, popups, progress, calls, relay, settings };
}

const saved = (url = LOCAL, privacyConfirmed = false): ProverSetting => ({ url, privacyConfirmed, lastTest: null });

describe('the gate before signing (P4.2, spec FR-009)', () => {
  it('does nothing when the market proves everything itself, or does not hand this circuit over', async () => {
    const off = engine({ relay: fakeRelay('off') });
    await off.e.ensure('open_swap_shielded_with_ed25519');
    const partial = engine({ relay: fakeRelay('required', ['append_inbox_with_ed25519']) });
    await partial.e.ensure('open_swap_shielded_with_ed25519');
    expect([...off.popups, ...partial.popups]).toEqual([]);
    expect([...off.calls, ...partial.calls]).toEqual([]);
  });

  it('a market whose config cannot be read counts as "off" (the hand-off still reaches the page)', async () => {
    const relay = fakeRelay();
    relay.clientProving.mockRejectedValueOnce(new RelayError(0, 'unreachable', ''));
    const x = engine({ relay });
    await x.e.ensure('open_swap_shielded_with_ed25519');
    expect(x.popups).toEqual([]);
  });

  it('no prover set: the popup; Continue goes on, closing it stops with "nothing was signed or sent"', async () => {
    const yes = engine({ popup: async () => ({ url: LOCAL }) });
    await yes.e.ensure('open_swap_shielded_with_ed25519');
    expect(yes.popups).toEqual([
      expect.objectContaining({
        circuit: 'open_swap_shielded_with_ed25519',
        reason: 'start',
        failure: null,
        deadlineMs: null,
      }),
    ]);
    const no = engine({});
    const err = await no.e.ensure('withdraw_shielded_with_ed25519').catch((x: unknown) => x);
    expect(err).toBeInstanceOf(ProverError);
    expect((err as ProverError).message).toBe('You closed the proof-server window, so nothing was signed or sent.');
  });

  it('a saved prover that passes: no popup; tested again only after a minute', async () => {
    let now = Date.now();
    const x = engine({ saved: saved() });
    (x.e as unknown as { deps: { pkg: PackageDeps } }).deps.pkg.now = () => now;
    await x.e.ensure('withdraw_shielded_with_ed25519');
    await x.e.ensure('append_inbox_with_ed25519');
    expect(x.popups).toEqual([]);
    expect(x.calls).toHaveLength(1);
    now += 61_000;
    await x.e.ensure('append_inbox_with_ed25519');
    expect(x.calls).toHaveLength(2);
    expect(x.settings.read()?.lastTest).toMatchObject({ ok: true, proofServer: '9.0.0-rc.8' });
  });

  it('a saved prover that fails at action time: the popup, with the reason', async () => {
    const x = engine({ saved: saved(), handler: refuse, popup: async () => ({ url: LOCAL }) });
    await x.e.ensure('withdraw_unshielded_with_ed25519');
    expect(x.popups[0]!.failure).toMatch(/^Your proof server did not answer at http:\/\/localhost:6300/);
  });

  it('an online prover saved without the privacy confirmation is not used without asking', async () => {
    const x = engine({ saved: saved(ONLINE, false), popup: async () => ({ url: ONLINE }) });
    await x.e.ensure('open_swap_shielded_with_ed25519');
    expect(x.popups).toHaveLength(1);
    expect(x.calls).toEqual([]);
    const y = engine({ saved: saved(ONLINE, true) });
    await y.e.ensure('open_swap_shielded_with_ed25519');
    expect(y.popups).toEqual([]);
  });
});

describe('the hand-off (P4.3, I-62a + I-62b)', () => {
  const proving = (): Handler => (url) =>
    url.endsWith('/version') ? reply(200, version()) : reply(200, { proof: PROOF, proveMs: 5 });

  it('fetches the request, proves it on the customer’s prover, posts the proof; progress on the way', async () => {
    const relay = fakeRelay();
    relay.request = handOffRequest();
    const x = engine({ relay, saved: saved(), handler: proving() });
    await x.e.handOff(relay as never, JOB);
    expect(relay.posted).toEqual([{ id: JOB.requestId, proofId: 'ab'.repeat(16), proof: PROOF }]);
    const prove = x.calls.find((c) => c.url.endsWith('/prove-circuit'))!;
    expect(JSON.parse(prove.body!)).toEqual({
      circuit: 'withdraw_shielded_with_ed25519',
      proofRequest: 'AAEC',
      keyMaterialOffset: 3,
    });
    expect(x.progress.map((p) => p?.state ?? null)).toEqual(['proving', 'sending', null]);
  });

  it('nothing open any more (answered, or the market moved on): nothing happens', async () => {
    const relay = fakeRelay();
    const x = engine({ relay, saved: saved(), handler: proving() });
    await x.e.handOff(relay as never, JOB);
    expect(x.calls).toEqual([]);
    expect(relay.postClientProof).not.toHaveBeenCalled();
  });

  it('no prover set when the market already waits: the popup says so', async () => {
    const relay = fakeRelay();
    relay.request = handOffRequest();
    const x = engine({ relay, handler: proving(), popup: async () => ({ url: LOCAL }) });
    await x.e.handOff(relay as never, JOB);
    expect(x.popups[0]).toMatchObject({ reason: 'handoff', deadlineMs: relay.request.deadline * 1000 });
    expect(relay.posted).toHaveLength(1);
  });

  it('the prover fails with time left: the popup again; stopping says nothing is spent', async () => {
    const relay = fakeRelay();
    relay.request = handOffRequest();
    let first = true;
    const handler: Handler = (url) => {
      if (url.endsWith('/version')) return reply(200, version());
      if (first) {
        first = false;
        return reply(503, { error: { code: 'out-of-memory', message: 'died' } });
      }
      return reply(200, { proof: PROOF });
    };
    const again = engine({ relay, saved: saved(), handler, popup: async () => ({ url: LOCAL }) });
    await again.e.handOff(relay as never, JOB);
    expect(again.popups[0]).toMatchObject({ reason: 'retry' });
    expect(again.popups[0]!.failure).toMatch(/busy or out of memory/);
    expect(relay.posted).toHaveLength(1);

    const relay2 = fakeRelay();
    relay2.request = handOffRequest();
    const stop = engine({
      relay: relay2,
      saved: saved(),
      handler: (url) =>
        url.endsWith('/version')
          ? reply(200, version())
          : reply(503, { error: { code: 'out-of-memory', message: 'x' } }),
    });
    const err = await stop.e.handOff(relay2 as never, JOB).catch((x: unknown) => x);
    expect((err as ProverError).message).toMatch(/the market sends nothing and spends no fee/);
  });

  it('the market refuses the proof (422) or says it is late (410); an older attempt is ignored', async () => {
    for (const [code, expected] of [
      ['client-proof-invalid', 'invalid'],
      ['client-proof-late', 'late'],
    ] as const) {
      const relay = fakeRelay();
      relay.request = handOffRequest();
      relay.postError = new RelayError(code === 'client-proof-invalid' ? 422 : 410, code, 'x');
      const x = engine({ relay, saved: saved(), handler: proving() });
      expect(await x.e.handOff(relay as never, JOB).catch((e: unknown) => e)).toMatchObject({ code: expected });
    }
    const relay = fakeRelay();
    relay.request = handOffRequest();
    relay.postError = new RelayError(409, 'client-proof-wrong-id', 'x');
    const x = engine({ relay, saved: saved(), handler: proving() });
    await x.e.handOff(relay as never, JOB);
  });
});

describe('RelayClient: the hand-off while a job is followed', () => {
  const view = (over: Partial<JobView> & { clientProof?: unknown } = {}) => ({
    requestId: '01'.repeat(16),
    action: 'withdraw',
    lane: 'prover',
    state: 'running',
    stage: 'awaiting-client-proof',
    stages: [],
    createdAt: 1,
    updatedAt: 1,
    expiresAt: 9,
    ...over,
  });
  const cp = (proofId: string, attempt = 1) => ({
    proofId,
    circuit: 'withdraw_shielded_with_ed25519',
    deadline: 9,
    attempt,
    fetched: false,
  });

  it('answers each new hand-off once (a rebuilt call opens another), then follows the job to its end', async () => {
    const jobs = [
      view({ clientProof: cp('aa'.repeat(16)) }),
      view({ clientProof: cp('aa'.repeat(16)), stage: 'client-proof-fetched' }),
      view({ clientProof: cp('bb'.repeat(16), 2) }),
      view({ state: 'succeeded', stage: 'succeeded', result: { txId: 'f'.repeat(64) } }),
    ];
    const fetchImpl = (async () => reply(200, { job: jobs.shift() ?? jobs.at(-1) })) as unknown as typeof fetch;
    const relay = new RelayClient('http://relay.test', fetchImpl);
    const handled: string[] = [];
    const done = await relay.waitForJob(jobs[0]!.requestId, () => undefined, {
      intervalMs: 1,
      clientProof: async (j) => void handled.push(j.clientProof!.proofId),
    });
    expect(handled).toEqual(['aa'.repeat(16), 'bb'.repeat(16)]);
    expect(done.state).toBe('succeeded');
  });

  it('waitWithProver passes the hooks; without them the job is only followed', async () => {
    const jobs = [
      view({ clientProof: cp('aa'.repeat(16)) }),
      view({ state: 'failed', stage: 'failed', error: { code: 'client-proof-missing', message: 'x' } }),
    ];
    const fetchImpl = (async () => reply(200, { job: jobs.shift() })) as unknown as typeof fetch;
    const relay = new RelayClient('http://relay.test', fetchImpl);
    const handOff = vi.fn(async () => {});
    const job = await waitWithProver(
      { relay, prover: { ensure: async () => {}, handOff } },
      '01'.repeat(16),
      () => undefined,
    );
    expect(handOff).toHaveBeenCalledTimes(1);
    expect(job.error?.code).toBe('client-proof-missing');
  });

  it('the hand-off routes: 409 / 404 client-proving-off are "nothing open"', async () => {
    const answers = [
      reply(409, { error: { code: 'not-awaiting-client-proof', message: 'x' } }),
      reply(404, { error: { code: 'client-proving-off', message: 'x' } }),
      reply(200, handOffRequest()),
    ];
    const relay = new RelayClient('http://relay.test', (async () => answers.shift()!) as unknown as typeof fetch);
    expect(await relay.clientProofRequest('01'.repeat(16))).toBeNull();
    expect(await relay.clientProofRequest('01'.repeat(16))).toBeNull();
    expect(await relay.clientProofRequest('01'.repeat(16))).toMatchObject({
      circuit: 'withdraw_shielded_with_ed25519',
    });
  });

  it('reads clientProving from /v1/config; absent or unknown is "off"', () => {
    expect(clientProvingOf({})).toEqual({ mode: 'off' });
    expect(clientProvingOf({ clientProving: { mode: 'sometimes' } })).toEqual({ mode: 'off' });
    expect(
      clientProvingOf({
        clientProving: { mode: 'required', circuits: ['a'], keySet: 'k', proofServer: 'p', timeoutSeconds: 300 },
      }),
    ).toMatchObject({ mode: 'required', timeoutSeconds: 300 });
  });
});

describe('the k>=18 operations ask for the prover BEFORE anything is signed or sent', () => {
  const ACC = '5a'.repeat(32);
  const untouchable = new Proxy(
    {},
    {
      get: (_t, p) => {
        if (p === 'then') return undefined;
        return () => {
          throw new Error(`touched ${String(p)}`);
        };
      },
    },
  );
  function gatedEnv() {
    const { signing, calls } = fakeSigning();
    const asked: string[] = [];
    const env: OperationEnv = {
      relay: untouchable as never,
      chain: untouchable as never,
      store: new LocalStore(localStorage),
      scope: { network: 'stagenet', owner: signing.deviceKey },
      signing,
      prover: {
        ensure: async (c) => {
          asked.push(c);
          throw new ProverError('cancelled', proverProblemText('cancelled'));
        },
        handOff: async () => {},
      },
    };
    return { env, calls, asked };
  }
  const coin = {
    nonce: '11'.repeat(32),
    color: '5e'.repeat(32),
    value: '100',
    mtIndex: '3',
    commitment: 'cc'.repeat(32),
    origin: 'inbox' as const,
    inInbox: true,
    spent: false,
  };

  it('make, take, a shielded withdrawal (Bridge out’s tx1 too) and an unshielded one: the gate first', async () => {
    const g = gatedEnv();
    await expect(makeOffer(g.env, ACC, {} as never, {} as never)).rejects.toBeInstanceOf(ProverError);
    await expect(takeOffer(g.env, ACC, {} as never, {} as never)).rejects.toBeInstanceOf(ProverError);
    const shielded = formatShieldedAddress(
      { coinPublicKey: '44'.repeat(32), encryptionPublicKey: '55'.repeat(32) },
      'stagenet',
    );
    await expect(
      withdrawToWallet(
        g.env,
        ACC,
        { color: coin.color, amount: 10n, recipient: shielded },
        { coin, purpose: 'bridge-out' },
      ),
    ).rejects.toBeInstanceOf(ProverError);
    await expect(
      withdrawUnshieldedToWallet(g.env, ACC, {
        color: '5e'.repeat(32),
        amount: 1n,
        recipient: formatUnshieldedAddress('66'.repeat(32), 'stagenet'),
        balance: 5n,
      }),
    ).rejects.toBeInstanceOf(ProverError);
    expect(g.asked).toEqual([
      ACTION_CIRCUIT['open-swap'],
      ACTION_CIRCUIT.take,
      ACTION_CIRCUIT.withdraw,
      ACTION_CIRCUIT['withdraw-unshielded'],
    ]);
    // Nothing was signed, and neither the market nor the chain was asked anything (the proxies throw).
    expect(g.calls).toEqual([]);
    expect(localStorage.length).toBe(0);
  });
});

describe('the words', () => {
  it('the relay’s new job codes (I-62a) say nothing was spent', () => {
    expect(jobErrorText({ code: 'client-proof-missing', message: 'x' }, '')).toMatch(
      /Nothing was sent and no fee was spent/,
    );
    expect(jobErrorText({ code: 'client-proof-late', message: 'x' }, '')).toMatch(/deadline.*no fee was spent/);
    expect(jobErrorText({ code: 'client-proof-invalid', message: 'x' }, '')).toBe(
      'Your proof server returned an invalid proof, so the market refused it. Nothing was sent and no fee was spent.',
    );
  });
  it('the stages, the progress line and its clock', () => {
    expect(stageWords('awaiting-client-proof')).toBe('Waiting for your prover');
    expect(stageWords('client-proof-fetched')).toBe('Proving on your prover…');
    expect(stageWords('client-proof-checked')).toBe('The market checked your proof');
    const p: ClientProofProgress = { startedAt: 0, url: LOCAL, state: 'proving', attempt: 1 };
    expect(progressWords(p)).toBe('Proving on your prover…');
    expect(progressWords({ ...p, state: 'waiting', wait: { code: 'busy', seconds: 30 } })).toMatch(/busy.*30 s/);
    expect(progressWords({ ...p, state: 'sending' })).toBe('Sending your proof to the market');
    expect(elapsedClock(75.4)).toBe('1:15');
    const a = new ActivityStore();
    a.begin('withdraw');
    a.clientProof(p);
    expect(a.peek()).toMatchObject({ title: ACTIVITY_TITLE.withdraw, clientProof: p });
    a.clientProof(null);
    expect(a.peek()!.clientProof).toBeNull();
  });
  it('the command is the ONE image constant (P6.3 pins it), with the port on loopback and a memory hint', () => {
    expect(PROVER_IMAGE).toBe('ghcr.io/midnight-experiments/solana-proof-server:<pending>');
    expect(PROVER_COMMAND).toBe(`docker run --rm -p 127.0.0.1:6300:6300 --memory 12g ${PROVER_IMAGE}`);
    expect(DEFAULT_PROVER_URL).toBe(LOCAL);
  });
});
