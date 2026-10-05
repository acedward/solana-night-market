// AA 00060 P13 (spec FR-024): the classic SPL Token and Associated Token Account instructions the relay's
// test faucet sends ("Mint Solana tokens"), the Mint account's layout, and a signed transaction's wire
// bytes. Browser-safe; no @solana/web3.js or @solana/spl-token. The instruction bytes equal
// @solana/spl-token 0.4.15's for the same inputs (vectors in packages/core/test/fixtures/spl-instructions.json).
//
//   Mint account (82 bytes):  mintAuthority COption<Pubkey> (u32 LE tag ‖ 32 bytes) ‖ supply u64 LE ‖
//                             decimals u8 ‖ isInitialized u8 ‖ freezeAuthority COption<Pubkey>
//   Token MintToChecked:      data [14 ‖ amount u64 LE ‖ decimals u8]; accounts: the mint (writable), the
//                             destination token account (writable), the mint authority (signer)
//   ATA CreateIdempotent:     data [1]; accounts: the payer (signer, writable), the associated token account
//                             (writable), its owner, the mint, the System program, the Token program. It
//                             creates the account when it is missing and does nothing when it exists.

import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  SolanaTxError,
  TOKEN_PROGRAM_ID,
  decodeKey,
  encodeKey,
  shortvec,
  type CompiledMessage,
  type Instruction,
} from './tx.js';

/** The largest wire transaction a Solana node accepts (PACKET_DATA_SIZE). */
export const MAX_TRANSACTION_BYTES = 1232;

/** The size of a classic SPL Token mint account. */
export const MINT_ACCOUNT_BYTES = 82;

const U64_MAX = (1n << 64n) - 1n;

export interface MintAccount {
  /** The mint authority (base58), or null when minting is disabled. */
  mintAuthority: string | null;
  supply: bigint;
  decimals: number;
  isInitialized: boolean;
  freezeAuthority: string | null;
}

/** Parse a classic SPL Token mint account's data; throws `SolanaTxError` when it is not one. */
export function parseMintAccount(data: Uint8Array): MintAccount {
  if (data.length !== MINT_ACCOUNT_BYTES) throw new SolanaTxError(`a mint account is ${MINT_ACCOUNT_BYTES} bytes`);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const option = (at: number): string | null => {
    const tag = view.getUint32(at, true);
    if (tag === 0) return null;
    if (tag !== 1) throw new SolanaTxError('a malformed mint account');
    return encodeKey(data.slice(at + 4, at + 36));
  };
  const isInitialized = data[45]!;
  if (isInitialized > 1) throw new SolanaTxError('a malformed mint account');
  return {
    mintAuthority: option(0),
    supply: view.getBigUint64(36, true),
    decimals: data[44]!,
    isInitialized: isInitialized === 1,
    freezeAuthority: option(46),
  };
}

/** Token `MintToChecked`: mint `amount` base units of `mint` (which has `decimals`) to `destination`. */
export function mintToCheckedInstruction(
  mint: string,
  destination: string,
  authority: string,
  amount: bigint,
  decimals: number,
  tokenProgram = TOKEN_PROGRAM_ID,
): Instruction {
  if (amount <= 0n || amount > U64_MAX) throw new SolanaTxError('the amount is not a positive u64');
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new SolanaTxError('bad decimals');
  decodeKey(mint, 'the mint');
  decodeKey(destination, 'the destination');
  decodeKey(authority, 'the mint authority');
  const data = new Uint8Array(10);
  const view = new DataView(data.buffer);
  data[0] = 14;
  view.setBigUint64(1, amount, true);
  data[9] = decimals;
  return {
    programId: tokenProgram,
    keys: [
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data,
  };
}

/** Associated Token Account `CreateIdempotent`: `owner`'s token account for `mint`, paid by `payer`. */
export function createAssociatedTokenAccountIdempotentInstruction(
  payer: string,
  associatedAccount: string,
  owner: string,
  mint: string,
  tokenProgram = TOKEN_PROGRAM_ID,
): Instruction {
  for (const [k, what] of [
    [payer, 'the payer'],
    [associatedAccount, 'the associated account'],
    [owner, 'the owner'],
    [mint, 'the mint'],
  ] as const)
    decodeKey(k, what);
  return {
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: associatedAccount, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: tokenProgram, isSigner: false, isWritable: false },
    ],
    data: Uint8Array.of(1),
  };
}

/** The wire transaction: `shortvec(n) ‖ n signatures ‖ message`, the signatures in the message's
 *  signer order (`accountKeys[0..numRequiredSignatures)`). */
export function assembleTransaction(message: CompiledMessage, signatures: readonly Uint8Array[]): Uint8Array {
  if (signatures.length !== message.numRequiredSignatures)
    throw new SolanaTxError(`the message needs ${message.numRequiredSignatures} signatures`);
  for (const s of signatures) if (s.length !== 64) throw new SolanaTxError('a signature is 64 bytes');
  const head = shortvec(signatures.length);
  const out = new Uint8Array(head.length + 64 * signatures.length + message.bytes.length);
  out.set(head, 0);
  signatures.forEach((s, i) => out.set(s, head.length + 64 * i));
  out.set(message.bytes, head.length + 64 * signatures.length);
  return out;
}
