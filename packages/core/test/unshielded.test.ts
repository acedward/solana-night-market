// AA 00047 lane B2: the unshielded side's wire contract (../src/unshielded.ts): `mn_addr` addresses
// and the balances read's shape.

import { bech32m } from '@scure/base';
import { describe, expect, it } from 'vitest';

import {
  UnshieldedAddressError,
  UnshieldedBalancesViewSchema,
  formatUnshieldedAddress,
  parseUnshieldedAddress,
  unshieldedBalancesPath,
} from '../src/unshielded.js';

const USER = '5a'.repeat(32);

describe('unshielded wallet addresses (mn_addr_…)', () => {
  it('round-trips a 32-byte user address, per network', () => {
    for (const network of ['stagenet', 'undeployed', 'mainnet']) {
      const text = formatUnshieldedAddress(USER, network);
      expect(text.startsWith(network === 'mainnet' ? 'mn_addr1' : `mn_addr_${network}1`)).toBe(true);
      expect(parseUnshieldedAddress(`  ${text} `, network)).toBe(USER);
    }
  });

  it('refuses another network, a shielded address, a wrong length and non-addresses', () => {
    expect(() => parseUnshieldedAddress(formatUnshieldedAddress(USER, 'stagenet'), 'undeployed')).toThrow(
      /for the stagenet network, not undeployed/,
    );
    const shielded = bech32m.encode('mn_shield-addr_stagenet', bech32m.toWords(new Uint8Array(64)), false);
    expect(() => parseUnshieldedAddress(shielded, 'stagenet')).toThrow(/not an unshielded wallet address/);
    const short = bech32m.encode('mn_addr_stagenet', bech32m.toWords(new Uint8Array(31)), false);
    expect(() => parseUnshieldedAddress(short, 'stagenet')).toThrow(/wrong length/);
    expect(() => parseUnshieldedAddress('hello', 'stagenet')).toThrow(UnshieldedAddressError);
  });
});

describe('the balances read', () => {
  it('has its path and shape', () => {
    expect(unshieldedBalancesPath('ab'.repeat(32))).toBe(`/v1/accounts/${'ab'.repeat(32)}/unshielded`);
    const view = {
      account: 'ab'.repeat(32),
      balances: [{ colour: 'cd'.repeat(32), amount: '1500000' }],
      blockHeight: 9,
    };
    expect(UnshieldedBalancesViewSchema.parse(view)).toEqual(view);
    expect(UnshieldedBalancesViewSchema.safeParse({ ...view, balances: [{ colour: 'x', amount: '1' }] }).success).toBe(
      false,
    );
  });
});
