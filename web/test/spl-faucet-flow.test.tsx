// AA 00060 P13 (spec FR-024): the "Mint Solana tokens" flow as the Portfolio mounts it through its `splFaucet`
// seam (lane 00060-lane-portfolio: `{ offered, Flow }`): offered only when the relay serves an enabled faucet;
// the flow shows what you get, claims with one request naming the wallet, and shows the signature.

import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { encodeKey } from '@nightmarket/core/solana';

import { MintSolanaTokensFlow, useSplFaucetSeam } from '../src/bridge/faucet/MintSolanaTokens.js';
import { WalletProvider } from '../src/wallet/WalletContext.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const RELAY = 'http://relay.test';
const WALLET = encodeKey(new Uint8Array(32).fill(3));
const X = encodeKey(new Uint8Array(32).fill(4));
const SIGNATURE = encodeKey(new Uint8Array(64).fill(7));
const TOKENS = [{ mint: X, symbol: 'X', name: 'Test X', decimals: 6, amount: '1000000000' }];

function stubRelay(o: { serve: boolean }) {
  const posts: unknown[] = [];
  const reply = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const job = (state: string, result?: unknown) => ({
    requestId: 'b'.repeat(32),
    action: 'spl-faucet',
    lane: 'relay',
    state,
    stage: state,
    stages: [],
    createdAt: 1,
    updatedAt: 1,
    expiresAt: 2,
    ...(result ? { result } : {}),
  });
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!o.serve) return reply(404, { error: { code: 'not-found', message: 'no such route' } });
    if (url.startsWith(`${RELAY}/v1/spl-faucet`)) return reply(200, { enabled: true, tokens: TOKENS, periodHours: 24 });
    if (url === `${RELAY}/v1/actions/spl-faucet`) {
      posts.push(JSON.parse(String(init?.body)));
      return reply(202, { job: job('queued') });
    }
    if (url.startsWith(`${RELAY}/v1/jobs/`))
      return reply(200, {
        job: job('succeeded', {
          wallet: WALLET,
          signature: SIGNATURE,
          minted: TOKENS.map((t) => ({ ...t, tokenAccount: X, createdAccount: true })),
          at: 1_800_000_000,
          nextClaimAt: 1_800_086_400,
        }),
      });
    return reply(404, { error: { code: 'not-found', message: 'no' } });
  });
  return posts;
}

async function mount(el: ReactNode) {
  const div = document.createElement('div');
  document.body.append(div);
  const root = createRoot(div);
  await act(async () => root.render(<WalletProvider>{el}</WalletProvider>));
  return { div, root };
}
const settle = async (ms = 60) => {
  for (let i = 0; i < 6; i++) await act(async () => new Promise((r) => setTimeout(r, ms / 6)));
};
const byTestId = (root: ParentNode, id: string) => root.querySelector(`[data-testid="${id}"]`);

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

function Host() {
  const seam = useSplFaucetSeam(RELAY);
  return (
    <div data-testid="host" data-offered={String(seam.offered)}>
      {seam.offered && <seam.Flow account={'11'.repeat(32)} walletAddress={WALLET} />}
    </div>
  );
}

describe('the Portfolio seam for Mint Solana tokens', () => {
  it('is not offered when the relay does not serve the faucet', async () => {
    stubRelay({ serve: false });
    const { div } = await mount(<Host />);
    await settle();
    expect(byTestId(div, 'host')!.getAttribute('data-offered')).toBe('false');
    expect(byTestId(div, 'mint-solana-flow')).toBeNull();
  });

  it('offered: the flow says what you get, claims with one request naming the wallet, and shows the signature', async () => {
    const posts = stubRelay({ serve: true });
    const { div } = await mount(<Host />);
    await settle();
    expect(byTestId(div, 'host')!.getAttribute('data-offered')).toBe('true');
    expect(byTestId(div, 'mint-solana-amounts')!.textContent).toBe('1,000 X');
    const claim = byTestId(div, 'mint-solana-claim') as HTMLButtonElement;
    expect(claim.disabled).toBe(false);
    await act(async () => claim.click());
    await settle(2_500);
    expect(posts).toEqual([{ payload: { wallet: WALLET } }]);
    expect(byTestId(div, 'mint-solana-result')!.textContent).toContain('Minted 1,000 X to your wallet.');
    expect(byTestId(div, 'mint-solana-signature')!.textContent).toBe(SIGNATURE);
  });

  it('the inline flow alone, for a given wallet', async () => {
    stubRelay({ serve: true });
    const { div } = await mount(<MintSolanaTokensFlow relayUrl={RELAY} walletAddress={WALLET} />);
    await settle();
    expect(byTestId(div, 'mint-solana-offer')!.textContent).toContain('minted to your wallet');
  });
});
