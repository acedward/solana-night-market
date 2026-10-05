// AA 00060 P13 (spec FR-024; the plan's P13 e2e): "Mint Solana tokens" in the browser, against a MOCK relay
// faucet (GET /v1/spl-faucet, POST /v1/actions/spl-faucet and its job, on the mock relay's origin) and the
// mock Solana RPC the site reads balances from (./bridge-fixtures.ts).
//
//   the Portfolio's action 5 (FR-023's list, lane 00060-lane-portfolio) is enabled only when the relay offers
//   the faucet (not served / off: disabled, "Not available on this market.") · its flow says what you get and
//   the current balance, claims with NO wallet request, and shows the result with the transaction signature
//   and the new balance · a wallet that claimed this period waits · a refusal is shown in plain words.

import { expect, test, type Page } from '@playwright/test';

import { associatedTokenAddress, encodeKey } from '../../packages/core/src/solana/index.js';
import { DEFAULT_PROFILE, X, bridgeSite, connectWallet, type Site } from './bridge-fixtures.js';
import { RELAY } from './mock-relay.js';
import { actionItem, openAction } from './portfolio-fixtures.js';

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
    /** The wallet already claimed this period. */
    claimed?: boolean;
  } = {},
): Promise<Faucet> {
  const f: Faucet = { posts: [], claimedAt: o.claimed ? Math.floor(Date.now() / 1000) - 3600 : null };
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

/** The Portfolio, the wallet connected and the account checked (the action list showing). */
async function portfolio(page: Page) {
  await page.goto('/#account');
  await connectWallet(page, DEFAULT_PROFILE.name);
  await expect(page.getByTestId('account-check')).toHaveAttribute('data-state', 'ok');
  await expect(page.getByTestId('portfolio-actions')).toBeVisible();
}

test('not served by the relay: action 5 is listed disabled, "Not available on this market."', async ({ page }) => {
  const s = await bridgeSite(page);
  const f = await mockFaucet(page, s, { serve: false });
  await portfolio(page);
  await expect(actionItem(page, 'mint-solana')).toHaveAttribute('data-enabled', 'false');
  await expect(actionItem(page, 'mint-solana')).toContainText('Not available on this market.');
  await page.goto('/#account?action=mint-solana');
  await expect(page.getByTestId('portfolio-action-unavailable')).toHaveText(
    'Mint Solana tokens: Not available on this market.',
  );
  await expect(page.getByTestId('mint-solana-flow')).toHaveCount(0);
  expect(f.posts).toHaveLength(0);
});

test('off on this market (mainnet): listed disabled, and nothing can be claimed', async ({ page }) => {
  const s = await bridgeSite(page);
  const f = await mockFaucet(page, s, { enabled: false, reason: 'mainnet' });
  await portfolio(page);
  await expect(actionItem(page, 'mint-solana')).toHaveAttribute('data-enabled', 'false');
  await expect(actionItem(page, 'mint-solana')).toContainText('Not available on this market.');
  await expect(page.getByTestId('mint-solana-flow')).toHaveCount(0);
  expect(f.posts).toHaveLength(0);
});

test('offered: what you get, the claim with no wallet request, then the signature and the new balance', async ({
  page,
}) => {
  const s = await bridgeSite(page);
  const f = await mockFaucet(page, s);
  await portfolio(page);
  await expect(actionItem(page, 'mint-solana')).toHaveAttribute('data-enabled', 'true');
  await openAction(page, 'mint-solana');
  const flow = page.getByTestId('mint-solana-flow');
  await expect(flow).toBeVisible();
  await expect(flow.getByTestId('mint-solana-amounts')).toHaveText('1,000 X');
  // The current balance, from the site's own Solana RPC (600 X, bridgeSite's).
  await expect(flow.locator('[data-testid="mint-solana-balance"][data-symbol="X"]')).toHaveText('600');
  const walletRequests = s.wallet.requests.length;
  await flow.getByTestId('mint-solana-claim').click();
  const result = flow.getByTestId('mint-solana-result');
  await expect(result).toBeVisible();
  await expect(result).toContainText('Minted 1,000 X to your wallet.');
  await expect(flow.getByTestId('mint-solana-signature')).toHaveText(SIGNATURE);
  await expect(flow.locator('[data-testid="mint-solana-new-balance"][data-symbol="X"]')).toHaveText('1,600');
  await expect(flow.getByTestId('mint-solana-next')).toContainText('Next claim for this wallet from');
  // One request, naming only the wallet; the wallet was asked for nothing.
  expect(f.posts).toEqual([{ payload: { wallet: s.wallet.address } }]);
  expect(s.wallet.requests.length).toBe(walletRequests);
});

test('a wallet that claimed this period: the flow says when the next claim opens, and the claim is off', async ({
  page,
}) => {
  const s = await bridgeSite(page);
  const f = await mockFaucet(page, s, { claimed: true });
  await portfolio(page);
  await openAction(page, 'mint-solana');
  await expect(page.getByTestId('mint-solana-waiting')).toContainText('The next claim opens at');
  await expect(page.getByTestId('mint-solana-claim')).toBeDisabled();
  expect(f.posts).toHaveLength(0);
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
  await portfolio(page);
  await openAction(page, 'mint-solana');
  const walletRequests = s.wallet.requests.length;
  await page.getByTestId('mint-solana-claim').click();
  await expect(page.getByTestId('mint-solana-error')).toContainText(
    'Already claimed: this wallet received its test tokens at 2026-10-05T10:00:00.000Z',
  );
  await expect(page.getByTestId('mint-solana-error')).toContainText('the next claim opens at 2026-10-06T10:00:00.000Z');
  expect(s.wallet.requests.length).toBe(walletRequests);
});
