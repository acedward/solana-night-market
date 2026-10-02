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
// AA 00047 P9.I (the security fix pass: F3 v2, C2, C6, Q30) adds:
//   make                signs `validUntil` = now + MAKE_LIFETIME (default one hour); the relay caps the
//                       intent's TTL at it, and the run records the proven offer's TTL against it
//   withdraw-unshielded A withdraws part of its UNSHIELDED balance (fund-unshielded.ts deposits it)
//                       to a fresh user address (one wallet prompt); the transaction's unshielded
//                       output to that address is checked
//   cancel              A makes a second offer, then "Cancel all open offers" (one wallet prompt:
//                       rotate_enc_key with its CURRENT key): the nonce moves, the key does not, and
//                       B's take of the cancelled offer cannot settle
//   expired             A makes an offer that expires in EXPIRE_SECONDS (75 s); after it: the same
//                       make again is refused (approval-expired) and B's take of it cannot settle
//   p9-negatives        refusals by the live relay, no transaction: validUntil 0 (no-expiry), too far
//                       (expiry-too-far), a B′ display mismatch (another site label for the same call),
//                       a C2 colour mismatch (a valid signature over a withdrawal naming twBTC, paid
//                       from a twUSDC coin), and a cancel for a key that is not the account's
// AA 00047 P10.I (the round-2 fix pass: F3 v3's "Site: " line, R2-1 caps and fairness, R2-3 restore)
// adds:
//   (every signed step) the wallet's first line must be exactly "Site: <label>" (questions Q36), and
//                       each account is checked the way the SITE checks it: the site's own chain
//                       reader (web/src/chain/indexer.ts) on the public indexer, with the verifier
//                       keys pinned in the web build (`open-*` with `fresh`: R2-6, empty as deployed)
//   restore             a page rotates A's key away (one real key-change prompt, sent as
//                       `restore-enc-key` to a key this browser does not hold): the site's check then
//                       fails on `enc-key` alone; "Restore my encryption key" (one prompt: "Rotate
//                       encryption key / New key <this browser's>") puts it back and the check passes
//   p10-negatives       Q36 at the live relay, no transaction: a valid signature over a first line whose
//                       label equals an action title, over a leading-space label, over a bare first
//                       line without "Site: ", and "Site: Cancel all open offers" above a real key change
//   fairness            R2-1 on the real relay: A sends a burst of makes, then loops makes and cancels
//                       as fast as the relay answers; B's withdrawals (sent while A's make proves, and
//                       while A's cancel proves) must wait behind at most ONE of A's jobs
//   caps                R2-1's per-account caps on B (the relay restarted with CAPS, e.g. "2,3,2,1" =
//                       open offers, makes/day, cancels/day, restores/day): account-busy, open-offers,
//                       makes-daily, cancels-daily and restores-daily, each 429 exactly past its cap
//   caps-restore        after a relay restart (the counters live in memory): B's key restored
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
  OFFER_LIFETIME_SECONDS,
  PROFILES,
  TAKE_LIFETIME_SECONDS,
  buildRelayActionMessage,
  bytesToHex,
  hexToBytes,
  unshieldedBalancesPath,
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
  cancelOffersRequest,
  decodeEd25519Point,
  ed25519DeviceOf,
  ed25519TokenResolver,
  findUseCounter,
  freshWantNonce,
  generateEncKeyPairPortable,
  offerInboxEntriesPortable,
  openEntryPortable,
  openSwapArgs,
  passportAuthOf,
  marketLabel,
  predictChangeCoin,
  pureCircuits,
  renderEd25519Message,
  restoreEncKeyRequest,
  siteLine,
  isRenderableLabel,
  withdrawRequest,
  withdrawUnshieldedRequest,
} from '@nightmarket/core/passport';
import { solanaEnvelopeMessage, solanaEnvelopeText } from '@nightmarket/core/solana-auth';
import nacl from 'tweetnacl';

// The SITE's own chain reader (AA 00047 P9.S/P10.S): what the page believes about an account.
import { ChainReader } from '../../../web/src/chain/indexer.js';

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
/** The make's signed lifetime (seconds): the relay caps the intent's TTL at it (audit C6). */
const MAKE_LIFETIME = Number(process.env.MAKE_LIFETIME ?? String(OFFER_LIFETIME_SECONDS));
/** The `expired` step's offer lifetime: just above the relay's 60 s minimum. */
const EXPIRE_SECONDS = Number(process.env.EXPIRE_SECONDS ?? '75');
/** The unshielded colour the `withdraw-unshielded` step pays out (NIGHT, the all-zero colour). */
const UNSHIELDED_COLOUR = (process.env.UNSHIELDED_COLOUR ?? '00'.repeat(32)).toLowerCase();
const UNSHIELDED_AMOUNT = BigInt(process.env.UNSHIELDED_AMOUNT ?? '1500000');
/** The `cancel` step's offer lifetime, and whether B then tries to take the cancelled offer (on a
 *  shared network the cancelled offer is not sent to the exchange's batcher: CANCEL_TAKE_CHECK=0). */
const CANCEL_MAKE_LIFETIME = Number(process.env.CANCEL_MAKE_LIFETIME ?? String(OFFER_LIFETIME_SECONDS));
const CANCEL_TAKE_CHECK = process.env.CANCEL_TAKE_CHECK !== '0';

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
    validUntil?: string;
  };
  /** P9.I: the offers the cancel and the expiry steps make (public values only). */
  cancelledOffer?: OfferRec;
  expiredOffer?: OfferRec;
  wantCoinOfA?: { nonce: string; color: string; value: string };
  /** P9.I: the coin c2-live.ts pays a C2-mismatched withdrawal from (A's, unspent at the time). */
  c2Coin?: { nonce: string; color: string; value: string; mtIndex: string };
}
interface OfferRec {
  offerId: string;
  giveColor: string;
  giveAmount: string;
  wantColor: string;
  wantAmount: string;
  makerCoin: string;
  validUntil?: string;
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

/** F3 v3 (P10.C, questions Q36): every account message's first line is exactly "Site: <label>". */
const SITE_LINE = siteLine(NETWORK);
function siteLineOf(text: string): string {
  const first = text.split('\n')[0]!.trimEnd();
  if (first !== SITE_LINE)
    throw new Error(`the wallet's first line is ${JSON.stringify(first)}, not ${JSON.stringify(SITE_LINE)}`);
  return first;
}

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
/** The SITE's check of an account (web/src/chain/indexer.ts `checkAccount`, with the web build's pinned
 *  verifier keys): read straight from the public indexer, never through the relay. With `until`, it is
 *  read again (every 3 s, up to `tries`) until `until` holds, as the page waits for the chain. */
const siteChain = new ChainReader({ indexerUrl: INDEXER_URL, networkId: PROFILE.midnightNetworkId });
async function siteCheck(
  who: 'A' | 'B',
  opts: { fresh?: boolean; until?: (c: { ok: boolean; codes: string[] }) => boolean; tries?: number } = {},
) {
  const read = async () => {
    const { state: st, check } = await siteChain.checkAccount(state[who].account!, {
      deviceKey: W[who].signer.deviceKey,
      encPublicKey: state[who].encPublic,
      ...(opts.fresh ? { fresh: true } : {}),
    });
    return {
      ok: check.ok,
      codes: check.problems.map((p) => p.code),
      problems: check.problems.map((p) => ({
        code: p.code,
        message: p.message,
        ...(p.detail ? { detail: p.detail } : {}),
      })),
      useCounter: check.useCounter?.toString(10) ?? null,
      onChain: st
        ? { encKey: st.view.encKey, authNonce: st.view.authNonce, blockHeight: st.blockHeight, inbox: st.inbox.length }
        : null,
    };
  };
  let c = await read();
  for (let i = 0; opts.until && !opts.until(c) && i < (opts.tries ?? 30); i++) {
    await new Promise((r) => setTimeout(r, 3_000));
    c = await read();
  }
  return c;
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
  callContext({
    account: s.account,
    authNonce: BigInt(s.authNonce),
    networkSalt: salt ?? s.networkSalt,
    encKey: s.encKey,
  });

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
  // AA 00047 P10.I: the site's opening check on the chain (P9.S, R2-6 / Q42): the web build's pinned
  // verifier keys, the authority retired, one device and it is this wallet's (first entry), this
  // browser's encryption key, this network's salt, nothing signed yet, and EMPTY as deployed.
  out.siteCheck = await siteCheck(who, { fresh: true, until: (c) => c.ok });
  put(`open${who}`, out);
  say(`the site's opening check: ${json(out.siteCheck)}`);
  if (!(out.siteCheck as { ok: boolean }).ok) throw new Error(`the site refuses the new account ${who}`);
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
    // The claim names the device's live use counter (AA 00047 P9, audit C8 / F-B10).
    const counter = { useCounter: useCounter(who, (await readState(account)).s).toString(10) };
    const env = await envelope(who, 'demo-tokens', account, counter);
    const r = await post('demo-tokens', {
      account,
      payload: counter,
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
    const counter = { useCounter: useCounter(who, (await readState(account)).s).toString(10) };
    const again = await envelope(who, 'demo-tokens', account, counter);
    const r2 = await post('demo-tokens', {
      account,
      payload: counter,
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

/** `who` (A by default) signs one make: GIVE_AMOUNT of its GIVE token for WANT_AMOUNT of WANT, valid
 *  `lifetime` seconds (or exactly `validUntil`), paid from one coin (one wallet prompt). Nothing is sent. */
async function signMake(lifetime: number, validUntil?: string, who: 'A' | 'B' = 'A') {
  const { s, coins } = await settledCoins(who);
  const held = coins.find(
    (c) => !c.spent && c.mtIndex !== null && c.color === giveToken!.midnightColour && BigInt(c.value) >= GIVE_AMOUNT,
  );
  if (!held) throw new Error(`${who} holds no ${GIVE_SYMBOL} coin of at least ${GIVE_AMOUNT}`);
  const want = { nonce: freshWantNonce(), color: hexToBytes(wantToken!.midnightColour, 32), value: WANT_AMOUNT };
  const heldQ = {
    nonce: hexToBytes(held.nonce, 32),
    color: hexToBytes(held.color, 32),
    value: BigInt(held.value),
    mt_index: BigInt(held.mtIndex!),
  };
  const entries = await offerInboxEntriesPortable(
    hexToBytes(state[who].encPublic, 32),
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
    // A real signed expiry (AA 00047 P9, audit C6).
    validUntil: validUntil ?? String(Math.floor(Date.now() / 1000) + lifetime),
    coin: { nonce: held.nonce, color: held.color, value: held.value, mtIndex: held.mtIndex! },
    authNonce: s.authNonce,
  };
  const { call, coin } = openSwapArgs(payload);
  const auth = await W[who].device.signOffer(ctxOf(s), call, coin, useCounter(who, s));
  return { who, s, coins, held, payload, auth };
}

/** Post a signed make and wait for it; returns the job and the listed offer. */
async function postMake(label: string, m: Awaited<ReturnType<typeof signMake>>) {
  say(`the wallet shows:\n      ${indent(m.auth.text)}`);
  siteLineOf(m.auth.text);
  const body = { account: m.s.account, payload: m.payload, passportAuth: passportAuthOf(m.auth) };
  const r = await post('open-swap', body);
  if (r.status !== 202 || !r.body.job) throw new Error(`open-swap refused: ${r.status} ${JSON.stringify(r.body)}`);
  const t = await waitJob(r.body.job, label);
  if (t.job.state !== 'succeeded') return { t, body, offer: null };
  const offer: OfferRec = {
    offerId: String((t.job.result as { offerId: string }).offerId),
    giveColor: m.payload.giveColor,
    giveAmount: m.payload.giveAmount,
    wantColor: m.payload.wantColor,
    wantAmount: m.payload.wantAmount,
    makerCoin: m.held.nonce,
    validUntil: m.payload.validUntil,
  };
  return { t, body, offer };
}

/** The proven offer's intent TTL as the exchange serves it, against its signed `validUntil` (the
 *  relay caps every intent's TTL at it: audit C6, P9.R; P9.I checks it on the stack). */
async function offerTtl(offerId: string, validUntil: string): Promise<Record<string, unknown>> {
  try {
    const { fetchOfferBytes } = await import('../../../relay/src/trade/publish.js');
    const { intentTtl } = await import('../../../relay/src/trade/account-offer.js');
    const got = await fetchOfferBytes(offerId, { kernelUrl: KERNEL_URL });
    if (!got) return { checked: false, reason: 'the exchange has no such offer' };
    const ledger = (await import('@midnightntwrk/ledger-v9')) as unknown as {
      Transaction: { deserialize(s: string, p: string, b: string, raw: Uint8Array): unknown };
    };
    const tx = ledger.Transaction.deserialize('signature', 'proof', 'binding', got.bytes);
    const ttl = intentTtl(tx);
    const until = Number(validUntil) * 1000;
    return {
      checked: true,
      validUntilUtc: new Date(until).toISOString(),
      intentTtlUtc: ttl === null ? null : new Date(ttl).toISOString(),
      // midnight-js gives a call's intent one hour from when it is built; the relay caps it.
      cappedAtValidUntil: ttl !== null && ttl <= until,
      ttlEqualsValidUntil: ttl === until,
      status: got.status ?? null,
    };
  } catch (e) {
    return { checked: false, error: String(e).slice(0, 400) };
  }
}

async function make() {
  step(
    `make: A gives ${GIVE_AMOUNT} ${GIVE_SYMBOL} base units for ${WANT_AMOUNT} ${WANT_SYMBOL}, valid ${MAKE_LIFETIME} s (one wallet prompt)`,
  );
  const m = await signMake(MAKE_LIFETIME);
  const { t, offer } = await postMake('open-swap A', m);
  const out: Record<string, unknown> = {
    state: t.job.state,
    seconds: t.seconds,
    stages: t.stages,
    result: t.job.result,
    error: t.job.error,
    walletText: m.auth.text,
    siteLine: siteLineOf(m.auth.text),
    validUntil: m.payload.validUntil,
    lifetimeSeconds: MAKE_LIFETIME,
    balancesBefore: balances(m.coins),
  };
  put('make', out);
  if (!offer) throw new Error(`open-swap failed: ${JSON.stringify(t.job.error)}`);
  state.offer = offer;
  saveState();
  out.kernel = await kernelView(offer.offerId, offer.giveColor);
  out.ttl = await offerTtl(offer.offerId, m.payload.validUntil);
  say(`the exchange: ${json(out.kernel)}`);
  say(`the offer's intent TTL: ${json(out.ttl)}`);
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

/** B signs a take of exactly offer `o` (B gives what A wants, wants what A gives; one prompt). */
async function signTake(o: OfferRec) {
  const before = { A: await settledCoins('A'), B: await settledCoins('B') };
  const { s, coins } = before.B;
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
    // A real signed expiry (AA 00047 P9, audit C6): a take lives minutes.
    validUntil: String(Math.floor(Date.now() / 1000) + TAKE_LIFETIME_SECONDS),
    coin: { nonce: held.nonce, color: held.color, value: held.value, mtIndex: held.mtIndex! },
    authNonce: s.authNonce,
  };
  const { call, coin } = openSwapArgs(payload);
  const auth = await W.B.device.signOffer(ctxOf(s), call, coin, useCounter('B', s));
  const body = { account: s.account, payload: { ...payload, offerId: o.offerId }, passportAuth: passportAuthOf(auth) };
  return { before, auth, body };
}

/** A take that must NOT settle (the offer was cancelled or has expired): B signs it, the relay may
 *  admit and prove it, but nothing lands and nobody's coins move. */
async function takeMustFail(o: OfferRec, label: string): Promise<Record<string, unknown>> {
  const { before, auth, body } = await signTake(o);
  const r = await post('take', body);
  const out: Record<string, unknown> = {
    walletText: auth.text,
    admission: { status: r.status, code: r.body.error?.code },
  };
  if (r.status === 202 && r.body.job) {
    const t = await waitJob(r.body.job, label);
    Object.assign(out, { state: t.job.state, seconds: t.seconds, stages: t.stages, error: t.job.error });
    if (t.job.state === 'succeeded') throw new Error(`${label}: the take SETTLED (${JSON.stringify(t.job.result)})`);
  }
  // Nothing moved: A's offered coin is unspent, and both balances are as before.
  const after = { A: await settledCoins('A'), B: await settledCoins('B') };
  out.makerCoinUnspent = after.A.coins.some((c) => c.nonce === o.makerCoin && !c.spent);
  out.balancesUnchanged =
    json(balances(after.A.coins)) === json(balances(before.A.coins)) &&
    json(balances(after.B.coins)) === json(balances(before.B.coins));
  out.nonces = { A: after.A.s.authNonce, B: after.B.s.authNonce };
  if (!out.makerCoinUnspent || !out.balancesUnchanged) throw new Error(`${label}: coins moved: ${json(out)}`);
  return out;
}

async function take() {
  const o = state.offer;
  if (!o) throw new Error('no offer of A recorded (run make first)');
  step(`take: B takes A's offer ${o.offerId} (one wallet prompt)`);
  const { before, auth, body } = await signTake(o);
  say(`the wallet shows:\n      ${indent(auth.text)}`);
  siteLineOf(auth.text);
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
  siteLineOf(auth.text);
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
    const oldCtx = callContext({
      account: s.account,
      authNonce: BigInt(s.authNonce) - 1n,
      networkSalt: s.networkSalt,
      encKey: s.encKey,
    });
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

// ── AA 00047 P9.I: the fix pass on the stack ─────────────────────────────────

/** The account's unshielded balance of `colour` as the relay's chain read reports it (base units). */
async function unshieldedOf(account: string, colour: string): Promise<bigint> {
  const r = await http<{ balances?: { colour: string; amount: string }[] }>(unshieldedBalancesPath(account));
  return BigInt(r.body.balances?.find((b) => b.colour === colour)?.amount ?? '0');
}

/** The unshielded outputs of a transaction (owner, token type, value), from its raw bytes. */
async function unshieldedOutputs(txId: string): Promise<Record<string, unknown>> {
  const query = `{ transactions(offset: {identifier: "${txId}"}) { raw } }`;
  for (let i = 0; i < 10; i++) {
    try {
      const res = await fetch(INDEXER_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query }),
      });
      const raw = ((await res.json()) as { data?: { transactions?: { raw: string }[] } }).data?.transactions?.[0]?.raw;
      if (raw) {
        const ledger = (await import('@midnightntwrk/ledger-v9')) as unknown as {
          Transaction: { deserialize(s: string, p: string, b: string, raw: Uint8Array): unknown };
        };
        const tx = ledger.Transaction.deserialize(
          'signature',
          'proof',
          'binding',
          hexToBytes(raw.replace(/^0x/, ''), raw.length / 2),
        ) as {
          intents?: Map<
            number,
            {
              guaranteedUnshieldedOffer?: { outputs: { owner: unknown; type: unknown; value: bigint }[] };
              fallibleUnshieldedOffer?: { outputs: { owner: unknown; type: unknown; value: bigint }[] };
            }
          >;
        };
        const h = (v: unknown) =>
          (typeof v === 'string' ? v : v instanceof Uint8Array ? bytesToHex(v) : String(v)).replace(/^0x/, '');
        const outputs = [];
        for (const intent of tx.intents?.values() ?? [])
          for (const o of [
            ...(intent.guaranteedUnshieldedOffer?.outputs ?? []),
            ...(intent.fallibleUnshieldedOffer?.outputs ?? []),
          ])
            outputs.push({ owner: h(o.owner), type: h(o.type), value: String(o.value) });
        return { checked: true, outputs };
      }
    } catch (e) {
      if (i === 9) return { checked: false, error: String(e).slice(0, 300) };
    }
    await new Promise((r) => setTimeout(r, 3_000));
  }
  return { checked: false, reason: 'the indexer has no raw bytes for the transaction' };
}

async function withdrawUnshielded() {
  step(
    `withdraw-unshielded: A pays ${UNSHIELDED_AMOUNT} of its unshielded ${UNSHIELDED_COLOUR.slice(0, 8)}… to a fresh address`,
  );
  const { s } = await coinsOf('A');
  const before = await unshieldedOf(s.account, UNSHIELDED_COLOUR);
  if (before < UNSHIELDED_AMOUNT) throw new Error(`A holds ${before} unshielded (fund-unshielded.ts first)`);
  const recipient = bytesToHex(new Uint8Array(randomBytes(32)));
  const payload = {
    recipient,
    color: UNSHIELDED_COLOUR,
    amount: UNSHIELDED_AMOUNT.toString(10),
    authNonce: s.authNonce,
  };
  const auth = await W.A.device.sign(ctxOf(s), withdrawUnshieldedRequest(payload), useCounter('A', s));
  say(`the wallet shows:\n      ${indent(auth.text)}`);
  siteLineOf(auth.text);
  const passportAuth = passportAuthOf(auth);
  const r = await post('withdraw-unshielded', { account: s.account, payload, passportAuth });
  if (r.status !== 202 || !r.body.job)
    throw new Error(`withdraw-unshielded refused: ${r.status} ${JSON.stringify(r.body)}`);
  const t = await waitJob(r.body.job, 'withdraw-unshielded A');
  const out: Record<string, unknown> = {
    state: t.job.state,
    seconds: t.seconds,
    stages: t.stages,
    result: t.job.result,
    error: t.job.error,
    walletText: auth.text,
    colour: UNSHIELDED_COLOUR,
    amount: UNSHIELDED_AMOUNT.toString(10),
    recipient,
    accountUnshieldedBefore: before.toString(10),
  };
  put('withdrawUnshielded', out);
  if (t.job.state !== 'succeeded') throw new Error(`withdraw-unshielded failed: ${JSON.stringify(t.job.error)}`);
  const txId = String((t.job.result as { txId: string }).txId);
  out.txs = await landed([txId]);
  out.outputs = await unshieldedOutputs(txId);
  const outs = (out.outputs as { outputs?: { owner: string; type: string; value: string }[] }).outputs ?? [];
  out.arrived = outs.some(
    (o) => o.owner === recipient && o.type === UNSHIELDED_COLOUR && BigInt(o.value) === UNSHIELDED_AMOUNT,
  );
  let after = before;
  for (let i = 0; i < 20 && after === before; i++) {
    await new Promise((res) => setTimeout(res, 3_000));
    after = await unshieldedOf(s.account, UNSHIELDED_COLOUR);
  }
  out.accountUnshieldedAfter = after.toString(10);
  out.accountPaidExactly = before - after === UNSHIELDED_AMOUNT;
  const late = await post('withdraw-unshielded', { account: s.account, payload, passportAuth });
  out.replayAfterLanding = { status: late.status, code: late.body.error?.code, detail: late.body.error?.detail };
  say(
    `arrived ${String(out.arrived)}; the account paid exactly ${String(out.accountPaidExactly)} (${before} → ${after})`,
  );
  put('withdrawUnshielded', out);
  if (!out.accountPaidExactly) throw new Error('the account did not pay exactly the amount');
}

/** "Cancel all open offers" for `who` (one prompt); returns the job and the account before/after. */
async function cancelAll(who: 'A' | 'B') {
  const { s } = await coinsOf(who);
  const payload = { newKey: s.encKey, authNonce: s.authNonce };
  const auth = await W[who].device.sign(ctxOf(s), cancelOffersRequest(payload), useCounter(who, s));
  say(`the wallet shows:\n      ${indent(auth.text)}`);
  siteLineOf(auth.text);
  const passportAuth = passportAuthOf(auth);
  const r = await post('cancel-offers', { account: s.account, payload, passportAuth });
  if (r.status !== 202 || !r.body.job) throw new Error(`cancel-offers refused: ${r.status} ${JSON.stringify(r.body)}`);
  const t = await waitJob(r.body.job, `cancel-offers ${who}`);
  if (t.job.state !== 'succeeded') throw new Error(`cancel-offers failed: ${JSON.stringify(t.job.error)}`);
  const txId = String((t.job.result as { txId: string }).txId);
  let s2 = (await readState(s.account)).s;
  for (let i = 0; i < 20 && BigInt(s2.authNonce) === BigInt(s.authNonce); i++) {
    await new Promise((res) => setTimeout(res, 3_000));
    s2 = (await readState(s.account)).s;
  }
  const late = await post('cancel-offers', { account: s.account, payload, passportAuth });
  return {
    state: t.job.state,
    seconds: t.seconds,
    stages: t.stages,
    walletText: auth.text,
    txs: await landed([txId]),
    authNonce: { before: s.authNonce, after: s2.authNonce },
    encKeyUnchanged: s2.encKey === s.encKey,
    replayAfterLanding: { status: late.status, code: late.body.error?.code, detail: late.body.error?.detail },
  };
}

async function cancel() {
  step('cancel: A makes a second offer, then cancels all its open offers (one prompt); B cannot take it');
  const m = await signMake(CANCEL_MAKE_LIFETIME);
  const { t, offer } = await postMake('open-swap A (to cancel)', m);
  if (!offer) throw new Error(`the second make failed: ${JSON.stringify(t.job.error)}`);
  state.cancelledOffer = offer;
  saveState();
  const out: Record<string, unknown> = {
    offer,
    make: { state: t.job.state, seconds: t.seconds, walletText: m.auth.text },
    kernelBefore: await kernelView(offer.offerId, offer.giveColor),
  };
  put('cancel', out);
  out.cancel = await cancelAll('A');
  const c = out.cancel as {
    walletText: string;
    authNonce: { before: string; after: string };
    encKeyUnchanged: boolean;
  };
  const lines = c.walletText.split('\n');
  out.walletSaysCancel = lines[1] === 'Cancel all open offers' && lines[2] === 'Your key does not change';
  put('cancel', out);
  if (!out.walletSaysCancel) throw new Error('the cancel did not read "Cancel all open offers"');
  if (BigInt(c.authNonce.after) !== BigInt(c.authNonce.before) + 1n || !c.encKeyUnchanged)
    throw new Error(`the cancel did not move the nonce by one with the key kept: ${json(c)}`);
  say(`cancelled: A's nonce ${c.authNonce.before} → ${c.authNonce.after}, key unchanged`);
  out.kernelAfter = await kernelView(offer.offerId, offer.giveColor);
  put('cancel', out);
  // The cancelled offer may still be on the book, but its approval is dead: B's take cannot settle.
  if (CANCEL_TAKE_CHECK) {
    out.takeOfCancelled = await takeMustFail(offer, 'take B (cancelled offer)');
    say(`B's take of the cancelled offer: ${json(out.takeOfCancelled)}`);
    put('cancel', out);
  }
}

async function expired() {
  step(`expired: A makes an offer valid ${EXPIRE_SECONDS} s; after it, the same make and B's take are refused`);
  const m = await signMake(EXPIRE_SECONDS);
  const { t, body, offer } = await postMake('open-swap A (short)', m);
  if (!offer) throw new Error(`the short make failed: ${JSON.stringify(t.job.error)}`);
  state.expiredOffer = offer;
  saveState();
  const out: Record<string, unknown> = {
    offer,
    make: { state: t.job.state, seconds: t.seconds, walletText: m.auth.text },
    ttl: await offerTtl(offer.offerId, m.payload.validUntil),
  };
  put('expired', out);
  const wait = Number(m.payload.validUntil) * 1000 - Date.now() + 12_000;
  say(
    `waiting ${Math.round(wait / 1000)} s for the signed expiry (${new Date(Number(m.payload.validUntil) * 1000).toISOString()})`,
  );
  if (wait > 0) await new Promise((res) => setTimeout(res, wait));
  const again = await post('open-swap', body);
  out.makeReplayed = { status: again.status, code: again.body.error?.code, detail: again.body.error?.detail };
  say(`the same make after its expiry → ${again.status} ${again.body.error?.code}`);
  if (again.status === 202) throw new Error('an expired make was admitted again');
  out.takeOfExpired = await takeMustFail(offer, 'take B (expired offer)');
  say(`B's take of the expired offer: ${json(out.takeOfExpired)}`);
  put('expired', out);
}

async function p9Negatives() {
  step('p9-negatives: refusals by the live relay (no transaction): expiry, B′ label, C2 colour, cancel key');
  const cases: Record<string, unknown> = {};
  const outcome = (name: string, r: { status: number; body: Answer }) => {
    cases[name] = {
      status: r.status,
      code: r.body.error?.code,
      detail: r.body.error?.detail,
      message: r.body.error?.message,
    };
    say(`${name} → ${r.status} ${r.body.error?.code} ${r.body.error?.detail ?? ''}`);
    if (r.status === 202) throw new Error(`NEGATIVE ACCEPTED: ${name}`);
  };
  // C6: an offer signed with no expiry, and one too far ahead (the signatures are valid).
  const now = Math.floor(Date.now() / 1000);
  for (const [name, until] of [
    ['make: validUntil 0 ("Expires never")', '0'],
    ['make: validUntil too far (now + 2 h)', String(now + 7200)],
    // A fresh signature over an expiry already past (a replayed old approval is stopped earlier, by the
    // replay guard, as `replayed`): the admission's own expiry rule.
    ['make: validUntil already past (now − 30 s)', String(now - 30)],
    ['make: validUntil too soon (now + 30 s, under the 60 s minimum)', String(now + 30)],
  ] as const) {
    const m = await signMake(0, until);
    outcome(
      name,
      await post('open-swap', { account: m.s.account, payload: m.payload, passportAuth: passportAuthOf(m.auth) }),
    );
  }
  // B′: the same withdrawal signed under another site label (the page says twUSDC has 2 decimals).
  const { s, coins } = await settledCoins('A');
  const usdc = coins.find((c) => !c.spent && c.mtIndex !== null && c.color === wantToken!.midnightColour);
  const btcColour = giveToken!.midnightColour;
  if (!usdc) throw new Error('A holds no spendable twUSDC coin for the negatives');
  const r0 = await recipientKeys();
  const wd = {
    recipient: r0.coinPublicKey,
    recipientEncryptionKey: r0.encryptionPublicKey,
    color: usdc.color,
    amount: '1000000',
    coin: { nonce: usdc.nonce, color: usdc.color, value: usdc.value, mtIndex: usdc.mtIndex! },
    authNonce: s.authNonce,
  };
  const lying = {
    ...tokens,
    byColour: (c: string) => {
      const t = tokens.byColour(c);
      return t && c === usdc.color ? { ...t, decimals: 2 } : t;
    },
  } as typeof tokens;
  const liar = ed25519DeviceOf(W.A.signer, { network: NETWORK, tokens: lying });
  const lied = await liar.sign(ctxOf(s), withdrawRequest(wd), useCounter('A', s));
  cases.bPrimeWalletText = lied.text;
  outcome(
    'B′: another site label for the same withdrawal',
    await post('withdraw', {
      account: s.account,
      payload: wd,
      passportAuth: passportAuthOf(lied),
    }),
  );
  // C2: a withdrawal NAMING twBTC paid from the twUSDC coin. The honest client refuses to sign it;
  // a signature made anyway over the text the arm renders for it is refused by the relay.
  const c2 = { ...wd, color: btcColour, amount: '1000' };
  try {
    await W.A.device.sign(ctxOf(s), withdrawRequest(c2), useCounter('A', s));
    cases.c2ClientRefusal = null;
  } catch (e) {
    cases.c2ClientRefusal = String((e as Error).message).slice(0, 200);
  }
  if (!cases.c2ClientRefusal) throw new Error('the client signed a C2-mismatched withdrawal');
  const crafted = c2Signature('A', s, c2);
  cases.c2WalletText = crafted.text;
  outcome(
    'C2: a withdrawal naming twBTC paid from a twUSDC coin',
    await post('withdraw', {
      account: s.account,
      payload: c2,
      passportAuth: crafted.passportAuth,
    }),
  );
  // Keep the coin for c2-live.ts (the circuit's refusal, with the relay stopped).
  state.c2Coin = { nonce: usdc.nonce, color: usdc.color, value: usdc.value, mtIndex: usdc.mtIndex! };
  saveState();
  // Q30: a "cancel" naming another key is a key change, which the market never asks for.
  const other = bytesToHex(new Uint8Array(randomBytes(32)));
  const otherCancel = { newKey: other, authNonce: s.authNonce };
  const rotated = await W.A.device.sign(ctxOf(s), cancelOffersRequest(otherCancel), useCounter('A', s));
  cases.otherKeyWalletTitle = rotated.text.split('\n')[1];
  outcome(
    'cancel: a key that is not the account’s',
    await post('cancel-offers', {
      account: s.account,
      payload: otherCancel,
      passportAuth: passportAuthOf(rotated),
    }),
  );
  put('p9Negatives', cases);
}

/** A signature over the F3 text the arm renders for a C2-mismatched withdrawal (declared colour ≠
 *  the coin's), made WITHOUT the client's refusal: the challenge from the contract's own pure
 *  circuit, the message from the TypeScript renderer, signed with the wallet's key. */
function c2Signature(who: 'A' | 'B', s: AccountStateView, p: Parameters<typeof withdrawRequest>[0]) {
  const ctx = ctxOf(s);
  const req = withdrawRequest(p) as Extract<ReturnType<typeof withdrawRequest>, { op: 'withdrawShielded' }>;
  const pk = decodeEd25519Point(hexToBytes(W[who].signer.deviceKey, 32));
  const counter = useCounter(who, s);
  const challenge = (pureCircuits as unknown as Record<string, (...a: unknown[]) => Uint8Array>)
    .challenge_withdraw_shielded_with_ed25519!(
    { bytes: ctx.contractAddress },
    pk,
    ctx.evmDomainSalt,
    { bytes: req.recipient },
    req.color,
    req.amount,
    req.coin,
    ctx.authNonce,
  );
  const m = renderEd25519Message(
    {
      contractAddress: ctx.contractAddress,
      authNonce: ctx.authNonce,
      challenge,
      label: marketLabel(NETWORK),
      tokens: ed25519TokenResolver(tokens),
    },
    { op: 'withdrawShielded', recipient: req.recipient, color: req.color, amount: req.amount },
  );
  const sig = nacl.sign.detached(m.bytes, W[who].secretKey);
  return {
    text: m.text,
    passportAuth: { owner: W[who].signer.deviceKey, signature: bytesToHex(sig), useCounter: counter.toString(10) },
  };
}

// ── AA 00047 P10.I: the round-2 fix pass on the stack ────────────────────────

type Reply = { status: number; code?: string; detail?: string; message?: string };
const reply = (r: { status: number; body: Answer }): Reply => ({
  status: r.status,
  ...(r.body.error?.code ? { code: r.body.error.code } : {}),
  ...(r.body.error?.detail ? { detail: r.body.error.detail } : {}),
  ...(r.body.error?.message ? { message: r.body.error.message } : {}),
});
const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** `restore-enc-key` for `who` to `newKey` (one prompt), from the CHAIN's view of the account (the site
 *  signs from the indexer, never the relay); waits until the chain shows the key. */
async function restoreTo(who: 'A' | 'B', newKey: string, label: string) {
  const account = state[who].account!;
  const view = (await siteChain.accountState(account))!;
  const payload = { newKey, authNonce: view.authNonce };
  const auth = await W[who].device.sign(ctxOf(view), restoreEncKeyRequest(payload), useCounter(who, view));
  say(`the wallet shows:\n      ${indent(auth.text)}`);
  const lines = auth.text.split('\n');
  const passportAuth = passportAuthOf(auth);
  const r = await post('restore-enc-key', { account, payload, passportAuth });
  const out: Record<string, unknown> = {
    label,
    walletText: auth.text,
    siteLine: siteLineOf(auth.text),
    walletSaysRotate:
      lines[1]!.trimEnd() === 'Rotate encryption key' && lines[2]!.startsWith(`New key ${newKey.slice(0, 16)}`),
    admission: reply(r),
    encKeyBefore: view.encKey,
  };
  if (r.status !== 202 || !r.body.job) return out;
  const t = await waitJob(r.body.job, `restore-enc-key ${who} (${label})`);
  Object.assign(out, { state: t.job.state, seconds: t.seconds, stages: t.stages, error: t.job.error });
  if (t.job.state !== 'succeeded') return out;
  out.txs = await landed([String((t.job.result as { txId: string }).txId)]);
  let now = await siteChain.accountState(account);
  for (let i = 0; i < 30 && now?.encKey !== newKey; i++) {
    await sleepMs(3_000);
    now = await siteChain.accountState(account);
  }
  out.encKeyAfter = now?.encKey ?? null;
  out.chainShowsNewKey = now?.encKey === newKey;
  out.authNonce = { before: view.authNonce, after: now?.authNonce ?? null };
  const late = await post('restore-enc-key', { account, payload, passportAuth });
  out.replayAfterLanding = reply(late);
  return out;
}

async function restoreStep() {
  step('restore (R2-3): a page rotates A’s key away; the site refuses on enc-key alone; "Restore my encryption key"');
  const out: Record<string, unknown> = { checkBefore: await siteCheck('A') };
  put('restore', out);
  if (!(out.checkBefore as { ok: boolean }).ok) throw new Error('the site does not accept A before the restore step');
  const before = balances((await settledCoins('A')).coins);
  // 1. The attack: a page gets the wallet to sign a REAL key change to a key this browser does not hold.
  //    The relay cannot tell (it refuses only the on-chain key itself); the circuit renders the truth:
  //    "Rotate encryption key / New key <other>".
  const away = bytesToHex(generateEncKeyPairPortable().publicKey);
  out.away = await restoreTo('A', away, 'a page rotates the key away');
  put('restore', out);
  const a = out.away as { chainShowsNewKey?: boolean; walletSaysRotate: boolean };
  if (!a.chainShowsNewKey || !a.walletSaysRotate) throw new Error(`the key change did not land: ${json(a)}`);
  // 2. The site refuses the account now, on the encryption key ALONE (`restorableCheck`).
  out.checkAfterAttack = await siteCheck('A');
  const c1 = out.checkAfterAttack as { ok: boolean; codes: string[] };
  out.restorable = !c1.ok && c1.codes.length === 1 && c1.codes[0] === 'enc-key';
  put('restore', out);
  if (!out.restorable) throw new Error(`the site's check is not "enc-key alone": ${json(c1)}`);
  // 3. "Restore my encryption key": this browser's key back (one prompt).
  out.restore = await restoreTo('A', state.A.encPublic, 'restore my encryption key');
  put('restore', out);
  const r = out.restore as { chainShowsNewKey?: boolean; walletSaysRotate: boolean };
  if (!r.chainShowsNewKey || !r.walletSaysRotate) throw new Error(`the restore did not land: ${json(r)}`);
  out.checkAfterRestore = await siteCheck('A', { until: (c) => c.ok });
  if (!(out.checkAfterRestore as { ok: boolean }).ok) throw new Error('the site still refuses A after the restore');
  // 4. A restore to the key already on chain is a cancel in disguise: refused (it must not escape the
  //    cancels' daily cap), before any proof.
  const view = (await siteChain.accountState(state.A.account!))!;
  const same = { newKey: view.encKey, authNonce: view.authNonce };
  const sameAuth = await W.A.device.sign(ctxOf(view), restoreEncKeyRequest(same), useCounter('A', view));
  out.restoreToTheSameKey = reply(
    await post('restore-enc-key', { account: view.account, payload: same, passportAuth: passportAuthOf(sameAuth) }),
  );
  if ((out.restoreToTheSameKey as Reply).status === 202) throw new Error('a restore to the on-chain key was admitted');
  // 5. Nothing lost: the coins sealed to this browser's key still open, the balances are unchanged.
  out.balancesBefore = before;
  out.balancesAfter = balances((await settledCoins('A')).coins);
  out.balancesUnchanged = json(out.balancesAfter) === json(before);
  say(`restore: ${json({ restorable: out.restorable, after: out.checkAfterRestore, same: out.restoreToTheSameKey })}`);
  put('restore', out);
  if (!out.balancesUnchanged) throw new Error('the balances changed across the key restore');
}

/** A valid signature by `who` over `bytes` (the wallet signs whatever it is shown). */
function signBytes(who: 'A' | 'B', bytes: Uint8Array, counter: bigint) {
  const kp = nacl.sign.keyPair.fromSeed(hexToBytes(state[who].seed, 32));
  return {
    owner: W[who].signer.deviceKey,
    signature: bytesToHex(nacl.sign.detached(bytes, kp.secretKey)),
    useCounter: counter.toString(10),
  };
}
const ascii = (t: string) => Uint8Array.from([...t].map((c) => c.charCodeAt(0)));

async function p10Negatives() {
  step('p10-negatives (Q36): first lines the circuit never renders for this market, at the live relay');
  const cases: Record<string, unknown> = {};
  const refused = (name: string, r: Reply, extra: Record<string, unknown> = {}) => {
    cases[name] = { ...r, ...extra };
    say(`${name} → ${r.status} ${r.code ?? ''} ${r.detail ?? ''}`);
    if (r.status === 202) throw new Error(`NEGATIVE ACCEPTED: ${name}`);
  };
  const { s, coins } = await settledCoins('A');
  const usdc = coins.find((c) => !c.spent && c.mtIndex !== null && c.color === wantToken!.midnightColour);
  if (!usdc) throw new Error('A holds no spendable twUSDC coin for the negatives');
  const r0 = await recipientKeys();
  const wd = {
    recipient: r0.coinPublicKey,
    recipientEncryptionKey: r0.encryptionPublicKey,
    color: usdc.color,
    amount: '1000000',
    coin: { nonce: usdc.nonce, color: usdc.color, value: usdc.value, mtIndex: usdc.mtIndex! },
    authNonce: s.authNonce,
  };
  const counter = useCounter('A', s);
  const honest = await W.A.device.sign(ctxOf(s), withdrawRequest(wd), counter);
  cases.honestFirstLine = siteLineOf(honest.text);
  const rest = honest.text.split('\n').slice(1).join('\n');
  const label = marketLabel(NETWORK);
  const variants: [string, string, string][] = [
    // A label that reads as an enforced line: the client renders it (it is a valid label), the circuit
    // would show "Site: Withdraw shielded"; the market's relay and page use only their own label.
    [
      'label = an action title ("Site: Withdraw shielded")',
      'Withdraw shielded',
      `Site: ${'Withdraw shielded'.padEnd(24)}\n${rest}`,
    ],
    // A label pushed off the marker: the client and the circuit refuse to render it at all.
    ['leading-space label ("Site:  Night Market …")', ` ${label}`, `Site: ${` ${label}`.padEnd(24)}\n${rest}`],
    // F3 v2's layout: the label as a bare first line, no "Site: " (6 bytes shorter).
    ['bare first line (no "Site: ")', label, `${label.padEnd(24)}\n${rest}`],
  ];
  for (const [name, lbl, text] of variants) {
    const auth = signBytes('A', ascii(text), counter);
    refused(name, reply(await post('withdraw', { account: s.account, payload: wd, passportAuth: auth })), {
      firstLine: text.split('\n')[0],
      clientRendersTheLabel: isRenderableLabel(lbl),
    });
  }
  // The attack Q36 closes: "Cancel all open offers" as the LABEL above a real key change.
  const other = bytesToHex(generateEncKeyPairPortable().publicKey);
  const rot = { newKey: other, authNonce: s.authNonce };
  const honestRot = await W.A.device.sign(ctxOf(s), restoreEncKeyRequest(rot), counter);
  const restRot = honestRot.text.split('\n').slice(1).join('\n');
  const fake = `Site: ${'Cancel all open offers'.padEnd(24)}\n${restRot}`;
  refused(
    'a real key change under the label "Cancel all open offers"',
    reply(
      await post('restore-enc-key', {
        account: s.account,
        payload: rot,
        passportAuth: signBytes('A', ascii(fake), counter),
      }),
    ),
    { walletWouldShow: fake.split('\n').slice(0, 3) },
  );
  // Nothing moved: the nonce and the key are as before.
  const after = (await siteChain.accountState(s.account))!;
  cases.unchanged = { authNonce: after.authNonce === s.authNonce, encKey: after.encKey === s.encKey };
  put('p10Negatives', cases);
  if (after.authNonce !== s.authNonce || after.encKey !== s.encKey)
    throw new Error('a Q36 negative changed the account');
}

/** The prover hold of a finished job, in the relay's own stage times (Unix seconds): a prover-lane job
 *  holds it from `running` to its end; an account-lane job (a make) from `proving` to `proven`. */
function proverHold(v: JobView): { start: number; end: number } | null {
  const at = (name: string) => v.stages.find((x) => x.stage === name)?.at;
  if (v.lane === 'prover') {
    const start = at('running');
    const end = v.stages.find((x) => x.stage === 'succeeded' || x.stage === 'failed')?.at;
    return start !== undefined && end !== undefined ? { start, end } : null;
  }
  const start = at('proving');
  if (start === undefined) return null;
  const end = at('proven') ?? v.stages.find((x) => x.stage === 'failed' || x.stage === 'succeeded')?.at ?? v.updatedAt;
  return { start, end };
}
const jobView = async (id: string) => (await http<{ job: JobView }>(API_PATHS.job(id))).body.job;

async function fairness() {
  step('fairness (R2-1): A bursts makes, then loops makes and cancels; B withdraws twice meanwhile');
  const out: Record<string, unknown> = {};
  put('fairness', out);
  const jobsA: { id: string; action: string; postedAt: string }[] = [];
  const triesA: Record<string, number> = {};
  let current: { id: string; action: string } | null = null;
  const count = (r: Reply) => {
    const k = `${r.status}${r.code ? ` ${r.code}` : ''}`;
    triesA[k] = (triesA[k] ?? 0) + 1;
  };
  // A's next request, signed against the account's state at the time (a cancel re-affirms its key).
  const buildA = async (kind: 'make' | 'cancel') => {
    if (kind === 'make') {
      const m = await signMake(900);
      return {
        action: 'open-swap' as const,
        body: { account: m.s.account, payload: m.payload, passportAuth: passportAuthOf(m.auth) },
      };
    }
    const { s } = await coinsOf('A');
    const payload = { newKey: s.encKey, authNonce: s.authNonce };
    const auth = await W.A.device.sign(ctxOf(s), cancelOffersRequest(payload), useCounter('A', s));
    return {
      action: 'cancel-offers' as const,
      body: { account: s.account, payload, passportAuth: passportAuthOf(auth) },
    };
  };
  // 1. The auditor's burst: six makes back to back.
  const burst = [];
  for (let i = 0; i < 6; i++) burst.push(await buildA('make'));
  const burstReplies: Reply[] = [];
  for (const b of burst) {
    const r = await post(b.action, b.body);
    burstReplies.push(reply(r));
    count(reply(r));
    if (r.status === 202 && r.body.job) {
      current = { id: r.body.job.requestId, action: b.action };
      jobsA.push({ ...current, postedAt: new Date().toISOString() });
    }
  }
  out.burst = burstReplies;
  say(`A's burst of 6 makes → ${burstReplies.map((r) => `${r.status}${r.code ? ` ${r.code}` : ''}`).join(', ')}`);
  // 2. The loop: as fast as the relay answers (once a second), make and cancel in turn.
  let stop = false;
  let kind: 'make' | 'cancel' = 'cancel';
  let pending: Awaited<ReturnType<typeof buildA>> | null = null;
  const loop = (async () => {
    while (!stop) {
      try {
        pending ??= await buildA(kind);
        const r = await post(pending.action, pending.body);
        count(reply(r));
        if (r.status === 202 && r.body.job) {
          current = { id: r.body.job.requestId, action: pending.action };
          jobsA.push({ ...current, postedAt: new Date().toISOString() });
          kind = kind === 'make' ? 'cancel' : 'make';
          pending = null;
        } else if (r.status !== 429) {
          pending = null; // stale (the nonce moved): sign again
        }
      } catch (e) {
        const k = `error ${String((e as Error).message).slice(0, 60)}`;
        triesA[k] = (triesA[k] ?? 0) + 1;
        pending = null;
      }
      await sleepMs(1_000);
    }
  })();
  // B's withdrawal of its smallest spendable coin (whole: no change), sent when `when` holds for A's
  // current job.
  const customer = async (label: string, when: (v: JobView) => boolean) => {
    for (let i = 0; i < 600; i++) {
      if (current) {
        const v = await jobView(current.id);
        if (v && when(v)) break;
      }
      await sleepMs(500);
    }
    const { s, coins } = await settledCoins('B');
    // B's largest coin of the GIVE token is kept for the caps phase's makes.
    const spendable = coins.filter((c) => !c.spent && c.mtIndex !== null);
    const reserve = spendable
      .filter((c) => c.color === giveToken!.midnightColour && BigInt(c.value) >= GIVE_AMOUNT)
      .sort((x, y) => (BigInt(x.value) > BigInt(y.value) ? -1 : 1))[0];
    const coin = spendable
      .filter((c) => c.nonce !== reserve?.nonce)
      .sort((x, y) => (BigInt(x.value) < BigInt(y.value) ? -1 : 1))[0];
    if (!coin) throw new Error('B holds no coin to withdraw');
    const rk = await recipientKeys();
    const payload = {
      recipient: rk.coinPublicKey,
      recipientEncryptionKey: rk.encryptionPublicKey,
      color: coin.color,
      amount: coin.value,
      coin: { nonce: coin.nonce, color: coin.color, value: coin.value, mtIndex: coin.mtIndex! },
      authNonce: s.authNonce,
    };
    const auth = await W.B.device.sign(ctxOf(s), withdrawRequest(payload), useCounter('B', s));
    siteLineOf(auth.text);
    const aheadAt = current ? { ...current, view: await jobView(current.id) } : null;
    const r = await post('withdraw', { account: s.account, payload, passportAuth: passportAuthOf(auth) });
    if (r.status !== 202 || !r.body.job) throw new Error(`B's withdrawal refused: ${json(reply(r))}`);
    const t = await waitJob(r.body.job, `withdraw B (${label})`);
    return {
      label,
      requestId: r.body.job.requestId,
      token: sym(coin.color),
      amount: coin.value,
      aJobWhenSent: aheadAt ? { id: aheadAt.id, action: aheadAt.action, stage: aheadAt.view?.stage } : null,
      state: t.job.state,
      seconds: t.seconds,
      txs: t.job.state === 'succeeded' ? await landed([String((t.job.result as { txId: string }).txId)]) : [],
    };
  };
  const rounds = [];
  rounds.push(await customer('while A’s make proves', (v) => v.action === 'open-swap' && v.stage === 'proving'));
  rounds.push(await customer('while A’s cancel proves', (v) => v.action === 'cancel-offers' && v.state === 'running'));
  stop = true;
  await loop;
  // Let A's last job end, so the next phase starts from an idle relay.
  if (current) await waitJob((await jobView(current.id))!, `A's last job (${current.action})`);
  // 3. The measure, in the relay's own stage times: for each B withdrawal, A's jobs that held the
  //    prover while it waited (held when it arrived, or started before it).
  const viewsA = await Promise.all(jobsA.map(async (j) => ({ ...j, view: await jobView(j.id) })));
  const holdsA = viewsA.map((j) => ({
    id: j.id,
    action: j.action,
    state: j.view?.state,
    hold: j.view ? proverHold(j.view) : null,
  }));
  const measured = [];
  for (const rd of rounds) {
    const v = (await jobView(rd.requestId))!;
    const arrived = v.createdAt;
    const started = v.stages.find((x) => x.stage === 'running')?.at ?? null;
    const held = holdsA.filter((h) => h.hold && started !== null && h.hold.start <= arrived && h.hold.end > arrived);
    const after = holdsA.filter((h) => h.hold && started !== null && h.hold.start > arrived && h.hold.start < started);
    measured.push({
      ...rd,
      arrivedAt: arrived,
      startedAt: started,
      waitedSeconds: started === null ? null : started - arrived,
      heldAtArrival: held.map((h) => `${h.action} ${h.id.slice(0, 8)}`),
      startedAfterArrival: after.map((h) => `${h.action} ${h.id.slice(0, 8)}`),
      aJobsAhead: held.length + after.length,
      pass: started !== null && held.length + after.length <= 1,
    });
  }
  Object.assign(out, { attempts: triesA, jobsA: holdsA, rounds: measured });
  out.pass = measured.every((m) => m.pass && m.state === 'succeeded');
  say(
    `fairness: ${json(measured.map((m) => ({ label: m.label, aJobsAhead: m.aJobsAhead, waited: m.waitedSeconds })))}`,
  );
  say(`A's attempts: ${json(triesA)}`);
  put('fairness', out);
  if (!out.pass) throw new Error(`fairness FAILED: ${json(measured)}`);
}

/** The caps the relay runs with in the `caps` phase: CAPS="open,makes,cancels,restores". */
const CAPS = (process.env.CAPS ?? '2,3,2,1').split(',').map((x) => Number(x));

async function caps() {
  const [open, makes, cancels, restores] = CAPS as [number, number, number, number];
  step(`caps (R2-1) on B: open offers ${open}, makes/day ${makes}, cancels/day ${cancels}, restores/day ${restores}`);
  if (open !== 2 || makes !== 3 || cancels !== 2 || restores !== 1)
    throw new Error('the caps step is written for CAPS=2,3,2,1');
  const out: Record<string, unknown> = { caps: { open, makes, cancels, restores } };
  const seq: Record<string, unknown>[] = [];
  const record = (what: string, r: Reply, extra: Record<string, unknown> = {}) => {
    seq.push({ what, ...r, ...extra });
    say(`${what} → ${r.status} ${r.code ?? ''}`);
    out.sequence = seq;
    put('caps', out);
  };
  const expect = (what: string, r: Reply, status: number, code?: string) => {
    if (r.status !== status || (code !== undefined && r.code !== code))
      throw new Error(`${what}: expected ${status}${code ? ` ${code}` : ''}, got ${json(r)}`);
  };
  const makeB = async () => {
    const m = await signMake(900, undefined, 'B');
    siteLineOf(m.auth.text);
    return { account: m.s.account, payload: m.payload, passportAuth: passportAuthOf(m.auth) };
  };
  const finish = async (r: { status: number; body: Answer }, label: string) => {
    if (r.status !== 202 || !r.body.job) return null;
    const t = await waitJob(r.body.job, label);
    if (t.job.state !== 'succeeded') throw new Error(`${label} failed: ${json(t.job.error)}`);
    return t;
  };
  const cancelB = async () => {
    const { s } = await coinsOf('B');
    const payload = { newKey: s.encKey, authNonce: s.authNonce };
    const auth = await W.B.device.sign(ctxOf(s), cancelOffersRequest(payload), useCounter('B', s));
    return { account: s.account, payload, passportAuth: passportAuthOf(auth) };
  };
  const nonceMoves = async (before: string) => {
    for (let i = 0; i < 30; i++) {
      const v = (await coinsOf('B')).s;
      if (v.authNonce !== before) return;
      await sleepMs(3_000);
    }
    throw new Error('B’s nonce did not move');
  };
  // 1. One job per account: a second make while the first runs → account-busy.
  const m1 = await post('open-swap', await makeB());
  record('make 1', reply(m1));
  expect('make 1', reply(m1), 202);
  const m2body = await makeB();
  const busy = await post('open-swap', m2body);
  record('make 2 while make 1 runs', reply(busy));
  expect('make 2 while make 1 runs', reply(busy), 429, 'account-busy');
  await finish(m1, 'make 1 B');
  const m2 = await post('open-swap', m2body);
  record('make 2 (after make 1)', reply(m2));
  expect('make 2', reply(m2), 202);
  await finish(m2, 'make 2 B');
  // 2. Open offers: two live → a third is refused.
  const m3 = await post('open-swap', await makeB());
  record('make 3 with 2 offers live', reply(m3));
  expect('make 3', reply(m3), 429, 'open-offers-cap');
  // 3. A cancel ends them (the nonce moves): a make is admitted again, the third of the day.
  const n0 = (await coinsOf('B')).s.authNonce;
  const c1 = await post('cancel-offers', await cancelB());
  record('cancel 1', reply(c1));
  expect('cancel 1', reply(c1), 202);
  await finish(c1, 'cancel 1 B');
  await nonceMoves(n0);
  const m3b = await post('open-swap', await makeB());
  record('make 3 after the cancel', reply(m3b));
  expect('make 3 after the cancel', reply(m3b), 202);
  await finish(m3b, 'make 3 B');
  // 4. Makes a day: the fourth is refused (one offer live: under the open-offer cap).
  const m4 = await post('open-swap', await makeB());
  record('make 4 (3 made today)', reply(m4));
  expect('make 4', reply(m4), 429, 'makes-daily-cap');
  // 5. Cancels a day: the second is admitted, the third refused.
  const n1 = (await coinsOf('B')).s.authNonce;
  const c2 = await post('cancel-offers', await cancelB());
  record('cancel 2', reply(c2));
  expect('cancel 2', reply(c2), 202);
  await finish(c2, 'cancel 2 B');
  await nonceMoves(n1);
  const c3 = await post('cancel-offers', await cancelB());
  record('cancel 3 (2 today)', reply(c3));
  expect('cancel 3', reply(c3), 429, 'cancels-daily-cap');
  // 6. Restores a day (their own count: the cancels are used up, a restore is still admitted).
  const away = bytesToHex(generateEncKeyPairPortable().publicKey);
  const rs1 = await restoreTo('B', away, 'restores cap: 1st (a page rotates B’s key away)');
  record('restore 1 (to another key)', rs1.admission as Reply, { chainShowsNewKey: rs1.chainShowsNewKey });
  expect('restore 1', rs1.admission as Reply, 202);
  if (!rs1.chainShowsNewKey) throw new Error('B’s key change did not land');
  out.checkAfterAttack = await siteCheck('B');
  const rs2 = await restoreTo('B', state.B.encPublic, 'restores cap: 2nd');
  record('restore 2 (1 today)', rs2.admission as Reply);
  expect('restore 2', rs2.admission as Reply, 429, 'restores-daily-cap');
  out.pass = true;
  put('caps', out);
}

/** After the relay restarted (the counters live in memory, RUNBOOK section 9): B's key back. */
async function capsRestore() {
  step('caps-restore: after a relay restart the restore cap is reset; B restores its key');
  const out: Record<string, unknown> = { checkBefore: await siteCheck('B') };
  out.restore = await restoreTo('B', state.B.encPublic, 'restore after the relay restart');
  const r = out.restore as { admission: Reply; chainShowsNewKey?: boolean };
  out.checkAfter = await siteCheck('B', { until: (c) => c.ok });
  put('capsRestore', out);
  if (r.admission.status !== 202 || !r.chainShowsNewKey || !(out.checkAfter as { ok: boolean }).ok)
    throw new Error(`B's restore failed: ${json(out)}`);
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
      case 'withdraw-unshielded':
        await withdrawUnshielded();
        break;
      case 'cancel':
        await cancel();
        break;
      case 'expired':
        await expired();
        break;
      case 'p9-negatives':
        await p9Negatives();
        break;
      case 'restore':
        await restoreStep();
        break;
      case 'p10-negatives':
        await p10Negatives();
        break;
      case 'fairness':
        await fairness();
        break;
      case 'caps':
        await caps();
        break;
      case 'caps-restore':
        await capsRestore();
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
