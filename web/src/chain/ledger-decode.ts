// The browser's own decoder of Midnight's ledger data (AA 00047 P11.B; questions Q47 A, which
// supersedes Q31; spec FR-004b "Round 3"): ledger-v9's WebAssembly (`@midnightntwrk/ledger-v9`
// 1.0.0-rc.3, the SDK set's), LOADED LAZILY. This module is only ever reached through the dynamic
// `import('./ledger-decode.js')` in ./indexer.ts (`loadLedgerDecoder`), which only the account
// (Portfolio) and trade pages run, so the production build puts it, the ledger's JavaScript glue and
// its ~10 MB WebAssembly in a chunk of their own that no other page downloads (deploy/RUNBOOK.md §16).
//
// Two decodes, both the ledger's own (nothing hand-parsed):
//   - a ledger EVENT (the indexer's `zswapLedgerEvents { raw }`): a leaf the ledger inserted
//     (`zswapOutput`: the coin commitment, the owning contract, the exact Merkle position) or a
//     nullifier it spent (`zswapInput`); each names its source transaction;
//   - a TRANSACTION (the indexer's `raw`): its contract calls, each with the coin commitments it
//     claims to receive and the nullifiers it claims (its transcripts' effects).

import { Event, Transaction, type Binding, type Proof, type SignatureEnabled } from '@midnightntwrk/ledger-v9';
import type { DecodedAccountTx, DecodedCall } from '@nightmarket/core';

/** One transaction as the indexer serves it, with what the decode needs. */
export interface IndexerTxForDecode {
  hash: string;
  /** The indexer's transaction id. */
  id: number;
  blockHeight: number;
  /** The transaction's range in the Zswap commitment tree: [start, end) (regular transactions). */
  zswapStartIndex?: number | null;
  zswapEndIndex?: number | null;
  /** The ledger's verdict: SUCCESS, PARTIAL_SUCCESS or FAILURE (regular transactions). */
  status?: string | null;
  /** The entry points of the account's calls in it. */
  entryPoints: readonly string[];
  /** Its raw Zswap ledger events. */
  events: ReadonlyArray<{ id: number; raw: string }>;
}

/** The indexer served something the ledger does not accept as what it claims to be. */
export class LedgerDecodeError extends Error {
  override name = 'LedgerDecodeError';
}

const low = (h: string) => h.replace(/^0x/, '').toLowerCase();

/** Free a WebAssembly-backed object now (wasm-bindgen's `free`, not in the typings). */
const release = (o: unknown) => (o as { free?: () => void }).free?.();

function bytesOf(hex: string): Uint8Array {
  const h = low(hex);
  if (h.length % 2 !== 0 || !/^[0-9a-f]*$/.test(h)) throw new LedgerDecodeError('not hex');
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(2 * i, 2 * i + 2), 16);
  return out;
}

const hexOf = (v: unknown): string =>
  typeof v === 'string'
    ? low(v)
    : v instanceof Uint8Array
      ? [...v].map((b) => b.toString(16).padStart(2, '0')).join('')
      : '';

/** One decoded ledger event, as plain data. */
export type DecodedLedgerEvent =
  | { kind: 'output'; commitment: string; contract: string | null; mtIndex: bigint; source: string }
  | { kind: 'input'; nullifier: string; contract: string | null; source: string }
  | { kind: 'other'; source: string };

/** Decode one raw ledger event (ledger-v9 `Event.deserialize`). Throws LedgerDecodeError. */
export function decodeEvent(rawHex: string): DecodedLedgerEvent {
  let ev: Event;
  try {
    ev = Event.deserialize(bytesOf(rawHex));
  } catch (e) {
    throw new LedgerDecodeError(`an event did not decode: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    const source = hexOf(ev.source.transactionHash);
    const c = ev.content;
    if (c.tag === 'zswapOutput') {
      const o = c as { commitment: string; contract?: string; mtIndex: bigint };
      return {
        kind: 'output',
        commitment: hexOf(o.commitment),
        contract: o.contract ? hexOf(o.contract) : null,
        mtIndex: o.mtIndex,
        source,
      };
    }
    if (c.tag === 'zswapInput') {
      const i = c as { nullifier: string; contract?: string };
      return { kind: 'input', nullifier: hexOf(i.nullifier), contract: i.contract ? hexOf(i.contract) : null, source };
    }
    return { kind: 'other', source };
  } finally {
    release(ev);
  }
}

/**
 * The account's own leaves and spends in one transaction: its decoded `zswapOutput` events whose
 * contract is the account (with the ledger's Merkle position) and its `zswapInput` events whose
 * contract is the account. Refuses (LedgerDecodeError) an event that does not decode, that names
 * another transaction as its source, or a leaf outside the transaction's range of the tree: the
 * indexer would then not be serving what the ledger did, and the read is not used.
 */
export function decodeAccountTx(account: string, tx: IndexerTxForDecode): DecodedAccountTx {
  const me = low(account);
  const hash = low(tx.hash);
  const outputs: DecodedAccountTx['outputs'] = [];
  const inputs: string[] = [];
  if (tx.status !== 'FAILURE') {
    const seen = new Set<number>();
    for (const e of [...tx.events].sort((a, b) => a.id - b.id)) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      const d = decodeEvent(e.raw);
      if (d.source !== hash) throw new LedgerDecodeError(`an event of ${hash.slice(0, 8)}… names another transaction`);
      if (d.kind === 'output' && d.contract === me) {
        const lo = tx.zswapStartIndex;
        const hi = tx.zswapEndIndex;
        if (typeof lo === 'number' && typeof hi === 'number' && (d.mtIndex < BigInt(lo) || d.mtIndex >= BigInt(hi)))
          throw new LedgerDecodeError(`a leaf of ${hash.slice(0, 8)}… lies outside its range of the tree`);
        outputs.push({ commitment: d.commitment, mtIndex: d.mtIndex.toString(10) });
      } else if (d.kind === 'input' && d.contract === me) inputs.push(d.nullifier);
    }
  }
  return { hash, blockHeight: tx.blockHeight, id: tx.id, entryPoints: [...new Set(tx.entryPoints)], outputs, inputs };
}

/** The contract calls of a raw transaction (ledger-v9 `Transaction.deserialize`, as the chain holds it:
 *  signed, proven, bound), with what each claims to receive and spend. With `expectedHash`, refuses
 *  bytes that are not that transaction (the ledger's own `transactionHash`). Throws LedgerDecodeError. */
export function decodeTransactionCalls(rawHex: string, expectedHash?: string): DecodedCall[] {
  let tx: Transaction<SignatureEnabled, Proof, Binding>;
  try {
    tx = Transaction.deserialize<SignatureEnabled, Proof, Binding>('signature', 'proof', 'binding', bytesOf(rawHex));
  } catch (e) {
    throw new LedgerDecodeError(`a transaction did not decode: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (expectedHash !== undefined && hexOf(tx.transactionHash()) !== low(expectedHash)) {
    release(tx);
    throw new LedgerDecodeError(`the bytes served for ${low(expectedHash).slice(0, 8)}… are another transaction`);
  }
  try {
    const calls: DecodedCall[] = [];
    for (const intent of tx.intents?.values() ?? []) {
      for (const action of intent.actions) {
        if (!('entryPoint' in action) || !('guaranteedTranscript' in action)) continue;
        const ep = action.entryPoint as string | Uint8Array;
        const effects = [action.guaranteedTranscript?.effects, action.fallibleTranscript?.effects].filter(
          (x): x is NonNullable<typeof x> => !!x,
        );
        calls.push({
          address: hexOf(action.address),
          entryPoint: typeof ep === 'string' ? ep : new TextDecoder().decode(ep),
          receives: effects.flatMap((f) => f.claimedShieldedReceives.map(hexOf)),
          nullifiers: effects.flatMap((f) => f.claimedNullifiers.map(hexOf)),
        });
      }
    }
    return calls;
  } finally {
    release(tx);
  }
}
