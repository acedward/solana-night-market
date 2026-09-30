// A gated call's arm-agnostic half: the call context and each action body's AuthRequest, in the
// pinned Passport client's shapes, bound to the exact coin (mt_index included); and the device's
// use counter, found through the arm's entry derivation (a fake one here: the Ed25519 arm's comes
// from Track A's client, lanes B2/B3).

import { describe, expect, it } from 'vitest';

import type { WithdrawPayload } from '../src/accounts.js';
import { appendInboxRequest, callContext, findUseCounter, withdrawRequest } from '../src/passport/index.js';

const ACCOUNT = '5e'.repeat(32);
const payload: WithdrawPayload = {
  recipient: '11'.repeat(32),
  color: '22'.repeat(32),
  amount: '1500000',
  coin: { nonce: '33'.repeat(32), color: '22'.repeat(32), value: '5000000', mtIndex: '42' },
  authNonce: '3',
};
const bytes = (hex: string) => Uint8Array.from(hex.match(/../g)!.map((b) => parseInt(b, 16)));

describe('gated call arguments', () => {
  it("the call context is the account, the auth nonce and the account's network salt (the Ed25519 arm binds it)", () => {
    const cc = callContext({
      account: `0x${ACCOUNT.toUpperCase()}`,
      authNonce: 3n,
      networkSalt: `0x${'AB'.repeat(32)}`,
    });
    expect(cc).toEqual({ contractAddress: bytes(ACCOUNT), authNonce: 3n, evmDomainSalt: bytes('ab'.repeat(32)) });
    expect(() => callContext({ account: ACCOUNT, authNonce: 3n, networkSalt: 'ab' })).toThrow();
  });

  it('a withdrawal binds the recipient, the amount and the exact coin', () => {
    expect(withdrawRequest(payload)).toEqual({
      op: 'withdrawShielded',
      recipient: bytes('11'.repeat(32)),
      color: bytes('22'.repeat(32)),
      amount: 1_500_000n,
      coin: { nonce: bytes('33'.repeat(32)), color: bytes('22'.repeat(32)), value: 5_000_000n, mt_index: 42n },
    });
  });

  it('an inbox append carries its 192-byte entry, and nothing else', () => {
    const entry = 'ab'.repeat(192);
    expect(appendInboxRequest({ entry, authNonce: '0' })).toEqual({ op: 'appendInbox', entry: bytes(entry) });
    expect(() => appendInboxRequest({ entry: 'ab'.repeat(191), authNonce: '0' })).toThrow();
  });
});

describe('the device use counter (MIP-0013 S11)', () => {
  // A stand-in for the arm's `derive_device_entry`: any injective function of the counter will do.
  const entryAt = (device: string) => (counter: bigint) => `${device}${counter.toString(16).padStart(8, '0')}`;
  const mine = entryAt('77'.repeat(28));

  it('finds the counter whose entry is live, from a hint or by scanning', () => {
    const live = [mine(5n), 'ff'.repeat(32)];
    expect(findUseCounter(live, mine)).toBe(5n);
    expect(findUseCounter(live, mine, 5n)).toBe(5n);
    expect(findUseCounter(live, mine, 9n)).toBe(5n); // a stale-high hint still resolves
    expect(
      findUseCounter(
        live.map((e) => e.toUpperCase()),
        mine,
      ),
    ).toBe(5n);
    expect(findUseCounter(live, entryAt('78'.repeat(28)))).toBeNull(); // another device
    expect(findUseCounter(live, mine, 0n, 5n)).toBeNull(); // beyond the scan limit
  });
});
