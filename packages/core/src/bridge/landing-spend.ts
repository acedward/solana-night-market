// AA 00060 P6.0 / P6.1 (questions Q5, owner decision A): spending a landing coin WITHOUT the wallet SDK's
// sync. The relay's tx1 binds the landing coin's owner (keys_t's coin public key), its colour and its
// value in the wallet's approval, but not the encryption key the coin is sealed to (00047 Q28). A coin
// sealed to another key is invisible to an SDK wallet (it finds coins by decrypting), yet the page knows
// the coin itself: its nonce is the paid-out nonce of tx1's spend (./out.ts), its colour and value are
// the withdrawal's. So the page builds its own ledger-v9 Zswap local state:
//
//   new ZswapLocalState().watchFor(keys_t.coinPublicKey, coin)   the coin it expects (no ciphertext needed)
//   .replayEvents(keys_t, <every Zswap event of the chain, in order>)   the commitment tree and the coin's
//                                                                  position, as the SDK's own sync does
//   .spend(keys_t, coin, segment)                                 the coin's Zswap input
//
// and merges that input into the call that receives the coin (tx2's `lockForSolana`, or the return's
// `deposit_shielded`). The same path serves an honest tx1: it never depends on the ciphertext.
//
// Everything here holds keys_t (SECRET): the caller clears the keys when the transfer ends.

import * as ledger from '@midnightntwrk/ledger-v9';

const norm = (h: string) => h.replace(/^0x/i, '').toLowerCase();

/** The landing coin as the page computes it (64 hex each; value in base units). */
export interface LandingCoinInfo {
  nonce: string;
  color: string;
  value: bigint;
}

export class LandingSpendError extends Error {
  override name = 'LandingSpendError';
  constructor(
    readonly code: 'not-seen' | 'spent' | 'no-segment' | 'bad-event',
    message: string,
  ) {
    super(message);
  }
}

export interface LandingSpendKeys {
  readonly shieldedSecretKeys: ledger.ZswapSecretKeys;
  readonly coinPublicKey: string;
}

/**
 * keys_t's Zswap local state with the landing coin watched for and the chain's Zswap events replayed,
 * oldest first (the indexer's `zswapLedgerEvents`, every one from the first). `raw` are the events'
 * serialized bytes.
 */
export function landingLocalState(
  keys: LandingSpendKeys,
  coin: LandingCoinInfo,
  raw: Iterable<Uint8Array>,
): ledger.ZswapLocalState {
  const watched = new ledger.ZswapLocalState().watchFor(norm(keys.coinPublicKey), {
    nonce: norm(coin.nonce),
    type: norm(coin.color),
    value: coin.value,
  } as never);
  const events: ledger.Event[] = [];
  for (const bytes of raw) {
    try {
      events.push(ledger.Event.deserialize(bytes));
    } catch (e) {
      // Not replayed: free what was decoded so far. (`replayEvents` takes ownership of the events it is
      // given: freeing them afterwards is "null pointer passed to rust", G-LANDING Q5 gate run 2.)
      for (const ev of events) (ev as unknown as { free?: () => void }).free?.();
      throw new LandingSpendError('bad-event', `a Zswap event did not decode: ${(e as Error).message}`);
    }
  }
  return watched.replayEvents(keys.shieldedSecretKeys, events);
}

/** The landing coin with its position, as the local state holds it (spendable), or null. */
export function findLandingCoin(
  state: ledger.ZswapLocalState,
  coin: LandingCoinInfo,
): ledger.QualifiedShieldedCoinInfo | null {
  const nonce = norm(coin.nonce);
  const color = norm(coin.color);
  for (const c of state.coins) {
    const q = c as unknown as { nonce: string; type: string; value: bigint };
    if (norm(String(q.nonce)) === nonce && norm(String(q.type)) === color && BigInt(q.value) === coin.value) return c;
  }
  return null;
}

/** The segments a transaction declares (0, and each intent's and fallible offer's). */
function segmentsOf(tx: ledger.UnprovenTransaction): number[] {
  const out = new Set<number>([0]);
  const t = tx as unknown as { intents?: Map<number, unknown>; fallibleOffer?: Map<number, unknown> };
  for (const m of [t.intents, t.fallibleOffer]) if (m instanceof Map) for (const k of m.keys()) out.add(Number(k));
  return [...out].sort((a, b) => a - b);
}

/** The segment whose shielded imbalance in `color` is short of exactly `value` (the call's receive). */
export function receivingSegment(tx: ledger.UnprovenTransaction, color: string, value: bigint): number | null {
  const want = norm(color);
  for (const s of segmentsOf(tx)) {
    for (const [token, delta] of tx.imbalances(s)) {
      const t = token as unknown as { tag?: string; raw?: string };
      if (t.tag === 'shielded' && norm(String(t.raw)) === want && delta === -value) return s;
    }
  }
  return null;
}

/**
 * Balance `unproven` (a call that receives the landing coin) with the coin's Zswap input, built from
 * `state` (see `landingLocalState`). Returns the merged, still unproven transaction and the coin's
 * position. Throws `not-seen` when the local state does not hold the coin (tx1 not on chain yet, or
 * another coin), `no-segment` when no segment of the call is short of exactly this coin.
 */
export function balanceWithLandingCoin(
  unproven: ledger.UnprovenTransaction,
  state: ledger.ZswapLocalState,
  keys: LandingSpendKeys,
  coin: LandingCoinInfo,
  networkId: string,
): { tx: ledger.UnprovenTransaction; segment: number; mtIndex: bigint } {
  const q = findLandingCoin(state, coin);
  if (!q) {
    throw new LandingSpendError(
      'not-seen',
      'the landing coin is not among the coins the chain shows for this transfer (not landed yet, or already spent)',
    );
  }
  const segment = receivingSegment(unproven, coin.color, coin.value);
  if (segment === null) {
    throw new LandingSpendError('no-segment', 'no segment of the call receives exactly the landing coin');
  }
  const [, input] = state.spend(keys.shieldedSecretKeys, q, segment);
  const offer = ledger.ZswapOffer.fromInput(input, q.type, q.value);
  const balancing =
    segment === 0
      ? ledger.Transaction.fromParts(networkId, offer)
      : ledger.Transaction.fromParts(networkId).addZswapOffer({ tag: 'specific', value: segment } as never, offer);
  return { tx: unproven.merge(balancing), segment, mtIndex: BigInt((q as unknown as { mt_index: bigint }).mt_index) };
}
