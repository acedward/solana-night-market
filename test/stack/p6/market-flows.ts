// P6 (AA 00047): the whole market for TWO accounts, driven through the relay over HTTP exactly as
// the browser drives it, with throwaway Ed25519 keys signing in Phantom's scheme (tweetnacl,
// RFC 8032, the raw bytes Phantom's `signMessage(m, 'utf8')` signs):
//
//   open-a / open-b     the Solana envelope (Track A's possession message) → register → the relay
//                       deploys both waves (authority retired) and activates the key
//   demo-a / demo-b     the Solana envelope → demo-tokens (the relay's DEMO_TOKENS_PATH)
//   make                A offers GIVE of one token for WANT of another (one F3 signature); the
//                       relay proves it fully guaranteed and posts it; the exchange's book lists it
//   take                B takes exactly that offer (one F3 signature); the relay proves the
//                       complement, merges, and the exchange's batcher settles it; both accounts'
//                       balances are reconciled from the chain and must move by exactly the legs
//   withdraw            A withdraws the coin it received to a Midnight shielded key (one F3
//                       signature); the coin is checked to arrive (the recipient's keys open it)
//   negatives           refusals by the live relay: another key, another account, another network,
//                       S+L, a flipped signature bit, R = identity, identity/small-order owner keys,
//                       and replays (no transaction is ever sent for these)
//
// State that must survive between runs (the two device seeds, the accounts' inbox keys, the
// withdrawal recipient's seed) lives in $STATE_DIR/state.json (mode 600, never printed). Public
// results (addresses, transaction and offer ids, timings, the texts the wallet shows) are merged
// into $OUT/market-flows.json.
//
//   RELAY_URL=… NETWORK=stagenet STATE_DIR=… OUT=… STEPS=open-a,demo-a bun test/stack/p6/market-flows.ts

import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  API_PATHS,
  KernelClient,
  PROFILES,
  buildRelayActionMessage,
  bytesToHex,
  hexToBytes,
  reconcileCoins,
  registryFor,
  type AccountStateView,
  type InboxPage,
  type JobView,
  type NetworkName,
  type RelayActionName,
  type ZswapActivity,
} from '@nightmarket/core';
import {
  callContext,
  ed25519DeviceOf,
  findUseCounter,
  freshWantNonce,
  generateEncKeyPairPortable,
  offerInboxEntriesPortable,
  openEntryPortable,
  openSwapArgs,
  passportAuthOf,
  predictChangeCoin,
  withdrawRequest,
} from '@nightmarket/core/passport';
import { solanaEnvelopeMessage, solanaEnvelopeText } from '@nightmarket/core/solana-auth';
import nacl from 'tweetnacl';

const RELAY = process.env.RELAY_URL ?? 'http://relay:8080';
const NETWORK = (process.env.NETWORK ?? 'undeployed') as NetworkName;
const PROFILE = PROFILES[NETWORK];
const STATE_DIR = process.env.STATE_DIR ?? '/state';
const OUT = process.env.OUT ?? '/out';
const OUT_NAME = process.env.OUT_NAME ?? 'market-flows.json';
const KERNEL_URL = process.env.KERNEL_URL ?? PROFILE.zswap.kernelUrl;
const INDEXER_URL = process.env.INDEXER_URL ?? PROFILE.midnight.indexerUrl;
const STEPS = (process.env.STEPS ?? 'open-a,open-b,demo-a,demo-b,make,take,withdraw,negatives')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const GIVE_SYMBOL = process.env.GIVE_SYMBOL ?? 'twBTC';
const WANT_SYMBOL = process.env.WANT_SYMBOL ?? 'twUSDC';
/** Base units: 0.01 twBTC for 10 twUSDC by default (1,000 twUSDC per twBTC). */
const GIVE_AMOUNT = BigInt(process.env.GIVE_AMOUNT ?? '1000000');
const WANT_AMOUNT = BigInt(process.env.WANT_AMOUNT ?? '10000000');

const tokens = registryFor(
  NETWORK,
  process.env.TOKENS_FILE ? JSON.parse(readFileSync(process.env.TOKENS_FILE, 'utf8')) : undefined,
);
const display = { network: NETWORK, tokens };
const giveToken = tokens.bySymbol(GIVE_SYMBOL);
const wantToken = tokens.bySymbol(WANT_SYMBOL);
if (!giveToken || !wantToken) throw new Error(`unknown token ${GIVE_SYMBOL} or ${WANT_SYMBOL} on ${NETWORK}`);
const sym = (colour: string) => tokens.byColour(colour)?.symbol ?? colour.slice(0, 8);

// ── state (secret) and results (public) ─────────────────────────────────────
interface Party {
  seed: string;
  encSecret: string;
  encPublic: string;
  account?: string;
}
interface State {
  network: string;
  A: Party;
  B: Party;
  recipientSeed: string;
  offer?: {
    offerId: string;
    giveColor: string;
    giveAmount: string;
    wantColor: string;
    wantAmount: string;
    makerCoin: string;
  };
  wantCoinOfA?: { nonce: string; color: string; value: string };
}
const statePath = join(STATE_DIR, 'state.json');
function newParty(): Party {
  const enc = generateEncKeyPairPortable();
  return {
    seed: bytesToHex(new Uint8Array(randomBytes(32))),
    encSecret: bytesToHex(enc.secretKey),
    encPublic: bytesToHex(enc.publicKey),
  };
}
function loadState(): State {
  if (existsSync(statePath)) {
    const s = JSON.parse(readFileSync(statePath, 'utf8')) as State;
    if (s.network !== NETWORK) throw new Error(`the state in ${STATE_DIR} is for ${s.network}, not ${NETWORK}`);
    return s;
  }
  return { network: NETWORK, A: newParty(), B: newParty(), recipientSeed: bytesToHex(new Uint8Array(randomBytes(32))) };
}
const state = loadState();
function saveState() {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  chmodSync(statePath, 0o600);
}
saveState();

const outPath = join(OUT, OUT_NAME);
const record: Record<string, unknown> = existsSync(outPath)
  ? (JSON.parse(readFileSync(outPath, 'utf8')) as Record<string, unknown>)
  : { network: NETWORK, relay: RELAY, kernel: KERNEL_URL, runs: [] };
const run = { startedAt: new Date().toISOString(), steps: STEPS } as Record<string, unknown>;
(record.runs as unknown[]).push(run);
const save = () => {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(record, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2)}\n`);
};
const put = (key: string, value: unknown) => {
  record[key] = value;
  save();
};
const step = (s: string) => process.stdout.write(`\n== ${new Date().toISOString()} ${s}\n`);
const say = (s: string) => process.stdout.write(`   ${s}\n`);
const indent = (t: string) => t.split('\n').join('\n      ');

// ── the wallets (throwaway keys; Phantom's scheme) ──────────────────────────
function wallet(p: Party) {
  const kp = nacl.sign.keyPair.fromSeed(hexToBytes(p.seed, 32));
  const signer = {
    deviceKey: bytesToHex(kp.publicKey),
    address: '',
    signMessage: async (m: Uint8Array) => nacl.sign.detached(m, kp.secretKey),
  };
  return { signer, device: ed25519DeviceOf(signer, display), secretKey: kp.secretKey };
}
const W = { A: wallet(state.A), B: wallet(state.B) };
record.devices = { A: W.A.device.address, B: W.B.device.address };

// ── HTTP ─────────────────────────────────────────────────────────────────────
type Answer = { job?: JobView; error?: { code: string; message: string; detail?: string } };
async function http<T>(path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const res = await fetch(`${RELAY}${path}`, init);
  return { status: res.status, body: (await res.json().catch(() => ({}))) as T };
}
const post = (action: RelayActionName, body: unknown) =>
  http<Answer>(API_PATHS.action(action), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

interface Timed {
  job: JobView;
  seconds: number;
  txs: string[];
  stages: { stage: string; detail?: unknown }[];
}
async function waitJob(job: JobView, label: string): Promise<Timed> {
  const t0 = Date.now();
  let seen = 0;
  for (;;) {
    const { body } = await http<{ job: JobView }>(API_PATHS.job(job.requestId));
    const j = body.job;
    for (const s of j.stages.slice(seen)) say(`[${label}] ${s.stage}${s.detail ? ` ${JSON.stringify(s.detail)}` : ''}`);
    seen = j.stages.length;
    if (j.state === 'succeeded' || j.state === 'failed') {
      const seconds = (Date.now() - t0) / 1000;
      say(`[${label}] ${j.state} in ${seconds.toFixed(1)} s`);
      const stages = j.stages.map((s) => ({ stage: s.stage, ...(s.detail ? { detail: s.detail } : {}) }));
      const txs = stages
        .map((s) => (s.detail as { tx?: unknown } | undefined)?.tx)
        .filter((t): t is string => typeof t === 'string');
      return { job: j, seconds, txs, stages };
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
}

async function envelope(who: 'A' | 'B', action: RelayActionName, account: string | undefined, payload: object) {
  const { body } = await http<{ nonce: string }>(API_PATHS.nonce);
  const message = buildRelayActionMessage({
    action,
    network: NETWORK,
    owner: W[who].signer.deviceKey,
    ...(account ? { account } : {}),
    payload: payload as Record<string, unknown>,
    nonce: body.nonce,
    expiry: Math.floor(Date.now() / 1000) + 300,
  });
  const signature = bytesToHex(await W[who].signer.signMessage(solanaEnvelopeMessage(message)));
  return { message, signature, text: solanaEnvelopeText(message) };
}

// ── chain reads (through the relay, as the browser does) ────────────────────
async function readState(account: string) {
  const s = (await http<AccountStateView>(API_PATHS.accountState(account))).body;
  const inbox = (await http<InboxPage>(`${API_PATHS.accountInbox(account)}?from=0&limit=500`)).body;
  const zswap = (await http<ZswapActivity>(API_PATHS.accountZswap(account))).body;
  return { s, inbox, zswap };
}
type Coins = ReturnType<typeof reconcileCoins>;
async function coinsOf(who: 'A' | 'B', previous: Coins = []) {
  const p = state[who];
  const account = p.account!;
  const { s, inbox, zswap } = await readState(account);
  const opened = [];
  for (const [i, e] of inbox.entries.entries()) {
    if (!e) continue;
    const c = await openEntryPortable(hexToBytes(p.encSecret, 32), hexToBytes(e, 192));
    if (c)
      opened.push({
        nonce: bytesToHex(c.nonce),
        color: bytesToHex(c.color),
        value: c.value.toString(10),
        inboxIndex: String(inbox.from + i),
      });
  }
  const coins = reconcileCoins({ account, inbox: opened, outputs: zswap.outputs, inputs: zswap.inputs, previous });
  return { s, coins };
}
/** Coins, waiting until every inbox coin has its Merkle index (and `until` holds). */
async function settledCoins(who: 'A' | 'B', until: (c: Coins) => boolean = () => true, tries = 40) {
  let { s, coins } = await coinsOf(who);
  for (let i = 0; i < tries && (coins.some((c) => c.mtIndex === null) || !until(coins)); i++) {
    await new Promise((r) => setTimeout(r, 3_000));
    ({ s, coins } = await coinsOf(who, coins));
  }
  return { s, coins };
}
function balances(coins: Coins): Record<string, string> {
  const out: Record<string, bigint> = {};
  for (const c of coins) if (!c.spent) out[sym(c.color)] = (out[sym(c.color)] ?? 0n) + BigInt(c.value);
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.toString(10)]));
}
const coinView = (coins: Coins) =>
  coins.map((c) => ({ token: sym(c.color), value: c.value, mtIndex: c.mtIndex, spent: c.spent }));

function useCounter(who: 'A' | 'B', s: AccountStateView): bigint {
  const d = W[who].device;
  const k = findUseCounter(s.devices, (n) =>
    bytesToHex(d.entryAt(hexToBytes(s.account, 32), BigInt(s.deviceEpoch), n)),
  );
  if (k === null) throw new Error(`${who}'s device is not live on its account`);
  return k;
}
const ctxOf = (s: AccountStateView, salt?: string) =>
  callContext({ account: s.account, authNonce: BigInt(s.authNonce), networkSalt: salt ?? s.networkSalt });

async function indexerTx(id: string): Promise<Record<string, unknown> | null> {
  // A relay job reports a transaction identifier (33 bytes, 0x00-prefixed); the batcher reports the
  // transaction hash (32 bytes).
  const by = id.length === 64 ? 'hash' : 'identifier';
  const query = `{ transactions(offset: {${by}: "${id}"}) { hash block { height timestamp } ... on RegularTransaction { identifiers fees { paidFees estimatedFees } transactionResult { status } } } }`;
  for (let i = 0; i < 10; i++) {
    try {
      const res = await fetch(INDEXER_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query }),
      });
      const j = (await res.json()) as { data?: { transactions?: Record<string, unknown>[] } };
      const t = j.data?.transactions?.[0];
      if (t) return t;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 3_000));
  }
  return null;
}
async function landed(ids: string[]) {
  const out = [];
  for (const id of ids) {
    const t = (await indexerTx(id)) as {
      hash?: string;
      block?: { height: number; timestamp: number };
      fees?: { paidFees: string };
      transactionResult?: { status: string };
    } | null;
    out.push({
      id,
      hash: t?.hash ?? null,
      block: t?.block?.height ?? null,
      at: t?.block ? new Date(t.block.timestamp).toISOString() : null,
      status: t?.transactionResult?.status ?? null,
      paidFeesSpecks: t?.fees?.paidFees ?? null,
    });
  }
  return out;
}

// ── steps ────────────────────────────────────────────────────────────────────
async function open(who: 'A' | 'B') {
  step(`open ${who} (one wallet prompt: the possession message)`);
  if (state[who].account) {
    say(`already open: ${state[who].account}`);
    return;
  }
  const reg = { encPublicKey: state[who].encPublic };
  const env = await envelope(who, 'register', undefined, reg);
  say(`the wallet shows:\n      ${indent(env.text)}`);
  const r = await post('register', { payload: reg, auth: { message: env.message, signature: env.signature } });
  if (r.status !== 202 || !r.body.job) throw new Error(`register refused: ${r.status} ${JSON.stringify(r.body)}`);
  const t = await waitJob(r.body.job, `register ${who}`);
  const out: Record<string, unknown> = {
    state: t.job.state,
    seconds: t.seconds,
    stages: t.stages,
    walletText: env.text,
    error: t.job.error,
  };
  put(`open${who}`, out);
  if (t.job.state !== 'succeeded') throw new Error(`register ${who} failed: ${JSON.stringify(t.job.error)}`);
  state[who].account = String((t.job.result as { account: string }).account);
  saveState();
  out.account = state[who].account;
  out.txs = await landed(t.txs);
  put(`open${who}`, out);
  say(`account ${state[who].account}`);
  if (who === 'A') {
    const replay = await post('register', { payload: reg, auth: { message: env.message, signature: env.signature } });
    out.replayedEnvelope = { status: replay.status, code: replay.body.error?.code, detail: replay.body.error?.detail };
    say(`the same registration envelope again → ${replay.status} ${replay.body.error?.detail}`);
    put(`open${who}`, out);
  }
}

async function demo(who: 'A' | 'B') {
  step(`demo tokens for ${who} (one wallet prompt)`);
  const account = state[who].account!;
  const info = (await http(`${API_PATHS.demoTokens}?owner=${W[who].signer.deviceKey}`)).body as { claimed?: boolean };
  say(`GET /v1/demo-tokens → ${JSON.stringify(info)}`);
  const out: Record<string, unknown> = { infoBefore: info };
  if (info.claimed) {
    say('already claimed');
  } else {
    const env = await envelope(who, 'demo-tokens', account, {});
    const r = await post('demo-tokens', {
      account,
      payload: {},
      auth: { message: env.message, signature: env.signature },
    });
    if (r.status !== 202 || !r.body.job) throw new Error(`demo-tokens refused: ${r.status} ${JSON.stringify(r.body)}`);
    const t = await waitJob(r.body.job, `demo-tokens ${who}`);
    Object.assign(out, {
      state: t.job.state,
      seconds: t.seconds,
      stages: t.stages,
      result: t.job.result,
      error: t.job.error,
    });
    put(`demo${who}`, out);
    if (t.job.state !== 'succeeded') throw new Error(`demo-tokens ${who} failed: ${JSON.stringify(t.job.error)}`);
    out.txs = await landed(t.txs);
    put(`demo${who}`, out);
  }
  if (who === 'A') {
    const again = await envelope(who, 'demo-tokens', account, {});
    const r2 = await post('demo-tokens', {
      account,
      payload: {},
      auth: { message: again.message, signature: again.signature },
    });
    out.secondClaim = { status: r2.status, code: r2.body.error?.code };
    say(`a second claim by the same key → ${r2.status} ${r2.body.error?.code}`);
  }
  const { coins } = await settledCoins(who, (c) => c.length >= 2);
  out.coins = coinView(coins);
  out.balances = balances(coins);
  say(`${who} holds ${JSON.stringify(out.balances)}`);
  put(`demo${who}`, out);
}

async function make() {
  step(`make: A gives ${GIVE_AMOUNT} ${GIVE_SYMBOL} base units for ${WANT_AMOUNT} ${WANT_SYMBOL} (one wallet prompt)`);
  const { s, coins } = await settledCoins('A');
  const held = coins.find(
    (c) => !c.spent && c.mtIndex !== null && c.color === giveToken!.midnightColour && BigInt(c.value) >= GIVE_AMOUNT,
  );
  if (!held) throw new Error(`A holds no ${GIVE_SYMBOL} coin of at least ${GIVE_AMOUNT}`);
  const want = { nonce: freshWantNonce(), color: hexToBytes(wantToken!.midnightColour, 32), value: WANT_AMOUNT };
  const heldQ = {
    nonce: hexToBytes(held.nonce, 32),
    color: hexToBytes(held.color, 32),
    value: BigInt(held.value),
    mt_index: BigInt(held.mtIndex!),
  };
  const entries = await offerInboxEntriesPortable(
    hexToBytes(state.A.encPublic, 32),
    want,
    predictChangeCoin(heldQ, GIVE_AMOUNT),
  );
  const payload = {
    giveColor: held.color,
    giveAmount: GIVE_AMOUNT.toString(10),
    wantColor: wantToken!.midnightColour,
    wantAmount: WANT_AMOUNT.toString(10),
    wantNonce: bytesToHex(want.nonce),
    wantEntry: bytesToHex(entries.wantEntry),
    changeEntry: bytesToHex(entries.changeEntry),
    validUntil: '0',
    coin: { nonce: held.nonce, color: held.color, value: held.value, mtIndex: held.mtIndex! },
    authNonce: s.authNonce,
  };
  const { call, coin } = openSwapArgs(payload);
  const auth = await W.A.device.signOffer(ctxOf(s), call, coin, useCounter('A', s));
  say(`the wallet shows:\n      ${indent(auth.text)}`);
  const r = await post('open-swap', { account: s.account, payload, passportAuth: passportAuthOf(auth) });
  if (r.status !== 202 || !r.body.job) throw new Error(`open-swap refused: ${r.status} ${JSON.stringify(r.body)}`);
  const t = await waitJob(r.body.job, 'open-swap A');
  const out: Record<string, unknown> = {
    state: t.job.state,
    seconds: t.seconds,
    stages: t.stages,
    result: t.job.result,
    error: t.job.error,
    walletText: auth.text,
    balancesBefore: balances(coins),
  };
  put('make', out);
  if (t.job.state !== 'succeeded') throw new Error(`open-swap failed: ${JSON.stringify(t.job.error)}`);
  const offerId = String((t.job.result as { offerId: string }).offerId);
  state.offer = {
    offerId,
    giveColor: payload.giveColor,
    giveAmount: payload.giveAmount,
    wantColor: payload.wantColor,
    wantAmount: payload.wantAmount,
    makerCoin: held.nonce,
  };
  saveState();
  out.kernel = await kernelView(offerId, payload.giveColor);
  say(`the exchange: ${json(out.kernel)}`);
  put('make', out);
}

const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString(10) : x));

/** The exchange's own view of an offer: its detail (legs as the kernel decoded them), whether the
 *  public book lists it (paging the offers that give its token), and its status. */
async function kernelView(offerId: string, giveColor: string): Promise<Record<string, unknown>> {
  const kernel = new KernelClient({ baseUrl: KERNEL_URL, retries: 2, timeoutMs: 20_000 });
  const detail = await kernel.offer(offerId).catch((e: unknown) => ({ error: String(e) }));
  let onBook = false;
  let bookError: string | undefined;
  try {
    let cursor: string | null | undefined = undefined;
    for (let page = 0; page < 20 && !onBook; page++) {
      const p = await kernel.offersPage({
        token: giveColor,
        direction: 'GIVING',
        limit: 100,
        ...(cursor ? { afterHash: cursor } : {}),
      });
      onBook = p.offers.some((o) => o.offerId === offerId);
      cursor = p.nextCursor;
      if (!cursor) break;
    }
  } catch (e) {
    bookError = String(e);
  }
  return {
    at: new Date().toISOString(),
    detail:
      detail && 'offerId' in detail
        ? {
            offerId: detail.offerId,
            computed: detail.computed,
            blockHeight: detail.blockHeight,
            ttlSeconds: detail.ttlSeconds,
          }
        : detail,
    onBook,
    ...(bookError ? { bookError } : {}),
    status: await kernel.offerStatus(offerId).catch(() => 'unknown'),
  };
}

async function book() {
  const o = state.offer;
  if (!o) throw new Error('no offer of A recorded (run make first)');
  step(`book: the exchange's view of A's offer ${o.offerId}`);
  const view = await kernelView(o.offerId, o.giveColor);
  say(`the exchange: ${json(view)}`);
  put('book', view);
}

async function take() {
  const o = state.offer;
  if (!o) throw new Error('no offer of A recorded (run make first)');
  step(`take: B takes A's offer ${o.offerId} (one wallet prompt)`);
  const before = { A: await settledCoins('A'), B: await settledCoins('B') };
  const { s, coins } = before.B;
  // B gives what A wants, and wants what A gives.
  const giveColor = o.wantColor;
  const giveAmount = BigInt(o.wantAmount);
  const held = coins.find(
    (c) => !c.spent && c.mtIndex !== null && c.color === giveColor && BigInt(c.value) >= giveAmount,
  );
  if (!held) throw new Error(`B holds no ${sym(giveColor)} coin of at least ${giveAmount}`);
  const want = { nonce: freshWantNonce(), color: hexToBytes(o.giveColor, 32), value: BigInt(o.giveAmount) };
  const heldQ = {
    nonce: hexToBytes(held.nonce, 32),
    color: hexToBytes(held.color, 32),
    value: BigInt(held.value),
    mt_index: BigInt(held.mtIndex!),
  };
  const entries = await offerInboxEntriesPortable(
    hexToBytes(state.B.encPublic, 32),
    want,
    predictChangeCoin(heldQ, giveAmount),
  );
  const payload = {
    giveColor,
    giveAmount: giveAmount.toString(10),
    wantColor: o.giveColor,
    wantAmount: o.giveAmount,
    wantNonce: bytesToHex(want.nonce),
    wantEntry: bytesToHex(entries.wantEntry),
    changeEntry: bytesToHex(entries.changeEntry),
    validUntil: '0',
    coin: { nonce: held.nonce, color: held.color, value: held.value, mtIndex: held.mtIndex! },
    authNonce: s.authNonce,
  };
  const { call, coin } = openSwapArgs(payload);
  const auth = await W.B.device.signOffer(ctxOf(s), call, coin, useCounter('B', s));
  say(`the wallet shows:\n      ${indent(auth.text)}`);
  const body = { account: s.account, payload: { ...payload, offerId: o.offerId }, passportAuth: passportAuthOf(auth) };
  const r = await post('take', body);
  if (r.status !== 202 || !r.body.job) throw new Error(`take refused: ${r.status} ${JSON.stringify(r.body)}`);
  const t = await waitJob(r.body.job, 'take B');
  const out: Record<string, unknown> = {
    state: t.job.state,
    seconds: t.seconds,
    stages: t.stages,
    result: t.job.result,
    error: t.job.error,
    walletText: auth.text,
    balancesBefore: { A: balances(before.A.coins), B: balances(before.B.coins) },
  };
  put('take', out);
  if (t.job.state !== 'succeeded') throw new Error(`take failed: ${JSON.stringify(t.job.error)}`);
  const txHash = String((t.job.result as { txHash: string }).txHash);
  out.tx = await landed([txHash]);
  const kernel = new KernelClient({ baseUrl: KERNEL_URL, retries: 2, timeoutMs: 20_000 });
  out.kernelStatusAfter = await kernel.offerStatus(o.offerId).catch(() => 'unknown');
  put('take', out);

  // The same approval again, after it landed: the account's nonce moved on.
  const late = await post('take', body);
  out.replayAfterLanding = { status: late.status, code: late.body.error?.code, detail: late.body.error?.detail };
  say(`the same take approval again → ${late.status} ${late.body.error?.detail ?? late.body.error?.code}`);

  // Balances must move by exactly the legs.
  const give = BigInt(o.giveAmount);
  const wantAmt = BigInt(o.wantAmount);
  const gS = sym(o.giveColor);
  const wS = sym(o.wantColor);
  const b0 = { A: balances(before.A.coins), B: balances(before.B.coins) };
  const expect = {
    A: { [gS]: BigInt(b0.A[gS] ?? '0') - give, [wS]: BigInt(b0.A[wS] ?? '0') + wantAmt },
    B: { [gS]: BigInt(b0.B[gS] ?? '0') + give, [wS]: BigInt(b0.B[wS] ?? '0') - wantAmt },
  };
  const matches = (c: Coins, e: Record<string, bigint>) =>
    Object.entries(e).every(([k, v]) => BigInt(balances(c)[k] ?? '0') === v);
  const after = {
    A: await settledCoins('A', (c) => matches(c, expect.A), 60),
    B: await settledCoins('B', (c) => matches(c, expect.B), 60),
  };
  out.balancesAfter = { A: balances(after.A.coins), B: balances(after.B.coins) };
  out.expected = {
    A: Object.fromEntries(Object.entries(expect.A).map(([k, v]) => [k, v.toString(10)])),
    B: Object.fromEntries(Object.entries(expect.B).map(([k, v]) => [k, v.toString(10)])),
  };
  out.balancesExact = matches(after.A.coins, expect.A) && matches(after.B.coins, expect.B);
  out.coinsAfter = { A: coinView(after.A.coins), B: coinView(after.B.coins) };
  say(`balances before ${JSON.stringify(out.balancesBefore)}`);
  say(`balances after  ${JSON.stringify(out.balancesAfter)} (exact: ${String(out.balancesExact)})`);
  const got = after.A.coins.find((c) => !c.spent && c.color === o.wantColor && BigInt(c.value) === wantAmt);
  if (got) state.wantCoinOfA = { nonce: got.nonce, color: got.color, value: got.value };
  saveState();
  put('take', out);
  if (!out.balancesExact) throw new Error('the balances did not move by exactly the legs');
}

async function recipientKeys() {
  const ledger = (await import('@midnightntwrk/ledger-v9')) as unknown as {
    ZswapSecretKeys: { fromSeed(s: Uint8Array): { coinPublicKey: unknown; encryptionPublicKey: unknown } };
  };
  const rk = ledger.ZswapSecretKeys.fromSeed(hexToBytes(state.recipientSeed, 32));
  const keyHex = (k: unknown) =>
    (typeof k === 'string' ? k : ((k as { toHexString?(): string }).toHexString?.() ?? String(k))).replace(/^0x/, '');
  return { rk, coinPublicKey: keyHex(rk.coinPublicKey), encryptionPublicKey: keyHex(rk.encryptionPublicKey) };
}

/** Whether the recipient's keys open an output of the transaction with this colour and value. */
async function arrived(txId: string, color: string, value: bigint): Promise<Record<string, unknown>> {
  const query = `{ transactions(offset: {identifier: "${txId}"}) { raw } }`;
  const res = await fetch(INDEXER_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const raw = ((await res.json()) as { data?: { transactions?: { raw: string }[] } }).data?.transactions?.[0]?.raw;
  if (!raw) return { checked: false, reason: 'the indexer has no raw bytes for the transaction' };
  const ledger = (await import('@midnightntwrk/ledger-v9')) as unknown as {
    Transaction: { deserialize(s: string, p: string, b: string, raw: Uint8Array): unknown };
    ZswapLocalState: new () => {
      applyWithChanges(sk: unknown, offer: unknown): { changes: { receivedCoins: unknown[] }[] };
    };
  };
  const tx = ledger.Transaction.deserialize(
    'signature',
    'proof',
    'binding',
    hexToBytes(raw.replace(/^0x/, ''), raw.length / 2),
  ) as {
    guaranteedOffer?: unknown;
    fallibleOffer?: Map<number, unknown>;
  };
  const { rk } = await recipientKeys();
  const offers = [tx.guaranteedOffer, ...(tx.fallibleOffer ? [...tx.fallibleOffer.values()] : [])].filter(Boolean);
  const received: { color: string; value: string }[] = [];
  for (const offer of offers) {
    const r = new ledger.ZswapLocalState().applyWithChanges(rk, offer);
    for (const ch of r.changes)
      // A ledger coin's colour is its raw token `type` (hex).
      for (const c of ch.receivedCoins as {
        type?: string | Uint8Array;
        color?: string | Uint8Array;
        value: bigint;
      }[]) {
        const t = c.type ?? c.color ?? '';
        received.push({ color: typeof t === 'string' ? t.replace(/^0x/, '') : bytesToHex(t), value: String(c.value) });
      }
  }
  return {
    checked: true,
    received: received.map((c) => ({ token: sym(c.color), value: c.value })),
    arrived: received.some((c) => c.color.replace(/^0x/, '') === color && BigInt(c.value) === value),
  };
}

async function withdraw() {
  step('withdraw: A withdraws the coin it received to a Midnight shielded key (one wallet prompt)');
  const o = state.offer;
  const { s, coins } = await settledCoins('A');
  const coin =
    coins.find((c) => !c.spent && c.mtIndex !== null && state.wantCoinOfA && c.nonce === state.wantCoinOfA.nonce) ??
    coins.find((c) => !c.spent && c.mtIndex !== null && o && c.color === o.wantColor) ??
    // No trade recorded (a run without make/take): the smallest spendable coin.
    [...coins]
      .filter((c) => !c.spent && c.mtIndex !== null)
      .sort((x, y) => (BigInt(x.value) < BigInt(y.value) ? -1 : 1))[0];
  if (!coin) throw new Error('A holds no coin to withdraw');
  const r0 = await recipientKeys();
  const payload = {
    recipient: r0.coinPublicKey,
    recipientEncryptionKey: r0.encryptionPublicKey,
    color: coin.color,
    amount: coin.value, // the whole coin: no change
    coin: { nonce: coin.nonce, color: coin.color, value: coin.value, mtIndex: coin.mtIndex! },
    authNonce: s.authNonce,
  };
  const auth = await W.A.device.sign(ctxOf(s), withdrawRequest(payload), useCounter('A', s));
  say(`the wallet shows:\n      ${indent(auth.text)}`);
  const passportAuth = passportAuthOf(auth);
  const r = await post('withdraw', { account: s.account, payload, passportAuth });
  if (r.status !== 202 || !r.body.job) throw new Error(`withdraw refused: ${r.status} ${JSON.stringify(r.body)}`);
  const dup = await post('withdraw', { account: s.account, payload, passportAuth });
  const t = await waitJob(r.body.job, 'withdraw A');
  const out: Record<string, unknown> = {
    state: t.job.state,
    seconds: t.seconds,
    stages: t.stages,
    result: t.job.result,
    error: t.job.error,
    walletText: auth.text,
    token: sym(coin.color),
    amount: coin.value,
    recipientCoinPublicKey: r0.coinPublicKey,
    replayWhileQueued: { status: dup.status, code: dup.body.error?.code, detail: dup.body.error?.detail },
  };
  put('withdraw', out);
  if (t.job.state !== 'succeeded') throw new Error(`withdraw failed: ${JSON.stringify(t.job.error)}`);
  const txId = String((t.job.result as { txId: string }).txId);
  out.txs = await landed([txId]);
  const late = await post('withdraw', { account: s.account, payload, passportAuth });
  out.replayAfterLanding = { status: late.status, code: late.body.error?.code, detail: late.body.error?.detail };
  out.arrival = await arrived(txId, coin.color, BigInt(coin.value)).catch((e: unknown) => ({
    checked: false,
    error: String(e),
  }));
  const after = await settledCoins('A');
  out.balancesAfter = balances(after.coins);
  say(`arrival: ${JSON.stringify(out.arrival)}; A now holds ${JSON.stringify(out.balancesAfter)}`);
  put('withdraw', out);
}

const L = (1n << 252n) + 27742317777372353535851937790883648493n;
function sPlusL(sigHex: string): string {
  const b = hexToBytes(sigHex, 64);
  let s = 0n;
  for (let i = 31; i >= 0; i--) s = (s << 8n) | BigInt(b[32 + i]!);
  let t = s + L;
  const out = new Uint8Array(b);
  for (let i = 0; i < 32; i++) {
    out[32 + i] = Number(t & 0xffn);
    t >>= 8n;
  }
  return bytesToHex(out);
}

// Signatures that a LAX verifier (tweetnacl: cofactorless, no s < L, no key or R checks) accepts,
// so a refusal proves the relay's STRICT checks, not a broken signature.
const le = (b: Uint8Array) => b.reduceRight((acc, x) => (acc << 8n) | BigInt(x), 0n);
const le32 = (n: bigint) => {
  const out = new Uint8Array(32);
  for (let i = 0, t = n; i < 32; i++, t >>= 8n) out[i] = Number(t & 0xffn);
  return out;
};
const sha512 = (...parts: Uint8Array[]) => {
  const h = createHash('sha512');
  for (const p of parts) h.update(p);
  return new Uint8Array(h.digest());
};
const IDENTITY = hexToBytes(`01${'00'.repeat(31)}`, 32);
/** R = identity with the verification equation holding: s = H(R‖A‖m)·a mod L (a from the seed). */
function identityRSignature(seedHex: string, publicKey: Uint8Array, message: Uint8Array): Uint8Array {
  const h = sha512(hexToBytes(seedHex, 32)).slice(0, 32);
  h[0]! &= 248;
  h[31]! &= 127;
  h[31]! |= 64;
  const a = le(h) % L;
  const k = le(sha512(IDENTITY, publicKey, message)) % L;
  return new Uint8Array([...IDENTITY, ...le32((k * a) % L)]);
}
/** For a key of small order `order` (identity: 1): R = r·B, s = r, with r drawn until H(R‖A‖m) ≡ 0
 *  (mod order), so s·B = R + k·A holds. */
async function smallOrderKeySignature(key: Uint8Array, order: bigint, message: Uint8Array): Promise<Uint8Array> {
  const { ed25519 } = await import('@noble/curves/ed25519.js');
  for (;;) {
    const r = (le(new Uint8Array(randomBytes(64))) % (L - 1n)) + 1n;
    const R = ed25519.Point.BASE.multiply(r).toBytes();
    const k = le(sha512(R, key, message)) % L;
    if (k % order === 0n) return new Uint8Array([...R, ...le32(r)]);
  }
}

async function negatives() {
  step('negatives: refusals by the live relay (no transaction is sent)');
  const { s, coins } = await settledCoins('A');
  const coin = coins.find((c) => !c.spent && c.mtIndex !== null);
  if (!coin) throw new Error('A holds no coin for the negative cases');
  const r0 = await recipientKeys();
  const payload = {
    recipient: r0.coinPublicKey,
    recipientEncryptionKey: r0.encryptionPublicKey,
    color: coin.color,
    amount: '1',
    coin: { nonce: coin.nonce, color: coin.color, value: coin.value, mtIndex: coin.mtIndex! },
    authNonce: s.authNonce,
  };
  const req = withdrawRequest(payload);
  const good = passportAuthOf(await W.A.device.sign(ctxOf(s), req, useCounter('A', s)));
  const cases: Record<string, unknown> = {};
  const tryIt = async (name: string, account: string, auth: typeof good, pl: object = payload) => {
    const r = await post('withdraw', { account, payload: pl, passportAuth: auth });
    cases[name] = { status: r.status, code: r.body.error?.code, detail: r.body.error?.detail };
    say(`${name} → ${r.status} ${r.body.error?.code} ${r.body.error?.detail ?? ''}`);
    if (r.status === 202) throw new Error(`NEGATIVE ACCEPTED: ${name}`);
  };
  // Another key signs A's call.
  const other = wallet(newParty());
  await tryIt('another key', s.account, passportAuthOf(await other.device.sign(ctxOf(s), req, 0n)));
  // A's approval sent for B's account.
  if (state.B.account) await tryIt('another account', state.B.account, good);
  // An approval rendered for another network (another sealed network salt).
  const wrongSalt = bytesToHex(new Uint8Array(randomBytes(32)));
  await tryIt(
    'another network (salt)',
    s.account,
    passportAuthOf(await W.A.device.sign(ctxOf(s, wrongSalt), req, useCounter('A', s))),
  );
  // An old nonce: signed over authNonce − 1 (a replayed approval of an earlier call).
  if (BigInt(s.authNonce) > 0n) {
    const oldCtx = callContext({ account: s.account, authNonce: BigInt(s.authNonce) - 1n, networkSalt: s.networkSalt });
    await tryIt(
      'old nonce (replay)',
      s.account,
      passportAuthOf(await W.A.device.sign(oldCtx, req, useCounter('A', s))),
      { ...payload, authNonce: (BigInt(s.authNonce) - 1n).toString(10) },
    );
  }
  // Tampered signature bytes.
  const flipped = hexToBytes(good.signature, 64);
  flipped[40]! ^= 1;
  await tryIt('flipped signature bit', s.account, { ...good, signature: bytesToHex(flipped) });
  // S + L (a malleated signature that a lax verifier accepts).
  await tryIt('S+L', s.account, { ...good, signature: sPlusL(good.signature) });
  // R = identity with the equation holding over the exact message the relay rebuilds.
  let signed: Uint8Array | null = null;
  const capture = ed25519DeviceOf(
    {
      ...W.A.signer,
      signMessage: async (m: Uint8Array) => {
        signed = m;
        return W.A.signer.signMessage(m);
      },
    },
    display,
  );
  await capture.sign(ctxOf(s), req, useCounter('A', s));
  const pk = hexToBytes(W.A.signer.deviceKey, 32);
  const rId = identityRSignature(state.A.seed, pk, signed!);
  cases.identityRLaxVerifies = nacl.sign.detached.verify(signed!, rId, pk);
  await tryIt('R = identity (equation holds)', s.account, { ...good, signature: bytesToHex(rId) });
  cases.sPlusLLaxVerifies = nacl.sign.detached.verify(signed!, hexToBytes(sPlusL(good.signature), 64), pk);
  // Tampered payload after signing (a different amount than the one signed).
  await tryIt('payload changed after signing', s.account, good, { ...payload, amount: '2' });
  // Registration with an identity / small-order owner key.
  for (const [name, key, order] of [
    ['register: identity key', `01${'00'.repeat(31)}`, 1n],
    ['register: small-order key (order 4)', '00'.repeat(32), 4n],
    ['register: small-order key (order 8)', 'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a', 8n],
  ] as const) {
    const { body } = await http<{ nonce: string }>(API_PATHS.nonce);
    const message = buildRelayActionMessage({
      action: 'register',
      network: NETWORK,
      owner: key,
      payload: { encPublicKey: state.A.encPublic },
      nonce: body.nonce,
      expiry: Math.floor(Date.now() / 1000) + 300,
    });
    // The client refuses to even render the message for such a key (that is a refusal too); the
    // relay is then sent a signature over the same text rendering the relay would use.
    let m: Uint8Array;
    let clientRefusal: string | null = null;
    try {
      m = solanaEnvelopeMessage(message);
    } catch (e) {
      clientRefusal = String((e as Error)?.message ?? e).slice(0, 300);
      m = new TextEncoder().encode(solanaEnvelopeText(message));
    }
    const sig = await smallOrderKeySignature(hexToBytes(key, 32), order, m);
    const laxVerifies = nacl.sign.detached.verify(m, sig, hexToBytes(key, 32));
    const r = await post('register', {
      payload: { encPublicKey: state.A.encPublic },
      auth: { message, signature: bytesToHex(sig) },
    }).catch((e: unknown) => ({ status: 0, body: { error: { code: String(e), message: '' } } as Answer }));
    cases[name] = {
      status: r.status,
      code: r.body.error?.code,
      detail: r.body.error?.detail,
      laxVerifies,
      clientRefusal,
    };
    say(`${name} → ${r.status} ${r.body.error?.code}`);
    if (r.status === 202) throw new Error(`NEGATIVE ACCEPTED: ${name}`);
  }
  put('negatives', cases);
}

async function main() {
  const health = (await http('/health')).body;
  run.healthBefore = health;
  save();
  for (const st of STEPS) {
    const t0 = Date.now();
    switch (st) {
      case 'open-a':
        await open('A');
        break;
      case 'open-b':
        await open('B');
        break;
      case 'demo-a':
        await demo('A');
        break;
      case 'demo-b':
        await demo('B');
        break;
      case 'make':
        await make();
        break;
      case 'book':
        await book();
        break;
      case 'take':
        await take();
        break;
      case 'withdraw':
        await withdraw();
        break;
      case 'negatives':
        await negatives();
        break;
      default:
        throw new Error(`unknown step ${st}`);
    }
    run.stepSeconds ??= {} as Record<string, number>;
    (run.stepSeconds as Record<string, number>)[st] = (Date.now() - t0) / 1000;
    save();
  }
  run.healthAfter = (await http('/health')).body;
  run.finishedAt = new Date().toISOString();
  record.accounts = { A: state.A.account ?? null, B: state.B.account ?? null };
  save();
  step('done');
}

main().then(
  () => process.exit(0),
  (e: unknown) => {
    run.error = String((e as Error)?.stack ?? e);
    save();
    process.stderr.write(`FAILED: ${String((e as Error)?.message ?? e)}\n`);
    process.exit(1);
  },
);
