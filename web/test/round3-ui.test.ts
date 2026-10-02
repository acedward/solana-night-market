// AA 00047 P11.A, the page's words and choices for the round-3 items (spec FR-004b "Round 3"):
//   - Q46 A: the withdrawal allowance is worded only from the relay's `withdraws-daily-cap` refusal
//     (P11.R's wire shape: `detail` `whole-coin-exit` or `whole-coin-exit-used`, Retry-After), and the
//     whole-coin exit lists the token's coins a whole withdrawal can spend;
//   - R3-9: the restore's signing facts say it never moves funds; its dialog shows the key's first 16
//     hex digits, exactly what the wallet shows after "New key";
//   - R3-10: a check that fails only because the indexer does not show the deploy yet is a read error
//     (actions wait, it is read again), never a refusal.

import { WHOLE_COIN_EXIT, WITHDRAWS_DAILY_CAP_CODE, registryFor, type StoredCoin } from '@nightmarket/core';
import { restoreEncKeyRequest } from '@nightmarket/core/passport';
import { describe, expect, it } from 'vitest';

import { keyFingerprint } from '../src/account/RestoreKeyDialog.js';
import { exitCoins } from '../src/account/WholeCoinExit.js';
import { checkStateOf } from '../src/chain/ChainContext.js';
import { jobErrorText, relayErrorText } from '../src/relay/messages.js';
import { signFacts } from '../src/wallet/sign-facts.js';

describe('Q46: the allowance in plain words, only from the relay’s refusal', () => {
  it('uses the relay’s wire contract (P11.R, @nightmarket/core withdraw-allowance)', () => {
    expect(WITHDRAWS_DAILY_CAP_CODE).toBe('withdraws-daily-cap');
    expect(WHOLE_COIN_EXIT).toEqual({ open: 'whole-coin-exit', used: 'whole-coin-exit-used' });
  });

  const refusal = (detail: string | undefined, retryAfterSeconds: number | null) =>
    relayErrorText({
      status: 429,
      code: 'withdraws-daily-cap',
      message: 'this account has used its 100 sponsored withdrawals in the last 24 hours',
      ...(detail ? { detail } : {}),
      retryAfterSeconds,
    });

  it('the exit still open: what happened, that nothing moved, the whole-coin exit, and when', () => {
    const t = refusal('whole-coin-exit', 3 * 3600);
    expect(t).toMatch(/^The market pays the network fee for a limited number of withdrawals per account each day/);
    expect(t).toContain("your account has used today's");
    expect(t).toContain('Nothing was sent, and your tokens are safe in your account.');
    expect(t).toContain(
      'You can still withdraw one whole coin of this token today (all of it, so nothing is left over)',
    );
    expect(t).toContain('or withdraw as usual again in about 3 hours.');
    expect(t).not.toContain('100'); // the relay's number is its own setting: the page does not repeat it
  });

  it('the exit used too (or no detail): when withdrawals work again, no exit', () => {
    for (const detail of ['whole-coin-exit-used', undefined]) {
      const t = refusal(detail, 600);
      expect(t).toContain('its one extra withdrawal of this token today as well');
      expect(t).toContain('You can withdraw again in 10 minutes.');
      expect(t).not.toContain('You can still withdraw one whole coin');
    }
  });
});

describe('P11.R’s other new codes, in plain words', () => {
  it('a coin already spent (refused, or a job that failed before proving)', () => {
    const refused = relayErrorText({ status: 409, code: 'coin-spent', message: 'the coin … was already spent' });
    expect(refused).toMatch(/^The coin this pays with was already spent on Midnight, so nothing was proven or sent\./);
    expect(refused).toContain('Refresh your balances and try again');
    expect(jobErrorText({ code: 'coin-spent', message: 'x' }, 'fallback')).toBe(refused);
  });

  it('too many unsettled takes today: wait, the rest still works', () => {
    const t = relayErrorText({ status: 429, code: 'takes-unsettled-cap', message: 'x', retryAfterSeconds: 5 * 3600 });
    expect(t).toContain('Several of your takes in the last 24 hours could not be settled by the exchange');
    expect(t).toContain('Try again in about 5 hours; your other actions still work, and nothing was sent.');
    expect(relayErrorText({ status: 429, code: 'takes-unsettled-cap', message: 'x' })).toContain('Try again in a day');
  });
});

describe('Q46: the whole-coin exit lists the token’s spendable coins, largest first', () => {
  const C = 'c0'.repeat(32);
  const coin = (value: string, over: Partial<StoredCoin> = {}): StoredCoin =>
    ({
      commitment: `${value.padStart(4, '0')}`.padEnd(64, 'a'),
      nonce: value.padEnd(64, '1'),
      color: C,
      value,
      mtIndex: '3',
      spent: false,
      origin: 'inbox',
      inInbox: true,
      ...over,
    }) as StoredCoin;

  it('keeps only unspent, positioned, confirmed, not-pending coins of that token', () => {
    const coins = [
      coin('5'),
      coin('900'),
      coin('70', { spent: true }),
      coin('60', { mtIndex: null }),
      coin('50', { color: 'c1'.repeat(32) }),
      coin('40', { pending: { authNonce: '1', input: { nonce: '00'.repeat(32), color: C, value: '100' }, since: 0 } }),
    ];
    expect(exitCoins(coins, `0x${C.toUpperCase()}`).map((c) => c.value)).toEqual(['900', '5']);
  });
});

describe('R3-9: the restore says it never moves funds, and names the key as the wallet will', () => {
  it('the signing facts', () => {
    const mine = 'ab'.repeat(32);
    const facts = signFacts(
      { kind: 'gated', request: restoreEncKeyRequest({ newKey: mine, authNonce: '5' }), purpose: 'restore-enc-key' },
      registryFor('stagenet'),
      { encKey: 'cd'.repeat(32) },
    );
    expect(facts?.title).toBe('Restore my encryption key');
    const what = facts?.facts[0];
    expect(what?.kind === 'text' ? what.value : '').toContain('It never moves funds.');
  });

  it('the key’s first 16 hex digits', () => {
    expect(keyFingerprint(`0x${'AB'.repeat(32)}`)).toBe('abababababababab');
  });
});

describe('R3-10: "not known yet" is a read error, never a refusal', () => {
  const unknown = {
    code: 'provenance-unknown' as const,
    message: 'Midnight’s indexer does not show how this account was created yet.',
  };

  it('alone: an error the page waits on', () => {
    expect(checkStateOf({ ok: false, useCounter: null, problems: [unknown] }, 5)).toEqual({
      status: 'error',
      message: unknown.message,
    });
  });

  it('with real problems: those, without it', () => {
    const real = { code: 'devices' as const, message: 'two devices' };
    expect(checkStateOf({ ok: false, useCounter: null, problems: [real, unknown] }, 5)).toEqual({
      status: 'failed',
      problems: [real],
      blockHeight: 5,
    });
    expect(checkStateOf({ ok: true, useCounter: 0n, problems: [] }, null)).toEqual({ status: 'ok', blockHeight: 0 });
  });
});
