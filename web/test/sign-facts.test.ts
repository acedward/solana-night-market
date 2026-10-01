// AA 00047 P9.S (spec FR-004b, questions Q25 B′): beside the wallet's text, the signing panel lists
// what the CONTRACT enforces for the call: each amount in base units with the token's full id, the
// site's name and decimals marked as only the site's label; recipients and the deadline in full. The
// signing seam announces those facts just before the wallet is asked, and the panel shows them only
// for an account call (never for a relay envelope).

import nacl from 'tweetnacl';
import { bytesToHex, registryFor, type DeviceSigner, type OpenSwapPayload } from '@nightmarket/core';
import { cancelOffersRequest, withdrawRequest, withdrawUnshieldedRequest } from '@nightmarket/core/passport';
import { describe, expect, it } from 'vitest';

import { signFacts, type SignFacts } from '../src/wallet/sign-facts.js';
import { SignPromptStore } from '../src/wallet/sign-prompt.js';
import { ed25519ActionSigning } from '../src/wallet/signing.js';

const tokens = registryFor('stagenet');
const twUSDC = tokens.bySymbol('twUSDC')!.midnightColour;
const twBTC = tokens.bySymbol('twBTC')!.midnightColour;
const UNKNOWN = '99'.repeat(32);

const swap = (over: Partial<OpenSwapPayload> = {}): OpenSwapPayload => ({
  giveColor: twBTC,
  giveAmount: '1000000',
  wantColor: twUSDC,
  wantAmount: '10000000',
  wantNonce: '44'.repeat(32),
  wantEntry: '55'.repeat(192),
  changeEntry: '66'.repeat(192),
  validUntil: '1790868312',
  coin: { nonce: '77'.repeat(32), color: twBTC, value: '10000000', mtIndex: '12' },
  authNonce: '5',
  ...over,
});

describe('signFacts (Q25 B′: base units and token ids; the name is the site’s label)', () => {
  it('lists a make’s legs in base units with the full token ids, and its signed expiry', () => {
    const f = signFacts({ kind: 'swap', action: 'open-swap', payload: swap() }, tokens)!;
    expect(f.title).toBe('Make an offer');
    expect(f.facts).toEqual([
      { kind: 'amount', label: 'You give', baseUnits: '1000000', tokenId: twBTC, siteLabel: '0.01 twBTC' },
      { kind: 'amount', label: 'You get', baseUnits: '10000000', tokenId: twUSDC, siteLabel: '10.00 twUSDC' },
      { kind: 'text', label: 'Expires', value: '2026-10-01 15:25:12 UTC' },
      { kind: 'text', label: 'Paid from one coin of', value: '10000000 base units', mono: true },
    ]);
  });

  it('says a token the site does not list is not listed (the base units and id still show)', () => {
    const f = signFacts({ kind: 'swap', action: 'take', payload: swap({ wantColor: UNKNOWN }) }, tokens)!;
    expect(f.title).toBe('Take an offer');
    expect(f.facts[1]).toEqual({
      kind: 'amount',
      label: 'You get',
      baseUnits: '10000000',
      tokenId: UNKNOWN,
      siteLabel: null,
    });
  });

  it('shows an unsigned deadline as never (the page no longer sends one)', () => {
    const f = signFacts({ kind: 'swap', action: 'open-swap', payload: swap({ validUntil: '0' }) }, tokens)!;
    expect(f.facts[2]).toEqual({ kind: 'text', label: 'Expires', value: 'never (no expiry)' });
  });

  it('lists a withdrawal’s amount and recipient, and a cancel’s unchanged key', () => {
    const w = signFacts(
      {
        kind: 'gated',
        request: withdrawRequest({
          recipient: '22'.repeat(32),
          color: twUSDC,
          amount: '1500000',
          coin: { nonce: '33'.repeat(32), color: twUSDC, value: '5000000', mtIndex: '9' },
          authNonce: '5',
        }),
      },
      tokens,
    )!;
    expect(w.facts.slice(0, 2)).toEqual([
      { kind: 'amount', label: 'You send', baseUnits: '1500000', tokenId: twUSDC, siteLabel: '1.50 twUSDC' },
      { kind: 'text', label: 'To (coin key)', value: '22'.repeat(32), mono: true },
    ]);
    const u = signFacts(
      {
        kind: 'gated',
        request: withdrawUnshieldedRequest({ recipient: '23'.repeat(32), color: twUSDC, amount: '7', authNonce: '5' }),
      },
      tokens,
    )!;
    expect(u.facts[0]).toMatchObject({ baseUnits: '7', tokenId: twUSDC });
    const c = signFacts(
      { kind: 'gated', request: cancelOffersRequest({ newKey: 'ab'.repeat(32), authNonce: '5' }) },
      tokens,
    )!;
    expect(c.title).toBe('Cancel all open offers');
    expect(c.facts[1]).toEqual({
      kind: 'text',
      label: 'Encryption key (unchanged)',
      value: 'ab'.repeat(32),
      mono: true,
    });
  });
});

describe('the facts reach the signing panel only for an account call', () => {
  it('announces the call’s facts just before the wallet is asked, then clears them', async () => {
    const kp = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(3));
    const prompts = new SignPromptStore();
    const seen: Array<SignFacts | null> = [];
    const signer: DeviceSigner = {
      deviceKey: bytesToHex(kp.publicKey),
      address: 'x',
      signMessage: async (m) => {
        const p = prompts.open(m, 'Phantom');
        seen.push(p.facts);
        prompts.close('signed');
        return nacl.sign.detached(m, kp.secretKey);
      },
    };
    const signing = ed25519ActionSigning(signer, { network: 'stagenet', tokens }, undefined, (f) =>
      prompts.setFacts(f),
    );
    const ctx = { account: 'c0'.repeat(32), authNonce: 5n, networkSalt: '71'.repeat(32) };
    await signing.authorise(ctx, { kind: 'swap', action: 'open-swap', payload: swap() }, 0n);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.title).toBe('Make an offer');
    // Cleared after: a relay envelope signed next shows no facts.
    const env = new TextEncoder().encode(
      'Night Market - stagenet\nProve you hold this key\nKey x\nFor y\nNonce ' + '0'.repeat(64),
    );
    expect(prompts.open(env, 'Phantom').facts).toBeNull();
  });
});
