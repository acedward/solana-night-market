// AA 00060 P8 (T8.1, T8.3, T8.6 at the unit level): "Show in my wallet" against the mock injector
// (test/mocks/injector.ts, I-4 FROZEN by 00059 @ f4d215c) with a software wallet (tweetnacl) behind the
// page's own signing seam (ed25519ActionSigning.rpcRegistration).

import nacl from 'tweetnacl';
import { describe, expect, it } from 'vitest';

import { bytesToHex, registryFor, solanaAddressOf, type DeviceSigner } from '@nightmarket/core';
import {
  REGISTRATION_ERROR_CODES,
  REGISTRATION_FIRST_LINE,
  registrationId,
  registrationMessageText,
} from '@nightmarket/core/bridge';

import {
  REGISTRATION_ERROR_TEXT,
  RegistrationRefused,
  checkInjector,
  readRegistrationStatus,
  registerAccount,
  registrationErrorText,
  type RegistrationContext,
} from '../src/bridge/rpc/operations.js';
import { messageKind } from '../src/wallet/sign-prompt.js';
import { EnvelopeSignatureError, ed25519ActionSigning } from '../src/wallet/signing.js';
import { asFetch } from '../../test/mocks/http.js';
import { mockInjector } from '../../test/mocks/injector.js';

const ACCOUNT = '45'.repeat(32);
const VIEWING_KEY = '77'.repeat(32);
const ORIGIN = 'http://127.0.0.1:18899';
const display = { network: 'stagenet', tokens: registryFor('stagenet') } as const;

function setup(opts: { signWith?: 'own' | 'other'; injectorOrigin?: string; networkId?: string } = {}) {
  const kp = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(4));
  const other = nacl.sign.keyPair();
  const address = solanaAddressOf(bytesToHex(kp.publicKey));
  const asked: string[] = [];
  const signer: DeviceSigner = {
    deviceKey: bytesToHex(kp.publicKey),
    address,
    signMessage: async (m) => {
      asked.push(new TextDecoder().decode(m));
      return nacl.sign.detached(m, (opts.signWith === 'other' ? other : kp).secretKey);
    },
  };
  const inj = mockInjector({ origin: opts.injectorOrigin ?? ORIGIN, networkId: opts.networkId ?? 'undeployed' });
  const requests: { url: string; method: string; body: string | null }[] = [];
  const handler = asFetch(inj.handler);
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), method: init?.method ?? 'GET', body: (init?.body as string) ?? null });
    return handler(input, init);
  }) as typeof fetch;
  const ctx: RegistrationContext = {
    injectorUrl: `${ORIGIN}/`,
    midnightNetworkId: 'undeployed',
    wallet: address,
    account: ACCOUNT,
    fetchImpl,
  };
  return { ctx, inj, signing: ed25519ActionSigning(signer, display), asked, requests, address };
}

describe('P8 Show in my wallet: one signature, one registration (FR-012)', () => {
  it('T8.1 the body is I-4’s five fields exactly, and the text is I-4’s for these inputs', async () => {
    const s = setup();
    const now = s.inj.now();
    const info = await checkInjector(s.ctx);
    const view = await registerAccount(s.ctx, info, s.signing, VIEWING_KEY, now);
    expect(view).toMatchObject({ status: 'synced', created: true, id: registrationId(s.address, ACCOUNT) });
    expect(s.asked).toHaveLength(1);
    const text = registrationMessageText({
      origin: ORIGIN,
      networkId: 'undeployed',
      solanaAddress: s.address,
      accountAddress: ACCOUNT,
      expires: now + 540,
    });
    expect(s.asked[0]).toBe(text);
    expect(s.inj.posts).toHaveLength(1);
    const body = s.inj.posts[0] as Record<string, string>;
    expect(Object.keys(body).sort()).toEqual(
      ['accountAddress', 'accountViewingKey', 'message', 'signature', 'solanaAddress'].sort(),
    );
    expect(body).toMatchObject({
      solanaAddress: s.address,
      accountAddress: ACCOUNT,
      accountViewingKey: VIEWING_KEY,
      message: text,
    });
    expect(body.signature).toMatch(/^[0-9a-f]{128}$/);
    // T8.6 (unit): the viewing key is in exactly one request, a POST to the configured origin.
    const carrying = s.requests.filter((r) => `${r.url} ${r.body ?? ''}`.includes(VIEWING_KEY));
    expect(carrying).toEqual([{ url: `${ORIGIN}/api/accounts`, method: 'POST', body: JSON.stringify(body) }]);
    expect(s.requests.every((r) => r.url.startsWith(`${ORIGIN}/`))).toBe(true);
  });

  it('the status: synced, stale-key, and none for an unregistered account', async () => {
    const s = setup();
    expect(await readRegistrationStatus(s.ctx)).toBeNull();
    await registerAccount(s.ctx, await checkInjector(s.ctx), s.signing, VIEWING_KEY);
    s.inj.setStatus('syncing', 2);
    expect(await readRegistrationStatus(s.ctx)).toMatchObject({ status: 'syncing', unseenCoins: 2 });
    s.inj.setStatus('stale-key');
    expect((await readRegistrationStatus(s.ctx))?.status).toBe('stale-key');
  });

  it('an injector that claims another origin or network: refused before the wallet is asked', async () => {
    const a = setup({ injectorOrigin: 'http://elsewhere.test:1' });
    await expect(checkInjector(a.ctx)).rejects.toBeInstanceOf(RegistrationRefused);
    const b = setup({ networkId: 'stagenet' });
    await expect(checkInjector(b.ctx)).rejects.toThrow(/Midnight network stagenet, not this site's \(undeployed\)/);
    expect(a.asked).toEqual([]);
    expect(b.asked).toEqual([]);
    expect(a.inj.posts).toEqual([]);
  });

  it('T8.3 every I-4 code has plain words; a refusal is not retried', async () => {
    for (const code of REGISTRATION_ERROR_CODES) {
      expect(REGISTRATION_ERROR_TEXT[code], code).toMatch(/^[A-Z]/);
    }
    for (const code of ['bad-signature', 'not-a-device', 'wrong-network', 'enc-key-mismatch'] as const) {
      const s = setup();
      s.inj.failNext(code);
      const err = await registerAccount(s.ctx, await checkInjector(s.ctx), s.signing, VIEWING_KEY).then(
        () => null,
        (e: unknown) => e,
      );
      expect(registrationErrorText(err), code).toBe(REGISTRATION_ERROR_TEXT[code]);
      expect(s.inj.posts, code).toHaveLength(1);
      expect(s.asked, code).toHaveLength(1);
    }
    const down = { ...setup().ctx, fetchImpl: (async () => Promise.reject(new TypeError('down'))) as typeof fetch };
    const e = await checkInjector(down).catch((x: unknown) => x);
    expect(registrationErrorText(e)).toBe('The RPC cannot be reached.');
  });

  it('the signing seam renders the text itself, and refuses another wallet or a signature that does not verify', async () => {
    const s = setup();
    const fields = {
      origin: ORIGIN,
      networkId: 'undeployed',
      solanaAddress: s.address,
      accountAddress: ACCOUNT,
      expires: 1_900_000_000,
    };
    await expect(
      s.signing.rpcRegistration!({ ...fields, solanaAddress: '11111111111111111111111111111111' }),
    ).rejects.toBeInstanceOf(EnvelopeSignatureError);
    expect(s.asked).toEqual([]);
    const bad = setup({ signWith: 'other' });
    await expect(bad.signing.rpcRegistration!({ ...fields, solanaAddress: bad.address })).rejects.toBeInstanceOf(
      EnvelopeSignatureError,
    );
    await expect(
      registerAccount(bad.ctx, await checkInjector(bad.ctx), bad.signing, VIEWING_KEY),
    ).rejects.toBeInstanceOf(EnvelopeSignatureError);
    expect(bad.inj.posts).toEqual([]);
  });

  it("the signing panel classifies I-4's text as rpc-registration, and every other text as before", () => {
    const s = setup();
    const text = registrationMessageText({
      origin: ORIGIN,
      networkId: 'undeployed',
      solanaAddress: s.address,
      accountAddress: ACCOUNT,
      expires: 1_900_000_000,
    });
    expect(text.split('\n')[0]).toBe(REGISTRATION_FIRST_LINE);
    expect(messageKind(text)).toBe('rpc-registration');
    expect(messageKind('Night Market - local\nProve you hold this key\n')).toBe('relay-envelope');
    expect(messageKind('Site: Night Market - local    \nWithdraw\n')).toBe('account-call');
  });
});
