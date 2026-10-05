// AA 00060 P10.3 (the security review's fix pass, audit file audits/00060-night-market-bridge-wallet-security.md):
// the relay-side findings, each as a test that failed before its fix.
//
//   C1   tx2's input is bound to the entitled landing coin (F-A1, F-B1, F-B5): exactly one Zswap input,
//        whose nullifier is the entitled coin's (the coin from the entitlement's own commitment, the
//        landing key from the coin secret key the unproven call carries anyway, Q2 A); exactly one
//        output; no fallible section; no proven bridge-out (it could not show which coin it spends);
//        consumption PERSISTED across a restart and a re-issue; a bounded number of proved failures.
//        Ported from auditor A's probes A1 (another key's coin), A2 (40 one-unit coins), A4 (resend after
//        a failure, reuse after a restart) and auditor B's substitution and re-issue sequences.
//   C9   a stale bridge-out (another customer's lock moved the bridge on) is not the requester's fault.
//   C11  the journey registry's mint is checked against the deployed bridge's sealed `sourceMint`.
//   C12  an entitlement has one spelling (no leading zeros in its expiry).

import { randomBytes } from 'node:crypto';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ed25519 } from '@noble/curves/ed25519.js';
import * as crt from '@midnight-ntwrk/compact-runtime-0.20';
import * as ledger from '@midnightntwrk/ledger-v9';
import nacl from 'tweetnacl';
import { afterAll, describe, expect, it } from 'vitest';

import { bytesToHex, hexToBytes } from '@nightmarket/core';
import { BridgeRegistry } from '@nightmarket/core/bridge';
import { findLandingCoin } from '@nightmarket/core/bridge/landing-spend';
import { landingKeysFromSeed, type LandingKeys } from '@nightmarket/core/bridge/landing-wallet';
import {
  LANDING_ENTITLEMENT_PATTERN,
  landingCoinCommitment,
  type BridgeOutPayload,
  type LandingBinding,
} from '@nightmarket/core/bridge/out';

import { countsAgainstBudget } from '../src/actions/failure-budget.js';
import {
  LandingEntitlements,
  bridgeOutAdmission,
  landingEntitlementKey,
  structuralChecks,
  type BridgeOutTxFacts,
} from '../src/bridge/out-actions.js';
import { bridgeKeyProblems } from '../src/bridge/registry-check.js';
import { PublicError } from '../src/queue/jobs.js';
import { buildLock } from '../../web/src/bridge/out/build.js';
import * as bridgeModule from '../../web/src/bridge/vendor/bridge/contract/index.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

const NETWORK_ID = 'undeployed';
const ACCOUNT = '5e'.repeat(32);
const WALLET = 'a1'.repeat(32);
const rand = (n = 32) => new Uint8Array(randomBytes(n));
const randHex = () => bytesToHex(rand());
const hexOf = (b: Uint8Array) => Buffer.from(b).toString('hex');
const KEY = landingEntitlementKey('11'.repeat(32));
const dirs: string[] = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'aa00060-audit-'));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function withVerifierKeys(state: Any, circuits: string[]) {
  for (const name of circuits) {
    const op = new (crt as Any).ContractOperation();
    op.verifierKey = new Uint8Array(readFileSync(join(__dirname, 'fixtures', 'verifier-keys', `${name}.verifier`)));
    state.setOperation(name, op);
  }
  return state;
}
/** A bridge deployed at a random address, sealing `sourceMint`. */
async function bridgeAt(sourceMint = rand()) {
  const address = randHex();
  const operator = nacl.sign.keyPair();
  const contract = new (bridgeModule as Any).Contract({});
  const init = await contract.initialState(
    crt.createConstructorContext({}, randHex()),
    (crt as Any).curve25519FromProjective(ed25519.Point.fromBytes(operator.publicKey, false)),
    sourceMint,
    rand(),
  );
  const colour = bytesToHex((bridgeModule as Any).pureCircuits.tokenColor(sourceMint, { bytes: hexToBytes(address, 32) }));
  return {
    address,
    colour,
    sourceMint,
    state: withVerifierKeys(init.currentContractState, ['lockForSolana', 'mintFromSolana']),
  };
}
const statesOf = (contractState: Any) => ({
  blockHash: 'ab'.repeat(32),
  height: 1,
  contractState,
  zswapChainState: new ledger.ZswapChainState(),
  ledgerParameters: ledger.LedgerParameters.initialParameters(),
});
const registryOf = (...bridges: { address: string; colour: string; splMint?: string }[]) =>
  new BridgeRegistry(
    NETWORK_ID,
    '11111111111111111111111111111111',
    bridges.map((b, i) => ({
      colour: b.colour,
      splMint: b.splMint ?? '11111111111111111111111111111111',
      bridgeContract: b.address,
      bridgeProgram: '11111111111111111111111111111111',
      bridgeApi: 'http://bridge.test',
      name: `Token ${i}`,
      symbol: `T${i}`,
      decimals: 6,
    })),
  );
function admissionDeps(bridge: { address: string; colour: string; state: Any }, entitlements: LandingEntitlements) {
  return {
    bridges: registryOf(bridge),
    entitlements,
    ledger: async () => ledger,
    transcripts: async () => ({
      runtime: crt as never,
      bridgeLedger: (s: Any) => (bridgeModule as Any).ledger(s),
      stateAt: async (a: string) => (a === bridge.address ? bridge.state : null),
      latestState: async (a: string) => (a === bridge.address ? bridge.state : null),
    }),
  };
}

/** keys_t holding coins of `colour` with these values. */
function walletWith(colour: string, values: bigint[], keys: LandingKeys = landingKeysFromSeed(rand())) {
  let state = new ledger.ZswapLocalState();
  const coins = values.map((value) => ({ nonce: randHex(), color: colour, value }));
  for (const c of coins)
    state = state.insertCoin(keys.shieldedSecretKeys, { nonce: c.nonce, type: c.color, value: c.value } as never);
  return { keys, coins, state };
}
/** Balance a draft with the given coins as inputs in segment 0 (what an attacker can send). */
function balanceWith(unproven: Any, w: ReturnType<typeof walletWith>, coins = w.coins) {
  let tx = unproven;
  let state = w.state;
  for (const c of coins) {
    const q = findLandingCoin(state, c)!;
    const [next, input] = state.spend(w.keys.shieldedSecretKeys, q, 0);
    state = next;
    tx = tx.merge(ledger.Transaction.fromParts(NETWORK_ID, ledger.ZswapOffer.fromInput(input, q.type, q.value)));
  }
  return tx;
}
const coinSecretKeyOf = (keys: LandingKeys) =>
  hexOf(
    (keys.shieldedSecretKeys.coinSecretKey as Any).yesIKnowTheSecurityImplicationsOfThis_serialize().slice(-32),
  );

/**
 * A lock of `amount` on `bridge`, entitled for the landing coin `entitled` of `owner` (its commitment is
 * the entitlement's op), balanced with `spent` coins of `payer`; the request names `spend`.
 */
async function lockCase(o: {
  bridge: Awaited<ReturnType<typeof bridgeAt>>;
  owner: ReturnType<typeof walletWith>;
  entitled: { nonce: string; color: string; value: bigint };
  payer?: ReturnType<typeof walletWith>;
  spent?: { nonce: string; color: string; value: bigint }[];
  spend?: { nonce: string; coinSecretKey: string };
  entitlements?: LandingEntitlements;
  proven?: boolean;
}) {
  const payer = o.payer ?? o.owner;
  const amount = o.entitled.value;
  const draft = await buildLock({
    networkId: NETWORK_ID,
    states: statesOf(o.bridge.state),
    bridgeContract: o.bridge.address,
    colour: o.bridge.colour,
    amount,
    solanaRecipient: WALLET,
    keys: payer.keys,
  });
  const tx = balanceWith(draft.unproven, payer, o.spent ?? [o.entitled]);
  const binding: LandingBinding = {
    deviceKey: WALLET,
    coinPublicKey: o.owner.keys.coinPublicKey,
    colour: o.bridge.colour,
    amount: amount.toString(),
  };
  const entitlements = o.entitlements ?? new LandingEntitlements({ key: KEY, network: NETWORK_ID });
  const commitment = landingCoinCommitment(
    { nonce: o.entitled.nonce, color: o.entitled.color, value: amount.toString() },
    o.owner.keys.coinPublicKey,
  );
  const token = entitlements.issue(ACCOUNT, binding, commitment);
  const payload = {
    kind: 'lock',
    entitlement: token,
    landing: binding,
    tx: hexOf(tx.serialize()),
    proven: o.proven ?? false,
    blockHash: 'ab'.repeat(32),
    spend: o.spend ?? { nonce: o.entitled.nonce, coinSecretKey: coinSecretKeyOf(o.owner.keys) },
  } as BridgeOutPayload;
  const admit = bridgeOutAdmission(admissionDeps(o.bridge, entitlements));
  const out = await admit({ account: ACCOUNT, payload, signer: WALLET, client: 'test' } as Any);
  if (out.ok) out.release?.();
  return { out, tx, payload, entitlements, token, binding, commitment };
}

describe('C1: tx2 spends exactly the entitled landing coin (F-A1, F-B1)', () => {
  it('the honest lock (the entitled coin, one input, one output) is admitted', async () => {
    const bridge = await bridgeAt();
    const owner = walletWith(bridge.colour, [50_000_000n]);
    const { out } = await lockCase({ bridge, owner, entitled: owner.coins[0]! });
    expect(out).toMatchObject({ ok: true });
  }, 60_000);

  it("A1: a lock whose input is ANOTHER key's coin is refused before any proof", async () => {
    const bridge = await bridgeAt();
    const owner = walletWith(bridge.colour, [50_000_000n]);
    const other = walletWith(bridge.colour, [50_000_000n]);
    // The request names the entitled coin and its key; the transaction spends the other key's coin.
    const a = await lockCase({ bridge, owner, entitled: owner.coins[0]!, payer: other, spent: other.coins });
    expect(a.out).toMatchObject({ ok: false, code: 'bridge-out-input' });
    // Naming the other key's coin and secret instead: the key is not the entitlement's.
    const b = await lockCase({
      bridge,
      owner,
      entitled: owner.coins[0]!,
      payer: other,
      spent: other.coins,
      spend: { nonce: other.coins[0]!.nonce, coinSecretKey: coinSecretKeyOf(other.keys) },
    });
    expect(b.out).toMatchObject({ ok: false, code: 'bridge-out-input' });
  }, 60_000);

  it('B: the same key, another coin of the same colour and value (a substitution) is refused', async () => {
    const bridge = await bridgeAt();
    const owner = walletWith(bridge.colour, [50_000_000n, 50_000_000n]);
    const { out } = await lockCase({ bridge, owner, entitled: owner.coins[0]!, spent: [owner.coins[1]!] });
    expect(out).toMatchObject({ ok: false, code: 'bridge-out-input' });
  }, 60_000);

  it('A2: a lock balanced by 40 one-unit coins is refused (exactly one input)', async () => {
    const bridge = await bridgeAt();
    const owner = walletWith(bridge.colour, Array.from({ length: 40 }, () => 1n));
    const entitled = { nonce: randHex(), color: bridge.colour, value: 40n };
    const { out } = await lockCase({ bridge, owner, entitled, spent: owner.coins });
    expect(out.ok).toBe(false);
    expect(['bridge-out-shape', 'bridge-out-input']).toContain((out as Any).code);
  }, 120_000);

  it('a proven bridge-out is refused: it cannot show which coin it spends', async () => {
    const bridge = await bridgeAt();
    const owner = walletWith(bridge.colour, [50_000_000n]);
    const { out } = await lockCase({ bridge, owner, entitled: owner.coins[0]!, proven: true });
    expect(out).toMatchObject({ ok: false, code: 'bridge-out-proven' });
  }, 60_000);

  it('a fallible offer or a fallible transcript is refused (facts)', () => {
    const address = 'd4'.repeat(32);
    const colour = 'c3'.repeat(32);
    const bridges = registryOf({ address, colour });
    const binding: LandingBinding = { deviceKey: WALLET, coinPublicKey: 'b2'.repeat(32), colour, amount: '5' };
    const honest = {
      calls: [{ address, entryPoint: 'lockForSolana', call: { guaranteedTranscript: {} } }],
      otherActions: 0,
      dustActions: 0,
      unshielded: false,
      outputs: [address],
      transients: 0,
      imbalances: [],
      guaranteedInputs: 1,
      guaranteedOutputs: 1,
      fallibleSegments: [],
    } as unknown as BridgeOutTxFacts;
    expect(() => structuralChecks(honest, 'lock', ACCOUNT, binding, bridges)).not.toThrow();
    const fallibleOffer = { ...honest, fallibleSegments: [1] } as unknown as BridgeOutTxFacts;
    expect(() => structuralChecks(fallibleOffer, 'lock', ACCOUNT, binding, bridges)).toThrow(/fallible/);
    const fallibleCall = {
      ...honest,
      calls: [{ address, entryPoint: 'lockForSolana', call: { guaranteedTranscript: {}, fallibleTranscript: {} } }],
    } as unknown as BridgeOutTxFacts;
    expect(() => structuralChecks(fallibleCall, 'lock', ACCOUNT, binding, bridges)).toThrow(/fallible/);
    const twoInputs = { ...honest, guaranteedInputs: 2 } as unknown as BridgeOutTxFacts;
    expect(() => structuralChecks(twoInputs, 'lock', ACCOUNT, binding, bridges)).toThrow(/one input/);
  });
});

describe('C1: consumption persists; failures are bounded (F-A1 parts 2-3, F-B1, F-B5)', () => {
  const binding: LandingBinding = { deviceKey: WALLET, coinPublicKey: 'cc'.repeat(32), colour: 'c3'.repeat(32), amount: '5' };

  it('A4 after a restart: a spent entitlement, and a RE-ISSUED one for the same coin, are refused', () => {
    const file = join(tempDir(), 'landing-entitlements.json');
    const a = new LandingEntitlements({ key: KEY, network: NETWORK_ID, file } as Any);
    const token = a.issue(ACCOUNT, binding, 'dd'.repeat(32));
    const held = a.admit(token, ACCOUNT, binding);
    expect(held.ok).toBe(true);
    if (held.ok) held.finished?.({ ok: true, proved: true, requesterFault: false });
    // A restart: a new instance, the same key and the same data file.
    const b = new LandingEntitlements({ key: landingEntitlementKey('11'.repeat(32)), network: NETWORK_ID, file } as Any);
    expect(b.admit(token, ACCOUNT, binding)).toMatchObject({ ok: false, code: 'entitlement-used' });
    // bridge-out-entitle re-issues a token for the same landing coin (a new expiry): still spent.
    const reissued = b.issue(ACCOUNT, binding, 'dd'.repeat(32));
    expect(reissued).not.toBe(token);
    expect(b.admit(reissued, ACCOUNT, binding)).toMatchObject({ ok: false, code: 'entitlement-used' });
  });

  it('A4 resend after a failure: three proved failures, then the entitlement is refused (also after a restart)', () => {
    const file = join(tempDir(), 'landing-entitlements.json');
    const a = new LandingEntitlements({ key: KEY, network: NETWORK_ID, file, maxFailedAttempts: 3 } as Any);
    const token = a.issue(ACCOUNT, { ...binding, amount: '6' }, 'ee'.repeat(32));
    for (let i = 0; i < 3; i++) {
      const h = a.admit(token, ACCOUNT, { ...binding, amount: '6' });
      expect(h.ok, `attempt ${i + 1}`).toBe(true);
      if (h.ok) h.finished?.({ ok: false, proved: true, requesterFault: true });
    }
    expect(a.admit(token, ACCOUNT, { ...binding, amount: '6' })).toMatchObject({ ok: false, code: 'bridge-out-attempts' });
    const b = new LandingEntitlements({ key: KEY, network: NETWORK_ID, file, maxFailedAttempts: 3 } as Any);
    expect(b.admit(token, ACCOUNT, { ...binding, amount: '6' })).toMatchObject({ ok: false, code: 'bridge-out-attempts' });
  });

  it('a refusal before any proof (stale at admission) does not use up an attempt', () => {
    const a = new LandingEntitlements({ key: KEY, network: NETWORK_ID, maxFailedAttempts: 1 } as Any);
    const token = a.issue(ACCOUNT, binding, 'ab'.repeat(32));
    for (let i = 0; i < 5; i++) {
      const h = a.admit(token, ACCOUNT, binding);
      expect(h.ok).toBe(true);
      if (h.ok) h.release?.();
    }
    const h = a.admit(token, ACCOUNT, binding);
    if (h.ok) h.finished?.({ ok: false, proved: false, requesterFault: false });
    expect(a.admit(token, ACCOUNT, binding).ok).toBe(true);
  });
});

describe('C9: a stale bridge-out is not the requester’s fault (F-A6)', () => {
  it('bridge-out-stale (another lock moved the bridge on, or the chain was slow) is not charged', () => {
    expect(countsAgainstBudget(new PublicError('bridge-out-stale', 'the contract moved on'), true)).toBe(false);
  });
});

describe('C11: the registry’s mint is the deployed bridge’s sealed source mint (F-A10)', () => {
  it('a bridge that seals another mint than the registry names is refused at start-up', async () => {
    const bridge = await bridgeAt();
    const managed = tempDir();
    mkdirSync(join(managed, 'bridge', 'keys'), { recursive: true });
    cpSync(
      join(__dirname, 'fixtures', 'verifier-keys', 'lockForSolana.verifier'),
      join(managed, 'bridge', 'keys', 'lockForSolana.verifier'),
    );
    const read = async (a: string) => (a === bridge.address ? bridge.state : null);
    const bridgeLedger = (s: Any) => (bridgeModule as Any).ledger(s);
    const { base58 } = await import('@scure/base');
    const right = registryOf({ address: bridge.address, colour: bridge.colour, splMint: base58.encode(bridge.sourceMint) });
    expect(await bridgeKeyProblems(right, managed, read as Any, bridgeLedger as Any)).toEqual([]);
    const wrong = registryOf({ address: bridge.address, colour: bridge.colour, splMint: base58.encode(rand()) });
    const problems = await bridgeKeyProblems(wrong, managed, read as Any, bridgeLedger as Any);
    expect(problems.join('\n')).toMatch(/seals another SPL mint/);
  }, 60_000);
});

describe('C12: an entitlement has one spelling', () => {
  it('an expiry with a leading zero is not a landing entitlement', () => {
    const t = (exp: string) => `le1.${'5e'.repeat(32)}.${'11'.repeat(32)}.${exp}.${'22'.repeat(32)}`;
    expect(LANDING_ENTITLEMENT_PATTERN.test(t('1790000000'))).toBe(true);
    expect(LANDING_ENTITLEMENT_PATTERN.test(t('01790000000'))).toBe(false);
  });
});
/* eslint-enable @typescript-eslint/no-explicit-any */
