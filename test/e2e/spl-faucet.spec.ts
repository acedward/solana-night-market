// AA 00060 P13 (spec FR-024; the plan's P13 e2e): "Mint Solana tokens" in the browser, against a MOCK relay
// faucet (GET /v1/spl-faucet, POST /v1/actions/spl-faucet and its job, on the mock relay's origin) and the
// mock Solana RPC the site reads balances from (./bridge-fixtures.ts).
//
//   the action is enabled only when the relay offers it (not served / off: disabled, "not available on this
//   market") · the flow says what you get and the current balance, claims with NO wallet request, and shows
//   the result with the transaction signature and the new balance · a refusal is shown in plain words.

import { expect, test, type Page } from '@playwright/test';

import { associatedTokenAddress, encodeKey } from '../../packages/core/src/solana/index.js';
import { X, bridgeSite, openPortfolio, type Site } from './bridge-fixtures.js';
import { RELAY } from './mock-relay.js';

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type' };
const REQUEST_ID = 'f'.repeat(32);
const SIGNATURE = encodeKey(new Uint8Array(64).fill(11));
const PERIOD = 86_400;

interface Faucet {
  posts: unknown[];
  claimedAt: number | null;
}

/** The faucet routes on the mock relay (registered after it, so they win; anything else falls through). */
async function mockFaucet(
  page: Page,
  s: Site,
  o: {
    serve?: boolean;
    enabled?: boolean;
    reason?: string;
    refuse?: { status: number; code: string; message: string };
  } = {},
): Promise<Faucet> {
  const f: Faucet = { posts: [], claimedAt: null };
  const tokens = [{ mint: X.splMint, symbol: 'X', name: 'Test X', decimals: 6, amount: '1000000000' }];
  const ata = associatedTokenAddress(s.wallet.address, X.splMint);
  await page.route(`${RELAY}/**`, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (req.method() === 'OPTIONS' || o.serve === false) return route.fallback();
    const json = (status: number, body: unknown) =>
      route.fulfill({ status, headers: CORS, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/v1/spl-faucet') {
      const wallet = url.searchParams.get('wallet');
      return json(200, {
        enabled: o.enabled ?? true,
        ...(o.reason ? { reason: o.reason } : {}),
        tokens,
        periodHours: 24,
        ...(wallet === s.wallet.address && f.claimedAt
          ? { claim: { state: 'claimed', at: f.claimedAt, nextClaimAt: f.claimedAt + PERIOD, signature: SIGNATURE } }
          : {}),
      });
    }
    if (url.pathname === '/v1/actions/spl-faucet') {
      f.posts.push(JSON.parse(req.postData() ?? 'null'));
      if (o.refuse) return json(o.refuse.status, { error: { code: o.refuse.code, message: o.refuse.message } });
      // The faucet mints: the wallet's associated account on the mock Solana RPC grows by 1,000 X.
      const before = s.rpc.tokenBalances.get(ata)?.amount ?? 0n;
      s.rpc.tokenBalances.set(ata, { amount: before + 1_000_000_000n, decimals: 6 });
      f.claimedAt = Math.floor(Date.now() / 1000);
      return json(202, { job: view('queued') });
    }
    if (url.pathname === `/v1/jobs/${REQUEST_ID}`)
      return json(200, {
        job: view('succeeded', {
          wallet: s.wallet.address,
          signature: SIGNATURE,
          minted: [{ ...tokens[0], tokenAccount: ata, createdAccount: false }],
          at: f.claimedAt,
          nextClaimAt: f.claimedAt! + PERIOD,
        }),
      });
    return route.fallback();
  });
  return f;
}

const view = (state: 'queued' | 'succeeded', result?: Record<string, unknown>) => ({
  requestId: REQUEST_ID,
  action: 'spl-faucet',
  lane: 'relay',
  state,
  stage: state === 'succeeded' ? 'succeeded' : 'queued',
  stages: [],
  createdAt: 1,
  updatedAt: 1,
  expiresAt: 4_000_000_000,
  ...(result ? { result } : {}),
});

test('not served by the relay: the action is shown disabled, "not available on this market"', async ({ page }) => {
  const s = await bridgeSite(page);
  const f = await mockFaucet(page, s, { serve: false });
  await openPortfolio(page);
  const action = page.getByTestId('mint-solana-action');
  await expect(action).toHaveAttribute('data-state', 'not-offered');
  await expect(page.getByTestId('mint-solana-open')).toBeDisabled();
  await expect(page.getByTestId('mint-solana-unavailable')).toHaveText('Not available on this market.');
  await expect(page.getByTestId('mint-solana-unavailable')).toHaveAttribute('data-code', 'not-configured');
  expect(f.posts).toHaveLength(0);
});

test('off on this market (mainnet): disabled, and the reason is named', async ({ page }) => {
  const s = await bridgeSite(page);
  await mockFaucet(page, s, { enabled: false, reason: 'mainnet' });
  await openPortfolio(page);
  await expect(page.getByTestId('mint-solana-open')).toBeDisabled();
  await expect(page.getByTestId('mint-solana-unavailable')).toHaveAttribute('data-code', 'mainnet');
});

test('offered: what you get, the claim with no wallet request, then the signature and the new balance', async ({
  page,
}) => {
  const s = await bridgeSite(page);
  const f = await mockFaucet(page, s);
  await openPortfolio(page);
  await expect(page.getByTestId('mint-solana-action')).toHaveAttribute('data-state', 'offered');
  await page.getByTestId('mint-solana-open').click();
  const d = page.getByTestId('mint-solana-dialog');
  await expect(d).toBeVisible();
  await expect(d.getByTestId('mint-solana-amounts')).toHaveText('1,000 X');
  // The current balance, from the site's own Solana RPC (600 X, bridgeSite's).
  await expect(d.locator('[data-testid="mint-solana-balance"][data-symbol="X"]')).toHaveText('600');
  const walletRequests = s.wallet.requests.length;
  await d.getByTestId('mint-solana-claim').click();
  const result = d.getByTestId('mint-solana-result');
  await expect(result).toBeVisible();
  await expect(result).toContainText('Minted 1,000 X to your wallet.');
  await expect(d.getByTestId('mint-solana-signature')).toHaveText(SIGNATURE);
  await expect(d.locator('[data-testid="mint-solana-new-balance"][data-symbol="X"]')).toHaveText('1,600');
  await expect(d.getByTestId('mint-solana-next')).toContainText('Next claim for this wallet from');
  // One request, naming only the wallet; the wallet was asked for nothing.
  expect(f.posts).toEqual([{ payload: { wallet: s.wallet.address } }]);
  expect(s.wallet.requests.length).toBe(walletRequests);
  // Reopened: the relay names the claim, so the button waits for the next period.
  await d.getByTestId('mint-solana-close').click();
  await page.getByTestId('mint-solana-open').click();
  await expect(page.getByTestId('mint-solana-waiting')).toContainText('The next claim opens at');
  await expect(page.getByTestId('mint-solana-claim')).toBeDisabled();
});

test('a refusal from the relay is shown in plain words, and nothing is asked of the wallet', async ({ page }) => {
  const s = await bridgeSite(page);
  await mockFaucet(page, s, {
    refuse: {
      status: 429,
      code: 'spl-faucet-period',
      message:
        'this wallet received its test tokens at 2026-10-05T10:00:00.000Z; the next claim opens at 2026-10-06T10:00:00.000Z',
    },
  });
  await openPortfolio(page);
  await page.getByTestId('mint-solana-open').click();
  const walletRequests = s.wallet.requests.length;
  await page.getByTestId('mint-solana-claim').click();
  await expect(page.getByTestId('mint-solana-error')).toContainText(
    'Already claimed: this wallet received its test tokens at 2026-10-05T10:00:00.000Z',
  );
  await expect(page.getByTestId('mint-solana-error')).toContainText('the next claim opens at 2026-10-06T10:00:00.000Z');
  expect(s.wallet.requests.length).toBe(walletRequests);
});
