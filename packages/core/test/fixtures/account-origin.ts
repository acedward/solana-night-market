// An account's ORIGIN as the public indexer serves it (AA 00047 P11, audit round 3 R3-1 / R3-10): the
// answers to the page's three origin reads (packages/core/src/passport/account-provenance.ts
// `ORIGIN_QUERY`, `deployTxQuery`, `originWindowQuery`), built in the test process from REAL
// serialised states (./account-state.ts: the compiled account's own constructor, the pinned key set's
// real verifier keys). For the core and web unit tests and the Playwright mock indexer.
//
// The honest origin is what the market's relay does (stagenet account A, test/fixtures/
// stagenet-account-a-origin.json): a deploy carrying the constructor's state with wave 1's keys and a
// live authority, then ONE maintenance update adding wave 2 and retiring the authority, a few blocks
// later, with nothing of the account's in between. A test makes it differ the ways a malicious relay
// could.

import { accountStateHex, FIXTURE_VERIFIER_KEYS, type AccountStateSpec } from './account-state.js';

/** The market account's wave 1 (the passport client's `ed25519AccountWaves({ withSwap: true })`; the
 *  page's `MARKET_ACCOUNT_WAVES`, which packages/core/test/account-provenance.test.ts keeps equal). Not
 *  imported from the page's code, so the fixture also serves the tests run against the code before
 *  P11 (fail-before). */
export const WAVE_ONE = [
  'deposit_unshielded',
  'deposit_shielded',
  'activate_initial_device_with_ed25519',
  'withdraw_unshielded_with_ed25519',
  'append_inbox_with_ed25519',
  'withdraw_shielded_with_ed25519',
  'withdraw_shielded_to_contract_with_ed25519',
  'rotate_enc_key_with_ed25519',
] as const;

export interface OriginSpec {
  account: string;
  deviceKey: string;
  /** The encryption key the account was created with (the browser's). */
  encKey: string;
  salt: string;
  /** What the deployer put into the deploy-time state besides the constructor's (a relay's choice). */
  deploy?: Pick<AccountStateSpec, 'round' | 'inbox' | 'credited' | 'unshielded' | 'authNonce' | 'boot'> & {
    /** Another encryption key or salt in the constructor's place. */
    encKey?: string;
    salt?: string;
    /** The deploy's operations (default: wave 1 with the pinned keys). */
    operations?: Readonly<Record<string, string>>;
  };
  /** The maintenance updates, oldest first (default: one, retiring, with every pinned key). */
  updates?: Array<{
    operations?: Readonly<Record<string, string>>;
    authority?: { committee: number; threshold: number };
  }>;
  /** The account's own actions in the deploy window besides the deploy and the update: a relay's
   *  writes while its authority was live (`sameTxAs`: inside the deploy's or the update's transaction). */
  windowExtra?: Array<{
    kind: 'call' | 'update' | 'deploy';
    entryPoint?: string;
    height?: number;
    sameTxAs?: 'deploy' | 'update';
  }>;
  /** The deploy's and the update's blocks (default 100 and 103, as on stagenet). */
  deployHeight?: number;
  updateHeight?: number;
  /** The indexer has no deploy record (R3-10); the deploy transaction is still readable by hash. */
  noDeployRecord?: boolean;
  /** No contract at the address at all. */
  noContract?: boolean;
  /** A block of the window the indexer does not serve. */
  missingBlock?: number;
  /** The deploy transaction's hash and identifier (the relay reports the identifier). */
  deployTxHash?: string;
  deployTxIdentifier?: string;
}

const pick = (names: readonly string[]) =>
  Object.fromEntries(names.map((n) => [n, FIXTURE_VERIFIER_KEYS[n]!])) as Record<string, string>;

/** The deploy-time state's operations in an honest deploy: wave 1, the pinned keys. */
export const WAVE_ONE_KEYS = pick(WAVE_ONE);

const OTHER_CONTRACT = '0c'.repeat(32);

/** The honest deploy transaction's hash and identifier, unless the spec names them. */
export const DEPLOY_TX_HASH = 'd0'.repeat(32);
export const DEPLOY_TX_IDENTIFIER = `00${'d1'.repeat(32)}`;

export interface OriginIndexer {
  /** The state the deploy created (hex). */
  deployState: string;
  /** The `data` of the indexer's answer to one of the page's origin reads, or undefined when the
   *  query is not one of them. */
  answer(query: string, variables: Record<string, unknown>): unknown;
}

/** The indexer's view of an account's origin. */
export async function originIndexer(spec: OriginSpec): Promise<OriginIndexer> {
  const d = spec.deploy ?? {};
  const base: AccountStateSpec = {
    account: spec.account,
    deviceKey: spec.deviceKey,
    encKey: d.encKey ?? spec.encKey,
    salt: d.salt ?? spec.salt,
    noDevice: true,
    booted: false,
    ...(d.boot ? { boot: d.boot } : {}),
  };
  const deployState = await accountStateHex({
    ...base,
    ...(d.round !== undefined ? { round: d.round } : {}),
    ...(d.authNonce !== undefined ? { authNonce: d.authNonce } : {}),
    inbox: d.inbox ?? [],
    ...(d.credited ? { credited: d.credited } : {}),
    ...(d.unshielded ? { unshielded: d.unshielded } : {}),
    operations: d.operations ?? WAVE_ONE_KEYS,
    authority: { committee: 1, threshold: 1 },
  });
  const updates = await Promise.all(
    (spec.updates ?? [{}]).map((u) =>
      accountStateHex({
        ...base,
        operations: u.operations ?? FIXTURE_VERIFIER_KEYS,
        authority: u.authority ?? { committee: 0, threshold: 1 },
      }),
    ),
  );

  const deployHeight = spec.deployHeight ?? 100;
  const updateHeight = spec.updateHeight ?? deployHeight + 3;
  const deployHash = spec.deployTxHash ?? DEPLOY_TX_HASH;
  const deployId = spec.deployTxIdentifier ?? DEPLOY_TX_IDENTIFIER;
  // Transactions (global ids in chain order): the deploy, the extras, then the updates.
  interface Tx {
    id: number;
    hash: string;
    height: number;
    actions: Array<{ __typename: string; address: string; entryPoint?: string }>;
  }
  let nextId = 1000;
  const deployTx: Tx = {
    id: nextId++,
    hash: deployHash,
    height: deployHeight,
    actions: [{ __typename: 'ContractDeploy', address: spec.account }],
  };
  const txs: Tx[] = [
    // Another contract's call in the deploy's block: not the account's, never counted.
    {
      id: nextId++,
      hash: 'c0'.repeat(32),
      height: deployHeight,
      actions: [{ __typename: 'ContractCall', address: OTHER_CONTRACT, entryPoint: 'mint' }],
    },
    deployTx,
  ];
  const typename = { call: 'ContractCall', update: 'ContractUpdate', deploy: 'ContractDeploy' } as const;
  const sameTx: Array<{ tx: 'deploy' | 'update'; action: Tx['actions'][number] }> = [];
  for (const [i, x] of (spec.windowExtra ?? []).entries()) {
    const action = {
      __typename: typename[x.kind],
      address: spec.account,
      ...(x.entryPoint ? { entryPoint: x.entryPoint } : {}),
    };
    if (x.sameTxAs) sameTx.push({ tx: x.sameTxAs, action });
    else
      txs.push({
        id: nextId++,
        hash: `e${i}`.padEnd(64, '0'),
        height: x.height ?? deployHeight + 1,
        actions: [action],
      });
  }
  const updateTxs: Tx[] = updates.map((_, i) => ({
    id: nextId++,
    hash: `a${i}`.padEnd(64, '0'),
    height: updateHeight + i,
    actions: [{ __typename: 'ContractUpdate', address: spec.account }],
  }));
  txs.push(...updateTxs);
  for (const s of sameTx) (s.tx === 'deploy' ? deployTx : updateTxs[0]!).actions.push(s.action);

  const stateAction = (state: string, tx: Tx) => ({
    state,
    transaction: { id: tx.id, hash: tx.hash, block: { height: tx.height } },
  });
  return {
    deployState,
    answer(query, variables) {
      if (query.includes('AccountOrigin($')) {
        if (spec.noContract || String(variables.address) !== spec.account) return { contract: null };
        return {
          contract: {
            deploys: spec.noDeployRecord ? [] : [stateAction(deployState, deployTx)],
            // The indexer serves the newest first, at most the limit asked (2).
            updates: updates
              .map((s, i) => stateAction(s, updateTxs[i]!))
              .reverse()
              .slice(0, 2),
          },
        };
      }
      if (query.includes('AccountDeployTx(')) {
        const tx = String(variables.tx);
        const hit = query.includes('identifier:') ? tx === deployId : tx === deployHash;
        if (spec.noContract || !hit) return { transactions: [] };
        return {
          transactions: [
            {
              id: deployTx.id,
              hash: deployTx.hash,
              block: { height: deployTx.height },
              contractActions: deployTx.actions.map((a) => ({ ...a, state: deployState })),
            },
          ],
        };
      }
      if (query.includes('AccountOriginWindow(')) {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(variables)) {
          const h = Number(v);
          out[k.replace(/^h/, 'b')] =
            h === spec.missingBlock
              ? null
              : {
                  height: h,
                  transactions: txs
                    .filter((t) => t.height === h)
                    .map((t) => ({ id: t.id, hash: t.hash, contractActions: t.actions })),
                };
        }
        return out;
      }
      return undefined;
    },
  };
}
