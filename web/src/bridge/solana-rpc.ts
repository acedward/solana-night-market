// AA 00060 P7.3: the page's Solana JSON-RPC client (config.json `solana.rpcUrl`): the reads Bridge in
// checks before the wallet is asked, the page's own send for `solana:signTransaction`, and the
// confirmation and the program log it reads the lock nonce from. Browser-safe: fetch only.

import { toBase64 } from '@nightmarket/core/solana';

export class SolanaRpcError extends Error {
  override name = 'SolanaRpcError';
}

export interface AccountInfo {
  owner: string;
  lamports: number;
  data: Uint8Array;
}

const fromBase64 = (b64: string): Uint8Array => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

export class SolanaRpc {
  private id = 0;
  constructor(
    readonly url: string,
    private readonly fetchImpl: typeof fetch = (i, init) => fetch(i, init),
  ) {}

  async call<T>(method: string, params: unknown[] = []): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method, params }),
      });
    } catch {
      throw new SolanaRpcError("The site's Solana RPC cannot be reached.");
    }
    const body = (await res.json().catch(() => null)) as { result?: T; error?: { message?: string } } | null;
    if (!body) throw new SolanaRpcError(`The Solana RPC answered ${res.status}.`);
    if (body.error) throw new SolanaRpcError(body.error.message ?? `${method} failed`);
    return body.result as T;
  }

  genesisHash = () => this.call<string>('getGenesisHash');

  async accountInfo(address: string): Promise<AccountInfo | null> {
    const r = await this.call<{ value: { owner: string; lamports: number; data: [string, string] } | null }>(
      'getAccountInfo',
      [address, { encoding: 'base64', commitment: 'confirmed' }],
    );
    if (!r.value) return null;
    return { owner: r.value.owner, lamports: r.value.lamports, data: fromBase64(r.value.data[0]) };
  }

  /** An SPL token account's balance in base units, or null when the account does not exist. */
  async tokenBalance(address: string): Promise<bigint | null> {
    try {
      const r = await this.call<{ value: { amount: string } }>('getTokenAccountBalance', [
        address,
        { commitment: 'confirmed' },
      ]);
      return BigInt(r.value.amount);
    } catch (e) {
      if (e instanceof SolanaRpcError && /could not find account|Invalid param/i.test(e.message)) return null;
      throw e;
    }
  }

  async balance(address: string): Promise<bigint> {
    const r = await this.call<{ value: number }>('getBalance', [address, { commitment: 'confirmed' }]);
    return BigInt(r.value);
  }

  async latestBlockhash(): Promise<string> {
    const r = await this.call<{ value: { blockhash: string } }>('getLatestBlockhash', [{ commitment: 'confirmed' }]);
    return r.value.blockhash;
  }

  sendTransaction = (wire: Uint8Array) =>
    this.call<string>('sendTransaction', [toBase64(wire), { encoding: 'base64', preflightCommitment: 'confirmed' }]);

  /** `confirmed`, `finalized`, `failed`, or null (not seen yet). */
  async signatureStatus(signature: string): Promise<'confirmed' | 'finalized' | 'failed' | null> {
    const r = await this.call<{ value: ({ confirmationStatus?: string; err: unknown } | null)[] }>(
      'getSignatureStatuses',
      [[signature], { searchTransactionHistory: true }],
    );
    const s = r.value[0];
    if (!s) return null;
    if (s.err) return 'failed';
    return s.confirmationStatus === 'finalized'
      ? 'finalized'
      : s.confirmationStatus === 'confirmed'
        ? 'confirmed'
        : null;
  }

  /** The transaction's program log (I-2: the LOCKC line), or null when it is not available yet. */
  async logMessages(signature: string): Promise<string[] | null> {
    const r = await this.call<{ meta: { logMessages?: string[] | null; err: unknown } | null } | null>(
      'getTransaction',
      [signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0, encoding: 'base64' }],
    );
    return r?.meta?.logMessages ?? null;
  }
}
