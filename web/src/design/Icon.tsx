// Small inline SVG icons (AA 00047 P8.1): drawn with `currentColor`, 24-unit grid, 1.8 px strokes.
// Decorative by default (aria-hidden); the control that holds one carries its own label.
//
//   <Icon name="wallet" />            <Icon name="close" className="x" />

import { useId, type SVGAttributes } from 'react';

const PATHS = {
  markets: 'M4 19V9m5 10V5m5 14v-7m5 7V8',
  trade: 'M7 7h11l-3-3M17 17H6l3 3',
  portfolio:
    'M4 8.5A2.5 2.5 0 0 1 6.5 6h11A2.5 2.5 0 0 1 20 8.5v9a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 17.5zM16 13h.01M4 9h12.5A1.5 1.5 0 0 0 18 7.5V6',
  data: 'M12 4c4.4 0 8 1.3 8 3s-3.6 3-8 3-8-1.3-8-3 3.6-3 8-3zm-8 3v10c0 1.7 3.6 3 8 3s8-1.3 8-3V7M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  wallet: 'M4 7.5A2.5 2.5 0 0 1 6.5 5H18v4M4 7.5v9A2.5 2.5 0 0 0 6.5 19H20V9H6.5A2.5 2.5 0 0 1 4 7.5zM16 14h.01',
  copy: 'M9 9h10v10H9zM5 15V5h10',
  close: 'M6 6l12 12M18 6L6 18',
  check: 'M5 12.5l4.5 4.5L19 7',
  chevron: 'M6 9l6 6 6-6',
  logout: 'M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 16l-4-4 4-4M6 12h10',
  alert: 'M12 8v5m0 3.5h.01M10.3 4.3L2.9 17a2 2 0 0 0 1.7 3h14.8a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0z',
  info: 'M12 11v6m0-9.5h.01M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z',
  success: 'M8 12.5l3 3 5-6M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z',
  spark: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z',
  shield: 'M12 3l7 3v6c0 4.4-3 7.9-7 9-4-1.1-7-4.6-7-9V6z',
  gift: 'M4 11h16v9H4zM3 7h18v4H3zM12 7v13M12 7c-1.5-3-5-3.5-5-1s3.5 1 5 1zm0 0c1.5-3 5-3.5 5-1s-3.5 1-5 1z',
  arrowUp: 'M12 19V5m-6 6l6-6 6 6',
  plus: 'M12 5v14M5 12h14',
  book: 'M5 5h14M5 9.5h9M5 14h14M5 18.5h9',
  clock: 'M12 7v5l3 2M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, ...rest }: SVGAttributes<SVGSVGElement> & { name: IconName }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

/** The Night Market mark: a crescent moon and a star on the brand gradient. */
export function LogoMark({ className = 'logo-mark' }: { className?: string }) {
  const id = `${useId()}-logo`;
  return (
    <svg className={className} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#8b5cf6" />
          <stop offset="0.55" stopColor="#6366f1" />
          <stop offset="1" stopColor="#22d3ee" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill={`url(#${id})`} />
      <path d="M19.6 7.2a7.6 7.6 0 1 0 5.2 11.9 6.2 6.2 0 0 1-5.2-11.9z" fill="#070b14" opacity="0.9" />
      <circle cx="23.6" cy="9.4" r="1.4" fill="#eef1fb" />
    </svg>
  );
}
