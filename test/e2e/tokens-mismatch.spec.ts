// AA 00060 P4 (T4.3, T4.5): the site's and the market's token lists must agree, and a bridge registry
// must be for the site's networks.
//   - T4.3: the mock relay publishes ANOTHER token-list digest: the page says so everywhere, and no
//     signed action reaches the wallet (opening an account, demo tokens, a withdrawal, an offer); with
//     the SAME digest nothing is shown and an account opens.
//   - T4.5: a journey registry for another Solana genesis hash, or another Midnight network, makes the
//     page refuse bridging with a reason.

import { readFileSync } from 'node:fs';

import { expect, test, type Page } from '@playwright/test';

import { tokensDigest } from '../../packages/core/src/tokens/digest.js';
import { asFetch } from '../mocks/http.js';
import { mockSolanaRpc } from '../mocks/solana-rpc.js';
import { connectPhantom } from './mock-phantom.js';
import { setup } from './wallet-fixtures.js';

// The site's list here is stagenet's built-in one: the vendored mint-test-tokens registry, each token's
// active deployment (as packages/core/src/tokens/registry.ts reads it; that module's JSON import does not
// load under Playwright's runner, so the file is read here).
const stagenetRecord = JSON.parse(
  readFileSync(
    new URL('../../packages/core/src/tokens/mint-test-tokens/metadata.stagenet.json', import.meta.url),
    'utf8',
  ),
) as {
  tokens: {
    symbol: string;
    decimals: number;
    privacy: 'shielded' | 'unshielded';
    activeDeploymentId: string;
    deployments: { deploymentId: string; status: string; tokenId: string }[];
  }[];
};
const siteDigest = tokensDigest({
  tokens: stagenetRecord.tokens.map((t) => {
    const d = t.deployments.find((x) => x.deploymentId === t.activeDeploymentId && x.status === 'active')!;
    return { symbol: t.symbol, decimals: t.decimals, privacy: t.privacy, midnightColour: d.tokenId } as never;
  }),
});

test('T4.3: another token list at the market pauses every signed action before the wallet is asked', async ({
  page,
}) => {
  const { phantom, relay } = await setup(page, { seeded: true });
  relay.tokensDigest = 'ab'.repeat(32);
  await page.goto('/#account');
  await connectPhantom(page);
  await expect(page.getByTestId('market-tokens-mismatch')).toBeVisible();
  await expect(page.getByTestId('market-tokens-mismatch')).toContainText(
    'This site and the market list different tokens.',
  );
  // Every signed action the page offers here: none may reach the wallet.
  for (const id of ['get-demo-tokens', 'withdraw-submit', 'secure-change']) {
    const b = page.getByTestId(id);
    if ((await b.count()) > 0 && (await b.first().isEnabled())) await b.first().click();
  }
  await page.getByTestId('tab-trade').click();
  const make = page.getByTestId('make-submit');
  if ((await make.count()) > 0 && (await make.first().isEnabled())) await make.first().click();
  await page.waitForTimeout(500);
  expect(phantom.requests).toHaveLength(0);
  expect(relay.submitted).toHaveLength(0);
});

test('T4.3: opening an account under another token list asks the wallet nothing', async ({ page }) => {
  const { phantom, relay } = await setup(page);
  relay.tokensDigest = 'cd'.repeat(32);
  await page.goto('/#account');
  await connectPhantom(page);
  await expect(page.getByTestId('market-tokens-mismatch')).toBeVisible();
  const open = page.getByTestId('open-account');
  if (await open.isEnabled()) await open.click();
  await page.waitForTimeout(500);
  expect(phantom.requests).toHaveLength(0);
  expect(relay.submitted).toHaveLength(0);
});

test('T4.3: the same token list shows nothing, and an account opens with one approval', async ({ page }) => {
  const { phantom, relay } = await setup(page);
  relay.tokensDigest = siteDigest;
  await page.goto('/#account');
  await connectPhantom(page);
  await page.getByTestId('open-account').click();
  await expect(page.getByTestId('accounts-message')).toContainText('is open');
  await expect(page.getByTestId('market-tokens-mismatch')).toHaveCount(0);
  expect(phantom.requests).toHaveLength(1);
});

const RPC = 'http://solana-rpc.test/';
async function bridgeSite(page: Page, journey: Record<string, unknown>, genesis: string) {
  const rpc = mockSolanaRpc({ genesisHash: genesis });
  const f = asFetch(rpc.handler);
  await page.route(`${RPC}**`, async (route) => {
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const res = await f(RPC, { method: 'POST', body: route.request().postData() ?? '' });
    return route.fulfill({
      status: 200,
      headers: { ...cors, 'content-type': 'application/json' },
      body: await res.text(),
    });
  });
  await page.route('**/config.json', (r) =>
    r.fulfill({
      json: {
        network: 'undeployed',
        relayUrl: '',
        tokens: { mode: 'replace', tokens: [{ symbol: 'twUSDC', decimals: 6, midnightColour: 'a1'.repeat(32) }] },
        solana: { rpcUrl: RPC, cluster: 'solana:localnet' },
        bridges: journey,
      },
    }),
  );
}
const journey = () =>
  JSON.parse(readFileSync(new URL('../fixtures/journey-registry.undeployed.json', import.meta.url), 'utf8')) as Record<
    string,
    unknown
  >;

test('T4.5: a registry for another Solana network: bridging is refused, with the reason', async ({ page }) => {
  await bridgeSite(page, journey(), '11111111111111111111111111111111');
  await page.goto('/#account');
  await expect(page.getByTestId('bridge-unavailable')).toHaveText(
    "Bridging is unavailable: the token registry is for another Solana network than the site's Solana RPC.",
  );
});

test('T4.5: a registry for another Midnight network: bridging is refused, with the reason', async ({ page }) => {
  const j = journey();
  await bridgeSite(page, { ...j, midnightNetwork: 'stagenet' }, String(j.solanaGenesisHash));
  await page.goto('/#account');
  await expect(page.getByTestId('bridge-unavailable')).toHaveText(
    "Bridging is unavailable: the token registry is for another Midnight network than this site's (undeployed).",
  );
});

test('T4.5: the right networks: no notice', async ({ page }) => {
  const j = journey();
  await bridgeSite(page, j, String(j.solanaGenesisHash));
  await page.goto('/#account');
  await page.waitForTimeout(800);
  await expect(page.getByTestId('bridge-unavailable')).toHaveCount(0);
});
