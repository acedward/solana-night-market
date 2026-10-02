// Serialised ledger EVENTS for tests and mocks (AA 00047 P11.B): byte for byte the layout ledger-v9
// 1.0.0-rc.3 emits for a contract-owned Zswap leaf (`zswapOutput`) and a contract's spend
// (`zswapInput`), as the stagenet indexer serves them (account A's events in
// test/fixtures/stagenet-p11b/), with the contract, the source transaction, the commitment or
// nullifier and the Merkle position put in. web/test/ledger-decode.test.ts checks that ledger-v9's
// own `Event.deserialize` reads every one of them back, so the page's real decoder runs on them.

const TAG = '6d69646e696768743a6576656e745b7631345d3a'; // "midnight:event[v14]:"

const hex32 = (h: string) => {
  const x = h.replace(/^0x/, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(x)) throw new Error(`not 32 bytes of hex: ${h}`);
  return x;
};

/** SCALE compact encoding of a non-negative integer below 2^30, as hex. */
export function compactHex(n: number | bigint): string {
  const v = BigInt(n);
  const le = (x: bigint, bytes: number) => {
    let out = '';
    for (let i = 0; i < bytes; i++)
      out += Number((x >> BigInt(8 * i)) & 0xffn)
        .toString(16)
        .padStart(2, '0');
    return out;
  };
  if (v < 0n) throw new Error('negative');
  if (v < 1n << 6n) return le(v << 2n, 1);
  if (v < 1n << 14n) return le((v << 2n) | 1n, 2);
  if (v < 1n << 30n) return le((v << 2n) | 2n, 4);
  throw new Error('too large for this fixture');
}

/** A leaf of a coin owned by `contract`, inserted by `txHash` at `mtIndex`. */
export function zswapOutputEventHex(a: {
  txHash: string;
  contract: string;
  commitment: string;
  mtIndex: number | bigint;
}) {
  const body = `${hex32(a.txHash)}00000000` + `01${hex32(a.commitment)}0200${compactHex(a.mtIndex)}`;
  return `${TAG}080080${hex32(a.contract)}0400${compactHex(body.length / 2)}${body}`;
}

/** A spend of a coin owned by `contract` (its nullifier), by `txHash`. */
export function zswapInputEventHex(a: { txHash: string; contract: string; nullifier: string }) {
  const body = `${hex32(a.txHash)}00000000` + `00${hex32(a.nullifier)}00`;
  return `${TAG}080080${hex32(a.contract)}0400${compactHex(body.length / 2)}${body}`;
}
