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

export interface SignPrompt {
  /** The wallet's name ("Phantom"). */
  wallet: string;
  /** The exact text the wallet is asked to sign. */
  text: string;
  /** "82d2 06a4": the first 8 hex digits of the message's digest line. */
  fingerprint: string;
  /** What the message is: an account call (F3) or the relay's proof-of-key envelope. */
  kind: 'account-call' | 'relay-envelope';
  /** Unix ms when the wallet was asked (for the "waiting" line). */
  since: number;
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

/** Which kind of message it is, from its second line (Track A's possession message says so). */
export const messageKind = (text: string): SignPrompt['kind'] =>
  text.split('\n')[1] === 'Prove you hold this key' ? 'relay-envelope' : 'account-call';

/** The one prompt open at a time, as an external store React subscribes to. */
export class SignPromptStore {
  private current: SignPrompt | null = null;
  private hidden = false;
  private readonly listeners = new Set<() => void>();

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** The prompt to show, or null (none open, or the customer hid it). */
  readonly get = (): SignPrompt | null => (this.hidden ? null : this.current);

  open(bytes: Uint8Array, wallet: string, now = Date.now()): SignPrompt {
    const text = messageText(bytes);
    this.current = { wallet, text, fingerprint: messageFingerprint(bytes), kind: messageKind(text), since: now };
    this.hidden = false;
    this.emit();
    return this.current;
  }

  close(): void {
    this.current = null;
    this.hidden = false;
    this.emit();
  }

  /** The customer closed the panel; the wallet's request stays open until it answers or times out. */
  hide(): void {
    this.hidden = true;
    this.emit();
  }

  private emit() {
    for (const l of this.listeners) l();
  }
}
