// What the page says when the Solana wallet does not give a usable signature (spec edge cases:
// "Phantom is locked, rejects the request, or gives a signature that isn't Ed25519: a clear message,
// and nothing is proven"; FR-004: Ledger accounts are refused in v1). One place, unit-tested.
//
// Every refusal here happens BEFORE anything is sent to the market: a signature that does not
// verify over the exact bytes the page asked for is never passed on, so nothing is proven with it.

export type WalletErrorKind =
  /** The customer declined in the wallet (EIP-1193-style code 4001, or the wallet's own words). */
  | 'rejected'
  /** The wallet did not answer in time (the page's own timeout). */
  | 'timeout'
  /** The wallet is locked, or the site is no longer connected to it (code 4100 / 4900). */
  | 'locked'
  /** The signature is the Ledger's wrapped form (`\xff"solana offchain"` ‖ …): a hardware account. */
  | 'hardware'
  /** The signature does not verify over the bytes asked for, or is not a 64-byte Ed25519 signature. */
  | 'bad-signature'
  /** The wallet cannot be used here (gone, no message signing, a key the account cannot use). */
  | 'unavailable'
  /** AA 00060 P4.3: the page refused to ask the wallet at all (the site's and the market's token lists
   *  differ, so the market would refuse the signature); the message says why. */
  | 'paused'
  /** Anything else the wallet threw. */
  | 'failed';

export const HARDWARE_NOT_SUPPORTED =
  "Hardware (Ledger) accounts aren't supported yet. Your wallet signed in the Ledger's wrapped form, which a Night Market account cannot verify. Switch to a software account in your wallet and connect again. Nothing was sent.";

const TEXT: Record<Exclude<WalletErrorKind, 'failed' | 'unavailable' | 'timeout' | 'paused'>, string> = {
  rejected: 'You declined the request in your wallet. Nothing was signed, and nothing was sent.',
  locked:
    'Your wallet is locked, or this site is no longer connected to it. Unlock it (or connect again) and try again. Nothing was sent.',
  hardware: HARDWARE_NOT_SUPPORTED,
  'bad-signature':
    'Your wallet returned a signature that does not match the request: it is not an Ed25519 signature over the exact text shown. Nothing was sent. Try again, or use another wallet.',
};

export class WalletError extends Error {
  override name = 'WalletError';
  constructor(
    readonly kind: WalletErrorKind,
    message?: string,
  ) {
    super(message ?? (kind in TEXT ? TEXT[kind as keyof typeof TEXT] : 'The wallet could not complete the request.'));
  }
}

export const timeoutError = (seconds: number) =>
  new WalletError(
    'timeout',
    `Your wallet did not answer within ${seconds} seconds. Open it, approve or decline the pending request, and try again; if it showed no request, just try again. Nothing was sent.`,
  );

/** The wallet's own error (Phantom's `{ code, message }`, a Wallet Standard Error, a string) as a
 *  WalletError with the customer's words. */
export function walletErrorFrom(e: unknown, during: 'connect' | 'sign' = 'sign'): WalletError {
  if (e instanceof WalletError) return e;
  const code =
    e && typeof e === 'object' && 'code' in e && typeof (e as { code: unknown }).code === 'number'
      ? (e as { code: number }).code
      : null;
  const raw =
    typeof e === 'string'
      ? e
      : e && typeof e === 'object' && 'message' in e && typeof (e as { message: unknown }).message === 'string'
        ? (e as { message: string }).message
        : '';
  if (code === 4001 || /reject|denied|declin|cancel/i.test(raw))
    return new WalletError(
      'rejected',
      during === 'connect' ? 'You declined the connection in your wallet. Nothing was shared.' : undefined,
    );
  if (code === 4100 || code === 4900 || /locked|unauthori[sz]ed|not connected|disconnected/i.test(raw))
    return new WalletError('locked');
  const said = raw.trim() ? ` (the wallet said: ${raw.trim().slice(0, 160)})` : '';
  return new WalletError(
    'failed',
    during === 'connect'
      ? `The wallet did not connect${said}.`
      : `The wallet could not sign${said}. Nothing was sent; try again.`,
  );
}

/** `promise`, or a timeout WalletError after `ms` (the wallet's own request may still be open). */
export function withWalletTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(timeoutError(Math.round(ms / 1000))), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
