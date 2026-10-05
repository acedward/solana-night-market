// AA 00060 P6.2: the chain states a Bridge-out second transaction is built on, read by the page from the
// PUBLIC indexer at ONE block (as midnight-js's `queryZSwapAndContractState` does: the block's ledger
// parameters and the contract's Zswap tree, and the contract's state as of that block), so the call, its
// tree and its parameters agree. The relay later checks the call against the same block's state.

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

const QUERY = `query BRIDGE_OUT_STATES($address: HexEncoded!, $offset: BlockOffset) {
  block(offset: $offset) { hash height ledgerParameters contractZswapState(address: $address) }
  contract(address: $address, offset: $offset) { state }
}`;

export interface ChainStates {
  blockHash: string;
  height: number;
  /** compact-runtime ContractState. */
  contractState: Any;
  /** ledger-v9 ZswapChainState (the contract's tree). */
  zswapChainState: Any;
  /** ledger-v9 LedgerParameters. */
  ledgerParameters: Any;
}

const bytesOf = (h: string): Uint8Array => {
  const s = h.replace(/^0x/i, '');
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
  return out;
};

export class StatesError extends Error {
  override name = 'StatesError';
}

/** The contract's states at the newest block (or at `blockHash`), or null when it does not exist. */
export async function readChainStates(
  indexerUrl: string,
  address: string,
  o: { blockHash?: string; fetchImpl?: typeof fetch } = {},
): Promise<ChainStates | null> {
  const f = o.fetchImpl ?? fetch;
  let latest = o.blockHash;
  if (!latest) {
    const res = await f(indexerUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: '{ block { hash height } }' }),
    });
    const b = (await res.json()) as { data?: { block?: { hash: string } } };
    latest = b.data?.block?.hash;
    if (!latest) throw new StatesError('the Midnight indexer did not answer with a block');
  }
  const res = await f(indexerUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query: QUERY,
      variables: { address: address.replace(/^0x/i, '').toLowerCase(), offset: { hash: latest } },
    }),
  });
  const body = (await res.json()) as {
    data?: {
      block?: { hash: string; height: number; ledgerParameters: string; contractZswapState: string | null };
      contract?: { state: string } | null;
    };
    errors?: { message: string }[];
  };
  if (body.errors?.length) throw new StatesError(`the Midnight indexer refused the read: ${body.errors[0]!.message}`);
  const block = body.data?.block;
  if (!block || !body.data?.contract || !block.contractZswapState) return null;
  const [crt, ledger] = await Promise.all([
    import('@midnight-ntwrk/compact-runtime-0.20'),
    import('@midnightntwrk/ledger-v9'),
  ]);
  return {
    blockHash: block.hash.replace(/^0x/i, '').toLowerCase(),
    height: block.height,
    contractState: (crt as Any).ContractState.deserialize(bytesOf(body.data.contract.state)),
    zswapChainState: (ledger as Any).ZswapChainState.deserialize(bytesOf(block.contractZswapState)),
    ledgerParameters: (ledger as Any).LedgerParameters.deserialize(bytesOf(block.ledgerParameters)),
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
