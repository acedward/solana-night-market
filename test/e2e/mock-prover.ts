// AA 00062: a MOCK of the customer's prover package (plan I-62b), served through page.route on any
// origin a test gives it (http://localhost:6300, an https "online" one, …). It answers like the package:
// `GET /version`, `POST /prove-circuit` (one proof at a time), CORS that echoes the page's origin with
// the private-network preflight header, and the package's error codes. It never proves anything: its
// "proof" is the ProofVersioned tag and random bytes, which the mock relay accepts (or refuses, when
// told to). Every request is recorded, so a test can check what the page sent and that nothing else
// reached the prover.

import { randomBytes } from 'node:crypto';

import type { Page, Route } from '@playwright/test';

import { KEY_SET, PROOF_SERVER } from './mock-relay.js';

export const CIRCUITS = [
  'append_inbox_with_ed25519',
  'open_swap_shielded_with_ed25519',
  'withdraw_shielded_with_ed25519',
  'withdraw_unshielded_with_ed25519',
];

export type ProverMode =
  /** The package, as published. */
  | 'ok'
  /** Nothing listening (the connection is refused). */
  | 'down'
  /** An older package: another proof-server version, or another key set. */
  | 'wrong-version'
  | 'wrong-key-set'
  /** A plain proof server: `/version` answers text, not the package's JSON. */
  | 'plain'
  /** `/prove-circuit` answers 503 out-of-memory. */
  | 'oom'
  /** `/prove-circuit` answers 429 busy once, then proves. */
  | 'busy-once';

export interface ProverCall {
  method: string;
  path: string;
  origin: string | null;
  body: unknown;
}

export class MockProver {
  mode: ProverMode = 'ok';
  /** How long `/prove-circuit` takes, in ms. */
  proveMs = 200;
  /** What the package's `machine` says (null: it cannot tell). */
  machine: { cpus: number; memoryBytes: number | null } | null = { cpus: 12, memoryBytes: 16 * 1024 ** 3 };
  readonly calls: ProverCall[] = [];
  private held: (() => void) | null = null;
  private holding = false;
  private busyServed = false;

  constructor(readonly base: string) {}

  /** Hold the next proof until the returned function is called. */
  holdNext(): () => void {
    this.holding = true;
    return () => {
      this.holding = false;
      this.held?.();
      this.held = null;
    };
  }

  /** The proofs asked for (the bodies the page sent). */
  get proofs(): Array<{ circuit: string; proofRequest: string; keyMaterialOffset: number }> {
    return this.calls
      .filter((c) => c.method === 'POST' && c.path === '/prove-circuit')
      .map((c) => c.body as { circuit: string; proofRequest: string; keyMaterialOffset: number });
  }

  async install(page: Page) {
    await page.route(`${this.base}/**`, (r) => this.handle(r));
  }

  private async handle(route: Route) {
    // A request the page gave up on (its deadline passed) cannot be answered any more: ignore that.
    await this.answer(route).catch(() => undefined);
  }

  private async answer(route: Route) {
    const req = route.request();
    const url = new URL(req.url());
    const origin = (await req.headerValue('origin')) ?? null;
    const raw = req.postData();
    let body: unknown;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = raw;
    }
    this.calls.push({ method: req.method(), path: url.pathname, origin, body });
    if (this.mode === 'down') return route.abort('connectionrefused');
    const cors: Record<string, string> = {
      'access-control-allow-origin': origin ?? '*',
      vary: 'Origin',
    };
    if (req.method() === 'OPTIONS')
      return route.fulfill({
        status: 204,
        headers: {
          ...cors,
          'access-control-allow-methods': 'GET, POST, OPTIONS',
          'access-control-allow-headers': 'content-type',
          'access-control-max-age': '600',
          'access-control-allow-private-network': 'true',
        },
      });
    const json = (status: number, b: unknown, extra: Record<string, string> = {}) =>
      route.fulfill({
        status,
        headers: { ...cors, ...extra },
        contentType: 'application/json',
        body: JSON.stringify(b),
      });
    if (url.pathname === '/version' && req.method() === 'GET') {
      if (this.mode === 'plain') return route.fulfill({ status: 200, headers: cors, body: PROOF_SERVER });
      return json(200, {
        api: 1,
        package: '0.1.0-e2e',
        proofServer: this.mode === 'wrong-version' ? '9.0.0-rc.6' : PROOF_SERVER,
        keySet: this.mode === 'wrong-key-set' ? 'ff'.repeat(32) : KEY_SET,
        circuits: CIRCUITS,
        busy: false,
        machine: this.machine,
      });
    }
    if (url.pathname === '/prove-circuit' && req.method() === 'POST') {
      const b = body as { circuit?: string } | null;
      if (!b || !CIRCUITS.includes(String(b.circuit)))
        return json(404, { error: { code: 'unknown-circuit', message: 'not one of the four' } });
      if (this.mode === 'oom') return json(503, { error: { code: 'out-of-memory', message: 'the prover died' } });
      if (this.mode === 'busy-once' && !this.busyServed) {
        this.busyServed = true;
        // The package sends `Retry-After: 30` (I-62b) without exposing it, so a page waits its default 30 s;
        // here it is exposed and short, to keep the test quick.
        return json(
          429,
          { error: { code: 'busy', message: 'one proof at a time' } },
          { 'retry-after': '1', 'access-control-expose-headers': 'retry-after' },
        );
      }
      if (this.holding) await new Promise<void>((r) => (this.held = r));
      await new Promise((r) => setTimeout(r, this.proveMs));
      const proof = Buffer.concat([Buffer.from('midnight:proof-versioned:', 'latin1'), randomBytes(64)]);
      return json(200, { proof: proof.toString('base64'), proveMs: this.proveMs });
    }
    return json(404, { error: { code: 'not-found', message: 'no such route' } });
  }
}
