// Badges and pills: short labels that classify a row or a value.
//
//   <Badge tone="green">Active</Badge>               a market's status
//   <NetworkBadge network="midnight" />              "MIDNIGHT" (a network label)
//   <StatusPill status="live">Live</StatusPill>      an offer's or transfer's state, with a dot
//   <NoValue>no buyers</NoValue>                     a value that is deliberately absent
//   <YoursBadge />                                   the account's own offer in a book

import type { HTMLAttributes, ReactNode } from 'react';

import { cx } from './format.js';

// Tone names are kept from the first design: in the dark theme 'navy' is violet, 'gold' amber.
export type BadgeTone = 'navy' | 'gold' | 'grey' | 'green' | 'red';

export function Badge({ tone = 'grey', className, ...rest }: HTMLAttributes<HTMLSpanElement> & { tone?: BadgeTone }) {
  return <span className={cx('tag', `tag-${tone}`, className)} {...rest} />;
}

export function NetworkBadge({
  network,
  onLight = false,
  children,
  className,
  ...rest
}: HTMLAttributes<HTMLSpanElement> & { network: 'midnight'; onLight?: boolean; children?: ReactNode }) {
  return (
    <span className={cx('net', `net-${network}`, onLight && 'net-light', className)} {...rest}>
      {children ?? 'Midnight'}
    </span>
  );
}

export type PillStatus = 'live' | 'filled' | 'done' | 'cancelled' | 'idle' | 'progress' | 'refunded' | 'failed';

export function StatusPill({ status, className, ...rest }: HTMLAttributes<HTMLSpanElement> & { status: PillStatus }) {
  return <span className={cx('status', `st-${status}`, className)} data-status={status} {...rest} />;
}

export function NoValue({ className, ...rest }: HTMLAttributes<HTMLSpanElement>) {
  return <span className={cx('no-value', className)} {...rest} />;
}

export function YoursBadge({ children = 'Your offer', ...rest }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <Badge tone="gold" {...rest}>
      {children}
    </Badge>
  );
}
