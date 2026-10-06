// AA 00060 P1 (T1.7): the dev-only wallet probe (G-NIGHTLY part A's page) with the mock wallet and the
// mock Solana RPC: it lists the wallet's features, signs every golden message plus the I-5 sample and
// the I-4 placeholder with verdict `ok`, sends a Memo both ways and sees each confirmed; its report
// carries no signature of any message. A hedged signer reads "identical: no". Without `devProbe: true`
// the route is the ordinary site.

import { readFileSync } from 'node:fs';

import { expect, test, type Page } from '@playwright/test';

import { asFetch } from '../mocks/http.js';
import { mockSolanaRpc, type MockSolanaRpc } from '../mocks/solana-rpc.js';
import { NIGHTLY_PROFILE, installMockWallet } from './mock-wallet.js';

const goldens = JSON.parse(readFileSync(new URL('../fixtures/messages-10b29b1.json', import.meta.url), 'utf8')) as {
  messages: { id: string; network: string; hex: string }[];
};
const RPC = 'http://solana-rpc.test/';
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type',
  'access-control-allow-methods': 'POST, GET, OPTIONS',
};

async function serveConfig(page: Page, devProbe: boolean) {
  // run-probe.sh places the goldens next to config.json; the bundle never carries them.
  await page.route('**/wallet-probe-goldens.json', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(goldens) }),
  );
  await page.route('**/config.json', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        network: 'undeployed',
        relayUrl: '',
        tokens: { mode: 'replace', tokens: [{ symbol: 'twUSDC', decimals: 6, midnightColour: 'a1'.repeat(32) }] },
        devProbe,
        solana: { rpcUrl: RPC, cluster: 'solana:localnet' },
      }),
    }),
  );
}

async function serveRpc(page: Page, rpc: MockSolanaRpc) {
  const f = asFetch(rpc.handler);
  await page.route(`${RPC}**`, async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const res = await f(RPC, { method: 'POST', body: req.postData() ?? '' });
    return route.fulfill({
      status: res.status,
      headers: { ...CORS, 'content-type': 'application/json' },
      body: await res.text(),
    });
  });
}

test('the probe lists the wallet, signs every message with verdict ok, and sends a Memo both ways', async ({
  page,
}) => {
  const rpc = mockSolanaRpc();
  const send = async (wire: string) => {
    const res = await asFetch(rpc.handler)(RPC, {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'sendTransaction',
        params: [wire, { encoding: 'base64' }],
      }),
    });
    const body = (await res.json()) as { result?: string; error?: { message: string } };
    if (!body.result) throw new Error(body.error?.message ?? 'send failed');
    return body.result;
  };
  const wallet = await installMockWallet(page, { profile: NIGHTLY_PROFILE, send });
  await serveConfig(page, true);
  await serveRpc(page, rpc);
  await page.goto('/#wallet-probe');
  await expect(page.getByTestId('wallet-probe')).toBeVisible();
  await expect(page.getByTestId('probe-genesis')).toHaveText(rpc.genesisHash);
  await expect(page.getByTestId('probe-via-Nightly')).toHaveText('wallet-standard');

  await page.getByTestId('probe-connect-Nightly').click();
  await page.getByTestId('probe-sign-all').click();
  await expect(page.getByTestId('probe-landing-identical')).toHaveText('yes', { timeout: 30_000 });
  await expect(page.getByTestId('probe-landing-verdicts')).toHaveText('ok, ok');
  const undeployed = goldens.messages.filter((m) => m.network === 'undeployed');
  for (const m of undeployed) await expect(page.getByTestId(`probe-verdict-golden:${m.id}`)).toHaveText('ok');
  await expect(page.getByTestId('probe-verdict-i4-placeholder')).toHaveText('ok');
  // 10 goldens + the I-4 placeholder + the I-5 sample twice; each exactly the bytes shown.
  const messages = wallet.requests.filter((r) => r.kind === 'signMessage');
  expect(messages).toHaveLength(undeployed.length + 3);
  for (const m of undeployed) expect(messages.some((r) => Buffer.from(r.bytes).toString('hex') === m.hex)).toBe(true);
  expect(Buffer.from(messages.at(-1)!.bytes).toString('latin1')).toMatch(
    /^Night Market landing key v1\nSign this only on: http:\/\/127\.0\.0\.1:\d+\n/,
  );

  await page.getByTestId('probe-sign-and-send').click();
  await expect(page.getByTestId('probe-txs')).toContainText('solana:signAndSendTransaction: confirmed', {
    timeout: 30_000,
  });
  await page.getByTestId('probe-sign-then-send').click();
  await expect(page.getByTestId('probe-txs')).toContainText('solana:signTransaction: confirmed', { timeout: 30_000 });
  expect(rpc.sent).toHaveLength(2);
  expect(wallet.requests.filter((r) => r.kind !== 'signMessage').map((r) => r.chain)).toEqual([
    'solana:localnet',
    'solana:localnet',
  ]);

  const report = JSON.parse(await page.getByTestId('probe-report').inputValue()) as {
    wallets: { name: string; features: Record<string, string> }[];
    siteDiscovery: { name: string; via: string }[];
    messages: { verdict: string }[];
    landingKey: { identical: boolean };
    transactions: { ok: boolean; walletChangedTransaction: boolean }[];
  };
  expect(report.wallets[0]!.name).toBe('Nightly');
  expect(Object.keys(report.wallets[0]!.features)).toContain('solana:signAndSendTransaction');
  expect(report.siteDiscovery).toEqual([{ name: 'Nightly', via: 'wallet-standard' }]);
  expect(report.messages.every((m) => m.verdict === 'ok')).toBe(true);
  expect(report.landingKey.identical).toBe(true);
  expect(report.transactions.map((t) => t.ok)).toEqual([true, true]);
  // No message signature leaks into the report (the I-5 signature is a secret key).
  const text = await page.getByTestId('probe-report').inputValue();
  const messageSignatures = wallet.signatures.slice(0, messages.length);
  for (const s of messageSignatures) {
    expect(text).not.toContain(s);
    expect(text).not.toContain(Buffer.from(s, 'hex').toString('base64'));
  }
});

test('a hedged signer: the I-5 sample reads "identical: no"', async ({ page }) => {
  const rpc = mockSolanaRpc();
  const wallet = await installMockWallet(page, { profile: NIGHTLY_PROFILE });
  wallet.mode = 'hedged';
  await serveConfig(page, true);
  await serveRpc(page, rpc);
  await page.goto('/#wallet-probe');
  await page.getByTestId('probe-connect-Nightly').click();
  await page.getByTestId('probe-landing').getByRole('button', { name: 'Sign twice' }).click();
  await expect(page.getByTestId('probe-landing-identical')).toHaveText('no');
  await expect(page.getByTestId('probe-landing-verdicts')).toHaveText('ok, ok');
});

test('without devProbe the route is the ordinary site', async ({ page }) => {
  await installMockWallet(page, { profile: NIGHTLY_PROFILE });
  await serveConfig(page, false);
  await page.goto('/#wallet-probe');
  await expect(page.getByTestId('network-name')).toBeVisible();
  await expect(page.getByTestId('wallet-probe')).toHaveCount(0);
});
