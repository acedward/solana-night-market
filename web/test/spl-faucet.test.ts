// AA 00060 P13 (spec FR-024): the browser's half of "Mint Solana tokens" (web/src/bridge/faucet/operations.ts):
// the offer and its disabled reasons, the claim through the relay client (no wallet involved), the refusals in
// plain words, and the balances read from the site's own Solana RPC.

import { describe, expect, it } from 'vitest';

import type { JobView, SplFaucetInfo, SplFaucetResult } from '@nightmarket/core';
import { associatedTokenAddress, encodeKey } from '@nightmarket/core/solana';

import { asFetch } from '../../test/mocks/http.js';
import { mockSolanaRpc } from '../../test/mocks/solana-rpc.js';
import {
  FaucetError,
  claimSolanaTokens,
  faucetAmountsText,
  faucetAvailability,
  faucetErrorText,
  solanaBalances,
} from '../src/bridge/faucet/operations.js';
import { SolanaRpc } from '../src/bridge/solana-rpc.js';
import { RelayClient, RelayError } from '../src/relay/client.js';

const WALLET = encodeKey(new Uint8Array(32).fill(3));
const X = encodeKey(new Uint8Array(32).fill(4));
const Y = encodeKey(new Uint8Array(32).fill(5));
const TOKENS = [
  { mint: X, symbol: 'X', name: 'Test X', decimals: 6, amount: '1000000000' },
  { mint: Y, symbol: 'Y', name: 'Test Y', decimals: 9, amount: '1000000000000' },
];

const job = (over: Partial<JobView>): JobView => ({
  requestId: 'a'.repeat(32),
  action: 'spl-faucet',
  lane: 'relay',
  state: 'queued',
  stage: 'queued',
  stages: [],
  createdAt: 1,
  updatedAt: 1,
  expiresAt: 2,
  ...over,
});

/** A relay answering the faucet's two routes, recording what the page sent. */
function relay(final: Partial<JobView>, info?: SplFaucetInfo) {
  const sent: { url: string; body: unknown }[] = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    sent.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
    const reply = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (url.includes('/v1/spl-faucet')) return reply(200, info ?? { enabled: true, tokens: TOKENS, periodHours: 24 });
    if (url.endsWith('/v1/actions/spl-faucet')) return reply(202, { job: job({}) });
    if (url.includes('/v1/jobs/')) return reply(200, { job: job(final) });
    return reply(404, { error: { code: 'not-found', message: 'no' } });
  };
  return { client: new RelayClient('http://relay.test', fetchImpl as typeof fetch), sent };
}

const result: SplFaucetResult = {
  wallet: WALLET,
  signature: '5'.repeat(88),
  minted: TOKENS.map((t) => ({ ...t, tokenAccount: associatedTokenAddress(WALLET, t.mint), createdAccount: true })),
  at: 1_800_000_000,
  nextClaimAt: 1_800_086_400,
};

describe('Mint Solana tokens: the offer', () => {
  it("says what a claim mints, in each token's decimals", () => {
    expect(faucetAmountsText(TOKENS)).toBe('1,000 X and 1,000 Y');
    expect(faucetAmountsText(TOKENS.slice(0, 1))).toBe('1,000 X');
    expect(faucetAmountsText([...TOKENS, { ...TOKENS[0]!, symbol: 'Z' }])).toBe('1,000 X, 1,000 Y and 1,000 Z');
  });

  it('is offered only when the relay says it is on; otherwise says why', () => {
    expect(faucetAvailability('loading')).toEqual({ state: 'loading' });
    expect(faucetAvailability({ enabled: true, tokens: TOKENS, periodHours: 24 })).toEqual({ state: 'offered' });
    expect(faucetAvailability(null)).toMatchObject({ state: 'not-offered', code: 'not-configured' });
    expect(faucetAvailability({ enabled: false, reason: 'mainnet', tokens: [], periodHours: 24 })).toMatchObject({
      state: 'not-offered',
      code: 'mainnet',
      reason: expect.stringMatching(/never offered on Solana mainnet/),
    });
    expect(
      faucetAvailability({ enabled: false, reason: 'authority-mismatch', tokens: TOKENS, periodHours: 24 }),
    ).toMatchObject({ state: 'not-offered', code: 'authority-mismatch' });
  });

  it('reads the offer for the connected wallet', async () => {
    const r = relay({});
    expect(await r.client.splFaucetInfo(WALLET)).toMatchObject({ enabled: true });
    expect(r.sent[0]!.url).toBe(`http://relay.test/v1/spl-faucet?wallet=${WALLET}`);
  });
});

describe('Mint Solana tokens: the claim', () => {
  it("sends only the wallet, no signature, and returns the job's result", async () => {
    const r = relay({ state: 'succeeded', stage: 'succeeded', result: result as unknown as Record<string, unknown> });
    const seen: string[] = [];
    const out = await claimSolanaTokens(r.client, WALLET, (j) => seen.push(j.state), { intervalMs: 1 });
    expect(out).toEqual(result);
    const post = r.sent.find((s) => s.url.endsWith('/v1/actions/spl-faucet'))!;
    expect(post.body).toEqual({ payload: { wallet: WALLET } });
    expect(seen).toEqual(['queued', 'succeeded']);
  });

  it('refuses a result for another wallet', async () => {
    const r = relay({
      state: 'succeeded',
      result: { ...result, wallet: encodeKey(new Uint8Array(32).fill(9)) } as unknown as Record<string, unknown>,
    });
    await expect(claimSolanaTokens(r.client, WALLET, undefined, { intervalMs: 1 })).rejects.toThrow(/unexpected/);
  });

  it('a failed or unconfirmed job is a plain sentence', async () => {
    const pending = relay({ state: 'failed', error: { code: 'spl-faucet-pending', message: 'sent' } });
    await expect(claimSolanaTokens(pending.client, WALLET, undefined, { intervalMs: 1 })).rejects.toThrow(
      /not confirmed it yet/,
    );
    const failed = relay({ state: 'failed', error: { code: 'spl-faucet-failed', message: 'it failed on Solana' } });
    await expect(claimSolanaTokens(failed.client, WALLET, undefined, { intervalMs: 1 })).rejects.toBeInstanceOf(
      FaucetError,
    );
  });

  it("the relay's refusals in plain words: period, not configured, mainnet, authority mismatch", () => {
    expect(
      faucetErrorText(new RelayError(429, 'spl-faucet-period', 'the next claim opens at 2027-01-15T08:00:00.000Z')),
    ).toBe('Already claimed: the next claim opens at 2027-01-15T08:00:00.000Z.');
    expect(faucetErrorText(new RelayError(401, 'unauthorised', 'x', 'not-supported'))).toBe(
      'This market does not offer Mint Solana tokens.',
    );
    expect(faucetErrorText(new RelayError(403, 'spl-faucet-off', 'x', 'mainnet'))).toMatch(
      /never offered on Solana mainnet/,
    );
    expect(faucetErrorText(new RelayError(503, 'spl-faucet-off', 'x', 'authority-mismatch'))).toMatch(
      /not the token's mint authority/,
    );
    expect(faucetErrorText(new RelayError(409, 'spl-faucet-pending', 'x'))).toMatch(/still on its way/);
  });
});

describe("Mint Solana tokens: balances from the site's Solana RPC", () => {
  it("reads each token's associated account; a missing account is 0, an unreadable one null", async () => {
    const rpc = mockSolanaRpc();
    rpc.tokenBalances.set(associatedTokenAddress(WALLET, X), { amount: 1_600_000_000n, decimals: 6 });
    const site = new SolanaRpc('http://solana-rpc.test/', asFetch(rpc.handler));
    const b = await solanaBalances(site, WALLET, TOKENS);
    expect(b.get(X)).toBe(1_600_000_000n);
    expect(b.get(Y)).toBe(0n);
    rpc.failing.add('getTokenAccountBalance');
    const down = await solanaBalances(site, WALLET, TOKENS);
    expect(down.get(X)).toBeNull();
  });
});
