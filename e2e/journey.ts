// AA 00057 P3: the scripted US5 journey's own steps. The journey itself is run by ./run-local.sh, which
// calls the page-code harnesses Night Market already has (test/stack/p6/market-flows.ts for I and IV,
// test/gates/landing/landing.ts for the Bridge in of II and the pre-funding, Show in my wallet of III and
// the Bridge out of V) and this script, one STEP per process, for what the journey adds:
//
//   STEP=oracle CHECKPOINT=start|II|III|IV|V|after-negatives
//                       reads every surface of the US5 oracle table (./oracle.ts) and compares it
//                       EXACTLY: A's wallet on the Solana validator, accounts A and B by the PAGE's own
//                       code (syncAccount over a copy of each page's store; the oracle never signs and
//                       never writes the page's store), A's wallet through the injector's
//                       `getTokenAccountsByOwner` (both token programs), and the bridges' vaults. It
//                       polls until every surface is exact or ORACLE_TIMEOUT_S passes, and records the
//                       time each surface took (SC-003 for the RPC). While A is not registered (start,
//                       II) the injector's answers for A must be byte-identical to the validator's
//                       (SC-006); once registered, its real-SPL answer must still equal the validator's
//                       (FR-007)
//   STEP=neg-registration  SC-004: a forged registration (B's wallet and account, a signature by another
//                       key) and a registration for another key's account (B's wallet signs for A's
//                       account) are refused, and nothing is stored for either
//   STEP=unregistered   SC-006: for B's wallet (unregistered, with history) and a fresh address, every
//                       answer of the injector is byte-identical to the validator's
//   STEP=third-party    a fresh Solana key for the non-account lock (kept in $STATE_DIR, mode 600);
//                       prints `THIRD <address>` for the run script to fund
//   STEP=neg-undeliverable  SC-004 / US1-2: the page's own Bridge-in precheck refuses a lock to Y's
//                       bridge contract (not a Passport account); the same lock sent anyway (the raw
//                       LockToContract a hostile client could send) is reported `undeliverable` by X's
//                       bridge, which signs nothing: no new action on X's bridge contract
//   STEP=fr021          P3b.4 (FR-021): after landing.ts OUT_CASE=partial, the injector's X equals the page's
//                       and the registration's unseenCoins is 0 (the oracle's after-partial checks balances)
//   STEP=spl-faucet     P3b.4 (00060 P13): a claim mints 1,000 X and 1,000 Y to a fresh wallet; a second is refused
//   STEP=spl-metadata   P3b.4 (00059 P7): the real SPL X's metadata through the injector's fill-in
//                       (EXPECT_SPL_FILLIN=0 before P7: passed through, nothing invented)
//   STEP=demo-decimals  P3b.4 (Q10): after A's demo claim, twBTC 8 decimals, twUSDC 6, icons, equal to the page
//   STEP=icons          P3b.4 (Q10): every published icon equals the table and the site's bundled copy
//   STEP=prompts        SC-005: user A's wallet prompts over the journey's steps (≤ 7; per step 1,1,1,1,3);
//                       the partial Bridge out (FR-021) takes exactly 4 (one more than a whole-coin one)
//   STEP=summary        the run's verdict, the oracle table as observed, the timings and the prompts
//
// SECRETS: the test wallets' seeds and the accounts' encryption secrets are market-flows.ts's
// ($STATE_DIR/state.json, mode 600); the third party's key is $STATE_DIR/third-party.json (mode 600).
// Everything this script writes to $OUT is public.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { randomBytes } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { base58 } from '@scure/base';
import nacl from 'tweetnacl';

import {
  PROFILES,
  SPL_FAUCET_REFUSALS,
  bytesToHex,
  hexToBytes,
  holdingsByColour,
  registryFor,
  type NetworkName,
} from '@nightmarket/core';
import {
  parseJourneyRegistry,
  readRegistrationInfo,
  registrationExpiresAt,
  registrationId,
  registrationMessageText,
  type BridgeEntry,
} from '@nightmarket/core/bridge';
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  associatedTokenAddress,
  bridgeVaultAddress,
  findProgramAddress,
  shortvec,
  splitTransaction,
} from '@nightmarket/core/solana';

import { ChainReader } from '../web/src/chain/indexer.js';
import { BridgeInRefused, followBridgeIn, precheckBridgeIn, sendBridgeIn } from '../web/src/bridge/in/operations.js';
import { claimSolanaTokens, faucetOffer, solanaBalances } from '../web/src/bridge/faucet/operations.js';
import { SolanaRpc } from '../web/src/bridge/solana-rpc.js';
import { RelayClient, RelayError } from '../web/src/relay/client.js';
import { syncAccount } from '../web/src/passport/operations.js';
import { headlessPage } from '../test/stack/p6/page.js';
import {
  CHECKPOINTS,
  ORACLE,
  compareCheckpoint,
  formatWhole,
  oracleRowText,
  type CheckpointName,
  type Observed,
} from './oracle.js';
import { logPrompt, readPromptLog, summarisePrompts, SC005_LIMIT } from './prompt-log.js';
import { parseIconTable } from './registry/icons.js';

type Any = any;

// ── configuration ───────────────────────────────────────────────────────────
const NETWORK = (process.env.NETWORK ?? 'undeployed') as NetworkName;
const PROFILE = PROFILES[NETWORK];
const STEP = process.env.STEP ?? '';
const STATE_DIR = process.env.STATE_DIR ?? '/state';
const OUT = process.env.OUT ?? '/out';
const RUN = process.env.RUN_DIR_IN ?? '/run/nm';
const need = (n: string): string => {
  const v = process.env[n];
  if (!v) throw new Error(`${n} is required`);
  return v;
};
const RELAY = process.env.RELAY_URL ?? 'http://relay:8080';
const INDEXER_URL = process.env.INDEXER_URL ?? 'http://indexer:8088/api/v4/graphql';
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL ?? '';
/** The injector on the stack network (it names 127.0.0.1:<port> as its origin; the text binds that). */
const INJECTOR_URL = (process.env.INJECTOR_URL ?? 'http://injector:8899').replace(/\/$/, '');
const ORACLE_TIMEOUT_S = Number(process.env.ORACLE_TIMEOUT_S ?? '180');

const say = (s: string) => process.stdout.write(`   ${s}\n`);
const step = (s: string) => process.stdout.write(`\n== ${new Date().toISOString()} ${s}\n`);
const norm = (h: unknown) => String(h).replace(/^0x/, '').toLowerCase();
const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── results ($OUT/journey.json, public) ─────────────────────────────────────
const outPath = join(OUT, 'journey.json');
const out: Record<string, Any> = existsSync(outPath) ? JSON.parse(readFileSync(outPath, 'utf8')) : { steps: {} };
const record = (key: string, value: unknown) => {
  out.steps[key] = value;
  writeFileSync(outPath, `${json(out)}\n`);
};

// ── the parties (market-flows.ts's state) and the journey's tokens ─────────────
interface Party {
  seed: string;
  encSecret: string;
  encPublic: string;
  account?: string;
}
interface FlowsState {
  network: string;
  A: Party;
  B: Party;
}
const flows = (): FlowsState => {
  const f = JSON.parse(readFileSync(join(STATE_DIR, 'state.json'), 'utf8')) as FlowsState;
  if (f.network !== NETWORK) throw new Error(`the state is for ${f.network}`);
  if (!f.A.account || !f.B.account) throw new Error('accounts A and B are not open (market-flows.ts open-a,open-b)');
  return f;
};
const keyOf = (p: Party) => nacl.sign.keyPair.fromSeed(hexToBytes(p.seed, 32));
const addressOf = (p: Party) => base58.encode(keyOf(p).publicKey);

const journeyFile = need('JOURNEY_FILE');
const journey = () => {
  const raw = JSON.parse(readFileSync(journeyFile, 'utf8'));
  return parseJourneyRegistry(raw, { midnightNetwork: NETWORK });
};
const tokens = () => registryFor(NETWORK, JSON.parse(readFileSync(join(RUN, 'tokens.json'), 'utf8')));

// ── JSON-RPC ────────────────────────────────────────────────────────────────
async function rawRpc(url: string, method: string, params: unknown[]): Promise<string> {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return r.text();
}
async function rpc(url: string, method: string, params: unknown[]): Promise<Any> {
  const j = JSON.parse(await rawRpc(url, method, params)) as { result?: Any; error?: Any };
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}
/** The answer with the context's slot masked (it moves between two reads). */
const maskSlot = (s: string) => s.replace(/"slot":\d+/g, '"slot":0');
/**
 * Byte identity of the injector's answer and the validator's (00059 gate A8's method): both read at once,
 * up to 10 tries for an exact match; the slot-masked answers must also be equal on EVERY try.
 */
async function bytesIdentical(method: string, params: unknown[]) {
  let exact = false;
  let maskedEveryTry = true;
  let n = 0;
  for (; n < 10 && !exact; n++) {
    const [a, b] = await Promise.all([rawRpc(INJECTOR_URL, method, params), rawRpc(SOLANA_RPC_URL, method, params)]);
    exact = a === b;
    maskedEveryTry &&= maskSlot(a) === maskSlot(b);
  }
  return {
    method,
    params: json(params).slice(0, 160),
    exact,
    maskedEveryTry,
    attempts: n,
    ok: exact && maskedEveryTry,
  };
}

// ── the surfaces ────────────────────────────────────────────────────────────
interface SplRead {
  holdings: Record<string, bigint>;
  /** Token accounts with a zero balance (recorded, not holdings). */
  zeros: string[];
  raw: { mint: string; amount: string; decimals: number; name?: string; symbol?: string }[];
}

/** A wallet's classic SPL holdings at `url`, keyed by the journey symbol (unknown mints by `mint:<b58>`). */
async function splHoldings(url: string, owner: string, entries: readonly BridgeEntry[]): Promise<SplRead> {
  const r = await rpc(url, 'getTokenAccountsByOwner', [
    owner,
    { programId: TOKEN_PROGRAM_ID },
    { encoding: 'jsonParsed', commitment: 'confirmed' },
  ]);
  const out: SplRead = { holdings: {}, zeros: [], raw: [] };
  for (const a of r.value as Any[]) {
    const info = a.account.data.parsed.info;
    const mint = String(info.mint);
    const amount = BigInt(info.tokenAmount.amount);
    const e = entries.find((x) => x.splMint === mint);
    const key = e
      ? Number(info.tokenAmount.decimals) === e.decimals
        ? e.symbol
        : `${e.symbol}?decimals`
      : `mint:${mint}`;
    out.raw.push({ mint, amount: amount.toString(), decimals: Number(info.tokenAmount.decimals) });
    if (amount === 0n) out.zeros.push(key);
    else out.holdings[key] = (out.holdings[key] ?? 0n) + amount;
  }
  return out;
}

/** The synthetic "<name> (Midnight)" holdings the injector lists (Token-2022), keyed by the journey symbol. */
async function midnightHoldings(owner: string, entries: readonly BridgeEntry[]): Promise<SplRead> {
  const r = await rpc(INJECTOR_URL, 'getTokenAccountsByOwner', [
    owner,
    { programId: TOKEN_2022_PROGRAM_ID },
    { encoding: 'jsonParsed', commitment: 'confirmed' },
  ]);
  const out: SplRead = { holdings: {}, zeros: [], raw: [] };
  for (const a of r.value as Any[]) {
    const info = a.account.data.parsed.info;
    const mint = String(info.mint);
    const amount = BigInt(info.tokenAmount.amount);
    const decimals = Number(info.tokenAmount.decimals);
    const mi = await rpc(INJECTOR_URL, 'getAccountInfo', [mint, { encoding: 'jsonParsed' }]).catch(() => null);
    const meta = (mi?.value?.data?.parsed?.info?.extensions ?? []).find((x: Any) => x.extension === 'tokenMetadata')
      ?.state as { name?: string; symbol?: string } | undefined;
    const name = meta?.name ?? null;
    // I-4b: a bridged colour shows as "<I-1 name> (Midnight)", with the SPL mint's decimals.
    const e = entries.find((x) => name === `${x.name} (Midnight)`);
    const key = e ? (decimals === e.decimals ? e.symbol : `${e.symbol}?decimals`) : `t22:${name ?? mint}`;
    out.raw.push({
      mint,
      amount: amount.toString(),
      decimals,
      ...(name ? { name } : {}),
      ...(meta?.symbol ? { symbol: meta.symbol } : {}),
    });
    if (amount === 0n) out.zeros.push(key);
    else out.holdings[key] = (out.holdings[key] ?? 0n) + amount;
  }
  return out;
}

/** An account's holdings by the PAGE's own code, over a COPY of that page's store (never written back). */
async function pageHoldings(who: 'A' | 'B', f: FlowsState, symbolOf: (colour: string) => string) {
  const p = f[who];
  const kp = keyOf(p);
  const dir = mkdtempSync(join(tmpdir(), 'aa00057-oracle-'));
  try {
    const store = join(dir, `page-${who}.json`);
    const src = join(STATE_DIR, `page-${who}.json`);
    if (existsSync(src)) copyFileSync(src, store);
    const page = headlessPage({
      network: NETWORK,
      relayUrl: RELAY,
      chain: new ChainReader({ indexerUrl: INDEXER_URL, networkId: PROFILE.midnightNetworkId }),
      // The oracle never asks a wallet: a signer that refuses.
      signer: {
        deviceKey: bytesToHex(kp.publicKey),
        address: base58.encode(kp.publicKey),
        signMessage: async () => {
          throw new Error('the oracle never signs');
        },
      },
      tokens: tokens(),
      storePath: store,
      account: { address: norm(p.account), encSecret: p.encSecret, encPublic: p.encPublic },
    });
    const sync = await syncAccount(page, norm(p.account));
    const h: Record<string, bigint> = {};
    for (const x of holdingsByColour(sync.coins)) h[symbolOf(x.color)] = (h[symbolOf(x.color)] ?? 0n) + x.total;
    return h;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function vaultBalances(entries: readonly BridgeEntry[]): Promise<Record<string, bigint>> {
  const sol = new SolanaRpc(SOLANA_RPC_URL);
  const h: Record<string, bigint> = {};
  for (const e of entries) h[e.symbol] = (await sol.tokenBalance(bridgeVaultAddress(e.bridgeProgram, e.splMint))) ?? 0n;
  return h;
}

// ── STEP=oracle ─────────────────────────────────────────────────────────────
async function oracle(name: CheckpointName) {
  if (!(CHECKPOINTS as readonly string[]).includes(name)) throw new Error(`unknown CHECKPOINT ${name}`);
  step(`oracle ${name}: every surface of the US5 table, exactly`);
  const f = flows();
  const reg = journey();
  const entries = reg.entries;
  const tk = tokens();
  const symbolOf = (colour: string) =>
    reg.byColour(colour)?.symbol ?? tk.byColour(colour)?.symbol ?? `colour:${colour.slice(0, 16)}`;
  const walletA = addressOf(f.A);
  const t0 = Date.now();
  const firstExact: Record<string, number | null> = {};
  let last: Any;
  let observed: Observed;
  let detail: Any;
  for (;;) {
    const [solA, rpcSplA, rpcMidA, accA, accB, vaults] = await Promise.all([
      splHoldings(SOLANA_RPC_URL, walletA, entries),
      splHoldings(INJECTOR_URL, walletA, entries),
      midnightHoldings(walletA, entries),
      pageHoldings('A', f, symbolOf),
      pageHoldings('B', f, symbolOf),
      vaultBalances(entries),
    ]);
    observed = {
      solanaA: solA.holdings,
      accountA: accA,
      rpcA: { spl: rpcSplA.holdings, midnight: rpcMidA.holdings },
      accountB: accB,
      vaults,
    };
    detail = { solanaA: solA, rpcSpl: rpcSplA, rpcMidnight: rpcMidA };
    last = compareCheckpoint(name, observed);
    const s = (Date.now() - t0) / 1000;
    for (const r of last.surfaces as Any[])
      if (r.exact && firstExact[r.surface] === undefined) firstExact[r.surface] = s;
    if (last.exact || s > ORACLE_TIMEOUT_S) break;
    await sleep(3_000);
  }
  for (const r of last.surfaces as Any[]) firstExact[r.surface] ??= null;
  // SC-006 while A is not registered; FR-007 once it is (the real SPL answer unchanged).
  const registered = !(name === 'start' || name === 'II');
  const identity = registered
    ? null
    : await Promise.all([
        bytesIdentical('getTokenAccountsByOwner', [
          walletA,
          { programId: TOKEN_PROGRAM_ID },
          { encoding: 'jsonParsed' },
        ]),
        bytesIdentical('getTokenAccountsByOwner', [
          walletA,
          { programId: TOKEN_2022_PROGRAM_ID },
          { encoding: 'jsonParsed' },
        ]),
        bytesIdentical('getBalance', [walletA]),
        bytesIdentical('getAccountInfo', [walletA, { encoding: 'base64' }]),
      ]);
  const byMint = (r: SplRead) => json([...r.raw].sort((a, b) => (a.mint < b.mint ? -1 : 1)));
  const realSplUntouched = registered
    ? byMint(await splHoldings(INJECTOR_URL, walletA, entries)) ===
      byMint(await splHoldings(SOLANA_RPC_URL, walletA, entries))
    : null;
  const want = ORACLE[name];
  const res = {
    checkpoint: name,
    exact: last.exact,
    seconds: (Date.now() - t0) / 1000,
    secondsToExact: firstExact,
    surfaces: last.surfaces,
    table: {
      walletASolana: oracleRowText(observed!.solanaA),
      accountA: oracleRowText(observed!.accountA),
      walletAThroughRpc:
        [oracleRowText(observed!.rpcA.spl), oracleRowText(observed!.rpcA.midnight, ' (Midnight)')]
          .filter((t) => t !== '—')
          .join(', ') || '—',
      accountB: oracleRowText(observed!.accountB),
      vaults: Object.entries(observed!.vaults)
        .map(([k, v]) => `${k} ${formatWhole(v)}`)
        .join(', '),
    },
    expectedTable: {
      walletASolana: oracleRowText(want.solanaA),
      accountA: oracleRowText(want.accountA),
      walletAThroughRpc:
        [oracleRowText(want.rpcA.spl), oracleRowText(want.rpcA.midnight, ' (Midnight)')]
          .filter((t) => t !== '—')
          .join(', ') || '—',
      accountB: oracleRowText(want.accountB),
    },
    zeroTokenAccounts: {
      solanaA: detail.solanaA.zeros,
      rpcSpl: detail.rpcSpl.zeros,
      rpcMidnight: detail.rpcMidnight.zeros,
    },
    rpcMidnightRaw: detail.rpcMidnight.raw,
    unregisteredIdentity: identity,
    realSplUntouched,
  };
  record(`oracle:${name}`, res);
  for (const r of last.surfaces as Any[])
    say(
      `${r.exact ? 'EXACT' : 'DIFF '} ${r.surface.padEnd(14)} ${json(r.got)}${r.exact ? '' : `  ${r.diff.join('; ')}`}`,
    );
  if (identity) for (const i of identity) say(`SC-006 A unregistered: ${i.method} ${i.ok ? 'identical' : 'DIFFERENT'}`);
  const identityOk = identity === null || identity.every((i) => i.ok);
  if (!last.exact || !identityOk || realSplUntouched === false)
    throw new Error(
      `oracle ${name}: not exact (${json(last.surfaces.filter((s: Any) => !s.exact).map((s: Any) => s.diff))}; identity ${identityOk}; real SPL untouched ${realSplUntouched})`,
    );
}

// ── STEP=neg-registration ───────────────────────────────────────────────────
async function negRegistration() {
  step('SC-004: a forged registration and a registration for another key’s account are refused; nothing is stored');
  const f = flows();
  const info = await readRegistrationInfo(INJECTOR_URL);
  const now = Math.floor(Date.now() / 1000);
  const expires = registrationExpiresAt(now, info.maxTtlSeconds);
  const B = keyOf(f.B);
  const walletB = base58.encode(B.publicKey);
  const post = async (body: Record<string, string>) => {
    const r = await fetch(`${INJECTOR_URL}/api/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: (await r.json().catch(() => ({}))) as Any };
  };
  const stored = async (wallet: string, account: string) => {
    const r = await fetch(`${INJECTOR_URL}/api/accounts/${registrationId(wallet, account)}`);
    return r.status;
  };
  const textFor = (wallet: string, account: string) =>
    registrationMessageText({
      origin: info.origin,
      networkId: info.networkId,
      solanaAddress: wallet,
      accountAddress: account,
      expires,
    });
  // (a) forged: B's wallet and B's account, B's viewing key, signed by ANOTHER key.
  const forgedText = textFor(walletB, norm(f.B.account));
  const forger = nacl.sign.keyPair.fromSeed(new Uint8Array(randomBytes(32)));
  const forged = await post({
    solanaAddress: walletB,
    accountAddress: norm(f.B.account),
    accountViewingKey: f.B.encSecret,
    message: forgedText,
    signature: bytesToHex(nacl.sign.detached(new TextEncoder().encode(forgedText), forger.secretKey)),
  });
  const forgedStored = await stored(walletB, norm(f.B.account));
  // (b) another key's account: B's wallet signs (validly) a registration of A's account, with A's
  // viewing key (the strongest case: the attacker even holds the key).
  const otherText = textFor(walletB, norm(f.A.account));
  const otherBytes = new TextEncoder().encode(otherText);
  logPrompt(B.publicKey, 'message', otherBytes);
  const other = await post({
    solanaAddress: walletB,
    accountAddress: norm(f.A.account),
    accountViewingKey: f.A.encSecret,
    message: otherText,
    signature: bytesToHex(nacl.sign.detached(otherBytes, B.secretKey)),
  });
  const otherStored = await stored(walletB, norm(f.A.account));
  const res = {
    forged: { status: forged.status, code: forged.body?.code ?? null, storedStatus: forgedStored },
    otherKeysAccount: { status: other.status, code: other.body?.code ?? null, storedStatus: otherStored },
  };
  record('neg-registration', res);
  say(json(res));
  const ok =
    forged.status === 401 &&
    forged.body?.code === 'bad-signature' &&
    forgedStored === 404 &&
    other.status === 403 &&
    other.body?.code === 'not-a-device' &&
    otherStored === 404;
  if (!ok) throw new Error(`SC-004 registrations: not refused as expected: ${json(res)}`);
}

// ── STEP=unregistered (SC-006) ──────────────────────────────────────────────
async function unregistered() {
  step('SC-006: an unregistered address gets byte-identical answers');
  const f = flows();
  const walletB = addressOf(f.B);
  const fresh = base58.encode(nacl.sign.keyPair.fromSeed(new Uint8Array(randomBytes(32))).publicKey);
  const calls = (addr: string): [string, unknown[]][] => [
    ['getTokenAccountsByOwner', [addr, { programId: TOKEN_PROGRAM_ID }, { encoding: 'jsonParsed' }]],
    ['getTokenAccountsByOwner', [addr, { programId: TOKEN_2022_PROGRAM_ID }, { encoding: 'jsonParsed' }]],
    ['getBalance', [addr]],
    ['getAccountInfo', [addr, { encoding: 'base64' }]],
    ['getSignaturesForAddress', [addr, { limit: 20 }]],
  ];
  const results: Record<string, Any[]> = {};
  for (const [label, addr] of [
    ['walletB', walletB],
    ['fresh', fresh],
  ] as const) {
    results[label] = [];
    for (const [m, p] of calls(addr)) results[label]!.push(await bytesIdentical(m, p));
  }
  // B's wallet must hold something real for the check to mean anything (SOL, its token account).
  const balanceB = await rpc(SOLANA_RPC_URL, 'getBalance', [walletB]);
  const res = { walletB, fresh, walletBLamports: balanceB?.value ?? null, results };
  record('unregistered', res);
  for (const [k, v] of Object.entries(results))
    for (const r of v) say(`${k} ${r.method} ${r.ok ? 'identical' : 'DIFFERENT'}`);
  if (!Object.values(results).every((v) => v.every((r) => r.ok)))
    throw new Error(`SC-006: an unregistered address got a different answer: ${json(results)}`);
}

// ── STEP=third-party / neg-undeliverable ────────────────────────────────────
const thirdPath = join(STATE_DIR, 'third-party.json');
function thirdKey(): nacl.SignKeyPair {
  if (!existsSync(thirdPath)) {
    writeFileSync(thirdPath, `${JSON.stringify({ seed: bytesToHex(new Uint8Array(randomBytes(32))) })}\n`, {
      mode: 0o600,
    });
    chmodSync(thirdPath, 0o600);
  }
  const { seed } = JSON.parse(readFileSync(thirdPath, 'utf8')) as { seed: string };
  return nacl.sign.keyPair.fromSeed(hexToBytes(seed, 32));
}

async function contractActionCount(address: string): Promise<number> {
  const r = await fetch(INDEXER_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query: 'query A($a: HexEncoded!) { contract(address: $a) { actions(limit: 1000) { __typename } } }',
      variables: { a: norm(address) },
    }),
  });
  const j = (await r.json()) as Any;
  if (j.errors) throw new Error(`indexer: ${JSON.stringify(j.errors).slice(0, 300)}`);
  return (j.data?.contract?.actions ?? []).length;
}

async function negUndeliverable() {
  step('SC-004 / US1-2: a lock to a contract that is not a Passport account');
  const reg = journey();
  const X = reg.entries.find((e) => e.symbol === 'X')!;
  const Y = reg.entries.find((e) => e.symbol === 'Y')!;
  const T = thirdKey();
  const third = base58.encode(T.publicKey);
  const sol = new SolanaRpc(SOLANA_RPC_URL);
  const amount = BigInt(process.env.NEG_AMOUNT ?? '1000000');
  const target = norm(Y.bridgeContract);
  const ctx = {
    rpc: sol,
    chain: 'solana:localnet',
    depositor: third,
    account: target,
    // As if the page's own check had passed: the bridge's recognition must still refuse.
    accountCheck: 'ok' as const,
    transactions: {
      async sign(tx: Uint8Array) {
        const { message } = splitTransaction(tx);
        const sig = nacl.sign.detached(message, T.secretKey);
        const o = new Uint8Array(shortvec(1).length + 64 + message.length);
        o.set(shortvec(1), 0);
        o.set(sig, shortvec(1).length);
        o.set(message, shortvec(1).length + 64);
        return o;
      },
    },
  };
  // 1. The page's precheck refuses before any wallet prompt.
  let precheck: Any;
  try {
    await precheckBridgeIn(ctx, X, amount);
    precheck = { refused: false };
  } catch (e) {
    precheck = { refused: e instanceof BridgeInRefused, message: (e as Error).message };
  }
  // 2. The same lock sent anyway: the bridge must report it undeliverable and sign nothing.
  const vault = bridgeVaultAddress(X.bridgeProgram, X.splMint);
  const before = {
    vault: (await sol.tokenBalance(vault)) ?? 0n,
    third: (await sol.tokenBalance(associatedTokenAddress(third, X.splMint))) ?? 0n,
    xBridgeActions: await contractActionCount(X.bridgeContract),
  };
  const t0 = Date.now();
  let rec = await sendBridgeIn(ctx, X, amount, 0n);
  // The bridge's own verdict, read from X's node directly. The node answers `GET /transfers/:id` with
  // `{ "transfer": <TransferView> }` (00050's envelope, which 00058's CLI reads); a 404 until it has seen
  // the lock. The page's own reading of the same transfer (followBridgeIn) is recorded beside it.
  const nodeView = async (): Promise<Any | null> => {
    if (!rec.lockNonce) return null;
    const r = await fetch(`${X.bridgeApi}/transfers/s2m:${rec.lockNonce}`).catch(() => null);
    if (!r || !r.ok) return null;
    const body = (await r.json().catch(() => null)) as Any;
    return body?.transfer ?? null;
  };
  const timeline: string[] = [];
  let view: Any | null = null;
  let decidedSeconds: number | null = null;
  while (Date.now() - t0 < 300_000) {
    if (rec.state !== 'undeliverable' && rec.state !== 'failed' && rec.state !== 'completed') {
      rec = await followBridgeIn(rec, ctx, async () => []);
      if (rec.progress && timeline[timeline.length - 1] !== rec.progress) timeline.push(rec.progress);
    }
    view = await nodeView();
    if (view?.status === 'undeliverable' || view?.status === 'completed') {
      decidedSeconds ??= (Date.now() - t0) / 1000;
      // Give the page a few more reads to see it too (it polls the same API).
      if (rec.state === 'undeliverable' || Date.now() - t0 > decidedSeconds * 1000 + 30_000) break;
    }
    await sleep(3_000);
  }
  await sleep(20_000); // a margin: nothing may follow the decision
  view = (await nodeView()) ?? view;
  const ata = associatedTokenAddress(third, X.splMint);
  const after = {
    vault: (await sol.tokenBalance(vault)) ?? 0n,
    third: (await sol.tokenBalance(ata)) ?? 0n,
    xBridgeActions: await contractActionCount(X.bridgeContract),
  };
  // Whether the PAGE (Night Market's own I-3 client) must see `undeliverable` too: the strict default.
  // See plans/00057-solana-midnight-journey-questions.md Q9 (the page cannot read the node's envelope).
  const pageMustSee = process.env.NEG_PAGE_MUST_SEE !== '0';
  const res = {
    target: { contract: target, what: "Y's bridge contract (a contract, not a Passport account)" },
    precheck,
    lock: {
      signature: rec.signature,
      nonce: rec.lockNonce ?? null,
      pageState: rec.state,
      pageReason: rec.reason ?? null,
    },
    view: view
      ? { status: view.status, reason: view.reason, delivery: view.delivery, recipientKind: view.recipientKind }
      : null,
    pageSawUndeliverable: rec.state === 'undeliverable',
    pageMustSee,
    decidedSeconds,
    timeline,
    before,
    after,
  };
  record('neg-undeliverable', res);
  say(json(res));
  const ok =
    precheck.refused === true &&
    /cannot deliver/.test(String(precheck.message)) &&
    view?.status === 'undeliverable' &&
    view?.reason?.code === 'not-a-passport-account' &&
    view?.delivery === null &&
    after.xBridgeActions === before.xBridgeActions &&
    after.vault - before.vault === amount &&
    before.third - after.third === amount &&
    (!pageMustSee || rec.state === 'undeliverable');
  if (!ok) throw new Error(`SC-004 non-account lock: not as expected: ${json(res)}`);
}

// ── P3b.4: the rows beyond the spec's table ─────────────────────────────────
/** The injector's registration of A (I-4 `GET /api/accounts/:id`). */
async function registrationOfA(f: FlowsState): Promise<Any | null> {
  const r = await fetch(`${INJECTOR_URL}/api/accounts/${registrationId(addressOf(f.A), norm(f.A.account))}`);
  return r.ok ? r.json() : null;
}

/** STEP=fr021 (spec FR-021): after the partial Bridge out, the injector shows exactly the page's X and the
 *  registration counts no unseen coin (the change was saved in the inbox). The balances themselves are the
 *  oracle's (CHECKPOINT=after-partial). */
async function fr021() {
  step('FR-021: after a partial Bridge out, the injector equals the page and unseenCoins is 0');
  const f = flows();
  const reg = journey();
  const X = reg.entries.find((e) => e.symbol === 'X')!;
  const symbolOf = (c: string) => reg.byColour(c)?.symbol ?? `colour:${c.slice(0, 16)}`;
  const t0 = Date.now();
  let res: Any;
  for (;;) {
    const [page, rpcMid, registration] = await Promise.all([
      pageHoldings('A', f, symbolOf),
      midnightHoldings(addressOf(f.A), reg.entries),
      registrationOfA(f),
    ]);
    res = {
      pageX: (page.X ?? 0n).toString(),
      rpcX: (rpcMid.holdings.X ?? 0n).toString(),
      unseenCoins: registration?.unseenCoins ?? null,
      status: registration?.status ?? null,
      colour: X.colour,
      seconds: (Date.now() - t0) / 1000,
    };
    if ((res.pageX === res.rpcX && res.unseenCoins === 0) || Date.now() - t0 > 120_000) break;
    await sleep(3_000);
  }
  record('fr021', res);
  say(json(res));
  if (res.pageX !== res.rpcX || res.unseenCoins !== 0 || res.status !== 'synced')
    throw new Error(`FR-021: the injector does not equal the page, or a coin is unseen: ${json(res)}`);
}

/** STEP=spl-faucet (00060 P13, spec FR-024): a claim mints 1,000 X and 1,000 Y to a FRESH wallet (no wallet
 *  prompt: the relay pays), read back from the validator; a second claim within the period is refused. */
async function splFaucet() {
  step('P13: the test SPL faucet mints 1,000 X and 1,000 Y to a fresh wallet; a second claim is refused');
  const reg = journey();
  const relay = new RelayClient(RELAY);
  const wallet = base58.encode(nacl.sign.keyPair.fromSeed(new Uint8Array(randomBytes(32))).publicKey);
  const offer = await faucetOffer(relay, wallet);
  const sol = new SolanaRpc(SOLANA_RPC_URL);
  const before = await solanaBalances(sol, wallet, offer?.tokens ?? []);
  const t0 = Date.now();
  const result = await claimSolanaTokens(relay, wallet);
  const claimSeconds = (Date.now() - t0) / 1000;
  let after = await solanaBalances(sol, wallet, offer!.tokens);
  for (let i = 0; i < 20 && offer!.tokens.some((t) => after.get(t.mint) !== BigInt(t.amount)); i++) {
    await sleep(1_000);
    after = await solanaBalances(sol, wallet, offer!.tokens);
  }
  let second: Any;
  try {
    await claimSolanaTokens(relay, wallet);
    second = { refused: false };
  } catch (e) {
    second = {
      refused: true,
      code: e instanceof RelayError ? e.code : ((e as Any).code ?? null),
      message: (e as Error).message,
    };
  }
  const expected = Object.fromEntries(
    reg.entries.map((e) => [e.splMint, (1000n * 10n ** BigInt(e.decimals)).toString()]),
  );
  const res = {
    wallet,
    offer: offer
      ? { enabled: offer.enabled, reason: offer.reason ?? null, periodHours: offer.periodHours, tokens: offer.tokens }
      : null,
    signature: result.signature,
    claimSeconds,
    minted: result.minted.map((m) => ({ symbol: m.symbol, amount: m.amount, createdAccount: m.createdAccount })),
    balances: Object.fromEntries(
      (offer?.tokens ?? []).map((t) => [
        t.symbol,
        { before: String(before.get(t.mint)), after: String(after.get(t.mint)) },
      ]),
    ),
    second,
  };
  record('spl-faucet', res);
  say(json(res));
  const ok =
    !!offer?.enabled &&
    offer.tokens.length === reg.entries.length &&
    offer.tokens.every(
      (t) => t.amount === expected[t.mint] && before.get(t.mint) === 0n && after.get(t.mint) === BigInt(t.amount),
    ) &&
    second.refused === true &&
    second.code === SPL_FAUCET_REFUSALS.period;
  if (!ok) throw new Error(`P13: the faucet is not as expected: ${json(res)}`);
}

const METAPLEX = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s';
/** Metaplex Token Metadata v1: name, symbol, uri (borsh strings, NUL padding trimmed). */
function decodeMetaplex(data: Uint8Array): { name: string; symbol: string; uri: string } | null {
  if (data.length < 65 + 12 || data[0] !== 4) return null;
  let at = 65;
  const str = () => {
    const n = data[at]! | (data[at + 1]! << 8) | (data[at + 2]! << 16) | (data[at + 3]! << 24);
    const s = new TextDecoder().decode(data.slice(at + 4, at + 4 + n)).replace(/\0+$/, '');
    at += 4 + n;
    return s;
  };
  return { name: str(), symbol: str(), uri: str() };
}
/** The injector's own URL for a public one it names (its PUBLIC_URL is 127.0.0.1:<port> on the host). */
const inContainer = (url: string) => url.replace(/^http:\/\/127\.0\.0\.1:\d+/, INJECTOR_URL);

/** STEP=spl-metadata (00059 P7, Q10): the REAL SPL X through the injector. With EXPECT_SPL_FILLIN=1 (the
 *  default; 00059 after P7) its Metaplex metadata PDA reads as name "X", symbol "X", and the metadata JSON's
 *  image is I-1's `splImage`; with 0 (00059 before P7) the injector passes the upstream's answer through
 *  (no metadata account), byte for byte. Either way the mint account itself is the validator's, byte for byte. */
async function splMetadata() {
  step('00059 P7: the real SPL X reads as "X" with its icon, through the metadata fill-in');
  const reg = journey();
  const raw = JSON.parse(readFileSync(journeyFile, 'utf8')) as { tokens: Any[] };
  const fillin = process.env.EXPECT_SPL_FILLIN !== '0';
  const out: Record<string, Any> = { expectFillIn: fillin };
  let ok = true;
  for (const e of reg.entries) {
    const i1 = raw.tokens.find((t) => t.splMint === e.splMint) ?? {};
    const [pda] = findProgramAddress(
      [new TextEncoder().encode('metadata'), base58.decode(METAPLEX), base58.decode(e.splMint)],
      METAPLEX,
    );
    const mintIdentical = await bytesIdentical('getAccountInfo', [e.splMint, { encoding: 'base64' }]);
    const r = await rpc(INJECTOR_URL, 'getAccountInfo', [pda, { encoding: 'base64' }]);
    const upstream = await rpc(SOLANA_RPC_URL, 'getAccountInfo', [pda, { encoding: 'base64' }]);
    const meta = r?.value ? decodeMetaplex(new Uint8Array(Buffer.from(r.value.data[0], 'base64'))) : null;
    let image: string | null = null;
    if (meta?.uri) {
      const j = (await fetch(inContainer(meta.uri))
        .then((x) => x.json())
        .catch(() => null)) as Any;
      image = j?.image ?? null;
    }
    const row = {
      mint: e.splMint,
      pda,
      upstreamHasMetadata: !!upstream?.value,
      served: meta,
      image,
      expectedImage: i1.splImage ?? null,
      mintBytesIdentical: mintIdentical.ok,
    };
    out[e.symbol] = row;
    const rowOk = fillin
      ? !row.upstreamHasMetadata && meta?.name === e.name && meta?.symbol === e.symbol && image === i1.splImage
      : !row.upstreamHasMetadata && r?.value === null;
    ok &&= rowOk && mintIdentical.ok;
  }
  record('spl-metadata', out);
  say(json(out));
  if (!ok) throw new Error(`00059 P7: the real SPL metadata is not as expected: ${json(out)}`);
}

/** STEP=demo-decimals (Q10): after A claims Night Market's demo tokens, the injector shows them with Night
 *  Market's decimals (twBTC 8: 0.1 twBTC = 10,000,000 base units), names and icons, equal to the page. */
async function demoDecimals() {
  step('Q10: twBTC shows 8 decimals through the injector (and twUSDC 6), equal to the page, with icons');
  const f = flows();
  const reg = journey();
  const tk = tokens();
  const icons = parseIconTable(JSON.parse(readFileSync(join(__dirname, 'registry/token-icons.json'), 'utf8')));
  const symbolOf = (c: string) => reg.byColour(c)?.symbol ?? tk.byColour(c)?.symbol ?? `colour:${c.slice(0, 16)}`;
  const t0 = Date.now();
  let res: Any;
  for (;;) {
    const page = await pageHoldings('A', f, symbolOf);
    const r = await rpc(INJECTOR_URL, 'getTokenAccountsByOwner', [
      addressOf(f.A),
      { programId: TOKEN_2022_PROGRAM_ID },
      { encoding: 'jsonParsed' },
    ]);
    const rows: Any[] = [];
    for (const a of r.value as Any[]) {
      const info = a.account.data.parsed.info;
      const mi = await rpc(INJECTOR_URL, 'getAccountInfo', [String(info.mint), { encoding: 'jsonParsed' }]).catch(
        () => null,
      );
      const meta = (mi?.value?.data?.parsed?.info?.extensions ?? []).find(
        (x: Any) => x.extension === 'tokenMetadata',
      )?.state;
      const json2 = meta?.uri
        ? ((await fetch(inContainer(meta.uri))
            .then((x) => x.json())
            .catch(() => null)) as Any)
        : null;
      rows.push({
        name: meta?.name ?? null,
        symbol: meta?.symbol ?? null,
        amount: String(info.tokenAmount.amount),
        decimals: Number(info.tokenAmount.decimals),
        uiAmountString: String(info.tokenAmount.uiAmountString),
        image: json2?.image ?? null,
      });
    }
    const pick = (n: string) => rows.find((x) => x.name === n);
    const btc = pick('twBTC (Midnight)');
    const usdc = pick('twUSDC (Midnight)');
    res = {
      page: Object.fromEntries(Object.entries(page).map(([k, v]) => [k, v.toString()])),
      rpc: rows,
      seconds: (Date.now() - t0) / 1000,
      checks: {
        twBTC:
          !!btc &&
          btc.decimals === 8 &&
          btc.amount === String(page.twBTC ?? -1n) &&
          btc.uiAmountString === '0.1' &&
          btc.image === icons.base + icons.midnight.twBTC,
        twUSDC:
          !!usdc &&
          usdc.decimals === 6 &&
          usdc.amount === String(page.twUSDC ?? -1n) &&
          usdc.image === icons.base + icons.midnight.twUSDC,
        xMidnightImage: pick('X (Midnight)')?.image === icons.base + icons.midnight.X,
      },
    };
    if (Object.values(res.checks).every(Boolean) || Date.now() - t0 > 120_000) break;
    await sleep(3_000);
  }
  record('demo-decimals', res);
  say(json(res));
  if (!Object.values(res.checks).every(Boolean)) throw new Error(`Q10 decimals/icons: not as expected: ${json(res)}`);
}

/** STEP=icons (Q10): every published icon the wallet loads is byte-identical to the site's bundled copy. */
async function iconsStep() {
  step('Q10: the published icons equal the table and the site’s bundled copies');
  const icons = parseIconTable(JSON.parse(readFileSync(join(__dirname, 'registry/token-icons.json'), 'utf8')));
  const { createHash } = await import('node:crypto');
  const rows: Any[] = [];
  for (const [file, sha] of Object.entries(icons.sha256)) {
    const r = await fetch(icons.base + file).catch(() => null);
    const body = r?.ok ? new Uint8Array(await r.arrayBuffer()) : null;
    const site = readFileSync(join(__dirname, '../web/public', icons.siteDir, file));
    rows.push({
      file,
      status: r?.status ?? null,
      cors: r?.headers.get('access-control-allow-origin') ?? null,
      published: body ? createHash('sha256').update(body).digest('hex') === sha : false,
      site: createHash('sha256').update(site).digest('hex') === sha,
    });
  }
  record('icons', rows);
  for (const r of rows) say(`${r.file} ${r.status} published=${r.published} site=${r.site} cors=${r.cors}`);
  if (!rows.every((r) => r.published && r.site && r.cors === '*')) throw new Error(`Q10 icons: ${json(rows)}`);
}

// ── STEP=prompts (SC-005) ───────────────────────────────────────────────────
function prompts() {
  step('SC-005: user A’s wallet prompts over the journey');
  const f = flows();
  const log = readPromptLog(readFileSync(need('PROMPT_LOG'), 'utf8'));
  const A = summarisePrompts(log, addressOf(f.A));
  const B = summarisePrompts(log, addressOf(f.B));
  const res = {
    limit: SC005_LIMIT,
    A,
    B,
    entriesA: log.filter((e) => e.wallet === A.wallet).map((e) => ({ step: e.step, kind: e.kind, what: e.what })),
  };
  record('prompts', res);
  say(`A: ${json(A.perStep)} = ${A.journeyTotal} (limit ${SC005_LIMIT}); outside the journey ${json(A.other)}`);
  if (!A.withinLimit || !A.matchesExpected) throw new Error(`SC-005: A's prompts are not as expected: ${json(A)}`);
  // FR-021 / 00060 P12.3: a partial Bridge out asks once more (saving its change) than a whole-coin one.
  if (A.other.fr021 !== undefined && A.other.fr021 !== 4)
    throw new Error(`FR-021: the partial Bridge out took ${A.other.fr021} prompts, not 4`);
}

// ── STEP=summary ────────────────────────────────────────────────────────────
function summary() {
  const s = out.steps as Record<string, Any>;
  const rows = CHECKPOINTS.filter((c) => s[`oracle:${c}`]).map((c) => ({
    checkpoint: c,
    exact: s[`oracle:${c}`].exact,
    ...s[`oracle:${c}`].table,
    secondsToExact: s[`oracle:${c}`].secondsToExact,
  }));
  const verdict = {
    oracleExactAtEveryCheckpoint: rows.length === CHECKPOINTS.length && rows.every((r) => r.exact),
    negatives: {
      registration: !!s['neg-registration'],
      unregisteredIdentity: !!s.unregistered,
      undeliverable: !!s['neg-undeliverable'],
    },
    prompts: s.prompts ? { A: s.prompts.A.journeyTotal, perStep: s.prompts.A.perStep } : null,
  };
  record('summary', { rows, verdict });
  say(json({ rows, verdict }));
}

async function main() {
  switch (STEP) {
    case 'oracle':
      return oracle(need('CHECKPOINT') as CheckpointName);
    case 'neg-registration':
      return negRegistration();
    case 'unregistered':
      return unregistered();
    case 'third-party':
      process.stdout.write(`THIRD ${base58.encode(thirdKey().publicKey)}\n`);
      return;
    case 'neg-undeliverable':
      return negUndeliverable();
    case 'fr021':
      return fr021();
    case 'spl-faucet':
      return splFaucet();
    case 'spl-metadata':
      return splMetadata();
    case 'demo-decimals':
      return demoDecimals();
    case 'icons':
      return iconsStep();
    case 'prompts':
      return prompts();
    case 'summary':
      return summary();
    default:
      throw new Error(`unknown STEP ${JSON.stringify(STEP)}`);
  }
}

main().then(
  () => process.exit(0),
  (e: unknown) => {
    const msg = String((e as Error)?.message ?? e);
    out.steps[`${STEP}${process.env.CHECKPOINT ? `:${process.env.CHECKPOINT}` : ''}:error`] = msg.slice(0, 3000);
    writeFileSync(outPath, `${json(out)}\n`);
    process.stderr.write(`FAILED ${STEP}: ${msg.slice(0, 2000)}\n${String((e as Error)?.stack ?? '')}\n`);
    process.exit(1);
  },
);
/* eslint-enable @typescript-eslint/no-explicit-any */
