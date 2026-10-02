// AA 00047 P11.I: the PAGE, headless. The browser's own operations (web/src/passport/operations.ts,
// web/src/trade/operations.ts) run here against the live relay and the live indexer, with the page's own
// chain reader (web/src/chain/indexer.ts: the account's origin, its COMPLETE history decoded with
// ledger-v9, P11.A/P11.B), the page's own store (web/src/store/store.ts over an in-memory Storage that
// is kept in $STATE_DIR between runs, as a browser keeps localStorage between reloads) and the page's
// own signing seam (web/src/wallet/signing.ts `ed25519ActionSigning`) over a throwaway tweetnacl key
// signing in Phantom's scheme. Nothing here re-implements what the page decides: the coins, the
// balances, the pending recovery records and the state of every approval come from the page's code.
//
// The store file holds the account's encryption SECRET (as a browser's localStorage does): it lives
// next to state.json, mode 600, never printed.

import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

import type { DeviceSigner, NetworkName, TokenRegistry } from '@nightmarket/core';

import type { ChainReader } from '../../../web/src/chain/indexer.js';
import type { OperationEnv } from '../../../web/src/passport/operations.js';
import type { AccountRecord } from '../../../web/src/passport/records.js';
import { RelayClient } from '../../../web/src/relay/client.js';
import { LocalStore } from '../../../web/src/store/store.js';
import { ed25519ActionSigning } from '../../../web/src/wallet/signing.js';

/** A `Storage` (the Web Storage API) in memory, saved to a file on `flush` (mode 600). */
export class FileStorage implements Storage {
  private readonly m = new Map<string, string>();
  constructor(private readonly path: string) {
    if (existsSync(path)) {
      const o = JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>;
      for (const [k, v] of Object.entries(o)) this.m.set(k, v);
    }
  }
  get length(): number {
    return this.m.size;
  }
  key(i: number): string | null {
    return [...this.m.keys()][i] ?? null;
  }
  getItem(k: string): string | null {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, String(v));
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
  clear(): void {
    this.m.clear();
  }
  flush(): void {
    writeFileSync(this.path, `${JSON.stringify(Object.fromEntries(this.m))}\n`, { mode: 0o600 });
    chmodSync(this.path, 0o600);
  }
}

export interface HeadlessPage extends OperationEnv {
  storage: FileStorage;
  /** Save the page's store (call after every operation). */
  flush(): void;
}

/**
 * The page for one wallet (`signer`) on `network`: the relay at `relayUrl`, the chain through `chain`
 * (the site's own reader), the store at `storePath`. With `account`, the records a browser that opened
 * that account holds are written first when missing: its encryption key pair (the one the harness
 * generated and registered), the account record (with its registration transactions: R3-10's
 * fallback), the roster hint and an empty coin list.
 */
export function headlessPage(o: {
  network: NetworkName;
  relayUrl: string;
  chain: ChainReader;
  signer: DeviceSigner;
  tokens: TokenRegistry;
  storePath: string;
  account?: { address: string; encSecret: string; encPublic: string; txs?: AccountRecord['txs'] };
}): HeadlessPage {
  const storage = new FileStorage(o.storePath);
  const store = new LocalStore(storage);
  const scope = { network: o.network, owner: o.signer.deviceKey };
  const env: HeadlessPage = {
    relay: new RelayClient(o.relayUrl),
    chain: o.chain,
    store,
    scope,
    signing: ed25519ActionSigning(o.signer, { network: o.network, tokens: o.tokens }),
    storage,
    flush: () => storage.flush(),
  };
  const a = o.account;
  if (a) {
    const account = a.address.replace(/^0x/, '').toLowerCase();
    const has = (kind: 'secret' | 'account' | 'roster' | 'coins') =>
      store
        .list(scope)
        .some((r) => r.parsed.kind === kind && !r.parsed.scope.global && r.parsed.scope.account === account);
    if (!has('secret'))
      store.put(scope, 'secret', { encSecretKey: a.encSecret, encPublicKey: a.encPublic }, { account });
    if (!has('account')) {
      const record: AccountRecord = {
        address: account,
        device: o.signer.deviceKey,
        network: o.network,
        createdAt: Date.now(),
        ...(a.txs ? { txs: a.txs } : {}),
      };
      store.put(scope, 'account', record, { account });
    }
    if (!has('roster')) store.put(scope, 'roster', { useCounter: '0' }, { account });
    if (!has('coins')) store.put(scope, 'coins', [], { account });
    storage.flush();
  }
  return env;
}
