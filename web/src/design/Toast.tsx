// Toasts: what just happened, in the corner of the screen (AA 00047 P8.1). A page keeps its own
// message state and renders it as a <Toast>; the toast is portalled into the shell's viewport
// (bottom right on a desktop, under the header on a phone), so it stays in sight wherever the
// customer has scrolled. A success fades out by itself after a while; an error stays until closed.
//
//   <ToastViewport />                                      once, in the shell
//   {message && (
//     <Toast tone="error" onClose={() => setMessage(null)} data-testid="trade-message">
//       {message.text}
//     </Toast>
//   )}
//
// Outside a viewport (a component test) the toast renders where it is.

import { createContext, useContext, useEffect, useState, type HTMLAttributes, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { cx } from './format.js';
import { Icon } from './Icon.js';

const ToastRoot = createContext<HTMLElement | null>(null);

/** How long a success stays up, in ms. */
export const TOAST_SUCCESS_MS = 12_000;

/** The shell's toast area, and the context its toasts portal into. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [root, setRoot] = useState<HTMLElement | null>(null);
  return (
    <ToastRoot.Provider value={root}>
      {children}
      <div className="toast-viewport" ref={setRoot} data-testid="toasts" />
    </ToastRoot.Provider>
  );
}

export type ToastTone = 'success' | 'error' | 'info';

export interface ToastProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  tone?: ToastTone;
  title?: ReactNode;
  /** Close (the ✕ button, and a success's timer). */
  onClose?: () => void;
  /** A success restarts its timer when this changes (the message's text). */
  timerKey?: string;
}

const ICON = { success: 'success', error: 'alert', info: 'info' } as const;

export function Toast({ tone = 'info', title, onClose, timerKey, className, children, ...rest }: ToastProps) {
  const root = useContext(ToastRoot);
  useEffect(() => {
    if (tone !== 'success' || !onClose) return;
    const t = setTimeout(onClose, TOAST_SUCCESS_MS);
    return () => clearTimeout(t);
  }, [tone, onClose, timerKey]);
  const node = (
    <div
      className={cx('toast', `toast-${tone}`, className)}
      role={tone === 'error' ? 'alert' : 'status'}
      data-tone={tone}
      {...rest}
    >
      <Icon name={ICON[tone]} className="toast-icon" />
      <div className="toast-body">
        {title ? <strong className="toast-title">{title}</strong> : null}
        {children}
      </div>
      {onClose ? (
        <button type="button" className="icon-btn" aria-label="Dismiss" onClick={onClose}>
          <Icon name="close" />
        </button>
      ) : (
        <span />
      )}
    </div>
  );
  return root ? createPortal(node, root) : node;
}
