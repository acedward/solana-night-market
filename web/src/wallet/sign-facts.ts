// What the signing panel lists beside the wallet's text: the facts the CONTRACT enforces for the call
// being approved (AA 00047 P9.S/P9.I; spec FR-004b; questions Q25 option B′, Q32).
//
// Q25 B′: a token's name and decimals are only this site's label; what the circuit binds is the
// exact amount in BASE UNITS and the full 32-byte TOKEN ID (its colour). So for every amount the panel
// shows the base units and the full token id, and the site's reading ("This site labels it:
// 10.000000 twUSDC") marked as the site's. Recipients and deadlines are shown in full too.
//
// Every value here comes from the pinned F3 v2 client itself (vendor/passport @ b2f1847:
// `renderUnits`, `renderSiteLabel`, `tokenDisplayFor`, `renderDeadline`), with the same token
// resolver the message builder uses (`ed25519TokenResolver`), so the panel and the wallet's text
// cannot drift apart. And each fact names the LINES of the wallet's text it stands for (`signed`):
// ./signing.ts refuses to ask the wallet when any of them is not, verbatim, a line of the bytes the
// wallet is about to sign (`missingFromSignedText`), so the panel never shows a fact the signature
// does not carry. Facts with no `signed` line (the coin a spend pays from, what a call does) are
// bound by the message's digest, not by a readable line, and the panel says so.
//
// The lines must be there IN ORDER (AA 00047 P10, audit round 2 R2-9): the operation line is the
// text's second line (its first is the site's label, never matched), and every fact's lines follow
// it in the order the panel lists them, so a swap's "This site labels it:" line for what it gives is
// the one after the give's token line, not the get's.

import { bytesToHex, hexToBytes, type TokenRegistry } from '@nightmarket/core';
import {
  UNKNOWN_TOKEN,
  ed25519TokenResolver,
  renderDeadline,
  renderSiteLabel,
  renderUnits,
  tokenDisplayFor,
  type AuthRequest,
} from '@nightmarket/core/passport';

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
      /** The wallet text's lines this fact stands for (trailing spaces trimmed). */
      signed: string[];
    }
  | {
      kind: 'text';
      label: string;
      value: string;
      mono?: boolean;
      /** The wallet text's lines this fact stands for (trailing spaces trimmed); empty when the fact
       *  is bound by the message's digest only (not a readable line). */
      signed: string[];
    };

export interface SignFacts {
  /** One line: what the call does. */
  title: string;
  /** The operation line of the wallet's text (its second line), e.g. "Withdraw shielded". */
  signedTitle: string;
  facts: SignFact[];
}

const norm = (h: string) => h.replace(/^0x/, '').toLowerCase();
/** The 8-byte fingerprint the F3 text shows for a recipient, a note or a key: 16 hex. */
const fp8 = (h: string) => norm(h).slice(0, 16);

/** An amount fact, with the three wallet lines it stands for. `role` is the F3 v2 line prefix: none
 *  for a withdrawal ("Base units …", "Token …"), "Give"/"Get" for a swap's legs. */
function amountFact(
  label: string,
  amount: bigint,
  colour: string,
  tokens: TokenRegistry,
  role?: 'Give' | 'Get',
): SignFact {
  const id = norm(colour);
  const shown = tokenDisplayFor(ed25519TokenResolver(tokens), hexToBytes(id, 32));
  const siteLabel = renderSiteLabel(amount, shown);
  const units = renderUnits(amount);
  return {
    kind: 'amount',
    label,
    baseUnits: units,
    tokenId: id,
    siteLabel,
    listed: shown !== UNKNOWN_TOKEN,
    signed: [
      role ? `${role} base units ${units}` : `Base units ${units}`,
      role ? `${role} token ${id}` : `Token ${id}`,
      `This site labels it: ${siteLabel}`,
    ],
  };
}

function gatedFacts(
  r: AuthRequest,
  tokens: TokenRegistry,
  purpose: 'restore-enc-key' | undefined,
  currentKey: string | undefined,
): SignFacts | null {
  switch (r.op) {
    case 'withdrawShielded':
    case 'withdrawShieldedToContract': {
      const toContract = r.op === 'withdrawShieldedToContract';
      const recipient = bytesToHex(r.recipient);
      return {
        title: 'Withdraw private tokens',
        signedTitle: toContract ? 'Withdraw to contract' : 'Withdraw shielded',
        facts: [
          amountFact('Amount', r.amount, bytesToHex(r.color), tokens),
          {
            kind: 'text',
            label: toContract ? 'To (contract)' : 'To (coin key)',
            value: recipient,
            mono: true,
            signed: [`${toContract ? 'To contract' : 'To key'} ${fp8(recipient)}`],
          },
          {
            kind: 'text',
            label: 'Paid from one coin of',
            value: `${r.coin.value.toString(10)} base units`,
            mono: true,
            signed: [],
          },
        ],
      };
    }
    case 'withdrawUnshielded': {
      const recipient = bytesToHex(r.recipient);
      return {
        title: 'Withdraw public tokens',
        signedTitle: 'Withdraw unshielded',
        facts: [
          amountFact('Amount', r.amount, bytesToHex(r.color), tokens),
          {
            kind: 'text',
            label: 'To (address)',
            value: recipient,
            mono: true,
            signed: [`To address ${fp8(recipient)}`],
          },
        ],
      };
    }
    case 'appendInbox':
      return {
        title: "Save a note in your account's inbox",
        signedTitle: 'File inbox note',
        facts: [
          {
            kind: 'text',
            label: 'What it does',
            value: 'Files one note, sealed to your own key, so a backup can restore the coin it describes.',
            signed: [`Note ${fp8(bytesToHex(r.entry))}`],
          },
        ],
      };
    case 'rotateEncKey':
      // "Restore my encryption key" (AA 00047 P10, R2-3): the ONE call that moves the key, and only
      // back to this browser's own (../passport/operations.ts `restoreEncryptionKey`). Its text is
      // "Rotate encryption key / New key <16 hex>"; the same key would read as a cancel, which these
      // lines do not match, so it is refused before the wallet.
      if (purpose === 'restore-enc-key') {
        const newKey = bytesToHex(r.newKey);
        return {
          title: 'Restore my encryption key',
          signedTitle: 'Rotate encryption key',
          facts: [
            {
              kind: 'text',
              label: 'What it does',
              value:
                "Sets your account's encryption key back to this browser's key, so the notes your coins are filed with are sealed to you again. Like any approval, it ends every open offer.",
              signed: [],
            },
            {
              kind: 'text',
              label: "New key (this browser's)",
              value: newKey,
              mono: true,
              signed: [`New key ${fp8(newKey)}`],
            },
            ...(currentKey
              ? [
                  {
                    kind: 'text' as const,
                    label: 'Replaces the key on Midnight now',
                    value: norm(currentKey),
                    mono: true,
                    signed: [],
                  },
                ]
              : []),
          ],
        };
      }
      // Otherwise the market only ever re-affirms the account's CURRENT key (questions Q30): the F3
      // v2 text is then "Cancel all open offers / Your key does not change". A request for any other
      // key renders "Rotate encryption key", which these lines do not match, so it is refused before
      // the wallet.
      return {
        title: 'Cancel all open offers',
        signedTitle: 'Cancel all open offers',
        facts: [
          {
            kind: 'text',
            label: 'What it does',
            value:
              "Your key does not change; the account's approval counter moves, so every offer or approval signed before can never be used.",
            signed: ['Your key does not change'],
          },
          {
            kind: 'text',
            label: 'Encryption key (unchanged)',
            value: bytesToHex(r.newKey),
            mono: true,
            signed: [],
          },
        ],
      };
    default:
      return null;
  }
}

/** The facts for one call, or null when there are none to add (a relay envelope, an unknown call).
 *  `ctx` (the call's context) adds the account's current key to a key restore's facts. */
export function signFacts(call: CallToAuthorise, tokens: TokenRegistry, ctx?: { encKey: string }): SignFacts | null {
  if (call.kind === 'gated') return gatedFacts(call.request, tokens, call.purpose, ctx?.encKey);
  const p = call.payload;
  const deadline = renderDeadline(BigInt(p.validUntil)).trimEnd();
  return {
    title: call.action === 'take' ? 'Take an offer' : 'Make an offer',
    signedTitle: 'Swap offer',
    facts: [
      amountFact('Give', BigInt(p.giveAmount), p.giveColor, tokens, 'Give'),
      amountFact('Get', BigInt(p.wantAmount), p.wantColor, tokens, 'Get'),
      {
        kind: 'text',
        label: 'Expires',
        value: deadline === 'never' ? 'never (no expiry)' : deadline,
        signed: [`Expires ${deadline}`],
      },
      { kind: 'text', label: 'Paid from one coin of', value: `${p.coin.value} base units`, mono: true, signed: [] },
    ],
  };
}

/** The text's line that names the operation: its second (the first is the site's label). */
export const OPERATION_LINE = 1;

/** The lines `facts` stands for that are not, verbatim and IN ORDER, lines of `text` (the wallet's
 *  text, trailing spaces trimmed): `site` (the first line the pinned renderer makes, @nightmarket/core
 *  `siteLine`: "Site: Night Market - stagenet" from F3 v3 on, questions Q36) exactly at line 1, the
 *  operation line exactly at `OPERATION_LINE`, then every fact's lines after it in the panel's order
 *  (R2-9). So a label equal to a title or a fact ("Cancel all open offers") never stands in for it.
 *  Empty when the text carries every fact as shown. */
export function missingFromSignedText(facts: SignFacts, text: string, site?: string): string[] {
  const lines = text.split('\n').map((l) => l.trimEnd());
  const missing: string[] = [];
  if (site !== undefined && lines[0] !== site) missing.push(site);
  if (lines[OPERATION_LINE] !== facts.signedTitle) missing.push(facts.signedTitle);
  let from = OPERATION_LINE + 1;
  for (const want of facts.facts.flatMap((f) => f.signed)) {
    const at = lines.indexOf(want, from);
    if (at < 0) missing.push(want);
    else from = at + 1;
  }
  return missing;
}

/** The page would show a fact the wallet's text does not carry: nothing is sent to the wallet. */
export class SignFactsMismatchError extends Error {
  override name = 'SignFactsMismatchError';
  constructor(readonly missing: string[]) {
    super(
      `The approval text does not show what this page shows (${missing.length} line${missing.length === 1 ? '' : 's'} missing), so the wallet was not asked. Nothing was signed.`,
    );
  }
}
