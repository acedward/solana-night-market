// The relay's report of an account's Zswap activity, checked against the PUBLIC indexer (AA 00047
// P9.S; questions Q26, and Q31 for why this part still comes from the relay).
//
// Which of the account's coins exist and which are spent come from the ledger's Zswap EVENTS (a leaf
// inserted at an exact Merkle position, a nullifier spent). Decoding an event needs ledger-v9's WASM
// (about 10 MB), which the browser bundle deliberately does not carry (plan P0.4), so the relay
// decodes them (`GET /v1/accounts/:a/zswap`). The browser does not take that report on trust:
//
//   - it computes every commitment and nullifier itself (./coins.ts), so the relay cannot attach a
//     report to another coin;
//   - it reads the account's transactions and their RAW event bytes from the public indexer itself,
//     and keeps a reported output (spend) only when that transaction is one of the account's and one
//     of its events carries the account's address AND the reported commitment (nullifier), both
//     32-byte values, at a byte boundary. A relay cannot invent a coin or a spend this way.
//
// What it still cannot catch (Q31): a hidden output or spend (the report leaves one out), and a wrong
// Merkle position. Neither moves funds or produces an unsigned action: the signed challenge binds the
// coin and its position, the circuit checks the position against the ledger's tree, and the ledger
// refuses a nullifier twice; a hidden coin stays on chain for any honest reader to find.

import type { OwnedInput, OwnedOutput } from './coins.js';
import type { ZswapActivity } from './accounts.js';

/** One of the account's transactions with its raw Zswap events, as the indexer serves them. */
export interface RawAccountTx {
  hash: string;
  blockHeight: number;
  events: ReadonlyArray<{ id: number; raw: string }>;
}

const norm = (h: string) => h.replace(/^0x/, '').toLowerCase();

/** Whether `hay` (hex) contains `needle` (hex) at a whole-byte offset. */
export function containsBytes(hay: string, needle: string): boolean {
  const h = norm(hay);
  const n = norm(needle);
  if (n.length === 0 || n.length % 2 !== 0) return false;
  for (let i = h.indexOf(n); i >= 0; i = h.indexOf(n, i + 1)) if (i % 2 === 0) return true;
  return false;
}

export interface ZswapCheck {
  /** The report, with only what the indexer's own events support. */
  activity: ZswapActivity;
  /** Reported outputs and spends the indexer does not support (dropped). */
  unsupported: Array<{ kind: 'output' | 'spend'; value: string; txHash: string }>;
}

/** Keep the relay's reported outputs and spends that the account's own transactions carry. */
export function checkZswapActivity(account: string, reported: ZswapActivity, txs: readonly RawAccountTx[]): ZswapCheck {
  const me = norm(account);
  const byHash = new Map(txs.map((t) => [norm(t.hash), t]));
  const unsupported: ZswapCheck['unsupported'] = [];
  const carried = (txHash: string, value: string) => {
    const tx = byHash.get(norm(txHash));
    return !!tx && tx.events.some((e) => containsBytes(e.raw, me) && containsBytes(e.raw, value));
  };
  const outputs: OwnedOutput[] = [];
  for (const o of reported.outputs) {
    if (carried(o.txHash, o.commitment)) outputs.push(o);
    else unsupported.push({ kind: 'output', value: norm(o.commitment), txHash: norm(o.txHash) });
  }
  const inputs: OwnedInput[] = [];
  for (const i of reported.inputs) {
    if (carried(i.txHash, i.nullifier)) inputs.push(i);
    else unsupported.push({ kind: 'spend', value: norm(i.nullifier), txHash: norm(i.txHash) });
  }
  return { activity: { ...reported, outputs, inputs }, unsupported };
}
