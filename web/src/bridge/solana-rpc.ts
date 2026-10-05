// AA 00060 P7.3: the page's Solana JSON-RPC client (config.json `solana.rpcUrl`): the reads Bridge in
// checks before the wallet is asked, the page's own send for `solana:signTransaction`, and the
// confirmation and the program log it reads the lock nonce from. Browser-safe: fetch only.
//
// P12.1 (spec FR-020): the Portfolio's Solana line, the wallet's SPL balance of a bridged mint
// (`ownerMintBalance`). It reads the SAME configured RPC as Bridge in (whose origin the site's
// Content-Security-Policy `connect-src` must already name), never the RPC injector.

import { base58Key32 } from '@nightmarket/core/bridge';
import { TOKEN_PROGRAM_ID, toBase64 } from '@nightmarket/core/solana';

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

  /**
   * The sum of `owner`'s SPL token accounts of `mint`, in base units (`getTokenAccountsByOwner` with a
   * mint filter). Every account the RPC lists must be a classic SPL Token account (165 bytes) of exactly
   * that mint and owner, and the answer must be a list: anything else throws (the page then says
   * "unavailable"), so a malformed answer is never read as a balance of 0.
   */
  async ownerMintBalance(owner: string, mint: string): Promise<bigint> {
    const ownerKey = base58Key32(owner);
    const mintKey = base58Key32(mint);
    if (!ownerKey || !mintKey) throw new SolanaRpcError('Not a Solana address.');
    const r = await this.call<{ value?: unknown } | null>('getTokenAccountsByOwner', [
      owner,
      { mint },
      { encoding: 'base64', commitment: 'confirmed' },
    ]);
    if (!r || !Array.isArray(r.value)) throw new SolanaRpcError('The Solana RPC answered no list of token accounts.');
    const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
    let sum = 0n;
    for (const item of r.value as unknown[]) {
      const acc = (item as { account?: { owner?: unknown; data?: unknown } } | null)?.account;
      const data = Array.isArray(acc?.data) && typeof acc.data[0] === 'string' ? fromBase64(acc.data[0]) : null;
      if (
        !acc ||
        acc.owner !== TOKEN_PROGRAM_ID ||
        !data ||
        data.length !== 165 ||
        !same(data.subarray(0, 32), mintKey) ||
        !same(data.subarray(32, 64), ownerKey)
      ) {
        throw new SolanaRpcError('The Solana RPC listed a token account of another mint, owner or program.');
      }
      // The SPL Token account layout: mint (32), owner (32), amount u64 little-endian at 64.
      sum += new DataView(data.buffer, data.byteOffset + 64, 8).getBigUint64(0, true);
    }
    return sum;
  }

  async balance(address: string): Promise<bigint> {
    const r = await this.call<{ value: number }>('getBalance', [address, { commitment: 'confirmed' }]);
    return BigInt(r.value);
  }

  async latestBlockhash(): Promise<string> {
    return (await this.latestBlockhashInfo()).blockhash;
  }

  /** A fresh blockhash and the last block height at which a transaction using it can land. */
  async latestBlockhashInfo(): Promise<{ blockhash: string; lastValidBlockHeight: bigint; slot: bigint }> {
    const r = await this.call<{
      context: { slot: number };
      value: { blockhash: string; lastValidBlockHeight: number };
    }>('getLatestBlockhash', [{ commitment: 'confirmed' }]);
    return {
      blockhash: r.value.blockhash,
      lastValidBlockHeight: BigInt(r.value.lastValidBlockHeight),
      slot: BigInt(r.context.slot),
    };
  }

  /** The current block height (AA 00060 P10.3 C3: has a lock's blockhash expired?). */
  async blockHeight(): Promise<bigint> {
    return BigInt(await this.call<number>('getBlockHeight', [{ commitment: 'confirmed' }]));
  }

  /** Signatures of transactions naming `address`, newest first, before `before` when given (C3: a lock
   *  whose wallet answer was lost). */
  async signaturesForAddress(
    address: string,
    limit = 100,
    before?: string,
  ): Promise<{ signature: string; slot: bigint }[]> {
    const r = await this.call<{ signature: string; slot: number }[]>('getSignaturesForAddress', [
      address,
      { limit, commitment: 'confirmed', ...(before ? { before } : {}) },
    ]);
    return r.map((x) => ({ signature: x.signature, slot: BigInt(x.slot) }));
  }

  /** A transaction's wire bytes (base64 encoding), or null when it is not available. */
  async transactionWire(signature: string): Promise<Uint8Array | null> {
    const r = await this.call<{ transaction: [string, string] } | null>('getTransaction', [
      signature,
      { commitment: 'confirmed', maxSupportedTransactionVersion: 0, encoding: 'base64' },
    ]);
    return r?.transaction ? fromBase64(r.transaction[0]) : null;
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
