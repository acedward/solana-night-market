// Plan L-TRD: a swap call's arm-agnostic arguments (the OPEN shape, the coin with its mt_index),
// and the kernel client's two calls for offers (status, publish). The arm's signed challenge over
// these arguments is Track A's (lanes B2/B3).

import { describe, expect, it } from 'vitest';

import { KernelClient } from '../src/market/kernel-client.js';
import { openSwapArgs } from '../src/passport/index.js';
import type { OpenSwapPayload } from '../src/trade.js';

const payload: OpenSwapPayload = {
  giveColor: 'a1'.repeat(32),
  giveAmount: '2000000',
  wantColor: 'b2'.repeat(32),
  wantAmount: '2100000',
  wantNonce: '11'.repeat(32),
  wantEntry: '22'.repeat(192),
  changeEntry: '00'.repeat(192),
  validUntil: '0',
  coin: { nonce: '33'.repeat(32), color: 'a1'.repeat(32), value: '3000000', mtIndex: '9' },
  authNonce: '2',
};

describe('openSwapArgs', () => {
  it('is always the OPEN shape (anyone may take it)', () => {
    const { call, coin } = openSwapArgs(payload);
    expect(call.recipientKind).toBe(0n);
    expect(call.recipient).toEqual(new Uint8Array(32));
    expect(coin.mt_index).toBe(9n);
    expect(call.want.value).toBe(2_100_000n);
  });
});

describe('the kernel client: offer status and publishing', () => {
  const answer = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const client = (f: (url: string, init: RequestInit) => Promise<Response>) =>
    new KernelClient({ baseUrl: 'http://kernel.test', fetch: f, retries: 0, timeoutMs: 1000 });
  const id = 'ab'.repeat(32);

  it('reads a status, and maps an unexpected word to unknown', async () => {
    const seen: string[] = [];
    const k = client(async (url) => {
      seen.push(url);
      return answer(200, { offerId: id, status: url.includes('ab') ? 'consumed' : 'x' });
    });
    expect(await k.offerStatus(id)).toBe('consumed');
    expect(seen[0]).toBe(`http://kernel.test/v1/offers/${id}/status`);
    const odd = client(async () => answer(200, { offerId: id, status: 'weird' }));
    expect(await odd.offerStatus(id)).toBe('unknown');
    const nf = client(async () => answer(200, { offerId: id, status: 'not_found' }));
    expect(await nf.offerStatus(id)).toBe('not_found');
  });

  it('publishes with {"offer": …}; a 409 duplicate counts as accepted; a refusal carries the code', async () => {
    let body = '';
    const ok = client(async (_u, init) => {
      body = String(init.body);
      return answer(200, { success: true, offerId: id });
    });
    expect(await ok.postOffer('swapoffer1xyz')).toMatchObject({ accepted: true, duplicate: false, offerId: id });
    expect(JSON.parse(body)).toEqual({ offer: 'swapoffer1xyz' });
    const dup = client(async () => answer(409, { error: 'DUPLICATE_OFFER', offerId: id, status: 'live' }));
    expect(await dup.postOffer('swapoffer1xyz')).toMatchObject({ accepted: true, duplicate: true });
    const bad = client(async () => answer(400, { error: 'ROOT_UNKNOWN', reason: 'root not synced' }));
    expect(await bad.postOffer('swapoffer1xyz')).toMatchObject({
      accepted: false,
      code: 'ROOT_UNKNOWN',
      reason: 'root not synced',
      status: 400,
    });
  });
});
