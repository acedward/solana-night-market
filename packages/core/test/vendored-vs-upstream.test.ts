// The vendored offer shim (Q18 option B) against the upstream module it copies, on Node, where
// upstream loads. Any drift, in either direction, fails CI: a re-pin that changes upstream
// offer.ts must re-vendor the shim.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { x25519 } from '@noble/curves/ed25519.js';
import { describe, expect, it } from 'vitest';

import * as upOffer from '../../../vendor/passport/contract/src/wallet/offer.js';
import { openInboxEntry } from '../../../vendor/passport/contract/src/wallet/inbox.js';
import { openEntryPortable } from '../src/passport/index.js';
import * as offer from '../src/passport/vendor/offer-codec.js';
import { bytesToHex as hex } from '../src/hex.js';
import { F } from './fixtures/p04-vectors.js';

const upstreamPath = (p: string) => fileURLToPath(new URL(`../../../vendor/passport/contract/${p}`, import.meta.url));

describe('offer-codec.ts vs upstream src/wallet/offer.ts', () => {
  // Upstream sections the shim leaves out: the EVM arm's (1: the OpenSwapShielded EIP-712 type;
  // 6: signing with an `evm` device, AA 00047) and the relay-side ones (3, 4, 5), plus the one
  // function the shim replaces.
  const omitted = new Set([
    // section 1: the OpenSwapShielded EIP-712 type (EVM arm)
    'OPEN_SWAP_PRIMARY_TYPE',
    'OPEN_SWAP_FIELDS',
    'OPEN_SWAP_ENCODE_TYPE',
    'OPEN_SWAP_TYPE_HASH',
    'uint8Word',
    'encodeOpenSwapStruct',
    'openSwapStructHash',
    'openSwapDigest',
    'buildOpenSwapTypedData',
    // section 6: signing with an `evm` device
    'openSwapMessage',
    'openSwapChallenge',
    'signOpenSwapOffer',
    'offerAuthArgs',
    // section 3: the envelope (relay-side)
    'OFFER_MAGIC',
    'sha256Hex',
    'makeTerms',
    'encodeEnvelope',
    'OfferEnvelopeError',
    'decodeEnvelope',
    'writeEnvelope',
    'readEnvelope',
    'offerExpired',
    'offerSecondsLeft',
    // section 4: imbalance reading (relay-side)
    'ImbalanceUnreadableError',
    'shieldedLabel',
    'segmentsOf',
    'readAllImbalances',
    'nonDustDeficits',
    'nonDustSurpluses',
    'makerAttachedDust',
    'OfferPlacementError',
    'expectedPlacement',
    'requirePlacement',
    'legSegmentOf',
    // section 5: the ledger-v9 builder (relay-side) and its re-exports
    'buildOpenSwapOffer',
    'fromHex',
    'toHex',
    'hexToBytes',
    'bytesToHex',
    // replaced by offerInboxEntriesPortable
    'offerInboxEntries',
  ]);

  it('exports the same names, minus the documented omissions and replacements', () => {
    const upstream = Object.keys(upOffer)
      .filter((k) => !omitted.has(k))
      .sort();
    const vendored = Object.keys(offer)
      .filter((k) => k !== 'offerInboxEntriesPortable')
      .sort();
    expect(vendored).toEqual(upstream);
  });

  it('every kept function body is textually the upstream one (except the marked change)', () => {
    const up = readFileSync(upstreamPath('src/wallet/offer.ts'), 'utf8');
    const ours = readFileSync(fileURLToPath(new URL('../src/passport/vendor/offer-codec.ts', import.meta.url)), 'utf8');
    // Upstream section 2, minus the two replaced functions, appears verbatim in ours.
    const start = up.indexOf('/** The surviving change coin of an offer, predicted BEFORE the call.');
    const end = up.indexOf('// 3. The offer envelope');
    expect(start).toBeGreaterThan(0);
    const verbatim = up
      .slice(start, end)
      .replace(/export const freshWantNonce[^\n]*\n/, '')
      .replace(/export function offerInboxEntries\([\s\S]*?\n}\n/, '')
      .replace(/\/\/ ─+\n\/\/ 3\.[\s\S]*$/, '');
    for (const chunk of verbatim.split('\n\n').filter((c) => c.trim() !== '' && !c.trim().startsWith('// ─'))) {
      expect(ours.includes(chunk), chunk.slice(0, 80)).toBe(true);
    }
    const recipients = up.slice(
      up.indexOf('/** Recipient shapes the circuit accepts.'),
      up.indexOf('export const RECIPIENT_CONTRACT_REFUSED = 2n;') +
        'export const RECIPIENT_CONTRACT_REFUSED = 2n;'.length,
    );
    expect(ours.includes(recipients)).toBe(true);
  });

  it('computes identical call arguments, change coins and coin choices', () => {
    const want = { nonce: F.wantNonce, color: F.wantColour, value: F.wantAmount };
    const call = {
      giveColor: F.colour,
      giveAmount: F.giveAmount,
      recipientKind: 1n,
      recipient: new Uint8Array(32).fill(4),
      want,
      wantEntry: new Uint8Array(192).fill(7),
      changeEntry: new Uint8Array(192),
      validUntil: F.validUntil,
    };
    expect(offer.offerCircuitArgs(call)).toEqual(upOffer.offerCircuitArgs(call));
    expect(offer.predictChangeCoin(F.coin, 4n)).toEqual(upOffer.predictChangeCoin(F.coin, 4n));
    expect(offer.predictChangeCoin(F.coin, F.coin.value)).toBeNull();
    expect(() => offer.predictChangeCoin(F.coin, F.coin.value + 1n)).toThrow(RangeError);
    const coins = [{ ...F.coin, value: 5n }, F.coin];
    expect(offer.selectGiveCoin(coins, F.colour, 6n)).toBe(upOffer.selectGiveCoin(coins, F.colour, 6n));
    expect([
      offer.RECIPIENT_OPEN,
      offer.RECIPIENT_NAMED_COIN_KEY,
      offer.RECIPIENT_CONTRACT_REFUSED,
      offer.TTL_CAP_SECONDS,
    ]).toEqual([
      upOffer.RECIPIENT_OPEN,
      upOffer.RECIPIENT_NAMED_COIN_KEY,
      upOffer.RECIPIENT_CONTRACT_REFUSED,
      upOffer.TTL_CAP_SECONDS,
    ]);
    expect(offer.freshWantNonce()).toHaveLength(32);
  });

  it("portable offer entries open with upstream's node:crypto codec, and back", async () => {
    const pk = x25519.getPublicKey(F.encSecretFixed);
    const want = { nonce: F.wantNonce, color: F.wantColour, value: F.wantAmount };
    const change = offer.predictChangeCoin(F.coin, F.giveAmount);
    const ours = await offer.offerInboxEntriesPortable(pk, want, change);
    expect(openInboxEntry(F.encSecretFixed, ours.wantEntry)).toMatchObject({ value: want.value });
    expect(openInboxEntry(F.encSecretFixed, ours.changeEntry)).toMatchObject({ value: change!.value });
    const theirs = upOffer.offerInboxEntries(pk, want, change);
    expect(await openEntryPortable(F.encSecretFixed, theirs.wantEntry)).toMatchObject({ value: want.value });
    const none = await offer.offerInboxEntriesPortable(pk, want, null);
    expect(hex(none.changeEntry)).toBe(hex(upOffer.offerInboxEntries(pk, want, null).changeEntry));
  });
});
