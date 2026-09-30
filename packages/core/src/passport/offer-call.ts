// One swap call's arguments (plan L-TRD: makes and takes), as the browser builds them and the relay
// rebuilds them from the same payload. The call is the account arm's `open_swap_shielded_with_<arm>`;
// its challenge (and the message the device signs over it) is the arm's, from Track A's client
// (plan A3/A4), plugged in by lanes B2 and B3. The arguments below do not depend on the arm.
//
// Only the OPEN shape is built here (recipient kind 0: anyone may take it), and the coin the give
// is paid from is part of the challenge (AUTH-10), `mt_index` included.

import type { ShieldedCoin, QualifiedCoin } from '../../../../vendor/passport/contract/src/wallet/contract.js';
import { hexToBytes, normaliseHex32 } from '../hex.js';
import type { OpenSwapPayload } from '../trade.js';
import { RECIPIENT_OPEN, type OfferCallArgs } from './vendor/offer-codec.js';

/** The circuit's eight leading arguments and the coin the give is paid from, from a payload. */
export function openSwapArgs(p: OpenSwapPayload): { call: OfferCallArgs; coin: QualifiedCoin } {
  const want: ShieldedCoin = {
    nonce: hexToBytes(normaliseHex32(p.wantNonce), 32),
    color: hexToBytes(normaliseHex32(p.wantColor), 32),
    value: BigInt(p.wantAmount),
  };
  return {
    call: {
      giveColor: hexToBytes(normaliseHex32(p.giveColor), 32),
      giveAmount: BigInt(p.giveAmount),
      recipientKind: RECIPIENT_OPEN,
      recipient: new Uint8Array(32),
      want,
      wantEntry: hexToBytes(p.wantEntry, 192),
      changeEntry: hexToBytes(p.changeEntry, 192),
      validUntil: BigInt(p.validUntil),
    },
    coin: {
      nonce: hexToBytes(normaliseHex32(p.coin.nonce), 32),
      color: hexToBytes(normaliseHex32(p.coin.color), 32),
      value: BigInt(p.coin.value),
      mt_index: BigInt(p.coin.mtIndex),
    },
  };
}
