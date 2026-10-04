// A minimal, browser-safe Solana LEGACY transaction toolkit (AA 00060; no @solana/web3.js in the app).
// P1 uses it for the wallet probe's harmless transaction; P7.1 adds PDAs, associated token accounts
// and the bridge's Lock to it.
//
// Wire format (docs.solana.com "Transactions"): a transaction is `shortvec(n) ‖ n × 64-byte signature ‖
// message`; a legacy message is `header [numRequiredSignatures, numReadonlySigned,
// numReadonlyUnsigned] ‖ shortvec(keys) ‖ keys × 32 ‖ recentBlockhash 32 ‖ shortvec(instructions) ‖
// instructions`, each instruction `programIdIndex u8 ‖ shortvec(accounts) ‖ indices ‖ shortvec(data)
// ‖ data`. The account order follows @solana/web3.js 1.x `Transaction.compileMessage`, so the bytes
// equal web3.js's for the same inputs (test vectors in packages/core/test/fixtures/solana-tx-web3.json):
// the fee payer first; then signers before non-signers and writable before read-only; ties by the
// base58 key, `localeCompare('en', {caseFirst: 'lower', …})` as web3.js sorts them.

import { base58 } from '@scure/base';

export const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';
export const MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
export const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const ASSOCIATED_TOKEN_PROGRAM_ID = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';

export interface AccountMeta {
  /** base58 */
  pubkey: string;
  isSigner: boolean;
  isWritable: boolean;
}

export interface Instruction {
  /** base58 */
  programId: string;
  keys: AccountMeta[];
  data: Uint8Array;
}

export class SolanaTxError extends Error {
  override name = 'SolanaTxError';
}

export function decodeKey(b58: string, what = 'a key'): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = base58.decode(b58);
  } catch {
    throw new SolanaTxError(`${what} is not base58`);
  }
  if (bytes.length !== 32) throw new SolanaTxError(`${what} is not 32 bytes`);
  return bytes;
}

export const encodeKey = (bytes: Uint8Array): string => base58.encode(bytes);

/** Solana's compact-u16 ("shortvec"). */
export function shortvec(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0 || n > 0xffff) throw new SolanaTxError(`not a u16: ${n}`);
  const out: number[] = [];
  let v = n;
  for (;;) {
    const b = v & 0x7f;
    v >>= 7;
    if (v === 0) {
      out.push(b);
      return Uint8Array.from(out);
    }
    out.push(b | 0x80);
  }
}

const concat = (parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

const SORT_OPTIONS: Intl.CollatorOptions = {
  localeMatcher: 'best fit',
  usage: 'sort',
  sensitivity: 'variant',
  ignorePunctuation: false,
  numeric: false,
  caseFirst: 'lower',
};

export interface CompiledMessage {
  bytes: Uint8Array;
  /** The account keys in message order. */
  accountKeys: string[];
  numRequiredSignatures: number;
}

/** A legacy message, as web3.js 1.x `Transaction.compileMessage` builds it. */
export function compileLegacyMessage(
  feePayer: string,
  recentBlockhash: string,
  instructions: Instruction[],
): CompiledMessage {
  if (instructions.length === 0) throw new SolanaTxError('a transaction needs an instruction');
  decodeKey(feePayer, 'the fee payer');
  const blockhash = decodeKey(recentBlockhash, 'the blockhash');
  const metas: AccountMeta[] = [];
  const programIds: string[] = [];
  for (const ix of instructions) {
    for (const k of ix.keys) metas.push({ ...k });
    if (!programIds.includes(ix.programId)) programIds.push(ix.programId);
  }
  for (const p of programIds) metas.push({ pubkey: p, isSigner: false, isWritable: false });
  const unique: AccountMeta[] = [];
  for (const m of metas) {
    const seen = unique.find((u) => u.pubkey === m.pubkey);
    if (seen) {
      seen.isWritable ||= m.isWritable;
      seen.isSigner ||= m.isSigner;
    } else unique.push({ ...m });
  }
  unique.sort((x, y) => {
    if (x.isSigner !== y.isSigner) return x.isSigner ? -1 : 1;
    if (x.isWritable !== y.isWritable) return x.isWritable ? -1 : 1;
    return x.pubkey.localeCompare(y.pubkey, 'en', SORT_OPTIONS);
  });
  const payerAt = unique.findIndex((u) => u.pubkey === feePayer);
  if (payerAt >= 0) {
    const [payer] = unique.splice(payerAt, 1);
    payer!.isSigner = true;
    payer!.isWritable = true;
    unique.unshift(payer!);
  } else unique.unshift({ pubkey: feePayer, isSigner: true, isWritable: true });
  const signed = unique.filter((u) => u.isSigner);
  const unsigned = unique.filter((u) => !u.isSigner);
  const header = Uint8Array.from([
    signed.length,
    signed.filter((u) => !u.isWritable).length,
    unsigned.filter((u) => !u.isWritable).length,
  ]);
  const accountKeys = [...signed, ...unsigned].map((u) => u.pubkey);
  const index = (k: string) => {
    const i = accountKeys.indexOf(k);
    if (i < 0) throw new SolanaTxError(`unknown account ${k}`);
    return i;
  };
  const compiled = instructions.map((ix) =>
    concat([
      Uint8Array.from([index(ix.programId)]),
      shortvec(ix.keys.length),
      Uint8Array.from(ix.keys.map((k) => index(k.pubkey))),
      shortvec(ix.data.length),
      ix.data,
    ]),
  );
  const bytes = concat([
    header,
    shortvec(accountKeys.length),
    ...accountKeys.map((k) => decodeKey(k)),
    blockhash,
    shortvec(compiled.length),
    ...compiled,
  ]);
  return { bytes, accountKeys, numRequiredSignatures: signed.length };
}

/** The wire transaction with zeroed signature slots (what a wallet's `signTransaction` takes). */
export function unsignedTransaction(message: CompiledMessage): Uint8Array {
  return concat([
    shortvec(message.numRequiredSignatures),
    new Uint8Array(64 * message.numRequiredSignatures),
    message.bytes,
  ]);
}

/** The signatures and message of a wire transaction. */
export function splitTransaction(wire: Uint8Array): { signatures: Uint8Array[]; message: Uint8Array } {
  let n = 0;
  let shift = 0;
  let at = 0;
  for (;;) {
    if (at >= wire.length || at > 2) throw new SolanaTxError('a malformed transaction');
    const b = wire[at++]!;
    n |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
  }
  if (at + 64 * n > wire.length) throw new SolanaTxError('a truncated transaction');
  const signatures = Array.from({ length: n }, (_, i) => wire.slice(at + 64 * i, at + 64 * (i + 1)));
  return { signatures, message: wire.slice(at + 64 * n) };
}

/** A Memo (v2) instruction signed by `signer`. */
export function memoInstruction(signer: string, text: string): Instruction {
  const data = new TextEncoder().encode(text);
  return { programId: MEMO_PROGRAM_ID, keys: [{ pubkey: signer, isSigner: true, isWritable: false }], data };
}

/** A System `Transfer` (index 2, lamports u64 LE). */
export function systemTransferInstruction(from: string, to: string, lamports: bigint): Instruction {
  const data = new Uint8Array(12);
  const view = new DataView(data.buffer);
  view.setUint32(0, 2, true);
  view.setBigUint64(4, lamports, true);
  return {
    programId: SYSTEM_PROGRAM_ID,
    keys: [
      { pubkey: from, isSigner: true, isWritable: true },
      { pubkey: to, isSigner: false, isWritable: true },
    ],
    data,
  };
}

/** base64 of bytes (the RPC's `sendTransaction` encoding), browser-safe. */
export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
