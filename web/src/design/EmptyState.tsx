// An empty state: what is missing, why, and the one thing to do about it.
//
//   <EmptyState title="Connect your wallet" action={<Button …>Connect wallet</Button>}>
//     Connect your wallet to see your holdings and your Night Market account.
//   </EmptyState>

import type { HTMLAttributes, ReactNode } from 'react';

import { cx } from './format.js';
import { Icon, type IconName } from './Icon.js';

export function EmptyState({
  title,
  action,
  icon,
  className,
  children,
  ...rest
}: Omit<HTMLAttributes<HTMLDivElement>, 'title'> & { title?: ReactNode; action?: ReactNode; icon?: IconName }) {
  return (
    <div className={cx('empty-state', className)} {...rest}>
      {icon ? (
        <span className="empty-icon">
          <Icon name={icon} />
        </span>
      ) : null}
      {title ? <h3 className="empty-title">{title}</h3> : null}
      {children ? <div className="empty-body">{children}</div> : null}
      {action ? <div className="empty-action">{action}</div> : null}
    </div>
  );
}
