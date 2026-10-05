// AA 00060 P6.3: the sponsor adds DUST ONLY to a proven, bound transaction and submits it (G-LANDING
// L.6 step 4; AA 00048 `addDustAndSubmit`, sponsor/src/bridge/vault.ts @ e150574). The shielded side is
// already balanced by the landing coin (the page's computed spend); the sponsor's coins are never asked
// for anything but the fee.

import type { SponsorWalletHandle } from '../passport/wallet-provider.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

const errorText = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

export async function addDustAndSubmit(
  handle: SponsorWalletHandle,
  tx: unknown,
  opts: { ttlMs?: number; waitForDustMs?: number; onWait?: () => void } = {},
): Promise<string> {
  const h = handle as Any;
  const ttl = new Date(Date.now() + (opts.ttlMs ?? 120_000));
  const keys = { shieldedSecretKeys: h.shieldedSecretKeys, dustSecretKey: h.dustSecretKey };
  // The wallet's DUST view lags the chain by a sync cycle (../passport/wallet-provider.ts).
  const deadline = Date.now() + (opts.waitForDustMs ?? 600_000);
  let warned = false;
  for (;;) {
    try {
      const recipe = await h.wallet.balanceFinalizedTransaction(tx, keys, { ttl, tokenKindsToBalance: ['dust'] });
      const signed = await h.wallet.signRecipe(recipe, (p: Uint8Array) => h.unshieldedKeystore.signDataAsync(p));
      const merged = await h.wallet.finalizeRecipe(signed);
      return String(await h.wallet.submitTransaction(merged));
    } catch (e) {
      if (!/insufficient funds|could not balance dust/i.test(errorText(e)) || Date.now() >= deadline) throw e;
      if (!warned) opts.onWait?.();
      warned = true;
      await new Promise((r) => setTimeout(r, 5_000));
    }
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */
