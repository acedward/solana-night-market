// AA 00060 P7.1: program-derived addresses for Bridge in, browser-safe (no @solana/web3.js in the app).
//
//   createProgramAddress(seeds, program) = SHA-256(seed₀ ‖ … ‖ seedₙ ‖ program ‖ "ProgramDerivedAddress"),
//   refused when the result is a point on the Ed25519 curve (it could have a private key);
//   findProgramAddress tries the bump seed 255, 254, … appended as the last seed.
//
// The on-curve test is @solana/web3.js 1.x's (`ed25519.ExtendedPoint.fromHex`, which decodes leniently,
// ZIP-215): noble's `Point.fromBytes(bytes, true)`. T7.1 holds every address here equal to web3.js's.
//
//   associatedTokenAddress(owner, mint, tokenProgram) = findProgramAddress([owner, tokenProgram, mint], ATA program)
//   the bridge's config PDA   = findProgramAddress(["config"], bridge program)            (00050 instructions.ts:43-77)
//   the bridge's vault PDA    = findProgramAddress(["vault", mint], bridge program)
//   a release receipt PDA     = findProgramAddress(["release", u64 LE withdrawal id], bridge program)

import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';

import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, SolanaTxError, decodeKey, encodeKey } from './tx.js';

const PDA_MARKER = new TextEncoder().encode('ProgramDerivedAddress');
const MAX_SEED_LENGTH = 32;
const MAX_SEEDS = 16;

/** Whether 32 bytes decode as a point of the Ed25519 curve (web3.js's `isOnCurve`). */
export function isOnCurve(bytes: Uint8Array): boolean {
  try {
    ed25519.Point.fromBytes(bytes, true);
    return true;
  } catch {
    return false;
  }
}

export function createProgramAddress(seeds: readonly Uint8Array[], programId: string): string {
  if (seeds.length > MAX_SEEDS) throw new SolanaTxError('too many seeds');
  const parts: Uint8Array[] = [];
  for (const s of seeds) {
    if (s.length > MAX_SEED_LENGTH) throw new SolanaTxError('a seed is longer than 32 bytes');
    parts.push(s);
  }
  parts.push(decodeKey(programId, 'the program id'), PDA_MARKER);
  const buf = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    buf.set(p, at);
    at += p.length;
  }
  const hash = sha256(buf);
  if (isOnCurve(hash)) throw new SolanaTxError('the address is on the curve');
  return encodeKey(hash);
}

export function findProgramAddress(seeds: readonly Uint8Array[], programId: string): [string, number] {
  for (let bump = 255; bump >= 0; bump--) {
    try {
      return [createProgramAddress([...seeds, Uint8Array.of(bump)], programId), bump];
    } catch (e) {
      if (!(e instanceof SolanaTxError) || e.message !== 'the address is on the curve') throw e;
    }
  }
  throw new SolanaTxError('no viable bump seed');
}

/** The associated token account of `owner` for `mint` (classic Token program unless given). */
export function associatedTokenAddress(owner: string, mint: string, tokenProgram = TOKEN_PROGRAM_ID): string {
  return findProgramAddress(
    [decodeKey(owner, 'the owner'), decodeKey(tokenProgram, 'the token program'), decodeKey(mint, 'the mint')],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0];
}

const ascii = (s: string) => new TextEncoder().encode(s);

export function bridgeConfigAddress(bridgeProgram: string): string {
  return findProgramAddress([ascii('config')], bridgeProgram)[0];
}

export function bridgeVaultAddress(bridgeProgram: string, mint: string): string {
  return findProgramAddress([ascii('vault'), decodeKey(mint, 'the mint')], bridgeProgram)[0];
}

export function bridgeReleaseReceiptAddress(bridgeProgram: string, withdrawalId: bigint): string {
  const id = new Uint8Array(8);
  new DataView(id.buffer).setBigUint64(0, withdrawalId, true);
  return findProgramAddress([ascii('release'), id], bridgeProgram)[0];
}
