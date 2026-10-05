// AA 00060 P10.3 (the security review's fix pass): the page-side findings, each as a test that failed
// before its fix (audits/00060-night-market-bridge-wallet-security.md).
//
//   C3   (F-A4, F-B3) a `signAndSendTransaction` that times out may still have sent the lock: the page keeps
//        a record BEFORE it asks the wallet, says the status is unknown (never "nothing was sent"), keeps
//        the wallet's late answer, finds the lock on Solana by its exact message, and blocks a new Bridge
//        in of that token until it has. A wallet that DECLINES (4001) did send nothing: no record stays.
//   C10  (F-A7) Bridge in completes on the delivered coin only (I-3 `delivery.coin`, by the page's own
//        decode), never on a balance that another coin raised.
//   C7   (F-B4) "Find my transfers" adopts an open transfer whose record this browser left unusable (no
//        entitlement, or marked failed after an interrupted tx1).
//
// New page functions are reached through dynamic imports, so the run before the fix fails on each test's
// own assertion instead of on the file's imports.

import nacl from 'tweetnacl';
import { describe, expect, it } from 'vitest';

import { bytesToHex, contractCoinCommitment, solanaAddressOf, type StoredCoin } from '@nightmarket/core';
import type { BridgeEntry } from '@nightmarket/core/bridge';
import { TOKEN_PROGRAM_ID, associatedTokenAddress, splitTransaction } from '@nightmarket/core/solana';

import { followBridgeIn, precheckBridgeIn, sendBridgeIn, type BridgeInContext } from '../src/bridge/in/operations.js';
import type { BridgeInRecord } from '../src/bridge/in/records.js';
import type { BridgeOutRecord } from '../src/bridge/out/records.js';
import { SolanaRpc } from '../src/bridge/solana-rpc.js';
import { WalletError } from '../src/wallet/wallet-errors.js';
import journeyFixture from '../../test/fixtures/journey-registry.undeployed.json';
import { deploymentRecordOf, mockBridgeApi, transferView } from '../../test/mocks/bridge-api.js';
import { asFetch } from '../../test/mocks/http.js';
import { mockSolanaRpc } from '../../test/mocks/solana-rpc.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

const ACCOUNT = '4f'.repeat(32);
const entry: BridgeEntry = {
  colour: '5d17c86110853c018dfcc6428a8c11a7ddfbf2f7d79c50d1b4b3411fa740f32b',
  splMint: 'cGfHiC6Kgg3FpFZvgwGcswsCRtp4aBP2fzuXRQPizuN',
  bridgeContract: 'a1'.repeat(32),
  bridgeProgram: 'EWo1KkENqJgXTfLz6tGRqfu8XJVsELwmkHHUgPtHB1sc',
  bridgeApi: 'http://127.0.0.1:18080',
  name: 'Test X',
  symbol: 'X',
  decimals: 6,
};
const mintData = (decimals: number) => {
  const d = new Uint8Array(82);
  d[44] = decimals;
  d[45] = 1;
  return d;
};

function setup() {
  const kp = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(3));
  const depositor = solanaAddressOf(bytesToHex(kp.publicKey));
  const chain = mockSolanaRpc();
  const bridge = mockBridgeApi();
  const rpc = new SolanaRpc('http://rpc.test', asFetch(chain.handler));
  chain.accounts.set(entry.splMint, { owner: TOKEN_PROGRAM_ID, data: mintData(6) });
  chain.tokenBalances.set(associatedTokenAddress(depositor, entry.splMint), { amount: 600_000_000n, decimals: 6 });
  chain.balances.set(depositor, 1_000_000_000);
  const signWire = (wire: Uint8Array): Uint8Array => {
    const { message } = splitTransaction(wire);
    const out = Uint8Array.from(wire);
    out.set(nacl.sign.detached(message, kp.secretKey), 1);
    return out;
  };
  const ctx: BridgeInContext = {
    rpc,
    chain: 'solana:localnet',
    depositor,
    account: ACCOUNT,
    accountCheck: 'ok',
    transactions: null,
    fetchImpl: asFetch(bridge.handler),
  };
  return { ctx, chain, bridge, depositor, signWire };
}

const lockcLine = (nonce: number, depositor: string) =>
  `Program log: EFFECTSTREAM_BRIDGE|LOCKC|${nonce}|${depositor}|${entry.splMint}|500000000|${ACCOUNT}`;
const stored = (coin: { nonce: string; colour: string; value: string }): StoredCoin => ({
  nonce: coin.nonce,
  color: coin.colour,
  value: coin.value,
  commitment: contractCoinCommitment({ nonce: coin.nonce, color: coin.colour, value: coin.value }, ACCOUNT),
  mtIndex: '9',
  origin: 'inbox',
  inInbox: true,
  spent: false,
});

describe('C3: a timed-out sign-and-send may have sent the lock (F-A4, F-B3)', () => {
  it('a record before the wallet; "unknown", never "nothing was sent"; the lock found on Solana; a retry blocked until then', async () => {
    const ops: Any = await import('../src/bridge/in/operations.js');
    expect(typeof ops.reconcileBridgeIn).toBe('function');
    expect(typeof ops.blocksNewBridgeIn).toBe('function');
    const s = setup();
    let late: Promise<Uint8Array> | null = null;
    s.ctx.transactions = {
      // The wallet SENDS the lock, but answers after the page's timeout.
      signAndSend: async (tx: Uint8Array) => {
        const signed = s.signWire(tx);
        await s.ctx.rpc.sendTransaction(signed);
        late = new Promise((r) => setTimeout(() => r(splitTransaction(signed).signatures[0]!), 30));
        throw Object.assign(new WalletError('timeout', 'Your wallet did not answer in time.'), { late });
      },
    };
    const prepared: BridgeInRecord[] = [];
    const lateRecords: BridgeInRecord[] = [];
    const err: Any = await sendBridgeIn(s.ctx, entry, 500_000_000n, 0n, 1000, {
      onPrepared: (r: BridgeInRecord) => prepared.push(r),
      onLate: (r: BridgeInRecord) => lateRecords.push(r),
    } as never).then(
      () => null,
      (e: unknown) => e,
    );
    // Saved BEFORE the wallet was asked.
    expect(prepared).toHaveLength(1);
    expect(prepared[0]!.state).toBe('signing');
    // The outcome is uncertain, and the page does not claim otherwise.
    expect(err).toBeInstanceOf(ops.BridgeInUncertain);
    expect(String(err.message)).not.toMatch(/Nothing was (sent|locked)/);
    expect(err.record.state).toBe('unknown');
    expect(ops.blocksNewBridgeIn([err.record], entry.colour)).toBe(true);
    // The wallet's late answer is kept.
    await new Promise((r) => setTimeout(r, 60));
    expect(lateRecords[0]).toMatchObject({ state: 'sent', signature: s.chain.sent[0]!.signature });
    // Without the late answer, the page finds the lock on Solana by its exact message.
    const found = await ops.reconcileBridgeIn(err.record, s.ctx);
    expect(found).toMatchObject({ state: 'sent', signature: s.chain.sent[0]!.signature });
    expect(ops.blocksNewBridgeIn([found], entry.colour)).toBe(false);
  });

  it('nothing on Solana and the blockhash expired: then, and only then, "nothing was locked"', async () => {
    const ops: Any = await import('../src/bridge/in/operations.js');
    const s = setup();
    s.ctx.transactions = {
      signAndSend: async () => {
        throw Object.assign(new WalletError('timeout', 'Your wallet did not answer in time.'), {
          late: new Promise<never>(() => undefined),
        });
      },
    };
    const err: Any = await sendBridgeIn(s.ctx, entry, 500_000_000n, 0n, 1000, {} as never).catch((e: unknown) => e);
    expect(err?.record?.state).toBe('unknown');
    const still = await ops.reconcileBridgeIn(err.record, s.ctx);
    expect(still.state).toBe('unknown');
    s.chain.advanceBlockHeight(1000);
    const expired = await ops.reconcileBridgeIn(err.record, s.ctx);
    expect(expired.state).toBe('failed');
    expect(expired.progress).toMatch(/Nothing was locked/);
  });

  it('a wallet that declines (4001) sent nothing: the pending record is withdrawn', async () => {
    const s = setup();
    const removed: BridgeInRecord[] = [];
    s.ctx.transactions = {
      signAndSend: async () => {
        throw new WalletError('rejected');
      },
    };
    await expect(
      sendBridgeIn(s.ctx, entry, 500_000_000n, 0n, 1000, {
        onWithdrawn: (r: BridgeInRecord) => removed.push(r),
      } as never),
    ).rejects.toBeInstanceOf(WalletError);
    expect(removed).toHaveLength(1);
    expect(s.chain.sent).toEqual([]);
  });
});

describe('C3: the search for a lost lock is bounded, and a search cut short never says "nothing was locked"', () => {
  const base: BridgeInRecord = {
    direction: 'in',
    key: 'ab'.repeat(32),
    message: Buffer.from('the lock message').toString('base64'),
    lastValidBlockHeight: '100',
    fromSlot: '500',
    source: '11111111111111111111111111111111',
    colour: entry.colour,
    mint: entry.splMint,
    symbol: entry.symbol,
    amount: '1',
    bridgeApi: entry.bridgeApi,
    balanceBefore: '0',
    createdAt: 1,
    state: 'unknown',
  };
  const rpcWith = (slotOf: (page: number, i: number) => number) => {
    let pages = 0;
    return {
      pages: () => pages,
      rpc: {
        blockHeight: async () => 1_000n,
        signatureStatus: async () => null,
        transactionWire: async () => null,
        signaturesForAddress: async () => {
          const page = pages++;
          return Array.from({ length: 100 }, (_, i) => ({ signature: `s${page}-${i}`, slot: BigInt(slotOf(page, i)) }));
        },
      } as unknown as SolanaRpc,
    };
  };

  it('every page newer than the lock: still unknown after the page limit (not "failed")', async () => {
    const { reconcileBridgeIn, BRIDGE_IN_SEARCH_PAGES } = await import('../src/bridge/in/operations.js');
    const t = rpcWith(() => 900);
    const r = await reconcileBridgeIn(base, { rpc: t.rpc });
    expect(r.state).toBe('unknown');
    expect(t.pages()).toBe(BRIDGE_IN_SEARCH_PAGES);
  });

  it('the search reaches the slot before the lock and the blockhash expired: failed, nothing was locked', async () => {
    const { reconcileBridgeIn } = await import('../src/bridge/in/operations.js');
    const t = rpcWith((page, i) => (page === 1 && i === 50 ? 400 : 900));
    const r = await reconcileBridgeIn(base, { rpc: t.rpc });
    expect(r.state).toBe('failed');
    expect(r.progress).toMatch(/Nothing was locked/);
    expect(t.pages()).toBe(2);
  });
});

describe('C10: Bridge in completes on the delivered coin only (F-A7)', () => {
  async function sent() {
    const s = setup();
    s.ctx.transactions = {
      signAndSend: async (tx: Uint8Array) => {
        const signed = s.signWire(tx);
        await s.ctx.rpc.sendTransaction(signed);
        return splitTransaction(signed).signatures[0]!;
      },
    };
    s.chain.logsFor = () => ['Program x invoke [1]', lockcLine(4, s.depositor), 'Program x success'];
    const rec = await sendBridgeIn(s.ctx, entry, 500_000_000n, 0n);
    return { ...s, rec };
  }
  const other = stored({ nonce: '77'.repeat(32), colour: entry.colour, value: '500000000' });

  it('another coin of the same token (a second Bridge in, a trade) does not complete this lock', async () => {
    const { ctx, bridge, rec } = await sent();
    bridge.setTransfer(transferView({ id: 's2m:4', status: 'submitted', recipient: ACCOUNT }));
    let r = await followBridgeIn(rec, ctx, async () => []);
    r = await followBridgeIn(r, ctx, async () => [other]);
    expect(r.state).not.toBe('completed');
    // The bridge cannot be read: still not completed by a balance.
    const down = { ...ctx, fetchImpl: (async () => new Response('', { status: 500 })) as typeof fetch };
    expect((await followBridgeIn(r, down, async () => [other])).state).not.toBe('completed');
  });

  it('the delivered coin completes it (through the bridge node’s real {transfer} answer)', async () => {
    const { ctx, bridge, rec } = await sent();
    const delivered = { nonce: '5e'.repeat(32), colour: entry.colour, value: '500000000' };
    bridge.setTransfer(
      transferView({
        id: 's2m:4',
        status: 'completed',
        recipient: ACCOUNT,
        delivery: { adapter: 'passport-ed25519@21493588', account: ACCOUNT, coin: delivered, tx: null },
      }),
    );
    let r = await followBridgeIn(rec, ctx, async () => []);
    r = await followBridgeIn(r, ctx, async () => [other, stored(delivered)]);
    expect(r.state).toBe('completed');
  });
});

describe('C7: "Find my transfers" adopts a transfer whose local record is unusable (F-B4)', () => {
  it('a record left without an entitlement, or marked failed after an interrupted tx1, is adopted again', async () => {
    const ops: Any = await import('../src/bridge/out/operations.js');
    expect(typeof ops.transfersToAdopt).toBe('function');
    const rec = (authNonce: string, o: Partial<BridgeOutRecord>) =>
      ({ authNonce, state: 'tx1-sent', ...o }) as BridgeOutRecord;
    const found = ['1', '2', '3', '4'].map((authNonce) => ({ authNonce, open: true }));
    const records = [
      rec('1', { state: 'tx1-sent', entitlement: `le1.${'a'.repeat(64)}.${'b'.repeat(64)}.1.${'c'.repeat(64)}` }),
      rec('2', { state: 'failed' }),
      rec('3', { state: 'tx1-signing' }),
    ];
    const adopt = ops.transfersToAdopt(found, records).map((f: Any) => f.authNonce);
    expect(adopt).toEqual(['2', '3', '4']);
  });
});
describe('C11: the site checks each bridge’s own deployment record (F-A10)', () => {
  it('a bridge whose GET /deployment names another mint: bridging refused, naming the token; a matching one or none: ready', async () => {
    const { checkBridges } = await import('../src/bridge/registry.js');
    const journey = structuredClone(journeyFixture) as {
      solanaGenesisHash: string;
      tokens: Array<Record<string, Any>>;
    };
    const recordOf = (t: Record<string, Any>) => ({
      schema: 'effectstream.solana-midnight-bridge.deployment/1',
      splMint: t.splMint,
      splMintDecimals: t.decimals,
      name: t.name,
      symbol: t.symbol,
      bridgeProgram: t.bridgeProgram,
      bridgeContract: t.bridgeContract,
      colour: t.colour,
      midnightNetwork: 'undeployed',
      solanaGenesisHash: journey.solanaGenesisHash,
      api: t.bridgeApi,
    });
    const serve = (deployment: (t: Record<string, Any>) => Response) =>
      (async (input: Any, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === 'POST') return Response.json({ jsonrpc: '2.0', id: 1, result: journey.solanaGenesisHash });
        const t = journey.tokens.find((x) => url === `${x.bridgeApi}/deployment`);
        return t ? deployment(t) : new Response('', { status: 404 });
      }) as typeof fetch;
    const solana = { rpcUrl: 'http://rpc.test', genesisHash: null, cluster: 'solana:localnet' };
    const same = await checkBridges(
      journey,
      'undeployed',
      solana,
      serve((t) => Response.json(recordOf(t))),
    );
    expect(same.state).toBe('ready');
    const none = await checkBridges(
      journey,
      'undeployed',
      solana,
      serve(() => new Response('', { status: 503 })),
    );
    expect(none.state).toBe('ready');
    const swapped = await checkBridges(
      journey,
      'undeployed',
      solana,
      serve((t) =>
        Response.json(
          t.symbol === 'X' ? { ...recordOf(t), splMint: '1thX6LZfHDZZKUs92febYZhYRcXddmzfzF2NvTkPNE' } : recordOf(t),
        ),
      ),
    );
    expect(swapped).toMatchObject({ state: 'refused' });
    expect((swapped as Any).reason).toMatch(/X/);
  });
});

// ── Round 2 (AA 00060 P10.4): the audit's round-2 consolidation, D1 and D4–D7 (page side) ─────────────────

/** A readable transaction body that is not the lock (another transfer of the token account). */
const otherWire = () => {
  const w = new Uint8Array(1 + 64 + 40);
  w[0] = 1;
  w.fill(7, 65);
  return w;
};
/** An RPC whose `method` fails (throws, or answers nothing for a transaction it listed). */
function failing(
  rpc: SolanaRpc,
  method: 'transactionWire' | 'signaturesForAddress' | 'blockHeight' | 'signatureStatus',
  how: 'throw' | 'null',
): SolanaRpc {
  const f = Object.create(rpc) as Record<string, unknown>;
  f[method] = async () => {
    if (how === 'throw') throw new Error('429 Too Many Requests');
    return null;
  };
  return f as unknown as SolanaRpc;
}
/** The wallet SENT the lock and its answer is lost; the lock's blockhash has expired. */
async function sentThenLost() {
  const s = setup();
  s.ctx.transactions = {
    signAndSend: async (tx: Uint8Array) => {
      const signed = s.signWire(tx);
      await s.ctx.rpc.sendTransaction(signed);
      throw Object.assign(new WalletError('timeout', 'Your wallet did not answer in time.'), {
        late: new Promise<never>(() => undefined),
      });
    },
  };
  const err: Any = await sendBridgeIn(s.ctx, entry, 500_000_000n, 0n, 1000, {} as never).catch((e: unknown) => e);
  expect(err?.record?.state).toBe('unknown');
  s.chain.advanceBlockHeight(1000);
  return { s, rec: err.record as BridgeInRecord };
}

describe('D1: a Solana lookup that fails is never "not found" (R-A2, R-B1)', () => {
  it('the lock WAS sent and the RPC fails to return it: unknown, never "Nothing was locked", still blocking; then found', async () => {
    const ops: Any = await import('../src/bridge/in/operations.js');
    const { s, rec } = await sentThenLost();
    const cases = [
      ['transactionWire', 'throw'],
      ['transactionWire', 'null'],
      ['signaturesForAddress', 'throw'],
      ['blockHeight', 'throw'],
    ] as const;
    for (const [method, how] of cases) {
      const r: BridgeInRecord = await ops
        .reconcileBridgeIn(rec, { rpc: failing(s.ctx.rpc, method, how) }, 2000)
        .catch((e: unknown) => ({ state: `threw: ${String(e)}` }));
      expect(r.state, `${method} ${how}`).toBe('unknown');
      expect(r.progress ?? '', `${method} ${how}`).not.toMatch(/Nothing was locked/);
      expect(ops.blocksNewBridgeIn([r], entry.colour), `${method} ${how}`).toBe(true);
    }
    // A definite answer once Solana can be read: the lock is found.
    const ok = await ops.reconcileBridgeIn(rec, s.ctx, 3000);
    expect(ok).toMatchObject({ state: 'sent', signature: s.chain.sent[0]!.signature });
  });

  it('after a failed lookup the page waits before asking Solana again (backoff), then asks', async () => {
    const ops: Any = await import('../src/bridge/in/operations.js');
    const { s, rec } = await sentThenLost();
    const r1: Any = await ops.reconcileBridgeIn(rec, { rpc: failing(s.ctx.rpc, 'transactionWire', 'throw') }, 10_000);
    expect(r1.state).toBe('unknown');
    expect(r1.lookupErrors).toBe(1);
    const calls = s.chain.calls.length;
    const r2 = await followBridgeIn(r1, s.ctx, async () => [], 10_500);
    expect(s.chain.calls.length).toBe(calls);
    expect(r2).toEqual(r1);
    const r3 = await followBridgeIn(r1, s.ctx, async () => [], 70_000);
    expect(r3.state).toBe('sent');
  });
});

const lostBase: BridgeInRecord = {
  direction: 'in',
  key: 'ab'.repeat(32),
  message: Buffer.from('the lock message').toString('base64'),
  lastValidBlockHeight: '100',
  fromSlot: '500',
  source: '11111111111111111111111111111111',
  colour: entry.colour,
  mint: entry.splMint,
  symbol: entry.symbol,
  amount: '1',
  bridgeApi: entry.bridgeApi,
  balanceBefore: '0',
  createdAt: 1,
  state: 'unknown',
};

describe('D5: a lock nobody can find no longer blocks the token for good (R-A5)', () => {
  it('once the request has expired, the search resumes where it stopped, and completes', async () => {
    const ops: Any = await import('../src/bridge/in/operations.js');
    // 1,500 transactions of the token account: the 1,200 newest after the lock's slot, then older ones.
    const sigs = Array.from({ length: 1500 }, (_, i) => ({
      signature: `s${i + 1}`,
      slot: BigInt(i < 1200 ? 900 : 400),
    }));
    const rpc = {
      blockHeight: async () => 1_000n,
      signatureStatus: async () => null,
      transactionWire: async () => otherWire(),
      signaturesForAddress: async (_a: string, limit = 100, before?: string) => {
        const start = before ? sigs.findIndex((x) => x.signature === before) + 1 : 0;
        return sigs.slice(start, start + limit);
      },
    } as unknown as SolanaRpc;
    const r1: Any = await ops.reconcileBridgeIn(lostBase, { rpc }, 10);
    expect(r1.state).toBe('unknown');
    expect(r1.blockhashExpired).toBe(true);
    expect(r1.searchBefore).toBe('s1000');
    const r2: Any = await ops.reconcileBridgeIn(r1, { rpc }, 20);
    expect(r2.state).toBe('failed');
    expect(r2.progress).toMatch(/Nothing was locked/);
  });

  it('"Stop checking": only once the request has expired; the record is final and the token unblocked', async () => {
    const ops: Any = await import('../src/bridge/in/operations.js');
    expect(typeof ops.dismissBridgeIn).toBe('function');
    expect(() => ops.dismissBridgeIn(lostBase, 5)).toThrow(/expired/);
    const d: Any = ops.dismissBridgeIn({ ...lostBase, blockhashExpired: true }, 5);
    expect(d.state).toBe('dismissed');
    expect(ops.isFinal(d)).toBe(true);
    expect(ops.blocksNewBridgeIn([d], entry.colour)).toBe(false);
  });
});

describe('D4: "Find my transfers" renews an expired entitlement (R-A4, R-B3)', () => {
  it('a record whose entitlement has expired is adopted again; one with a live entitlement is left alone', async () => {
    const ops: Any = await import('../src/bridge/out/operations.js');
    const token = (exp: string) => `le1.${'a'.repeat(64)}.${'b'.repeat(64)}.${exp}.${'c'.repeat(64)}`;
    const found = ['1', '2'].map((authNonce) => ({ authNonce, open: true }));
    const records = [
      { authNonce: '1', state: 'landed', entitlement: token('1700000000') },
      { authNonce: '2', state: 'landed', entitlement: token('1900000000') },
    ];
    expect(ops.transfersToAdopt(found, records, 1_800_000_000).map((f: Any) => f.authNonce)).toEqual(['1']);
    expect(typeof ops.entitlementExpired).toBe('function');
    expect(ops.entitlementExpired(token('1700000000'), 1_800_000_000)).toBe(true);
    expect(ops.entitlementExpired(token('1900000000'), 1_800_000_000)).toBe(false);
  });
});

describe('D6: a stopped tx1 record always fits the backup format (R-B4)', () => {
  const stopped = (authNonce: string, progress: string): BridgeOutRecord => ({
    direction: 'out',
    authNonce,
    colour: entry.colour,
    symbol: 'X',
    amount: '5',
    bridgeContract: entry.bridgeContract,
    bridgeProgram: entry.bridgeProgram,
    bridgeApi: entry.bridgeApi,
    wallet: entry.bridgeProgram,
    spentCoin: { nonce: 'd1'.repeat(32), color: entry.colour, value: '9' },
    landingCoinPublicKey: 'cc'.repeat(32),
    landingNonce: 'd2'.repeat(32),
    landingCommitment: 'd3'.repeat(32),
    check: 'ab'.repeat(16),
    createdAt: 1,
    state: 'failed',
    progress,
  });

  it('a long error keeps the "Find my transfers" advice within 300 characters, and the backup imports', async () => {
    const ops: Any = await import('../src/bridge/out/operations.js');
    expect(typeof ops.tx1StoppedProgress).toBe('function');
    const progress: string = ops.tx1StoppedProgress(new Error('x'.repeat(400)));
    expect(progress.length).toBeLessThanOrEqual(300);
    expect(progress.endsWith(ops.TX1_MAY_HAVE_MOVED)).toBe(true);
    const { LocalStore } = await import('../src/store/store.js');
    const { putBridgeOut } = await import('../src/bridge/out/records.js');
    const scope = { network: 'stagenet', owner: '22'.repeat(32) } as const;
    localStorage.clear();
    const store = new LocalStore(localStorage);
    putBridgeOut(store, scope, ACCOUNT, stopped('7', progress));
    // A record handed a longer progress is bounded when it is stored.
    putBridgeOut(store, scope, ACCOUNT, stopped('8', 'y'.repeat(400)));
    const file = JSON.parse(JSON.stringify(store.exportWallet(scope))) as unknown;
    localStorage.clear();
    expect(new LocalStore(localStorage).importWallet(file, scope).imported).toBe(2);
  });
});

describe('D7: Bridge in refuses a bridge whose deployment cannot be verified (R-B5)', () => {
  function withDeployment(deployment?: unknown) {
    const s = setup();
    const bridge = mockBridgeApi(deployment ? { deployment } : {});
    s.ctx.fetchImpl = asFetch(bridge.handler);
    s.ctx.transactions = {
      signAndSend: async () => {
        throw new Error('the wallet is not asked here');
      },
    };
    return s;
  }

  it('no deployment record, or one naming another mint: refused before the wallet; a matching one: allowed', async () => {
    const none = withDeployment();
    await expect(precheckBridgeIn(none.ctx, entry, 1_000_000n)).rejects.toThrow(/cannot be verified/);
    const other = withDeployment({
      ...deploymentRecordOf(entry),
      splMint: '1thX6LZfHDZZKUs92febYZhYRcXddmzfzF2NvTkPNE',
    });
    await expect(precheckBridgeIn(other.ctx, entry, 1_000_000n)).rejects.toThrow(/SPL mint/);
    const same = withDeployment(deploymentRecordOf(entry));
    await expect(precheckBridgeIn(same.ctx, entry, 1_000_000n)).resolves.toMatchObject({ splBalance: 600_000_000n });
  });
});
/* eslint-enable @typescript-eslint/no-explicit-any */
