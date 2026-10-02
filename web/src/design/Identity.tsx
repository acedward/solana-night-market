// Who and what, at a glance (AA 00047 P8.1): a wallet's avatar and a token's icon.
//
//   <Avatar seed={address} />                 a deterministic two-colour disc for a wallet address
//   <TokenIcon symbol="twBTC" />              a coloured disc with the token's initials
//   <PairIcon base="twBTC" quote="twUSDC" />  two overlapping token discs
//
// The colours come from a small hash of the text, so the same wallet or token always looks the
// same; they carry no meaning and are never the only way to tell two things apart (the text is
// always next to them).

import { useId, type CSSProperties } from 'react';

import { cx } from './format.js';

/** FNV-1a over the text: a stable 32-bit number. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function Avatar({ seed, size = 'md', className }: { seed: string; size?: 'md' | 'lg'; className?: string }) {
  const id = useId();
  const h = hash(seed);
  const a = h % 360;
  const b = (a + 60 + ((h >>> 9) % 120)) % 360;
  const cx1 = 8 + ((h >>> 3) % 16);
  const cy1 = 8 + ((h >>> 7) % 16);
  return (
    <svg
      className={cx('avatar', size === 'lg' && 'avatar-lg', className)}
      viewBox="0 0 32 32"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id={`${id}-g`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={`hsl(${a} 80% 62%)`} />
          <stop offset="1" stopColor={`hsl(${b} 75% 45%)`} />
        </linearGradient>
      </defs>
      <circle cx="16" cy="16" r="16" fill={`url(#${id}-g)`} />
      <circle cx={cx1} cy={cy1} r="7" fill="#ffffff" opacity="0.22" />
    </svg>
  );
}

/** The token's initials: "twBTC" → "BTC", "utwUSDC" → "USDC", anything else its first letters. */
const initials = (symbol: string) => symbol.replace(/^u?tw/, '').slice(0, 4) || symbol.slice(0, 4);

export function TokenIcon({ symbol, small = false }: { symbol: string; small?: boolean }) {
  const style = { '--tone': String(hash(symbol.replace(/^u/, '')) % 360) } as CSSProperties;
  const text = initials(symbol);
  return (
    <span
      className={cx('token-icon', small && 'token-icon-sm', text.length > 3 && 'token-icon-long')}
      style={style}
      aria-hidden="true"
    >
      {text}
    </span>
  );
}

/** The pair: the base token's disc, with the quote's small disc on its corner. */
export function PairIcon({ base, quote }: { base: string; quote: string }) {
  return (
    <span className="pair-icon" aria-hidden="true">
      <TokenIcon symbol={base} />
      <span className="pair-quote">
        <TokenIcon symbol={quote} small />
      </span>
    </span>
  );
}
