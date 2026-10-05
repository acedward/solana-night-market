// AA 00057 P3 (spec SC-005): the wallet prompt ledger of the scripted journey. Every time a harness step
// asks a test wallet to sign (a message or a Solana transaction), exactly as a real wallet would show a
// prompt, the step appends one line to $PROMPT_LOG (JSON lines). The journey's steps run as separate
// processes (market-flows.ts, landing.ts, journey.ts), so the ledger is a file; `JOURNEY_STEP` names the
// journey step (I, prefund, II, III, IV, V, neg) the process runs for. Without PROMPT_LOG nothing is
// written, so the harnesses behave exactly as before.
//
// Only public facts are written: the wallet's address, the kind, the message's first line (every text a
// wallet signs here is public; the landing-key text's SIGNATURE is secret, and it is never logged).

import { appendFileSync } from 'node:fs';

import { base58 } from '@scure/base';

export type PromptKind = 'message' | 'transaction';

export interface PromptEntry {
  at: string;
  step: string;
  wallet: string;
  kind: PromptKind;
  /** The message's first line (printable ASCII), or the transaction's byte length. */
  what: string;
}

const firstLine = (bytes: Uint8Array): string => {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  const line = text.split('\n')[0] ?? '';
  return /^[\x20-\x7e]*$/.test(line) ? line.slice(0, 120) : `<${bytes.length} bytes>`;
};

/** Record one wallet prompt (a no-op without PROMPT_LOG). `wallet` is the base58 address or the 32-byte key. */
export function logPrompt(wallet: string | Uint8Array, kind: PromptKind, bytes: Uint8Array): void {
  const path = process.env.PROMPT_LOG;
  if (!path) return;
  const entry: PromptEntry = {
    at: new Date().toISOString(),
    step: process.env.JOURNEY_STEP ?? 'unknown',
    wallet: typeof wallet === 'string' ? wallet : base58.encode(wallet),
    kind,
    what: kind === 'message' ? firstLine(bytes) : `<transaction ${bytes.length} bytes>`,
  };
  appendFileSync(path, `${JSON.stringify(entry)}\n`);
}

/** Read a ledger written by `logPrompt`. */
export function readPromptLog(text: string): PromptEntry[] {
  return text
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as PromptEntry);
}

/** The journey steps of SC-005, in order, and the prompts each must take for user A (6 actions, the
 *  landing-key derivation asking twice: 7 in all). */
export const SC005_STEPS = ['I', 'II', 'III', 'IV', 'V'] as const;
export const SC005_EXPECTED: Readonly<Record<(typeof SC005_STEPS)[number], number>> = {
  I: 1,
  II: 1,
  III: 1,
  IV: 1,
  V: 3,
};
export const SC005_LIMIT = 7;

export interface PromptSummary {
  wallet: string;
  perStep: Record<string, number>;
  journeyTotal: number;
  /** Prompts outside the journey's steps (pre-funding by the counterparty, negatives), by step. */
  other: Record<string, number>;
  withinLimit: boolean;
  matchesExpected: boolean;
}

/** SC-005 for one wallet: the prompts of the journey steps I..V (negatives and pre-funding excluded). */
export function summarisePrompts(entries: readonly PromptEntry[], wallet: string): PromptSummary {
  const perStep: Record<string, number> = Object.fromEntries(SC005_STEPS.map((s) => [s, 0]));
  const other: Record<string, number> = {};
  for (const e of entries) {
    if (e.wallet !== wallet) continue;
    if ((SC005_STEPS as readonly string[]).includes(e.step)) perStep[e.step] = (perStep[e.step] ?? 0) + 1;
    else other[e.step] = (other[e.step] ?? 0) + 1;
  }
  const journeyTotal = SC005_STEPS.reduce((n, s) => n + (perStep[s] ?? 0), 0);
  return {
    wallet,
    perStep,
    journeyTotal,
    other,
    withinLimit: journeyTotal <= SC005_LIMIT,
    matchesExpected: SC005_STEPS.every((s) => perStep[s] === SC005_EXPECTED[s]),
  };
}
