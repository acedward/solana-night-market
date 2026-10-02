// The account operations, as the browser runs them (plan L-ACC): open an account, rebuild its
// coins from chain data, and the two gated calls of this lane (a withdrawal, and re-filing its
// change in the inbox, Q13). Each asks the wallet for exactly ONE signature, through the Solana
// wallet's `ActionSigning` (../wallet/signing.ts, lane B2).
//
// The browser is the source of truth (Q5): the encryption secret is generated and kept here,
// the inbox is decrypted here, every coin is kept here, and the relay receives only public keys,
// signatures and, for a spend, the one coin that spend consumes (research finding 2).
//
// The relay is TRUSTLESS (AA 00047 P9.S, spec FR-004b, questions Q26 A and Q31): what the page
// believes about the account comes from the public indexer (`env.chain`, ../chain/indexer.ts), never
// from the relay. Before any deposit, trade, withdrawal or sealed entry, the account must pass the
// market-account check on the chain's own state (the verifier keys pinned in this build, the
// authority retired, ONE device and it is this wallet's, this browser's encryption key, this
// network's salt); the nonce, the device counter, the inbox and the public balances are read there
// too. The relay still decodes the account's Zswap events (positions and spends, Q31), and the page
// checks that report against the indexer's raw events. A withdrawal's change coin is computed here,
// never taken from the relay (Q28 A).
//
// AA 00047 P10 (audit round 2, spec FR-004b "Round 2"):
//   - R2-5: a withdrawal's change is written down (a PENDING RECOVERY RECORD on the coin list: the
//     input coin, the amount, the expected change, the signed nonce) BEFORE the approval leaves the
//     page, and reconciled against the chain on every walk (`settlePendingWithdrawals`): it counts,
//     pays and is filed in the inbox only once the chain shows its leaf;
//   - R2-6: a just-opened account must be EMPTY (no inbox note, no balance), and a refusal at opening
//     holds (`refusedAtOpen`); only coins the chain confirms count (@nightmarket/core
//     `confirmedOnChain`); the indexer read goes past 500 transactions (../chain/indexer.ts);
//   - R2-3: an account whose on-chain encryption key is no longer this browser's, with this wallet
//     as its one device, gets "Restore my encryption key" (`restoreEncryptionKey`).

import {
  RELAY_ACTIONS,
  buildRelayActionMessage,
  bytesToHex,
  checkZswapActivity,
  chooseCoin,
  confirmedOnChain,
  contractCoinCommitment,
  contractCoinNullifier,
  encPublicKeyOf,
  hexToBytes,
  localCoin,
  parseShieldedAddress,
  reconcileCoins,
  type AccountStateView,
  type AppendInboxPayload,
  type CancelOffersPayload,
  type CancelOffersResult,
  type JobView,
  type OwnedInput,
  type PassportAuth,
  type RegisterResult,
  type RestoreEncKeyPayload,
  type RestoreEncKeyResult,
  type SignedRelayAction,
  type StoredCoin,
  type WithdrawPayload,
  type WithdrawResult,
  type WithdrawUnshieldedPayload,
  type WithdrawUnshieldedResult,
  parseUnshieldedAddress,
} from '@nightmarket/core';
import {
  accountCheckText,
  appendInboxRequest,
  cancelOffersRequest,
  withdrawUnshieldedRequest,
  generateEncKeyPairPortable,
  openEntryPortable,
  predictWithdrawChange,
  restoreEncKeyRequest,
  sameCoin,
  sealEntryPortable,
  withdrawRequest,
  type AccountCheck,
  type AccountCheckCode,
  type GatedContext,
} from '@nightmarket/core/passport';

import type { AccountChain, AccountOnChain } from '../chain/indexer.js';
import type { RelayClient } from '../relay/client.js';
import { jobErrorText } from '../relay/messages.js';
import { recordKey, type WalletScope } from '../store/schema.js';
import type { LocalStore } from '../store/store.js';
import type { ActionSigning } from '../wallet/signing.js';
import {
  readAccount,
  readCoins,
  readRoster,
  readSecret,
  type AccountRecord,
  type JobAction,
  type JobRecord,
  type SecretRecord,
} from './records.js';

export class OperationError extends Error {
  override name = 'OperationError';
}

/** A job the relay ran and reported failed, with the relay's code. */
export class JobFailedError extends OperationError {
  override name = 'JobFailedError';
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** The account failed the market-account check on the chain (audit C3): nothing is signed for it. */
export class AccountCheckError extends OperationError {
  override name = 'AccountCheckError';
  constructor(readonly check: AccountCheck) {
    super(
      `This account does not pass this site's checks on Midnight: ${accountCheckText(check)} Nothing was signed or sent. Do not send tokens to it.`,
    );
  }
}

export interface OperationEnv {
  relay: RelayClient;
  /** The browser's own reader of the chain: the public indexer (questions Q26 A). */
  chain: AccountChain;
  store: LocalStore;
  /** This wallet on this network (`owner` is its device key). */
  scope: WalletScope;
  /** How the connected Solana wallet signs (lane B2). */
  signing: ActionSigning;
  /** Where the job's progress goes (stages, queue position). */
  onJob?: (job: JobView) => void;
}

/** Sign a RelayAction envelope with the wallet: its signature, 128 lowercase hex. */
async function signEnvelope(env: OperationEnv, message: Parameters<ActionSigning['relayAction']>[0]) {
  const sig = await env.signing.relayAction(message);
  if (!/^[0-9a-f]{128}$/.test(sig)) throw new OperationError('The wallet returned no signature.');
  return sig;
}

export function putJob(
  env: OperationEnv,
  account: string | null,
  job: JobView,
  action: JobAction,
  context?: Record<string, unknown>,
) {
  const rec: JobRecord = {
    requestId: job.requestId,
    action,
    startedAt: Date.now(),
    state: job.state,
    stage: job.stage,
    ...(context ? { context } : {}),
  };
  env.store.put(env.scope, 'job', rec, { account, id: job.requestId });
}

export function updateJob(env: OperationEnv, account: string | null, job: JobView) {
  const key = recordKey(env.scope, 'job', { account, id: job.requestId });
  const prev = env.store.get<JobRecord>(key)?.data;
  if (prev)
    env.store.put(env.scope, 'job', { ...prev, state: job.state, stage: job.stage }, { account, id: job.requestId });
  env.onJob?.(job);
}

export const dropJob = (env: OperationEnv, account: string | null, requestId: string) =>
  env.store.remove(recordKey(env.scope, 'job', { account, id: requestId }));

// ── Open an account (L-ACC.1) ─────────────────────────────────────────────────────

/**
 * Register: generate the encryption key pair here (the secret is stored BEFORE anything leaves
 * the page), ask the wallet for ONE signature (the RelayAction, which is also the enrolment: its
 * owner IS the device key), and wait while the relay deploys both waves, retires the authority and
 * activates. Resumes a registration in flight.
 */
export async function openAccount(env: OperationEnv): Promise<AccountRecord> {
  const { relay, store, scope } = env;
  let secret = readSecret(store, scope, null);
  const inFlight = findJobs(env, null, 'register')[0];
  let requestId = inFlight?.requestId;

  if (!requestId) {
    if (!secret) {
      const kp = generateEncKeyPairPortable();
      secret = { encSecretKey: bytesToHex(kp.secretKey), encPublicKey: bytesToHex(kp.publicKey), pending: true };
      store.put(scope, 'secret', secret, { account: null });
    }
    const payload = { encPublicKey: secret.encPublicKey };
    const { nonce, maxTtlSeconds } = await relay.nonce();
    const message = buildRelayActionMessage({
      action: 'register',
      network: scope.network,
      owner: env.signing.deviceKey,
      payload,
      nonce,
      expiry: Math.floor(Date.now() / 1000) + Math.min(maxTtlSeconds, 300),
    });
    const signature = await signEnvelope(env, message);
    const job = await relay.submit('register', { payload, auth: { message, signature } });
    putJob(env, null, job, 'register');
    env.onJob?.(job);
    requestId = job.requestId;
  }
  if (!secret) throw new OperationError('The registration in progress has lost its key in this browser.');

  const done = await relay.waitForJob(requestId, (j) => updateJob(env, null, j));
  dropJob(env, null, requestId);
  if (done.state !== 'succeeded' || !done.result) {
    throw new OperationError(jobErrorText(done.error, 'The account could not be opened.'));
  }
  const r = done.result as unknown as RegisterResult;
  const account = String(r.account).replace(/^0x/, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(account)) throw new OperationError('The market reported no account address.');
  // The relay's word is not taken (Q26): read the new account from the chain and check it is the
  // market's own account, with this wallet as its ONLY device, at its first entry with nothing
  // signed yet, sealed to the key this browser generated, on this network. The records are kept
  // either way (so nothing is lost), but an account that fails is never used: every later action
  // checks it again on the chain and refuses.
  const check = await checkNewAccount(env, account, secret.encPublicKey, r.txs?.waveOne ?? null);
  // R2-6: what only a NEW account must be (nothing signed yet, nothing in it) cannot be checked again
  // later, so a failure of it is kept with the account: every later action refuses it too.
  const atOpen = check.problems.filter((p) => OPEN_ONLY_CODES.includes(p.code));
  const record: AccountRecord = {
    address: account,
    device: env.signing.deviceKey,
    network: scope.network,
    createdAt: Date.now(),
    txs: r.txs,
    ...(atOpen.length > 0 ? { refusedAtOpen: atOpen.map((p) => ({ code: p.code, message: p.message })) } : {}),
  };
  const finalSecret: SecretRecord = { encSecretKey: secret.encSecretKey, encPublicKey: secret.encPublicKey };
  store.put(scope, 'secret', finalSecret, { account });
  store.put(scope, 'account', record, { account });
  store.put(scope, 'roster', { useCounter: '0' }, { account });
  store.put(scope, 'coins', [], { account });
  store.remove(recordKey(scope, 'secret', { account: null }));
  if (!check.ok) throw new AccountCheckError(check);
  return record;
}

/** The new-account rules that hold only at opening (R2-6): once used, an account is neither fresh
 *  nor empty, so these are checked once and their failure is kept (`AccountRecord.refusedAtOpen`). */
const OPEN_ONLY_CODES: readonly AccountCheckCode[] = ['not-fresh', 'not-empty'];

/** The refusal kept from the account's opening, as a check (R2-6), or null. */
export function refusalAtOpen(env: Pick<OperationEnv, 'store' | 'scope'>, account: string): AccountCheck | null {
  const kept = readAccount(env.store, env.scope, account)?.refusedAtOpen;
  if (!kept?.length) return null;
  return {
    ok: false,
    useCounter: null,
    problems: kept.map((p) => ({ code: p.code as AccountCheckCode, message: p.message })),
  };
}

/** How long the page waits for the public indexer to show a just-opened account, and how often it
 *  asks (the relay reports success once the activation lands; an indexer can lag a few blocks). */
export const NEW_ACCOUNT_WAIT_MS = 90_000;
export const NEW_ACCOUNT_POLL_MS = 3_000;

/** The fresh-account check, waiting for the indexer to show the activated account and its deploy. */
async function checkNewAccount(
  env: OperationEnv,
  account: string,
  encPublicKey: string,
  deployTx: string | null,
): Promise<AccountCheck> {
  const deadline = Date.now() + NEW_ACCOUNT_WAIT_MS;
  for (;;) {
    let found: Awaited<ReturnType<AccountChain['checkAccount']>>;
    try {
      found = await env.chain.checkAccount(account, {
        deviceKey: env.signing.deviceKey,
        encPublicKey,
        fresh: true,
        deployTx,
      });
    } catch (e) {
      if (Date.now() >= deadline) throw e;
      await sleep(NEW_ACCOUNT_POLL_MS);
      continue;
    }
    // Not on the indexer yet (no contract, not activated yet, or its deploy not shown yet: AA 00047
    // P11, R3-10): wait. Anything else is final. A deploy still not shown at the deadline is NOT a
    // refusal kept with the account (`provenance-unknown` is not an opening-only code): every later
    // check reads it again.
    const waiting = !found.state || !found.state.view.booted || originUnknown(found.check);
    if (!waiting || Date.now() >= deadline) return found.check;
    await sleep(NEW_ACCOUNT_POLL_MS);
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const low = (h: string) => h.replace(/^0x/, '').toLowerCase();

/** The check could not judge the account's origin yet (the indexer shows no deploy): temporary. */
export const originUnknown = (c: Pick<AccountCheck, 'problems'>): boolean =>
  c.problems.some((p) => p.code === 'provenance-unknown');

/** The account's deploy transaction as this browser recorded it at opening (R3-10's fallback when
 *  the indexer has no deploy record), or null. */
const deployTxOf = (env: Pick<OperationEnv, 'store' | 'scope'>, account: string): string | null =>
  readAccount(env.store, env.scope, account)?.txs?.waveOne || null;

/**
 * The account as the chain shows it, after the market-account check for this wallet and this
 * browser's key (audit C3). Throws AccountCheckError when it fails: the caller signs nothing.
 */
export async function verifiedAccount(
  env: Pick<OperationEnv, 'chain' | 'store' | 'scope' | 'signing'>,
  account: string,
) {
  const secret = readSecret(env.store, env.scope, account);
  if (!secret)
    throw new OperationError('This browser does not hold the account secret. Import your export to use it here.');
  const kept = refusalAtOpen(env, account);
  if (kept) throw new AccountCheckError(kept);
  const hint = readRoster(env.store, env.scope, account)?.useCounter;
  const { state, check } = await env.chain.checkAccount(account, {
    deviceKey: env.signing.deviceKey,
    encPublicKey: secret.encPublicKey,
    ...(hint !== undefined ? { counterHint: BigInt(hint) } : {}),
    deployTx: deployTxOf(env, account),
  });
  if (!state) throw new OperationError('Midnight has no account at this address (the indexer does not show it).');
  if (!check.ok) throw new AccountCheckError(check);
  return state;
}

export function findJobs(env: Pick<OperationEnv, 'store' | 'scope'>, account: string | null, action?: JobAction) {
  const out: JobRecord[] = [];
  for (const r of env.store.list(env.scope)) {
    if (r.parsed.kind !== 'job' || r.parsed.scope.global || !r.record) continue;
    if (r.parsed.scope.account !== account) continue;
    const j = r.record.data as JobRecord;
    if (!action || j.action === action) out.push(j);
  }
  return out;
}

// ── Rebuild the coins from chain data (L-ACC.2, L-ACC.4) ────────────────────────────

export interface SyncResult {
  state: AccountStateView;
  coins: StoredCoin[];
  /** Inbox entries that did not open with this browser's secret (not ours, or poisoned). */
  unreadable: number;
  /** The market-account check on the chain's state (audit C3). Balances are shown either way;
   *  every action refuses an account that fails it. */
  check: AccountCheck;
  /** The relay's reported coin facts that the indexer's own events do not carry (dropped, Q31). */
  unsupported: number;
  /** The account's public balances, from the chain. */
  unshielded: AccountOnChain['unshielded'];
  /** Unspent coins the chain does not confirm (an inbox note with no leaf, a change not shown yet):
   *  not in any balance (R2-6). */
  unconfirmed: number;
}

/**
 * The inbox walk: read the account's state from the CHAIN (its inbox ciphertexts included), decrypt
 * HERE with the account's secret, then reconcile with the ledger's record of the account's leaves
 * (the exact `mt_index` of each coin) and spends (nullifiers). The relay decodes those from the
 * ledger's events; its report is kept only where the indexer's own raw events carry it (Q31). Coins
 * that only this browser knows (a withdrawal's change not yet filed, Q13) are kept.
 */
export async function syncAccount(env: OperationEnv, account: string): Promise<SyncResult> {
  const { relay, store, scope } = env;
  const secret = readSecret(store, scope, account);
  if (!secret)
    throw new OperationError('This browser does not hold the account secret. Import your export to use it here.');
  const found = await env.chain.checkAccount(account, {
    deviceKey: env.signing.deviceKey,
    encPublicKey: secret.encPublicKey,
  });
  const onChain = found.state;
  if (!onChain) throw new OperationError('The market cannot find this account on the network.');
  const sk = hexToBytes(secret.encSecretKey, 32);
  const inbox: Array<{ nonce: string; color: string; value: string; inboxIndex: string }> = [];
  let unreadable = 0;
  for (const [i, entry] of onChain.inbox.entries()) {
    if (!entry) continue;
    const coin = await openEntryPortable(sk, hexToBytes(entry, 192));
    if (!coin) {
      unreadable++;
      continue;
    }
    inbox.push({
      nonce: bytesToHex(coin.nonce),
      color: bytesToHex(coin.color),
      value: coin.value.toString(10),
      inboxIndex: String(i),
    });
  }
  const previous = readCoins(store, scope, account);
  const reported = await relay.zswap(account);
  // The transactions the report names for coins this browser knows: what the chain read must hold
  // (the indexer's newest page, then the rest by hash for a long history, R2-6).
  const commitments = new Set<string>();
  const nullifiers = new Set<string>();
  for (const c of [...previous, ...inbox, ...previous.flatMap((p) => (p.pending ? [p.pending.input] : []))]) {
    commitments.add(contractCoinCommitment(c, account));
    nullifiers.add(contractCoinNullifier(c, account));
  }
  const need = [
    ...reported.outputs.filter((o) => commitments.has(low(o.commitment))).map((o) => o.txHash),
    ...reported.inputs.filter((i) => nullifiers.has(low(i.nullifier))).map((i) => i.txHash),
  ];
  const txs = await env.chain.accountTransactions(account, need);
  const checked = checkZswapActivity(account, reported, txs);
  const coins = settlePendingWithdrawals(
    account,
    reconcileCoins({
      account,
      inbox,
      outputs: checked.activity.outputs,
      inputs: checked.activity.inputs,
      previous,
    }),
    checked.activity.inputs,
    BigInt(onChain.view.authNonce),
  );
  store.put(scope, 'coins', coins, { account });
  return {
    state: onChain.view,
    coins,
    unreadable,
    check: found.check,
    unsupported: checked.unsupported.length,
    unshielded: onChain.unshielded,
    unconfirmed: coins.filter((c) => !c.spent && !confirmedOnChain(c)).length,
  };
}

/**
 * Reconcile every PENDING RECOVERY RECORD (a withdrawal's change, written before it was sent; R2-5)
 * against the chain:
 *   - the chain shows the change's leaf: confirmed, the record becomes an ordinary change coin
 *     (spendable now, and filed in the inbox by `secureChange`);
 *   - the account's nonce moved past the one it signed and the coin it spends was never spent on
 *     chain: that withdrawal can never land, so the record goes, and the input coin, if this browser
 *     had set it aside, is spendable again;
 *   - the input coin was spent and another record of the same coin is the one the chain shows: this
 *     one goes;
 *   - otherwise it stays pending: the withdrawal may still land (the nonce has not moved), or it
 *     landed and the change is not shown yet. Never in a balance, never spendable, meanwhile.
 * `inputs` are the spends the chain confirms (the relay's report, checked against the indexer).
 */
export function settlePendingWithdrawals(
  account: string,
  coins: readonly StoredCoin[],
  inputs: readonly OwnedInput[],
  chainNonce: bigint,
): StoredCoin[] {
  const spentOnChain = new Set(inputs.map((i) => low(i.nullifier)));
  const inputOf = (c: StoredCoin) => contractCoinCommitment(c.pending!.input, account);
  const landed = new Set(coins.filter((c) => c.pending && confirmedOnChain(c)).map(inputOf));
  const release = new Set<string>();
  const out: StoredCoin[] = [];
  for (const c of coins) {
    if (!c.pending) {
      out.push(c);
      continue;
    }
    if (confirmedOnChain(c)) {
      const { pending: _p, ...confirmed } = c;
      out.push(confirmed);
      continue;
    }
    const input = inputOf(c);
    const inputSpent = spentOnChain.has(contractCoinNullifier(c.pending.input, account));
    if (chainNonce > BigInt(c.pending.authNonce)) {
      if (!inputSpent) {
        release.add(input);
        continue;
      }
      if (landed.has(input)) continue;
    }
    out.push(c);
  }
  return out.map((c) => {
    if (!release.has(c.commitment) || !c.spent || spentOnChain.has(contractCoinNullifier(c, account))) return c;
    const { spentTx: _t, ...rest } = c;
    return { ...rest, spent: false };
  });
}

/** Coins the chain does not confirm yet that this browser computed itself (a withdrawal's change
 *  waiting for its leaf, R2-5): shown as pending, with the amount the signed withdrawal fixes. */
export const pendingChanges = (coins: readonly StoredCoin[]) => coins.filter((c) => !c.spent && !!c.pending);

/** Inbox notes whose coin the chain does not confirm: possibly fake (anyone can file a note, R2-6),
 *  so only counted, never shown as an amount. */
export const unconfirmedNotes = (coins: readonly StoredCoin[]) =>
  coins.filter((c) => !c.spent && !c.pending && c.inInbox && !confirmedOnChain(c));

// ── The gated calls (L-ACC.3, L-ACC.4, L-ACC.5) ─────────────────────────────────────

/**
 * What a gated call is built against, from the CHAIN, after the market-account check: the auth
 * nonce, the device's use counter, the network salt and the encryption key all come from the
 * account's own on-chain state (Q26), never from the relay.
 */
export async function gatedContext(env: OperationEnv, account: string) {
  const onChain = await verifiedAccount(env, account);
  const state = onChain.view;
  if (!state.booted) throw new OperationError('The account is not active.');
  const hint = BigInt(readRoster(env.store, env.scope, account)?.useCounter ?? '0');
  const counter = env.signing.useCounter(state, hint);
  if (counter === null) throw new OperationError('This wallet is not a device of this account.');
  const ctx: GatedContext = {
    account,
    authNonce: BigInt(state.authNonce),
    networkSalt: state.networkSalt,
    encKey: state.encKey,
  };
  return { state, counter, ctx };
}

/**
 * A RelayAction over the WHOLE body (security review F-B6), for arguments the contract's own
 * challenge does not cover: the relay checks it names this body exactly, and the same device.
 */
async function relayEnvelope(
  env: OperationEnv,
  action: 'withdraw',
  account: string,
  payload: Record<string, unknown>,
): Promise<SignedRelayAction> {
  const { nonce, maxTtlSeconds } = await env.relay.nonce();
  const message = buildRelayActionMessage({
    action,
    network: env.scope.network,
    owner: env.signing.deviceKey,
    account,
    payload,
    nonce,
    expiry: Math.floor(Date.now() / 1000) + Math.min(maxTtlSeconds, 300),
  });
  return { message, signature: await signEnvelope(env, message) };
}

async function submitGated(
  env: OperationEnv,
  account: string,
  action: 'withdraw' | 'withdraw-unshielded' | 'append-inbox' | 'cancel-offers' | 'restore-enc-key',
  payload:
    WithdrawPayload | WithdrawUnshieldedPayload | AppendInboxPayload | CancelOffersPayload | RestoreEncKeyPayload,
  passportAuth: PassportAuth,
  counter: bigint,
  context: Record<string, unknown>,
  opts: { envelope?: boolean } = {},
): Promise<JobView> {
  if (!RELAY_ACTIONS.includes(action)) throw new OperationError('unknown action');
  const body = payload as unknown as Record<string, unknown>;
  const auth = opts.envelope && action === 'withdraw' ? await relayEnvelope(env, action, account, body) : undefined;
  const job = await env.relay.submit(action, {
    account,
    payload: body,
    passportAuth,
    ...(auth ? { auth } : {}),
  });
  putJob(env, account, job, action, context);
  env.onJob?.(job);
  const done = await env.relay.waitForJob(job.requestId, (j) => updateJob(env, account, j));
  dropJob(env, account, job.requestId);
  if (done.state !== 'succeeded')
    throw new JobFailedError(
      done.error?.code ?? 'failed',
      jobErrorText(done.error, 'The market could not complete this.'),
    );
  env.store.put(env.scope, 'roster', { useCounter: (counter + 1n).toString(10) }, { account });
  return done;
}

/** A payee: a shielded wallet address (`mn_shield-addr_…`, both keys), or a bare 32-byte coin
 *  public key (only the relay's own wallet can be paid that way: nothing is sealed to it). */
export function recipientOf(text: string, network: string): { coinPublicKey: string; encryptionPublicKey?: string } {
  const t = text.trim();
  if (/^mn_/i.test(t)) {
    const a = parseShieldedAddress(t, network);
    return { coinPublicKey: a.coinPublicKey, encryptionPublicKey: a.encryptionPublicKey };
  }
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(t)) return { coinPublicKey: t.replace(/^0x/, '').toLowerCase() };
  throw new OperationError('Enter a shielded wallet address (mn_shield-addr_…).');
}

/**
 * Pay `amount` of `color` from ONE coin to a shielded wallet (its address). The
 * browser picks the coin (the smallest that covers it, Q9) and resolves its exact position first,
 * so the wallet is asked once. The change is COMPUTED HERE from the signed coin and amount (Q28 A;
 * @nightmarket/core/passport `predictWithdrawChange`) and kept here; it has no inbox entry until
 * `secureChange` files one (Q13). The relay's report of the change is only compared: when it
 * differs, `changeMismatch` says so and the browser's coin is the one kept.
 *
 * R2-5: the change is written down as a PENDING RECOVERY RECORD as soon as the wallet has signed and
 * BEFORE anything is sent, so a relay that reports a failure, or never answers, cannot make this
 * browser forget it; it stays pending (no balance, not spendable, not filed) until the chain shows
 * it (`settlePendingWithdrawals`, on every walk).
 */
export async function withdrawToWallet(
  env: OperationEnv,
  account: string,
  args: { color: string; amount: bigint; recipient: string },
  opts: { recipientEnvelope?: boolean } = {},
): Promise<{ txId: string; change: StoredCoin | null; changeMismatch: boolean }> {
  const to = recipientOf(args.recipient, env.scope.network);
  const coins = readCoins(env.store, env.scope, account);
  const coin = chooseCoin(coins, args.color, args.amount);
  const { state, counter, ctx } = await gatedContext(env, account);
  const payload: WithdrawPayload = {
    recipient: to.coinPublicKey,
    ...(to.encryptionPublicKey ? { recipientEncryptionKey: to.encryptionPublicKey } : {}),
    color: coin.color,
    amount: args.amount.toString(10),
    coin: { nonce: coin.nonce, color: coin.color, value: coin.value, mtIndex: coin.mtIndex },
    authNonce: state.authNonce,
  };
  const passportAuth = await env.signing.authorise(ctx, { kind: 'gated', request: withdrawRequest(payload) }, counter);
  // The change follows from what the wallet signed (the coin and the amount): computed here, never
  // taken from the relay (Q28 A), and written down before the approval leaves the page (R2-5).
  const expected = predictWithdrawChange(coin, args.amount);
  const pending: StoredCoin | null = expected
    ? {
        ...localCoin(expected, account, 'change'),
        changeOf: { spent: coin.commitment, amount: args.amount.toString(10) },
        pending: {
          authNonce: state.authNonce,
          input: { nonce: coin.nonce, color: coin.color, value: coin.value },
          since: Date.now(),
        },
      }
    : null;
  if (pending) putCoin(env, account, pending);
  // Paying a wallet seals the coin to its encryption key, which the contract's challenge does not
  // cover (security review F-B6). Night Market asks ONE prompt per action (questions Q13 option B):
  // the encryption key rides the request unsigned, unless the relay turns F-B6's second signature
  // back on (its public config's `withdrawRecipientEnvelope`), when the wallet signs an envelope too.
  const done = await submitGated(
    env,
    account,
    'withdraw',
    payload,
    passportAuth,
    counter,
    { spent: coin.commitment },
    { envelope: opts.recipientEnvelope === true && payload.recipientEncryptionKey !== undefined },
  );
  const result = done.result as unknown as WithdrawResult;
  // The relay's report of the change must say the same; if not, the browser's coin is kept and the
  // caller says so. The change has no inbox entry yet (Q13); the market's single-use entitlement to
  // file one is kept with it (security review F-B3). It stays PENDING until the chain shows it (R2-5).
  const reported = result.change ?? null;
  const changeMismatch = expected === null ? reported !== null : !sameCoin(expected, reported);
  const change = pending
    ? {
        ...(readCoins(env.store, env.scope, account).find((c) => c.commitment === pending.commitment) ?? pending),
        ...(result.txId ? { createdTx: result.txId } : {}),
        ...(result.changeEntitlement ? { appendEntitlement: result.changeEntitlement } : {}),
      }
    : null;
  // The spent coin is set aside now; the next walk confirms the spend from the ledger's nullifier (or
  // gives it back, if the withdrawal never lands: `settlePendingWithdrawals`).
  const next = readCoins(env.store, env.scope, account).map((c) =>
    c.commitment === coin.commitment ? { ...c, spent: true, spentTx: result.txId } : c,
  );
  env.store.put(env.scope, 'coins', next, { account });
  if (change) putCoin(env, account, change);
  return { txId: result.txId, change, changeMismatch };
}

/** Add or replace one coin of the account's list (by its commitment). */
function putCoin(env: Pick<OperationEnv, 'store' | 'scope'>, account: string, coin: StoredCoin) {
  const list = readCoins(env.store, env.scope, account).filter((c) => c.commitment !== coin.commitment);
  env.store.put(env.scope, 'coins', [...list, coin], { account });
}

/** What became of a withdrawal's change, from the chain (R2-5). */
export type ChangeOutcome =
  /** The chain shows it: spendable, and ready to be filed in the inbox. */
  | { state: 'confirmed'; coin: StoredCoin }
  /** The withdrawal can never land (the nonce moved on without it): there is no change. */
  | { state: 'void' }
  /** Not shown yet: still pending, kept in this browser. */
  | { state: 'pending'; coin: StoredCoin };

/** Walk the account until the chain shows a withdrawal's change (or shows it never came), for at
 *  most `waitMs`. */
export async function awaitChange(
  env: OperationEnv,
  account: string,
  commitment: string,
  waitMs = NEW_ACCOUNT_WAIT_MS,
): Promise<ChangeOutcome> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    await syncAccount(env, account);
    const c = readCoins(env.store, env.scope, account).find((x) => x.commitment === commitment);
    if (!c) return { state: 'void' };
    if (!c.pending && confirmedOnChain(c)) return { state: 'confirmed', coin: c };
    if (Date.now() >= deadline) return { state: 'pending', coin: c };
    await sleep(NEW_ACCOUNT_POLL_MS);
  }
}

/** What the page says while a withdrawal's change is not on the chain yet (R2-5). */
export const CHANGE_PENDING =
  'Midnight does not show this change yet, so it cannot be saved in your inbox or used. It is kept in this browser, and the page saves it once Midnight shows it.';

/**
 * Pay `amount` of `color` from the account's UNSHIELDED balance to an unshielded wallet
 * (`mn_addr_…`): the arm's `withdraw_unshielded_with_ed25519`, ONE signature (its F3 message shows
 * the amount, the token and the recipient's fingerprint). Unshielded tokens are public balances, not
 * coins: nothing is kept here, and the next balance read shows the change.
 */
export async function withdrawUnshieldedToWallet(
  env: OperationEnv,
  account: string,
  args: { color: string; amount: bigint; recipient: string; balance?: bigint },
): Promise<{ txId: string }> {
  let recipient: string;
  try {
    recipient = parseUnshieldedAddress(args.recipient, env.scope.network);
  } catch (e) {
    throw new OperationError(e instanceof Error ? e.message : 'Enter an unshielded wallet address (mn_addr_…).');
  }
  if (args.amount <= 0n) throw new OperationError('Enter an amount above zero.');
  if (args.balance !== undefined && args.amount > args.balance)
    throw new OperationError('The account does not hold that much of this token (unshielded).');
  const { state, counter, ctx } = await gatedContext(env, account);
  const payload: WithdrawUnshieldedPayload = {
    recipient,
    color: args.color.replace(/^0x/, '').toLowerCase(),
    amount: args.amount.toString(10),
    authNonce: state.authNonce,
  };
  const passportAuth = await env.signing.authorise(
    ctx,
    { kind: 'gated', request: withdrawUnshieldedRequest(payload) },
    counter,
  );
  const done = await submitGated(env, account, 'withdraw-unshielded', payload, passportAuth, counter, {
    color: payload.color,
  });
  const result = done.result as unknown as WithdrawUnshieldedResult | undefined;
  return { txId: String(result?.txId ?? '') };
}

/**
 * File an inbox entry for a coin that has none (Q13 default A: a withdrawal's change), so the
 * chain alone can restore it: the entry is sealed HERE to the account's own public key, and the
 * wallet signs the `AppendInbox` call once.
 */
export async function secureChange(env: OperationEnv, account: string, given: StoredCoin): Promise<{ txId: string }> {
  // Whether the chain shows it is taken from the coin as this browser holds it NOW (the last walk may
  // have confirmed it, R2-5), never from a copy the caller kept.
  const stored = readCoins(env.store, env.scope, account).find((c) => c.commitment === given.commitment);
  const { pending: _stale, ...rest } = given;
  const coin: StoredCoin = stored
    ? { ...rest, mtIndex: stored.mtIndex, ...(stored.pending ? { pending: stored.pending } : {}) }
    : given;
  // The market pays for filing an entry only against the entitlement it issued for this coin (F-B3):
  // without one, say so before the wallet is asked for anything.
  if (!coin.appendEntitlement) {
    throw new OperationError(
      'The market has no record of this coin as change it can file, so it cannot secure it. It stays spendable from this browser: keep your Export up to date.',
    );
  }
  // Q28 A: the entry must describe exactly the change the withdrawal created, recomputed here from
  // the coin it was paid from and the amount (both signed), before the wallet is asked to seal it.
  const paidFrom = coin.changeOf
    ? readCoins(env.store, env.scope, account).find((c) => c.commitment === coin.changeOf!.spent)
    : undefined;
  const recomputed = (() => {
    try {
      return paidFrom && coin.changeOf ? predictWithdrawChange(paidFrom, BigInt(coin.changeOf.amount)) : null;
    } catch {
      return null; // the stored amount exceeds the coin: not a change this page recorded
    }
  })();
  if (!sameCoin(recomputed, coin)) {
    throw new OperationError(
      'This coin is not the change its withdrawal creates (recomputed in this browser), so it is not recorded. Nothing was signed.',
    );
  }
  // R2-5: an entry is filed only for a change the CHAIN shows (its leaf), never for a pending record.
  if (coin.pending || !confirmedOnChain(coin)) throw new OperationError(CHANGE_PENDING);
  const { state, counter, ctx } = await gatedContext(env, account);
  const entry = await sealEntryPortable(hexToBytes(state.encKey, 32), {
    nonce: hexToBytes(coin.nonce, 32),
    color: hexToBytes(coin.color, 32),
    value: BigInt(coin.value),
  });
  const payload: AppendInboxPayload = {
    entry: bytesToHex(entry),
    authNonce: state.authNonce,
    entitlement: coin.appendEntitlement,
  };
  const passportAuth = await env.signing.authorise(
    ctx,
    { kind: 'gated', request: appendInboxRequest(payload) },
    counter,
  );
  const done = await submitGated(env, account, 'append-inbox', payload, passportAuth, counter, {
    coin: coin.commitment,
  });
  return { txId: String((done.result as { txId?: unknown } | undefined)?.txId ?? '') };
}

/** What the page says when the market cannot land a cancel yet. */
export const CANCEL_UNAVAILABLE =
  'This market cannot cancel offers yet. Nothing was signed on chain; your offer stops working on its own at the expiry you signed.';

/**
 * "Cancel offer" (audit C6, questions Q30): end EVERY open approval of the account at once, its open
 * offers included. The wallet signs the arm's `rotate_enc_key` with the account's CURRENT key (read
 * from the chain, so the call changes nothing but the auth nonce), the relay lands it, and the
 * account's nonce moves: every approval signed at the old nonce (a listed offer, a take a relay may
 * be holding) can never execute. Done only when the CHAIN shows the new nonce.
 */
export async function cancelOpenApprovals(
  env: OperationEnv,
  account: string,
): Promise<{ txId: string; authNonce: string }> {
  const { state, counter, ctx } = await gatedContext(env, account);
  const signedAt = BigInt(state.authNonce);
  const payload: CancelOffersPayload = { newKey: state.encKey, authNonce: state.authNonce };
  const passportAuth = await env.signing.authorise(
    ctx,
    { kind: 'gated', request: cancelOffersRequest(payload) },
    counter,
  );
  let done: JobView;
  try {
    done = await submitGated(env, account, 'cancel-offers', payload, passportAuth, counter, {});
  } catch (e) {
    if (unavailable(e)) throw new OperationError(CANCEL_UNAVAILABLE);
    throw e;
  }
  const txId = String((done.result as Partial<CancelOffersResult> | undefined)?.txId ?? '');
  // The relay's "succeeded" is not the proof: the chain's nonce is (Q26).
  const deadline = Date.now() + NEW_ACCOUNT_WAIT_MS;
  for (;;) {
    const now = await env.chain.accountState(account);
    if (now && BigInt(now.authNonce) > signedAt) return { txId, authNonce: now.authNonce };
    if (Date.now() >= deadline)
      throw new OperationError(
        'The market reported the cancel done, but Midnight does not show it yet. Refresh in a minute; until the chain shows it, treat your offer as open.',
      );
    await sleep(NEW_ACCOUNT_POLL_MS);
  }
}

/** Coins that exist only in this browser (no inbox entry yet) and that the chain shows: shown as
 *  "not yet secured", with "Save it now". A change still pending (R2-5) is not one of them yet. */
export const unsecuredCoins = (coins: readonly StoredCoin[]) =>
  coins.filter((c) => !c.spent && !c.inInbox && !c.pending);

// ── Restore my encryption key (AA 00047 P10, audit round 2 R2-3) ────────────────────────────────

/** Whether a failed account check is ONLY that the account's encryption key is not this browser's:
 *  the wallet is its one device (that part passed), so it can sign the key back (R2-3). */
export const restorableCheck = (c: Pick<AccountCheck, 'ok' | 'problems'>): boolean =>
  !c.ok && c.problems.length > 0 && c.problems.every((p) => p.code === 'enc-key');

/** What the page says when the market cannot restore a key yet. */
export const RESTORE_UNAVAILABLE =
  'This market cannot restore encryption keys yet. Nothing was signed on chain; your account keeps the key it has.';

/**
 * "Restore my encryption key" (R2-3): the account's on-chain encryption key is no longer the one this
 * browser holds (for example, a page passed a real key change off as something else, audit
 * F-A2-3), while this wallet is still its one device. The wallet signs the arm's `rotate_enc_key`
 * BACK to this browser's own key (the F3 v2 text: "Rotate encryption key / New key <16 hex>"), the
 * relay lands it (`restore-enc-key`, lane P10.R), and it is done only when the CHAIN shows this
 * browser's key again. Like any signed call it also moves the nonce: every open offer ends.
 */
export async function restoreEncryptionKey(env: OperationEnv, account: string): Promise<{ txId: string }> {
  const secret = readSecret(env.store, env.scope, account);
  if (!secret)
    throw new OperationError('This browser does not hold the account secret. Import your export to use it here.');
  const kept = refusalAtOpen(env, account);
  if (kept) throw new AccountCheckError(kept);
  // The key put back is THIS browser's, whose secret it holds: never a key it could not open notes with.
  if (encPublicKeyOf(secret.encSecretKey) !== secret.encPublicKey)
    throw new OperationError(
      "This browser's key for the account is damaged: import your export first. Nothing was signed.",
    );
  const hint = BigInt(readRoster(env.store, env.scope, account)?.useCounter ?? '0');
  const { state, check } = await env.chain.checkAccount(account, {
    deviceKey: env.signing.deviceKey,
    encPublicKey: secret.encPublicKey,
    counterHint: hint,
    deployTx: deployTxOf(env, account),
  });
  if (!state) throw new OperationError('Midnight has no account at this address (the indexer does not show it).');
  if (check.ok)
    throw new OperationError("Your account already uses this browser's encryption key. Nothing to restore.");
  // Restorable means the ONLY problem is the current key: the account's origin passed, so the state
  // its deploy created carries THIS browser's key (AA 00047 P11, R3-1). The key sent below is
  // therefore exactly the account's opening key, the only one the relay lands (P11.R, questions Q50).
  // An origin not known yet is not restorable either: nothing is signed until it is.
  if (!restorableCheck(check)) throw new AccountCheckError(check);
  const view = state.view;
  if (!view.booted) throw new OperationError('The account is not active.');
  const counter = env.signing.useCounter(view, hint);
  if (counter === null) throw new OperationError('This wallet is not a device of this account.');
  // The call binds the account's CURRENT (on-chain) key in its context, and this browser's as the
  // new one: the wallet's text then reads "Rotate encryption key / New key <this browser's>".
  const ctx: GatedContext = {
    account,
    authNonce: BigInt(view.authNonce),
    networkSalt: view.networkSalt,
    encKey: view.encKey,
  };
  const payload: RestoreEncKeyPayload = { newKey: secret.encPublicKey, authNonce: view.authNonce };
  const passportAuth = await env.signing.authorise(
    ctx,
    { kind: 'gated', request: restoreEncKeyRequest(payload), purpose: 'restore-enc-key' },
    counter,
  );
  let done: JobView;
  try {
    done = await submitGated(env, account, 'restore-enc-key', payload, passportAuth, counter, {});
  } catch (e) {
    if (unavailable(e)) throw new OperationError(RESTORE_UNAVAILABLE);
    throw e;
  }
  const txId = String((done.result as Partial<RestoreEncKeyResult> | undefined)?.txId ?? '');
  // The relay's "succeeded" is not the proof: the chain's key is (Q26).
  const deadline = Date.now() + NEW_ACCOUNT_WAIT_MS;
  for (;;) {
    const now = await env.chain.accountState(account);
    if (now && now.encKey.toLowerCase() === secret.encPublicKey.toLowerCase()) return { txId };
    if (Date.now() >= deadline)
      throw new OperationError(
        'The market reported your key restored, but Midnight does not show it yet. Refresh in a minute; until the chain shows it, nothing is signed for this account.',
      );
    await sleep(NEW_ACCOUNT_POLL_MS);
  }
}

/** A relay that does not run an action (yet): its codes. */
function unavailable(e: unknown): boolean {
  const code = e instanceof JobFailedError ? e.code : (e as { code?: unknown }).code;
  const detail = (e as { detail?: unknown }).detail;
  return code === 'not-implemented' || code === 'not-found' || detail === 'not-supported';
}
