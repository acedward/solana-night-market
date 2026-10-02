// A MOCK PUBLIC INDEXER for the browser walkthroughs (AA 00047 P9.S; questions Q26 A, Q31), served
// through page.route at its own origin (the page reads it directly, never through the relay).
//
// It serves the account the mock relay keeps "on chain" (./mock-relay.ts) the way the Midnight
// indexer does, answering the page's two GraphQL reads (web/src/chain/indexer.ts):
//   - `contract(address) { state }`: the account's REAL serialised ContractState, built by the
//     compiled account's own constructor with the relay's fields and the pinned key set's real
//     verifier keys (packages/core/test/fixtures/account-state.ts), so the page's real decoder and
//     real market-account check run on it;
//   - `contract(address) { actions { transaction { … zswapLedgerEvents } } }`: the account's
//     transactions, with raw events that carry the account's address and each coin's commitment or
//     nullifier, for the page's check of the relay's Zswap report.
//   - the account's ORIGIN (AA 00047 P11, R3-1 / R3-10; packages/core/src/passport/
//     account-provenance.ts): its deploy and the state it created, its one retiring maintenance
//     update, and the blocks between (../../packages/core/test/fixtures/account-origin.ts). P10's reads
//     (the deploy's block, the state at that block) are still answered, so the specs also run against
//     the page before P11 (fail-before).
// A test can make the chain differ from what an honest market would deploy (`tamper`), or from what
// the relay reports (`hideFromEvents`).

import type { Route } from '@playwright/test';

import { originIndexer, type OriginSpec } from '../../packages/core/test/fixtures/account-origin.js';
import { accountStateHex, FIXTURE_VERIFIER_KEYS } from '../../packages/core/test/fixtures/account-state.js';
import { networkSaltFor } from '../../packages/core/src/passport/account-chain.js';
import { COLOUR } from '../../packages/core/test/fixtures/kernel/book.js';
import { ACCOUNT, type MockRelay } from './mock-relay.js';

export const INDEXER = 'http://indexer.test/api/v4/graphql';

/** The site configuration's network override that points the page at this indexer. */
export const INDEXER_OVERRIDE = { midnight: { indexerUrl: INDEXER } } as const;

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': '*',
};
const PREFIX = Buffer.from('midnight:event[v14]:').toString('hex');

/** How a compromised relay's account can differ from the market's own (audit C3, F-A2/F-B5). */
export interface Tamper {
  /** A second device entry (the attacker's). */
  extraDevice?: boolean;
  /** The maintenance authority kept (one committee key). */
  liveAuthority?: boolean;
  /** One circuit's verifier key replaced (another circuit's key under its name). */
  swappedKey?: boolean;
  /** The account sealed to another encryption key. */
  otherEncKey?: boolean;
  /** Another network's salt. */
  otherSalt?: boolean;
  /** AA 00047 P10 (R2-6): an inbox note already there when it was deployed. */
  seededInbox?: boolean;
  /** AA 00047 P10 (R2-6): a credited balance near 2^128 already there when it was deployed. */
  seededCredit?: boolean;
  /** AA 00047 P11 (R3-1, auditor A's probe): deployed with `round` at 2^64 - 4 (2^64 - 3 once
   *  activated): it freezes, funds included, a few calls later. */
  roundBomb?: boolean;
  /** AA 00047 P11 (R3-1): a call of the account between its deploy and its authority's retirement
   *  (a write under a temporary verifier key). */
  maintenanceWrite?: boolean;
  /** AA 00047 P11 (R3-10): the indexer has no deploy record (the deploy transaction is still
   *  readable by its hash or identifier). */
  noDeployRecord?: boolean;
  /** AA 00047 P11 (R3-10): the indexer shows no deploy at all yet (no record, no transaction). */
  originUnknown?: boolean;
}

export class MockIndexer {
  /** Every query, as `state:<address>` or `actions:<address>`. */
  readonly queries: string[] = [];
  tamper: Tamper = {};
  /** Commitments/nullifiers the chain's events do NOT carry (a relay's invention). */
  readonly hideFromEvents = new Set<string>();
  /** Answer every query with an HTTP error (the indexer is down). */
  down = false;
  /** AA 00047 P10 (R2-6): this many NEWER transactions of the account than its own (a griefer's
   *  one-unit deposits), so its real ones are past the indexer's newest page of `actions(limit)`. */
  padActions = 0;
  /** The transactions read by hash (`transactions(offset: { hash })`). */
  readonly byHash: string[] = [];

  constructor(private readonly relay: MockRelay) {}

  private async stateHex(): Promise<string | null> {
    const r = this.relay;
    if (!r.registered || !r.deviceKey || !r.encKey) return null;
    const t = this.tamper;
    const operations = t.swappedKey
      ? { ...FIXTURE_VERIFIER_KEYS, withdraw_shielded_with_ed25519: FIXTURE_VERIFIER_KEYS.append_inbox_with_ed25519! }
      : FIXTURE_VERIFIER_KEYS;
    return accountStateHex({
      account: ACCOUNT,
      deviceKey: r.deviceKey,
      encKey: t.otherEncKey ? 'e1'.repeat(32) : r.encKey,
      salt: t.otherSalt ? networkSaltFor('undeployed') : r.salt,
      ...(t.roundBomb ? { round: (1n << 64n) - 3n } : {}),
      authNonce: r.authNonce,
      useCounter: r.useCounter,
      inbox: t.seededInbox ? ['ab'.repeat(192), ...r.entries] : r.entries,
      ...(t.seededCredit ? { credited: [[COLOUR.twUSDC, (1n << 128n) - 1n] as const] } : {}),
      unshielded: [...r.unshielded].filter(([, v]) => v > 0n),
      operations,
      ...(t.extraDevice ? { extraDevices: ['ad'.repeat(32)] } : {}),
      ...(t.liveAuthority ? { authority: { committee: 1, threshold: 1 } } : {}),
    });
  }

  /** The account's state as it was deployed (R2-6): what the deployer (`tamper`) seeded, nothing else. */
  private async deployedHex(): Promise<string | null> {
    const r = this.relay;
    if (!r.registered || !r.deviceKey || !r.encKey) return null;
    const t = this.tamper;
    return accountStateHex({
      account: ACCOUNT,
      deviceKey: r.deviceKey,
      encKey: r.encKey,
      salt: r.salt,
      noDevice: true,
      booted: false,
      inbox: t.seededInbox ? ['ab'.repeat(192)] : [],
      ...(t.seededCredit ? { credited: [[COLOUR.twUSDC, (1n << 128n) - 1n] as const] } : {}),
      ...(t.roundBomb ? { round: (1n << 64n) - 4n } : {}),
    });
  }

  /** The account's origin as the indexer shows it (AA 00047 P11): the deploy the relay made, with what
   *  the deployer (`tamper`) chose, its retiring update, and the blocks between. */
  private async origin() {
    const r = this.relay;
    if (!r.registered || !r.deviceKey || !r.encKey) return null;
    const t = this.tamper;
    const spec: OriginSpec = {
      account: ACCOUNT,
      deviceKey: r.deviceKey,
      encKey: r.deployEncKey ?? r.encKey,
      salt: r.salt,
      deploy: {
        ...(t.seededInbox ? { inbox: ['ab'.repeat(192)] } : {}),
        ...(t.seededCredit ? { credited: [[COLOUR.twUSDC, (1n << 128n) - 1n] as const] } : {}),
        ...(t.roundBomb ? { round: (1n << 64n) - 4n } : {}),
      },
      ...(t.maintenanceWrite ? { windowExtra: [{ kind: 'call' as const, entryPoint: 'deposit_unshielded' }] } : {}),
      ...(t.noDeployRecord || t.originUnknown ? { noDeployRecord: true } : {}),
      // The mock relay's transaction ids are 64 hex: the page reads them as hashes.
      ...(r.registerTxs && !t.originUnknown ? { deployTxHash: r.registerTxs.waveOne } : {}),
      ...(t.originUnknown ? { deployTxIdentifier: 'ff'.repeat(33), deployTxHash: 'fe'.repeat(32) } : {}),
    };
    return originIndexer(spec);
  }

  private actions() {
    const byHash = new Map<
      string,
      { hash: string; block: { height: number }; zswapLedgerEvents: Array<{ id: number; raw: string }> }
    >();
    let id = 1;
    const add = (txHash: string, height: number, value: string) => {
      const tx = byHash.get(txHash) ?? { hash: txHash, block: { height }, zswapLedgerEvents: [] };
      if (!this.hideFromEvents.has(value))
        tx.zswapLedgerEvents.push({ id: id++, raw: `${PREFIX}080080${ACCOUNT}${value}00` });
      byHash.set(txHash, tx);
    };
    for (const o of this.relay.outputs) add(o.txHash, o.blockHeight, o.commitment);
    for (const i of this.relay.inputs) add(i.txHash, i.blockHeight, i.nullifier);
    return [...byHash.values()];
  }

  /** The account's actions as the indexer serves them: NEWEST first, at most `limit` (it caps 500). */
  private page(limit: number) {
    const own = this.actions().sort((a, b) => b.block.height - a.block.height);
    const pad = Array.from({ length: this.padActions }, (_, i) => ({
      hash: `f${(this.padActions - i).toString(16).padStart(63, '0')}`,
      block: { height: 100_000 + this.padActions - i },
      zswapLedgerEvents: [] as Array<{ id: number; raw: string }>,
    }));
    return [...pad, ...own].slice(0, Math.min(limit, 500)).map((transaction) => ({ transaction }));
  }

  async handle(route: Route) {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const json = (status: number, body: unknown) =>
      route.fulfill({ status, headers: CORS, contentType: 'application/json', body: JSON.stringify(body) });
    if (this.down) return json(503, { errors: [{ message: 'unavailable' }] });
    const body = JSON.parse(req.postData() ?? '{}') as {
      query?: string;
      variables?: { address?: string; limit?: number } & Record<string, unknown>;
    };
    const address = String(body.variables?.address ?? '').toLowerCase();
    const query = body.query ?? '';
    const ours = address === ACCOUNT;
    // The account's origin (AA 00047 P11): its deploy, its update, the blocks between.
    const origin = await this.origin();
    const fromOrigin = origin?.answer(query, body.variables ?? {});
    if (fromOrigin !== undefined) {
      this.queries.push(
        // The deploy-transaction and window reads name no address: `deploytx` and `window`.
        query.includes('AccountOrigin($')
          ? `origin:${address}`
          : query.includes('AccountDeployTx(')
            ? 'deploytx'
            : 'window',
      );
      return json(200, { data: fromOrigin });
    }
    if (!origin && /AccountOrigin\(\$|AccountDeployTx\(|AccountOriginWindow\(/.test(query)) {
      this.queries.push(`origin:${address}`);
      return json(200, { data: query.includes('AccountOrigin($') ? { contract: null } : { transactions: [] } });
    }
    if (query.includes('type: DEPLOY')) {
      // The deploy's block (AA 00047 P10, R2-6).
      this.queries.push(`deploy:${address}`);
      const deployed = ours && this.relay.registered && !this.tamper.noDeployRecord && !this.tamper.originUnknown;
      return json(200, {
        data: { contract: deployed ? { actions: [{ transaction: { block: { height: 1 } } }] } : null },
      });
    }
    if (query.includes('offset: { height')) {
      // The account as DEPLOYED: no device yet, not activated; what the deployer put in it.
      this.queries.push(`deployed:${address}`);
      const state = ours ? await this.deployedHex() : null;
      return json(200, { data: { contract: state ? { state } : null } });
    }
    if (query.includes('transactions(offset')) {
      // By hash (AA 00047 P10, R2-6): the account's own transactions, wherever they are.
      const own = new Map(this.actions().map((t) => [t.hash, t]));
      const data: Record<string, unknown[]> = {};
      for (const [k, v] of Object.entries(body.variables ?? {})) {
        const h = String(v);
        this.byHash.push(h);
        const t = own.get(h);
        data[k.replace(/^h/, 't')] = t ? [{ ...t, contractActions: [{ address: ACCOUNT }] }] : [];
      }
      return json(200, { data });
    }
    if (query.includes('actions(')) {
      this.queries.push(`actions:${address}`);
      const limit = Number(body.variables?.limit ?? 100);
      return json(200, { data: { contract: ours && this.relay.registered ? { actions: this.page(limit) } : null } });
    }
    this.queries.push(`state:${address}`);
    const state = ours ? await this.stateHex() : null;
    return json(200, { data: { contract: state ? { state } : null, block: { height: 99 } } });
  }
}
