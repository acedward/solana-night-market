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
// SECRETS: A's test device seed is market-flows.ts's (state.json, mode 600); the landing master is
// re-derived from it in every process and never written; the operator's throwaway key is in
// landing-state.json (mode 600). Everything written to $OUT is public.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { sha256 } from '@noble/hashes/sha2.js';
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
import { bridgeColourOf, deriveLandingMaster, type LandingMaster } from '@nightmarket/core/bridge';
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
  signMessage: async (m: Uint8Array) => nacl.sign.detached(m, kpA.secretKey),
};
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

/** The page's balance of Y on A (its own decode), waiting until `until` holds. */
async function pageY(until: (v: bigint) => boolean = () => true, tries = 60) {
  const pg = pageA();
  let last: { total: bigint; coins: Any[]; authNonce: string } = { total: -1n, coins: [], authNonce: '' };
  for (let i = 0; i < tries; i++) {
    const sync = await syncAccount(pg, account());
    pg.flush();
    const y = holdingsByColour(sync.coins).find((h) => h.color === colourY());
    last = {
      total: y?.total ?? 0n,
      coins: sync.coins.filter((c: Any) => c.color === colourY()),
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
      return signerA.signMessage(m);
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
    process.stdout.write(`BRIDGE ${json({ contract, colour, symbol: 'Y', decimals: 6 })}\n`);
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
    [label]: { authNonce: n.toString(), amount: amount.toString(), txHash: landed?.hash ?? null },
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
async function tx2(authNonce: bigint, amount: bigint, label: string, opts: { tamperRecipient?: boolean } = {}) {
  step(`${label}: tx2 = lockForSolana(coin, <A's wallet key>), balanced by keys_t, DUST by the sponsor`);
  const { master } = await landingMaster();
  const keys = landingKeyFor(master, account(), authNonce);
  master.wipe();
  const rt = await runtime();
  const bridge = await bridgeRuntime();
  const landing = await openLanding(keys);
  const sponsor = await openWallet(need('SPONSOR_SEED_FILE'));
  const res: Record<string, Any> = { authNonce: authNonce.toString(), amount: amount.toString() };
  try {
    res.landingSyncMs = landing.syncMs;
    res.landingBalanceY = String(await landing.waitFor(colourY(), amount));
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
    const balancing = await landing.wallet.balanceTransaction(keys.shieldedSecretKeys, unproven);
    if (!balancing) throw new Error('keys_t balanced nothing: the coin was not spent');
    const merged = unproven.merge(balancing);
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
    res.landingBalancesAfter = Object.fromEntries(
      Object.entries(await landing.balances()).map(([k, v]) => [k.slice(0, 12), v.toString()]),
    );
    res.landingHoldsDustOrNight = false; // keys_t never derives a NIGHT key; its Dust key is never registered
    const dustAfter = await dustOf(sponsor.handle as SponsorWalletHandle);
    res.sponsorDust = { before: dustBefore?.toString() ?? null, after: dustAfter?.toString() ?? null };
    const yAfter = BigInt(Object.entries(await landing.balances()).find(([k]) => k === colourY())?.[1] ?? 0n);
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
    await landing.stop().catch(() => undefined);
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

/** L.9 (a): tx1's payload with another recipient and the original approval → 401, nothing lands. */
async function negRelay() {
  step('neg-relay (L.9 a): another recipient with the original approval, at the live relay');
  const pg = pageA();
  await pageY((v) => v > 0n);
  const st = await pg.chain.accountState(account());
  const coins = readCoins(pg.store, pg.scope, account());
  const coin = chooseCoin(coins, colourY(), 1n * UNIT);
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

async function main() {
  out.network = NETWORK;
  if (STEP !== 'bridge-deploy') {
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
      });
    }
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
      keys.clear();
      return record('negSeal', { sdkSeesCoin: bal >= BigInt(t.amount), balance: bal.toString() });
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
