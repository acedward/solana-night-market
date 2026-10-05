// AA 00060 P12.1 / P12.1b / P12.1c (spec FR-020, FR-022, FR-023): the Portfolio in the browser, with the
// mock wallet, the mock Solana RPC (getTokenAccountsByOwner), the mock bridges for X and Y, the mock RPC
// injector on its own origin, and the mock relay and public indexer (a seeded account).
//
//   FR-020  X and Y: TOTAL = the private balance on Midnight + the wallet's SPL on Solana, with the mint
//           shortened and copied whole; a Solana read that fails says "unavailable" and shows no total;
//           the Solana line is read on the site's Solana RPC, never the injector; twUSDC is unchanged.
//   FR-022  the configured icons are the site's own files (loaded from its origin); no icon: the badge.
//   FR-023  exactly five actions, in order and wording, each opening its own flow; Show in my wallet in
//           the right column; the pending items stay reachable; the demo pack only on the Portfolio.

import { expect, test, type Page, type Request } from '@playwright/test';

import { asFetch } from '../mocks/http.js';
import { mockInjector } from '../mocks/injector.js';
import { transferView } from '../mocks/bridge-api.js';
import { X, Y, bridgeSite, connectWallet, DEFAULT_PROFILE, lockc, review, type Site } from './bridge-fixtures.js';
import { ACCOUNT } from './mock-relay.js';
import { actionItem, openAction } from './portfolio-fixtures.js';

const INJECTOR = 'http://injector.test';
const M = 1_000_000n; // decimals 6
const LABELS = [
  'Send tokens to a Midnight wallet',
  'Bridge in from Solana: make your tokens private',
  'Bridge out to Solana',
  'Mint Midnight tokens',
  'Mint Solana tokens',
];

/** The site's token list with X and Y and their Midnight icons (FR-022: config, never by colour). */
const TOKENS = {
  mode: 'extend',
  tokens: [
    { symbol: 'X', name: 'Test X', decimals: 6, midnightColour: X.colour, icon: 'token-icons/x-midnight.png' },
    { symbol: 'Y', name: 'Test Y', decimals: 6, midnightColour: Y.colour, icon: 'token-icons/y-midnight.png' },
  ],
};

/** The bridging site with X and Y, an RPC injector (routed, every request recorded) and the copy recorder. */
async function portfolioSite(page: Page): Promise<{ s: Site; injector: Request[] }> {
  const s = await bridgeSite(page, { withY: true, injectorUrl: `${INJECTOR}/`, tokens: TOKENS, splIcons: true });
  const inj = mockInjector({ origin: INJECTOR, networkId: 'stagenet' });
  const f = asFetch(inj.handler);
  await page.route(`${INJECTOR}/**`, async (route) => {
    const r = route.request();
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type' };
    if (r.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const res = await f(r.url(), { method: r.method(), ...(r.postData() ? { body: r.postData()! } : {}) });
    const headers: Record<string, string> = { ...cors };
    res.headers.forEach((v, k) => (headers[k] = v));
    return route.fulfill({ status: res.status, headers, body: await res.text() });
  });
  const injector: Request[] = [];
  page.on('request', (r) => {
    if (r.url().startsWith(INJECTOR)) injector.push(r);
  });
  await page.addInitScript(() => {
    const w = window as unknown as { __copied: string[] };
    w.__copied = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (t: string) => void w.__copied.push(t) },
    });
  });
  return { s, injector };
}

async function openPortfolioPage(page: Page) {
  await page.goto('/#account');
  await connectWallet(page, DEFAULT_PROFILE.name);
  await expect(page.getByTestId('account-check')).toHaveAttribute('data-state', 'ok');
}

const bridgedRow = (page: Page, symbol: string) =>
  page.locator(`[data-testid=passport-row][data-kind=bridged][data-symbol="${symbol}"]`);

test('FR-020 / FR-022: X and Y show TOTAL, (Private) on Midnight and on Solana with the mint; the icons are the site’s own', async ({
  page,
}) => {
  const { s, injector } = await portfolioSite(page);
  // Midnight: 10,000 X and 3 Y in the account. Solana: 60,000 + 30,000 X and 25 Y in the wallet.
  await s.relay.deposit([
    { nonce: '7a'.repeat(32), color: X.colour, value: 10_000n * M },
    { nonce: '7b'.repeat(32), color: Y.colour, value: 3n * M },
  ]);
  s.rpc.tokenBalances.set(s.ata, { amount: 60_000n * M, decimals: 6, owner: s.wallet.address, mint: X.splMint });
  s.rpc.tokenBalances.set('X2222222222222222222222222222222222222222222', {
    amount: 30_000n * M,
    decimals: 6,
    owner: s.wallet.address,
    mint: X.splMint,
  });
  s.rpc.tokenBalances.set('Y1111111111111111111111111111111111111111111', {
    amount: 25n * M,
    decimals: 6,
    owner: s.wallet.address,
    mint: Y.splMint,
  });
  await openPortfolioPage(page);

  const x = bridgedRow(page, 'X');
  await expect(x.getByTestId('bridged-total')).toHaveAttribute('data-raw', String(100_000n * M));
  await expect(x.getByTestId('bridged-total')).toHaveText('100,000.00');
  await expect(x.getByTestId('bridged-midnight')).toHaveText('10,000.00 (Private) on Midnight');
  await expect(x.getByTestId('bridged-solana')).toContainText('90,000.00 on Solana');
  await expect(x.getByTestId('bridged-mint')).toContainText('cGfHiC…QPizuN');
  await expect(x.getByTestId('bridged-mint')).toHaveAttribute('data-value', X.splMint);
  const y = bridgedRow(page, 'Y');
  await expect(y.getByTestId('bridged-total')).toHaveText('28.00');
  await expect(y.getByTestId('bridged-midnight')).toHaveText('3.00 (Private) on Midnight');
  await expect(y.getByTestId('bridged-solana')).toContainText('25.00 on Solana');
  // One row each: no plain X or Y row beside it.
  await expect(page.locator(`[data-testid=passport-row][data-colour="${X.colour}"]`)).toHaveCount(1);

  // twUSDC (no Solana version) is shown as before, with its text badge (no icon configured for it).
  const usdc = page.locator('[data-testid=passport-row][data-symbol="twUSDC"]');
  await expect(usdc).toContainText('1,000.00');
  await expect(usdc).not.toHaveAttribute('data-kind', 'bridged');
  await expect(usdc.locator('span.token-icon')).toHaveText('USDC');
  await expect(usdc.locator('img')).toHaveCount(0);

  // FR-022: X's Midnight icon on its row and its SPL icon on the Solana line, loaded from the site itself.
  const icons = x.locator('img.token-icon-img');
  await expect(icons).toHaveCount(2);
  for (const [i, file] of [
    [0, 'token-icons/x-midnight.png'],
    [1, 'token-icons/x.png'],
  ] as const) {
    await expect(icons.nth(i)).toHaveAttribute('src', file);
    await expect.poll(() => icons.nth(i).evaluate((e) => (e as HTMLImageElement).naturalWidth)).toBe(512);
    expect(await icons.nth(i).evaluate((e) => new URL((e as HTMLImageElement).currentSrc).origin)).toBe(
      await page.evaluate(() => location.origin),
    );
  }

  // Copy gives the whole mint address.
  await x.getByTestId('bridged-mint').getByRole('button').click();
  expect(await page.evaluate(() => (window as unknown as { __copied: string[] }).__copied)).toEqual([X.splMint]);

  // The Solana line was read on the site's Solana RPC; the injector never got a token-account read.
  expect(s.rpc.calls.filter((c) => c === 'getTokenAccountsByOwner').length).toBeGreaterThanOrEqual(2);
  expect(injector.filter((r) => (r.postData() ?? '').includes('getTokenAccountsByOwner'))).toEqual([]);

  // A Solana read that fails: "unavailable" and no total; the Midnight line stays.
  s.rpc.failing.add('getTokenAccountsByOwner');
  await page.getByTestId('refresh-balances').click();
  await expect(x.getByTestId('bridged-solana')).toHaveAttribute('data-state', 'unavailable');
  await expect(x.getByTestId('bridged-solana')).toContainText('Solana: unavailable');
  await expect(x.getByTestId('bridged-total')).toHaveCount(0);
  await expect(x.getByTestId('bridged-no-total')).toHaveText('No total');
  await expect(x.getByTestId('bridged-midnight')).toHaveText('10,000.00 (Private) on Midnight');
  // It reads again on the next refresh.
  s.rpc.failing.delete('getTokenAccountsByOwner');
  await page.getByTestId('refresh-balances').click();
  await expect(x.getByTestId('bridged-total')).toHaveText('100,000.00');
});

test('FR-023: exactly five actions, each opening its own flow; Show in my wallet on the right; no demo pack elsewhere', async ({
  page,
}) => {
  await portfolioSite(page);
  await openPortfolioPage(page);
  await expect(page.getByTestId('portfolio-action-label')).toHaveText(LABELS);
  await expect(page.getByTestId('portfolio-action')).toHaveCount(5);
  // Mint Solana tokens: this market does not offer it (FR-024 lands in its own lane).
  await expect(actionItem(page, 'mint-solana')).toHaveAttribute('data-enabled', 'false');
  await expect(actionItem(page, 'mint-solana')).toContainText('Not available on this market.');
  for (const id of ['send', 'bridge-in', 'bridge-out', 'mint-midnight'] as const)
    await expect(actionItem(page, id)).toHaveAttribute('data-enabled', 'true');
  // No form on the Portfolio itself: every form is inside a flow.
  await expect(page.locator('.area-stmt form').filter({ visible: true })).toHaveCount(0);
  // The right column: Show in my wallet and the pending items.
  await expect(page.locator('.area-side [data-testid=show-in-wallet-section]')).toBeVisible();
  await expect(page.locator('.area-side [data-testid=pending-box]')).toBeVisible();
  await expect(page.locator('.area-stmt [data-testid=show-in-wallet-section]')).toHaveCount(0);

  const flows = [
    ['send', 'withdraw-section'],
    ['bridge-in', 'bridge-in-section'],
    ['bridge-out', 'bridge-out-section'],
    ['mint-midnight', 'demo-tokens'],
  ] as const;
  for (const [id, section] of flows) {
    await openAction(page, id);
    await expect(page).toHaveURL(new RegExp(`#account\\?action=${id}$`));
    await expect(page.getByTestId(section)).toBeVisible();
    for (const [, other] of flows) if (other !== section) await expect(page.getByTestId(other)).toBeHidden();
    await expect(page.getByTestId('portfolio-actions')).toBeHidden();
    // The holdings, Show in my wallet and the pending items stay on every flow's page.
    await expect(page.getByTestId('passport-section')).toBeVisible();
    await expect(page.locator('.area-side [data-testid=show-in-wallet-section]')).toBeVisible();
    await expect(page.locator('.area-side [data-testid=pending-box]')).toBeVisible();
    await page.getByTestId('portfolio-back').click();
    await expect(page.getByTestId('portfolio-actions')).toBeVisible();
  }
  // Find my transfers is in the Bridge out flow.
  await openAction(page, 'bridge-out');
  await expect(page.getByTestId('bridge-out-find')).toBeVisible();

  // An action this market does not offer, by its address: its page says so.
  await page.goto('/#account?action=mint-solana');
  await expect(page.getByTestId('portfolio-action-unavailable')).toHaveText(
    'Mint Solana tokens: Not available on this market.',
  );

  // The free demo pack is offered only on the Portfolio (owner: "Keep Free demo tokens only in the Portfolio View").
  for (const tab of ['tab-markets', 'tab-trade']) {
    await page.getByTestId(tab).click();
    await expect(page.getByTestId('holdings-panel').first()).toBeAttached();
    await expect(page.getByTestId('demo-tokens')).toHaveCount(0);
    await expect(page.getByTestId('get-demo-tokens')).toHaveCount(0);
  }
});

test('FR-023: an open transfer stays one click away (the action says so), and its record is in the flow', async ({
  page,
}) => {
  test.setTimeout(60_000);
  const { s } = await portfolioSite(page);
  s.rpc.logsFor = () => [lockc(s, 5)];
  await openPortfolioPage(page);
  await openAction(page, 'bridge-in');
  await review(page, '500');
  await page.getByTestId('bridge-in-send').click();
  const record = page.getByTestId('bridge-in-record');
  await expect(record).toHaveAttribute('data-state', 'locked', { timeout: 15_000 });
  // Back on the list: Bridge in says a transfer is in progress; the flow keeps following it meanwhile.
  await page.getByTestId('portfolio-back').click();
  await expect(actionItem(page, 'bridge-in').getByTestId('portfolio-action-pending')).toHaveText(
    'One transfer in progress',
  );
  s.bridge.setTransfer(transferView({ id: 's2m:5', status: 'observed', recipient: ACCOUNT }));
  await openAction(page, 'bridge-in');
  await expect(record).toContainText('The bridge has seen the lock', { timeout: 15_000 });
});
