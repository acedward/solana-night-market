// AA 00060 P7 (T7.1, P7.4): Bridge in's bytes. The I-2 codec and the I-3 shapes against 00058's FROZEN
// vectors (test/fixtures/00058-interfaces.json, copied byte for byte from effectstream 6c07dab), and the
// page's own Solana transaction and PDAs against @solana/web3.js 1.98.4 (a test-only devDependency).

import { randomBytes } from 'node:crypto';

import { Keypair, PublicKey, Transaction, TransactionInstruction, SystemProgram } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';

import vectors from '../../../test/fixtures/00058-interfaces.json';
import { BridgeInError, buildLockToAccount, checkLockToAccount, lockToAccountFacts } from '../src/bridge/bridge-in.js';
import {
  decodeLockToContract,
  encodeLockToContract,
  lockcLogs,
  parseLockcLog,
  readLockNonce,
  s2mTransferId,
} from '../src/bridge/lock-codec.js';
import {
  RecipientVerdictSchema,
  TransferViewSchema,
  readTransfer,
  transferProgressText,
} from '../src/bridge/transfers.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  associatedTokenAddress,
  bridgeConfigAddress,
  bridgeReleaseReceiptAddress,
  bridgeVaultAddress,
  compileLegacyMessage,
  isOnCurve,
  memoInstruction,
  unsignedTransaction,
} from '../src/solana/index.js';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const unhex = (h: string) => new Uint8Array(Buffer.from(h, 'hex'));
const pk = () => Keypair.generate().publicKey;

describe("P7.4 00058's frozen I-2 vectors, byte for byte", () => {
  it('the instruction data', () => {
    for (const v of vectors.i2.instructions) {
      if (v.valid) {
        expect(hex(encodeLockToContract(BigInt(v.amount!), unhex(v.contractHex!))), v.name).toBe(v.data);
        expect(decodeLockToContract(unhex(v.data)).amount).toBe(BigInt(v.amount!));
      } else {
        expect(() => decodeLockToContract(unhex(v.data)), v.name).toThrow();
      }
    }
    expect(vectors.i2.tag).toBe(3);
    expect(vectors.i2.dataLength).toBe(41);
  });

  it('the log lines', () => {
    for (const v of vectors.i2.logLines) {
      const parsed = parseLockcLog(v.line);
      if (!v.valid) {
        expect(parsed, v.name).toBeNull();
        continue;
      }
      expect(parsed, v.name).toEqual({
        kind: 'LOCKC',
        nonce: BigInt(v.parsed!.nonce),
        depositor: v.parsed!.depositor,
        mint: v.parsed!.mint,
        amount: BigInt(v.parsed!.amount),
        contractHex: v.parsed!.contractHex,
      });
    }
  });

  it('a mixed transaction: the LOCKC line is read, the wallet locks are left alone', () => {
    const t = vectors.i2.mixedTransaction;
    const lockc = lockcLogs(t.logMessages);
    expect(lockc.map((l) => l.nonce)).toEqual([4n]);
    const want = t.lockNonces.find((n) => n.kind === 'LOCKC')!;
    expect(
      readLockNonce(t.logMessages, {
        depositor: lockc[0]!.depositor,
        mint: lockc[0]!.mint,
        amount: lockc[0]!.amount,
        contractHex: lockc[0]!.contractHex,
      }),
    ).toBe(BigInt(want.nonce));
    expect(s2mTransferId(4n)).toBe(t.transferIds[1]);
  });

  it("the account order is I-2's", () => {
    expect(vectors.i2.accounts.map((a) => [a.signer, a.writable])).toEqual([
      [true, false],
      [false, true],
      [false, true],
      [false, true],
      [false, false],
    ]);
  });
});

describe("P7.4 00058's frozen I-3 vectors parse", () => {
  it('every transfer view and every recognition verdict', () => {
    for (const v of vectors.i3.transferViews) expect(TransferViewSchema.parse(v)).toEqual(v);
    for (const r of vectors.i3.recipients) expect(RecipientVerdictSchema.parse(r)).toEqual(r);
  });
});

describe("00058 Q6 (resolved A): an s2m view whose recipientKind is null is 'lock not seen yet'", () => {
  it('parses, reads as not seen, and the page keeps polling with the waiting words', async () => {
    const view = { ...vectors.i3.transferViews[0]!, recipientKind: null, recipient: null, delivery: null };
    expect(TransferViewSchema.parse(view).recipientKind).toBeNull();
    const fetchImpl = (async () =>
      new Response(JSON.stringify(view), { headers: { 'content-type': 'application/json' } })) as typeof fetch;
    const read = await readTransfer('http://bridge.test', view.id, fetchImpl);
    expect(read).toEqual({ kind: 'not-seen' });
    expect(transferProgressText(read)).toBe('Waiting for the bridge to see the lock');
    // A known kind still reads as the view.
    const known = await readTransfer(
      'http://bridge.test',
      view.id,
      (async () => new Response(JSON.stringify({ ...view, recipientKind: 'contract' }))) as typeof fetch,
    );
    expect(known.kind).toBe('view');
  });
});

describe('T7.1 the page builds the same bytes as @solana/web3.js 1.98.4', () => {
  it('PDAs, associated token accounts and the on-curve test (100 random inputs)', () => {
    const tokenProgram = new PublicKey(TOKEN_PROGRAM_ID);
    const ata = new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID);
    for (let i = 0; i < 100; i++) {
      const owner = pk();
      const mint = pk();
      const program = pk();
      const id = BigInt(i * 7919);
      expect(associatedTokenAddress(owner.toBase58(), mint.toBase58())).toBe(
        PublicKey.findProgramAddressSync(
          [owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()],
          ata,
        )[0].toBase58(),
      );
      expect(bridgeConfigAddress(program.toBase58())).toBe(
        PublicKey.findProgramAddressSync([Buffer.from('config')], program)[0].toBase58(),
      );
      expect(bridgeVaultAddress(program.toBase58(), mint.toBase58())).toBe(
        PublicKey.findProgramAddressSync([Buffer.from('vault'), mint.toBuffer()], program)[0].toBase58(),
      );
      const le = Buffer.alloc(8);
      le.writeBigUInt64LE(id);
      expect(bridgeReleaseReceiptAddress(program.toBase58(), id)).toBe(
        PublicKey.findProgramAddressSync([Buffer.from('release'), le], program)[0].toBase58(),
      );
      const random = new Uint8Array(randomBytes(32));
      expect(isOnCurve(random)).toBe(PublicKey.isOnCurve(random));
    }
  });

  it("Bridge in's transaction: the message and the unsigned wire (50 random inputs)", () => {
    for (let i = 0; i < 50; i++) {
      const depositor = pk();
      const mint = pk();
      const program = pk();
      const blockhash = pk().toBase58();
      const amount = BigInt(1 + Math.floor(Math.random() * 1e12));
      const account = hex(new Uint8Array(randomBytes(32)));
      const ours = buildLockToAccount({
        entry: {
          splMint: mint.toBase58(),
          bridgeProgram: program.toBase58(),
          colour: 'ab'.repeat(32),
          symbol: 'X',
          decimals: 6,
        },
        depositor: depositor.toBase58(),
        amount,
        account,
        recentBlockhash: blockhash,
      });
      const tokenProgram = new PublicKey(TOKEN_PROGRAM_ID);
      const [source] = PublicKey.findProgramAddressSync(
        [depositor.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()],
        new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID),
      );
      const [config] = PublicKey.findProgramAddressSync([Buffer.from('config')], program);
      const [vault] = PublicKey.findProgramAddressSync([Buffer.from('vault'), mint.toBuffer()], program);
      const tx = new Transaction({ feePayer: depositor, recentBlockhash: blockhash }).add(
        new TransactionInstruction({
          programId: program,
          keys: [
            { pubkey: depositor, isSigner: true, isWritable: false },
            { pubkey: source, isSigner: false, isWritable: true },
            { pubkey: config, isSigner: false, isWritable: true },
            { pubkey: vault, isSigner: false, isWritable: true },
            { pubkey: tokenProgram, isSigner: false, isWritable: false },
          ],
          data: Buffer.from(encodeLockToContract(amount, unhex(account))),
        }),
      );
      expect(hex(ours.message.bytes)).toBe(tx.serializeMessage().toString('hex'));
      expect(hex(ours.transaction)).toBe(
        hex(new Uint8Array(tx.serialize({ requireAllSignatures: false, verifySignatures: false }))),
      );
      expect(checkLockToAccount(ours.transaction, ours.facts).blockhash).toBe(blockhash);
    }
  });

  it('a system transfer and a memo still match (the P1 toolkit)', () => {
    const a = pk();
    const b = pk();
    const blockhash = pk().toBase58();
    const tx = new Transaction({ feePayer: a, recentBlockhash: blockhash }).add(
      SystemProgram.transfer({ fromPubkey: a, toPubkey: b, lamports: 42 }),
    );
    expect(
      hex(
        compileLegacyMessage(a.toBase58(), blockhash, [
          {
            programId: SystemProgram.programId.toBase58(),
            keys: [
              { pubkey: a.toBase58(), isSigner: true, isWritable: true },
              { pubkey: b.toBase58(), isSigner: false, isWritable: true },
            ],
            data: new Uint8Array(tx.instructions[0]!.data),
          },
        ]).bytes,
      ),
    ).toBe(tx.serializeMessage().toString('hex'));
  });
});

describe('the page refuses a transaction that is not exactly its lock', () => {
  const depositor = pk().toBase58();
  const entry = {
    splMint: pk().toBase58(),
    bridgeProgram: pk().toBase58(),
    colour: 'ab'.repeat(32),
    symbol: 'X',
    decimals: 6,
  };
  const account = 'cd'.repeat(32);
  const facts = lockToAccountFacts({ entry, depositor, amount: 500n, account });

  it('another amount, another account, another program, another payer, two instructions', () => {
    const build = (over: Partial<Parameters<typeof buildLockToAccount>[0]>) =>
      buildLockToAccount({ entry, depositor, amount: 500n, account, recentBlockhash: pk().toBase58(), ...over })
        .transaction;
    expect(() => checkLockToAccount(build({ amount: 501n }), facts)).toThrow(/amount/);
    expect(() => checkLockToAccount(build({ account: 'ef'.repeat(32) }), facts)).toThrow(/Midnight recipient/);
    expect(() => checkLockToAccount(build({ entry: { ...entry, bridgeProgram: pk().toBase58() } }), facts)).toThrow(
      BridgeInError,
    );
    expect(() => checkLockToAccount(build({ depositor: pk().toBase58() }), facts)).toThrow(/fee payer/);
    const two = compileLegacyMessage(depositor, pk().toBase58(), [
      memoInstruction(depositor, 'x'),
      {
        programId: entry.bridgeProgram,
        keys: [
          { pubkey: depositor, isSigner: true, isWritable: false },
          { pubkey: facts.source, isSigner: false, isWritable: true },
          { pubkey: facts.config, isSigner: false, isWritable: true },
          { pubkey: facts.vault, isSigner: false, isWritable: true },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        ],
        data: encodeLockToContract(500n, unhex(account)),
      },
    ]);
    expect(() => checkLockToAccount(unsignedTransaction(two), facts)).toThrow(/one instruction/);
  });
});
