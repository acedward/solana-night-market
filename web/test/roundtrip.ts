// Security review F-B4: Import accepts only records the page writes. The flow tests call this after
// they ran the page's real operations, so every record those flows write must round-trip through
// Export -> CLEAR ALL -> Import unchanged (a record shape that Import would refuse fails here).

import { expect } from 'vitest';

import type { WalletScope } from '../src/store/schema.js';
import type { LocalStore } from '../src/store/store.js';

const walletKeys = (owner: string) => {
  const out: Record<string, string> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)!;
    if (k.includes(owner.toLowerCase())) out[k] = localStorage.getItem(k)!;
  }
  return out;
};

export function expectImportRoundTrip(store: LocalStore, scope: WalletScope): void {
  const before = walletKeys(scope.owner);
  const file = JSON.parse(JSON.stringify(store.exportWallet(scope))) as unknown;
  store.clearAll();
  const r = store.importWallet(file, scope);
  expect(r.imported).toBe(Object.keys(before).length);
  expect(walletKeys(scope.owner)).toEqual(before);
}
