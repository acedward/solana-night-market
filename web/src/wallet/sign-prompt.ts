// What the page shows while the Solana wallet is asked to sign (spec FR-003: "the dApp always shows
// the decoded action next to the Phantom prompt"; AA 00047 lane B2).
//
// The bytes the wallet signs ARE readable text: an account call's F3 message, rendered by Track A's
// client and (identically) by the circuit, or the relay envelope's proof-of-key message (questions
// Q14). So the page shows exactly those bytes, decoded, beside the wallet's own window, with a
// short FINGERPRINT: the first 8 hex digits of the message's own "Digest" line (an account call) or
// "Nonce" line (an envelope), which the wallet displays too, so the two can be compared at a glance.
//
// The Phantom adapter (./phantom-adapter.ts) opens a prompt just before it calls the wallet and
// closes it when the wallet answers (or fails); ./SigningPrompt.tsx renders it.

import { sha256 } from '@noble/hashes/sha2.js';

import { LANDING_KEY_FIRST_LINE, REGISTRATION_FIRST_LINE } from '@nightmarket/core/bridge';

import type { SignFacts } from './sign-facts.js';

export interface SignPrompt {
  /** The wallet's name ("Phantom"). */
  wallet: string;
  /** The exact text the wallet is asked to sign. */
  text: string;
  /** "82d2 06a4": the first 8 hex digits of the message's digest line. */
  fingerprint: string;
  /** What the request is: an account call (F3), the relay's proof-of-key envelope, or (AA 00060 P5.3)
   *  the RPC injector's registration text (I-4), the Bridge-out landing key's text (I-5, asked twice),
   *  or a Solana transaction the page built (its decoded facts in `transaction`). */
  kind: SignPromptKind;
  /** Unix ms when the wallet was asked (for the "waiting" line). */
  since: number;
  /** For an account call: what the contract enforces (base units, token ids, deadline; Q25 B′). */
  facts: SignFacts | null;
  /** For a Solana transaction: what the page built, decoded (the program, the mint, the amount in base
   *  units and with the site's decimals, the accounts). */
  transaction?: TransactionFacts | null;
}

export type SignPromptKind =
  'account-call' | 'relay-envelope' | 'rpc-registration' | 'landing-key' | 'solana-transaction';

/** A Solana transaction's facts as the page shows them beside the wallet's own window. */
export interface TransactionFacts {
  /** One line: what it does ("Lock 500 X for your Night Market account"). */
  title: string;
  facts: { label: string; value: string; mono?: boolean }[];
}

const hexOf = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const group = (hex8: string) => `${hex8.slice(0, 4)} ${hex8.slice(4, 8)}`;

/** The printable-ASCII message as text (the arm's messages are printable ASCII and newlines). */
export const messageText = (bytes: Uint8Array): string => String.fromCharCode(...bytes);

/** The message's fingerprint: its "Digest"/"Nonce" line's first 8 hex digits, grouped; the first 8
 *  hex digits of its SHA-256 when it has neither line. */
export function messageFingerprint(bytes: Uint8Array): string {
  const m = /^(?:Digest|Nonce) ([0-9a-f]{64})$/m.exec(messageText(bytes));
  return group(m ? m[1]!.slice(0, 8) : hexOf(sha256(bytes)).slice(0, 8));
}

/** Which kind of message it is: I-4's or I-5's own first line (AA 00060), else from its second line
 *  (Track A's possession message says so). */
export const messageKind = (text: string): Exclude<SignPromptKind, 'solana-transaction'> => {
  const lines = text.split('\n');
  if (lines[0] === REGISTRATION_FIRST_LINE) return 'rpc-registration';
  if (lines[0] === LANDING_KEY_FIRST_LINE) return 'landing-key';
  return lines[1] === 'Prove you hold this key' ? 'relay-envelope' : 'account-call';
};

/** The one prompt open at a time, as an external store React subscribes to. */
export class SignPromptStore {
  private current: SignPrompt | null = null;
  private pendingFacts: SignFacts | null = null;
  private hidden = false;
  private readonly listeners = new Set<() => void>();
  private readonly signedListeners = new Set<() => void>();

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** The prompt to show, or null (none open, or the customer hid it). */
  readonly get = (): SignPrompt | null => (this.hidden ? null : this.current);

  /** The facts of the account call about to be signed (the signing seam announces them just before
   *  the wallet is asked, and clears them after); the next `open` shows them. */
  setFacts(facts: SignFacts | null): void {
    this.pendingFacts = facts;
  }

  open(bytes: Uint8Array, wallet: string, now = Date.now()): SignPrompt {
    const text = messageText(bytes);
    const kind = messageKind(text);
    this.current = {
      wallet,
      text,
      fingerprint: messageFingerprint(bytes),
      kind,
      since: now,
      facts: kind === 'account-call' ? this.pendingFacts : null,
    };
    this.hidden = false;
    this.emit();
    return this.current;
  }

  /** AA 00060 P5.3: the wallet is asked to sign a Solana transaction the page built; the panel shows its
   *  decoded facts (the wallet shows its own reading of the same transaction). */
  openTransaction(transaction: TransactionFacts, wallet: string, now = Date.now()): SignPrompt {
    this.current = {
      wallet,
      text: [transaction.title, ...transaction.facts.map((f) => `${f.label}: ${f.value}`)].join('\n'),
      fingerprint: '',
      kind: 'solana-transaction',
      since: now,
      facts: null,
      transaction,
    };
    this.hidden = false;
    this.emit();
    return this.current;
  }

  /** The wallet answered (`signed`: with a signature the page accepted) or the request ended. */
  close(outcome: 'signed' | 'ended' = 'ended'): void {
    this.current = null;
    this.hidden = false;
    this.emit();
    if (outcome === 'signed') for (const l of this.signedListeners) l();
  }

  /** Called each time the wallet signs a request the page accepted (the signing modal then moves
   *  on to the market's part of the action, AA 00047 P8.1). */
  readonly onSigned = (listener: () => void): (() => void) => {
    this.signedListeners.add(listener);
    return () => this.signedListeners.delete(listener);
  };

  /** The customer closed the panel; the wallet's request stays open until it answers or times out. */
  hide(): void {
    this.hidden = true;
    this.emit();
  }

  private emit() {
    for (const l of this.listeners) l();
  }
}
