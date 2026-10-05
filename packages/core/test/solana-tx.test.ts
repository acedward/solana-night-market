// AA 00060 P10.5 (audit E1, R3-B1): `splitTransaction` returns a transaction's signatures and message only
// when the WHOLE message parses (legacy or v0): a body cut short, with trailing bytes, with a signature count
// its header does not ask for, or with an index outside its accounts is refused. Bridge in's reconcile reads
// such a body as "unknown", never as evidence that the lock was not sent.

import { randomBytes } from 'node:crypto';

import {
  Keypair,
  MessageV0,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  VersionedTransaction,
} from '@solana/web3.js';
import { describe, expect, it } from 'vitest';

import {
  compileLegacyMessage,
  memoInstruction,
  shortvec,
  splitTransaction,
  unsignedTransaction,
} from '../src/solana/tx.js';

const payer = Keypair.generate().publicKey.toBase58();
const blockhash = new PublicKey(randomBytes(32)).toBase58();
const legacy = () => unsignedTransaction(compileLegacyMessage(payer, blockhash, [memoInstruction(payer, 'probe')]));

describe('E1: splitTransaction refuses a body whose message does not parse', () => {
  it('a well-formed legacy and a well-formed v0 transaction parse', () => {
    const wire = legacy();
    const parts = splitTransaction(wire);
    expect(parts.signatures).toHaveLength(1);
    expect(parts.message.length).toBe(wire.length - 65);
    const kp = Keypair.generate();
    const v0 = new VersionedTransaction(
      MessageV0.compile({
        payerKey: kp.publicKey,
        recentBlockhash: blockhash,
        instructions: [
          SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 5 }),
          new TransactionInstruction({
            programId: new PublicKey(randomBytes(32)),
            keys: [],
            data: Buffer.from([1, 2]),
          }),
        ],
      }),
    );
    v0.sign([kp]);
    expect(splitTransaction(v0.serialize()).signatures).toHaveLength(1);
  });

  it.each([
    ['a one-signature transaction cut to 65 bytes', (w: Uint8Array) => w.slice(0, 65)],
    ['a message cut by one byte', (w: Uint8Array) => w.slice(0, w.length - 1)],
    ['a message with a trailing byte', (w: Uint8Array) => Uint8Array.from([...w, 0])],
    [
      'two signatures for a message that asks for one',
      (w: Uint8Array) => Uint8Array.from([...shortvec(2), ...new Uint8Array(128), ...w.slice(65)]),
    ],
    [
      'an instruction whose program index is outside the accounts',
      (w: Uint8Array) => {
        const out = Uint8Array.from(w);
        // header (3) + shortvec(keys) + keys + blockhash + shortvec(1 instruction) → the program index
        const keys = out[65 + 3]!;
        out[65 + 3 + 1 + 32 * keys + 32 + 1] = 200;
        return out;
      },
    ],
    ['an empty body', () => new Uint8Array(0)],
  ])('%s: refused', (_name, mutate) => {
    expect(() => splitTransaction(mutate(legacy()))).toThrow();
  });
});
