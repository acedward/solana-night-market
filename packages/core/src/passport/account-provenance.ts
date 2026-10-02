// Where an account came from, checked by the browser on the chain itself (AA 00047 P11, audit round 3
// R3-1 / F-A3-1 MAJOR, R3-10 / F-A3-6.3; spec FR-004b "Round 3"; questions Q26 A, Q42, Q49).
//
// A deploy carries its initial ledger state, and the deployer (the relay) chooses it freely. Round 3
// showed what that buys a malicious relay: an account identical to an honest one but for `round` set
// near 2^64 passes every check of the account's CURRENT state, works for a few calls, and then every
// call fails its overflow check, withdrawals included, with the deposited funds frozen for good
// (auditor A's probe `audit-a3-probe-round.ts`). A second route used the deploy's live maintenance
// authority: install a temporary verifier key, write any state with it, reinstall the pinned key,
// retire.
//
// So the page proves the account's ORIGIN, from the public indexer, with nothing taken from the relay:
//   1. The deploy-time state is the honest constructor's. The page runs the compiled account's own
//      constructor with the arguments it knows (this browser's encryption key, this network's salt,
//      no vault) and the one it cannot know, the boot commitment, read from the deployed state (it
//      binds the device that may activate; the device check covers who that is), and compares the
//      WHOLE ledger state with the one the indexer serves for the deploy TRANSACTION (not a block's):
//      byte for byte, and field by field for the report (`round`, the counters, the inbox, the
//      balances, the maps, the keys). The deploy also holds no tokens.
//   2. Between the deploy and the retirement of its maintenance authority, only the market's own
//      steps wrote anything: the deploy (exactly wave 1, with this build's pinned verifier keys), at
//      most the activation, and ONE maintenance update that adds wave 2 (pinned keys) and retires the
//      authority. Any other state write in that window (a call, a second update) is refused. After
//      the retirement no key can change, so every later write ran one of the pinned circuits.
//   3. (In ./account-chain.ts, on every check:) the counters stay far below their overflow, and every
//      credited unshielded balance is backed by the contract's real holding of that token.
//
// A deploy the indexer does not show (yet) is never judged on the CURRENT state instead (R3-10: that
// made the opening check stricter, and griefable by anyone's deposit): the deploy transaction is read
// by its hash when the page knows it, and otherwise the origin is "not known yet", which is retried
// and never kept as a refusal.

import {
  ChargedState,
  ContractState,
  type StateValue,
  createConstructorContext,
} from '@midnight-ntwrk/compact-runtime-0.20';
import { sha256 } from '@noble/hashes/sha2.js';

import { bytesToHex, hexToBytes, normaliseHex32 } from '../hex.js';
import { Contract, ledger, type Ledger } from '../../../../vendor/passport/contract/src/wallet/contract.js';
import { compareVerifierKeys, type AccountCheckProblem } from './account-chain.js';

// ── The market account's deploy waves ─────────────────────────────────────────────────

/** The circuits each wave of a deploy carries. */
export interface DeployWaves {
  waveOne: readonly string[];
  waveTwo: readonly string[];
}

/** A Night Market account's waves: the passport client's `ed25519AccountWaves({ withSwap: true })`
 *  (relay/src/passport/account-shape.ts deploys exactly these; relay/test/account-waves-core.test.ts
 *  keeps the two equal). Wave 1: the deposits, the activation and the arm's five gated circuits (the
 *  node's measured ceiling of eight operations); wave 2: the offer circuit, inserted by the
 *  maintenance update that retires the authority. */
export const MARKET_ACCOUNT_WAVES: DeployWaves = {
  waveOne: [
    'deposit_unshielded',
    'deposit_shielded',
    'activate_initial_device_with_ed25519',
    'withdraw_unshielded_with_ed25519',
    'append_inbox_with_ed25519',
    'withdraw_shielded_with_ed25519',
    'withdraw_shielded_to_contract_with_ed25519',
    'rotate_enc_key_with_ed25519',
  ],
  waveTwo: ['open_swap_shielded_with_ed25519'],
};

/** The one circuit that may write between the deploy and the retirement besides the market's own
 *  maintenance: the permissionless activation of the committed device. */
export const ACTIVATION_CIRCUIT = 'activate_initial_device_with_ed25519';

/** The longest deploy-to-retirement span the page reads, in blocks. The market's relay retires the
 *  authority in the transaction right after the deploy (3 blocks on stagenet, account A); a span
 *  longer than this is refused rather than read (a relay could otherwise make every page read
 *  without end). */
export const MAX_WINDOW_BLOCKS = 100;
/** Blocks per window read: the public indexer refuses a query of ~30 aliased block reads as "too
 *  complex" (16 pass; measured read-only on stagenet, 2026-10-02). */
export const WINDOW_PAGE = 10;

// ── What the indexer shows ───────────────────────────────────────────────────────────

/** One of the account's contract actions in the deploy window. */
export interface OriginAction {
  kind: 'deploy' | 'call' | 'update' | 'other';
  /** A call's circuit. */
  entryPoint?: string;
  /** The transaction's indexer id (a global order) and hash, and its block. */
  txId: number;
  txHash: string;
  height: number;
}

/** An action the indexer serves with the account's state right after it. */
export interface OriginStateAction {
  txId: number;
  txHash: string;
  height: number;
  /** The serialised ContractState after the action (hex). */
  state: string;
}

export interface AccountOrigin {
  account: string;
  /** The deploy, with the state it created. */
  deploy: OriginStateAction;
  /** Where the deploy was found: the indexer's deploy record, or the deploy transaction read by hash. */
  deployFrom: 'deploy-record' | 'deploy-transaction';
  /** The maintenance updates (the indexer is asked for at most 2: a market account has exactly one). */
  updates: OriginStateAction[];
  /** The account's actions in the transactions from the deploy's to the single update's (both
   *  included), in chain order; null when there is no single update, or the span is longer than
   *  `MAX_WINDOW_BLOCKS` (refused either way, so not read). */
  window: OriginAction[] | null;
}

/** The indexer's answer about an account's origin: found, or not (yet). */
export type OriginRead = { found: true; origin: AccountOrigin } | { found: false; reason: string };

/** The verdict on an account's origin. `known: false` is temporary (the indexer does not show the
 *  deploy yet): the page retries, and never keeps it as a refusal. */
export type OriginVerdict =
  { known: true; problems: AccountCheckProblem[] } | { known: false; problems: AccountCheckProblem[] };

export interface OriginExpectation {
  /** The encryption PUBLIC key this browser holds for the account (the constructor's argument). */
  encPublicKey: string;
  /** This network's salt (the constructor's argument). */
  networkSalt: string;
  /** This build's pinned verifier-key digests: circuit → SHA-256. */
  verifierKeys: Readonly<Record<string, string>>;
  /** The waves the market deploys (default `MARKET_ACCOUNT_WAVES`). */
  waves?: DeployWaves;
}

// ── 1. The constructor's state ──────────────────────────────────────────────────────────

const noWitnesses = new Proxy(
  {},
  {
    get: () => () => {
      throw new Error('the account constructor calls no witness');
    },
  },
);

/** The honest constructor's ledger state for these arguments (compact-runtime 0.20, the compiled
 *  account module the page already holds). No vault: a market account has no bridge. */
export async function constructorState(args: {
  boot: Uint8Array;
  encPublicKey: string;
  networkSalt: string;
}): Promise<StateValue> {
  const contract = new Contract(noWitnesses as never);
  const zero = new Uint8Array(32);
  const init = await (
    contract as unknown as {
      initialState(ctx: unknown, ...a: unknown[]): Promise<{ currentContractState: ContractState }>;
    }
  ).initialState(
    createConstructorContext({}, '00'.repeat(32)),
    Uint8Array.from(args.boot),
    hexToBytes(args.encPublicKey, 32),
    hexToBytes(args.networkSalt, 32),
    { bytes: zero },
    { bytes: Uint8Array.from(zero) },
  );
  return init.currentContractState.data.state;
}

/** A ledger state's canonical bytes: the state alone, re-wrapped (no operations, no authority, no
 *  balance, fresh storage charging), so two states serialise equal exactly when they are equal. */
export function canonicalStateBytes(state: StateValue): string {
  const cs = new ContractState();
  cs.data = new ChargedState(state);
  return bytesToHex(cs.serialize());
}

const hex = (b: Uint8Array) => bytesToHex(b);
const sorted = (xs: string[]) => [...xs].sort().join(',');

/** Every ledger field as text, for the field-by-field report. */
export function describeLedger(l: Ledger): Record<string, string> {
  return {
    round: l.round.toString(10),
    enc_key: hex(l.enc_key),
    inbox: sorted([...l.inbox].map(([k, v]) => `${k.toString(10)}:${hex(v)}`)),
    inbox_count: l.inbox_count.toString(10),
    unshielded_balances: sorted([...l.unshielded_balances].map(([c, v]) => `${hex(c)}:${v.toString(10)}`)),
    spec_version: l.spec_version.toString(10),
    devices: sorted([...l.devices].map(hex)),
    device_epoch: l.device_epoch.toString(10),
    device_count: l.device_count.toString(10),
    auth_nonce: l.auth_nonce.toString(10),
    boot: hex(l.boot),
    booted: String(l.booted),
    evm_domain_salt: hex(l.evm_domain_salt),
    vault: hex(l.vault.bytes),
    vault_address: hex(l.vault_address.bytes),
  };
}

/** The fields whose difference is "it did not start empty" (R2-6's words), not another origin. */
const EMPTINESS_FIELDS = new Set(['inbox', 'inbox_count', 'unshielded_balances']);

/** Compare a deploy-time state with the constructor's: the fields that differ (empty when equal). */
export async function compareWithConstructor(
  deployed: ContractState,
  e: Pick<OriginExpectation, 'encPublicKey' | 'networkSalt'>,
): Promise<{ equal: boolean; fields: string[] }> {
  const got = ledger(deployed.data);
  const honest = await constructorState({ boot: got.boot, encPublicKey: e.encPublicKey, networkSalt: e.networkSalt });
  const a = describeLedger(got);
  const b = describeLedger(ledger(honest));
  const fields = Object.keys(b).filter((k) => a[k] !== b[k]);
  const whole = canonicalStateBytes(deployed.data.state) === canonicalStateBytes(honest);
  // The whole state decides; the fields only say where. A difference the fields cannot name (another
  // layout, an extra cell) is still a difference.
  if (!whole && fields.length === 0) fields.push('layout');
  return { equal: whole && fields.length === 0, fields };
}

// ── 2. The verdict ──────────────────────────────────────────────────────────────────────

const provenance = (message: string, detail?: string): AccountCheckProblem => ({
  code: 'provenance',
  message,
  ...(detail ? { detail } : {}),
});

/** The plain words for a deploy-time state that is not the constructor's. */
const STARTING_STATE =
  'It was created with a different starting state than this site’s market gives every new account, which can make it stop working later with your tokens in it.';

const decodeState = (h: string): ContractState | null => {
  try {
    return ContractState.deserialize(hexToBytes(h.replace(/^0x/, '')));
  } catch {
    return null;
  }
};

const operationName = (op: string | Uint8Array): string => (typeof op === 'string' ? op : new TextDecoder().decode(op));

/** circuit → SHA-256 of its verifier key, as ./account-chain.ts reads it. */
function operationDigests(cs: ContractState): Record<string, string> {
  const out: Record<string, string> = {};
  for (const op of cs.operations()) {
    const vk = cs.operation(op)?.verifierKey;
    out[operationName(op)] = vk && vk.length > 0 ? hex(sha256(vk)) : '';
  }
  return out;
}

const pick = (keys: Readonly<Record<string, string>>, names: readonly string[]) =>
  Object.fromEntries(names.map((n) => [n, keys[n] ?? `missing:${n}`]));

const keysText = (k: ReturnType<typeof compareVerifierKeys>) =>
  [
    k.different.length ? `different: ${k.different.join(', ')}` : '',
    k.missing.length ? `missing: ${k.missing.join(', ')}` : '',
    k.extra.length ? `extra: ${k.extra.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('; ');

const actionText = (a: OriginAction) =>
  `${a.kind}${a.entryPoint ? ` ${a.entryPoint}` : ''} (tx ${a.txHash.slice(0, 12)}…, block ${a.height})`;

/**
 * Judge an account's origin (see the header). Every rule is checked; the problems are the page's.
 * `known: false` when the indexer does not show the deploy (yet).
 */
export async function checkAccountOrigin(read: OriginRead, e: OriginExpectation): Promise<OriginVerdict> {
  if (!read.found)
    return {
      known: false,
      problems: [
        {
          code: 'provenance-unknown',
          message: 'Midnight’s indexer does not show how this account was created yet.',
          detail: read.reason,
        },
      ],
    };
  const o = read.origin;
  const waves = e.waves ?? MARKET_ACCOUNT_WAVES;
  const problems: AccountCheckProblem[] = [];

  // (1) The deploy: the constructor's state, exactly wave 1 with the pinned keys, no tokens.
  const deployed = decodeState(o.deploy.state);
  if (!deployed) {
    problems.push(provenance(STARTING_STATE, 'the deploy-time state does not decode'));
  } else {
    let cmp: { equal: boolean; fields: string[] };
    try {
      cmp = await compareWithConstructor(deployed, e);
    } catch (err) {
      cmp = { equal: false, fields: [`not a Passport account (${(err as Error).message})`] };
    }
    if (!cmp.equal) {
      const empty = cmp.fields.filter((f) => EMPTINESS_FIELDS.has(f));
      const other = cmp.fields.filter((f) => !EMPTINESS_FIELDS.has(f));
      if (empty.some((f) => f !== 'unshielded_balances'))
        problems.push({
          code: 'not-empty',
          message: 'It was deployed with notes already in its inbox, which this site did not put there.',
          detail: `deploy-time ${empty.join(', ')}`,
        });
      if (empty.includes('unshielded_balances'))
        problems.push({
          code: 'not-empty',
          message: 'It was deployed with balances already in it, which this site did not put there.',
          detail: 'deploy-time unshielded_balances',
        });
      if (other.length > 0) problems.push(provenance(STARTING_STATE, `deploy-time ${other.join(', ')}`));
    }
    const held = [...deployed.balance.entries()].filter(([, v]) => v > 0n);
    if (held.length > 0)
      problems.push({
        code: 'not-empty',
        message: 'It was deployed with balances already in it, which this site did not put there.',
        detail: `deploy-time holdings ${held.length}`,
      });
    const deployKeys = compareVerifierKeys(operationDigests(deployed), pick(e.verifierKeys, waves.waveOne));
    if (!deployKeys.equal)
      problems.push(
        provenance(
          'It was created with other circuits than this site’s market deploys.',
          `deploy (wave 1): ${keysText(deployKeys)}`,
        ),
      );
  }

  // (2) The maintenance: exactly one update, which adds wave 2 with the pinned keys and retires the
  // authority.
  if (o.updates.length !== 1) {
    problems.push(
      provenance(
        o.updates.length === 0
          ? 'Its contract was never locked the way this site’s market locks every account.'
          : 'Its contract was changed after it was created, more than this site’s market ever does.',
        `${o.updates.length} maintenance updates`,
      ),
    );
  } else {
    const u = o.updates[0]!;
    const after = decodeState(u.state);
    if (u.txId <= o.deploy.txId)
      problems.push(provenance('Its history on Midnight is out of order.', 'update before deploy'));
    if (!after) {
      problems.push(provenance('Its contract was changed in a way this site cannot read.', 'update state'));
    } else {
      const ma = after.maintenanceAuthority;
      if (!(ma.committee.length === 0 && Number(ma.threshold) >= 1))
        problems.push(
          provenance(
            'Its contract was changed after it was created without being locked.',
            `update: committee ${ma.committee.length}, threshold ${ma.threshold}`,
          ),
        );
      const all = [...waves.waveOne, ...waves.waveTwo];
      const updateKeys = compareVerifierKeys(operationDigests(after), pick(e.verifierKeys, all));
      if (!updateKeys.equal)
        problems.push(
          provenance(
            'Its contract was given other circuits than this site’s market deploys.',
            `update (wave 2): ${keysText(updateKeys)}`,
          ),
        );
    }
    // (3) The window: nothing but the market's own steps wrote before the authority retired.
    if (o.window === null) {
      problems.push(
        provenance(
          'Its contract was locked too long after it was created for this site to check what happened before.',
          `deploy block ${o.deploy.height}, update block ${u.height}`,
        ),
      );
    } else {
      const strays: OriginAction[] = [];
      let activations = 0;
      for (const a of o.window) {
        if (a.txId === o.deploy.txId) {
          if (a.kind !== 'deploy') strays.push(a);
        } else if (a.txId === u.txId) {
          if (a.kind !== 'update') strays.push(a);
        } else if (a.kind === 'call' && a.entryPoint === ACTIVATION_CIRCUIT && activations === 0) {
          activations++;
        } else {
          strays.push(a);
        }
      }
      const deploys = o.window.filter((a) => a.kind === 'deploy' && a.txId === o.deploy.txId).length;
      const updates = o.window.filter((a) => a.kind === 'update' && a.txId === u.txId).length;
      if (deploys !== 1 || updates !== 1)
        problems.push(
          provenance(
            'Its history on Midnight does not show how it was created.',
            `window: ${deploys} deploys, ${updates} updates`,
          ),
        );
      if (strays.length > 0)
        problems.push(
          provenance(
            'Something changed it before its contract was locked, which this site’s market never does.',
            strays.map(actionText).join('; '),
          ),
        );
    }
  }
  return { known: true, problems };
}

// ── 3. Reading it from the public indexer ─────────────────────────────────────────────────

/** A GraphQL read (the page's chain reader). Throws when the indexer cannot answer. */
export type GraphQLRead = <T>(query: string, variables: Record<string, unknown>) => Promise<T>;

/** The deploy record and the maintenance updates, each with the state right after it. */
export const ORIGIN_QUERY = `query AccountOrigin($address: HexEncoded!) {
  contract(address: $address) {
    deploys: actions(limit: 1, type: DEPLOY) { state transaction { id hash block { height } } }
    updates: actions(limit: 2, type: UPDATE) { state transaction { id hash block { height } } }
  }
}`;

/** The deploy TRANSACTION by its hash or its identifier (R3-10: when the indexer has no deploy
 *  record). The relay reports a transaction's identifier (33 bytes), the indexer's records a hash. */
export const deployTxQuery = (by: 'hash' | 'identifier') => `query AccountDeployTx($tx: HexEncoded!) {
  transactions(offset: { ${by}: $tx }) { id hash block { height } contractActions { __typename address state } }
}`;

/** One page of the deploy window: `b<i>: block(offset: { height: $h<i> })`, with every transaction's
 *  contract actions. */
export const originWindowQuery = (n: number) =>
  `query AccountOriginWindow(${Array.from({ length: n }, (_, i) => `$h${i}: Int!`).join(', ')}) {\n` +
  Array.from(
    { length: n },
    (_, i) =>
      `  b${i}: block(offset: { height: $h${i} }) { height transactions { id hash contractActions { __typename address ... on ContractCall { entryPoint } } } }`,
  ).join('\n') +
  '\n}';

interface IndexerStateAction {
  state: string;
  transaction: { id: number; hash: string; block: { height: number } };
}
interface IndexerBlock {
  height: number;
  transactions: Array<{
    id: number;
    hash: string;
    contractActions: Array<{ __typename: string; address: string; entryPoint?: string }>;
  }>;
}

const low = (h: string) => h.replace(/^0x/, '').toLowerCase();
const stateAction = (a: IndexerStateAction): OriginStateAction => ({
  txId: a.transaction.id,
  txHash: low(a.transaction.hash),
  height: a.transaction.block.height,
  state: a.state,
});
const kindOf = (typename: string): OriginAction['kind'] =>
  typename === 'ContractDeploy'
    ? 'deploy'
    : typename === 'ContractCall'
      ? 'call'
      : typename === 'ContractUpdate'
        ? 'update'
        : 'other';

/**
 * Read an account's origin from the public indexer: its deploy (the deploy record, or else the deploy
 * transaction `deployTx` names, by hash or identifier, kept only when the chain shows it deploying
 * THIS account: an address has one deploy, so that transaction is the deploy whoever named it), its
 * maintenance updates, and every action of the account in the blocks from the deploy to the single
 * update (in pages of `WINDOW_PAGE`, at most `MAX_WINDOW_BLOCKS`).
 */
export async function readAccountOrigin(
  read: GraphQLRead,
  account: string,
  opts: { deployTx?: string | null } = {},
): Promise<OriginRead> {
  const address = normaliseHex32(account);
  const o = await read<{
    contract: { deploys: IndexerStateAction[]; updates: IndexerStateAction[] } | null;
  }>(ORIGIN_QUERY, { address });
  let deploy: OriginStateAction | null = o.contract?.deploys?.[0] ? stateAction(o.contract.deploys[0]) : null;
  let deployFrom: AccountOrigin['deployFrom'] = 'deploy-record';
  const hint = opts.deployTx ? low(opts.deployTx) : '';
  if (!deploy && /^[0-9a-f]{64,200}$/.test(hint)) {
    const t = await read<{
      transactions: Array<{
        id: number;
        hash: string;
        block: { height: number };
        contractActions: Array<{ __typename: string; address: string; state: string }>;
      }> | null;
    }>(deployTxQuery(hint.length === 64 ? 'hash' : 'identifier'), { tx: hint });
    for (const tx of t.transactions ?? []) {
      const d = tx.contractActions.find((a) => a.__typename === 'ContractDeploy' && low(a.address) === address);
      if (d) {
        deploy = { txId: tx.id, txHash: low(tx.hash), height: tx.block.height, state: d.state };
        deployFrom = 'deploy-transaction';
      }
    }
  }
  if (!deploy) return { found: false, reason: o.contract ? 'no deploy record' : 'no contract at this address' };
  const updates = (o.contract?.updates ?? []).map(stateAction);
  const origin: AccountOrigin = { account: address, deploy, deployFrom, updates, window: null };
  if (updates.length !== 1) return { found: true, origin };
  const u = updates[0]!;
  const span = u.height - deploy.height + 1;
  if (span < 1 || span > MAX_WINDOW_BLOCKS) return { found: true, origin };

  const heights = Array.from({ length: span }, (_, i) => deploy.height + i);
  const window: OriginAction[] = [];
  for (let i = 0; i < heights.length; i += WINDOW_PAGE) {
    const page = heights.slice(i, i + WINDOW_PAGE);
    const data = await read<Record<string, IndexerBlock | null>>(
      originWindowQuery(page.length),
      Object.fromEntries(page.map((h, k) => [`h${k}`, h])),
    );
    for (const [k, h] of page.entries()) {
      const b = data[`b${k}`];
      // The update is indexed, so every block before it is too: a block missing from the answer is
      // an indexer that cannot be read right now, not an empty block.
      if (!b || b.height !== h) return { found: false, reason: `block ${h} not served` };
      for (const tx of b.transactions) {
        if (tx.id < deploy.txId || tx.id > u.txId) continue;
        for (const a of tx.contractActions) {
          if (low(a.address) !== address) continue;
          window.push({
            kind: kindOf(a.__typename),
            ...(a.entryPoint ? { entryPoint: a.entryPoint } : {}),
            txId: tx.id,
            txHash: low(tx.hash),
            height: b.height,
          });
        }
      }
    }
  }
  window.sort((x, y) => x.height - y.height || x.txId - y.txId);
  return { found: true, origin: { ...origin, window } };
}
