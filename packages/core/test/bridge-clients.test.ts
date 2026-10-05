// AA 00060 P1 (T1.6): the PROVISIONAL I-2 codec's vectors (00058's proposal), the I-3 client against
// the mock bridge API (every status, and `undeliverable` with a reason), the PROVISIONAL I-4 client
// against the mock injector, and the minimal Solana transaction toolkit against @solana/web3.js 1.99's
// bytes (fixtures/solana-tx-web3.json).

import { base58 } from '@scure/base';
import nacl from 'tweetnacl';
import { describe, expect, it } from 'vitest';

import {
  I2_STATUS,
  LockCodecError,
  decodeLockToContract,
  encodeLockToContract,
  lockcLogs,
  parseLockcLog,
  readLockNonce,
  s2mTransferId,
} from '../src/bridge/lock-codec.js';
import {
  InjectorError,
  REGISTRATION_FIRST_LINE,
  postRegistration,
  readRegistration,
  readRegistrationInfo,
  registrationMessageText,
} from '../src/bridge/injector.js';
import {
  TRANSFER_STATUSES,
  UNDELIVERABLE_CODES,
  UNDELIVERABLE_TEXT,
  readRecipientVerdict,
  readTransfer,
  transferProgressText,
} from '../src/bridge/transfers.js';
import { LANDING_KEY_FIRST_LINE } from '../src/bridge/landing-key.js';
import { bytesToHex } from '../src/hex.js';
import { MARKET_LABELS } from '../src/market-label.js';
import { assertSafeEd25519Message } from '../src/passport/ed25519.js';
import {
  compileLegacyMessage,
  memoInstruction,
  splitTransaction,
  toBase64,
  unsignedTransaction,
  type Instruction,
} from '../src/solana/tx.js';
import web3 from './fixtures/solana-tx-web3.json';
import { mockBridgeApi, transferView } from '../../../test/mocks/bridge-api.js';
import { asFetch } from '../../../test/mocks/http.js';
import { mockInjector } from '../../../test/mocks/injector.js';
import { mockSolanaRpc } from '../../../test/mocks/solana-rpc.js';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

describe('T1.6 I-2 lock codec (FROZEN 2026-10-04, 00058 @ 6c07dab)', () => {
  it('is marked frozen', () => expect(I2_STATUS).toMatch(/^FROZEN 2026-10-04 \(00058 @ 6c07dab\)/));

  it("00058's proposed vector: 500 X at 6 decimals to contract a1×32", () => {
    const data = encodeLockToContract(500_000_000n, new Uint8Array(32).fill(0xa1));
    expect(hex(data)).toBe(`03${'0065cd1d00000000'}${'a1'.repeat(32)}`);
    expect(data.length).toBe(41);
    expect(decodeLockToContract(data)).toEqual({ amount: 500_000_000n, contract: new Uint8Array(32).fill(0xa1) });
  });

  it('refuses a zero contract, a zero amount, and 40- or 42-byte data', () => {
    expect(() => encodeLockToContract(1n, new Uint8Array(32))).toThrow(LockCodecError);
    expect(() => encodeLockToContract(0n, new Uint8Array(32).fill(1))).toThrow(LockCodecError);
    const good = encodeLockToContract(1n, new Uint8Array(32).fill(1));
    expect(() => decodeLockToContract(good.slice(0, 40))).toThrow(/41 bytes/);
    expect(() => decodeLockToContract(new Uint8Array([...good, 0]))).toThrow(/41 bytes/);
    const zero = Uint8Array.from(good);
    zero.fill(0, 9);
    expect(() => decodeLockToContract(zero)).toThrow(/all-zero/);
  });

  it('reads its own lock nonce from the LOCKC line, and refuses anything else', () => {
    const depositor = base58.encode(new Uint8Array(32).fill(3));
    const mint = base58.encode(new Uint8Array(32).fill(4));
    const contractHex = 'a1'.repeat(32);
    const line = `Program log: EFFECTSTREAM_BRIDGE|LOCKC|42|${depositor}|${mint}|500000000|${contractHex}`;
    const logs = ['Program xyz invoke [1]', line, 'Program xyz success'];
    expect(parseLockcLog(line)).toMatchObject({ nonce: 42n, amount: 500_000_000n, contractHex });
    expect(readLockNonce(logs, { depositor, mint, amount: 500_000_000n, contractHex })).toBe(42n);
    expect(s2mTransferId(42n)).toBe('s2m:42');
    expect(() => readLockNonce(logs, { depositor, mint, amount: 1n, contractHex })).toThrow(/does not match/);
    expect(() => readLockNonce([line, line], { depositor, mint, amount: 500_000_000n, contractHex })).toThrow(
      /one LOCKC/,
    );
    expect(parseLockcLog(line.replace('|42|', `|${(1n << 64n).toString()}|`))).toBeNull();
    expect(
      parseLockcLog(`Program log: EFFECTSTREAM_BRIDGE|LOCK|1|${depositor}|${mint}|5|${'ab'.repeat(64)}`),
    ).toBeNull();
    expect(lockcLogs([line, 'noise', line])).toHaveLength(2);
  });
});

describe('T1.6 I-3 client against the mock bridge API', () => {
  it('a 404 is "not seen yet"; then every status; undeliverable carries its reason', async () => {
    const api = mockBridgeApi();
    const f = asFetch(api.handler);
    const read = await readTransfer('http://bridge', 's2m:7', f);
    expect(read).toEqual({ kind: 'not-seen' });
    expect(transferProgressText(read)).toBe('Waiting for the bridge to see the lock');
    for (const status of TRANSFER_STATUSES.filter((s) => s !== 'undeliverable')) {
      api.setTransfer(transferView({ id: 's2m:7', status }));
      const r = await readTransfer('http://bridge/', 's2m:7', f);
      expect(r.kind === 'view' && r.view.status).toBe(status);
    }
    for (const code of UNDELIVERABLE_CODES) {
      api.setTransfer(
        transferView({
          id: 's2m:7',
          status: 'undeliverable',
          reason: { code, message: 'x', at: '2026-10-04T00:00:00Z' },
        }),
      );
      const r = await readTransfer('http://bridge', 's2m:7', f);
      expect(transferProgressText(r)).toContain(UNDELIVERABLE_TEXT[code]);
      expect(transferProgressText(r)).toContain('stay locked on Solana');
    }
  });

  it('refuses another transfer, a bad shape and a bad id', async () => {
    const api = mockBridgeApi();
    const f = asFetch(api.handler);
    api.setTransfer(transferView({ id: 's2m:8', status: 'observed' }), 's2m:7');
    await expect(readTransfer('http://bridge', 's2m:7', f)).rejects.toThrow(/another transfer/);
    await expect(readTransfer('http://bridge', 'x:1', f)).rejects.toThrow(/not a transfer id/);
    api.setTransfer({ ...transferView({ id: 's2m:9', status: 'observed' }), status: 'lost' as never });
    await expect(readTransfer('http://bridge', 's2m:9', f)).rejects.toThrow(/unknown shape/);
  });

  it('the recognition verdict', async () => {
    const api = mockBridgeApi();
    const f = asFetch(api.handler);
    const a = 'ab'.repeat(32);
    expect((await readRecipientVerdict('http://bridge', `0x${a.toUpperCase()}`, f)).verdict).toBe('deliverable');
    api.setVerdict(a, 'undeliverable', 'authority-live');
    expect(await readRecipientVerdict('http://bridge', a, f)).toMatchObject({
      verdict: 'undeliverable',
      code: 'authority-live',
    });
  });
});

describe('T1.6 I-4 client against the mock injector (PROVISIONAL: 00059 proposal of 2026-10-04)', () => {
  const kp = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(5));
  const wallet = base58.encode(kp.publicKey);
  const account = '45'.repeat(32);

  it('the v1 text: 9 lines, its own first line, safe for the arm, and never I-5’s or a market message’s', () => {
    const text = registrationMessageText({
      origin: 'http://127.0.0.1:18899',
      networkId: 'undeployed',
      solanaAddress: wallet,
      accountAddress: account,
      expires: 1_900_000_000,
    });
    const lines = text.split('\n');
    expect(lines).toHaveLength(9);
    expect(lines[0]).toBe(REGISTRATION_FIRST_LINE);
    expect(lines[6]).toBe('Expires 2030-03-17 17:46:40 UTC');
    expect(lines[0]).not.toBe(LANDING_KEY_FIRST_LINE);
    expect(lines[0]!.startsWith('Site: ')).toBe(false);
    for (const l of Object.values(MARKET_LABELS)) expect(lines[0]).not.toBe(l);
    expect(() => assertSafeEd25519Message(new TextEncoder().encode(text))).not.toThrow();
  });

  it('registers once, reads the status, and surfaces an error code without retrying', async () => {
    const inj = mockInjector();
    const f = asFetch(inj.handler);
    const info = await readRegistrationInfo('http://inj', f);
    const message = registrationMessageText({
      origin: info.origin,
      networkId: info.networkId,
      solanaAddress: wallet,
      accountAddress: account,
      expires: inj.now() + 300,
    });
    const body = {
      solanaAddress: wallet,
      accountAddress: account,
      accountViewingKey: '77'.repeat(32),
      message,
      signature: bytesToHex(nacl.sign.detached(new TextEncoder().encode(message), kp.secretKey)),
    };
    const view = await postRegistration('http://inj', body, f);
    expect(view).toMatchObject({ status: 'synced', created: true });
    expect(inj.posts).toEqual([body]);
    inj.setStatus('stale-key');
    expect((await readRegistration('http://inj', view.id, f)).status).toBe('stale-key');
    inj.failNext('not-a-device');
    await expect(postRegistration('http://inj', body, f)).rejects.toMatchObject({ code: 'not-a-device', status: 403 });
    expect(inj.posts).toHaveLength(2);
    const forged = {
      ...body,
      signature: bytesToHex(nacl.sign.detached(new TextEncoder().encode(`${message}x`), kp.secretKey)),
    };
    await expect(postRegistration('http://inj', forged, f)).rejects.toBeInstanceOf(InjectorError);
  });
});

describe('the minimal Solana toolkit', () => {
  it('compiles each web3.js 1.99 vector to the same message bytes', () => {
    for (const v of web3.vectors) {
      const ixs: Instruction[] = v.instructions.map((i) => ({
        ...i,
        data: new Uint8Array(Buffer.from(i.dataHex, 'hex')),
      }));
      const m = compileLegacyMessage(v.feePayer, v.recentBlockhash, ixs);
      expect(hex(m.bytes), v.name).toBe(v.messageHex);
      expect(hex(unsignedTransaction(m)), v.name).toBe(v.unsignedTxHex);
    }
  });

  it('a signed memo is accepted by the mock RPC; another blockhash is refused', async () => {
    const rpc = mockSolanaRpc();
    const f = asFetch(rpc.handler);
    const call = async (method: string, params: unknown[] = []) =>
      (await (
        await f('http://rpc', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
      ).json()) as {
        result?: { value: { blockhash: string } } | string;
        error?: { message: string };
      };
    const kp = nacl.sign.keyPair();
    const payer = base58.encode(kp.publicKey);
    const { result } = await call('getLatestBlockhash');
    const m = compileLegacyMessage(payer, (result as { value: { blockhash: string } }).value.blockhash, [
      memoInstruction(payer, 'probe'),
    ]);
    const wire = unsignedTransaction(m);
    wire.set(nacl.sign.detached(m.bytes, kp.secretKey), 1);
    const sent = await call('sendTransaction', [toBase64(wire), { encoding: 'base64' }]);
    expect(sent.result).toBe(base58.encode(splitTransaction(wire).signatures[0]!));
    const stale = compileLegacyMessage(payer, base58.encode(new Uint8Array(32).fill(9)), [
      memoInstruction(payer, 'probe'),
    ]);
    const w2 = unsignedTransaction(stale);
    w2.set(nacl.sign.detached(stale.bytes, kp.secretKey), 1);
    expect((await call('sendTransaction', [toBase64(w2)])).error?.message).toMatch(/Blockhash not found/);
  });
});
