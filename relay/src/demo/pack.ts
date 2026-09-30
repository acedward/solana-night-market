// The demo-token pack, resolved against the market's registry (spec FR-007): each configured
// `SYMBOL:AMOUNT` must name a SHIELDED token with a faucet contract (the mint-test-tokens v2
// `mint(recipient, amount, nonce)`), and its whole-token amount must be a positive number of base
// units that fits the faucet's Uint<64>.

import { parseUnits, type DemoTokenPackItem, type TokenRegistry } from '@nightmarket/core';

export interface ResolvedPackItem extends DemoTokenPackItem {
  /** The faucet (issuer) contract, 64 hex. */
  faucet: string;
  /** The faucet's domain separator (the colour is tokenType(domain, faucet)). */
  domainSeparator: string;
}

export class DemoPackError extends Error {
  override name = 'DemoPackError';
}

const U64_MAX = (1n << 64n) - 1n;

export function resolvePack(
  pack: readonly { symbol: string; amount: string }[],
  registry: TokenRegistry,
): ResolvedPackItem[] {
  return pack.map(({ symbol, amount }) => {
    const t = registry.bySymbol(symbol);
    if (!t) throw new DemoPackError(`demo pack: ${symbol} is not in the ${registry.network} token registry`);
    if (t.privacy !== 'shielded') throw new DemoPackError(`demo pack: ${t.symbol} is not a shielded token`);
    if (!t.contract || !t.domainSeparator) {
      throw new DemoPackError(`demo pack: ${t.symbol} has no faucet contract or domain separator in the registry`);
    }
    let raw: bigint;
    try {
      raw = parseUnits(amount, t.decimals);
    } catch (e) {
      throw new DemoPackError(`demo pack: ${t.symbol} ${amount}: ${(e as Error).message}`);
    }
    if (raw <= 0n || raw > U64_MAX)
      throw new DemoPackError(`demo pack: ${t.symbol} ${amount} is not a mintable amount`);
    return {
      symbol: t.symbol,
      colour: t.midnightColour,
      decimals: t.decimals,
      amount: raw.toString(10),
      faucet: t.contract,
      domainSeparator: t.domainSeparator,
    };
  });
}
