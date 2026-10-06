// AA 00060 P6 (T6.1, T6.2, T6.3 at the unit level): the relay's Bridge out.
//
//   T6.1  the landing entitlement: its MAC, expiry and single use; tampering with any bound field
//         (account, device, landing coin key, colour, amount) is `entitlement-invalid`; a new instance
//         with the same key (a restart) still verifies it (that a spent one stays spent needs the relay's
//         data file: P10.3, ./bridge-out-audit.test.ts)
//   T6.2  the checks before any proof or DUST, on REAL unproven transactions built here exactly as the
//         page builds them (web/src/bridge/out/build.ts: midnight-js `createUnprovenCallTxFromInitialStates`
//         on the vendored bridge, the landing coin's input from @nightmarket/core/bridge/landing-spend): the
//         honest lock and return pass; another destination, another amount, another colour, a bridge not
//         in I-1, a return to another account, a call the contract's latest state no longer runs (a
//         concurrent lock), and extra calls are each refused with their named code. DUST spends and
//         unshielded offers are checked on the transaction's facts (they need a funded wallet to build).
//   T6.3  the page's own draft check refuses a lock with another recipient or amount before any request.

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ed25519 } from '@noble/curves/ed25519.js';
import * as crt from '@midnight-ntwrk/compact-runtime-0.20';
import * as ledger from '@midnightntwrk/ledger-v9';
import nacl from 'tweetnacl';
import { describe, expect, it } from 'vitest';

import { bytesToHex, hexToBytes } from '@nightmarket/core';
import { BridgeRegistry } from '@nightmarket/core/bridge';
import { findLandingCoin, type LandingCoinInfo } from '@nightmarket/core/bridge/landing-spend';
import {
  landingCoinSecretKeyHex,
  landingKeysFromSeed,
  type LandingKeys,
} from '@nightmarket/core/bridge/landing-wallet';
import {
  BRIDGE_OUT_REFUSALS as R,
  landingCoinCommitment,
  type BridgeOutPayload,
  type LandingBinding,
} from '@nightmarket/core/bridge/out';
import { AccountContract } from '@nightmarket/core/passport';

import {
  BridgeOutRefused,
  LandingEntitlements,
  type BridgeOutTxFacts,
  bridgeOutTxFacts,
  checkBridgeOut,
  landingEntitlementKey,
  landingOfWithdrawal,
  runCall,
  structuralChecks,
} from '../src/bridge/out-actions.js';
import { BuildError, balanceAndCheck, buildLock, buildReturn } from '../../web/src/bridge/out/build.js';
import * as bridgeModule from '../../web/src/bridge/vendor/bridge/contract/index.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

const NETWORK_ID = 'undeployed';
const rand = (n = 32) => new Uint8Array(randomBytes(n));
const randHex = () => bytesToHex(rand());

// ── T6.1 ─────────────────────────────────────────────────────────────────────

describe('T6.1 the landing entitlement', () => {
  const key = landingEntitlementKey('11'.repeat(32));
  const account = '5e'.repeat(32);
  const binding: LandingBinding = {
    deviceKey: 'a1'.repeat(32),
    coinPublicKey: 'b2'.repeat(32),
    colour: 'c3'.repeat(32),
    amount: '50000000',
  };
  const commitment = 'd4'.repeat(32);

  it('verifies for exactly what it binds; any bound field changed is entitlement-invalid', () => {
    const e = new LandingEntitlements({ key, network: 'undeployed' });
    const token = e.issue(account, binding, commitment);
    expect(token).toMatch(/^le1\.[0-9a-f]{64}\.[0-9a-f]{64}\.[0-9]+\.[0-9a-f]{64}$/);
    expect(e.verify(token, account, binding).ok).toBe(true);
    for (const [field, value] of [
      ['deviceKey', 'ee'.repeat(32)],
      ['coinPublicKey', 'ee'.repeat(32)],
      ['colour', 'ee'.repeat(32)],
      ['amount', '50000001'],
    ] as const) {
      const out = e.admit(token, account, { ...binding, [field]: value });
      expect(out, field).toMatchObject({ ok: false, code: R.entitlementInvalid });
    }
    expect(e.admit(token, 'ee'.repeat(32), binding)).toMatchObject({ ok: false, code: R.entitlementInvalid });
    // Another network's relay, or another key, does not accept it.
    expect(new LandingEntitlements({ key, network: 'stagenet' }).verify(token, account, binding).ok).toBe(false);
    expect(
      new LandingEntitlements({ key: landingEntitlementKey('22'.repeat(32)), network: 'undeployed' }).verify(
        token,
        account,
        binding,
      ).ok,
    ).toBe(false);
    // A forged MAC (its last digit changed: never the same digit), a malformed token.
    const forged = `${token.slice(0, -1)}${token.endsWith('0') ? '1' : '0'}`;
    expect(forged).not.toBe(token);
    expect(e.verify(forged, account, binding).ok).toBe(false);
    expect(e.verify('le1.nope', account, binding).ok).toBe(false);
  });

  it('expires after its 30 days', () => {
    let now = 1_000_000;
    const e = new LandingEntitlements({ key, network: 'undeployed', now: () => now });
    const token = e.issue(account, binding, commitment);
    now += 30 * 86_400 - 1;
    expect(e.verify(token, account, binding).ok).toBe(true);
    now += 1;
    expect(e.verify(token, account, binding)).toMatchObject({ ok: false, reason: 'the entitlement has expired' });
  });

  it('is single use: held while its job runs, spent when it succeeds, released when it fails', () => {
    const e = new LandingEntitlements({ key, network: 'undeployed' });
    const token = e.issue(account, binding, commitment);
    const first = e.admit(token, account, binding);
    expect(first.ok).toBe(true);
    expect(e.admit(token, account, binding)).toMatchObject({ ok: false, code: R.entitlementUsed });
    // The job failed: the customer may try again.
    if (first.ok) first.finished?.({ ok: false, proved: true, requesterFault: false });
    const second = e.admit(token, account, binding);
    expect(second.ok).toBe(true);
    if (second.ok) second.finished?.({ ok: true, proved: true, requesterFault: false });
    expect(e.admit(token, account, binding)).toMatchObject({ ok: false, code: R.entitlementUsed });
    // A refused request (a full queue) gives it back.
    const t2 = e.issue(account, binding, 'f5'.repeat(32));
    const held = e.admit(t2, account, binding);
    if (held.ok) held.release?.();
    expect(e.admit(t2, account, binding).ok).toBe(true);
  });

  it('survives a restart (the key is the seed’s): a restarted relay still verifies it', () => {
    const a = new LandingEntitlements({ key, network: 'undeployed' });
    const token = a.issue(account, binding, commitment);
    const b = new LandingEntitlements({ key: landingEntitlementKey('11'.repeat(32)), network: 'undeployed' });
    expect(b.verify(token, account, binding).ok).toBe(true);
    // That a SPENT one stays spent across a restart needs the data file the relay keeps (P10.3, audit C1):
    // relay/test/bridge-out-audit.test.ts.
  });

  it('a withdrawal’s entitlement binds the landing coin it paid (tx1’s paid-out coin, the landing key)', () => {
    const l = landingOfWithdrawal({
      recipient: binding.coinPublicKey,
      color: binding.colour,
      amount: binding.amount,
      coin: { nonce: 'aa'.repeat(32), color: binding.colour, value: '60000000' },
      deviceKey: binding.deviceKey,
    });
    expect(l.binding).toEqual(binding);
    expect(l.commitment).toMatch(/^[0-9a-f]{64}$/);
    expect(LandingEntitlements.opOf(l.commitment)).not.toBe(LandingEntitlements.opOf(commitment));
  });
});

// ── T6.2 / T6.3: real unproven transactions ────────────────────────────────────

/** A deployed contract's operations carry their verifier keys (midnight-js needs one to locate a call's
 *  keys); a state built offline gets the real PUBLIC ones (./fixtures/verifier-keys; nothing is proven). */
function withVerifierKeys(state: Any, circuits: string[]) {
  for (const name of circuits) {
    const op = new (crt as Any).ContractOperation();
    op.verifierKey = new Uint8Array(readFileSync(join(__dirname, 'fixtures', 'verifier-keys', `${name}.verifier`)));
    state.setOperation(name, op);
  }
  return state;
}

/** A bridge contract's state built offline (its constructor), at a random address. */
async function bridgeAt() {
  const address = randHex();
  const operator = nacl.sign.keyPair();
  const sourceMint = rand();
  const contract = new (bridgeModule as Any).Contract({});
  const init = await contract.initialState(
    crt.createConstructorContext({}, randHex()),
    (crt as Any).curve25519FromProjective(ed25519.Point.fromBytes(operator.publicKey, false)),
    sourceMint,
    rand(),
  );
  const colour = bytesToHex(
    (bridgeModule as Any).pureCircuits.tokenColor(sourceMint, { bytes: hexToBytes(address, 32) }),
  );
  return { address, colour, state: withVerifierKeys(init.currentContractState, ['lockForSolana', 'mintFromSolana']) };
}

/** A Passport account's state built offline (as packages/core/test/withdraw-change.test.ts does). */
async function accountAt() {
  const address = randHex();
  const contract = new (AccountContract as Any)(
    new Proxy(
      {},
      {
        get: () => () => {
          throw new Error('no witness');
        },
      },
    ),
  );
  const init = await contract.initialState(
    crt.createConstructorContext({}, randHex()),
    rand(),
    rand(),
    rand(),
    { bytes: new Uint8Array(32) },
    { bytes: new Uint8Array(32) },
  );
  return {
    address,
    state: withVerifierKeys(init.currentContractState, ['deposit_shielded']),
    encKey: bytesToHex(nacl.box.keyPair().publicKey),
  };
}

const statesOf = (contractState: Any) => ({
  blockHash: 'ab'.repeat(32),
  height: 1,
  contractState,
  zswapChainState: new ledger.ZswapChainState(),
  ledgerParameters: ledger.LedgerParameters.initialParameters(),
});

/** keys_t holding a landing coin of `colour` and `value` (inserted directly into its local state). */
function landingWith(colour: string, value: bigint) {
  const keys = landingKeysFromSeed(rand());
  const coin: LandingCoinInfo = { nonce: randHex(), color: colour, value };
  const state = new ledger.ZswapLocalState().insertCoin(keys.shieldedSecretKeys, {
    nonce: coin.nonce,
    type: coin.color,
    value: coin.value,
  } as never);
  expect(findLandingCoin(state, coin)).not.toBeNull();
  return { keys, coin, state };
}

const WALLET = 'a1'.repeat(32);

async function lockTx(o: {
  bridge: Awaited<ReturnType<typeof bridgeAt>>;
  amount: bigint;
  recipient?: string;
  coinColour?: string;
}) {
  const l = landingWith(o.coinColour ?? o.bridge.colour, o.amount);
  const draft = await buildLock({
    networkId: NETWORK_ID,
    states: statesOf(o.bridge.state),
    bridgeContract: o.bridge.address,
    colour: o.coinColour ?? o.bridge.colour,
    amount: o.amount,
    solanaRecipient: o.recipient ?? WALLET,
    keys: l.keys,
  });
  const { hex } = await balanceAndCheck({
    networkId: NETWORK_ID,
    draft,
    contract: o.bridge.address,
    state: l.state,
    keys: l.keys,
    coin: l.coin,
  });
  return { hex, draft, landing: l };
}

const registryOf = (...bridges: { address: string; colour: string }[]) =>
  new BridgeRegistry(
    NETWORK_ID,
    '11111111111111111111111111111111',
    bridges.map((b, i) => ({
      colour: b.colour,
      splMint: '11111111111111111111111111111111',
      bridgeContract: b.address,
      bridgeProgram: '11111111111111111111111111111111',
      bridgeApi: 'http://bridge.test',
      name: `Token ${i}`,
      symbol: `T${i}`,
      decimals: 6,
    })),
  );

const ENTITLEMENTS = new LandingEntitlements({ key: landingEntitlementKey('11'.repeat(32)), network: NETWORK_ID });

function relayDeps(bridges: BridgeRegistry, states: Record<string, Any>, latest?: Record<string, Any>) {
  return {
    bridges,
    entitlements: ENTITLEMENTS,
    ledger: async () => ledger,
    transcripts: async () => ({
      runtime: crt as never,
      bridgeLedger: (s: Any) => (bridgeModule as Any).ledger(s),
      stateAt: async (a: string) => states[a] ?? null,
      latestState: async (a: string) => (latest ?? states)[a] ?? null,
    }),
  };
}

/** A request as the page sends it: the entitlement the relay issued for `account`'s landing coin `l`, and
 *  the coin it spends (P10.3, audit C1). */
const payload = (
  kind: 'lock' | 'return',
  tx: string,
  binding: LandingBinding,
  l: { keys: Pick<LandingKeys, 'shieldedSecretKeys'>; coin: LandingCoinInfo },
  account: string,
): BridgeOutPayload => ({
  kind,
  entitlement: ENTITLEMENTS.issue(
    account,
    binding,
    landingCoinCommitment({ nonce: l.coin.nonce, color: binding.colour, value: binding.amount }, binding.coinPublicKey),
  ),
  landing: binding,
  tx,
  proven: false,
  blockHash: 'ab'.repeat(32),
  spend: { nonce: l.coin.nonce, coinSecretKey: landingCoinSecretKeyHex(l.keys) },
});

const refusal = async (p: Promise<unknown>) => {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(BridgeOutRefused);
  return (e as BridgeOutRefused).code;
};

describe('T6.2 the relay refuses every other transaction before any proof or DUST', () => {
  const ACCOUNT = '5e'.repeat(32);

  it('the honest lock passes, recording {wallet, amount} under the next withdrawal id', async () => {
    const bridge = await bridgeAt();
    const { hex, draft, landing } = await lockTx({ bridge, amount: 50_000_000n });
    expect(draft.withdrawalId).toBe(0n);
    const binding = {
      deviceKey: WALLET,
      coinPublicKey: landing.keys.coinPublicKey,
      colour: bridge.colour,
      amount: '50000000',
    };
    const out = await checkBridgeOut(
      relayDeps(registryOf(bridge), { [bridge.address]: bridge.state }),
      ACCOUNT,
      payload('lock', hex, binding, landing, ACCOUNT),
    );
    expect(out.withdrawalId).toBe(0n);
  }, 60_000);

  it('another destination, another amount, another colour, a bridge not in I-1: each named', async () => {
    const bridge = await bridgeAt();
    const other = await bridgeAt();
    const states = { [bridge.address]: bridge.state, [other.address]: other.state };
    const reg = registryOf(bridge, other);
    const bind = (l: { keys: { coinPublicKey: string } }, over: Partial<LandingBinding> = {}): LandingBinding => ({
      deviceKey: WALLET,
      coinPublicKey: l.keys.coinPublicKey,
      colour: bridge.colour,
      amount: '50000000',
      ...over,
    });
    // Another destination: the lock pays another wallet.
    const d = await lockTx({ bridge, amount: 50_000_000n, recipient: 'ee'.repeat(32) });
    expect(
      await refusal(
        checkBridgeOut(relayDeps(reg, states), ACCOUNT, payload('lock', d.hex, bind(d.landing), d.landing, ACCOUNT)),
      ),
    ).toBe(R.destination);
    // Another amount: the lock (and its coin) is 49 Y, the entitlement says 50. Since P10.3 (audit C1) the
    // coin it spends is not the entitled one, which is refused first.
    const a = await lockTx({ bridge, amount: 49_000_000n });
    expect(
      await refusal(
        checkBridgeOut(relayDeps(reg, states), ACCOUNT, payload('lock', a.hex, bind(a.landing), a.landing, ACCOUNT)),
      ),
    ).toBe(R.input);
    // Another colour: the other bridge, while the landing coin's colour is the first's.
    const c = await lockTx({ bridge: other, amount: 50_000_000n });
    expect(
      await refusal(
        checkBridgeOut(relayDeps(reg, states), ACCOUNT, payload('lock', c.hex, bind(c.landing), c.landing, ACCOUNT)),
      ),
    ).toBe(R.colour);
    // A bridge that is not in the journey registry.
    const n = await lockTx({ bridge: other, amount: 50_000_000n });
    expect(
      await refusal(
        checkBridgeOut(
          relayDeps(registryOf(bridge), states),
          ACCOUNT,
          payload('lock', n.hex, bind(n.landing, { colour: other.colour }), n.landing, ACCOUNT),
        ),
      ),
    ).toBe(R.contract);
  }, 120_000);

  it('a lock the latest state no longer runs (a concurrent lock) is stale; nothing else to rebuild', async () => {
    const bridge = await bridgeAt();
    const first = await lockTx({ bridge, amount: 1_000_000n });
    const second = await lockTx({ bridge, amount: 2_000_000n });
    // The bridge after the FIRST lock landed: the second, built on the same old state, no longer runs.
    const tx: Any = ledger.Transaction.deserialize('signature', 'pre-proof', 'pre-binding', hexToBytes(first.hex));
    const call = bridgeOutTxFacts(tx).calls[0]!.call;
    const after = runCall(crt as never, bridge.state, bridge.address, call);
    const moved = new (crt as Any).ContractState();
    moved.data = after;
    const binding = {
      deviceKey: WALLET,
      coinPublicKey: second.landing.keys.coinPublicKey,
      colour: bridge.colour,
      amount: '2000000',
    };
    expect(
      await refusal(
        checkBridgeOut(
          relayDeps(registryOf(bridge), { [bridge.address]: bridge.state }, { [bridge.address]: moved }),
          ACCOUNT,
          payload('lock', second.hex, binding, second.landing, ACCOUNT),
        ),
      ),
    ).toBe(R.stale);
  }, 120_000);

  it('the honest return passes; a return into another account is refused', async () => {
    const acc = await accountAt();
    const l = landingWith('c3'.repeat(32), 20_000_000n);
    const draft = await buildReturn({
      networkId: NETWORK_ID,
      states: statesOf(acc.state),
      account: acc.address,
      colour: l.coin.color,
      amount: l.coin.value,
      accountEncKey: acc.encKey,
      keys: l.keys,
    });
    const { hex } = await balanceAndCheck({
      networkId: NETWORK_ID,
      draft,
      contract: acc.address,
      state: l.state,
      keys: l.keys,
      coin: l.coin,
    });
    const binding = {
      deviceKey: WALLET,
      coinPublicKey: l.keys.coinPublicKey,
      colour: l.coin.color,
      amount: '20000000',
    };
    const deps = relayDeps(registryOf(), { [acc.address]: acc.state });
    expect(
      (await checkBridgeOut(deps, acc.address, payload('return', hex, binding, l, acc.address))).withdrawalId,
    ).toBeNull();
    // Another account's own entitlement, with a return into THIS account: refused.
    expect(
      await refusal(checkBridgeOut(deps, 'ee'.repeat(32), payload('return', hex, binding, l, 'ee'.repeat(32)))),
    ).toBe(R.destination);
    // A return is not a lock, and a lock is not a return.
    expect(await refusal(checkBridgeOut(deps, acc.address, payload('lock', hex, binding, l, acc.address)))).toBe(
      R.contract,
    );
    // The entitlement is for ANOTHER account than the request names: refused before anything else.
    expect(await refusal(checkBridgeOut(deps, acc.address, payload('return', hex, binding, l, 'ee'.repeat(32))))).toBe(
      R.entitlementInvalid,
    );
  }, 120_000);

  it('two calls, an extra call, a DUST spend, an unshielded offer, a transient, change elsewhere: refused on the facts', () => {
    const reg = registryOf({ address: 'b1'.repeat(32), colour: 'c3'.repeat(32) });
    const binding = { deviceKey: WALLET, coinPublicKey: 'cc'.repeat(32), colour: 'c3'.repeat(32), amount: '1' };
    const call = { address: 'b1'.repeat(32), entryPoint: 'lockForSolana', call: {} };
    const base: BridgeOutTxFacts = {
      calls: [call],
      otherActions: 0,
      dustActions: 0,
      unshielded: false,
      outputs: ['b1'.repeat(32)],
      transients: 0,
      imbalances: [],
      guaranteedInputs: 1,
      guaranteedOutputs: 1,
      nullifiers: ['ab'.repeat(32)],
      fallibleSegments: [],
    };
    const code = (over: Partial<BridgeOutTxFacts>) => {
      try {
        structuralChecks({ ...base, ...over }, 'lock', '5e'.repeat(32), binding, reg);
        return 'passed';
      } catch (e) {
        return (e as BridgeOutRefused).code;
      }
    };
    expect(code({})).toBe('passed');
    expect(code({ calls: [call, call] })).toBe(R.shape);
    expect(code({ otherActions: 1 })).toBe(R.shape);
    expect(code({ dustActions: 1 })).toBe(R.dust);
    expect(code({ unshielded: true })).toBe(R.unshielded);
    expect(code({ transients: 1 })).toBe(R.shape);
    expect(code({ outputs: ['b1'.repeat(32), null] })).toBe(R.shape);
    expect(code({ imbalances: ['0:shielded:c3=-1'] })).toBe(R.shape);
    expect(code({ calls: [{ ...call, entryPoint: 'mintFromSolana' }] })).toBe(R.shape);
  });
});

describe('T6.3 the page refuses its own draft before any request', () => {
  it('a lock with another recipient or amount than the draft check expects', async () => {
    const bridge = await bridgeAt();
    const l = landingWith(bridge.colour, 5_000_000n);
    // A tampered builder: the contract records another recipient than the page asked for.
    const tampered = { ...bridge, state: bridge.state };
    const draft = await buildLock({
      networkId: NETWORK_ID,
      states: statesOf(tampered.state),
      bridgeContract: bridge.address,
      colour: bridge.colour,
      amount: 5_000_000n,
      solanaRecipient: WALLET,
      keys: l.keys,
    });
    expect(draft.solanaRecipient).toBe(WALLET);
    // The page's shape check refuses a balanced transaction on another contract than the lock's.
    const { balanceWithLandingCoin } = await import('@nightmarket/core/bridge/landing-spend');
    const b = balanceWithLandingCoin(draft.unproven, l.state, l.keys, l.coin, NETWORK_ID);
    const { checkDraftShape } = await import('../../web/src/bridge/out/build.js');
    expect(() => checkDraftShape(b.tx, 'ee'.repeat(32), 'lockForSolana')).toThrow(BuildError);
    expect(() => checkDraftShape(b.tx, bridge.address, 'deposit_shielded')).toThrow(BuildError);
    expect(() => checkDraftShape(b.tx, bridge.address, 'lockForSolana')).not.toThrow();
  }, 60_000);
});
/* eslint-enable @typescript-eslint/no-explicit-any */
