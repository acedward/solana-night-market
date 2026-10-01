// What the signing panel lists beside the wallet's text: the facts the CONTRACT enforces for the call
// being approved (AA 00047 P9.S; spec FR-004b; questions Q25 option B′).
//
// Q25 B′: a token's name and decimals are only this site's label; what the circuit binds is the
// exact amount in BASE UNITS and the full 32-byte TOKEN ID (its colour). So for every amount the panel
// shows the base units and the full token id, and the site's reading ("This site labels it:
// 10.000000 twUSDC") marked as the site's. Recipients and deadlines are shown in full too.
//
// The text follows lane P9.C's F3 v2 wallet message (passport `00047-solana-ed25519-arm` @ `b2f1847`,
// plan Evidence log "P9.C client API"): per amount `Base units <n>`, `Token <64 hex>` and
// `This site labels it: <renderDecimal(n, decimals)> <symbol>` (a token the arm cannot show: `<n> ?`;
// a swap's lines start `Give …` / `Get …`); the deadline `Expires YYYY-MM-DD hh:mm:ss UTC`; a
// same-key rotate is "Cancel all open offers / Your key does not change". The site label below is
// computed by the same rule as the client's `renderSiteLabel` and with the same token resolver the
// message builder uses (`ed25519TokenResolver`).
// TODO(P9.I): once vendor/passport is re-pinned to the F3 v2 client, call its `renderSiteLabel` /
// `tokenDisplayFor` directly, and refuse to ask the wallet when an amount fact here does not appear
// verbatim in the signed text (`renderEd25519Message`).

import { deadlineText, type TokenRegistry } from '@nightmarket/core';
import { ed25519TokenResolver, type AuthRequest } from '@nightmarket/core/passport';

import type { CallToAuthorise } from './signing.js';

export type SignFact =
  | {
      kind: 'amount';
      label: string;
      /** The exact amount the contract moves, base units (decimal). */
      baseUnits: string;
      /** The token's full id (its 32-byte colour), 64 hex. */
      tokenId: string;
      /** This site's reading of it, as the F3 v2 wallet line shows it: "10.000000 twUSDC", or
       *  "<base units> ?" for a token the site does not list (or the arm cannot show). */
      siteLabel: string;
      /** Whether the site lists the token (its label has a symbol). */
      listed: boolean;
    }
  | { kind: 'text'; label: string; value: string; mono?: boolean };

export interface SignFacts {
  /** One line: what the call does. */
  title: string;
  facts: SignFact[];
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const norm = (h: string) => h.replace(/^0x/, '').toLowerCase();

/** The F3 v2 client's `renderDecimal`: the base units with `decimals` digits after the point. */
function renderDecimal(value: bigint, decimals: number): string {
  if (decimals === 0) return value.toString();
  const text = value.toString().padStart(decimals + 1, '0');
  return `${text.slice(0, text.length - decimals)}.${text.slice(text.length - decimals)}`;
}

function amountFact(label: string, amount: bigint, colour: string, tokens: TokenRegistry): SignFact {
  const id = norm(colour);
  const t = ed25519TokenResolver(tokens)(id);
  return {
    kind: 'amount',
    label,
    baseUnits: amount.toString(10),
    tokenId: id,
    siteLabel: t ? `${renderDecimal(amount, t.decimals)} ${t.symbol}` : `${amount.toString(10)} ?`,
    listed: !!t,
  };
}

function gatedFacts(r: AuthRequest, tokens: TokenRegistry): SignFacts | null {
  switch (r.op) {
    case 'withdrawShielded':
    case 'withdrawShieldedToContract':
      return {
        title: 'Withdraw private tokens',
        facts: [
          amountFact('Amount', r.amount, hex(r.color), tokens),
          { kind: 'text', label: 'To (coin key)', value: hex(r.recipient), mono: true },
          {
            kind: 'text',
            label: 'Paid from one coin of',
            value: `${r.coin.value.toString(10)} base units`,
            mono: true,
          },
        ],
      };
    case 'withdrawUnshielded':
      return {
        title: 'Withdraw public tokens',
        facts: [
          amountFact('Amount', r.amount, hex(r.color), tokens),
          { kind: 'text', label: 'To (address)', value: hex(r.recipient), mono: true },
        ],
      };
    case 'appendInbox':
      return {
        title: "Save a note in your account's inbox",
        facts: [
          {
            kind: 'text',
            label: 'What it does',
            value: 'Files one note, sealed to your own key, so a backup can restore the coin it describes.',
          },
        ],
      };
    case 'rotateEncKey':
      return {
        title: 'Cancel all open offers',
        facts: [
          {
            kind: 'text',
            label: 'What it does',
            value:
              "Your key does not change; the account's approval counter moves, so every offer or approval signed before can never be used.",
          },
          { kind: 'text', label: 'Encryption key (unchanged)', value: hex(r.newKey), mono: true },
        ],
      };
    default:
      return null;
  }
}

/** The facts for one call, or null when there are none to add (a relay envelope, an unknown call). */
export function signFacts(call: CallToAuthorise, tokens: TokenRegistry): SignFacts | null {
  if (call.kind === 'gated') return gatedFacts(call.request, tokens);
  const p = call.payload;
  return {
    title: call.action === 'take' ? 'Take an offer' : 'Make an offer',
    facts: [
      amountFact('Give', BigInt(p.giveAmount), p.giveColor, tokens),
      amountFact('Get', BigInt(p.wantAmount), p.wantColor, tokens),
      {
        kind: 'text',
        label: 'Expires',
        value: BigInt(p.validUntil) === 0n ? 'never (no expiry)' : deadlineText(p.validUntil),
      },
      { kind: 'text', label: 'Paid from one coin of', value: `${p.coin.value} base units`, mono: true },
    ],
  };
}
