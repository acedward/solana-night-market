// @vitest-environment node
// AA 00062 P4.5 (spec FR-013, owner Q2 "any URL is OK"): the tested Content-Security-Policy, as the
// deployment documents carry it (deploy/RUNBOOK.md section 16, deploy/.env.example's
// WEB_CONTENT_SECURITY_POLICY, deploy/SYSTEMD.md's nginx example), is ONE value; and against the value
// before AA 00062 it adds exactly the customer's proof server to connect-src (`http://localhost:*`,
// `http://127.0.0.1:*`, `https:`) and changes nothing else. The browser runs of that value are
// test/e2e/prover.spec.ts (and chain.spec.ts, zswap-decode.spec.ts).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), 'utf8');

/** The value before AA 00062 (AA 00047 P11.B / 00060), as the three documents carried it. */
const BEFORE =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self' https://indexer.stagenet.shielded.tools wss://indexer.stagenet.shielded.tools https://stagenet.api-zswap.zkdojo.com; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";
const PROVER_SOURCES = ['http://localhost:*', 'http://127.0.0.1:*', 'https:'];

const directives = (csp: string) =>
  new Map(
    csp
      .split(';')
      .map((d) => d.trim().split(/\s+/))
      .filter((d) => d[0])
      .map(([name, ...sources]) => [name!, sources]),
  );

function documented(): Record<string, string> {
  const runbook = read('deploy/RUNBOOK.md');
  const section = runbook.slice(runbook.indexOf('## 16.'), runbook.indexOf('## 17.'));
  const block = /```\n(default-src[^\n]+)\n```/.exec(section)?.[1];
  const env = /^# WEB_CONTENT_SECURITY_POLICY=(.+)$/m.exec(read('deploy/.env.example'))?.[1];
  const nginx = /add_header Content-Security-Policy "([^"]+)" always;/.exec(read('deploy/SYSTEMD.md'))?.[1];
  return { runbook: block ?? '', env: env ?? '', nginx: nginx ?? '' };
}

describe('the tested Content-Security-Policy (deploy documents)', () => {
  it('is one value in RUNBOOK §16, .env.example and SYSTEMD.md', () => {
    const d = documented();
    expect(d.runbook).not.toBe('');
    expect(d.env).toBe(d.runbook);
    expect(d.nginx).toBe(d.runbook);
  });

  it('adds exactly the proof-server sources to connect-src, and changes nothing else', () => {
    const now = directives(documented().runbook);
    const before = directives(BEFORE);
    expect([...now.keys()]).toEqual([...before.keys()]);
    for (const [name, sources] of before) {
      if (name === 'connect-src') expect(now.get(name)).toEqual([...sources, ...PROVER_SOURCES]);
      else expect(now.get(name)).toEqual(sources);
    }
    // `https:` does not cover a WebSocket: the indexer's wss origin stays listed.
    expect(now.get('connect-src')).toContain('wss://indexer.stagenet.shielded.tools');
  });
});
