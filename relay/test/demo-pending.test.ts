// AA 00047 P10, audit round 2 R2-7 (F-B2-4) and R2-9 (F-A2-7.3, the lost progress write): a demo
// token is never minted twice. Before its transaction is submitted, the claim records it as PENDING
// (the inbox entry it files, and when it can no longer land); a resumed claim (after a failure, a lost
// response or a crash) reconciles every pending token against the account's on-chain inbox before
// anything is minted again, and quarantines what it cannot check.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { DemoMintUnclearError, demoTokens, reconcilePending, type DemoMint } from '../src/demo/action.js';
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
    before("beforeSubmit?.({ stage: 'deposit', entry", 'custody.depositShielded(coin, entry)');
    // AA 00047 P11, R3-8: the confirmed mint is recorded before the deposit is built.
    before("beforeSubmit?.({ stage: 'minted', mintTx })", "beforeSubmit?.({ stage: 'deposit', entry");
  });
});

// AA 00047 P11, audit round 3 R3-8 (F-B3-7): on `via-sponsor`, the confirmed mint (the coin in the
// sponsor wallet) is recorded apart from the deposit, so a resumed claim after a confirmed mint
// deposits ONLY, and quarantines what it cannot tell.
describe('via-sponsor: a confirmed mint is never minted again (R3-8)', () => {
  /** A via-sponsor faucet on the fake chain, following ./faucet.ts `viaSponsor`'s protocol: the mint
   *  (`mint` → the sponsor's balance → `minted`), then the deposit (`deposit`, its entry). */
  function viaSponsor(c: ReturnType<typeof chain>) {
    const balance = new Map<string, bigint>();
    const mintCalls: string[] = [];
    const depositCalls: string[] = [];
    let n = 0;
    const faucet =
      (
        o: {
          crash?: 'after-mint' | 'after-deposit-submit';
          depositLands?: boolean;
          ttl?: number;
        } = {},
      ): DemoMint =>
      async ({ item: it, beforeSubmit, resume }) => {
        const amount = BigInt(it.amount);
        let mintTx = resume?.mintTx;
        if (!resume) {
          beforeSubmit({ stage: 'mint' });
          mintCalls.push(it.symbol);
          balance.set(it.colour, (balance.get(it.colour) ?? 0n) + amount);
          mintTx = `${++n}`.repeat(64).slice(0, 64);
          beforeSubmit({ stage: 'minted', mintTx });
          if (o.crash === 'after-mint') throw new Error('socket hang up: the relay stopped');
        } else if ((balance.get(it.colour) ?? 0n) < amount) {
          throw new DemoMintUnclearError('the sponsor does not hold the minted token');
        }
        const entry = new Uint8Array(192).fill(++n);
        beforeSubmit({
          stage: 'deposit',
          entry,
          ...(mintTx ? { mintTx } : {}),
          notAfter: Math.floor(Date.now() / 1000) + (o.ttl ?? 3600),
        });
        depositCalls.push(it.symbol);
        if (o.depositLands !== false) {
          c.inbox.push(entry);
          balance.set(it.colour, balance.get(it.colour)! - amount);
        }
        if (o.crash === 'after-deposit-submit') throw new Error('socket hang up: the response was lost');
        return { ...(mintTx ? { mint: mintTx } : {}), deposit: `d${n}`.padEnd(64, '0') };
      };
    return { balance, mintCalls, depositCalls, faucet };
  }
  const viaSponsorDemo = (claims: DemoTokenClaims, c: ReturnType<typeof chain>, mint: DemoMint, now?: () => number) =>
    demoTokens({
      runtime: () => c.rt,
      sponsor: new FakeSponsor(),
      claims,
      pack: [TA],
      path: 'via-sponsor',
      arm: testArm,
      mint,
      log: silentLog(),
      ...(now ? { now } : {}),
    });

  it('a mint confirmed in the sponsor wallet and then cut off before its deposit: the resumed claim deposits only', async () => {
    const c = chain();
    const claims = new DemoTokenClaims({ file: null, dailyCap: 10 });
    const f = viaSponsor(c);
    let first = true;
    const mint: DemoMint = (o) => (first ? ((first = false), f.faucet({ crash: 'after-mint' })(o)) : f.faucet()(o));
    const d = viaSponsorDemo(claims, c, mint);
    expect((await claimOnce(d)).code).not.toBe('ok');
    expect(claims.record(OWNER)?.pending?.[TA.colour]).toMatchObject({ stage: 'minted' });
    const again = await claimOnce(d);
    expect(again.code).toBe('ok');
    expect(again.stages).toContain('reconciled:minted');
    expect(f.mintCalls).toEqual(['tA']); // minted ONCE
    expect(f.depositCalls).toEqual(['tA']);
    expect(c.inbox).toHaveLength(1);
    expect(claims.record(OWNER)).toMatchObject({ state: 'claimed' });
    const minted = (again.result as { minted: Array<{ txs: { mint?: string; deposit?: string } }> }).minted;
    expect(minted[0]!.txs.mint).toBe(claims.record(OWNER)!.delivered![TA.colour]!.mint);
  });

  it('a deposit that can no longer land is deposited again, never minted again (F-B3-7)', async () => {
    const c = chain();
    const claims = new DemoTokenClaims({ file: null, dailyCap: 10 });
    const f = viaSponsor(c);
    let now = Math.floor(Date.now() / 1000);
    let first = true;
    const mint: DemoMint = (o) =>
      first
        ? ((first = false), f.faucet({ crash: 'after-deposit-submit', depositLands: false, ttl: 60 })(o))
        : f.faucet()(o);
    const d = viaSponsorDemo(claims, c, mint, () => now);
    expect((await claimOnce(d)).code).not.toBe('ok');
    expect(claims.record(OWNER)?.pending?.[TA.colour]).toMatchObject({ stage: 'deposit' });
    expect(claims.record(OWNER)?.pending?.[TA.colour]?.mintTx).toMatch(/^[0-9a-f]{64}$/);
    // Before the deposit's last landing time: the claim waits (nothing minted, nothing deposited).
    expect((await claimOnce(d)).code).toBe('demo-tokens-settling');
    now += 3600 + 600; // past its TTL and the margin: it can no longer land
    const again = await claimOnce(d);
    expect(again.code).toBe('ok');
    expect(f.mintCalls).toEqual(['tA']); // the sponsor's first mint is used; no second issuance
    expect(f.depositCalls).toEqual(['tA', 'tA']);
    expect(c.inbox).toHaveLength(1);
  });

  it('a deposit found on chain is delivered, keeping the mint’s transaction id', async () => {
    const c = chain();
    const claims = new DemoTokenClaims({ file: null, dailyCap: 10 });
    const f = viaSponsor(c);
    let first = true;
    const mint: DemoMint = (o) =>
      first ? ((first = false), f.faucet({ crash: 'after-deposit-submit' })(o)) : f.faucet()(o);
    const d = viaSponsorDemo(claims, c, mint);
    await claimOnce(d);
    const mintTx = claims.record(OWNER)?.pending?.[TA.colour]?.mintTx;
    const again = await claimOnce(d);
    expect(again.code).toBe('ok');
    expect(f.mintCalls).toEqual(['tA']);
    expect(f.depositCalls).toEqual(['tA']);
    expect(claims.record(OWNER)?.delivered?.[TA.colour]).toMatchObject({ mint: mintTx, reconciled: true });
  });

  it('a resumed deposit whose minted token the sponsor no longer holds is QUARANTINED: never minted or deposited again', async () => {
    const c = chain();
    const claims = new DemoTokenClaims({ file: null, dailyCap: 10 });
    const f = viaSponsor(c);
    let first = true;
    const mint: DemoMint = (o) => (first ? ((first = false), f.faucet({ crash: 'after-mint' })(o)) : f.faucet()(o));
    const d = viaSponsorDemo(claims, c, mint);
    await claimOnce(d);
    f.balance.set(TA.colour, 0n); // the sponsor's coin went elsewhere: the state is unclear
    const again = await claimOnce(d);
    expect(again.code).toBe('ok');
    expect(again.result).toMatchObject({ held: [{ symbol: 'tA', colour: TA.colour }], minted: [] });
    expect(claims.record(OWNER)?.quarantined?.[TA.colour]).toMatchObject({ stage: 'minted' });
    expect(f.mintCalls).toEqual(['tA']);
    expect(f.depositCalls).toEqual([]);
    expect(await claimOnce(d)).toMatchObject({ code: 'refused:already-claimed' });
  });

  it('a mint submitted but never confirmed stays unclear: quarantined, as before', async () => {
    const c = chain();
    const claims = new DemoTokenClaims({ file: null, dailyCap: 10 });
    const f = viaSponsor(c);
    let first = true;
    const mint: DemoMint = (o) =>
      first
        ? ((first = false),
          (async ({ beforeSubmit }) => {
            beforeSubmit({ stage: 'mint' });
            throw new Error('socket hang up');
          }) as DemoMint)(o)
        : f.faucet()(o);
    const d = viaSponsorDemo(claims, c, mint);
    await claimOnce(d);
    const again = await claimOnce(d);
    expect(again.result).toMatchObject({ held: [{ symbol: 'tA' }] });
    expect(f.mintCalls).toEqual([]);
  });

  it('DemoFaucets.viaSponsor with `resume` deposits from the sponsor’s balance and never mints; without the balance it says the state is unclear', async () => {
    const { DemoFaucets } = await import('../src/demo/faucet.js');
    const Rx = await import('rxjs');
    const deposits: string[] = [];
    const rt = {
      providers: async () => ({}),
      compiledAccount: () => ({}),
      client: {
        account: {
          CustodyAccount: {
            connect: async () => ({
              depositShielded: async (_c: unknown, e: Uint8Array) => {
                deposits.push(hex(e).slice(0, 8));
                return { txId: 'dd'.repeat(32) };
              },
            }),
          },
        },
      },
    } as unknown as PassportRuntime;
    const faucets = new DemoFaucets(rt, silentLog());
    // Any mint would load the faucet bundle, which this runtime does not have: it would throw.
    const wallet = (held: bigint) =>
      ({
        wallet: { state: () => Rx.of({ isSynced: true, shielded: { balances: { [TA.colour]: held } } }) },
      }) as never;
    const pendings: unknown[] = [];
    const out = await faucets.viaSponsor({
      wallet: wallet(5_000_000n),
      account: ACCOUNT,
      encKey: new Uint8Array(32).fill(9),
      item: TA,
      stage: () => {},
      beforeSubmit: (p) => pendings.push(p),
      resume: { mintTx: 'ab'.repeat(32) },
    });
    expect(out).toEqual({ mint: 'ab'.repeat(32), deposit: 'dd'.repeat(32) });
    expect(deposits).toHaveLength(1);
    expect(pendings).toMatchObject([{ stage: 'deposit', mintTx: 'ab'.repeat(32) }]);
    await expect(
      faucets.viaSponsor({
        wallet: wallet(999_999n),
        account: ACCOUNT,
        encKey: new Uint8Array(32).fill(9),
        item: TA,
        stage: () => {},
        resume: {},
      }),
    ).rejects.toBeInstanceOf(DemoMintUnclearError);
    expect(deposits).toHaveLength(1);
  });
});
