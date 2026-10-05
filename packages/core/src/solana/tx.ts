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

/** A parsed transaction message (legacy or v0), every byte accounted for. */
export interface ParsedMessage {
  version: 'legacy' | 0;
  header: { numRequiredSignatures: number; numReadonlySigned: number; numReadonlyUnsigned: number };
  accountKeys: string[];
  recentBlockhash: string;
  instructions: { programIdIndex: number; accounts: number[]; data: Uint8Array }[];
  lookups: { account: string; writable: number[]; readonly: number[] }[];
}

/** A strict compact-u16 at `at`: at most 3 bytes, no alias encodings. Returns [value, next offset]. */
function readShortvec(b: Uint8Array, at: number): [number, number] {
  let value = 0;
  for (let i = 0; i < 3; i++) {
    if (at + i >= b.length) throw new SolanaTxError('a truncated message');
    const byte = b[at + i]!;
    value |= (byte & 0x7f) << (7 * i);
    if ((byte & 0x80) === 0) {
      if (i > 0 && byte === 0) throw new SolanaTxError('a non-canonical length');
      if (value > 0xffff) throw new SolanaTxError('a length above u16');
      return [value, at + i + 1];
    }
  }
  throw new SolanaTxError('a length longer than three bytes');
}

/**
 * Parse a transaction message, legacy or v0 (AA 00060 P10.5, audit E1 / R3-B1): the header, the static
 * account keys, the blockhash, every instruction (its program and account indices within the accounts,
 * its data), and for v0 the address-table lookups. Throws SolanaTxError unless EVERY byte belongs to it.
 */
export function parseMessage(m: Uint8Array): ParsedMessage {
  let at = 0;
  const need = (n: number) => {
    if (at + n > m.length) throw new SolanaTxError('a truncated message');
  };
  const vec = () => {
    const [n, next] = readShortvec(m, at);
    at = next;
    return n;
  };
  need(1);
  let version: ParsedMessage['version'] = 'legacy';
  if (m[0]! & 0x80) {
    if ((m[0]! & 0x7f) !== 0) throw new SolanaTxError(`an unsupported message version ${m[0]! & 0x7f}`);
    version = 0;
    at = 1;
  }
  need(3);
  const header = { numRequiredSignatures: m[at]!, numReadonlySigned: m[at + 1]!, numReadonlyUnsigned: m[at + 2]! };
  at += 3;
  const nKeys = vec();
  need(32 * nKeys);
  const accountKeys = Array.from({ length: nKeys }, (_, i) => encodeKey(m.slice(at + 32 * i, at + 32 * (i + 1))));
  at += 32 * nKeys;
  need(32);
  const recentBlockhash = encodeKey(m.slice(at, at + 32));
  at += 32;
  const nIx = vec();
  const instructions: ParsedMessage['instructions'] = [];
  for (let k = 0; k < nIx; k++) {
    need(1);
    const programIdIndex = m[at++]!;
    const nAcc = vec();
    need(nAcc);
    const accounts = Array.from(m.slice(at, at + nAcc));
    at += nAcc;
    const len = vec();
    need(len);
    instructions.push({ programIdIndex, accounts, data: m.slice(at, at + len) });
    at += len;
  }
  const lookups: ParsedMessage['lookups'] = [];
  if (version === 0) {
    const nLookups = vec();
    for (let k = 0; k < nLookups; k++) {
      need(32);
      const account = encodeKey(m.slice(at, at + 32));
      at += 32;
      const nW = vec();
      need(nW);
      const writable = Array.from(m.slice(at, at + nW));
      at += nW;
      const nR = vec();
      need(nR);
      const readonly = Array.from(m.slice(at, at + nR));
      at += nR;
      lookups.push({ account, writable, readonly });
    }
  }
  if (at !== m.length) throw new SolanaTxError('trailing bytes after the message');
  // The header and the indices must describe these accounts.
  const { numRequiredSignatures: s, numReadonlySigned: rs, numReadonlyUnsigned: ru } = header;
  if (s < 1 || s > nKeys) throw new SolanaTxError('a header that asks for signatures the accounts do not have');
  if (rs >= s) throw new SolanaTxError('a header whose fee payer is read-only');
  if (ru > nKeys - s) throw new SolanaTxError('a header with more read-only accounts than unsigned ones');
  const total = nKeys + lookups.reduce((n, l) => n + l.writable.length + l.readonly.length, 0);
  for (const ix of instructions) {
    if (ix.programIdIndex === 0 || ix.programIdIndex >= nKeys)
      throw new SolanaTxError("an instruction whose program is not one of the message's accounts");
    if (ix.accounts.some((a) => a >= total)) throw new SolanaTxError('an instruction account outside the message');
  }
  return { version, header, accountKeys, recentBlockhash, instructions, lookups };
}

/** The signatures and message of a wire transaction. P10.5 (audit E1): only when the WHOLE message parses
 *  (`parseMessage`) and its header asks for exactly the signatures given; anything else throws. */
export function splitTransaction(wire: Uint8Array): { signatures: Uint8Array[]; message: Uint8Array } {
  let n: number;
  let at: number;
  try {
    [n, at] = readShortvec(wire, 0);
  } catch {
    throw new SolanaTxError('a malformed transaction');
  }
  if (at + 64 * n > wire.length) throw new SolanaTxError('a truncated transaction');
  const signatures = Array.from({ length: n }, (_, i) => wire.slice(at + 64 * i, at + 64 * (i + 1)));
  const message = wire.slice(at + 64 * n);
  const parsed = parseMessage(message);
  if (parsed.header.numRequiredSignatures !== n) {
    throw new SolanaTxError(
      `a transaction with ${n} signatures for a message that asks for ${parsed.header.numRequiredSignatures}`,
    );
  }
  return { signatures, message };
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
