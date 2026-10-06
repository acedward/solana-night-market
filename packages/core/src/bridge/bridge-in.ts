// AA 00060 P7.2 (spec FR-001, FR-003): Bridge in's Solana transaction, built by the page itself from the
// journey registry (I-1) and I-2 (./lock-codec.ts, the only module that knows the bytes): ONE
// `LockToContract` whose Midnight recipient is the connected wallet's own market account, paid and
// signed by the connected wallet. Nothing here talks to a network or a wallet.
//
//   accounts (I-2, frozen 2026-10-04 @ 00058 6c07dab): depositor (signer) · the depositor's associated
//   token account for the mint (writable) · the bridge's `config` PDA (writable) · its vault PDA
//   ["vault", mint] (writable) · the classic Token program
//
// `decodeLockToAccount` reads a transaction back (the one the wallet returns from `signTransaction`, or
// the page's own) so the page shows, and checks, exactly what is signed: one instruction, to the
// registry's bridge program, with these accounts and this data.

import { bytesToHex, hexToBytes, normaliseHex32 } from '../hex.js';
import { associatedTokenAddress, bridgeConfigAddress, bridgeVaultAddress } from '../solana/pda.js';
import {
  TOKEN_PROGRAM_ID,
  compileLegacyMessage,
  decodeKey,
  encodeKey,
  splitTransaction,
  unsignedTransaction,
  type CompiledMessage,
  type Instruction,
} from '../solana/tx.js';
import { LockCodecError, decodeLockToContract, encodeLockToContract } from './lock-codec.js';
import type { BridgeEntry } from './registry.js';

export interface LockToAccountInput {
  entry: Pick<BridgeEntry, 'splMint' | 'bridgeProgram' | 'colour' | 'symbol' | 'decimals'>;
  /** The connected wallet (base58): signs and pays. */
  depositor: string;
  /** Base units of the SPL mint. */
  amount: bigint;
  /** The connected wallet's market account (64 hex). */
  account: string;
}

/** What the page shows before the wallet is asked, and what it checks afterwards. */
export interface LockFacts {
  program: string;
  mint: string;
  amount: bigint;
  /** The wallet's associated token account the SPL leaves from. */
  source: string;
  depositor: string;
  /** The Midnight market account (64 hex) the tokens are delivered to. */
  account: string;
  config: string;
  vault: string;
}

export function lockToAccountFacts(input: LockToAccountInput): LockFacts {
  return {
    program: input.entry.bridgeProgram,
    mint: input.entry.splMint,
    amount: input.amount,
    source: associatedTokenAddress(input.depositor, input.entry.splMint, TOKEN_PROGRAM_ID),
    depositor: input.depositor,
    account: normaliseHex32(input.account),
    config: bridgeConfigAddress(input.entry.bridgeProgram),
    vault: bridgeVaultAddress(input.entry.bridgeProgram, input.entry.splMint),
  };
}

export function lockToAccountInstruction(input: LockToAccountInput): Instruction {
  const f = lockToAccountFacts(input);
  return {
    programId: f.program,
    keys: [
      { pubkey: f.depositor, isSigner: true, isWritable: false },
      { pubkey: f.source, isSigner: false, isWritable: true },
      { pubkey: f.config, isSigner: false, isWritable: true },
      { pubkey: f.vault, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: encodeLockToContract(input.amount, hexToBytes(f.account, 32)),
  };
}

/** The whole transaction (fee payer: the depositor), unsigned, for the wallet. */
export function buildLockToAccount(input: LockToAccountInput & { recentBlockhash: string }): {
  message: CompiledMessage;
  transaction: Uint8Array;
  facts: LockFacts;
} {
  const message = compileLegacyMessage(input.depositor, input.recentBlockhash, [lockToAccountInstruction(input)]);
  return { message, transaction: unsignedTransaction(message), facts: lockToAccountFacts(input) };
}

export class BridgeInError extends Error {
  override name = 'BridgeInError';
}

/** The legacy message's parts (enough to check one LockToContract). */
function parseLegacyMessage(m: Uint8Array) {
  let at = 0;
  const byte = () => {
    if (at >= m.length) throw new BridgeInError('a truncated transaction');
    return m[at++]!;
  };
  const shortvec = () => {
    let n = 0;
    for (let shift = 0; ; shift += 7) {
      const b = byte();
      n |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) return n;
      if (shift > 14) throw new BridgeInError('a malformed transaction');
    }
  };
  if ((m[0]! & 0x80) !== 0) throw new BridgeInError('a versioned transaction (the page builds legacy ones only)');
  const header = [byte(), byte(), byte()] as const;
  const keys: string[] = [];
  for (let i = 0, n = shortvec(); i < n; i++) {
    keys.push(encodeKey(m.slice(at, at + 32)));
    at += 32;
  }
  const blockhash = encodeKey(m.slice(at, at + 32));
  at += 32;
  const instructions: { program: string; accounts: string[]; data: Uint8Array }[] = [];
  for (let i = 0, n = shortvec(); i < n; i++) {
    const program = keys[byte()];
    const accounts: string[] = [];
    for (let j = 0, k = shortvec(); j < k; j++) accounts.push(keys[byte()]!);
    const len = shortvec();
    const data = m.slice(at, at + len);
    at += len;
    if (!program || data.length !== len) throw new BridgeInError('a malformed instruction');
    instructions.push({ program, accounts, data });
  }
  if (at !== m.length) throw new BridgeInError('trailing bytes after the instructions');
  return { header, keys, blockhash, instructions };
}

/**
 * The facts of a wire transaction that must be exactly one LockToContract for `expected` (the bridge
 * program, the accounts in I-2's order, the amount and the account), paid by the depositor. Throws
 * BridgeInError otherwise: the page never asks for, or sends, anything else.
 */
export function checkLockToAccount(wire: Uint8Array, expected: LockFacts): { blockhash: string } {
  const { message } = splitTransaction(wire);
  const t = parseLegacyMessage(message);
  if (t.keys[0] !== expected.depositor) throw new BridgeInError('the fee payer is not the connected wallet');
  if (t.instructions.length !== 1) throw new BridgeInError(`expected one instruction, found ${t.instructions.length}`);
  const ix = t.instructions[0]!;
  if (ix.program !== expected.program)
    throw new BridgeInError("the instruction is not for the registry's bridge program");
  const want = [expected.depositor, expected.source, expected.config, expected.vault, TOKEN_PROGRAM_ID];
  if (ix.accounts.length !== 5 || ix.accounts.some((a, i) => a !== want[i])) {
    throw new BridgeInError("the instruction's accounts are not the lock's");
  }
  let decoded;
  try {
    decoded = decodeLockToContract(ix.data);
  } catch (e) {
    throw new BridgeInError(e instanceof LockCodecError ? e.message : 'not a LockToContract');
  }
  if (decoded.amount !== expected.amount) throw new BridgeInError('the amount is not the one entered');
  if (bytesToHex(decoded.contract) !== expected.account)
    throw new BridgeInError('the Midnight recipient is not your account');
  // The writable and signer flags (the header): one signer (the depositor), writable.
  if (t.header[0] !== 1 || t.header[1] !== 0) throw new BridgeInError('unexpected signers');
  decodeKey(t.blockhash);
  return { blockhash: t.blockhash };
}
