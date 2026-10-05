// A MOCK Solana JSON-RPC (AA 00060 P1.5): the calls Night Market's Bridge in and the wallet probe make,
// answered from state the test sets. `sendTransaction` checks every signature of the wire transaction
// (tweetnacl over the message) and refuses a transaction whose blockhash it never handed out (as a node
// on another cluster would); the logs `getTransaction` returns come from `logsFor`, so a test can serve
// the bridge's LOCKC line for the lock it sent.
//
// Methods: getGenesisHash, getAccountInfo (owner, lamports, data as base64), getTokenAccountBalance,
// getBalance, getLatestBlockhash, sendTransaction (base64), getSignatureStatuses, getTransaction,
// getSignaturesForAddress (the sent transactions naming the address, newest first) and getBlockHeight
// (AA 00060 P10.3 C3: the page finds a lock whose wallet answer it lost, or learns its blockhash expired),
// and getTokenAccountsByOwner with a mint filter (P12.1, the Portfolio's Solana line: the token accounts
// of `tokenBalances` that name an owner and a mint, as classic SPL Token accounts in base64).

import { base58 } from '@scure/base';
import nacl from 'tweetnacl';

import { TOKEN_PROGRAM_ID, splitTransaction } from '../../packages/core/src/solana/tx.js';
import { json, type Handler } from './http.js';

export interface MockAccount {
  owner: string;
  lamports?: number;
  data?: Uint8Array;
}

export interface SentTransaction {
  signature: string;
  wire: Uint8Array;
  message: Uint8Array;
  accountKeys: string[];
  /** The slot it was sent at (getSignaturesForAddress answers it). */
  slot?: number;
}

export interface MockSolanaRpc {
  handler: Handler;
  genesisHash: string;
  accounts: Map<string, MockAccount>;
  /** SPL token balances by token-account address: base units and decimals; with `owner` and `mint`,
   *  getTokenAccountsByOwner lists the account too (`program`: its owning program, default SPL Token). */
  tokenBalances: Map<string, { amount: bigint; decimals: number; owner?: string; mint?: string; program?: string }>;
  /** SOL balances in lamports by address. */
  balances: Map<string, number>;
  sent: SentTransaction[];
  /** The program logs `getTransaction` answers for a sent transaction (default none). */
  logsFor: (tx: SentTransaction) => string[];
  /** Every JSON-RPC method called, in order. */
  calls: string[];
  /** Move the block height on by `n` (blockhashes handed out before then expire). */
  advanceBlockHeight(n: number): void;
  /** AA 00060 P10.4 (audit D1): JSON-RPC methods that answer an error (an RPC that cannot be read). */
  failing: Set<string>;
}

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

/** The account keys of a legacy message (header 3 bytes, shortvec count, 32-byte keys). */
function accountKeysOf(message: Uint8Array): string[] {
  let at = 3;
  let n = 0;
  let shift = 0;
  for (;;) {
    const b = message[at++]!;
    n |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
  }
  return Array.from({ length: n }, (_, i) => base58.encode(message.slice(at + 32 * i, at + 32 * (i + 1))));
}

export function mockSolanaRpc(opts: { genesisHash?: string } = {}): MockSolanaRpc {
  const genesisHash = opts.genesisHash ?? base58.encode(new Uint8Array(32).fill(7));
  const handedOut = new Set<string>();
  let slot = 1000;
  const rpc: MockSolanaRpc = {
    genesisHash,
    accounts: new Map(),
    tokenBalances: new Map(),
    balances: new Map(),
    sent: [],
    logsFor: () => [],
    calls: [],
    failing: new Set<string>(),
    advanceBlockHeight(n) {
      slot += n;
    },
    handler: async (req) => {
      const body = (await req.json()) as { id: unknown; method: string; params?: unknown[] };
      rpc.calls.push(body.method);
      const ok = (result: unknown) => json({ jsonrpc: '2.0', id: body.id, result });
      const err = (code: number, message: string) => json({ jsonrpc: '2.0', id: body.id, error: { code, message } });
      if (rpc.failing.has(body.method)) return err(-32005, 'Node is behind (a test failure)');
      const p = body.params ?? [];
      const context = { slot: slot++ };
      switch (body.method) {
        case 'getGenesisHash':
          return ok(genesisHash);
        case 'getLatestBlockhash': {
          const h = base58.encode(nacl.randomBytes(32));
          handedOut.add(h);
          return ok({ context, value: { blockhash: h, lastValidBlockHeight: slot + 150 } });
        }
        case 'getBalance':
          return ok({ context, value: rpc.balances.get(String(p[0])) ?? 0 });
        case 'getAccountInfo': {
          const a = rpc.accounts.get(String(p[0]));
          return ok({
            context,
            value: a
              ? {
                  owner: a.owner,
                  lamports: a.lamports ?? 2_039_280,
                  data: [b64(a.data ?? new Uint8Array()), 'base64'],
                  executable: false,
                  rentEpoch: 0,
                }
              : null,
          });
        }
        case 'getTokenAccountBalance': {
          const t = rpc.tokenBalances.get(String(p[0]));
          if (!t) return err(-32602, 'Invalid param: could not find account');
          const ui = Number(t.amount) / 10 ** t.decimals;
          return ok({
            context,
            value: { amount: t.amount.toString(), decimals: t.decimals, uiAmount: ui, uiAmountString: String(ui) },
          });
        }
        case 'sendTransaction': {
          const wire = new Uint8Array(Buffer.from(String(p[0]), 'base64'));
          let parts;
          try {
            parts = splitTransaction(wire);
          } catch {
            return err(-32602, 'failed to deserialize the transaction');
          }
          const accountKeys = accountKeysOf(parts.message);
          const blockhash = base58.encode(
            parts.message.slice(3 + 1 + 32 * accountKeys.length, 3 + 1 + 32 * accountKeys.length + 32),
          );
          if (!handedOut.has(blockhash)) return err(-32002, 'Transaction simulation failed: Blockhash not found');
          for (let i = 0; i < parts.signatures.length; i++) {
            const key = base58.decode(accountKeys[i]!);
            if (!nacl.sign.detached.verify(parts.message, parts.signatures[i]!, key)) {
              return err(-32003, 'Transaction signature verification failure');
            }
          }
          const signature = base58.encode(parts.signatures[0]!);
          rpc.sent.push({ signature, wire, message: parts.message, accountKeys, slot });
          return ok(signature);
        }
        case 'getBlockHeight':
          return ok(slot);
        case 'getTokenAccountsByOwner': {
          const owner = String(p[0]);
          const mint = (p[1] as { mint?: string } | undefined)?.mint;
          if (!mint) return err(-32602, 'Invalid params: a mint filter is required by this mock');
          const value = [...rpc.tokenBalances.entries()]
            .filter(([, t]) => t.owner === owner && t.mint === mint)
            .map(([pubkey, t]) => {
              const data = new Uint8Array(165);
              data.set(base58.decode(t.mint!), 0);
              data.set(base58.decode(t.owner!), 32);
              new DataView(data.buffer).setBigUint64(64, t.amount, true);
              data[108] = 1; // initialized
              return {
                pubkey,
                account: {
                  owner: t.program ?? TOKEN_PROGRAM_ID,
                  lamports: 2_039_280,
                  data: [b64(data), 'base64'],
                  executable: false,
                  rentEpoch: 0,
                  space: 165,
                },
              };
            });
          return ok({ context, value });
        }
        case 'getSignaturesForAddress': {
          const address = String(p[0]);
          const o = (p[1] as { limit?: number; before?: string } | undefined) ?? {};
          const limit = Number(o.limit ?? 1000);
          const naming = rpc.sent.filter((t) => t.accountKeys.includes(address)).reverse();
          const start = o.before ? naming.findIndex((t) => t.signature === o.before) + 1 : 0;
          return ok(
            naming.slice(start, start + limit).map((t) => ({
              signature: t.signature,
              slot: t.slot ?? slot,
              err: null,
              memo: null,
              blockTime: null,
              confirmationStatus: 'confirmed',
            })),
          );
        }
        case 'getSignatureStatuses': {
          const sigs = (p[0] as string[]) ?? [];
          return ok({
            context,
            value: sigs.map((s) =>
              rpc.sent.some((t) => t.signature === s)
                ? { slot, confirmations: null, err: null, confirmationStatus: 'confirmed' }
                : null,
            ),
          });
        }
        case 'getTransaction': {
          const tx = rpc.sent.find((t) => t.signature === String(p[0]));
          if (!tx) return ok(null);
          return ok({
            slot,
            blockTime: null,
            meta: { err: null, logMessages: rpc.logsFor(tx) },
            transaction: [b64(tx.wire), 'base64'],
          });
        }
        default:
          return err(-32601, `Method not found: ${body.method}`);
      }
    },
  };
  return rpc;
}
