// AA 00062 P4 (spec US1-US3, FR-008-FR-013; plan I-62a, I-62b, R4): the customer's own prover, in the
// browser, with the mock relay in `CLIENT_PROVING=required` (./mock-relay.ts) and a mock of the prover
// package (./mock-prover.ts).
//
//   - Local Data (the tab formerly "Your data"): "Proof server (optional)", Test pass and fail (nothing
//     listening, another version, another key set, not the package), the browser's local-network
//     permission denied, Forget, and the setting kept out of the backup file;
//   - the URL rules: an http URL that is not this computer is refused; an https one needs the privacy
//     confirmation;
//   - the popup: only for the k>=18 actions, before anything is signed or sent, with the owner's words,
//     the command, the URL, Test, and Continue after a pass; then "Proving on your prover…", the hand-off
//     answered with exactly what the market asked, and the action done;
//   - a saved prover that passes: no popup; one that fails at action time: the popup with the reason;
//   - no popup for opening an account, demo tokens, Bridge in or a key restore;
//   - the prover fails mid-action (out of memory), the market refuses the proof, or it comes too late;
//   - a stale call (I-62a v2, "prove first"): the same signed request is sent again once on its own;
//   - the Content-Security-Policy: the prover sources work, and nothing else new is allowed.

import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

import { formatShieldedAddress } from '../../packages/core/src/shielded-address.js';
import { formatUnshieldedAddress } from '../../packages/core/src/unshielded.js';
import { COLOUR } from '../../packages/core/test/fixtures/kernel/book.js';
import { encodeRecord } from '../../web/src/store/schema.js';
import { X, bridgeSite, lockc, openPortfolio, review } from './bridge-fixtures.js';
import { connectPhantom } from './mock-phantom.js';
import { INDEXER } from './mock-indexer.js';
import { MockProver } from './mock-prover.js';
import { KEY_SET, RELAY } from './mock-relay.js';
import { openAction } from './portfolio-fixtures.js';
import { setup } from './wallet-fixtures.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
const SHOTS = process.env.PROVER_SHOTS_DIR ?? `${root}/test-results/prover`;
mkdirSync(SHOTS, { recursive: true });

const LOCAL = 'http://localhost:6300';
const ONLINE = 'https://prover.test';
const PROVER_KEY = 'night-market/v1/_global/settings/prover';
const KERNEL = 'https://stagenet.api-zswap.zkdojo.com';
const PROVER_SOURCES = ['http://localhost:*', 'http://127.0.0.1:*', 'https:'];

const holding = (page: Page, symbol: string, kind = 'shielded') =>
  page.locator(`[data-testid=holding][data-symbol="${symbol}"][data-kind="${kind}"]`);

/** A saved prover setting in this browser (seeded once per tab), as the page writes it. */
async function seedProver(page: Page, url: string, ok = true) {
  const value = encodeRecord(
    'settings',
    {
      url,
      privacyConfirmed: false,
      lastTest: { ok, at: Date.now(), package: '0.1.0-e2e', proofServer: '9.0.0-rc.8', keySet: KEY_SET, problem: null },
    },
    Date.now(),
  );
  await page.addInitScript(
    ([k, v]) => {
      if (sessionStorage.getItem('nm-e2e-prover-seeded')) return;
      localStorage.setItem(k!, v!);
      sessionStorage.setItem('nm-e2e-prover-seeded', '1');
    },
    [PROVER_KEY, value],
  );
}

const storedKeys = (page: Page) =>
  page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('night-market/')));

async function makeOffer(page: Page) {
  await page.getByTestId('side-sell').click();
  await page.getByTestId('make-quantity').fill('0.05');
  await page.getByTestId('make-price').fill('60000');
  await page.getByTestId('make-sign').click();
}

test.describe('Local Data: "Proof server (optional)"', () => {
  test('the rename, the section, Test pass and fail, Forget, and never in the backup file', async ({ page }) => {
    const { relay, phantom } = await setup(page, { seeded: true });
    relay.clientProving = 'required';
    const prover = new MockProver(LOCAL);
    await prover.install(page);
    const other = new MockProver('http://127.0.0.1:6399');
    other.mode = 'down';
    await other.install(page);
    await page.goto('/#account');
    await connectPhantom(page);
    await expect(page.locator('[data-testid=passport-row][data-symbol="twBTC"]')).toContainText('0.10');

    // The tab is "Local Data" everywhere (nav, wallet menu, the page's title), at the same route.
    await expect(page.getByTestId('tab-local')).toHaveText(/Local Data/);
    await page.getByTestId('wallet-connected').click();
    await expect(page.getByTestId('account-menu').getByRole('menuitem', { name: 'Local Data' })).toHaveAttribute(
      'href',
      '#local',
    );
    await page.getByTestId('account-menu').getByRole('menuitem', { name: 'Local Data' }).click();
    await expect(page.getByRole('heading', { level: 2, name: 'Local Data' })).toBeVisible();
    await expect(page.getByText('Your data', { exact: true })).toHaveCount(0);

    const section = page.getByTestId('prover-section');
    await expect(section).toContainText('Proof server (optional)');
    await expect(page.getByTestId('prover-market-mode')).toHaveAttribute('data-mode', 'required');
    await expect(page.getByTestId('prover-none')).toBeVisible();
    await expect(page.getByTestId('prover-command')).toHaveText(
      'docker run --rm -p 127.0.0.1:6300:6300 --memory 12g ghcr.io/midnight-experiments/solana-proof-server:<pending>',
    );
    await expect(page.getByTestId('prover-url')).toHaveValue(LOCAL);

    // Test passes: reachable, the version, the key set, the circuits, and the machine.
    await page.getByTestId('prover-test').click();
    await expect(page.getByTestId('prover-verdict')).toHaveAttribute('data-ok', 'true');
    for (const id of ['reach', 'version', 'key-set', 'circuits'])
      await expect(page.locator(`[data-testid=prover-check][data-id="${id}"]`)).toHaveAttribute('data-ok', 'true');
    await expect(page.locator('[data-testid=prover-check][data-id="machine"]')).toContainText('12 CPUs');
    await expect(page.getByTestId('prover-saved-url')).toHaveText(LOCAL);
    await expect(page.getByTestId('prover-last-result')).toHaveAttribute('data-ok', 'true');
    expect(await storedKeys(page)).toContain(PROVER_KEY);
    // Only the page called the prover, and only its /version (with the page's origin, for CORS).
    expect(prover.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /version']);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: `${SHOTS}/local-data-proof-server.png`, fullPage: true });

    // Test fails, with the reason in plain words: nothing listening.
    await page.getByTestId('prover-url').fill('http://127.0.0.1:6399');
    await page.getByTestId('prover-test').click();
    await expect(page.getByTestId('prover-verdict')).toHaveAttribute('data-ok', 'false');
    await expect(page.locator('[data-testid=prover-check][data-id="reach"]')).toContainText(
      'Your proof server did not answer at http://127.0.0.1:6399',
    );
    await expect(page.getByTestId('prover-last-result')).toHaveAttribute('data-ok', 'false');
    // Another version, another key set, and not the package at all.
    await page.getByTestId('prover-url').fill(LOCAL);
    for (const [mode, id, words] of [
      [
        'wrong-version',
        'version',
        'another proof-server version (proof server 9.0.0-rc.6); the market needs 9.0.0-rc.8',
      ],
      ['wrong-key-set', 'key-set', 'another key set (key set ffffffff…ffff); the market needs 21493588…5c5e'],
    ] as const) {
      prover.mode = mode;
      await page.getByTestId('prover-test').click();
      const line = page.locator(`[data-testid=prover-check][data-id="${id}"]`);
      await expect(line).toHaveAttribute('data-ok', 'false');
      await expect(line).toContainText(words);
      await expect(line).toContainText('Update the package: docker run');
    }
    prover.mode = 'plain';
    await page.getByTestId('prover-test').click();
    await expect(page.locator('[data-testid=prover-check][data-id="reach"]')).toContainText(
      'it is not the Night Market prover package',
    );
    prover.mode = 'ok';
    await page.getByTestId('prover-test').click();
    await expect(page.getByTestId('prover-verdict')).toHaveAttribute('data-ok', 'true');

    // The backup file never holds it (owner Q3).
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export').click()]);
    const exported = JSON.parse(await readFile((await download.path())!, 'utf8'));
    expect(exported.owner).toBe(phantom.deviceKey);
    expect(JSON.stringify(exported)).not.toContain('settings/prover');
    expect(JSON.stringify(exported)).not.toContain('localhost:6300');

    // Forget: gone from this browser.
    await page.getByTestId('prover-forget').click();
    await expect(page.getByTestId('prover-none')).toContainText('Forgotten');
    expect(await storedKeys(page)).not.toContain(PROVER_KEY);
    await expect(page.getByTestId('prover-forget')).toBeDisabled();
  });

  test('URL rules: an http URL off this computer is refused; an https one needs the privacy confirmation', async ({
    page,
  }) => {
    await setup(page);
    const online = new MockProver(ONLINE);
    await online.install(page);
    const plain = new MockProver('http://prover.test:6300');
    await plain.install(page);
    await page.goto('/#local');
    await expect(page.getByTestId('prover-section')).toBeVisible();

    await page.getByTestId('prover-url').fill('http://prover.test:6300');
    await expect(page.getByTestId('prover-url-error')).toContainText('An online proof server must use https://');
    await expect(page.getByTestId('prover-test')).toBeDisabled();
    await page.getByTestId('prover-url').fill('http://[::1]:6300');
    await expect(page.getByTestId('prover-url-error')).toBeVisible();
    await page.getByTestId('prover-url').fill('ftp://prover.test');
    await expect(page.getByTestId('prover-url-error')).toBeVisible();
    expect(plain.calls).toEqual([]);

    await page.getByTestId('prover-url').fill(`${ONLINE}/`);
    await expect(page.getByTestId('prover-privacy')).toContainText('sees the private details of every transaction');
    await expect(page.getByTestId('prover-test')).toBeDisabled();
    await page.getByTestId('prover-privacy-confirm').check();
    await page.getByTestId('prover-test').click();
    await expect(page.getByTestId('prover-verdict')).toHaveAttribute('data-ok', 'true');
    await expect(page.getByTestId('prover-saved-url')).toHaveText(ONLINE);
    const stored = await page.evaluate((k) => JSON.parse(localStorage.getItem(k)!), PROVER_KEY);
    expect(stored.data).toMatchObject({ url: ONLINE, privacyConfirmed: true, lastTest: { ok: true } });
    expect(online.calls.filter((c) => c.method === 'GET').map((c) => c.path)).toEqual(['/version']);
    expect(plain.calls).toEqual([]);
  });

  test('the browser blocks localhost (the local-network permission is denied): said plainly, nothing is called', async ({
    page,
    baseURL,
  }) => {
    await setup(page);
    // The page on a name that is not this computer's, so the browser's local-network rules apply (R4).
    // (Registered after setup: it answers before setup's "nothing leaves the page" route; config.json
    // falls through to setup's.)
    await page.route('http://market.test/**', async (route) => {
      const u = new URL(route.request().url());
      if (u.pathname === '/config.json') return route.fallback();
      const response = await route.fetch({ url: `${baseURL}${u.pathname}${u.search}` });
      await route.fulfill({ response });
    });
    const prover = new MockProver(LOCAL);
    await prover.install(page);
    await page.addInitScript(() => {
      const perms = navigator.permissions;
      const query = perms.query.bind(perms);
      perms.query = (d: PermissionDescriptor) =>
        (d as { name: string }).name === 'loopback-network'
          ? Promise.resolve({ state: 'denied' } as PermissionStatus)
          : query(d);
    });
    await page.goto('http://market.test/#local');
    await page.getByTestId('prover-test').click();
    await expect(page.getByTestId('prover-verdict')).toHaveAttribute('data-ok', 'false');
    await expect(page.locator('[data-testid=prover-check][data-id="reach"]')).toContainText(
      'Your browser blocks this site from reaching apps on this computer (localhost)',
    );
    await expect(page.locator('[data-testid=prover-check][data-id="reach"]')).toContainText('online proof server');
    expect(prover.calls).toEqual([]);
  });
});

test.describe('the popup, and the proof on the customer’s prover', () => {
  test('a make: the popup BEFORE anything is signed; Test; Continue; proving on the prover; the offer listed', async ({
    page,
  }) => {
    const { phantom, relay } = await setup(page, { seeded: true });
    relay.clientProving = 'required';
    const prover = new MockProver(LOCAL);
    await prover.install(page);
    await page.goto(`/#trade?pair=${encodeURIComponent('twBTC/twUSDC')}`);
    await connectPhantom(page);
    await expect(holding(page, 'twBTC')).toContainText('0.10');
    await makeOffer(page);

    const popup = page.getByTestId('prover-popup');
    await expect(popup).toBeVisible();
    await expect(page.getByTestId('prover-popup-text')).toHaveText(
      'You need to prove the ZK transaction. About 12 GB of memory are needed for this operation. You can start your own local proof server by running this command, or get an online ZK proof server and paste its URL.',
    );
    await expect(page.getByTestId('prover-popup-demo')).toHaveText(
      'This is a tech demo; on a real network this will be provided.',
    );
    await expect(page.getByTestId('prover-popup-command')).toContainText('-p 127.0.0.1:6300:6300 --memory 12g');
    await expect(page.getByTestId('prover-popup-url')).toHaveValue(LOCAL);
    await expect(page.getByTestId('prover-popup-action')).toHaveAttribute(
      'data-circuit',
      'open_swap_shielded_with_ed25519',
    );
    await expect(page.getByTestId('prover-popup-continue')).toBeDisabled();
    // Nothing signed, nothing sent, the prover not called yet.
    expect(phantom.requests).toHaveLength(0);
    expect(relay.submitted).toHaveLength(0);
    expect(prover.calls).toEqual([]);
    await page.screenshot({ path: `${SHOTS}/popup.png` });
    // WCAG 2.2 AA, as the rest of the site (test/e2e/a11y.spec.ts), once its animations have ended.
    await page.evaluate(() =>
      Promise.all(
        document
          .getAnimations()
          .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
          .map((a) => a.finished.catch(() => undefined)),
      ),
    );
    const axe = await new AxeBuilder({ page })
      .include('[data-testid=prover-popup]')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(axe.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);

    await page.getByTestId('prover-popup-test').click();
    await expect(page.getByTestId('prover-popup-verdict')).toHaveAttribute('data-ok', 'true');
    await expect(page.getByTestId('prover-popup-continue')).toBeEnabled();
    await page.screenshot({ path: `${SHOTS}/popup-test-passed.png` });
    // Changing the URL after a pass needs a new Test.
    await page.getByTestId('prover-popup-url').fill('http://localhost:6301');
    await expect(page.getByTestId('prover-popup-continue')).toBeDisabled();
    await page.getByTestId('prover-popup-url').fill(LOCAL);
    await expect(page.getByTestId('prover-popup-continue')).toBeEnabled();

    const release = prover.holdNext();
    await page.getByTestId('prover-popup-continue').click();
    await expect(popup).toHaveCount(0);
    // The wallet signs once; the market hands the proof to the customer's prover.
    await expect(page.getByTestId('activity-stage')).toHaveText('Proving on your prover…');
    await expect(page.getByTestId('activity-client-proof')).toContainText(`Your proof server at ${LOCAL}`);
    await expect(page.getByTestId('activity-elapsed')).toHaveText(/^0:0\d$/);
    await page.screenshot({ path: `${SHOTS}/proving-on-your-prover.png` });
    expect(phantom.requests).toHaveLength(1);
    release();
    await expect(page.getByTestId('trade-message')).toContainText('Your offer is listed on the market');

    // The prover got exactly what the market handed out, and the market got the prover's proof.
    expect(relay.handOffs).toHaveLength(1);
    const h = relay.handOffs[0]!;
    expect(prover.proofs).toEqual([
      { circuit: h.circuit, proofRequest: h.proofRequest, keyMaterialOffset: h.keyMaterialOffset },
    ]);
    expect(h).toMatchObject({ circuit: 'open_swap_shielded_with_ed25519', fetched: true, verdict: 'checked' });
    expect(Buffer.from(h.proof!, 'base64').toString('latin1')).toMatch(/^midnight:proof-versioned:/);
    expect(relay.submitted.map((s) => [s.action, s.verified])).toEqual([['open-swap', 'ok']]);
    // The prover saw the page's origin (CORS) and nothing but /version and /prove-circuit.
    expect([...new Set(prover.calls.map((c) => c.path))].sort()).toEqual(['/prove-circuit', '/version']);
  });

  test('a saved prover that passes: no popup for a take, a withdrawal and its change, an unshielded withdrawal', async ({
    page,
  }) => {
    const { phantom, relay } = await setup(page, { seeded: true });
    relay.clientProving = 'required';
    await seedProver(page, LOCAL);
    const prover = new MockProver(LOCAL);
    await prover.install(page);

    await page.goto(`/#trade?pair=${encodeURIComponent('twETH/twBTC')}`);
    await connectPhantom(page);
    await expect(holding(page, 'twETH')).toContainText('1.00');
    await page.getByTestId('trade-book-bids').getByTestId('take-line').first().click();
    await page.getByTestId('take-sign').click();
    await expect(page.getByTestId('trade-message')).toContainText('settled in one transaction on Midnight');

    await page.getByTestId('tab-account').click();
    await openAction(page, 'send');
    await expect(page.locator('[data-testid=passport-row][data-symbol="twUSDC"]')).toContainText('1,000.00');
    await page.getByTestId('send-token').selectOption(COLOUR.twUSDC);
    await page.getByTestId('send-amount').fill('100');
    await page
      .getByTestId('send-recipient')
      .fill(
        formatShieldedAddress({ coinPublicKey: '44'.repeat(32), encryptionPublicKey: '55'.repeat(32) }, 'stagenet'),
      );
    await page.getByTestId('send-submit').click();
    await expect(page.getByTestId('accounts-message')).toContainText('the change is recorded in your inbox');

    await page.getByTestId('withdraw-kind-unshielded').click();
    await page.getByTestId('wu-amount').fill('5');
    await page.getByTestId('wu-recipient').fill(formatUnshieldedAddress('66'.repeat(32), 'stagenet'));
    await page.getByTestId('wu-submit').click();
    await expect(page.getByTestId('accounts-message')).toContainText('Withdrawn');

    await expect(page.getByTestId('prover-popup')).toHaveCount(0);
    expect(relay.submitted.map((s) => s.action)).toEqual(['take', 'withdraw', 'append-inbox', 'withdraw-unshielded']);
    expect(relay.handOffs.map((h) => [h.circuit, h.verdict])).toEqual([
      ['open_swap_shielded_with_ed25519', 'checked'],
      ['withdraw_shielded_with_ed25519', 'checked'],
      ['append_inbox_with_ed25519', 'checked'],
      ['withdraw_unshielded_with_ed25519', 'checked'],
    ]);
    expect(prover.proofs.map((p) => p.circuit)).toEqual(relay.handOffs.map((h) => h.circuit));
    expect(phantom.requests).toHaveLength(4);
  });

  test('the saved prover fails at action time: the popup with the reason; closing it signs and sends nothing', async ({
    page,
  }) => {
    const { phantom, relay } = await setup(page, { seeded: true });
    relay.clientProving = 'required';
    await seedProver(page, LOCAL);
    const prover = new MockProver(LOCAL);
    prover.mode = 'down';
    await prover.install(page);
    await page.goto(`/#trade?pair=${encodeURIComponent('twBTC/twUSDC')}`);
    await connectPhantom(page);
    await expect(holding(page, 'twBTC')).toContainText('0.10');
    await makeOffer(page);
    await expect(page.getByTestId('prover-popup-failure')).toContainText(
      `Your proof server did not answer at ${LOCAL}`,
    );
    await page.getByTestId('prover-popup-cancel').click();
    await expect(page.getByTestId('trade-message')).toContainText(
      'You closed the proof-server window, so nothing was signed or sent.',
    );
    expect(phantom.requests).toHaveLength(0);
    expect(relay.submitted).toHaveLength(0);
  });

  test('Bridge out: the popup comes before the landing-key texts are signed', async ({ page }) => {
    const s = await bridgeSite(page);
    s.relay.clientProving = 'required';
    await s.relay.deposit([{ nonce: '9a'.repeat(32), color: X.colour, value: 7_000_000n }]);
    await openPortfolio(page, undefined, 'bridge-out');
    await page.getByTestId('bridge-out-amount').fill('5');
    await page.getByTestId('bridge-out-review').click();
    await page.getByTestId('bridge-out-send').click();
    await expect(page.getByTestId('prover-popup-action')).toHaveAttribute(
      'data-circuit',
      'withdraw_shielded_with_ed25519',
    );
    expect(s.wallet.requests).toHaveLength(0);
    await page.getByTestId('prover-popup-cancel').click();
    await expect(page.getByTestId('bridge-out-error')).toContainText('nothing was signed or sent');
    expect(s.wallet.requests).toHaveLength(0);
    expect(s.relay.submitted).toHaveLength(0);
  });
});

test.describe('no popup for the actions the market still proves itself', () => {
  test('opening an account and demo tokens', async ({ page }) => {
    const { relay } = await setup(page);
    relay.clientProving = 'required';
    await page.goto('/#account');
    await connectPhantom(page);
    await page.getByTestId('open-account').click();
    await expect(page.getByTestId('accounts-message')).toContainText('is open');
    await openAction(page, 'mint-midnight');
    await page.getByTestId('get-demo-tokens').click();
    await expect(page.getByTestId('demo-message')).toContainText('Demo tokens delivered');
    await expect(page.getByTestId('prover-popup')).toHaveCount(0);
    expect(relay.submitted.map((s) => s.action)).toEqual(['register', 'demo-tokens']);
    expect(relay.handOffs).toEqual([]);
  });

  test('a key restore', async ({ page }) => {
    const { relay } = await setup(page, { seeded: true });
    relay.clientProving = 'required';
    relay.encKey = 'e1'.repeat(32);
    await page.goto('/#account');
    await connectPhantom(page);
    await page.getByTestId('restore-key').click();
    await page.getByTestId('restore-continue').click();
    await expect(page.getByTestId('accounts-message')).toContainText('Your encryption key is restored');
    await expect(page.getByTestId('prover-popup')).toHaveCount(0);
    expect(relay.handOffs).toEqual([]);
  });

  test('Bridge in', async ({ page }) => {
    const s = await bridgeSite(page);
    s.relay.clientProving = 'required';
    s.rpc.logsFor = () => ['Program x invoke [1]', lockc(s, 4), 'Program x success'];
    await openPortfolio(page);
    await review(page, '500');
    await page.getByTestId('bridge-in-send').click();
    await expect(page.getByTestId('bridge-in-ok')).toContainText('500 X are on their way');
    await expect(page.getByTestId('prover-popup')).toHaveCount(0);
    expect(s.relay.handOffs).toEqual([]);
  });
});

test.describe('when the customer’s prover or its proof fails', () => {
  test('out of memory while the market waits: the popup reopens with the reason; stopping says nothing is spent', async ({
    page,
  }) => {
    const { relay } = await setup(page, { seeded: true });
    relay.clientProving = 'required';
    await seedProver(page, LOCAL);
    const prover = new MockProver(LOCAL);
    prover.mode = 'oom';
    await prover.install(page);
    await page.goto(`/#trade?pair=${encodeURIComponent('twBTC/twUSDC')}`);
    await connectPhantom(page);
    await expect(holding(page, 'twBTC')).toContainText('0.10');
    await makeOffer(page);
    await expect(page.getByTestId('prover-popup-failure')).toContainText(
      'Your prover is busy or out of memory (it needs about 12 GB).',
    );
    await expect(page.getByTestId('prover-popup-deadline')).toContainText('The market waits');
    await expect(page.getByTestId('prover-popup-action')).toContainText('the market is waiting for the proof');
    await page.getByTestId('prover-popup-cancel').click();
    await expect(page.getByTestId('trade-message')).toContainText('the market sends nothing and spends no fee');
    expect(relay.handOffs[0]).toMatchObject({ fetched: true, proof: null });
  });

  test('the market refuses the proof: "your proof server returned an invalid proof"', async ({ page }) => {
    const { relay } = await setup(page, { seeded: true });
    relay.clientProving = 'required';
    relay.clientProofVerdict = 'invalid';
    await seedProver(page, LOCAL);
    await new MockProver(LOCAL).install(page);
    await page.goto(`/#trade?pair=${encodeURIComponent('twBTC/twUSDC')}`);
    await connectPhantom(page);
    await expect(holding(page, 'twBTC')).toContainText('0.10');
    await makeOffer(page);
    await expect(page.getByTestId('trade-message')).toContainText(
      'Your proof server returned an invalid proof, so the market refused it. Nothing was sent and no fee was spent.',
    );
    expect(relay.handOffs[0]).toMatchObject({ verdict: 'invalid' });
  });

  test('a stale call (I-62a v2): the page sends the same signed request again once; proved again, the offer is listed', async ({
    page,
  }) => {
    const { phantom, relay } = await setup(page, { seeded: true });
    relay.clientProving = 'required';
    relay.clientProofStale = 1;
    await seedProver(page, LOCAL);
    const prover = new MockProver(LOCAL);
    await prover.install(page);
    await page.goto(`/#trade?pair=${encodeURIComponent('twBTC/twUSDC')}`);
    await connectPhantom(page);
    await expect(holding(page, 'twBTC')).toContainText('0.10');
    await makeOffer(page);
    await expect(page.getByTestId('trade-message')).toContainText('Your offer is listed on the market');
    // Signed ONCE; the same body sent twice (a new ticket); the prover proved twice.
    expect(phantom.requests).toHaveLength(1);
    expect(relay.submitted.map((s) => s.action)).toEqual(['open-swap', 'open-swap']);
    expect(relay.submitted[1]!.body).toEqual(relay.submitted[0]!.body);
    expect(relay.handOffs.map((h) => h.verdict)).toEqual(['stale', 'checked']);
    expect(prover.proofs).toHaveLength(2);
    await expect(page.getByTestId('prover-popup')).toHaveCount(0);
  });

  test('stale twice: no third try; "your account changed while your proof server was proving", nothing spent', async ({
    page,
  }) => {
    const { phantom, relay } = await setup(page, { seeded: true });
    relay.clientProving = 'required';
    relay.clientProofStale = 2;
    await seedProver(page, LOCAL);
    await new MockProver(LOCAL).install(page);
    await page.goto(`/#trade?pair=${encodeURIComponent('twBTC/twUSDC')}`);
    await connectPhantom(page);
    await expect(holding(page, 'twBTC')).toContainText('0.10');
    await makeOffer(page);
    await expect(page.getByTestId('trade-message')).toContainText(
      'Your account changed while your proof server was proving (a deposit or a trade landed), so that proof no longer fits it. Nothing was sent and no fee was spent',
    );
    expect(phantom.requests).toHaveLength(1);
    expect(relay.submitted).toHaveLength(2);
    expect(relay.handOffs.map((h) => h.verdict)).toEqual(['stale', 'stale']);
  });

  test('too slow for the deadline: late, and nothing is spent', async ({ page }) => {
    const { relay } = await setup(page, { seeded: true });
    relay.clientProving = 'required';
    relay.clientProofTimeoutSeconds = 8;
    await seedProver(page, LOCAL);
    const prover = new MockProver(LOCAL);
    prover.proveMs = 15_000;
    await prover.install(page);
    await page.goto(`/#trade?pair=${encodeURIComponent('twBTC/twUSDC')}`);
    await connectPhantom(page);
    await expect(holding(page, 'twBTC')).toContainText('0.10');
    await makeOffer(page);
    await expect(page.getByTestId('trade-message')).toContainText(
      'Your prover did not finish before this action’s deadline',
      { timeout: 20_000 },
    );
    await expect(page.getByTestId('trade-message')).toContainText('no fee was spent');
    expect(relay.handOffs[0]).toMatchObject({ proof: null });
  });
});

// deploy/RUNBOOK.md §16: the tested Content-Security-Policy, with this test's origins in place of the
// stagenet ones, and the three proof-server sources AA 00062 adds (spec FR-013).
const CSP = (connect: string[]) =>
  [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src 'self' ${connect.join(' ')}`,
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'none'",
  ].join('; ');

async function withCsp(page: Page, policy: string): Promise<string[]> {
  const violations: string[] = [];
  await page.exposeFunction('__cspViolation', (v: string) => violations.push(v));
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) =>
      (window as unknown as { __cspViolation(v: string): void }).__cspViolation(
        `${e.violatedDirective} ${e.blockedURI}`,
      ),
    );
  });
  await page.route(
    (url) => url.hostname === '127.0.0.1',
    async (route) => {
      if (route.request().resourceType() !== 'document') return route.fallback();
      const response = await route.fetch();
      return route.fulfill({ response, headers: { ...response.headers(), 'content-security-policy': policy } });
    },
  );
  return violations;
}

test.describe('the Content-Security-Policy (spec FR-013)', () => {
  test('the prover sources work, and nothing else new is allowed', async ({ page }) => {
    await setup(page);
    const local = new MockProver(LOCAL);
    await local.install(page);
    const loop = new MockProver('http://127.0.0.1:6302');
    await loop.install(page);
    const online = new MockProver(ONLINE);
    await online.install(page);
    const violations = await withCsp(page, CSP([RELAY, new URL(INDEXER).origin, KERNEL, ...PROVER_SOURCES]));
    await page.goto('/#local');
    for (const url of [LOCAL, 'http://127.0.0.1:6302', ONLINE]) {
      await page.getByTestId('prover-url').fill(url);
      if (url === ONLINE) await page.getByTestId('prover-privacy-confirm').check();
      await page.getByTestId('prover-test').click();
      await expect(page.getByTestId('prover-verdict')).toHaveAttribute('data-ok', 'true');
    }
    expect(violations).toEqual([]);
    // Nothing else new: plain http to another host, and a WebSocket to the prover, stay blocked.
    const blocked = await page.evaluate(async () => {
      const out: string[] = [];
      await fetch('http://elsewhere.test/x').catch(() => out.push('http'));
      try {
        new WebSocket('ws://localhost:6300/');
      } catch {
        out.push('ws');
      }
      return out;
    });
    expect(blocked).toContain('http');
    await expect.poll(() => violations.some((v) => v.includes('elsewhere.test'))).toBe(true);
    await expect.poll(() => violations.some((v) => v.startsWith('connect-src ws://localhost:6300'))).toBe(true);
  });

  test('a policy without the prover sources: the page says the site’s security policy blocks it', async ({ page }) => {
    await setup(page);
    const local = new MockProver(LOCAL);
    await local.install(page);
    const violations = await withCsp(page, CSP([RELAY, new URL(INDEXER).origin, KERNEL]));
    await page.goto('/#local');
    await page.getByTestId('prover-test').click();
    await expect(page.locator('[data-testid=prover-check][data-id="reach"]')).toContainText(
      `This site's security policy does not allow it to connect to ${LOCAL}`,
    );
    expect(violations.some((v) => v.startsWith('connect-src') && v.includes('localhost:6300'))).toBe(true);
    expect(local.calls).toEqual([]);
  });
});
