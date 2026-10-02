// The whole-coin exit, offered ONLY after the market refused a withdrawal because the account used
// up its daily allowance (AA 00047 P11, owner decision Q46 A: "limit at 100. Do not explain in the UI
// until its drained"; the relay's `429 withdraws-daily-cap`, detail `whole-coin-exit`, P11.R).
//
// Past the allowance, the market still pays for ONE withdrawal per token per day that spends a coin
// WHOLE (no change), so funds never get stuck. A shielded withdrawal spends one coin, so the page lists
// this token's coins, each with its whole amount; choosing one withdraws all of it to the same
// recipient. (The page picks the coin by its amount: the smallest coin that covers an amount equal to
// a coin's value is a coin of exactly that value.)

import { confirmedOnChain, formatUnits, type StoredCoin, type TokenRegistry } from '@nightmarket/core';

import { Button, Notice } from '../design/index.js';

export interface WholeCoinExitOffer {
  /** The token's colour (64 hex). */
  color: string;
  /** Where the refused withdrawal was going. */
  recipient: string;
}

/** The coins of a token that a whole-coin withdrawal can spend, largest first. */
export function exitCoins(coins: readonly StoredCoin[], color: string): StoredCoin[] {
  const colour = color.replace(/^0x/, '').toLowerCase();
  return coins
    .filter((c) => !c.spent && !c.pending && c.color === colour && c.mtIndex !== null && confirmedOnChain(c))
    .sort((a, b) => (BigInt(b.value) > BigInt(a.value) ? 1 : BigInt(b.value) < BigInt(a.value) ? -1 : 0));
}

const short = (s: string) => (s.length <= 24 ? s : `${s.slice(0, 14)}…${s.slice(-8)}`);

export function WholeCoinExit({
  offer,
  coins,
  tokens,
  busy,
  onWithdraw,
  onDismiss,
}: {
  offer: WholeCoinExitOffer;
  coins: readonly StoredCoin[];
  tokens: TokenRegistry | null;
  busy: boolean;
  onWithdraw(color: string, amount: bigint, recipient: string): void;
  onDismiss(): void;
}) {
  const token = tokens?.byColour(offer.color);
  const symbol = token?.symbol ?? short(offer.color);
  const list = exitCoins(coins, offer.color);
  return (
    <Notice
      tone="info"
      className="panel-intro"
      data-testid="whole-coin-exit"
      title="You can still withdraw a whole coin"
    >
      <p className="small">
        You have used today&apos;s withdrawals the market pays for. Today you can still withdraw one whole coin of{' '}
        {symbol}: all of it goes to <span className="mono">{short(offer.recipient)}</span>, and nothing is left over.
        Your other tokens stay safe in your account.
      </p>
      {list.length === 0 ? (
        <p className="small muted" data-testid="whole-coin-exit-none">
          This browser holds no confirmed coin of {symbol} to withdraw.
        </p>
      ) : (
        <ul className="check-problems" data-testid="whole-coin-exit-coins">
          {list.map((c) => (
            <li key={c.commitment}>
              <span data-testid="whole-coin-exit-amount" data-raw={c.value}>
                {formatUnits(BigInt(c.value), token?.decimals ?? 0, { minFractionDigits: 2, grouping: true })} {symbol}
              </span>{' '}
              <Button
                size="small"
                variant="secondary"
                disabled={busy}
                data-testid="whole-coin-exit-coin"
                onClick={() => onWithdraw(offer.color, BigInt(c.value), offer.recipient)}
              >
                Withdraw this whole coin
              </Button>
            </li>
          ))}
        </ul>
      )}
      <Button size="small" variant="link" data-testid="whole-coin-exit-dismiss" onClick={onDismiss}>
        Not now
      </Button>
    </Notice>
  );
}
