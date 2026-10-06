// AA 00060 P8 (T8.1-T8.4, T8.6): "Show in my wallet" in the browser, against the mock injector (I-4,
// FROZEN by 00059 @ f4d215c) on its own origin, with the mock Phantom and a seeded stagenet account.
//
//   T8.1 the body the injector receives is I-4's five fields and the text is I-4's · T8.2 the disclosure
//   comes first; Cancel asks the wallet nothing and sends nothing · T8.3 an I-4 error in plain words, not
//   retried · T8.4 stale-key → Register again → a new prompt and a new POST · T8.6 the viewing key goes
//   only to the configured injector, in exactly one request.

import { expect, test, type Page, type Request } from '@playwright/test';

import { REGISTRATION_FIRST_LINE } from '../../packages/core/src/bridge/injector.js';
import { asFetch } from '../mocks/http.js';
import { mockInjector, type MockInjector } from '../mocks/injector.js';
import { INDEXER_OVERRIDE } from './mock-indexer.js';
import { connectPhantom, type MockPhantom } from './mock-phantom.js';
import { ACCOUNT, RELAY } from './mock-relay.js';
import { setup } from './wallet-fixtures.js';

const INJECTOR = 'http://injector.test';

async function site(page: Page): Promise<{ phantom: MockPhantom; inj: MockInjector; requests: Request[] }> {
  const { phantom } = await setup(page, { seeded: true });
  const inj = mockInjector({ origin: INJECTOR, networkId: 'stagenet' });
  const f = asFetch(inj.handler);
  await page.route(`${INJECTOR}/**`, async (route) => {
    const r = route.request();
    if (r.method() === 'OPTIONS') {
      return route.fulfill({
        status: 204,
        headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type' },
      });
    }
    const res = await f(r.url(), { method: r.method(), ...(r.postData() ? { body: r.postData()! } : {}) });
    const headers: Record<string, string> = { 'access-control-allow-origin': '*' };
    res.headers.forEach((v, k) => (headers[k] = v));
    return route.fulfill({ status: res.status, headers, body: await res.text() });
  });
  // The site names the injector (registered after setup's own config route, so it wins).
  await page.route('**/config.json', (r) =>
    r.fulfill({
      json: {
        network: 'stagenet',
        relayUrl: RELAY,
        overrides: INDEXER_OVERRIDE,
        walletTimeoutSeconds: 20,
        injector: { url: `${INJECTOR}/` },
      },
    }),
  );
  const requests: Request[] = [];
  page.on('request', (r) => requests.push(r));
  return { phantom, inj, requests };
}

async function open(page: Page) {
  await page.goto('/#account');
  await connectPhantom(page);
  await expect(page.getByTestId('account-check')).toHaveAttribute('data-state', 'ok');
  await expect(page.getByTestId('show-in-wallet-section')).toBeVisible();
}

/** The account's viewing key, as this browser keeps it (the seeded secret record). */
const viewingKey = (page: Page) =>
  page.evaluate(() => {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)!;
      if (k.endsWith('/secret'))
        return (JSON.parse(localStorage.getItem(k)!) as { data: { encSecretKey: string } }).data.encSecretKey;
    }
    return null;
  });

const toInjector = (requests: Request[]) => requests.filter((r) => r.url().startsWith(INJECTOR));

test('T8.2: the disclosure comes first; Cancel asks the wallet nothing and sends nothing', async ({ page }) => {
  const s = await site(page);
  await open(page);
  await expect(page.getByTestId('show-in-wallet-origin')).toHaveText(INJECTOR);
  await page.getByTestId('show-in-wallet-start').click();
  const d = page.getByTestId('show-in-wallet-disclosure');
  await expect(d).toBeVisible();
  await expect(d).toContainText("your account's viewing key");
  await expect(d).toContainText(`the RPC at ${INJECTOR}, and no one else`);
  await expect(d).toContainText('It cannot spend or move anything');
  await page.getByTestId('show-in-wallet-cancel').click();
  await expect(d).toBeHidden();
  await page.waitForTimeout(300);
  expect(s.phantom.requests).toHaveLength(0);
  expect(s.inj.posts).toHaveLength(0);
  expect(toInjector(s.requests)).toHaveLength(0);
});

test('T8.1 / T8.6: one signature over I-4’s text, one POST with the five fields; the key goes nowhere else', async ({
  page,
}) => {
  const s = await site(page);
  s.inj.setStatus('syncing', 2);
  await open(page);
  const key = await viewingKey(page);
  expect(key).toMatch(/^[0-9a-f]{64}$/);
  await page.getByTestId('show-in-wallet-start').click();
  const release = s.phantom.holdNext();
  await page.getByTestId('show-in-wallet-continue').click();
  // The signing panel says what this text is.
  await expect(page.getByTestId('sign-prompt-kind')).toHaveAttribute('data-kind', 'rpc-registration');
  await expect(page.getByTestId('sign-prompt-text')).toContainText(REGISTRATION_FIRST_LINE);
  release();
  await expect(page.getByTestId('show-in-wallet-status')).toHaveAttribute('data-status', 'syncing');
  await expect(page.getByTestId('show-in-wallet-unseen')).toHaveAttribute('data-count', '2');
  await expect(page.getByTestId('show-in-wallet-url')).toHaveText(INJECTOR);
  // The wallet was asked once, for exactly I-4's text naming this injector, wallet and account.
  expect(s.phantom.requests).toHaveLength(1);
  const text = s.phantom.requests[0]!.text;
  const lines = text.split('\n');
  expect(lines[0]).toBe(REGISTRATION_FIRST_LINE);
  expect(lines.slice(2, 6)).toEqual([
    `RPC ${INJECTOR}`,
    'Midnight network stagenet',
    `Wallet ${s.phantom.address}`,
    `Account ${ACCOUNT}`,
  ]);
  // One POST, the five fields.
  expect(s.inj.posts).toHaveLength(1);
  expect(s.inj.posts[0]).toMatchObject({
    solanaAddress: s.phantom.address,
    accountAddress: ACCOUNT,
    accountViewingKey: key,
    message: text,
  });
  expect(Object.keys(s.inj.posts[0] as object).sort()).toEqual(
    ['accountAddress', 'accountViewingKey', 'message', 'signature', 'solanaAddress'].sort(),
  );
  // T8.6: of every request the page made, exactly one carries the viewing key: that POST.
  const carrying = s.requests.filter((r) => `${r.url()} ${r.postData() ?? ''}`.includes(key!));
  expect(carrying.map((r) => [r.method(), r.url()])).toEqual([['POST', `${INJECTOR}/api/accounts`]]);
  // The status is followed until synced.
  s.inj.setStatus('synced');
  await expect(page.getByTestId('show-in-wallet-status')).toHaveAttribute('data-status', 'synced', { timeout: 10_000 });
  await expect(page.getByTestId('show-in-wallet-unseen')).toHaveCount(0);
});

test('T8.3: an I-4 error is shown in plain words and not retried', async ({ page }) => {
  const s = await site(page);
  await open(page);
  s.inj.failNext('not-a-device');
  await page.getByTestId('show-in-wallet-start').click();
  await page.getByTestId('show-in-wallet-continue').click();
  await expect(page.getByTestId('show-in-wallet-error')).toHaveText(
    'The RPC says your wallet is not a device of this account.',
  );
  await page.waitForTimeout(1_000);
  expect(s.inj.posts).toHaveLength(1);
  expect(s.phantom.requests).toHaveLength(1);
});

test('T8.4: stale-key → Register again → a new prompt and a new POST', async ({ page }) => {
  const s = await site(page);
  await open(page);
  await page.getByTestId('show-in-wallet-start').click();
  await page.getByTestId('show-in-wallet-continue').click();
  await expect(page.getByTestId('show-in-wallet-status')).toHaveAttribute('data-status', 'synced');
  s.inj.setStatus('stale-key');
  await page.getByTestId('show-in-wallet-check').click();
  await expect(page.getByTestId('show-in-wallet-status')).toHaveAttribute('data-status', 'stale-key');
  await expect(page.getByTestId('show-in-wallet-status')).toContainText('Register again');
  s.inj.setStatus('synced');
  await page.getByTestId('show-in-wallet-again').click();
  await expect(page.getByTestId('show-in-wallet-disclosure')).toBeVisible();
  await page.getByTestId('show-in-wallet-continue').click();
  await expect(page.getByTestId('show-in-wallet-status')).toHaveAttribute('data-status', 'synced');
  expect(s.phantom.requests).toHaveLength(2);
  expect(s.inj.posts).toHaveLength(2);
});

test('an injector that claims another origin: refused before the wallet is asked', async ({ page }) => {
  const { phantom } = await setup(page, { seeded: true });
  const inj = mockInjector({ origin: 'http://elsewhere.test', networkId: 'stagenet' });
  const f = asFetch(inj.handler);
  await page.route(`${INJECTOR}/**`, async (route) => {
    const res = await f(route.request().url(), { method: route.request().method() });
    return route.fulfill({
      status: res.status,
      headers: { 'access-control-allow-origin': '*' },
      body: await res.text(),
    });
  });
  await page.route('**/config.json', (r) =>
    r.fulfill({
      json: { network: 'stagenet', relayUrl: RELAY, overrides: INDEXER_OVERRIDE, injector: { url: INJECTOR } },
    }),
  );
  await open(page);
  await page.getByTestId('show-in-wallet-start').click();
  await page.getByTestId('show-in-wallet-continue').click();
  await expect(page.getByTestId('show-in-wallet-error')).toContainText(`says it is http://elsewhere.test`);
  expect(phantom.requests).toHaveLength(0);
  expect(inj.posts).toHaveLength(0);
});

test('no injector configured: no panel, and no request to any injector', async ({ page }) => {
  const { phantom } = await setup(page, { seeded: true });
  await page.goto('/#account');
  await connectPhantom(page);
  await expect(page.getByTestId('account-check')).toHaveAttribute('data-state', 'ok');
  await expect(page.getByTestId('show-in-wallet-section')).toHaveCount(0);
  expect(phantom.requests).toHaveLength(0);
});
