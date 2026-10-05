// AA 00060 P3, gate G-LANDING: Bridge out's mechanism end to end on a ledger-9 localnet, before L-OUT is
// built (plan P3, L.1-L.10). Driven by ./run-local.sh, which brings the stack up (Night Market's p6
// recipe), opens account A with market-flows.ts (STEPS=open-a), and calls this script once per STEP,
// starting and stopping the relay around it (the sponsor seed is the relay's: one wallet per seed).
//
//   STEP=bridge-deploy  a third party (dev seed 3) deploys bridge contract Y from the 00050 template's
//                       compiled artefacts (P0.6), with a throwaway operator Ed25519 key and a fake SPL mint;
//                       prints `BRIDGE {…}` (its address and colour) for the run script
//   STEP=fund           L.4: the operator signs the `SMBRDG1:` digest, the third party calls `mintFromSolana`
//                       to itself and `deposit_shielded` into A; the PAGE's own decode must show the coin
//   STEP=tx1            L.1 + L.5: the landing key from A's test keypair (I-5, asked twice), then tx1: the
//                       page's `withdrawToWallet` through the REAL relay to keys_t(A, n), sealed to keys_t
//   STEP=tx2            L.6 + L.7 (relay stopped): keys_t's shielded wallet syncs; `lockForSolana` is built
//                       with NO key material, balanced by keys_t alone, proven on rc.8 with the relay's own
//                       runtime, then the sponsor (dev seed 1) adds DUST only and submits; the assertions
//   STEP=resume-lock    L.8 (relay stopped, a new process): re-derive, FIND the coin with no stored record
//                       (the page's decode + tx1's Zswap events), finish the lock
//   STEP=resume-return  L.8 (relay stopped): re-derive, find, return the coin to A (`deposit_shielded`
//                       sealed to A's on-chain key), the page sees it
//   STEP=neg-relay      L.9 (a): tx1's payload with another recipient and the original approval → 401
//   STEP=neg-circuit    L.9 (b) (relay stopped): the same, straight to the account's circuit
//   STEP=neg-node       L.9 (c) (relay stopped): tx2 with the Solana recipient changed after proving
//   STEP=neg-seal       L.9 (d): tx1 sealed to another encryption key: does keys_t's wallet still see it?
//
// AA 00060 P6.0, the Q5 gate (owner decision A, the computed-coin spend): with COMPUTED=1, STEP=tx2 and
// STEP=return balance the call with the landing coin built by the PAGE's own path
// (@nightmarket/core/bridge/landing-spend: keys_t's ledger-v9 Zswap local state watches for the predicted
// coin and replays every Zswap event from the public indexer, web/src/bridge/out/zswap-events.ts) instead
// of the wallet SDK's sync, so it works whatever key tx1 sealed the coin to. STEP=return (TX1_LABEL=…)
// returns that transfer's coin to A (`deposit_shielded`, sealed to A's on-chain key).
//
// AA 00060 P6 (T6.5, T6.4), STEP=out with OUT_CASE: the PAGE's own Bridge out (web/src/bridge/out/
// operations.ts, the page's signing seam over A's test key) through the REAL relay's `withdraw` (purpose
// `bridge-out`), `bridge-out` and `bridge-out-entitle`, the relay started with BRIDGE_REGISTRY_FILE and
// the bridge bundle in its key volume:
//   a           50 Y: derive (2 prompts), tx1 (1 prompt), the lock: the bridge records {A's wallet, 50 Y};
//               every request the page made is captured, and no landing secret is in any of them or in
//               the page's store (T6.4, SC-005)
//   b-start/b   30 Y: tx1, then a NEW process finishes the lock from the stored record
//   c-start/c   20 Y: tx1, then the coin is returned to A (the page sees it)
//   d-start/d   15 Y: tx1, then an EMPTY store finds the transfer from the chain alone, the relay re-issues
//               its entitlement (`bridge-out-entitle`), and the lock lands
//   e           (WITHDRAWS_DAILY_CAP=1) a partial bridge-out past the allowance → 429 withdraws-daily-cap;
//               the whole coin → admitted as the exit, and locked
//   f           a hedged signer: refused at the landing key (`not-deterministic`) before tx1
//   g           a stored check that does not match → `landing-key-changed`, before tx1
//   i           two locks built on the same bridge state at once: one lands, the other is refused before
//               any proof (`bridge-out-stale`), rebuilt on the new state, and lands
//   j           `bridge-out-entitle` for a coin tx1 never paid → `entitle-not-found`
//
// SECRETS: A's test device seed is market-flows.ts's (state.json, mode 600); the landing master is
// re-derived from it in every process and never written; the operator's throwaway key is in
// landing-state.json (mode 600). Everything written to $OUT is public.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { sha256, sha512 } from '@noble/hashes/sha2.js';
import { base58 } from '@scure/base';
import nacl from 'tweetnacl';

import {
  PROFILES,
  bytesToHex,
  chooseCoin,
  hexToBytes,
  holdingsByColour,
  registryFor,
  type NetworkName,
} from '@nightmarket/core';
import { bridgeColourOf, deriveLandingMaster, type BridgeEntry, type LandingMaster } from '@nightmarket/core/bridge';
import {
  TOKEN_2022_PROGRAM_ID,
  associatedTokenAddress,
  bridgeVaultAddress,
  shortvec,
  splitTransaction,
} from '@nightmarket/core/solana';
import {
  balanceWithLandingCoin,
  findLandingCoin,
  landingLocalState,
  type LandingCoinInfo,
} from '@nightmarket/core/bridge/landing-spend';
import { landingKeyFor, type LandingKeys } from '@nightmarket/core/bridge/landing-wallet';
import {
  callContext,
  decodeEd25519Point,
  decodeEd25519Signature,
  ed25519DeviceOf,
  findUseCounter,
  passportAuthOf,
  withdrawRequest,
} from '@nightmarket/core/passport';

import { parseSponsorSeed } from '../../../relay/src/config.js';
import { createLogger } from '../../../relay/src/log.js';
import { PassportRuntime } from '../../../relay/src/passport/runtime.js';
import { syncedKeys, type SponsorWalletHandle } from '../../../relay/src/passport/wallet-provider.js';
import { openFacadeWallet } from '../../../relay/src/sponsor/facade.js';
import { sealEntryPortable } from '../../../vendor/passport/contract/src/wallet/deposit.js';
import { ChainReader, indexerWsUrlFor } from '../../../web/src/chain/indexer.js';
import { decodeEvent } from '../../../web/src/chain/ledger-decode.js';
import { syncAccount, withdrawToWallet } from '../../../web/src/passport/operations.js';
import { readCoins } from '../../../web/src/passport/records.js';
import { readZswapEvents } from '../../../web/src/bridge/out/zswap-events.js';
import {
  adoptTransfer,
  findTransfers,
  finishLock,
  followBridgeOut,
  landingMasterFor,
  returnToAccount,
  startBridgeOut,
  type BridgeOutContext,
} from '../../../web/src/bridge/out/operations.js';
import { followBridgeIn, precheckBridgeIn, sendBridgeIn } from '../../../web/src/bridge/in/operations.js';
import { checkInjector, readRegistrationStatus, registerAccount } from '../../../web/src/bridge/rpc/operations.js';
import { SolanaRpc } from '../../../web/src/bridge/solana-rpc.js';
import { putBridgeOut, readBridgeOuts, type BridgeOutRecord } from '../../../web/src/bridge/out/records.js';
import { recordKey } from '../../../web/src/store/schema.js';
import { ed25519ActionSigning } from '../../../web/src/wallet/signing.js';
import { logPrompt } from '../../../e2e/prompt-log.js';
import { headlessPage, type HeadlessPage } from '../../stack/p6/page.js';
import { landingCoinCommitment, paidOutNonce } from './coins.js';

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
const INDEXER_WS_URL = indexerWsUrlFor(INDEXER_URL);
const NODE_WS_URL = process.env.NODE_WS_URL ?? 'ws://node:9944';
const CONTRACT_PROVER = process.env.MIDNIGHT_CONTRACT_PROOF_SERVER_URL ?? 'http://proof-server-rc8:6300';
const DUST_PROVER = process.env.MIDNIGHT_DUST_PROOF_SERVER_URL ?? 'http://proof-server:6300';
const MANAGED = process.env.MIDNIGHT_MANAGED_PATH ?? '/app/vendor/passport/contract/contracts/managed';
const BRIDGE_DIR = join(MANAGED, 'bridge');
/** Y has 6 decimals: 50 Y, 30 Y, 20 Y. */
const UNIT = 1_000_000n;
/** The headless "browser"'s origin for I-5 (a local origin; there is no page server here). */
const ORIGIN = process.env.LANDING_ORIGIN ?? 'http://127.0.0.1:5173';
/** No Solana chain in this gate: a fixed genesis hash stands in for the I-1 value. */
const GENESIS = process.env.SOLANA_GENESIS ?? base58.encode(new Uint8Array(32).fill(7));
/** P6.0 (Q5 A): balance with the page's computed-coin path instead of the SDK's sync. */
const COMPUTED = process.env.COMPUTED === '1';
/** P9 (the real 00058 bridges): the Solana validator's RPC (JOURNEY_FILE: the journey registry). */
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL ?? '';

const say = (s: string) => process.stdout.write(`   ${s}\n`);
const step = (s: string) => process.stdout.write(`\n== ${new Date().toISOString()} ${s}\n`);
const norm = (h: unknown) => String(h).replace(/^0x/, '').toLowerCase();
const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));
const errorChain = (e: unknown): string => {
  const chain: string[] = [];
  for (let c: unknown = e, i = 0; c && i < 8; c = (c as { cause?: unknown }).cause, i++) {
    chain.push(String((c as Error)?.message ?? c));
  }
  return chain.join(' <- ');
};

// ── state: market-flows' (A) and this gate's own ────────────────────────────
// market-flows.ts writes state.json when it opens A (after STEP=bridge-deploy): read it lazily.
interface FlowsState {
  network: string;
  A: { seed: string; encSecret: string; encPublic: string; account?: string; txs?: Any };
  /** AA 00057: B, for B's own Bridge in (WHO=B). */
  B?: { seed: string; encSecret: string; encPublic: string; account?: string; txs?: Any };
}
let flowsCache: FlowsState | null = null;
function flowsState(): FlowsState {
  if (flowsCache) return flowsCache;
  const path = join(STATE_DIR, 'state.json');
  if (!existsSync(path)) throw new Error('no state.json: open account A first (market-flows.ts STEPS=open-a)');
  const f = JSON.parse(readFileSync(path, 'utf8')) as FlowsState;
  if (f.network !== NETWORK) throw new Error(`the state is for ${f.network}`);
  return (flowsCache = f);
}
interface GateState {
  operatorSecret?: string;
  bridge?: { contract: string; colour: string; sourceMint: string; networkTag: string };
  nextLockNonce?: number;
  tx1?: Record<string, Any>;
  /** P9: the real 00058 bridges' journey entries (I-1) by symbol; Y's is also `bridge`. */
  journey?: Record<string, BridgeEntry>;
  /** P9: A's coin commitments per symbol at the last page-mark. */
  marks?: Record<string, string[]>;
}
const gatePath = join(STATE_DIR, 'landing-state.json');
const gate: GateState = existsSync(gatePath) ? (JSON.parse(readFileSync(gatePath, 'utf8')) as GateState) : {};
const saveGate = () => {
  writeFileSync(gatePath, `${JSON.stringify(gate, null, 2)}\n`, { mode: 0o600 });
  chmodSync(gatePath, 0o600);
};
const outPath = join(OUT, 'landing.json');
const out: Record<string, Any> = existsSync(outPath) ? JSON.parse(readFileSync(outPath, 'utf8')) : { steps: {} };
const record = (key: string, value: unknown) => {
  out.steps[key] = value;
  mkdirSync(OUT, { recursive: true });
  writeFileSync(outPath, `${json(out)}\n`);
};

const tokens = registryFor(NETWORK, JSON.parse(readFileSync(join(RUN, 'tokens.json'), 'utf8')));
/** A's test keypair (the "wallet"), from market-flows.ts's state, loaded on first use. */
let kpCache: nacl.SignKeyPair | null = null;
const kpOfA = () => (kpCache ??= nacl.sign.keyPair.fromSeed(hexToBytes(flowsState().A.seed, 32)));
const kpA = {
  get publicKey() {
    return kpOfA().publicKey;
  },
  get secretKey() {
    return kpOfA().secretKey;
  },
};
const signerA = {
  get deviceKey() {
    return bytesToHex(kpA.publicKey);
  },
  get address() {
    return base58.encode(kpA.publicKey);
  },
  // AA 00057 P3 (SC-005): every signature the PAGE (or a step acting as the user) asks of A's wallet
  // is one prompt, recorded when PROMPT_LOG is set. The gate's own re-derivations (landingMaster, used
  // to verify, never by the page) sign with `rawSignA` and are not prompts.
  signMessage: async (m: Uint8Array) => {
    logPrompt(kpA.publicKey, 'message', m);
    return nacl.sign.detached(m, kpA.secretKey);
  },
};
const rawSignA = async (m: Uint8Array) => nacl.sign.detached(m, kpA.secretKey);
const flows = {
  get A() {
    return flowsState().A;
  },
};
const account = () => {
  if (!flows.A.account) throw new Error('account A is not open (run market-flows.ts STEPS=open-a)');
  return norm(flows.A.account);
};
const colourY = () => {
  if (!gate.bridge) throw new Error('no bridge (STEP=bridge-deploy first)');
  return gate.bridge.colour;
};

// ── the runtime pieces ──────────────────────────────────────────────────────
const log = createLogger({ level: 'warn' }, { service: 'landing-gate' });
let rtP: Promise<PassportRuntime> | undefined;
const runtime = () =>
  (rtP ??= PassportRuntime.load({
    managedPath: MANAGED,
    networkId: PROFILE.midnightNetworkId,
    indexerUrl: INDEXER_URL,
    indexerWsUrl: INDEXER_WS_URL,
    contractProofServerUrl: CONTRACT_PROVER,
    log,
  }));

async function openWallet(seedFile: string) {
  return openFacadeWallet(
    parseSponsorSeed(readFileSync(seedFile, 'utf8')),
    {
      networkId: PROFILE.midnightNetworkId,
      indexerUrl: INDEXER_URL,
      indexerWsUrl: INDEXER_WS_URL,
      nodeWsUrl: NODE_WS_URL,
      dustProofServerUrl: DUST_PROVER,
    },
    { feeBlocksMargin: 20 },
  );
}

/** The bridge contract from the vendored compiled artefacts (P0.6), in the key-volume copy. */
async function bridgeRuntime() {
  const mod: Any = await import(join(BRIDGE_DIR, 'contract', 'index.js'));
  const { CompiledContract } = (await import('@midnight-ntwrk/compact-js')) as Any;
  const { NodeZkConfigProvider } = await import('@midnight-ntwrk/midnight-js-node-zk-config-provider');
  const compiled = CompiledContract.make('contract-bridge', mod.Contract).pipe(
    CompiledContract.withWitnesses({}),
    CompiledContract.withCompiledFileAssets(BRIDGE_DIR),
  );
  return { mod, compiled, zk: new NodeZkConfigProvider(BRIDGE_DIR), ledger: (d: Any) => mod.ledger(d) };
}

/** The page for A (headless): its store keeps A's encryption secret, as a browser does. */
let pageP: HeadlessPage | undefined;
function pageA(): HeadlessPage {
  return (pageP ??= headlessPage({
    network: NETWORK,
    relayUrl: RELAY,
    chain: new ChainReader({ indexerUrl: INDEXER_URL, networkId: PROFILE.midnightNetworkId }),
    signer: signerA,
    tokens,
    storePath: join(STATE_DIR, 'page-A.json'),
    account: {
      address: account(),
      encSecret: flows.A.encSecret,
      encPublic: flows.A.encPublic,
      ...(flows.A.txs ? { txs: flows.A.txs } : {}),
    },
  }));
}

/** AA 00057: B's wallet and page (B's own Bridge in, WHO=B), as market-flows.ts opened B. */
const flowsB = () => {
  const b = flowsState().B;
  if (!b?.account) throw new Error('account B is not open (run market-flows.ts STEPS=open-b)');
  return b;
};
let kpBCache: nacl.SignKeyPair | null = null;
const kpOfB = () => (kpBCache ??= nacl.sign.keyPair.fromSeed(hexToBytes(flowsB().seed, 32)));
const signerB = {
  get deviceKey() {
    return bytesToHex(kpOfB().publicKey);
  },
  get address() {
    return base58.encode(kpOfB().publicKey);
  },
  signMessage: async (m: Uint8Array) => {
    logPrompt(kpOfB().publicKey, 'message', m);
    return nacl.sign.detached(m, kpOfB().secretKey);
  },
};
let pageBP: HeadlessPage | undefined;
function pageB(): HeadlessPage {
  const b = flowsB();
  return (pageBP ??= headlessPage({
    network: NETWORK,
    relayUrl: RELAY,
    chain: new ChainReader({ indexerUrl: INDEXER_URL, networkId: PROFILE.midnightNetworkId }),
    signer: signerB,
    tokens,
    storePath: join(STATE_DIR, 'page-B.json'),
    account: {
      address: norm(b.account),
      encSecret: b.encSecret,
      encPublic: b.encPublic,
      ...(b.txs ? { txs: b.txs } : {}),
    },
  }));
}
/** The party a WHO=A|B step acts for: its wallet key, page and account. */
function party(who: 'A' | 'B') {
  return who === 'B'
    ? { who, kp: kpOfB(), address: signerB.address, page: pageB(), account: norm(flowsB().account) }
    : { who, kp: kpOfA(), address: signerA.address, page: pageA(), account: account() };
}

/** The page's balance of Y on A (its own decode), waiting until `until` holds. */
async function pageY(until: (v: bigint) => boolean = () => true, tries = 60, colour = colourY()) {
  const pg = pageA();
  let last: { total: bigint; coins: Any[]; authNonce: string } = { total: -1n, coins: [], authNonce: '' };
  for (let i = 0; i < tries; i++) {
    const sync = await syncAccount(pg, account());
    pg.flush();
    const y = holdingsByColour(sync.coins).find((h) => h.color === colour);
    last = {
      total: y?.total ?? 0n,
      coins: sync.coins.filter((c: Any) => c.color === colour),
      authNonce: sync.state.authNonce,
    };
    if (until(last.total)) return last;
    await new Promise((r) => setTimeout(r, 3_000));
  }
  return last;
}

/** I-5 from A's test keypair (asked twice, as the page will), with this gate's fixed site values. */
async function landingMaster(): Promise<{ master: LandingMaster; ms: number; prompts: number }> {
  const t0 = Date.now();
  let prompts = 0;
  const master = await deriveLandingMaster(
    async (m) => {
      prompts += 1;
      return rawSignA(m);
    },
    { origin: ORIGIN, midnightNetwork: NETWORK, solanaGenesisHash: GENESIS, walletAddress: signerA.address },
    kpA.publicKey,
    { expect: { siteNetwork: NETWORK, rpcGenesisHash: GENESIS } },
  );
  return { master, ms: Date.now() - t0, prompts };
}

/** keys_t's shielded wallet (the SDK's ShieldedWallet alone, as AA 00048), synced strictly. */
async function openLanding(keys: LandingKeys) {
  if (!('WebSocket' in globalThis)) {
    const { WebSocket } = await import('ws');
    (globalThis as { WebSocket?: unknown }).WebSocket = WebSocket;
  }
  const Rx = await import('rxjs');
  const { ShieldedWallet } = (await import('@midnightntwrk/wallet-sdk-shielded')) as Any;
  const t0 = Date.now();
  const wallet: Any = ShieldedWallet({
    networkId: PROFILE.midnightNetworkId,
    indexerClientConnection: { indexerHttpUrl: INDEXER_URL, indexerWsUrl: INDEXER_WS_URL },
    txHistoryStorage: {
      gotPending: async () => undefined,
      gotFinalized: async () => undefined,
      gotRejected: async () => undefined,
      getAll: async () => [],
      get: async () => undefined,
      serialize: async () => '[]',
    },
  }).startWithSecretKeys(keys.shieldedSecretKeys);
  await wallet.start(keys.shieldedSecretKeys);
  const state: Any = await Rx.firstValueFrom(
    wallet.state.pipe(
      Rx.filter((s: Any) => s.progress.isStrictlyComplete()),
      Rx.timeout({ first: 600_000 }),
    ),
  );
  const syncMs = Date.now() - t0;
  const balances = async (): Promise<Record<string, bigint>> => {
    const s: Any = await Rx.firstValueFrom(wallet.state);
    return Object.fromEntries(Object.entries(s.balances as Record<string, bigint>).map(([k, v]) => [norm(k), v]));
  };
  const waitFor = async (colour: string, atLeast: bigint, ms = 300_000) => {
    const until = Date.now() + ms;
    for (;;) {
      const b = (await balances())[colour] ?? 0n;
      if (b >= atLeast || Date.now() > until) return b;
      await new Promise((r) => setTimeout(r, 2_000));
    }
  };
  return { wallet, syncMs, firstState: state, balances, waitFor, stop: () => wallet.stop() };
}

/**
 * P6.0 (Q5 A): keys_t's OWN Zswap local state (the page's computed path): every Zswap event from the
 * public indexer, replayed into a ledger-v9 local state that watches for the predicted landing coin.
 * No wallet SDK, no decryption: it finds the coin whatever key tx1 sealed it to.
 */
async function computedLanding(keys: LandingKeys, coin: LandingCoinInfo) {
  if (!('WebSocket' in globalThis)) {
    const { WebSocket } = await import('ws');
    (globalThis as { WebSocket?: unknown }).WebSocket = WebSocket;
  }
  const t0 = Date.now();
  const events = await readZswapEvents(INDEXER_WS_URL, { timeoutMs: 300_000 });
  const readMs = Date.now() - t0;
  const t1 = Date.now();
  const state = landingLocalState(
    keys,
    coin,
    events.map((e) => e.raw),
  );
  const replayMs = Date.now() - t1;
  const q = findLandingCoin(state, coin);
  return {
    state,
    events: events.length,
    lastEventId: events.at(-1)?.id ?? null,
    readMs,
    replayMs,
    holds: !!q,
    mtIndex: q ? String((q as Any).mt_index) : null,
  };
}

const coinOf = (label: string): LandingCoinInfo => {
  const t = gate.tx1?.[label];
  if (!t?.landingCoin) throw new Error(`no landing coin recorded for ${label}`);
  return { nonce: t.landingCoin.nonce, color: t.landingCoin.color, value: BigInt(t.landingCoin.value) };
};

/** Building a call reads no key material (the browser holds none): anything that asks throws. */
const NO_KEY_MATERIAL = (() => {
  const refuse = () => {
    throw new Error('the browser holds no proving or verifier keys');
  };
  return {
    getProverKey: refuse,
    getVerifierKey: refuse,
    getVerifierKeys: refuse,
    getZKIR: refuse,
    get: refuse,
    asKeyMaterialProvider: refuse,
  };
})();

/** The transaction's contract calls (address:entryPoint), DUST spends and unshielded offers. */
function shapeOf(tx: Any): { calls: string[]; dustSpends: number; unshielded: boolean } {
  const calls: string[] = [];
  for (const intent of tx.intents?.values?.() ?? []) {
    for (const action of intent.actions ?? []) {
      if (action?.address && action?.entryPoint !== undefined) {
        const ep =
          typeof action.entryPoint === 'string' ? action.entryPoint : new TextDecoder().decode(action.entryPoint);
        calls.push(`${norm(action.address)}:${ep}`);
      }
    }
  }
  let dustSpends = 0;
  let unshielded = false;
  for (const intent of tx.intents?.values?.() ?? []) {
    dustSpends += intent.dustActions?.spends?.length ?? 0;
    if (intent.guaranteedUnshieldedOffer || intent.fallibleUnshieldedOffer) unshielded = true;
  }
  return { calls, dustSpends, unshielded };
}

async function indexerTx(id: string): Promise<Any | null> {
  const by = id.length === 64 ? 'hash' : 'identifier';
  const query = `{ transactions(offset: {${by}: "${id}"}) { hash block { height } zswapLedgerEvents { id raw } ... on RegularTransaction { identifiers fees { paidFees estimatedFees } transactionResult { status } } } }`;
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(INDEXER_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query }),
      });
      const j = (await res.json()) as { data?: { transactions?: Any[] } };
      const t = j.data?.transactions?.[0];
      if (t) return t;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 3_000));
  }
  return null;
}

/** The sponsor's DUST (seed 1), settled. */
async function dustOf(handle: SponsorWalletHandle): Promise<bigint | null> {
  const Rx = await import('rxjs');
  const st: Any = await Rx.firstValueFrom(
    (handle.wallet.state() as Any).pipe(
      Rx.filter((s: Any) => s.isSynced === true),
      Rx.timeout({ first: 300_000 }),
    ),
  );
  const d = st.dust?.walletBalance?.(new Date()) ?? st.dust?.balance?.(new Date());
  return typeof d === 'bigint' ? d : null;
}

/** The sponsor adds DUST only to a proven, bound transaction and submits it (AA 00048 addDustAndSubmit). */
async function addDustAndSubmit(handle: SponsorWalletHandle, tx: Any): Promise<{ txId: string; balanceMs: number }> {
  const h = handle as Any;
  const t0 = Date.now();
  const recipe = await h.wallet.balanceFinalizedTransaction(
    tx,
    { shieldedSecretKeys: h.shieldedSecretKeys, dustSecretKey: h.dustSecretKey },
    { ttl: new Date(Date.now() + 120_000), tokenKindsToBalance: ['dust'] },
  );
  const signed = await h.wallet.signRecipe(recipe, (p: Uint8Array) => h.unshieldedKeystore.signDataAsync(p));
  const merged = await h.wallet.finalizeRecipe(signed);
  const balanceMs = Date.now() - t0;
  const txId = String(await h.wallet.submitTransaction(merged));
  return { txId, balanceMs };
}

/** keys_t of a transfer, its predicted landing coin, and its commitment. */
function landingOf(
  master: LandingMaster,
  authNonce: bigint,
  spent: { nonce: string; color: string; value: string },
  amount: bigint,
) {
  const keys = landingKeyFor(master, account(), authNonce);
  const coin = { nonce: paidOutNonce(spent.nonce), color: norm(spent.color), value: amount.toString(10) };
  return { keys, coin, commitment: landingCoinCommitment(coin, keys.coinPublicKey) };
}

/** A shielded address for (cpk, epk), as the page parses it. */
async function shieldedAddress(cpk: string, epk: string): Promise<string> {
  const af: Any = await import('@midnightntwrk/wallet-sdk-address-format');
  return af.MidnightBech32m.encode(
    NETWORK,
    new af.ShieldedAddress(
      af.ShieldedCoinPublicKey.fromHexString(cpk),
      new af.ShieldedEncryptionPublicKey(Buffer.from(epk, 'hex')),
    ),
  ).asString();
}

// ── the steps ───────────────────────────────────────────────────────────────

async function bridgeDeploy() {
  step('bridge-deploy: a third party deploys bridge contract Y (00050 template artefacts, P0.6)');
  const tp = await openWallet(need('THIRD_PARTY_SEED_FILE'));
  try {
    const rt = await runtime();
    const bridge = await bridgeRuntime();
    const providers = { ...(await rt.providers(tp.handle as SponsorWalletHandle)), zkConfigProvider: bridge.zk };
    const operator = nacl.sign.keyPair();
    const sourceMint = new Uint8Array(randomBytes(32));
    const networkTag = sha256(new TextEncoder().encode(`midnight:${PROFILE.midnightNetworkId}`));
    const crt: Any = await import('@midnight-ntwrk/compact-runtime-0.20');
    const { ed25519 } = await import('@noble/curves/ed25519.js');
    const operatorKey = crt.curve25519FromProjective(ed25519.Point.fromBytes(operator.publicKey, false));
    const { deployContract } = (await import('@midnight-ntwrk/midnight-js-contracts')) as Any;
    const t0 = Date.now();
    const deployed: Any = await deployContract(providers, {
      compiledContract: bridge.compiled,
      args: [operatorKey, sourceMint, networkTag],
    });
    const contract = norm(deployed.deployTxData.public.contractAddress);
    const colour = bytesToHex(bridge.mod.pureCircuits.tokenColor(sourceMint, { bytes: hexToBytes(contract, 32) }));
    const ours = bridgeColourOf(sourceMint, contract);
    gate.operatorSecret = bytesToHex(operator.secretKey);
    gate.bridge = { contract, colour, sourceMint: bytesToHex(sourceMint), networkTag: bytesToHex(networkTag) };
    gate.nextLockNonce = 1;
    saveGate();
    const r = {
      contract,
      colour,
      colourByCoreBridgeColourOf: ours,
      colourMatchesCore: ours === colour,
      sourceMint: base58.encode(sourceMint),
      operator: base58.encode(operator.publicKey),
      networkTag: bytesToHex(networkTag),
      deployTx: deployed.deployTxData.public.txId ?? null,
      seconds: (Date.now() - t0) / 1000,
    };
    record('bridgeDeploy', r);
    if (!r.colourMatchesCore) throw new Error('core bridgeColourOf differs from the contract tokenColor');
    process.stdout.write(
      `BRIDGE ${json({ contract, colour, symbol: 'Y', decimals: 6, sourceMint: base58.encode(sourceMint) })}\n`,
    );
  } finally {
    await tp.stop().catch(() => undefined);
  }
}

/** L.4: mint `amount` Y to the third party (operator signs), then deposit it into A. */
async function fund(amount: bigint, label: string) {
  step(`${label}: mint ${amount / UNIT} Y to a third party (mintFromSolana), deposit_shielded into A`);
  const tp = await openWallet(need('THIRD_PARTY_SEED_FILE'));
  try {
    const rt = await runtime();
    const bridge = await bridgeRuntime();
    const handle = tp.handle as SponsorWalletHandle;
    const keys = await syncedKeys(handle);
    const cpk = norm(keys.coinPublicKey);
    const epk = norm(keys.encryptionPublicKey);
    const contract = gate.bridge!.contract;
    const lockNonce = BigInt(gate.nextLockNonce ?? 1);
    const recipient = { is_left: true, left: { bytes: hexToBytes(cpk, 32) }, right: { bytes: new Uint8Array(32) } };
    const digest: Uint8Array = bridge.mod.pureCircuits.mintDigest(
      { bytes: hexToBytes(contract, 32) },
      hexToBytes(gate.bridge!.networkTag, 32),
      lockNonce,
      recipient,
      amount,
    );
    const msg = new Uint8Array([...new TextEncoder().encode('SMBRDG1:'), ...digest]);
    const sig = nacl.sign.detached(msg, hexToBytes(gate.operatorSecret!, 64));
    const providers = { ...(await rt.providers(handle)), zkConfigProvider: bridge.zk };
    const { submitCallTx } = (await import('@midnight-ntwrk/midnight-js-contracts')) as Any;
    const before = await balancesOf(handle);
    const t0 = Date.now();
    const minted: Any = await submitCallTx(providers, {
      compiledContract: bridge.compiled,
      contractAddress: contract,
      circuitId: 'mintFromSolana',
      args: [lockNonce, recipient, amount, new Uint8Array(randomBytes(32)), decodeEd25519Signature(sig)],
      additionalCoinEncPublicKeyMappings: new Map([[cpk, epk]]),
    });
    const mintSeconds = (Date.now() - t0) / 1000;
    gate.nextLockNonce = Number(lockNonce) + 1;
    saveGate();
    say(`minted in ${mintSeconds.toFixed(1)} s (tx ${String(minted.public?.txId ?? '?')})`);
    // Wait until the third party's wallet holds the new coin.
    const want = (before[colourY()] ?? 0n) + amount;
    for (let i = 0; i < 100 && ((await balancesOf(handle))[colourY()] ?? 0n) < want; i++) {
      await new Promise((r) => setTimeout(r, 3_000));
    }
    // deposit_shielded into A, the entry sealed to A's on-chain key (any third party can).
    const l = await rt.ledgerState(account());
    if (!l?.booted) throw new Error('account A is not active');
    const coin = { nonce: new Uint8Array(randomBytes(32)), color: hexToBytes(colourY(), 32), value: amount };
    const entry = await sealEntryPortable(Uint8Array.from(l.enc_key), coin);
    const custody: Any = await rt.client.account.CustodyAccount.connect(
      await rt.providers(handle),
      rt.compiledAccount(),
      account(),
    );
    const t1 = Date.now();
    const dep: Any = await custody.depositShielded(coin, entry);
    const depositSeconds = (Date.now() - t1) / 1000;
    say(`deposited into A in ${depositSeconds.toFixed(1)} s (tx ${String(dep.txId)})`);
    const before2 = await pageY();
    const after = await pageY((v) => v >= before2.total + amount || v >= amount);
    const r = {
      lockNonce: lockNonce.toString(),
      amount: amount.toString(),
      mintTx: minted.public?.txId ?? null,
      mintSeconds,
      depositTx: dep.txId,
      depositSeconds,
      pageYTotal: after.total.toString(),
      pageYCoins: after.coins.map((c: Any) => ({ value: c.value, spent: c.spent, mtIndex: c.mtIndex })),
    };
    record(label, r);
    return r;
  } finally {
    await tp.stop().catch(() => undefined);
  }
}

async function balancesOf(handle: SponsorWalletHandle): Promise<Record<string, bigint>> {
  const Rx = await import('rxjs');
  const st: Any = await Rx.firstValueFrom(
    (handle.wallet.state() as Any).pipe(
      Rx.filter((s: Any) => s.isSynced === true),
      Rx.timeout({ first: 300_000 }),
    ),
  );
  return Object.fromEntries(
    Object.entries((st.shielded?.balances ?? {}) as Record<string, bigint>).map(([k, v]) => [norm(k), v]),
  );
}

/** L.1 + L.5: derive I-5 twice; tx1 through the real relay to keys_t(A, n). */
async function tx1(amount: bigint, label: string, opts: { sealTo?: string } = {}) {
  step(`${label}: I-5 (asked twice), then tx1 = the page's withdrawToWallet through the real relay`);
  const { master, ms, prompts } = await landingMaster();
  const pg = pageA();
  const y = await pageY((v) => v >= amount);
  const st = await pg.chain.accountState(account());
  if (!st) throw new Error('account A is not on chain');
  const n = BigInt(st.authNonce);
  const coins = readCoins(pg.store, pg.scope, account());
  const spent = chooseCoin(coins, colourY(), amount);
  const t = landingOf(master, n, spent, amount);
  // L.9 (d): SEAL_TO=other seals tx1 to another wallet's (valid) encryption key, as a relay could.
  let epk = t.keys.encryptionPublicKey;
  if (opts.sealTo === 'other') {
    const ledger: Any = await import('@midnightntwrk/ledger-v9');
    const other = ledger.ZswapSecretKeys.fromSeed(new Uint8Array(randomBytes(32)));
    epk = norm(other.encryptionPublicKey);
    other.clear();
  }
  const recipient = await shieldedAddress(t.keys.coinPublicKey, epk);
  const t0 = Date.now();
  const r = await withdrawToWallet(pg, account(), { color: colourY(), amount, recipient });
  pg.flush();
  const landed = await indexerTx(r.txId);
  const seconds = (Date.now() - t0) / 1000;
  const outputs = (landed?.zswapLedgerEvents ?? [])
    .map((e: Any) => decodeEvent(e.raw))
    .filter((e: Any) => e.kind === 'output')
    .map((e: Any) => ({ commitment: e.commitment, contract: e.contract, mtIndex: String(e.mtIndex) }));
  const hit = outputs.find((o: Any) => o.commitment === t.commitment);
  const res = {
    check: master.check,
    deterministic: true,
    derivationPrompts: prompts,
    derivationMs: ms,
    pageYBefore: y.total.toString(),
    authNonce: n.toString(),
    landingCoinPublicKey: t.keys.coinPublicKey,
    sealedTo: epk === t.keys.encryptionPublicKey ? 'keys_t encryption key' : 'ANOTHER encryption key',
    spentCoin: { value: spent.value, mtIndex: spent.mtIndex },
    predictedLandingCoin: { color: t.coin.color, value: t.coin.value },
    predictedCommitment: t.commitment,
    tx1: r.txId,
    tx1Hash: landed?.hash ?? null,
    tx1Block: landed?.block?.height ?? null,
    tx1Fees: landed?.fees ?? null,
    tx1Status: landed?.transactionResult?.status ?? null,
    tx1Seconds: seconds,
    tx1Outputs: outputs.map((o: Any) => ({ ...o, commitment: `${o.commitment.slice(0, 16)}…` })),
    predictedCommitmentInTx1: !!hit,
    landingMtIndex: hit?.mtIndex ?? null,
    change: r.change ? r.change.value : null,
  };
  gate.tx1 = {
    [label]: {
      authNonce: n.toString(),
      amount: amount.toString(),
      txHash: landed?.hash ?? null,
      // P6.0: the landing coin the page computes (public: from tx1's spend and the withdrawal).
      landingCoin: { nonce: t.coin.nonce, color: t.coin.color, value: t.coin.value },
      sealedElsewhere: epk !== t.keys.encryptionPublicKey,
    },
    ...(gate.tx1 ?? {}),
  };
  saveGate();
  record(label, res);
  t.keys.clear();
  master.wipe();
  if (!hit) throw new Error('the predicted landing coin is not among tx1’s outputs');
  return res;
}

/** L.6 + L.7: tx2 `lockForSolana` (no key material, landing-key balancing, rc.8, DUST-only sponsor). */
async function tx2(
  authNonce: bigint,
  amount: bigint,
  label: string,
  opts: { tamperRecipient?: boolean; coin?: LandingCoinInfo } = {},
) {
  const path = COMPUTED ? 'the COMPUTED coin (P6.0)' : 'the SDK wallet';
  step(`${label}: tx2 = lockForSolana(coin, <A's wallet key>), balanced by keys_t via ${path}, DUST by the sponsor`);
  const { master } = await landingMaster();
  const keys = landingKeyFor(master, account(), authNonce);
  master.wipe();
  const rt = await runtime();
  const bridge = await bridgeRuntime();
  if (COMPUTED && !opts.coin) throw new Error('COMPUTED needs the landing coin');
  const landing = COMPUTED ? null : await openLanding(keys);
  let comp: Awaited<ReturnType<typeof computedLanding>> | null = null;
  const sponsor = await openWallet(need('SPONSOR_SEED_FILE'));
  const res: Record<string, Any> = { authNonce: authNonce.toString(), amount: amount.toString(), path };
  try {
    if (landing) {
      res.landingSyncMs = landing.syncMs;
      res.landingBalanceY = String(await landing.waitFor(colourY(), amount));
    } else {
      comp = await computedLanding(keys, opts.coin!);
      res.computed = {
        events: comp.events,
        lastEventId: comp.lastEventId,
        readMs: comp.readMs,
        replayMs: comp.replayMs,
        holds: comp.holds,
        mtIndex: comp.mtIndex,
      };
      res.landingBalanceY = comp.holds ? amount.toString() : '0';
    }
    if (BigInt(res.landingBalanceY) < amount) throw new Error(`keys_t holds ${res.landingBalanceY} Y, not ${amount}`);
    const contract = gate.bridge!.contract;
    const pdp: Any = rt.publicDataProvider;
    const t0 = Date.now();
    const block = await pdp.queryBlock();
    const states = await pdp.queryZSwapAndContractState(contract, { type: 'blockHash', blockHash: block.hash });
    if (!states) throw new Error('no bridge state');
    const [zswapChainState, contractState, ledgerParameters] = states;
    const before = bridge.ledger(contractState.data);
    const predictedId = BigInt(before.withdrawalNonce);
    const solanaRecipient = Uint8Array.from(kpA.publicKey);
    const { createUnprovenCallTxFromInitialStates } = (await import('@midnight-ntwrk/midnight-js-contracts')) as Any;
    const { setNetworkId } = await import('@midnight-ntwrk/midnight-js-network-id');
    setNetworkId(PROFILE.midnightNetworkId as never);
    const call: Any = await createUnprovenCallTxFromInitialStates(
      NO_KEY_MATERIAL,
      {
        compiledContract: bridge.compiled,
        contractAddress: contract,
        circuitId: 'lockForSolana',
        args: [
          { nonce: new Uint8Array(randomBytes(32)), color: hexToBytes(colourY(), 32), value: amount },
          solanaRecipient,
        ],
        coinPublicKey: keys.coinPublicKey,
        initialContractState: contractState,
        initialZswapChainState: zswapChainState,
        ledgerParameters,
      },
      keys.encryptionPublicKey,
    );
    res.buildMs = Date.now() - t0;
    const next = bridge.ledger(call.public.nextContractState);
    const entry = next.withdrawals.lookup(predictedId);
    res.draftCheck = {
      result: String(call.private.result),
      predictedId: predictedId.toString(),
      entry: { solanaRecipient: bytesToHex(entry.solanaRecipient), amount: String(entry.amount) },
      destinationIsWallet: bytesToHex(entry.solanaRecipient) === bytesToHex(solanaRecipient),
      amountMatches: BigInt(entry.amount) === amount,
    };
    if (
      !res.draftCheck.destinationIsWallet ||
      !res.draftCheck.amountMatches ||
      BigInt(call.private.result) !== predictedId
    ) {
      throw new Error(`the draft is not this lock: ${json(res.draftCheck)}`);
    }
    const unproven = call.private.unprovenTx;
    const t1 = Date.now();
    let merged: Any;
    if (comp) {
      const b = balanceWithLandingCoin(unproven, comp.state, keys, opts.coin!, PROFILE.midnightNetworkId);
      merged = b.tx;
      res.computed.segment = b.segment;
      res.computed.spentMtIndex = b.mtIndex.toString();
    } else {
      const balancing = await landing!.wallet.balanceTransaction(keys.shieldedSecretKeys, unproven);
      if (!balancing) throw new Error('keys_t balanced nothing: the coin was not spent');
      merged = unproven.merge(balancing);
    }
    res.balanceMs = Date.now() - t1;
    res.shape = shapeOf(merged);
    if (
      res.shape.calls.length !== 1 ||
      res.shape.calls[0] !== `${contract}:lockForSolana` ||
      res.shape.dustSpends !== 0 ||
      res.shape.unshielded
    ) {
      throw new Error(`unexpected tx2 shape: ${json(res.shape)}`);
    }
    const t2 = Date.now();
    const unbound: Any = await (rt.proofProvider as Any).proveTx(merged, { timeout: 900_000 });
    let finalized: Any = unbound.bind();
    res.proveMs = Date.now() - t2;
    if (opts.tamperRecipient) {
      // L.9 (c): change the Solana recipient (disclosed in the call's transcript) after proving.
      const ledger: Any = await import('@midnightntwrk/ledger-v9');
      const bytes: Uint8Array = finalized.serialize();
      const at = indexOf(bytes, solanaRecipient);
      res.tamper = { recipientFoundAt: at };
      if (at < 0) throw new Error('the recipient bytes are not in the proven transaction');
      const copy = Uint8Array.from(bytes);
      copy[at] = copy[at]! ^ 1;
      finalized = ledger.Transaction.deserialize('signature', 'proof', 'binding', copy);
    }
    const dustBefore = await dustOf(sponsor.handle as SponsorWalletHandle);
    const t3 = Date.now();
    let submitted: { txId: string; balanceMs: number } | null = null;
    try {
      submitted = await addDustAndSubmit(sponsor.handle as SponsorWalletHandle, finalized);
    } catch (e) {
      res.submitError = errorChain(e).slice(0, 2000);
    }
    res.sponsorBalanceMs = submitted?.balanceMs ?? null;
    res.tx2 = submitted?.txId ?? null;
    const landed = submitted ? await indexerTx(submitted.txId) : null;
    res.inclusionMs = Date.now() - t3;
    res.tx2Hash = landed?.hash ?? null;
    res.tx2Block = landed?.block?.height ?? null;
    res.tx2Fees = landed?.fees ?? null;
    res.tx2Status = landed?.transactionResult?.status ?? null;
    // L.7: the bridge's withdrawals map, from the indexer.
    const after = await pdp.queryContractState(contract);
    const l2 = bridge.ledger(after.data);
    const recorded = l2.withdrawals.member(predictedId) ? l2.withdrawals.lookup(predictedId) : null;
    res.bridge = {
      withdrawalNonceBefore: predictedId.toString(),
      withdrawalNonceAfter: String(l2.withdrawalNonce),
      recorded: recorded
        ? { solanaRecipient: bytesToHex(recorded.solanaRecipient), amount: String(recorded.amount) }
        : null,
      recordedIsWallet: recorded ? bytesToHex(recorded.solanaRecipient) === bytesToHex(solanaRecipient) : false,
    };
    // keys_t after: no Y left (the landing coin spent), and never any DUST or NIGHT.
    await new Promise((r) => setTimeout(r, 6_000));
    let yAfter: bigint;
    if (landing) {
      res.landingBalancesAfter = Object.fromEntries(
        Object.entries(await landing.balances()).map(([k, v]) => [k.slice(0, 12), v.toString()]),
      );
      yAfter = BigInt(Object.entries(await landing.balances()).find(([k]) => k === colourY())?.[1] ?? 0n);
    } else {
      // The computed path again: the coin's nullifier is now in the chain's events, so it is gone.
      const again = await computedLanding(keys, opts.coin!);
      res.computedAfter = { events: again.events, holdsCoin: again.holds };
      yAfter = again.holds ? amount : 0n;
    }
    res.landingHoldsDustOrNight = false; // keys_t never derives a NIGHT key; its Dust key is never registered
    const dustAfter = await dustOf(sponsor.handle as SponsorWalletHandle);
    res.sponsorDust = { before: dustBefore?.toString() ?? null, after: dustAfter?.toString() ?? null };
    res.landingYAfter = yAfter.toString();
    if (opts.tamperRecipient) {
      // L.9 (c): the node must refuse it, and nothing may change on the bridge.
      res.verdict =
        (res.submitError || res.tx2Status !== 'SUCCESS') &&
        res.bridge.withdrawalNonceAfter === res.bridge.withdrawalNonceBefore
          ? 'REFUSED (nothing recorded)'
          : 'ACCEPTED (a failure)';
      record(label, res);
      if (res.verdict !== 'REFUSED (nothing recorded)') throw new Error(`L.9 (c) failed: ${json(res.bridge)}`);
      return res;
    }
    // L.7: the withdrawal recorded under the predicted id, to the wallet, for the amount; the coin spent.
    res.verdict =
      res.tx2Status === 'SUCCESS' &&
      res.bridge.recordedIsWallet &&
      res.bridge.recorded?.amount === amount.toString() &&
      BigInt(res.bridge.withdrawalNonceAfter) === predictedId + 1n &&
      yAfter + amount <= BigInt(res.landingBalanceY)
        ? 'PASS'
        : 'FAIL';
    record(label, res);
    if (res.verdict !== 'PASS')
      throw new Error(
        `tx2 did not land as expected: ${json({ status: res.tx2Status, bridge: res.bridge, submitError: res.submitError, yAfter: res.landingYAfter })}`,
      );
    return res;
  } finally {
    keys.clear();
    await landing?.stop().catch(() => undefined);
    await sponsor.stop().catch(() => undefined);
  }
}

function indexOf(hay: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

/**
 * The plan's "Finding a landing coin without storage" (L.8): from the page's own decode of A's history
 * (its spent coins and the transactions that spent them) and each such transaction's Zswap events, the
 * paid-out coin of every withdrawal, and keys_t(A, n) for every n below A's auth nonce; a commitment
 * among the transaction's outputs that keys_t owns is a landing coin. Nothing stored is read.
 */
async function findLandingCoins(master: LandingMaster) {
  const pg = pageA();
  const sync = await syncAccount(pg, account());
  pg.flush();
  const nonceNow = BigInt(sync.state.authNonce);
  const spent = sync.coins.filter((c: Any) => c.spent && c.color === colourY());
  const found: Any[] = [];
  const t0 = Date.now();
  // The transactions that spent one of A's Y coins, from the page's decoded history.
  for (const tx of sync.history.txs as Any[]) {
    if (!tx.entryPoints.some((e: string) => /withdraw_shielded/.test(e))) continue;
    const coin = spent.find((c: Any) => c.spentTx && norm(c.spentTx) === norm(tx.hash));
    if (!coin) continue;
    const change = sync.coins.find(
      (c: Any) =>
        c.color === coin.color &&
        ((c.createdTx && norm(c.createdTx) === norm(tx.hash)) ||
          tx.outputs.some((o: Any) => o.commitment === c.commitment)),
    );
    const amount = BigInt(coin.value) - (change ? BigInt(change.value) : 0n);
    const full = await indexerTx(tx.hash);
    const outputs = (full?.zswapLedgerEvents ?? [])
      .map((e: Any) => decodeEvent(e.raw))
      .filter((e: Any) => e.kind === 'output');
    for (let n = 0n; n < nonceNow; n++) {
      const t = landingOf(master, n, coin, amount);
      const hit = outputs.find((o: Any) => o.commitment === t.commitment);
      if (hit)
        found.push({
          authNonce: n,
          amount,
          txHash: tx.hash,
          mtIndex: String(hit.mtIndex),
          coinPublicKey: t.keys.coinPublicKey,
        });
      t.keys.clear();
    }
  }
  return { found, scanMs: Date.now() - t0, authNonceNow: nonceNow.toString(), withdrawalsScanned: spent.length };
}

async function resumeLock() {
  step('resume-lock (L.8): a NEW process, an empty store for the landing key: re-derive, find, finish the lock');
  const { master } = await landingMaster();
  const search = await findLandingCoins(master);
  master.wipe();
  // Open transfers: found coins keys_t still holds (the lock or return spent the others).
  const open: Any[] = [];
  for (const f of search.found) {
    const { master: m2 } = await landingMaster();
    const keys = landingKeyFor(m2, account(), f.authNonce);
    m2.wipe();
    const w = await openLanding(keys);
    const bal = (await w.balances())[colourY()] ?? 0n;
    await w.stop().catch(() => undefined);
    keys.clear();
    if (bal >= f.amount) open.push(f);
  }
  record('resumeSearch', {
    ...search,
    found: search.found.map((f) => ({ ...f, authNonce: f.authNonce.toString(), amount: f.amount.toString() })),
    open: open.length,
  });
  if (open.length === 0) throw new Error('no open landing coin found without storage');
  const f = open[0];
  return tx2(f.authNonce, f.amount, 'resumeLock');
}

async function resumeReturn() {
  step('resume-return (L.8): re-derive, find the open coin, return it to A (deposit_shielded, sealed to A)');
  const { master } = await landingMaster();
  const search = await findLandingCoins(master);
  master.wipe();
  let target: Any = null;
  for (const f of search.found) {
    const { master: m2 } = await landingMaster();
    const keys = landingKeyFor(m2, account(), f.authNonce);
    m2.wipe();
    const w = await openLanding(keys);
    const bal = (await w.balances())[colourY()] ?? 0n;
    await w.stop().catch(() => undefined);
    keys.clear();
    if (bal >= f.amount) target = f;
  }
  if (!target) throw new Error('no open landing coin to return');
  const { master: m3 } = await landingMaster();
  const keys = landingKeyFor(m3, account(), target.authNonce);
  m3.wipe();
  const rt = await runtime();
  const landing = await openLanding(keys);
  const sponsor = await openWallet(need('SPONSOR_SEED_FILE'));
  const res: Record<string, Any> = { authNonce: target.authNonce.toString(), amount: target.amount.toString() };
  try {
    const before = await pageY();
    const l = await rt.ledgerState(account());
    if (!l) throw new Error('A is not on chain');
    const coin = { nonce: new Uint8Array(randomBytes(32)), color: hexToBytes(colourY(), 32), value: target.amount };
    const entry = await sealEntryPortable(Uint8Array.from(l.enc_key), coin);
    const pdp: Any = rt.publicDataProvider;
    const block = await pdp.queryBlock();
    const states = await pdp.queryZSwapAndContractState(account(), { type: 'blockHash', blockHash: block.hash });
    const [zswapChainState, contractState, ledgerParameters] = states;
    const { createUnprovenCallTxFromInitialStates } = (await import('@midnight-ntwrk/midnight-js-contracts')) as Any;
    const call: Any = await createUnprovenCallTxFromInitialStates(
      NO_KEY_MATERIAL,
      {
        compiledContract: rt.compiledAccount(),
        contractAddress: account(),
        circuitId: 'deposit_shielded',
        args: [coin, entry],
        coinPublicKey: keys.coinPublicKey,
        initialContractState: contractState,
        initialZswapChainState: zswapChainState,
        ledgerParameters,
      },
      keys.encryptionPublicKey,
    );
    const unproven = call.private.unprovenTx;
    const balancing = await landing.wallet.balanceTransaction(keys.shieldedSecretKeys, unproven);
    const merged = unproven.merge(balancing);
    res.shape = shapeOf(merged);
    const t0 = Date.now();
    const finalized = (await (rt.proofProvider as Any).proveTx(merged, { timeout: 900_000 })).bind();
    res.proveMs = Date.now() - t0;
    const submitted = await addDustAndSubmit(sponsor.handle as SponsorWalletHandle, finalized);
    res.tx = submitted.txId;
    const landed = await indexerTx(submitted.txId);
    res.txHash = landed?.hash ?? null;
    res.txStatus = landed?.transactionResult?.status ?? null;
    const after = await pageY((v) => v >= before.total + target.amount);
    res.pageY = { before: before.total.toString(), after: after.total.toString() };
    res.returned = after.total === before.total + target.amount;
    record('resumeReturn', res);
    if (!res.returned) throw new Error(`the page does not see the returned coin: ${json(res.pageY)}`);
    return res;
  } finally {
    keys.clear();
    await landing.stop().catch(() => undefined);
    await sponsor.stop().catch(() => undefined);
  }
}

/**
 * P6.0 (Q5 A) (ii): return the coin of the transfer recorded as TX1_LABEL to A (`deposit_shielded`, the
 * entry sealed to A's on-chain key), balanced by keys_t through the COMPUTED coin (or the SDK wallet
 * without COMPUTED=1), DUST by the sponsor; the page must see the coin.
 */
async function returnCoin(label: string) {
  const t = gate.tx1?.[label];
  if (!t) throw new Error(`no ${label} recorded`);
  const amount = BigInt(t.amount);
  const path = COMPUTED ? 'the COMPUTED coin (P6.0)' : 'the SDK wallet';
  step(`return ${label}: deposit_shielded into A (sealed to A), balanced by keys_t via ${path}`);
  const { master } = await landingMaster();
  const keys = landingKeyFor(master, account(), BigInt(t.authNonce));
  master.wipe();
  const rt = await runtime();
  const coin = COMPUTED ? coinOf(label) : null;
  const landing = COMPUTED ? null : await openLanding(keys);
  const sponsor = await openWallet(need('SPONSOR_SEED_FILE'));
  const res: Record<string, Any> = { tx1: label, authNonce: String(t.authNonce), amount: amount.toString(), path };
  try {
    let comp: Awaited<ReturnType<typeof computedLanding>> | null = null;
    if (coin) {
      comp = await computedLanding(keys, coin);
      res.computed = {
        events: comp.events,
        readMs: comp.readMs,
        replayMs: comp.replayMs,
        holds: comp.holds,
        mtIndex: comp.mtIndex,
      };
      if (!comp.holds) throw new Error('the computed path does not find the landing coin');
    } else {
      const bal = await landing!.waitFor(colourY(), amount, 60_000);
      res.sdkBalance = bal.toString();
      if (bal < amount) throw new Error(`the SDK wallet holds ${bal} Y, not ${amount}`);
    }
    const before = await pageY();
    const l = await rt.ledgerState(account());
    if (!l) throw new Error('A is not on chain');
    const deposit = { nonce: new Uint8Array(randomBytes(32)), color: hexToBytes(colourY(), 32), value: amount };
    const entry = await sealEntryPortable(Uint8Array.from(l.enc_key), deposit);
    const pdp: Any = rt.publicDataProvider;
    const block = await pdp.queryBlock();
    const states = await pdp.queryZSwapAndContractState(account(), { type: 'blockHash', blockHash: block.hash });
    const [zswapChainState, contractState, ledgerParameters] = states;
    const { createUnprovenCallTxFromInitialStates } = (await import('@midnight-ntwrk/midnight-js-contracts')) as Any;
    const call: Any = await createUnprovenCallTxFromInitialStates(
      NO_KEY_MATERIAL,
      {
        compiledContract: rt.compiledAccount(),
        contractAddress: account(),
        circuitId: 'deposit_shielded',
        args: [deposit, entry],
        coinPublicKey: keys.coinPublicKey,
        initialContractState: contractState,
        initialZswapChainState: zswapChainState,
        ledgerParameters,
      },
      keys.encryptionPublicKey,
    );
    const unproven = call.private.unprovenTx;
    let merged: Any;
    if (comp) {
      const b = balanceWithLandingCoin(unproven, comp.state, keys, coin!, PROFILE.midnightNetworkId);
      merged = b.tx;
      res.computed.segment = b.segment;
    } else {
      merged = unproven.merge(await landing!.wallet.balanceTransaction(keys.shieldedSecretKeys, unproven));
    }
    res.shape = shapeOf(merged);
    const t0 = Date.now();
    const finalized = (await (rt.proofProvider as Any).proveTx(merged, { timeout: 900_000 })).bind();
    res.proveMs = Date.now() - t0;
    const submitted = await addDustAndSubmit(sponsor.handle as SponsorWalletHandle, finalized);
    res.tx = submitted.txId;
    const landed = await indexerTx(submitted.txId);
    res.txHash = landed?.hash ?? null;
    res.txStatus = landed?.transactionResult?.status ?? null;
    const after = await pageY((v) => v >= before.total + amount);
    res.pageY = { before: before.total.toString(), after: after.total.toString() };
    res.returned = after.total === before.total + amount;
    if (coin) {
      const again = await computedLanding(keys, coin);
      res.computedAfter = { holdsCoin: again.holds };
    }
    res.verdict = res.txStatus === 'SUCCESS' && res.returned && !res.computedAfter?.holdsCoin ? 'PASS' : 'FAIL';
    record(`return:${label}`, res);
    if (res.verdict !== 'PASS') throw new Error(`the return did not land as expected: ${json(res)}`);
    return res;
  } finally {
    keys.clear();
    await landing?.stop().catch(() => undefined);
    await sponsor.stop().catch(() => undefined);
  }
}

/** L.9 (a): tx1's payload with another recipient and the original approval → 401, nothing lands. */
async function negRelay() {
  step('neg-relay (L.9 a): another recipient with the original approval, at the live relay');
  const pg = pageA();
  // AA 00057: NEG_SYMBOL picks the journey token the approval spends (default Y, as in P3/P9).
  const negColour = process.env.NEG_SYMBOL ? norm(gate.journey![process.env.NEG_SYMBOL]!.colour) : colourY();
  await pageY((v) => v > 0n, 60, negColour);
  const st = await pg.chain.accountState(account());
  const coins = readCoins(pg.store, pg.scope, account());
  const coin = chooseCoin(coins, negColour, 1n * UNIT);
  const { master } = await landingMaster();
  const t = landingOf(master, BigInt(st!.authNonce), coin, 1n * UNIT);
  master.wipe();
  const payload = {
    recipient: t.keys.coinPublicKey,
    recipientEncryptionKey: t.keys.encryptionPublicKey,
    color: coin.color,
    amount: (1n * UNIT).toString(),
    coin: { nonce: coin.nonce, color: coin.color, value: coin.value, mtIndex: coin.mtIndex! },
    authNonce: st!.authNonce,
  };
  t.keys.clear();
  const device = ed25519DeviceOf(signerA, { network: NETWORK, tokens });
  const s = st!;
  const counter = findUseCounter(s.devices, (k) =>
    bytesToHex(device.entryAt(hexToBytes(s.account, 32), BigInt(s.deviceEpoch), k)),
  );
  const ctx = callContext({
    account: s.account,
    authNonce: BigInt(s.authNonce),
    networkSalt: s.networkSalt,
    encKey: s.encKey,
  });
  const good = passportAuthOf(await device.sign(ctx, withdrawRequest(payload), counter!));
  const attacker = bytesToHex(new Uint8Array(randomBytes(32)));
  const res = await fetch(`${RELAY}/v1/actions/withdraw`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ account: account(), payload: { ...payload, recipient: attacker }, passportAuth: good }),
  });
  const body = (await res.json().catch(() => ({}))) as Any;
  const st2 = await pg.chain.accountState(account());
  const r = {
    status: res.status,
    code: body.error?.code ?? null,
    detail: body.error?.detail ?? null,
    authNonceBefore: s.authNonce,
    authNonceAfter: st2?.authNonce ?? null,
  };
  record('negRelay', r);
  if (res.status !== 401) throw new Error(`the tampered recipient was not refused with 401: ${json(r)}`);
  return r;
}

/** L.9 (b): the same tampered recipient straight to the circuit (relay stopped; c2-live.ts pattern). */
async function negCircuit() {
  step('neg-circuit (L.9 b): another recipient with the original signature, straight to the circuit');
  const rt = await runtime();
  const sponsor = await openWallet(need('SPONSOR_SEED_FILE'));
  try {
    const pg = pageA();
    await pageY((v) => v > 0n);
    const coins = readCoins(pg.store, pg.scope, account());
    const c = chooseCoin(coins, colourY(), 1n * UNIT);
    const l = await rt.ledgerState(account());
    if (!l) throw new Error('A is not on chain');
    const device = ed25519DeviceOf(signerA, { network: NETWORK, tokens });
    const accountBytes = hexToBytes(account(), 32);
    const counter = findUseCounter(
      [...l.devices].map((d) => bytesToHex(d)),
      (k) => bytesToHex(device.entryAt(accountBytes, l.device_epoch, k)),
    );
    const ctx = callContext({
      account: account(),
      authNonce: l.auth_nonce,
      networkSalt: bytesToHex(l.evm_domain_salt),
      encKey: bytesToHex(l.enc_key),
    });
    const { master } = await landingMaster();
    const t = landingOf(master, l.auth_nonce, c, 1n * UNIT);
    master.wipe();
    const honest = hexToBytes(t.keys.coinPublicKey, 32);
    t.keys.clear();
    const coin = {
      nonce: hexToBytes(c.nonce, 32),
      color: hexToBytes(c.color, 32),
      value: BigInt(c.value),
      mt_index: BigInt(c.mtIndex!),
    };
    const color = hexToBytes(c.color, 32);
    const amount = 1n * UNIT;
    const auth: Any = await device.sign(
      ctx,
      { op: 'withdrawShielded', recipient: honest, color, amount, coin },
      counter!,
    );
    const attacker = new Uint8Array(randomBytes(32));
    const providers = await rt.providers(sponsor.handle as SponsorWalletHandle);
    const custody: Any = await rt.client.account.CustodyAccount.connect(providers, rt.compiledAccount(), account(), {
      ...rt.client.witnesses.emptyCoinStore(),
      coins: { [c.color]: { nonceHex: c.nonce, colorHex: c.color, value: c.value, mtIndex: c.mtIndex } },
    });
    const r: Record<string, Any> = { authNonceBefore: l.auth_nonce.toString() };
    try {
      const out: Any = await custody.handle.callTx['withdraw_shielded_with_ed25519'](
        { bytes: attacker },
        color,
        amount,
        decodeEd25519Point(kpA.publicKey),
        counter,
        auth.sig,
        auth.show,
      );
      r.outcome = 'ACCEPTED (a failure)';
      r.txId = out?.public?.txId ?? null;
    } catch (e) {
      const msg = errorChain(e);
      r.outcome = /invalid signature/.test(msg) ? 'REFUSED by the circuit: invalid signature' : 'REFUSED (other)';
      r.error = msg.slice(0, 1500);
    }
    const l2 = await rt.ledgerState(account());
    r.authNonceAfter = l2?.auth_nonce.toString() ?? null;
    record('negCircuit', r);
    if (r.outcome !== 'REFUSED by the circuit: invalid signature') throw new Error(`L.9 (b) failed: ${r.outcome}`);
    return r;
  } finally {
    await sponsor.stop().catch(() => undefined);
  }
}

// ── P6 (T6.5, T6.4): the page's own Bridge out through the real relay ─────────────────────────

/** Y's journey-registry entry (I-1), as the site and the relay both read it. */
function entryY(): Any {
  if (gate.journey?.Y) return gate.journey.Y;
  const b = gate.bridge!;
  return {
    colour: b.colour,
    splMint: base58.encode(hexToBytes(b.sourceMint, 32)),
    bridgeContract: b.contract,
    bridgeProgram: base58.encode(new Uint8Array(32).fill(9)),
    bridgeApi: 'http://bridge.invalid',
    name: 'Bridged Y',
    symbol: 'Y',
    decimals: 6,
  };
}

/** The page's Bridge-out context (A's page, A's test key as the wallet). */
function outCtx(page: HeadlessPage, signing?: Any): BridgeOutContext {
  return {
    env: signing ? { ...page, signing } : page,
    network: NETWORK,
    networkId: PROFILE.midnightNetworkId,
    indexerUrl: INDEXER_URL,
    indexerWsUrl: INDEXER_WS_URL,
    origin: ORIGIN,
    solanaGenesisHash: GENESIS,
    wallet: signerA.address,
    deviceKey: signerA.deviceKey,
    ...(SOLANA_RPC_URL ? { rpc: new SolanaRpc(SOLANA_RPC_URL) } : {}),
    onProgress: (t) => say(`page: ${t}`),
  };
}

/** The bridge's withdrawals as the chain has them now. */
async function bridgeWithdrawals(): Promise<{ nonce: bigint; get(id: bigint): Any }> {
  const rt = await runtime();
  const bridge = await bridgeRuntime();
  const st: Any = await (rt.publicDataProvider as Any).queryContractState(gate.bridge!.contract);
  const l = bridge.ledger(st.data);
  return {
    nonce: BigInt(l.withdrawalNonce),
    get: (id: bigint) => (l.withdrawals.member(id) ? l.withdrawals.lookup(id) : null),
  };
}

/** Whether keys_t of `r` still holds its landing coin (the computed path). */
async function landingHolds(r: BridgeOutRecord): Promise<boolean> {
  const { master } = await landingMaster();
  const keys = landingKeyFor(master, account(), BigInt(r.authNonce));
  master.wipe();
  try {
    const c = await computedLanding(keys, { nonce: r.landingNonce, color: r.colour, value: BigInt(r.amount) });
    return c.holds;
  } finally {
    keys.clear();
  }
}

/** Capture every request the page makes (fetch bodies and URLs, WebSocket frames): T6.4. */
function captureRequests(): { requests: { url: string; body: string }[]; stop(): void } {
  const requests: { url: string; body: string }[] = [];
  const g = globalThis as Any;
  const origFetch = g.fetch;
  g.fetch = async (input: Any, init?: Any) => {
    const url = String(input instanceof Request ? input.url : input);
    let body = '';
    if (init?.body !== undefined)
      body = typeof init.body === 'string' ? init.body : Buffer.from(init.body).toString('hex');
    else if (input instanceof Request)
      body = await input
        .clone()
        .text()
        .catch(() => '');
    requests.push({ url, body });
    return origFetch(input, init);
  };
  const WS = g.WebSocket;
  const origSend = WS?.prototype?.send;
  if (origSend) {
    WS.prototype.send = function (data: Any) {
      requests.push({
        url: String(this.url ?? 'ws'),
        body: typeof data === 'string' ? data : Buffer.from(data).toString('hex'),
      });
      return origSend.call(this, data);
    };
  }
  return {
    requests,
    stop() {
      g.fetch = origFetch;
      if (origSend) WS.prototype.send = origSend;
    },
  };
}

async function outCase(c: string) {
  const pg = pageA();
  const ctx = outCtx(pg);
  const res: Record<string, Any> = { case: c };
  const start = async (amount: bigint, label: string) => {
    await pageY((v) => v >= amount);
    const coin = chooseCoin(readCoins(pg.store, pg.scope, account()), colourY(), amount);
    const t0 = Date.now();
    const m = await landingMasterFor(ctx, account());
    const r = await startBridgeOut(ctx, m, { account: account(), entry: entryY(), amount, coin });
    pg.flush();
    res[label] = {
      authNonce: r.authNonce,
      state: r.state,
      entitlement: !!r.entitlement,
      tx1Id: r.tx1Id,
      seconds: (Date.now() - t0) / 1000,
      // P9.6: what the sponsor paid for tx1 (the indexer's record).
      fees: r.tx1Id ? ((await indexerTx(r.tx1Id))?.fees ?? null) : null,
    };
    return { r, m };
  };
  const lock = async (r: BridgeOutRecord, m: LandingMaster, label: string) => {
    const before = await bridgeWithdrawals();
    const t0 = Date.now();
    const done = await finishLock(ctx, m, account(), r);
    pg.flush();
    const after = await bridgeWithdrawals();
    const id = BigInt(done.withdrawalId!);
    const w = after.get(id);
    const holds = await landingHolds(done);
    res[label] = {
      state: done.state,
      withdrawalId: done.withdrawalId,
      tx2Id: done.tx2Id,
      seconds: (Date.now() - t0) / 1000,
      recorded: w
        ? { solanaRecipient: bytesToHex(Uint8Array.from(w.solanaRecipient)), amount: String(w.amount) }
        : null,
      nonceBefore: before.nonce.toString(),
      nonceAfter: after.nonce.toString(),
      landingStillHolds: holds,
      // P9.6: the DUST the sponsor paid for the lock (the indexer's record of tx2).
      fees: done.tx2Id ? ((await indexerTx(done.tx2Id))?.fees ?? null) : null,
    };
    const ok =
      done.state === 'locked' &&
      w &&
      bytesToHex(Uint8Array.from(w.solanaRecipient)) === signerA.deviceKey &&
      BigInt(w.amount) === BigInt(r.amount) &&
      !holds;
    if (!ok) throw new Error(`${label}: the lock is not as expected: ${json(res[label])}`);
    return done;
  };
  switch (c) {
    case 'a': {
      // P9: with the real bridge, the release arrives in the wallet's token account on Solana.
      const ataBefore = SOLANA_RPC_URL ? await walletTokenBalance(entryY()) : null;
      const cap = captureRequests();
      let r: BridgeOutRecord;
      let m: LandingMaster;
      try {
        ({ r, m } = await start(50n * UNIT, 'tx1'));
        await lock(r, m, 'lock');
      } finally {
        cap.stop();
      }
      // T6.4 (SC-005): no landing secret in any request, nor in the page's store.
      const message = (await import('@nightmarket/core/bridge')).landingMessage({
        origin: ORIGIN,
        midnightNetwork: PROFILE.midnightNetworkId,
        solanaGenesisHash: GENESIS,
        walletAddress: signerA.address,
      });
      const sig = nacl.sign.detached(message, kpA.secretKey);
      const core = await import('@nightmarket/core/bridge');
      const masterKey = core.landingMasterFromSignature(sig);
      const seed = core.landingSeed(masterKey, account(), BigInt(r!.authNonce));
      const forms = (b: Uint8Array) => [
        bytesToHex(b),
        Buffer.from(b).toString('base64'),
        Buffer.from(b).toString('base64url'),
      ];
      const secrets: Record<string, string[]> = { sig1: forms(sig), master: forms(masterKey), seed_t: forms(seed) };
      const store = readFileSync(join(STATE_DIR, 'page-A.json'), 'utf8');
      const leaks: string[] = [];
      for (const [name, fs] of Object.entries(secrets)) {
        for (const f of fs) {
          for (const q of cap.requests) if (q.url.includes(f) || q.body.includes(f)) leaks.push(`${name} in ${q.url}`);
          if (store.includes(f)) leaks.push(`${name} in the page's store`);
        }
      }
      res.t64 = {
        requests: cap.requests.length,
        hosts: [...new Set(cap.requests.map((q) => q.url.replace(/^(\w+:\/\/[^/]+).*$/, '$1')))],
        bridgeOutRequests: cap.requests.filter((q) => q.url.endsWith('/v1/actions/bridge-out')).length,
        leaks,
      };
      record('out:a', res);
      if (leaks.length > 0) throw new Error(`T6.4: a landing secret left the tab: ${leaks.join('; ')}`);
      void m!;
      if (ataBefore !== null) {
        // The page follows the transfer: the bridge's I-3 progress, then the release receipt on Solana.
        const t0 = Date.now();
        let rec = readBridgeOuts(pg.store, pg.scope, account()).find((x) => x.authNonce === r!.authNonce)!;
        const progress: string[] = [];
        while (rec.state !== 'arrived' && Date.now() - t0 < 900_000) {
          rec = await followBridgeOut(ctx, rec);
          putBridgeOut(pg.store, pg.scope, account(), rec);
          pg.flush();
          if (rec.progress && progress[progress.length - 1] !== rec.progress) progress.push(rec.progress);
          if (rec.state !== 'arrived') await new Promise((ok) => setTimeout(ok, 5_000));
        }
        const ataAfter = await walletTokenBalance(entryY());
        res.arrival = {
          state: rec.state,
          seconds: (Date.now() - t0) / 1000,
          progress,
          walletTokenAccount: { before: ataBefore, after: ataAfter },
        };
        record('out:a', res);
        if (rec.state !== 'arrived' || ataAfter - ataBefore !== 50n * UNIT)
          throw new Error(`a: the release did not arrive as expected: ${json(res.arrival)}`);
      }
      return res;
    }
    case 'b-start':
    case 'c-start':
    case 'd-start': {
      const amount = { 'b-start': 30n, 'c-start': 20n, 'd-start': 15n }[c]! * UNIT;
      await start(amount, 'tx1');
      return record(`out:${c}`, res);
    }
    case 'b': {
      // A NEW process: the record from the page's store, the master derived again (2 prompts).
      const open = readBridgeOuts(pg.store, pg.scope, account()).find(
        (x) => x.amount === String(30n * UNIT) && x.state === 'tx1-sent',
      );
      if (!open) throw new Error('no stored transfer of 30 Y to finish');
      const m = await landingMasterFor(ctx, account());
      await lock(open, m, 'lock');
      return record('out:b', res);
    }
    case 'c': {
      const open = readBridgeOuts(pg.store, pg.scope, account()).find(
        (x) => x.amount === String(20n * UNIT) && x.state === 'tx1-sent',
      );
      if (!open) throw new Error('no stored transfer of 20 Y to return');
      const before = await pageY();
      const m = await landingMasterFor(ctx, account());
      const done = await returnToAccount(ctx, m, account(), open);
      pg.flush();
      const after = await pageY((v) => v >= before.total + BigInt(open.amount));
      res.return = {
        state: done.state,
        tx2Id: done.tx2Id,
        pageY: { before: before.total.toString(), after: after.total.toString() },
      };
      record('out:c', res);
      if (after.total !== before.total + BigInt(open.amount))
        throw new Error(`the page does not see the returned coin: ${json(res.return)}`);
      return res;
    }
    case 'd': {
      // An EMPTY store for the same wallet and account (the records a browser that opened A holds, but no
      // bridge-out record): find the transfer from the chain alone, re-entitle, lock.
      const fresh = headlessPage({
        network: NETWORK,
        relayUrl: RELAY,
        chain: new ChainReader({ indexerUrl: INDEXER_URL, networkId: PROFILE.midnightNetworkId }),
        signer: signerA,
        tokens,
        storePath: join(STATE_DIR, `page-A-empty-${Date.now()}.json`),
        account: {
          address: account(),
          encSecret: flows.A.encSecret,
          encPublic: flows.A.encPublic,
          ...(flows.A.txs ? { txs: flows.A.txs } : {}),
        },
      });
      const fctx = outCtx(fresh);
      if (readBridgeOuts(fresh.store, fresh.scope, account()).length !== 0)
        throw new Error('the fresh store is not empty');
      const m = await landingMasterFor(fctx, account());
      const t0 = Date.now();
      const found = await findTransfers(fctx, m, account());
      res.found = found.map((f) => ({ authNonce: f.authNonce, amount: f.amount.toString(), open: f.open }));
      res.findSeconds = (Date.now() - t0) / 1000;
      const target = found.find((f) => f.open && f.amount === 15n * UNIT);
      if (!target) throw new Error(`the 15 Y transfer was not found open: ${json(res.found)}`);
      const r = await adoptTransfer(fctx, m, account(), target, entryY());
      res.adopted = { state: r.state, entitlement: !!r.entitlement };
      const before = await bridgeWithdrawals();
      const done = await finishLock(fctx, m, account(), r);
      const after = await bridgeWithdrawals();
      const w = after.get(BigInt(done.withdrawalId!));
      res.lock = {
        state: done.state,
        nonceBefore: before.nonce.toString(),
        nonceAfter: after.nonce.toString(),
        recorded: w
          ? { solanaRecipient: bytesToHex(Uint8Array.from(w.solanaRecipient)), amount: String(w.amount) }
          : null,
      };
      record('out:d', res);
      if (!w || BigInt(w.amount) !== 15n * UNIT || bytesToHex(Uint8Array.from(w.solanaRecipient)) !== signerA.deviceKey)
        throw new Error(`d: the lock is not as expected: ${json(res.lock)}`);
      return res;
    }
    case 'e': {
      // The relay runs with WITHDRAWS_DAILY_CAP=1 and was restarted (its counts are in memory): A holds
      // a 5 Y and a 3 Y coin. 1 Y of the 5 Y coin is the day's one withdrawal; 1 Y of the 3 Y coin is
      // refused (429); the whole 3 Y coin is admitted as the exit and locked.
      const coins = readCoins(pg.store, pg.scope, account());
      const five = coins.find((x) => x.color === colourY() && !x.spent && x.value === String(5n * UNIT));
      const three = coins.find((x) => x.color === colourY() && !x.spent && x.value === String(3n * UNIT));
      if (!five || !three) throw new Error('A does not hold the 5 Y and 3 Y coins');
      const m = await landingMasterFor(ctx, account());
      const first = await startBridgeOut(ctx, m, {
        account: account(),
        entry: entryY(),
        amount: 1n * UNIT,
        coin: five as Any,
      });
      pg.flush();
      res.first = { state: first.state };
      let refused: Any = null;
      try {
        await startBridgeOut(ctx, m, { account: account(), entry: entryY(), amount: 1n * UNIT, coin: three as Any });
      } catch (e) {
        refused = {
          name: (e as Error).name,
          code: (e as Any).code ?? null,
          status: (e as Any).status ?? null,
          message: (e as Error).message.slice(0, 300),
        };
      }
      pg.flush();
      res.partial = refused;
      if (!refused || refused.code !== 'withdraws-daily-cap')
        throw new Error(`e: the partial bridge-out past the cap was not refused: ${json(refused)}`);
      const exit = await startBridgeOut(ctx, m, {
        account: account(),
        entry: entryY(),
        amount: 3n * UNIT,
        coin: three as Any,
      });
      pg.flush();
      res.exit = { state: exit.state };
      await lock(exit, m, 'exitLock');
      return record('out:e', res);
    }
    case 'f': {
      // A hedged signer (valid signatures that differ each time): refused at the landing key, before tx1.
      let asked = 0;
      const { ed25519 } = await import('@noble/curves/ed25519.js');
      const hedged = {
        deviceKey: signerA.deviceKey,
        address: signerA.address,
        signMessage: async (msg: Uint8Array) => {
          asked += 1;
          const L = ed25519.Point.Fn.ORDER;
          const le = (b: Uint8Array) => b.reduceRight((v, x) => (v << 8n) | BigInt(x), 0n);
          const toLe = (v: bigint) =>
            Uint8Array.from({ length: 32 }, (_, i) => Number((v >> (8n * BigInt(i))) & 0xffn));
          const { scalar } = ed25519.utils.getExtendedPublicKey(kpA.secretKey.slice(0, 32));
          const rr = le(new Uint8Array(randomBytes(64))) % L;
          const R = ed25519.Point.BASE.multiply(rr).toBytes();
          const k = le(sha512(new Uint8Array([...R, ...kpA.publicKey, ...msg]))) % L;
          return new Uint8Array([...R, ...toLe((rr + k * scalar) % L)]);
        },
      };
      const signing = ed25519ActionSigning(hedged, { network: NETWORK, tokens });
      let err: Any = null;
      try {
        await landingMasterFor(outCtx(pg, signing), account());
      } catch (e) {
        err = { code: (e as Any).code ?? null, message: (e as Error).message };
      }
      res.refusal = err;
      res.walletAsked = asked;
      record('out:f', res);
      if (err?.code !== 'not-deterministic' || asked !== 2) throw new Error(`f: ${json(res)}`);
      return res;
    }
    case 'g': {
      // A stored check that does not match (another master): refused before tx1.
      const fake: BridgeOutRecord = {
        ...(readBridgeOuts(pg.store, pg.scope, account())[0] as BridgeOutRecord),
        authNonce: '999999',
        check: '00'.repeat(16),
        state: 'failed',
      };
      putBridgeOut(pg.store, pg.scope, account(), { ...fake, createdAt: Date.now() + 10_000 });
      let err: Any = null;
      try {
        await landingMasterFor(ctx, account());
      } catch (e) {
        err = { code: (e as Any).code ?? null, message: (e as Error).message };
      }
      pg.store.remove(recordKey(pg.scope, 'bridge', { account: account(), id: 'out-999999' }));
      pg.flush();
      res.refusal = err;
      record('out:g', res);
      if (err?.code !== 'landing-key-changed') throw new Error(`g: ${json(res)}`);
      return res;
    }
    case 'i': {
      // A concurrent lock between tx2's build and its submission. Two transfers at the landing key; both
      // locks are BUILT on the same bridge state. Transfer one is held at its first submission until
      // transfer two's lock has landed, so one's first draft is stale when the market reads it: it must be
      // refused at admission (409 bridge-out-stale: no proof, no DUST, the entitlement released), and the
      // page must rebuild it on the new state and land it. (Sending both at once would only meet the
      // relay's one-job-per-account gate, `429 account-busy`, before any check of the transaction.)
      const one = await start(4n * UNIT, 'tx1One');
      const two = await start(2n * UNIT, 'tx1Two');
      const before = await bridgeWithdrawals();
      let oneReady!: () => void;
      const oneAtSubmit = new Promise<void>((r) => (oneReady = r));
      let twoLanded!: () => void;
      const twoDone = new Promise<void>((r) => (twoLanded = r));
      const attempts: { transfer: string; outcome: string }[] = [];
      const gated = (label: 'one' | 'two') => {
        let calls = 0;
        const relay = Object.create(pg.relay) as typeof pg.relay;
        relay.submit = (async (action: string, body: Any) => {
          calls += 1;
          if (action === 'bridge-out' && label === 'one' && calls === 1) {
            oneReady();
            await twoDone;
          }
          if (action === 'bridge-out' && label === 'two') await oneAtSubmit;
          try {
            const job = await pg.relay.submit(action as never, body);
            attempts.push({ transfer: label, outcome: 'admitted' });
            return job;
          } catch (e) {
            attempts.push({
              transfer: label,
              outcome: `refused ${String((e as Any).status ?? '')} ${String((e as Any).code ?? (e as Error).message)}`,
            });
            throw e;
          }
        }) as typeof pg.relay.submit;
        relay.waitForJob = (async (id: string, onJob: Any) => {
          const done = await pg.relay.waitForJob(id, onJob);
          attempts.push({
            transfer: label,
            outcome: `job ${done.state}${done.error?.code ? ` ${done.error.code}` : ''}`,
          });
          return done;
        }) as typeof pg.relay.waitForJob;
        return { ...ctx, env: { ...ctx.env, relay } };
      };
      const t0 = Date.now();
      const [a, b] = await Promise.all([
        finishLock(gated('one'), one.m, account(), one.r),
        finishLock(gated('two'), two.m, account(), two.r).finally(() => twoLanded()),
      ]);
      pg.flush();
      const after = await bridgeWithdrawals();
      res.locks = {
        seconds: (Date.now() - t0) / 1000,
        states: [a.state, b.state],
        withdrawalIds: [a.withdrawalId, b.withdrawalId],
        nonceBefore: before.nonce.toString(),
        nonceAfter: after.nonce.toString(),
        attempts,
      };
      record('out:i', res);
      // Transfer one: refused at admission as stale (nothing proven, nothing spent), then admitted and landed.
      const oneAttempts = attempts.filter((x) => x.transfer === 'one').map((x) => x.outcome);
      if (
        a.state !== 'locked' ||
        b.state !== 'locked' ||
        after.nonce !== before.nonce + 2n ||
        json(oneAttempts) !== json([oneAttempts[0], 'admitted', 'job succeeded']) ||
        !/^refused 409 bridge-out-stale$/.test(oneAttempts[0] ?? '')
      )
        throw new Error(`i: ${json(res.locks)}`);
      return res;
    }
    case 'j': {
      // bridge-out-entitle for a coin tx1 never paid (another landing key): entitle-not-found.
      // (a)'s transfer: locked, or arrived when the run follows the real bridge's release (P9).
      const r = readBridgeOuts(pg.store, pg.scope, account()).find(
        (x) => (x.state === 'locked' || x.state === 'arrived') && x.amount === String(50n * UNIT),
      );
      if (!r) throw new Error('no 50 Y transfer to borrow the tx1 from');
      const st = await pg.chain.accountState(account());
      const counter = pg.signing.useCounter(st!, 0n);
      const job = await pg.relay.submit('bridge-out-entitle', {
        account: account(),
        payload: {
          tx1Hash: (await indexerTx(r.tx1Id!))?.hash?.replace(/^0x/, '') ?? r.tx1Id,
          spentCoin: r.spentCoin,
          amount: r.amount,
          landingCoinPublicKey: '77'.repeat(32),
          deviceKey: signerA.deviceKey,
          useCounter: String(counter),
        },
      });
      const done = await pg.relay.waitForJob(job.requestId, () => undefined);
      res.job = { state: done.state, code: done.error?.code ?? null };
      record('out:j', res);
      if (done.state !== 'failed' || done.error?.code !== 'entitle-not-found') throw new Error(`j: ${json(res.job)}`);
      return res;
    }
    default:
      throw new Error(`unknown OUT_CASE ${c}`);
  }
}

// ── P9: the real 00058 bridges (journey registry I-1 from their deployment records) ────────────────

/** The wallet's (A's) associated token account balance of `entry`'s SPL mint, base units (0 if none). */
async function walletTokenBalance(entry: BridgeEntry, owner = signerA.address): Promise<bigint> {
  const rpc = new SolanaRpc(need('SOLANA_RPC_URL'));
  return (await rpc.tokenBalance(associatedTokenAddress(owner, entry.splMint))) ?? 0n;
}

/** STEP=adopt-bridges: the journey's X and Y become this gate's bridges (the page's entries). */
function adoptBridges() {
  const j = JSON.parse(readFileSync(need('JOURNEY_FILE'), 'utf8')) as { tokens: BridgeEntry[] };
  gate.journey = Object.fromEntries(j.tokens.map((t) => [t.symbol, t]));
  const y = gate.journey.Y;
  if (!y || !gate.journey.X) throw new Error('the journey registry has no X or no Y');
  gate.bridge = {
    contract: norm(y.bridgeContract),
    colour: norm(y.colour),
    sourceMint: bytesToHex(base58.decode(y.splMint)),
    networkTag: '',
  };
  saveGate();
  record('adopt-bridges', gate.journey);
  say(`bridges: ${json(Object.values(gate.journey).map((t) => ({ symbol: t.symbol, contract: t.bridgeContract })))}`);
}

/** STEP=wallets: A's and B's wallet addresses (the Solana side of the market's test devices). */
function wallets() {
  const st = flowsState() as Any;
  const addr = (seed: string) => base58.encode(nacl.sign.keyPair.fromSeed(hexToBytes(seed, 32)).publicKey);
  process.stdout.write(`WALLET_A ${addr(st.A.seed)}\nWALLET_B ${addr(st.B.seed)}\n`);
  process.stdout.write(`ACCOUNT_A ${norm(st.A.account)}\nACCOUNT_B ${norm(st.B.account)}\n`);
}

/** A's unspent coins of `colour` by the page's own decode (commitment → value). */
async function pageCoinsOf(colour: string): Promise<Map<string, bigint>> {
  const pg = pageA();
  const sync = await syncAccount(pg, account());
  pg.flush();
  return new Map(
    (sync.coins as Any[])
      .filter((c) => c.color === colour && !c.spent && !c.pending && c.mtIndex !== null)
      .map((c) => [String(c.commitment), BigInt(c.value)]),
  );
}

/** STEP=page-mark: remember A's current coins of SYMBOL (before a third party bridges more in). */
async function pageMark() {
  const entry = gate.journey?.[need('SYMBOL')];
  if (!entry) throw new Error(`no journey entry ${process.env.SYMBOL}`);
  gate.marks = { ...(gate.marks ?? {}), [entry.symbol]: [...(await pageCoinsOf(norm(entry.colour))).keys()] };
  saveGate();
}

/** STEP=page-wait: A's page (its own decode) holds a NEW coin of exactly AMOUNT of SYMBOL (since page-mark). */
async function pageWait() {
  const entry = gate.journey?.[need('SYMBOL')];
  if (!entry) throw new Error(`no journey entry ${process.env.SYMBOL}`);
  const amount = BigInt(need('AMOUNT'));
  const known = new Set(gate.marks?.[entry.symbol] ?? []);
  const t0 = Date.now();
  let found: string | null = null;
  for (let i = 0; i < 200 && !found; i++) {
    for (const [commitment, value] of await pageCoinsOf(norm(entry.colour)))
      if (!known.has(commitment) && value === amount) found = commitment;
    if (!found) await new Promise((r) => setTimeout(r, 3_000));
  }
  record(`page-wait:${process.env.LABEL ?? entry.symbol}`, {
    symbol: entry.symbol,
    amount: amount.toString(),
    coin: found,
    seconds: (Date.now() - t0) / 1000,
  });
  if (!found) throw new Error(`A's page shows no new ${amount} coin of ${entry.symbol}`);
}

/**
 * STEP=bridge-in (T7.9): A's page Bridge in of AMOUNT of SYMBOL from A's wallet (the page's own
 * precheck, one LockToContract signed by the wallet, the page's send), followed to completion by the
 * page's own decode. Then: A gains exactly AMOUNT, the wallet's token account is down by AMOUNT, and the
 * bridge's vault is up by AMOUNT.
 */
async function bridgeIn() {
  const entry = gate.journey?.[need('SYMBOL')];
  if (!entry) throw new Error(`no journey entry ${process.env.SYMBOL}`);
  const amount = BigInt(need('AMOUNT'));
  const rpc = new SolanaRpc(need('SOLANA_RPC_URL'));
  // AA 00057: WHO=B runs the same page operations for B (B's own Bridge in of the journey's Y).
  const who = process.env.WHO === 'B' ? party('B') : party('A');
  const pg = who.page;
  step(`T7.9: ${who.who}'s page bridges ${amount} base units of ${entry.symbol} in from its wallet`);
  const vault = bridgeVaultAddress(entry.bridgeProgram, entry.splMint);
  const balanceOf = async () => {
    const sync = await syncAccount(pg, who.account);
    pg.flush();
    return holdingsByColour(sync.coins).find((h) => h.color === norm(entry.colour))?.total ?? 0n;
  };
  const before = {
    page: await balanceOf(),
    wallet: await walletTokenBalance(entry, who.address),
    vault: (await rpc.tokenBalance(vault)) ?? 0n,
  };
  let prompts = 0;
  const ctx = {
    rpc,
    chain: 'solana:localnet',
    depositor: who.address,
    account: who.account,
    accountCheck: 'ok' as const,
    transactions: {
      // `solana:signTransaction`: the wallet signs the page's transaction; the page sends it.
      async sign(tx: Uint8Array) {
        prompts += 1;
        const { message } = splitTransaction(tx);
        logPrompt(who.kp.publicKey, 'transaction', message);
        const sig = nacl.sign.detached(message, who.kp.secretKey);
        const out = new Uint8Array(shortvec(1).length + 64 + message.length);
        out.set(shortvec(1), 0);
        out.set(sig, shortvec(1).length);
        out.set(message, shortvec(1).length + 64);
        return out;
      },
    },
  };
  const t0 = Date.now();
  const pre = await precheckBridgeIn(ctx, entry, amount);
  let rec = await sendBridgeIn(ctx, entry, amount, before.page);
  const sentSeconds = (Date.now() - t0) / 1000;
  const progress: string[] = [];
  while (rec.state !== 'completed' && rec.state !== 'failed' && rec.state !== 'undeliverable') {
    if (Date.now() - t0 > 900_000) break;
    rec = await followBridgeIn(rec, ctx, async () => {
      const sync = await syncAccount(pg, who.account);
      pg.flush();
      return sync.coins;
    });
    if (rec.progress && progress[progress.length - 1] !== rec.progress) progress.push(rec.progress);
    if (rec.state !== 'completed') await new Promise((ok) => setTimeout(ok, 3_000));
  }
  const after = {
    page: await balanceOf(),
    wallet: await walletTokenBalance(entry, who.address),
    vault: (await rpc.tokenBalance(vault)) ?? 0n,
  };
  const res = {
    who: who.who,
    symbol: entry.symbol,
    amount: amount.toString(),
    prompts,
    note: pre.note,
    state: rec.state,
    lockNonce: rec.lockNonce ?? null,
    signature: rec.signature,
    sentSeconds,
    completedSeconds: (Date.now() - t0) / 1000,
    progress,
    before,
    after,
  };
  record(`bridge-in:${process.env.LABEL ?? entry.symbol}`, res);
  say(`bridge in: ${json({ state: rec.state, before, after, seconds: res.completedSeconds })}`);
  if (
    rec.state !== 'completed' ||
    prompts !== 1 ||
    after.page - before.page !== amount ||
    before.wallet - after.wallet !== amount ||
    after.vault - before.vault !== amount
  )
    throw new Error(`T7.9: Bridge in is not as expected: ${json(res)}`);
}

// ── P9.3: Show in my wallet against 00059's injector (I-4, FROZEN @ f4d215c) ──────────────────────

/**
 * A registers through the page's own I-4 operations (checkInjector, one signature, one POST with the
 * viewing key); then the injector's RPC must show A's wallet exactly A's holdings by the page's own
 * decode (as 00059's gate A2: less the change the page holds without an inbox note), in Token-2022
 * accounts. INJECTOR_PUBLIC_URL is the origin the injector names (127.0.0.1 on the host); this container
 * reaches it as INJECTOR_INTERNAL_URL.
 */
async function inject() {
  const pub = need('INJECTOR_PUBLIC_URL').replace(/\/$/, '');
  const internal = (process.env.INJECTOR_INTERNAL_URL ?? 'http://injector:8899').replace(/\/$/, '');
  const fetchImpl = ((input: Any, init?: Any) => {
    const url = String(input instanceof Request ? input.url : input);
    return fetch(url.startsWith(pub) ? internal + url.slice(pub.length) : url, init);
  }) as typeof fetch;
  const rpc = async (method: string, params: unknown[]) => {
    const r = await fetch(internal, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const j = (await r.json()) as { result?: Any; error?: Any };
    if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
    return j.result;
  };
  step("P9.3 Show in my wallet: A registers with 00059's injector (the page's I-4 operations, one signature)");
  const pg = pageA();
  const ctx = {
    injectorUrl: pub,
    midnightNetworkId: PROFILE.midnightNetworkId,
    wallet: signerA.address,
    account: account(),
    fetchImpl,
  };
  const info = await checkInjector(ctx);
  let prompts = 0;
  const signing = ed25519ActionSigning(
    {
      deviceKey: signerA.deviceKey,
      address: signerA.address,
      signMessage: async (m: Uint8Array) => {
        prompts += 1;
        return signerA.signMessage(m);
      },
    },
    { network: NETWORK, tokens },
  );
  const t0 = Date.now();
  const view = await registerAccount(ctx, info, signing, flows.A.encSecret);
  say(`registered: ${view.id} ${view.status} (${prompts} signature)`);
  let st: Any = view;
  for (let i = 0; i < 90 && st.status !== 'synced'; i++) {
    await new Promise((r) => setTimeout(r, 2_000));
    st = (await readRegistrationStatus(ctx)) ?? st;
  }
  const syncedSeconds = (Date.now() - t0) / 1000;
  // What the RPC must show: the page's holdings, less change it holds without an inbox note.
  const want = async () => {
    const sync = await syncAccount(pg, account());
    pg.flush();
    const m: Record<string, bigint> = {};
    for (const h of holdingsByColour(sync.coins)) m[h.color] = h.total;
    for (const c of sync.coins as Any[]) {
      if (!c.spent && !c.inInbox && c.origin === 'change' && c.mtIndex !== null && !c.pending)
        m[c.color] = (m[c.color] ?? 0n) - BigInt(c.value);
    }
    return Object.fromEntries(Object.entries(m).filter(([, v]) => v > 0n));
  };
  const got = async () => {
    const r = await rpc('getTokenAccountsByOwner', [
      signerA.address,
      { programId: TOKEN_2022_PROGRAM_ID },
      { encoding: 'jsonParsed' },
    ]);
    const accounts: { mint: string; amount: string; name?: string; symbol?: string }[] = [];
    for (const a of r.value as Any[]) {
      const parsed = a.account.data.parsed.info;
      const mint = String(parsed.mint);
      const mi = await rpc('getAccountInfo', [mint, { encoding: 'jsonParsed' }]).catch(() => null);
      const meta = (mi?.value?.data?.parsed?.info?.extensions ?? []).find(
        (x: Any) => x.extension === 'tokenMetadata',
      )?.state;
      accounts.push({
        mint,
        amount: String(parsed.tokenAmount.amount),
        ...(meta ? { name: String(meta.name), symbol: String(meta.symbol) } : {}),
      });
    }
    return accounts;
  };
  const sorted = (xs: string[]) => [...xs].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0));
  let page: Record<string, bigint> = {};
  let accounts: Awaited<ReturnType<typeof got>> = [];
  let same = false;
  const t1 = Date.now();
  for (let i = 0; i < 60 && !same; i++) {
    page = await want();
    accounts = await got();
    same =
      json(sorted(Object.values(page).map(String))) ===
      json(sorted(accounts.map((a) => a.amount).filter((a) => BigInt(a) > 0n)));
    if (!same) await new Promise((r) => setTimeout(r, 3_000));
  }
  const bySymbol = Object.fromEntries(
    Object.entries(page).map(([colour, v]) => [tokens.byColour(colour)?.symbol ?? colour, v.toString()]),
  );
  const res = {
    registration: { id: view.id, firstStatus: view.status, status: st.status, error: st.error ?? null },
    prompts,
    syncedSeconds,
    matchSeconds: (Date.now() - t1) / 1000,
    page: bySymbol,
    rpc: accounts,
    same,
  };
  record('inject', res);
  say(`page ${json(bySymbol)}; RPC ${json(accounts)}`);
  if (prompts !== 1 || st.status !== 'synced' || !same)
    throw new Error(`Show in my wallet: not as expected: ${json(res)}`);
}

async function main() {
  out.network = NETWORK;
  if (STEP !== 'bridge-deploy' && STEP !== 'adopt-bridges') {
    out.account = flows.A.account ?? null;
    out.wallet = signerA.address;
  }
  switch (STEP) {
    case 'bridge-deploy':
      return bridgeDeploy();
    case 'fund':
      return fund(BigInt(process.env.FUND_AMOUNT ?? String(50n * UNIT)), process.env.LABEL ?? 'fund');
    case 'tx1':
      return tx1(BigInt(process.env.AMOUNT ?? String(50n * UNIT)), process.env.LABEL ?? 'tx1', {
        ...(process.env.SEAL_TO ? { sealTo: process.env.SEAL_TO } : {}),
      });
    case 'tx2': {
      const label = process.env.TX1_LABEL ?? 'tx1';
      const t = gate.tx1?.[label];
      if (!t) throw new Error(`no ${label} recorded`);
      return tx2(BigInt(t.authNonce), BigInt(t.amount), process.env.LABEL ?? 'tx2', {
        tamperRecipient: process.env.TAMPER === '1',
        ...(COMPUTED ? { coin: coinOf(label) } : {}),
      });
    }
    case 'return':
      return returnCoin(process.env.TX1_LABEL ?? 'tx1');
    case 'out':
      return outCase(process.env.OUT_CASE ?? 'a');
    case 'adopt-bridges':
      return adoptBridges();
    case 'wallets':
      return wallets();
    case 'page-mark':
      return pageMark();
    case 'page-wait':
      return pageWait();
    case 'bridge-in':
      return bridgeIn();
    case 'inject':
      return inject();
    case 'resume-lock':
      return resumeLock();
    case 'resume-return':
      return resumeReturn();
    case 'neg-relay':
      return negRelay();
    case 'neg-circuit':
      return negCircuit();
    case 'neg-seal-check': {
      // L.9 (d): does keys_t's SDK wallet see a coin sealed to another encryption key?
      const t = gate.tx1?.[process.env.TX1_LABEL ?? 'tx1-seal'];
      if (!t) throw new Error('no tx1-seal recorded');
      const { master } = await landingMaster();
      const keys = landingKeyFor(master, account(), BigInt(t.authNonce));
      master.wipe();
      const w = await openLanding(keys);
      const bal = (await w.balances())[colourY()] ?? 0n;
      await w.stop().catch(() => undefined);
      // P6.0: the page's computed path finds it anyway (it watches for the coin, no decryption).
      const comp = COMPUTED ? await computedLanding(keys, coinOf(process.env.TX1_LABEL ?? 'tx1-seal')) : null;
      keys.clear();
      return record(`negSeal:${process.env.TX1_LABEL ?? 'tx1-seal'}`, {
        sdkSeesCoin: bal >= BigInt(t.amount),
        balance: bal.toString(),
        ...(comp ? { computedSeesCoin: comp.holds, computedMtIndex: comp.mtIndex, events: comp.events } : {}),
      });
    }
    default:
      throw new Error(`unknown STEP ${JSON.stringify(STEP)}`);
  }
}

main().then(
  () => process.exit(0),
  (e: unknown) => {
    const msg = errorChain(e);
    out.steps[`${STEP}:error`] = msg.slice(0, 3000);
    mkdirSync(OUT, { recursive: true });
    writeFileSync(outPath, `${json(out)}\n`);
    process.stderr.write(`FAILED ${STEP}: ${msg.slice(0, 2000)}\n${String((e as Error)?.stack ?? '')}\n`);
    process.exit(1);
  },
);
/* eslint-enable @typescript-eslint/no-explicit-any */
