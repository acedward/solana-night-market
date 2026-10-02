// A MOCK PUBLIC INDEXER for the browser walkthroughs (AA 00047 P9.S; questions Q26 A, Q31), served
// through page.route at its own origin (the page reads it directly, never through the relay).
//
// It serves the account the mock relay keeps "on chain" (./mock-relay.ts) the way the Midnight
// indexer does, answering the page's two GraphQL reads (web/src/chain/indexer.ts):
//   - `contract(address) { state }`: the account's REAL serialised ContractState, built by the
//     compiled account's own constructor with the relay's fields and the pinned key set's real
//     verifier keys (packages/core/test/fixtures/account-state.ts), so the page's real decoder and
//     real market-account check run on it;
//   - the account's HISTORY (AA 00047 P11.B, questions Q47 A): `contract(address) { actions(limit) }`
//     (newest first, at most 500) and the `contractActions` SUBSCRIPTION over a WebSocket (oldest first
//     from a block height, then waiting, as the indexer does), each action with its transaction's
//     height, range in the Zswap tree, verdict, the entry point of the account's call and the ledger
//     EVENTS, serialised byte for byte as ledger-v9 emits them
//     (packages/core/test/fixtures/ledger-events.ts), so the page's real ledger-v9 decoder runs on them;
//   - `transactions(offset: { hash }) { raw }`: a swap transaction's raw bytes, built by ledger-v9
//     (./ledger-tx.ts);
//   - the account's ORIGIN (AA 00047 P11, R3-1 / R3-10; packages/core/src/passport/
//     account-provenance.ts): its deploy and the state it created, its one retiring maintenance
//     update, and the blocks between (../../packages/core/test/fixtures/account-origin.ts). P10's reads
//     (the deploy's block, the state at that block) are still answered, so the specs also run against
//     the page before P11 (fail-before).
// A test can make the chain differ from what an honest market would deploy (`tamper`), hide a leaf or
// a spend from the events (`hideFromEvents`), put griefers' deposits in front of the account's own
// (`padActions`), or refuse the stream (`noStream`).

import type { Route, WebSocketRoute } from '@playwright/test';

import { originIndexer, type OriginSpec } from '../../packages/core/test/fixtures/account-origin.js';
import { accountStateHex, FIXTURE_VERIFIER_KEYS } from '../../packages/core/test/fixtures/account-state.js';
import { zswapInputEventHex, zswapOutputEventHex } from '../../packages/core/test/fixtures/ledger-events.js';
import { networkSaltFor } from '../../packages/core/src/passport/account-chain.js';
import { COLOUR } from '../../packages/core/test/fixtures/kernel/book.js';
import { ACCOUNT, type MockRelay } from './mock-relay.js';

export const INDEXER = 'http://indexer.test/api/v4/graphql';
/** Its WebSocket endpoint (the page derives it from INDEXER). */
export const INDEXER_WS = 'ws://indexer.test/api/v4/graphql/ws';

/** The site configuration's network override that points the page at this indexer. */
export const INDEXER_OVERRIDE = { midnight: { indexerUrl: INDEXER } } as const;

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': '*',
};

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
  /** The transactions read by hash (`transactions(offset: { hash })`: their raw bytes). */
  readonly byHash: string[] = [];
  /** The subscriptions the page opened, with the block height each started at. */
  readonly streams: number[] = [];
  /** Refuse the WebSocket stream (a Content-Security-Policy or a proxy that blocks it). */
  noStream = false;

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

  /** The account's actions as the indexer serves them, OLDEST first: one per call of the account, each
   *  with its transaction (and the ledger events of the account's leaves and spends in it). */
  private actions() {
    const r = this.relay;
    const events = new Map<string, Array<{ id: number; raw: string }>>();
    const ranges = new Map<string, number[]>();
    let id = 1;
    for (const o of r.outputs) {
      ranges.set(o.txHash, [...(ranges.get(o.txHash) ?? []), Number(o.mtIndex)]);
      if (this.hideFromEvents.has(o.commitment)) continue;
      const raw = zswapOutputEventHex({
        txHash: o.txHash,
        contract: ACCOUNT,
        commitment: o.commitment,
        mtIndex: BigInt(o.mtIndex),
      });
      events.set(o.txHash, [...(events.get(o.txHash) ?? []), { id: id++, raw }]);
    }
    for (const i of r.inputs) {
      if (this.hideFromEvents.has(i.nullifier)) continue;
      const raw = zswapInputEventHex({ txHash: i.txHash, contract: ACCOUNT, nullifier: i.nullifier });
      events.set(i.txHash, [...(events.get(i.txHash) ?? []), { id: id++, raw }]);
    }
    const own = [...r.chainTxs.entries()]
      .sort(([, a], [, b]) => a.id - b.id)
      .flatMap(([hash, t]) => {
        const at = ranges.get(hash) ?? [];
        const transaction = {
          hash,
          id: t.id,
          block: { height: t.height },
          zswapStartIndex: at.length ? Math.min(...at) : 0,
          zswapEndIndex: at.length ? Math.max(...at) + 1 : 0,
          transactionResult: { status: 'SUCCESS' },
          zswapLedgerEvents: events.get(hash) ?? [],
        };
        const calls = t.entryPoints.length ? t.entryPoints : [null];
        return calls.map((entryPoint) => ({ __typename: 'ContractCall', entryPoint, transaction }));
      });
    // A griefer's one-unit deposits, NEWER than everything of the account's own: a real leaf each.
    const pad = Array.from({ length: this.padActions }, (_, i) => {
      const hash = `f${(i + 1).toString(16).padStart(63, '0')}`;
      return {
        __typename: 'ContractCall',
        entryPoint: 'deposit_shielded',
        transaction: {
          hash,
          id: 100_000 + i,
          block: { height: 100_000 + i },
          zswapStartIndex: 1_000_000 + i,
          zswapEndIndex: 1_000_001 + i,
          transactionResult: { status: 'SUCCESS' },
          zswapLedgerEvents: [
            {
              id: 10_000_000 + i,
              raw: zswapOutputEventHex({
                txHash: hash,
                contract: ACCOUNT,
                commitment: (i + 1).toString(16).padStart(64, 'c'),
                mtIndex: 1_000_000 + i,
              }),
            },
          ],
        },
      };
    });
    return [...own, ...pad];
  }

  /** The chain's tip: past every transaction, and never before the state's read (height 99). */
  private tip() {
    return Math.max(99, ...this.actions().map((a) => a.transaction.block.height)) + 1;
  }

  /** The account's actions as the indexer serves them: NEWEST first, at most `limit` (it caps 500). */
  private page(limit: number) {
    return this.actions().reverse().slice(0, Math.min(limit, 500));
  }

  /** The `contractActions` subscription (graphql-transport-ws): every action from the offset's block
   *  height, oldest first, then nothing more (the stream stays open, as the indexer's does). */
  handleWs(ws: WebSocketRoute) {
    ws.onMessage((m) => {
      const msg = JSON.parse(String(m)) as {
        type?: string;
        id?: string;
        payload?: { variables?: Record<string, unknown> };
      };
      if (msg.type === 'connection_init') {
        if (this.noStream) return ws.close({ code: 1011, reason: 'refused' });
        return ws.send(JSON.stringify({ type: 'connection_ack' }));
      }
      if (msg.type !== 'subscribe') return;
      const v = msg.payload?.variables ?? {};
      const from = Number((v.offset as { height?: number } | undefined)?.height ?? 0);
      this.streams.push(from);
      const ours = String(v.address ?? '').toLowerCase() === ACCOUNT && this.relay.registered;
      for (const a of ours ? this.actions() : [])
        if (a.transaction.block.height >= from)
          ws.send(JSON.stringify({ id: msg.id, type: 'next', payload: { data: { contractActions: a } } }));
    });
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
    if (query.includes('AccountHistoryTip')) return json(200, { data: { block: { height: this.tip() } } });
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
      // A transaction's raw bytes, by hash (AA 00047 P11.B: a swap's, for the evidence of a fill).
      const h = String(body.variables?.hash ?? '');
      this.byHash.push(h);
      const t = this.relay.chainTxs.get(h);
      return json(200, { data: { transactions: t?.raw ? [{ hash: h, raw: t.raw }] : [] } });
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
