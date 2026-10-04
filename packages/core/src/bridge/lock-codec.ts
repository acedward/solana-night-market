// I-2, a Solana bridge `Lock` whose Midnight recipient is a contract (owner 00058; consumer: Night
// Market's Bridge in). THE ONLY MODULE THAT KNOWS THESE BYTES (AA 00060 P1.5).
//
// PROVISIONAL. It implements 00058's PROPOSAL of 2026-10-04 (plans/00058-bridge-contract-delivery.md,
// Interfaces "I-2", Status PROPOSED) exactly, and assumes that proposal is what 00058's P1 freezes:
//   - instruction tag 3 `LockToContract`: data = 0x03 ‖ amount u64 LE (> 0) ‖ contract [32] (not all
//     zero), 41 bytes; accounts identical to `Lock`, in the same order: depositor (signer), the
//     depositor's token account (writable), the `config` PDA (writable), the vault PDA (writable), the
//     classic Token program;
//   - one log line per instruction: `EFFECTSTREAM_BRIDGE|LOCKC|<nonce>|<depositor>|<mint>|<amount>|<contractHex64>`
//     (`msg!` prefixes `Program log: `), the nonce and amount decimal u64;
//   - a client reads its lock nonce from `getTransaction(signature, {commitment: "confirmed",
//     maxSupportedTransactionVersion: 0}).meta.logMessages`, one LOCKC line per LockToContract
//     instruction, in order; the transfer id is `s2m:<nonce>`.
// P7.4 replaces any difference with 00058's frozen text and imports its golden vectors
// (`packages/tests/fixtures/00058-interfaces.json` in the bridge template) byte for byte.

export const I2_STATUS = 'PROVISIONAL (00058 proposal of 2026-10-04)';

/** The new instruction's tag. */
export const LOCK_TO_CONTRACT_TAG = 3;
/** The wallet-recipient `Lock` tag (unchanged by I-2; Night Market never builds it). */
export const LOCK_TAG = 1;
export const LOCK_TO_CONTRACT_DATA_BYTES = 41;

/** The accounts of a LockToContract, in order (each `[name, signer, writable]`). */
export const LOCK_TO_CONTRACT_ACCOUNTS = [
  ['depositor', true, false],
  ['source', false, true],
  ['config', false, true],
  ['vault', false, true],
  ['tokenProgram', false, false],
] as const;

const U64_MAX = (1n << 64n) - 1n;

export class LockCodecError extends Error {
  override name = 'LockCodecError';
}

/** The 41 data bytes of a LockToContract. */
export function encodeLockToContract(amount: bigint, contract: Uint8Array): Uint8Array {
  if (amount <= 0n || amount > U64_MAX) throw new LockCodecError(`the amount must be a u64 above 0, got ${amount}`);
  if (contract.length !== 32) throw new LockCodecError('the contract address is 32 bytes');
  if (contract.every((b) => b === 0)) throw new LockCodecError('the contract address is all zero');
  const data = new Uint8Array(LOCK_TO_CONTRACT_DATA_BYTES);
  data[0] = LOCK_TO_CONTRACT_TAG;
  new DataView(data.buffer).setBigUint64(1, amount, true);
  data.set(contract, 9);
  return data;
}

/** The fields of a LockToContract's data, or a LockCodecError (any other length, tag, zero amount or contract). */
export function decodeLockToContract(data: Uint8Array): { amount: bigint; contract: Uint8Array } {
  if (data.length !== LOCK_TO_CONTRACT_DATA_BYTES) {
    throw new LockCodecError(`a LockToContract is ${LOCK_TO_CONTRACT_DATA_BYTES} bytes, got ${data.length}`);
  }
  if (data[0] !== LOCK_TO_CONTRACT_TAG) throw new LockCodecError(`not a LockToContract (tag ${data[0]})`);
  const amount = new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(1, true);
  const contract = data.slice(9);
  if (amount === 0n) throw new LockCodecError('a zero amount');
  if (contract.every((b) => b === 0)) throw new LockCodecError('an all-zero contract');
  return { amount, contract };
}

export interface LockcLog {
  kind: 'LOCKC';
  nonce: bigint;
  depositor: string;
  mint: string;
  amount: bigint;
  contractHex: string;
}

const LOCKC_RE =
  /^(?:Program log: )?EFFECTSTREAM_BRIDGE\|LOCKC\|(0|[1-9][0-9]{0,19})\|([1-9A-HJ-NP-Za-km-z]{32,44})\|([1-9A-HJ-NP-Za-km-z]{32,44})\|(0|[1-9][0-9]{0,19})\|([0-9a-f]{64})$/;

/** One LOCKC log line, or null (any other line, or a nonce/amount above u64). */
export function parseLockcLog(line: string): LockcLog | null {
  const m = LOCKC_RE.exec(line);
  if (!m) return null;
  const nonce = BigInt(m[1]!);
  const amount = BigInt(m[4]!);
  if (nonce > U64_MAX || amount > U64_MAX) return null;
  return { kind: 'LOCKC', nonce, depositor: m[2]!, mint: m[3]!, amount, contractHex: m[5]! };
}

/** Every LOCKC line of a transaction's logs, in order. */
export const lockcLogs = (logMessages: readonly string[]): LockcLog[] =>
  logMessages.map(parseLockcLog).filter((l): l is LockcLog => l !== null);

/**
 * The lock nonce of the ONE LockToContract a Night Market Bridge in sends (one instruction per
 * transaction), checked against what the page asked for: the depositor, the mint, the amount and the
 * account. Throws when the logs hold no such line, or more than one.
 */
export function readLockNonce(
  logMessages: readonly string[],
  expected: { depositor: string; mint: string; amount: bigint; contractHex: string },
): bigint {
  const lines = lockcLogs(logMessages);
  if (lines.length !== 1) throw new LockCodecError(`expected one LOCKC log line, found ${lines.length}`);
  const l = lines[0]!;
  if (
    l.depositor !== expected.depositor ||
    l.mint !== expected.mint ||
    l.amount !== expected.amount ||
    l.contractHex !== expected.contractHex.toLowerCase()
  ) {
    throw new LockCodecError('the LOCKC log line does not match the lock the page sent');
  }
  return l.nonce;
}

/** The bridge API's id of a Solana → Midnight transfer. */
export const s2mTransferId = (nonce: bigint): string => `s2m:${nonce}`;
/** The bridge API's id of a Midnight → Solana transfer (the bridge's withdrawal id). */
export const m2sTransferId = (withdrawalId: bigint): string => `m2s:${withdrawalId}`;
