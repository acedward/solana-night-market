// AA 00060 P7 (T7.2-T7.5, T7.8, unit): Bridge in's checks, send and follow (web/src/bridge/in/operations.ts)
// against the mock Solana RPC and the mock bridge API (test/mocks), with a software wallet in the test
// (tweetnacl). Every refusal happens before the wallet is asked; completion is the page's own decode.

import nacl from 'tweetnacl';
import { describe, expect, it } from 'vitest';

import { bytesToHex, contractCoinCommitment, solanaAddressOf, type StoredCoin } from '@nightmarket/core';
import {
  UNDELIVERABLE_CODES,
  UNDELIVERABLE_TEXT,
  buildLockToAccount,
  type BridgeEntry,
} from '@nightmarket/core/bridge';
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  associatedTokenAddress,
  encodeKey,
  splitTransaction,
} from '@nightmarket/core/solana';

import {
  BridgeInRefused,
  MIN_FEE_LAMPORTS,
  followBridgeIn,
  pageBalance,
  precheckBridgeIn,
  sendBridgeIn,
  type BridgeInContext,
} from '../src/bridge/in/operations.js';
import type { BridgeInRecord } from '../src/bridge/in/records.js';
import { SolanaRpc } from '../src/bridge/solana-rpc.js';
import { WalletError, walletErrorFrom } from '../src/wallet/wallet-errors.js';
import { deploymentRecordOf, mockBridgeApi, transferView } from '../../test/mocks/bridge-api.js';
import { asFetch } from '../../test/mocks/http.js';
import { mockSolanaRpc } from '../../test/mocks/solana-rpc.js';

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

/** A classic SPL mint account's data: 82 bytes, decimals at byte 44, initialised at 45. */
const mintData = (decimals: number) => {
  const d = new Uint8Array(82);
  d[44] = decimals;
  d[45] = 1;
  return d;
};

type WalletMode = 'software' | 'reject' | 'tamper' | 'other-key';

function setup(opts: { features?: 'both' | 'send' | 'sign' | 'none'; spl?: bigint | null; lamports?: number } = {}) {
  const kp = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(3));
  const depositor = solanaAddressOf(bytesToHex(kp.publicKey));
  const chain = mockSolanaRpc();
  // The bridge's deployment record matches the entry (P10.4, audit D7: Bridge in verifies it first).
  const bridge = mockBridgeApi({ deployment: deploymentRecordOf(entry) });
  const rpc = new SolanaRpc('http://rpc.test', asFetch(chain.handler));
  chain.accounts.set(entry.splMint, { owner: TOKEN_PROGRAM_ID, data: mintData(6) });
  const ata = associatedTokenAddress(depositor, entry.splMint);
  if (opts.spl !== null) chain.tokenBalances.set(ata, { amount: opts.spl ?? 600_000_000n, decimals: 6 });
  chain.balances.set(depositor, opts.lamports ?? 1_000_000_000);
  const wallet = { mode: 'software' as WalletMode, asked: [] as string[] };
  const other = nacl.sign.keyPair();
  const signWire = (wire: Uint8Array): Uint8Array => {
    let bytes = wire;
    if (wallet.mode === 'tamper') {
      // The wallet "signs" another lock: 1 base unit more.
      bytes = buildLockToAccount({
        entry,
        depositor,
        amount: 500_000_001n,
        account: ACCOUNT,
        recentBlockhash: encodeKey(new Uint8Array(32).fill(9)),
      }).transaction;
    }
    const { message } = splitTransaction(bytes);
    const out = Uint8Array.from(bytes);
    out.set(nacl.sign.detached(message, wallet.mode === 'other-key' ? other.secretKey : kp.secretKey), 1);
    return out;
  };
  const refuse = () => {
    // A wallet's explicit rejection: code 4001 (P10.6, audit F1: only that, or a refusal before the call, is
    // "never sent").
    if (wallet.mode === 'reject') throw walletErrorFrom({ code: 4001, message: 'User rejected the request.' }, 'sign');
  };
  const signAndSend = async (tx: Uint8Array, c: string) => {
    wallet.asked.push(`signAndSend ${c}`);
    refuse();
    const signed = signWire(tx);
    await rpc.sendTransaction(signed);
    return splitTransaction(signed).signatures[0]!;
  };
  const sign = async (tx: Uint8Array, c: string) => {
    wallet.asked.push(`sign ${c}`);
    refuse();
    return signWire(tx);
  };
  const f = opts.features ?? 'both';
  const ctx: BridgeInContext = {
    rpc,
    chain: 'solana:localnet',
    depositor,
    account: ACCOUNT,
    accountCheck: 'ok',
    transactions: f === 'none' ? null : { ...(f !== 'sign' ? { signAndSend } : {}), ...(f !== 'send' ? { sign } : {}) },
    fetchImpl: asFetch(bridge.handler),
  };
  return { ctx, chain, bridge, wallet, depositor, ata };
}

const refusal = async (p: Promise<unknown>) => {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(BridgeInRefused);
  return (e as Error).message;
};

describe('P7 Bridge in: the checks before the wallet is asked (FR-002)', () => {
  it('the honest case: the facts, the balances, no wallet request', async () => {
    const { ctx, wallet, ata } = setup();
    const pre = await precheckBridgeIn(ctx, entry, 500_000_000n);
    expect(pre.facts).toMatchObject({
      program: entry.bridgeProgram,
      mint: entry.splMint,
      amount: 500_000_000n,
      source: ata,
      account: ACCOUNT,
    });
    expect(pre.splBalance).toBe(600_000_000n);
    expect(pre.note).toBeNull();
    expect(wallet.asked).toEqual([]);
  });

  it('T7.2 a Token-2022 mint: refused, no wallet request', async () => {
    const { ctx, chain, wallet } = setup();
    chain.accounts.set(entry.splMint, { owner: TOKEN_2022_PROGRAM_ID, data: mintData(6) });
    expect(await refusal(precheckBridgeIn(ctx, entry, 1n))).toBe("Token-2022 tokens can't be bridged.");
    chain.accounts.set(entry.splMint, { owner: '11111111111111111111111111111111', data: mintData(6) });
    expect(await refusal(precheckBridgeIn(ctx, entry, 1n))).toMatch(/not a classic SPL token/);
    chain.accounts.set(entry.splMint, { owner: TOKEN_PROGRAM_ID, data: mintData(9) });
    expect(await refusal(precheckBridgeIn(ctx, entry, 1n))).toMatch(/decimals this site lists \(6\)/);
    chain.accounts.delete(entry.splMint);
    expect(await refusal(precheckBridgeIn(ctx, entry, 1n))).toMatch(/mint does not exist/);
    expect(wallet.asked).toEqual([]);
  });

  it("T7.3 the page's own account check failed or is pending, or the bridge says undeliverable: refused", async () => {
    const s = setup();
    expect(await refusal(precheckBridgeIn({ ...s.ctx, accountCheck: 'failed' }, entry, 1n))).toMatch(
      /check of your account on Midnight failed/,
    );
    expect(await refusal(precheckBridgeIn({ ...s.ctx, accountCheck: 'pending' }, entry, 1n))).toMatch(
      /waits until this page has checked your account/,
    );
    s.bridge.setVerdict(ACCOUNT, 'undeliverable', 'authority-live');
    expect(await refusal(precheckBridgeIn(s.ctx, entry, 1n))).toContain(UNDELIVERABLE_TEXT['authority-live']);
    s.bridge.setVerdict(ACCOUNT, 'retry');
    expect((await precheckBridgeIn(s.ctx, entry, 1n)).note).toMatch(/not read your account yet/);
    // P10.4 (audit D7, R-B5): a bridge that does not answer at all cannot be verified, so no lock.
    const down = { ...s.ctx, fetchImpl: (async () => new Response('', { status: 503 })) as typeof fetch };
    expect(await refusal(precheckBridgeIn(down, entry, 1n))).toMatch(/cannot be verified/);
    // Its deployment verified but its own account verdict unreadable: the page's check stands, with a note.
    const verdictDown = {
      ...s.ctx,
      fetchImpl: (async (u: RequestInfo | URL) =>
        String(u).endsWith('/deployment')
          ? Response.json(deploymentRecordOf(entry))
          : new Response('', { status: 503 })) as typeof fetch,
    };
    expect((await precheckBridgeIn(verdictDown, entry, 1n)).note).toMatch(
      /could not be read; this page's check passed/,
    );
    expect(s.wallet.asked).toEqual([]);
  });

  it('T7.4 too little SPL, no token account, too little SOL: refused, naming the token', async () => {
    expect(await refusal(precheckBridgeIn(setup({ spl: 100_000_000n }).ctx, entry, 500_000_000n))).toBe(
      'Your wallet holds only 100 X, less than the 500 X entered.',
    );
    expect(await refusal(precheckBridgeIn(setup({ spl: null }).ctx, entry, 1n))).toBe(
      'Your wallet holds no X in its token account.',
    );
    expect(await refusal(precheckBridgeIn(setup({ lamports: Number(MIN_FEE_LAMPORTS) - 1 }).ctx, entry, 1n))).toMatch(
      /needs a little SOL/,
    );
    expect(await refusal(precheckBridgeIn(setup().ctx, entry, 0n))).toMatch(/above zero/);
  });

  it('a wallet without transaction features: refused with the reason (P5.1, T5.4)', async () => {
    const { ctx } = setup({ features: 'none' });
    expect(await refusal(precheckBridgeIn(ctx, entry, 1n))).toMatch(/cannot sign Solana transactions here/);
  });
});

describe('P7 Bridge in: one transaction, exactly the lock', () => {
  it('signAndSendTransaction: the wallet sends the page-built lock; the record is "sent"', async () => {
    const { ctx, chain, wallet, depositor } = setup();
    const rec = await sendBridgeIn(ctx, entry, 500_000_000n, 7n, 1000);
    expect(wallet.asked).toEqual(['signAndSend solana:localnet']);
    expect(chain.sent).toHaveLength(1);
    expect(chain.sent[0]!.signature).toBe(rec.signature);
    expect(chain.sent[0]!.accountKeys[0]).toBe(depositor);
    expect(rec).toMatchObject({
      direction: 'in',
      state: 'sent',
      amount: '500000000',
      balanceBefore: '7',
      colour: entry.colour,
      mint: entry.splMint,
      bridgeApi: entry.bridgeApi,
      createdAt: 1000,
    });
  });

  it('signTransaction only: the page checks the signed transaction and sends it itself', async () => {
    const { ctx, chain, wallet } = setup({ features: 'sign' });
    const rec = await sendBridgeIn(ctx, entry, 500_000_000n, 0n);
    expect(wallet.asked).toEqual(['sign solana:localnet']);
    expect(chain.sent.map((t) => t.signature)).toEqual([rec.signature]);
  });

  it('a wallet that returns another transaction, or signs with another key: nothing is sent', async () => {
    const t = setup({ features: 'sign' });
    t.wallet.mode = 'tamper';
    expect(await refusal(sendBridgeIn(t.ctx, entry, 500_000_000n, 0n))).toMatch(/another transaction than the lock/);
    t.wallet.mode = 'other-key';
    expect(await refusal(sendBridgeIn(t.ctx, entry, 500_000_000n, 0n))).toMatch(/cannot verify/);
    expect(t.chain.sent).toEqual([]);
  });

  it('T7.8 the wallet refuses: the error reaches the page and nothing is sent or recorded', async () => {
    for (const features of ['send', 'sign'] as const) {
      const t = setup({ features });
      t.wallet.mode = 'reject';
      await expect(sendBridgeIn(t.ctx, entry, 500_000_000n, 0n)).rejects.toBeInstanceOf(WalletError);
      expect(t.chain.sent).toEqual([]);
    }
  });
});

describe('P7 Bridge in: following the lock (T7.5); completion by the page', () => {
  const lockcLine = (nonce: number, depositor: string, account = ACCOUNT) =>
    `Program log: EFFECTSTREAM_BRIDGE|LOCKC|${nonce}|${depositor}|${entry.splMint}|500000000|${account}`;
  const deliveredCoin = { nonce: '5e'.repeat(32), colour: entry.colour, value: '500000000' };
  const stored = (coin = deliveredCoin, mtIndex: string | null = '9'): StoredCoin => ({
    nonce: coin.nonce,
    color: coin.colour,
    value: coin.value,
    commitment: contractCoinCommitment({ nonce: coin.nonce, color: coin.colour, value: coin.value }, ACCOUNT),
    mtIndex,
    origin: 'inbox',
    inInbox: true,
    spent: false,
  });

  async function sent() {
    const s = setup();
    s.chain.logsFor = () => ['Program x invoke [1]', lockcLine(4, s.depositor), 'Program x success'];
    const rec = await sendBridgeIn(s.ctx, entry, 500_000_000n, 0n);
    return { ...s, rec };
  }

  it('404 → observed → submitted → completed by the bridge, but only the page decode completes it', async () => {
    const { ctx, bridge, rec } = await sent();
    let coins: StoredCoin[] = [];
    const page = async () => coins;
    let r: BridgeInRecord = await followBridgeIn(rec, ctx, page);
    expect(r).toMatchObject({ state: 'locked', lockNonce: '4', progress: 'Waiting for the bridge to see the lock' });
    bridge.setTransfer(transferView({ id: 's2m:4', status: 'observed', recipient: ACCOUNT }));
    r = await followBridgeIn(r, ctx, page);
    expect(r).toMatchObject({ state: 'bridging', progress: 'The bridge has seen the lock' });
    bridge.setTransfer(transferView({ id: 's2m:4', status: 'submitted', recipient: ACCOUNT }));
    r = await followBridgeIn(r, ctx, page);
    expect(r.progress).toBe('The bridge is delivering');
    bridge.setTransfer(
      transferView({
        id: 's2m:4',
        status: 'completed',
        recipient: ACCOUNT,
        delivery: { adapter: 'passport-ed25519@21493588', account: ACCOUNT, coin: deliveredCoin, tx: null },
      }),
    );
    r = await followBridgeIn(r, ctx, page);
    // The bridge's word is not completion.
    expect(r).toMatchObject({ state: 'bridging', progress: 'The bridge reports it delivered' });
    // A coin the chain does not confirm yet is not either.
    coins = [stored(deliveredCoin, null)];
    expect((await followBridgeIn(r, ctx, page)).state).toBe('bridging');
    coins = [stored()];
    r = await followBridgeIn(r, ctx, page);
    expect(r).toMatchObject({ state: 'completed', progress: 'In your account' });
    // Final: no more reads.
    expect(await followBridgeIn(r, ctx, async () => [])).toBe(r);
  });

  it('P10.3 (audit C10): a balance alone never completes it, while the bridge cannot be read', async () => {
    const { ctx, rec } = await sent();
    const down = { ...ctx, fetchImpl: (async () => new Response('', { status: 500 })) as typeof fetch };
    let r = await followBridgeIn(rec, down, async () => []);
    expect(r).toMatchObject({ state: 'locked', progress: "The bridge's progress cannot be read right now" });
    const other = stored({ nonce: '77'.repeat(32), colour: entry.colour, value: '500000000' });
    expect(pageBalance([other], entry.colour)).toBe(500_000_000n);
    r = await followBridgeIn(r, down, async () => [other]);
    expect(r.state).toBe('locked');
  });

  it('undeliverable, for every code: the plain reason and "stay locked"', async () => {
    for (const code of UNDELIVERABLE_CODES) {
      const { ctx, bridge, rec } = await sent();
      bridge.setTransfer(
        transferView({
          id: 's2m:4',
          status: 'undeliverable',
          recipient: ACCOUNT,
          reason: { code, message: `bridge says ${code}`, at: '2026-10-04T00:00:00Z' },
        }),
      );
      const r = await followBridgeIn(rec, ctx, async () => []);
      expect(r.state, code).toBe('undeliverable');
      expect(r.progress).toContain(UNDELIVERABLE_TEXT[code]);
      expect(r.progress).toMatch(/stay locked on Solana/);
      expect(r.reason).toEqual({ code, message: `bridge says ${code}` });
    }
  });

  it('00058 Q6: a view whose recipientKind is null is "not seen yet", and the page keeps polling', async () => {
    const { ctx, bridge, rec } = await sent();
    bridge.setTransfer({ ...transferView({ id: 's2m:4', status: 'completed' }), recipientKind: null });
    const r = await followBridgeIn(rec, ctx, async () => []);
    expect(r).toMatchObject({ state: 'locked', progress: 'Waiting for the bridge to see the lock' });
  });

  it('not confirmed yet, a failed transaction, a log for another lock', async () => {
    const s = setup();
    const rec = await sendBridgeIn(s.ctx, entry, 500_000_000n, 0n);
    // Not seen by the RPC yet: keep waiting.
    const unseen = { ...rec, signature: encodeKey(new Uint8Array(64).fill(1)) };
    expect(await followBridgeIn(unseen, s.ctx, async () => [])).toMatchObject({
      state: 'sent',
      progress: 'Waiting for Solana to confirm the lock',
    });
    // Confirmed, but its log has no LOCKC line for this lock: an error, never a guess.
    await expect(followBridgeIn(rec, s.ctx, async () => [])).rejects.toThrow(/does not match what was sent/);
    s.chain.logsFor = () => [lockcLine(4, s.depositor, 'ab'.repeat(32))];
    await expect(followBridgeIn(rec, s.ctx, async () => [])).rejects.toThrow(/does not match what was sent/);
    const failing = new SolanaRpc(
      'http://rpc.test',
      asFetch(async (req) => {
        const body = (await req.json()) as { id: number };
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            result: { value: [{ err: { InstructionError: [0, 'Custom'] }, confirmationStatus: 'confirmed' }] },
          }),
        );
      }),
    );
    expect(await followBridgeIn(rec, { ...s.ctx, rpc: failing }, async () => [])).toMatchObject({
      state: 'failed',
      progress: 'The Solana transaction failed: nothing was locked.',
    });
  });
});
