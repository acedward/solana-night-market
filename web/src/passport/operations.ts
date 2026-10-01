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

import {
  RELAY_ACTIONS,
  buildRelayActionMessage,
  bytesToHex,
  checkZswapActivity,
  chooseCoin,
  hexToBytes,
  localCoin,
  parseShieldedAddress,
  reconcileCoins,
  type AccountStateView,
  type AppendInboxPayload,
  type CancelOffersPayload,
  type CancelOffersResult,
  type JobView,
  type PassportAuth,
  type RegisterResult,
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
  sameCoin,
  sealEntryPortable,
  withdrawRequest,
  type AccountCheck,
  type GatedContext,
} from '@nightmarket/core/passport';

import type { AccountChain, AccountOnChain } from '../chain/indexer.js';
import type { RelayClient } from '../relay/client.js';
import { jobErrorText } from '../relay/messages.js';
import { recordKey, type WalletScope } from '../store/schema.js';
import type { LocalStore } from '../store/store.js';
import type { ActionSigning } from '../wallet/signing.js';
import {
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
  const check = await checkNewAccount(env, account, secret.encPublicKey);
  const record: AccountRecord = {
    address: account,
    device: env.signing.deviceKey,
    network: scope.network,
    createdAt: Date.now(),
    txs: r.txs,
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

/** How long the page waits for the public indexer to show a just-opened account, and how often it
 *  asks (the relay reports success once the activation lands; an indexer can lag a few blocks). */
export const NEW_ACCOUNT_WAIT_MS = 90_000;
export const NEW_ACCOUNT_POLL_MS = 3_000;

/** The fresh-account check, waiting for the indexer to show the activated account. */
async function checkNewAccount(env: OperationEnv, account: string, encPublicKey: string): Promise<AccountCheck> {
  const deadline = Date.now() + NEW_ACCOUNT_WAIT_MS;
  for (;;) {
    let found: Awaited<ReturnType<AccountChain['checkAccount']>>;
    try {
      found = await env.chain.checkAccount(account, { deviceKey: env.signing.deviceKey, encPublicKey, fresh: true });
    } catch (e) {
      if (Date.now() >= deadline) throw e;
      await sleep(NEW_ACCOUNT_POLL_MS);
      continue;
    }
    // Not on the indexer yet (no contract, or not activated yet): wait. Anything else is final.
    const waiting = !found.state || !found.state.view.booted;
    if (!waiting || Date.now() >= deadline) return found.check;
    await sleep(NEW_ACCOUNT_POLL_MS);
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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
  const hint = readRoster(env.store, env.scope, account)?.useCounter;
  const { state, check } = await env.chain.checkAccount(account, {
    deviceKey: env.signing.deviceKey,
    encPublicKey: secret.encPublicKey,
    ...(hint !== undefined ? { counterHint: BigInt(hint) } : {}),
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
  const [reported, txs] = await Promise.all([relay.zswap(account), env.chain.accountTransactions(account)]);
  const checked = checkZswapActivity(account, reported, txs);
  const coins = reconcileCoins({
    account,
    inbox,
    outputs: checked.activity.outputs,
    inputs: checked.activity.inputs,
    previous: readCoins(store, scope, account),
  });
  store.put(scope, 'coins', coins, { account });
  return {
    state: onChain.view,
    coins,
    unreadable,
    check: found.check,
    unsupported: checked.unsupported.length,
    unshielded: onChain.unshielded,
  };
}

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
  action: 'withdraw' | 'withdraw-unshielded' | 'append-inbox' | 'cancel-offers',
  payload: WithdrawPayload | WithdrawUnshieldedPayload | AppendInboxPayload | CancelOffersPayload,
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
  // The change follows from what the wallet signed (the coin and the amount): computed here, never
  // taken from the relay (Q28 A). The relay's report must say the same; if not, the browser's coin
  // is kept and the caller says so. The change has no inbox entry yet (Q13); the market's single-use
  // entitlement to file one is kept with it (security review F-B3).
  const expected = predictWithdrawChange(coin, args.amount);
  const reported = result.change ?? null;
  const changeMismatch = expected === null ? reported !== null : !sameCoin(expected, reported);
  const change = expected
    ? {
        ...localCoin(expected, account, 'change', result.txId),
        changeOf: { spent: coin.commitment, amount: args.amount.toString(10) },
        ...(result.changeEntitlement ? { appendEntitlement: result.changeEntitlement } : {}),
      }
    : null;
  // The spent coin is marked now; the next sync confirms it from the ledger's nullifier.
  const next = readCoins(env.store, env.scope, account).map((c) =>
    c.commitment === coin.commitment ? { ...c, spent: true, spentTx: result.txId } : c,
  );
  if (change) next.push(change);
  env.store.put(env.scope, 'coins', next, { account });
  return { txId: result.txId, change, changeMismatch };
}

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
export async function secureChange(env: OperationEnv, account: string, coin: StoredCoin): Promise<{ txId: string }> {
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
    const code = e instanceof JobFailedError ? e.code : (e as { code?: unknown }).code;
    const detail = (e as { detail?: unknown }).detail;
    if (code === 'not-implemented' || code === 'not-found' || detail === 'not-supported')
      throw new OperationError(CANCEL_UNAVAILABLE);
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

/** Coins that exist only in this browser (no inbox entry yet): shown as "not yet secured". */
export const unsecuredCoins = (coins: readonly StoredCoin[]) => coins.filter((c) => !c.spent && !c.inInbox);
