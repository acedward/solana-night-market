// Loading and progress (AA 00047 P8.1).
//
//   <Skeleton width="6em" />                         a shimmering placeholder while a value loads
//   <Spinner />                                      a small spinner (waiting on the wallet)
//   <ProgressBar value={0.4} label="Proving" />      a bar; value undefined = indeterminate
//   <Stepper steps={['Approve', 'Prove', 'Confirm']} current={1} />   a horizontal step indicator
//
// Motion stops under prefers-reduced-motion (base.css); the text next to each one says the same.

import type { CSSProperties } from 'react';

import { cx } from './format.js';
import { Icon } from './Icon.js';

export function Skeleton({ width, line = false, className }: { width?: string; line?: boolean; className?: string }) {
  const style: CSSProperties | undefined = width ? { width } : undefined;
  return <span className={cx('skeleton', line && 'skeleton-line', className)} style={style} aria-hidden="true" />;
}

export function Spinner({ className }: { className?: string }) {
  return <span className={cx('spinner', className)} aria-hidden="true" />;
}

export function ProgressBar({ value, label, ...rest }: { value?: number; label: string; 'data-testid'?: string }) {
  const pct = value === undefined ? undefined : Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <div
      className={cx('progress', pct === undefined && 'progress-indeterminate')}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      {...(pct !== undefined ? { 'aria-valuenow': pct } : {})}
      {...rest}
    >
      <span style={{ width: `${pct ?? 35}%` }} />
    </div>
  );
}

export function Stepper({ steps, current, label }: { steps: readonly string[]; current: number; label: string }) {
  return (
    <ol className="stepper" aria-label={label}>
      {steps.map((s, i) => {
        const state = i < current ? 'done' : i === current ? 'current' : 'pending';
        return (
          <li key={s} className={state} aria-current={state === 'current' ? 'step' : undefined} data-step-state={state}>
            <span className="dot">{state === 'done' ? <Icon name="check" /> : i + 1}</span>
            <span>
              {s}
              <span className="sr-only">
                {state === 'done' ? ' (done)' : state === 'current' ? ' (in progress)' : ' (not started)'}
              </span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}
