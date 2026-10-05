// AA 00060 P13: the relay's Solana JSON-RPC client, for the test SPL faucet only (SPL_FAUCET_RPC_URL). Fetch
// only; every failure to reach the RPC is an `InfrastructureError` (never the requester's fault), and an
// answer with a JSON-RPC `error` is a `SolanaRpcError` carrying its code and message.

import { InfrastructureError } from '../actions/failure-budget.js';

export class SolanaRpcError extends Error {
  override name = 'SolanaRpcError';
  constructor(
    readonly method: string,
    readonly code: number | null,
    message: string,
  ) {
    super(message);
  }
}

export interface RpcAccount {
  owner: string;
  lamports: bigint;
  data: Uint8Array;
}

export interface SignatureStatus {
  slot: number;
  err: unknown;
  confirmationStatus: 'processed' | 'confirmed' | 'finalized' | null;
}

/** The `fetch` this client uses (injectable for tests). */
export type FaucetFetch = (url: string, init: RequestInit) => Promise<Response>;

export class FaucetSolanaRpc {
  private id = 0;
  constructor(
    private readonly url: string,
    private readonly fetchImpl: FaucetFetch = (u, init) => fetch(u, init),
    private readonly timeoutMs = 15_000,
  ) {}

  async call<T>(method: string, params: unknown[] = []): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method, params }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      // The URL may carry a key: never put it (or the underlying error, which can name it) in the text.
      throw new InfrastructureError(`the Solana RPC could not be reached (${method})`);
    }
    const body = (await res.json().catch(() => null)) as {
      result?: T;
      error?: { code?: number; message?: string };
    } | null;
    if (!body) throw new InfrastructureError(`the Solana RPC answered HTTP ${res.status} (${method})`);
    if (body.error) {
      throw new SolanaRpcError(
        method,
        typeof body.error.code === 'number' ? body.error.code : null,
        String(body.error.message ?? `${method} failed`).slice(0, 300),
      );
    }
    return body.result as T;
  }

  genesisHash = (): Promise<string> => this.call<string>('getGenesisHash');

  async account(address: string): Promise<RpcAccount | null> {
    const r = await this.call<{ value: { owner: string; lamports: number; data: [string, string] } | null }>(
      'getAccountInfo',
      [address, { encoding: 'base64', commitment: 'confirmed' }],
    );
    if (!r?.value) return null;
    return {
      owner: r.value.owner,
      lamports: BigInt(r.value.lamports),
      data: new Uint8Array(Buffer.from(r.value.data[0], 'base64')),
    };
  }

  async latestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
    const r = await this.call<{ value: { blockhash: string; lastValidBlockHeight: number } }>('getLatestBlockhash', [
      { commitment: 'confirmed' },
    ]);
    return r.value;
  }

  blockHeight = (): Promise<number> => this.call<number>('getBlockHeight', [{ commitment: 'confirmed' }]);

  /** Send a signed wire transaction (preflight on: a transaction that cannot succeed is refused here). */
  sendTransaction = (wire: Uint8Array): Promise<string> =>
    this.call<string>('sendTransaction', [
      Buffer.from(wire).toString('base64'),
      { encoding: 'base64', preflightCommitment: 'confirmed' },
    ]);

  async signatureStatus(signature: string): Promise<SignatureStatus | null> {
    const r = await this.call<{ value: (SignatureStatus | null)[] }>('getSignatureStatuses', [
      [signature],
      { searchTransactionHistory: true },
    ]);
    return r?.value?.[0] ?? null;
  }
}
