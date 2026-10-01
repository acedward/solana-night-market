// AA 00047 P10, audit round 2 R2-7 (F-B2-4) and R2-9 (F-A2-7.3, the lost progress write): a demo
// token is never minted twice. Before its transaction is submitted, the claim records it as PENDING
// (the inbox entry it files, and when it can no longer land); a resumed claim (after a failure, a lost
// response or a crash) reconciles every pending token against the account's on-chain inbox before
// anything is minted again, and quarantines what it cannot check.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { demoTokens, reconcilePending, type DemoMint } from '../src/demo/action.js';
import { DemoTokenClaims, type ClaimRecord } from '../src/demo/claims.js';
import type { ResolvedPackItem } from '../src/demo/pack.js';
import type { PassportRuntime } from '../src/passport/runtime.js';
import type { JobContext } from '../src/queue/jobs.js';
import { FakeSponsor, silentLog } from './harness.js';
import { testArm, testDeviceEntry } from './fake-arm.js';

const ACCOUNT = '5e'.repeat(32);
const OWNER = '0b'.repeat(32);
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const unhex = (h: string) => Uint8Array.from(Buffer.from(h, 'hex'));

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'nm-pending-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const item = (symbol: string, colourByte: string): ResolvedPackItem => ({
  symbol,
  colour: colourByte.repeat(32),
  decimals: 6,
  amount: '1000000',
  faucet: 'fa'.repeat(32),
  domainSeparator: `mint-test-tokens:${symbol}`,
});
const TA = item('tA', 'aa');
const TB = item('tB', 'bb');

/** The account on a fake chain: its inbox is what the tests make land. */
function chain() {
  const inbox: Uint8Array[] = [];
  const live = new Set([testDeviceEntry(ACCOUNT, OWNER, 0n, 0n)]);
  const rt = {
    ledgerState: async (a: string) =>
      a === ACCOUNT
        ? {
            booted: true,
            device_count: 1n,
            device_epoch: 0n,
            auth_nonce: 0n,
            inbox_count: BigInt(inbox.length),
            enc_key: new Uint8Array(32),
            devices: { member: (e: Uint8Array) => live.has(hex(e)) },
            inbox: { member: (k: bigint) => k < BigInt(inbox.length), lookup: (k: bigint) => inbox[Number(k)]! },
          }
        : null,
  } as unknown as PassportRuntime;
  return { rt, inbox };
}

const ctx = (): JobContext & { stages: string[] } => {
  const stages: string[] = [];
  return {
    requestId: 'r',
    log: silentLog(),
    stage: (name, detail) => stages.push(detail?.verdict ? `${name}:${detail.verdict}` : name),
    prove: (fn) => fn(),
    stages,
  };
};

/** A mint that files a fresh entry: `land` says whether it lands, `then` what happens after. */
function mints(c: ReturnType<typeof chain>) {
  const calls: string[] = [];
  let n = 0;
  const mint =
    (
      o: { land?: boolean; after?: 'ok' | 'lose-response'; stage?: 'mint' | 'mint-and-deposit'; ttl?: number } = {},
    ): DemoMint =>
    async ({ item: it, beforeSubmit }) => {
      calls.push(it.symbol);
      const entry = new Uint8Array(192).fill(++n);
      // `?.`: the faucet's callback is new in P10 (the tests also run against the code before it).
      if (o.stage === 'mint') beforeSubmit?.({ stage: 'mint' });
      else
        beforeSubmit?.({ stage: 'mint-and-deposit', entry, notAfter: Math.floor(Date.now() / 1000) + (o.ttl ?? 3600) });
      if (o.land !== false) c.inbox.push(entry);
      if (o.after === 'lose-response') throw new Error('socket hang up: the response was lost');
      return { mintAndDeposit: `${n}`.repeat(64).slice(0, 64) };
    };
  return { calls, mint };
}

function demo(
  claims: DemoTokenClaims,
  c: ReturnType<typeof chain>,
  mint: DemoMint,
  pack = [TA, TB],
  now?: () => number,
) {
  return demoTokens({
    runtime: () => c.rt,
    sponsor: new FakeSponsor(),
    claims,
    pack,
    path: 'direct',
    arm: testArm,
    mint,
    log: silentLog(),
    ...(now ? { now } : {}),
  });
}

/** One claim: admission then the job; the job's error code (or 'ok') and the result. */
async function claimOnce(d: ReturnType<typeof demo>) {
  const admitted = await d.admit({ account: ACCOUNT, signer: OWNER, payload: { useCounter: '0' } });
  if (!admitted.ok) return { code: `refused:${admitted.code}`, result: undefined };
  const c = ctx();
  try {
    const result = await d.executor({ account: ACCOUNT, signer: OWNER }, c);
    return { code: 'ok', result, stages: c.stages };
  } catch (e) {
    return { code: (e as { code?: string }).code ?? 'error', result: undefined, stages: c.stages };
  }
}

describe('a demo token is never minted twice (R2-7)', () => {
  it('a mint that landed but whose response was lost is found on chain, not minted again', async () => {
    const c = chain();
    const claims = new DemoTokenClaims({ file: null, dailyCap: 10 });
    const m = mints(c);
    let first = true;
    const mint: DemoMint = (o) =>
      o.item.symbol === 'tA' && first ? ((first = false), m.mint({ after: 'lose-response' })(o)) : m.mint()(o);
    const d = demo(claims, c, mint);
    expect((await claimOnce(d)).code).not.toBe('ok');
    expect(claims.record(OWNER)?.pending?.[TA.colour]).toMatchObject({ stage: 'mint-and-deposit' });
    const again = await claimOnce(d);
    expect(again.code).toBe('ok');
    expect(m.calls).toEqual(['tA', 'tB']); // tA once, though its first attempt "failed"
    expect(c.inbox).toHaveLength(2);
    expect(claims.record(OWNER)).toMatchObject({ state: 'claimed', delivered: { [TA.colour]: { reconciled: true } } });
    expect(claims.record(OWNER)?.pending).toBeUndefined();
  });

  it('crash recovery: a reservation left on disk keeps its pending tokens, and they are reconciled first', async () => {
    const dir = tmp();
    const file = join(dir, 'claims.json');
    const c = chain();
    const landed = new Uint8Array(192).fill(0x77);
    c.inbox.push(landed);
    const now = Math.floor(Date.now() / 1000);
    const record: ClaimRecord = {
      owner: OWNER,
      account: ACCOUNT,
      state: 'reserved', // the relay was killed mid-job
      at: now - 60,
      pending: {
        [TA.colour]: {
          since: now - 60,
          notAfter: now + 3540,
          stage: 'mint-and-deposit',
          entry: hex(landed),
          inboxFrom: '0',
        },
        [TB.colour]: {
          since: now - 60,
          notAfter: now - 3600,
          stage: 'mint-and-deposit',
          entry: 'ee'.repeat(192),
          inboxFrom: '0',
        },
      },
    };
    writeFileSync(file, JSON.stringify({ format: 'night-market-demo-token-claims/1', claims: [record] }));
    const claims = new DemoTokenClaims({ file, dailyCap: 10, heartbeatSeconds: 0 });
    claims.lock();
    expect(claims.record(OWNER)).toMatchObject({ state: 'partial', pending: { [TA.colour]: {}, [TB.colour]: {} } });
    const m = mints(c);
    const out = await claimOnce(demo(claims, c, m.mint()));
    expect(out.code).toBe('ok');
    // tA landed before the crash: found. tB's transaction can no longer land and is not there: minted.
    expect(m.calls).toEqual(['tB']);
    expect(out.stages).toEqual(expect.arrayContaining(['reconciled:landed', 'reconciled:not-landed']));
    const onDisk = JSON.parse(readFileSync(file, 'utf8')) as { claims: ClaimRecord[] };
    expect(onDisk.claims[0]).toMatchObject({ state: 'claimed' });
    claims.unlock();
  });

  it('a pending token that could still land stops the claim (demo-tokens-settling, not counted): nothing is minted', async () => {
    const c = chain();
    const claims = new DemoTokenClaims({ file: null, dailyCap: 10 });
    const m = mints(c);
    let first = true;
    // The first attempt submits tA, which does not land (yet), and the response is lost.
    const mint: DemoMint = (o) =>
      first ? ((first = false), m.mint({ land: false, after: 'lose-response' })(o)) : m.mint()(o);
    const d = demo(claims, c, mint);
    await claimOnce(d);
    const failuresBefore = claims.record(OWNER)?.failures ?? 0;
    const again = await claimOnce(d);
    expect(again.code).toBe('demo-tokens-settling');
    expect(m.calls).toEqual(['tA']); // never again while it could still land
    expect(claims.record(OWNER)?.failures ?? 0).toBe(failuresBefore);
    expect(claims.isResumable(OWNER)).toBe(true);
  });

  it('when the transaction can no longer land and its entry is absent, the token is minted again (once)', async () => {
    const c = chain();
    const claims = new DemoTokenClaims({ file: null, dailyCap: 10 });
    const m = mints(c);
    let first = true;
    let now = Math.floor(Date.now() / 1000);
    const mint: DemoMint = (o) =>
      first ? ((first = false), m.mint({ land: false, after: 'lose-response', ttl: 60 })(o)) : m.mint()(o);
    const d = demo(claims, c, mint, [TA, TB], () => now);
    await claimOnce(d);
    now += 60 + 301; // past its TTL and the settle margin
    expect((await claimOnce(d)).code).toBe('ok');
    expect(m.calls).toEqual(['tA', 'tA', 'tB']);
    expect(c.inbox).toHaveLength(2);
  });

  it('an interrupted mint with no entry to look for (via-sponsor, to the sponsor) is quarantined: never minted again', async () => {
    const c = chain();
    const claims = new DemoTokenClaims({ file: null, dailyCap: 10 });
    const m = mints(c);
    let first = true;
    const mint: DemoMint = (o) =>
      o.item.symbol === 'tA' && first
        ? ((first = false), m.mint({ stage: 'mint', land: false, after: 'lose-response' })(o))
        : m.mint()(o);
    const d = demo(claims, c, mint);
    await claimOnce(d);
    const again = await claimOnce(d);
    expect(again.code).toBe('ok');
    expect(m.calls).toEqual(['tA', 'tB']);
    expect(again.result).toMatchObject({ held: [{ symbol: 'tA', colour: TA.colour }], minted: [{ symbol: 'tB' }] });
    expect(claims.record(OWNER)).toMatchObject({ state: 'claimed', quarantined: { [TA.colour]: { stage: 'mint' } } });
    expect(await claimOnce(d)).toMatchObject({ code: 'refused:already-claimed' });
  });

  it('F-A2-7.3: a progress write that fails after the mint landed does not lead to a second mint', async () => {
    const dir = tmp();
    const file = join(dir, 'claims.json');
    const c = chain();
    const a = new DemoTokenClaims({ file, dailyCap: 10, heartbeatSeconds: 0, hostname: 'relay-host' });
    a.lock();
    const m = mints(c);
    // tA lands; then the store can no longer be written (its lock was taken from under it).
    const mint: DemoMint = async (o) => {
      const out = await m.mint()(o);
      writeFileSync(`${file}.lock`, JSON.stringify({ pid: process.pid, host: 'relay-host', token: 'someone-else' }));
      return out;
    };
    expect((await claimOnce(demo(a, c, mint))).code).not.toBe('ok');
    // A restarted relay (same host and pid, a new token) takes the lock over and resumes the claim.
    const b = new DemoTokenClaims({ file, dailyCap: 10, heartbeatSeconds: 0, hostname: 'relay-host' });
    b.lock();
    const m2 = mints(c);
    expect((await claimOnce(demo(b, c, m2.mint()))).code).toBe('ok');
    expect(m.calls).toEqual(['tA']);
    expect(m2.calls).toEqual(['tB']); // tA was found on chain
    b.unlock();
  });

  it('reconcilePending reads only from the recorded inbox position on, and needs an entry', async () => {
    const c = chain();
    const e = new Uint8Array(192).fill(5);
    c.inbox.push(e, new Uint8Array(192).fill(6));
    const p = { since: 0, notAfter: 100, stage: 'mint-and-deposit' as const, entry: hex(e) };
    expect(await reconcilePending(c.rt, ACCOUNT, { ...p, inboxFrom: '0' }, 50)).toBe('landed');
    expect(await reconcilePending(c.rt, ACCOUNT, { ...p, inboxFrom: '1' }, 50)).toBe('settling');
    expect(await reconcilePending(c.rt, ACCOUNT, { ...p, inboxFrom: '1' }, 500)).toBe('not-landed');
    expect(await reconcilePending(c.rt, ACCOUNT, { ...p, inboxFrom: '9' }, 50)).toBe('landed'); // beyond the count: from 0
    expect(await reconcilePending(c.rt, ACCOUNT, { since: 0, notAfter: 0, stage: 'mint' }, 50)).toBe('unknowable');
    expect(unhex(p.entry)).toEqual(e);
  });

  it('the faucet records the pending token BEFORE every submission (source order)', () => {
    const src = readFileSync(join(__dirname, '../src/demo/faucet.ts'), 'utf8');
    const before = (a: string, b: string, from = 0) => {
      const i = src.indexOf(a, from);
      const j = src.indexOf(b, i);
      expect([a, i]).not.toEqual([a, -1]);
      expect([b, j > i]).toEqual([b, true]);
      return j;
    };
    const direct = src.indexOf('async direct(');
    before("beforeSubmit?.({ stage: 'mint-and-deposit'", 'contracts.submitTx(', direct);
    before("beforeSubmit?.({ stage: 'mint' })", 'submitCallTx as unknown');
    before("beforeSubmit?.({ stage: 'deposit', entry })", 'custody.depositShielded(coin, entry)');
  });
});
