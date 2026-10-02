// Raw TRANSACTIONS for the mock indexer (AA 00047 P11.B): serialised by ledger-v9 1.0.0-rc.3 itself in
// the chain's format (signed, proven, bound), so the page's real decoder (web/src/chain/ledger-decode.ts
// `decodeTransactionCalls`) reads them exactly as it reads a stagenet transaction. Each carries the
// given contract calls, with the coins each claims to receive and the nullifiers it claims, in its
// guaranteed transcript. The proofs are placeholders from a fake prover (nothing verifies them: the
// page reads a transaction's calls, it does not re-verify the chain), and the transaction hash is the
// ledger's own, which the mock then serves the transaction under.

import * as L from '@midnightntwrk/ledger-v9';

export interface MockCall {
  address: string;
  entryPoint: string;
  receives: string[];
  nullifiers: string[];
}

const emptyMap = () => new Map();

/** A fake prover: a well-formed placeholder proof for every circuit, and key material with the
 *  current verifier-key version tag. */
const PROVIDER = {
  async check() {
    return [];
  },
  async prove() {
    return Uint8Array.from([...Buffer.from('midnight:proof[v5]:'), 0x80, ...new Uint8Array(32).fill(7)]);
  },
  async lookupKey() {
    return {
      proverKey: new Uint8Array(8),
      verifierKey: Uint8Array.from([...Buffer.from('midnight:verifier-key[v7]:'), 0, 0, 0, 0]),
      ir: new Uint8Array(8),
    };
  },
};

/** A bound, "proven" transaction with these calls: its hash and its raw bytes (hex). */
export async function rawTxWithCalls(calls: readonly MockCall[]): Promise<{ hash: string; raw: string }> {
  let intent = L.Intent.new(new Date(Date.now() + 3_600_000));
  for (const c of calls) {
    const effects = {
      claimedNullifiers: c.nullifiers,
      claimedShieldedReceives: c.receives,
      claimedShieldedSpends: [],
      claimedContractCalls: [],
      shieldedMints: emptyMap(),
      unshieldedMints: emptyMap(),
      unshieldedInputs: emptyMap(),
      unshieldedOutputs: emptyMap(),
      claimedUnshieldedSpends: emptyMap(),
    };
    const transcript = {
      gas: { readTime: 0n, computeTime: 0n, bytesWritten: 0n, bytesDeleted: 0n },
      effects,
      program: [],
    };
    const empty = { value: [], alignment: [] };
    const proto = new L.ContractCallPrototype(
      c.address,
      c.entryPoint,
      new L.ContractOperation(),
      transcript as never,
      undefined,
      [],
      empty,
      empty,
      L.communicationCommitmentRandomness(),
      c.entryPoint,
    );
    intent = intent.addCall(proto) as typeof intent;
  }
  const unproven = L.Transaction.fromParts('undeployed', undefined, undefined, intent);
  const tx = (await unproven.prove(PROVIDER as never, L.CostModel.initialCostModel())).bind();
  return { hash: tx.transactionHash(), raw: Buffer.from(tx.serialize()).toString('hex') };
}
