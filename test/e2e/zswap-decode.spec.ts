// AA 00047 P11.B: the browser decodes the account's shielded activity itself (questions Q47 A, which
// supersedes Q31; spec FR-004b "Round 3"; audit round 3 R3-3…R3-6), on the PRODUCTION build (`vite
// build` + `vite preview`), in Chromium, with the mock Phantom, relay and public indexer.
//
// The feasibility gate (plan P11.B (0)):
//   - ledger-v9 1.0.0-rc.3's WebAssembly is NOT loaded on the Markets page, and IS loaded, lazily, by
//     the account (Portfolio) and trade pages, which decode the account's history with it;
//   - the production chunk decodes REAL stagenet transactions of a market account (account A of the P6
//     acceptance, test/fixtures/stagenet-p11b/) in the browser;
//   - it works under the RUNBOOK's Content-Security-Policy (`'wasm-unsafe-eval'`, and the indexer's
//     WebSocket in `connect-src`).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { expect, test, type Page } from '@playwright/test';

import { COLOUR } from '../../packages/core/test/fixtures/kernel/book.js';
import { formatShieldedAddress } from '../../packages/core/src/shielded-address.js';
import { INDEXER, INDEXER_WS } from './mock-indexer.js';
import { connectPhantom } from './mock-phantom.js';
import { RELAY } from './mock-relay.js';
import { KERNEL } from './visual-fixtures.js';
import { setup } from './wallet-fixtures.js';

const LEDGER_ASSET = /\/assets\/(midnight_ledger_wasm_v9_bg-[^/]*\.wasm|ledger-decode-[^/]*\.js)$/;
const portfolioRow = (page: Page, symbol: string) =>
  page.locator(`[data-testid=passport-row][data-symbol="${symbol}"]:not([data-kind="unshielded"])`);
const holding = (page: Page, symbol: string) =>
  page.locator(`[data-testid=holding][data-symbol="${symbol}"][data-kind="shielded"]`);

/** Every request for ledger-v9's chunk or WebAssembly, by file. */
function watchLedger(page: Page): string[] {
  const seen: string[] = [];
  page.on('request', (r) => {
    const m = LEDGER_ASSET.exec(new URL(r.url()).pathname);
    if (m) seen.push(m[1]!.replace(/-[^-.]+\.(wasm|js)$/, '.$1'));
  });
  return seen;
}

test.describe('the feasibility gate: ledger-v9 in the page, lazily (plan P11.B (0))', () => {
  test('not loaded on Markets; loaded by the Portfolio, which decodes the account with it', async ({ page }) => {
    await setup(page, { seeded: true });
    const ledger = watchLedger(page);
    await page.goto('/#markets');
    await connectPhantom(page);
    await expect(page.getByTestId('wallet-address')).toBeVisible();
    await expect(page.locator('[data-testid=market-row]').first()).toBeVisible();
    await page.waitForTimeout(1_500);
    expect(ledger).toEqual([]);
    // To the Portfolio (the same document: a section change): the balances need the page's own decode.
    await page.goto('/#account');
    await expect(portfolioRow(page, 'twBTC')).toContainText('0.10');
    expect([...new Set(ledger)].sort()).toEqual(['ledger-decode.js', 'midnight_ledger_wasm_v9_bg.wasm']);
  });

  test('loaded by the Trade page, which decodes the account with it', async ({ page }) => {
    await setup(page, { seeded: true });
    const ledger = watchLedger(page);
    await page.goto(`/#trade?pair=${encodeURIComponent('twBTC/twUSDC')}`);
    await connectPhantom(page);
    await expect(holding(page, 'twBTC')).toContainText('0.10');
    expect([...new Set(ledger)].sort()).toEqual(['ledger-decode.js', 'midnight_ledger_wasm_v9_bg.wasm']);
  });

  test('the production chunk decodes real stagenet transactions of a market account, in Chromium', async ({ page }) => {
    await setup(page, { seeded: true });
    await page.goto('/#account');
    await connectPhantom(page);
    await expect(portfolioRow(page, 'twBTC')).toContainText('0.10');
    const fx = (name: string) =>
      JSON.parse(
        readFileSync(fileURLToPath(new URL(`../fixtures/stagenet-p11b/${name}`, import.meta.url)), 'utf8'),
      ) as { account: string; data: Record<string, unknown> };
    const history = fx('account-a-history.json');
    type Action = {
      entryPoint?: string;
      transaction: {
        hash: string;
        id: number;
        block: { height: number };
        zswapStartIndex: number;
        zswapEndIndex: number;
        transactionResult: { status: string };
        zswapLedgerEvents: Array<{ id: number; raw: string }>;
      };
    };
    const txs = (history.data.contract as { actions: Action[] }).actions.map((a) => ({
      hash: a.transaction.hash,
      id: a.transaction.id,
      blockHeight: a.transaction.block.height,
      zswapStartIndex: a.transaction.zswapStartIndex,
      zswapEndIndex: a.transaction.zswapEndIndex,
      status: a.transaction.transactionResult.status,
      entryPoints: a.entryPoint ? [a.entryPoint] : [],
      events: a.transaction.zswapLedgerEvents,
    }));
    const take = (fx('tx-4464f3f4.json').data.transactions as Array<{ hash: string; raw: string }>)[0]!;
    const decoded = await page.evaluate(
      async ({ account, txs, take }) => {
        // The chunk the page itself loaded (production build, hashed name).
        const url = performance
          .getEntriesByType('resource')
          .map((e) => e.name)
          .find((n) => /\/assets\/ledger-decode-[^/]*\.js$/.test(n));
        if (!url) throw new Error('the page has not loaded the ledger chunk');
        const m = (await import(url)) as {
          decodeAccountTx(a: string, t: unknown): { hash: string; outputs: unknown[]; inputs: string[] };
          decodeTransactionCalls(
            raw: string,
            hash: string,
          ): Array<{ address: string; entryPoint: string; receives: string[] }>;
        };
        return {
          txs: txs.map((t) => m.decodeAccountTx(account, t)),
          calls: m.decodeTransactionCalls(take.raw, take.hash),
        };
      },
      { account: history.account, txs, take },
    );
    const leaves = decoded.txs.flatMap((t) => t.outputs as Array<{ mtIndex: string }>).map((o) => o.mtIndex);
    expect(leaves.sort()).toEqual(['5179', '5180', '5184', '5186']);
    expect(decoded.txs.flatMap((t) => t.inputs)).toEqual([
      'aea3047d94bd83b666aae60683a4b6c3efb5cdc38e29eb06f58eebff9be12552',
      '5af4437dfd239d35581358cc9aa1b91f83b4d00e075da643fde4d7e747eec2a2',
    ]);
    const ofA = decoded.calls.find((c) => c.address === history.account)!;
    expect(ofA.entryPoint).toBe('open_swap_shielded_with_ed25519');
    expect(ofA.receives).toContain('edc20df6f937d9d57b2c0ab6b922b579a82b7c06af3b1eb31a5990bc5b548e37');
  });
});

// deploy/RUNBOOK.md §16: the tested Content-Security-Policy, with this test's origins in place of the
// stagenet ones (the relay is cross-origin here; in a deployment it is the same-origin /relay).
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

const WS_ORIGIN = new URL(INDEXER_WS).origin.replace(/^http/, 'ws');

test.describe('the Content-Security-Policy the decode needs (deploy/RUNBOOK.md §16)', () => {
  test('under the RUNBOOK’s policy the page loads ledger-v9 and streams a long history', async ({ page }) => {
    const { indexer } = await setup(page, { seeded: true });
    indexer.padActions = 600; // the account's own coins are older than the newest page: streamed
    const violations = await withCsp(page, CSP([RELAY, new URL(INDEXER).origin, WS_ORIGIN, KERNEL]));
    await page.goto('/#account');
    await connectPhantom(page);
    await expect(portfolioRow(page, 'twBTC')).toContainText('0.10');
    expect(indexer.streams).toEqual([1]); // from the deploy's block
    await expect(page.getByTestId('history-incomplete')).toHaveCount(0);
    expect(violations).toEqual([]);
  });

  test('without the indexer’s WebSocket in connect-src a long history is NOT complete, and the page says so', async ({
    page,
  }) => {
    // Not routed: Playwright's WebSocket routing would bypass the page's policy.
    const { indexer } = await setup(page, { seeded: true, noWsRoute: true });
    indexer.padActions = 600;
    const violations = await withCsp(page, CSP([RELAY, new URL(INDEXER).origin, KERNEL]));
    await page.goto('/#account');
    await connectPhantom(page);
    await expect(page.getByTestId('history-incomplete')).toBeVisible();
    // The demo coins' leaves are older than the newest page: not confirmed, so not counted.
    await expect(portfolioRow(page, 'twBTC')).toHaveCount(0);
    expect(violations).toContain(`connect-src ${INDEXER_WS}`);
  });
});

test.describe('the account’s complete history (plan P11.B (1))', () => {
  test('a refused stream leaves a long history incomplete: the page says so and counts nothing it cannot confirm', async ({
    page,
  }) => {
    const { indexer } = await setup(page, { seeded: true });
    indexer.padActions = 600;
    indexer.noStream = true;
    await page.goto('/#account');
    await connectPhantom(page);
    await expect(page.getByTestId('history-incomplete')).toBeVisible();
    await expect(portfolioRow(page, 'twBTC')).toHaveCount(0);
  });

  test('a history of more than 500 actions is read in full from the indexer, never by hashes the relay names', async ({
    page,
  }) => {
    const { relay, indexer } = await setup(page, { seeded: true });
    indexer.padActions = 600; // a griefer's one-unit deposits, newer than the account's own coins
    relay.zswapHistoryTooLong = true; // the relay at b8d81e9 refuses its own report from 500 on (R3-5)
    await page.goto('/#account');
    await connectPhantom(page);
    await expect(portfolioRow(page, 'twBTC')).toContainText('0.10');
    await expect(portfolioRow(page, 'twBTC').getByTestId('passport-largest')).toHaveAttribute('data-raw', '10000000');
    expect(indexer.streams).toEqual([1]); // streamed from the deploy's block
    expect(indexer.byHash).toEqual([]); // nothing read by a hash someone named
    expect(relay.zswapReads).toBe(0); // the relay's Zswap report was never asked for
    await expect(page.getByTestId('history-incomplete')).toHaveCount(0);
  });
});

// ── Round 3's attacks on the page's view of the account (audit R3-3, R3-4, R3-6), end to end ──────

const myMake = (page: Page) => page.locator('[data-testid=my-trade][data-role=make]');

/** Make an offer on twBTC/twUSDC (sell 0.05 twBTC at 60,000): live and listed. */
async function makeAnOffer(page: Page) {
  await page.goto(`/#trade?pair=${encodeURIComponent('twBTC/twUSDC')}`);
  await connectPhantom(page);
  await expect(holding(page, 'twBTC')).toContainText('0.10');
  await page.getByTestId('side-sell').click();
  await page.getByTestId('make-quantity').fill('0.05');
  await page.getByTestId('make-price').fill('60000');
  await page.getByTestId('make-sign').click();
  await expect(page.getByTestId('live-offer-banner')).toBeVisible();
  await expect(myMake(page)).toHaveAttribute('data-state', 'live');
}

/** The settling transaction the page recorded for its offer (from its own records). */
const recordedSettlement = (page: Page) =>
  page.evaluate(() => {
    for (const v of Object.values(localStorage)) {
      const m = /"settledTx":"([0-9a-f]+)"/.exec(String(v));
      if (m && String(v).includes('"role":"make"')) return m[1];
    }
    return null;
  });

test.describe('round 3’s attacks, against the page’s own decode', () => {
  test('R3-3: a counterfeit note with a real coin’s colour and nonce adds nothing and takes nothing over', async ({
    page,
  }) => {
    const { relay } = await setup(page, { seeded: true });
    // The seeded 0.1 twBTC coin's colour and nonce (wallet-fixtures: nonce 0xa1…), claiming 5,000 twBTC.
    await relay.fakeNote({ nonce: 'a1'.repeat(32), color: COLOUR.twBTC, value: 500_000_000_000n });
    await page.goto('/#account');
    await connectPhantom(page);
    await expect(portfolioRow(page, 'twBTC').getByTestId('passport-amount')).toHaveAttribute('data-raw', '10000000');
    await expect(portfolioRow(page, 'twBTC').getByTestId('passport-largest')).toHaveAttribute('data-raw', '10000000');
    await expect(page.getByTestId('unconfirmed-notes')).toHaveAttribute('data-count', '1');
  });

  test('R3-4: a withdrawal the relay lands, reports failed, and leaves out of its report is confirmed from the chain', async ({
    page,
  }) => {
    const { relay } = await setup(page, { seeded: true });
    relay.landButFail.add('withdraw');
    relay.omitWithdrawalsFromReport = true; // the input's spend and the change's leaf: hidden
    await page.goto('/#account');
    await connectPhantom(page);
    await expect(portfolioRow(page, 'twUSDC')).toContainText('1,000.00');
    await page.getByTestId('withdraw-kind-shielded').click();
    await page.getByTestId('send-token').selectOption(COLOUR.twUSDC);
    await page.getByTestId('send-amount').fill('100');
    await page
      .getByTestId('send-recipient')
      .fill(
        formatShieldedAddress({ coinPublicKey: '44'.repeat(32), encryptionPublicKey: '55'.repeat(32) }, 'stagenet'),
      );
    await page.getByTestId('send-submit').click();
    await expect(page.getByTestId('accounts-message')).toContainText('The prover crashed');
    await page.reload();
    await connectPhantom(page);
    // The chain (decoded here) shows the 1,000 spent and the 900 of change: never the 1,000 again.
    await expect(portfolioRow(page, 'twUSDC').getByTestId('passport-amount')).toHaveAttribute('data-raw', '900000000');
    await expect(page.getByTestId('pending-change')).toHaveCount(0);
    expect(relay.zswapReads).toBe(0);
  });

  // Reported by P11.A (coordinator, 2026-10-02): a withdrawal refused for Q46's allowance left its
  // pending change; the whole-coin exit then spent the same coin; the change stayed "pending" for ever.
  test('R3-4: after a refused withdrawal, the whole-coin exit of the same coin leaves no change pending for ever', async ({
    page,
  }) => {
    const { relay } = await setup(page, { seeded: true });
    await page.goto('/#account');
    await connectPhantom(page);
    await expect(portfolioRow(page, 'twUSDC')).toContainText('1,000.00');
    await page.getByTestId('withdraw-kind-shielded').click();
    await page.getByTestId('send-token').selectOption(COLOUR.twUSDC);
    await page.getByTestId('send-amount').fill('100');
    await page
      .getByTestId('send-recipient')
      .fill(
        formatShieldedAddress({ coinPublicKey: '44'.repeat(32), encryptionPublicKey: '55'.repeat(32) }, 'stagenet'),
      );
    relay.refuseNext = {
      status: 429,
      code: 'withdraws-daily-cap',
      message: 'this account has used its 100 sponsored withdrawals in the last 24 hours',
      detail: 'whole-coin-exit',
      retryAfter: 7200,
    };
    await page.getByTestId('send-submit').click();
    await page.getByTestId('whole-coin-exit').getByTestId('whole-coin-exit-coin').click();
    await expect(page.getByTestId('accounts-message')).toContainText('Sent');
    await page.reload();
    await connectPhantom(page);
    // Once the page has walked the account (the twBTC row is its), the 1,000 coin is spent (decoded) and
    // the refused withdrawal's 900 of change is no longer pending, nor kept anywhere.
    await expect(portfolioRow(page, 'twBTC')).toContainText('0.10');
    await expect(portfolioRow(page, 'twUSDC')).toHaveCount(0);
    await expect(page.getByTestId('pending-box')).toBeVisible();
    await expect(page.getByTestId('pending-change')).toHaveCount(0);
    const stored = await page.evaluate(() =>
      Object.entries(localStorage)
        .filter(([k]) => k.includes('coins'))
        .map(([, v]) => v)
        .join(''),
    );
    expect(stored).toContain('"value":"1000000000"'); // the walk wrote the list
    expect(stored).not.toContain('"pending"');
  });

  test('R3-6: a real coin someone deposits with the offer’s wanted nonce never makes the cancelled offer Filled', async ({
    page,
  }) => {
    const { relay } = await setup(page, { seeded: true });
    await makeAnOffer(page);
    const make = relay.submitted.find((s) => s.action === 'open-swap')!.body.payload as {
      wantNonce: string;
      wantColor: string;
      wantAmount: string;
    };
    // The relay saw the wanted coin; an attacker pays for it and files its note, in a deposit.
    await relay.plantWantedCoin({ nonce: make.wantNonce, color: make.wantColor, value: BigInt(make.wantAmount) });
    await page.getByTestId('cancel-offer').click();
    await expect(page.getByTestId('trade-message')).toContainText('Cancelled: your offer can no longer be taken');
    await expect(myMake(page)).toHaveAttribute('data-state', 'cancelled');
    expect(await recordedSettlement(page)).toBeNull();
  });

  test('R3-6: the maker’s offer settled by someone is Filled by its decoded swap transaction', async ({ page }) => {
    const { relay, indexer } = await setup(page, { seeded: true });
    await makeAnOffer(page);
    relay.settleOnCancel = true; // asked to cancel, this relay settles the offer it holds instead
    await page.getByTestId('cancel-offer').click();
    await expect(myMake(page)).toHaveAttribute('data-state', 'filled');
    const swapTx = [...relay.chainTxs.entries()].find(([, t]) => t.raw)![0];
    expect(await recordedSettlement(page)).toBe(swapTx);
    expect(indexer.byHash).toContain(swapTx); // its raw bytes were read and decoded
  });
});
