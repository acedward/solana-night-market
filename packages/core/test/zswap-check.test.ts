// AA 00047 P9.S (questions Q31): the relay still decodes the account's Zswap events (the browser
// bundle carries no ledger-v9), and the browser keeps its report only where the public indexer's own
// raw events carry it. Checked on the LIVE stagenet account A: the honest decoding (ledger-v9's
// `Event.deserialize`, exactly as relay/src/chain/indexer.ts does) passes whole; anything a relay
// invents does not.

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type { ZswapActivity } from '../src/accounts.js';
import { checkZswapActivity, containsBytes, type RawAccountTx } from '../src/zswap-check.js';

const f = JSON.parse(
  readFileSync(new URL('../../../test/fixtures/stagenet-account-a.json', import.meta.url), 'utf8'),
) as {
  account: string;
  actions: Array<{
    transaction: { hash: string; block: { height: number }; zswapLedgerEvents: Array<{ id: number; raw: string }> };
  }>;
  relayDecoded: ZswapActivity;
};
const txs: RawAccountTx[] = f.actions.map((a) => ({
  hash: a.transaction.hash,
  blockHeight: a.transaction.block.height,
  events: a.transaction.zswapLedgerEvents,
}));

describe('containsBytes', () => {
  it('matches whole bytes only, case and 0x insensitive', () => {
    expect(containsBytes('0xAABBCC', 'bbcc')).toBe(true);
    expect(containsBytes('aabbcc', 'abbc')).toBe(false); // half-byte offset
    expect(containsBytes('0abbcc', 'bbcc')).toBe(true);
    expect(containsBytes('aabbcc', '')).toBe(false);
  });
});

describe('checkZswapActivity on the live stagenet account A', () => {
  it('keeps everything an honest relay reports', () => {
    expect(f.relayDecoded.outputs.length + f.relayDecoded.inputs.length).toBeGreaterThan(0);
    const r = checkZswapActivity(f.account, f.relayDecoded, txs);
    expect(r.unsupported).toEqual([]);
    expect(r.activity).toEqual(f.relayDecoded);
  });

  it('drops an invented output, an invented spend, and a real one moved to another transaction', () => {
    const real = f.relayDecoded.outputs[0]!;
    const otherTx = txs.find((t) => t.hash !== real.txHash)!.hash;
    const lying: ZswapActivity = {
      ...f.relayDecoded,
      outputs: [
        ...f.relayDecoded.outputs,
        { commitment: '11'.repeat(32), mtIndex: '5', txHash: real.txHash, blockHeight: real.blockHeight },
        { ...real, txHash: otherTx },
      ],
      inputs: [...f.relayDecoded.inputs, { nullifier: '22'.repeat(32), txHash: real.txHash, blockHeight: 1 }],
    };
    const r = checkZswapActivity(f.account, lying, txs);
    expect(r.unsupported.map((u) => [u.kind, u.value.slice(0, 4)])).toEqual([
      ['output', '1111'],
      ['output', real.commitment.slice(0, 4)],
      ['spend', '2222'],
    ]);
    expect(r.activity).toEqual(f.relayDecoded);
  });

  it('drops a report for another account’s coin in the same transaction', () => {
    // The settlement 4464f3f4… (plan P6.3) carries both accounts' outputs. This commitment is account
    // B's (57351491…412e) change, at mtIndex 5183: it sits in that transaction, but in B's event.
    const settle = txs.find((t) => t.hash.startsWith('4464f3f4'))!;
    const commitment = '0a54cabb45558285f4bdeb733384c69e1584f7638a9fa3d1a84282c8e162f575';
    expect(settle.events.some((e) => containsBytes(e.raw, commitment))).toBe(true);
    const r = checkZswapActivity(
      f.account,
      { ...f.relayDecoded, outputs: [{ commitment, mtIndex: '1', txHash: settle.hash, blockHeight: 1 }], inputs: [] },
      txs,
    );
    expect(r.unsupported).toHaveLength(1);
  });
});
