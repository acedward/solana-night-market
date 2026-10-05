// AA 00060 P8 (spec US3, FR-012): "Show in my wallet", the page's side of I-4 (FROZEN by 00059 @ f4d215c).
//
//   checkInjector     `GET /api/accounts/registration-info` on the CONFIGURED injector; its origin must be
//                     the configured URL's own, and its network the site's, or the page refuses (the text
//                     binds both, and the wallet's custom RPC is that origin)
//   registerAccount   renders the v1 text itself (core injector.ts) with an expiry inside the injector's
//                     window, asks the wallet ONCE (ActionSigning.rpcRegistration checks the signature),
//                     then ONE `POST /api/accounts` to the configured injector with the five fields: the
//                     only request that carries the viewing key (T8.6). Never retried by the page.
//   readRegistrationStatus  `GET /api/accounts/:id` (the id is derived, nothing is stored); null on 404
//
// The viewing key is the account's X25519 inbox secret from this browser's record: it opens the inbox
// notes (balances and history) and can spend nothing (every spend needs the wallet's signature).

import {
  InjectorError,
  injectorOrigin,
  postRegistration,
  readRegistration,
  readRegistrationInfo,
  registrationExpiresAt,
  registrationId,
  type RegistrationErrorCode,
  type RegistrationInfo,
  type RegistrationView,
} from '@nightmarket/core/bridge';

import type { ActionSigning } from '../../wallet/signing.js';

export class RegistrationRefused extends Error {
  override name = 'RegistrationRefused';
}

export interface RegistrationContext {
  /** config.json `injector.url`. */
  injectorUrl: string;
  /** The site's Midnight network id (PROFILES[network].midnightNetworkId). */
  midnightNetworkId: string;
  /** The connected wallet (base58) and its market account (64 hex). */
  wallet: string;
  account: string;
  fetchImpl?: typeof fetch;
}

/** Plain words for each I-4 code (T8.3). */
export const REGISTRATION_ERROR_TEXT: Readonly<Record<RegistrationErrorCode | 'unreachable' | 'unknown', string>> = {
  malformed: 'The RPC could not read the registration.',
  'bad-solana-address': 'The RPC did not accept your wallet address.',
  'bad-account-address': 'The RPC did not accept your account address.',
  'bad-viewing-key': "The RPC did not accept your account's viewing key.",
  'bad-message': 'The RPC did not accept the signed text.',
  'message-mismatch': 'The signed text names another wallet or account than the registration.',
  'wrong-origin': 'The signed text names another RPC than the one it was sent to.',
  'wrong-network': 'The RPC is on another Midnight network than your account.',
  expired: 'The signed text expired before the RPC read it. Check your computer’s clock, then try again.',
  'expiry-too-far': 'The signed text expires later than the RPC allows. Check your computer’s clock, then try again.',
  'bad-signature': 'The RPC could not verify your wallet’s signature.',
  'indexer-unavailable': 'The RPC cannot read Midnight right now. Try again later.',
  'account-not-found': 'The RPC cannot find your account on Midnight.',
  'not-passport-account': 'The RPC does not recognise your account as a Night Market account.',
  'not-a-device': 'The RPC says your wallet is not a device of this account.',
  'enc-key-mismatch': "The RPC says the viewing key does not match your account's encryption key on Midnight.",
  'storage-error': 'The RPC could not save the registration. Try again later.',
  'accounts-disabled': 'This RPC does not accept account registrations.',
  'not-found': 'The RPC has no registration for this account.',
  'method-not-allowed': 'The RPC refused the request.',
  unreachable: 'The RPC cannot be reached.',
  unknown: 'The RPC answered something this page does not understand.',
};

export const registrationErrorText = (e: unknown): string =>
  e instanceof RegistrationRefused
    ? e.message
    : e instanceof InjectorError
      ? REGISTRATION_ERROR_TEXT[e.code]
      : e instanceof Error
        ? e.message
        : 'Something went wrong.';

const reach = async <T>(p: Promise<T>): Promise<T> => {
  try {
    return await p;
  } catch (e) {
    if (e instanceof InjectorError) throw e;
    throw new InjectorError('the injector cannot be reached', 'unreachable');
  }
};

/** The configured injector's registration info, checked against the site's own config. */
export async function checkInjector(ctx: RegistrationContext): Promise<RegistrationInfo> {
  const origin = injectorOrigin(ctx.injectorUrl);
  if (!origin) throw new RegistrationRefused("This site's RPC address is not valid.");
  const info = await reach(readRegistrationInfo(ctx.injectorUrl, ctx.fetchImpl));
  if (info.origin !== origin) {
    throw new RegistrationRefused(
      `The RPC at ${origin} says it is ${info.origin}. Night Market registers your account only with the RPC this site names.`,
    );
  }
  if (info.networkId !== ctx.midnightNetworkId) {
    throw new RegistrationRefused(
      `The RPC is for the Midnight network ${info.networkId}, not this site's (${ctx.midnightNetworkId}).`,
    );
  }
  return info;
}

/** One signature, then one POST (with the viewing key) to the configured injector. */
export async function registerAccount(
  ctx: RegistrationContext,
  info: RegistrationInfo,
  signing: Pick<ActionSigning, 'rpcRegistration'>,
  viewingKey: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<RegistrationView> {
  if (!signing.rpcRegistration) throw new RegistrationRefused('This wallet connection cannot sign the registration.');
  if (!/^[0-9a-f]{64}$/.test(viewingKey))
    throw new RegistrationRefused("This browser does not hold the account's key.");
  const { message, signature } = await signing.rpcRegistration({
    origin: info.origin,
    networkId: info.networkId,
    solanaAddress: ctx.wallet,
    accountAddress: ctx.account,
    expires: registrationExpiresAt(nowSeconds, info.maxTtlSeconds),
  });
  return reach(
    postRegistration(
      ctx.injectorUrl,
      { solanaAddress: ctx.wallet, accountAddress: ctx.account, accountViewingKey: viewingKey, message, signature },
      ctx.fetchImpl,
    ),
  );
}

/** The registration's status, or null when the injector has none for this wallet and account. */
export async function readRegistrationStatus(ctx: RegistrationContext): Promise<RegistrationView | null> {
  try {
    return await reach(readRegistration(ctx.injectorUrl, registrationId(ctx.wallet, ctx.account), ctx.fetchImpl));
  } catch (e) {
    if (e instanceof InjectorError && e.code === 'not-found') return null;
    throw e;
  }
}
