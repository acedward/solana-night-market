// The sponsored-withdrawal allowance (AA 00047 P11, audit round 3 R3-2 / F-B3-1, F-A3-4; owner
// decision Q46 A at 100): the wire contract between the relay (relay/src/actions/account-caps.ts)
// and the page.
//
// The market pays every withdrawal's network fee (DUST). Per account it pays for at most
// `WITHDRAWS_DAILY_CAP` withdrawals in any rolling 24 hours (default 100), shielded and unshielded
// together. Past it, ONE whole-coin withdrawal per listed token per rolling 24 hours is still
// accepted, so funds never get stuck:
//   - shielded (`withdraw`): the withdrawal spends its coin whole: `amount` equals `coin.value`, so
//     there is no change (and no change to re-file);
//   - unshielded (`withdraw-unshielded`): an unshielded withdrawal never makes change, so any amount
//     of that token counts as its exit (a whole-balance rule could be broken by anyone depositing a
//     little more of it in between: deposits are permissionless).
// A refusal is HTTP 429 with `Retry-After` and
//   {"error": {"code": "withdraws-daily-cap", "message": "...", "detail": <one of WHOLE_COIN_EXIT>}}
// The page says nothing about the allowance until it sees this code (owner, Q46: "Do not explain in
// the UI until its drained").

/** The error code of a withdrawal refused because the account's daily allowance is used up. */
export const WITHDRAWS_DAILY_CAP_CODE = 'withdraws-daily-cap';

/** The allowance's default (`WITHDRAWS_DAILY_CAP`): sponsored withdrawals per account per day. */
export const WITHDRAWS_DAILY_CAP_DEFAULT = 100;

/** The `detail` of a `withdraws-daily-cap` refusal. */
export const WHOLE_COIN_EXIT = {
  /** This token's whole-coin exit is still open today: a whole-coin withdrawal of it is accepted. */
  open: 'whole-coin-exit',
  /** This token's exit was used in the last 24 hours (or the market does not list the token):
   *  `Retry-After` says when a withdrawal is accepted again. */
  used: 'whole-coin-exit-used',
} as const;
export type WholeCoinExitDetail = (typeof WHOLE_COIN_EXIT)[keyof typeof WHOLE_COIN_EXIT];

/** The actions the allowance covers: every withdrawal the market pays for. */
export const SPONSORED_WITHDRAW_ACTIONS = ['withdraw', 'withdraw-unshielded'] as const;
export type SponsoredWithdrawAction = (typeof SPONSORED_WITHDRAW_ACTIONS)[number];

/**
 * Whether a withdrawal is a whole-coin exit (see the header): a shielded one whose `amount` is its
 * coin's whole `value`, or any unshielded one. Anything malformed is not.
 */
export function isWholeCoinWithdrawal(action: string, payload: Record<string, unknown>): boolean {
  if (action === 'withdraw-unshielded') return true;
  if (action !== 'withdraw') return false;
  const coin = payload.coin as { value?: unknown } | undefined;
  const amount = payload.amount;
  if (typeof amount !== 'string' || typeof coin?.value !== 'string') return false;
  if (!/^[0-9]{1,40}$/.test(amount) || !/^[0-9]{1,40}$/.test(coin.value)) return false;
  return BigInt(amount) === BigInt(coin.value) && BigInt(amount) > 0n;
}
