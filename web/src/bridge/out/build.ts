// AA 00060 P6.2: Bridge out's second transaction, BUILT in the browser with no key material (G-LANDING
// L.6; AA 00048 `buildWithdraw`):
//
//   lock    `lockForSolana({nonce: random, colour, amount}, <the wallet's key>)` on the bridge of the
//           landing coin's colour (I-1), with the vendored bridge JS (../vendor/bridge, PROVENANCE.md)
//   return  `deposit_shielded({nonce: random, colour, amount}, <an inbox entry sealed to the account's
//           on-chain key>)` on the account itself (the Passport client's account contract)
//
// built by midnight-js's `createUnprovenCallTxFromInitialStates` on ONE block's state (the contract's
// state, its Zswap tree, the ledger parameters: ./states.ts), then balanced by the landing coin through
// the computed path (@nightmarket/core/bridge/landing-spend: whatever key tx1 sealed it to; questions
// Q5 A) and checked (`checkDraft`: one call, this contract and entry point, no DUST, no unshielded
// offer, and for a lock the bridge's next withdrawal is exactly {the wallet, the amount}) before the
// relay is asked to prove it (questions Q2 A). midnight-js, compact-js and the contracts load lazily:
// this module is only ever imported by the Bridge-out chunk.

import type { LandingCoinInfo, LandingSpendKeys } from '@nightmarket/core/bridge/landing-spend';

import type { ChainStates } from './states.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

const norm = (h: string) => h.replace(/^0x/i, '').toLowerCase();
const hexOf = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const bytesOf = (h: string) => {
  const s = norm(h);
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
  return out;
};

export class BuildError extends Error {
  override name = 'BuildError';
  constructor(
    readonly code: 'draft-mismatch' | 'unexpected-shape' | 'no-state' | 'bad-input',
    message: string,
  ) {
    super(message);
  }
}

interface BuildRuntime {
  createUnprovenCallTxFromInitialStates: Any;
  bridgeCompiled: Any;
  bridgeLedger: (state: Any) => Any;
  accountCompiled: Any;
  ledger: Any;
}

let runtimeP: Promise<BuildRuntime> | undefined;

/** midnight-js, compact-js, the bridge and account contracts, and ledger-v9, loaded on first use. */
export function buildRuntime(networkId: string): Promise<BuildRuntime> {
  runtimeP ??= (async () => {
    // midnight-js's address codecs use Node's global `Buffer` (AA 00048 `ensureBufferGlobal`).
    const g = globalThis as { Buffer?: unknown };
    if (g.Buffer === undefined) g.Buffer = (await import('buffer')).Buffer;
    const [contracts, compactJs, bridge, passport, ledger] = await Promise.all([
      import('@midnight-ntwrk/midnight-js-contracts'),
      import('@midnight-ntwrk/compact-js'),
      import('../vendor/bridge/contract/index.js'),
      import('@nightmarket/core/passport'),
      import('@midnightntwrk/ledger-v9'),
    ]);
    const { CompiledContract } = compactJs as Any;
    return {
      createUnprovenCallTxFromInitialStates: (contracts as Any).createUnprovenCallTxFromInitialStates,
      bridgeCompiled: CompiledContract.make('contract-bridge', (bridge as Any).Contract).pipe(
        CompiledContract.withVacantWitnesses,
      ),
      bridgeLedger: (s: Any) => (bridge as Any).ledger(s),
      // The account's witnesses must exist (the contract checks), though `deposit_shielded` calls none.
      accountCompiled: CompiledContract.make('account', (passport as Any).AccountContract).pipe(
        CompiledContract.withWitnesses((passport as Any).accountWitnesses()),
      ),
      ledger,
    };
  })();
  return runtimeP.then(async (rt) => {
    // midnight-js reads the network id from a module global when it renders the coin public key.
    const { setNetworkId } = await import('@midnight-ntwrk/midnight-js-network-id');
    setNetworkId(networkId as never);
    return rt;
  });
}

/** Building a call reads no key material: anything that asks for keys is a bug, so it throws. */
export const NO_KEY_MATERIAL = (() => {
  const refuse = () => {
    throw new Error('the browser holds no proving or verifier keys (the market proves)');
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

const randomNonce = (): Uint8Array => crypto.getRandomValues(new Uint8Array(32));

export interface LockDraft {
  kind: 'lock';
  /** The built call, unproven and NOT yet balanced. */
  unproven: Any;
  /** The withdrawal id the lock will record (I-3 `m2s:<id>`; the release receipt PDA). */
  withdrawalId: bigint;
  solanaRecipient: string;
  amount: bigint;
  blockHash: string;
}

export interface ReturnDraft {
  kind: 'return';
  unproven: Any;
  amount: bigint;
  blockHash: string;
}

/** Build `lockForSolana` on the bridge for the landing coin; checks the bridge's next withdrawal. */
export async function buildLock(o: {
  networkId: string;
  states: ChainStates;
  bridgeContract: string;
  colour: string;
  amount: bigint;
  /** The wallet's key (64 hex): the Solana recipient. */
  solanaRecipient: string;
  keys: { coinPublicKey: string; encryptionPublicKey: string };
}): Promise<LockDraft> {
  const rt = await buildRuntime(o.networkId);
  const before = rt.bridgeLedger(o.states.contractState.data);
  const withdrawalId = BigInt(before.withdrawalNonce);
  const call: Any = await rt.createUnprovenCallTxFromInitialStates(
    NO_KEY_MATERIAL,
    {
      compiledContract: rt.bridgeCompiled,
      contractAddress: norm(o.bridgeContract),
      circuitId: 'lockForSolana',
      args: [{ nonce: randomNonce(), color: bytesOf(o.colour), value: o.amount }, bytesOf(o.solanaRecipient)],
      coinPublicKey: norm(o.keys.coinPublicKey),
      initialContractState: o.states.contractState,
      initialZswapChainState: o.states.zswapChainState,
      ledgerParameters: o.states.ledgerParameters,
    },
    norm(o.keys.encryptionPublicKey),
  );
  // The draft check on the call's own result (spec FR-008, T6.3): exactly this withdrawal.
  const next = rt.bridgeLedger(call.public.nextContractState);
  const entry = next.withdrawals.member(withdrawalId) ? next.withdrawals.lookup(withdrawalId) : null;
  if (
    BigInt(call.private.result) !== withdrawalId ||
    !entry ||
    hexOf(Uint8Array.from(entry.solanaRecipient)) !== norm(o.solanaRecipient) ||
    BigInt(entry.amount) !== o.amount
  ) {
    throw new BuildError('draft-mismatch', 'the built lock is not this withdrawal (another recipient or amount)');
  }
  return {
    kind: 'lock',
    unproven: call.private.unprovenTx,
    withdrawalId,
    solanaRecipient: norm(o.solanaRecipient),
    amount: o.amount,
    blockHash: o.states.blockHash,
  };
}

/** Build `deposit_shielded` into the account: the landing coin back, its entry sealed to the account. */
export async function buildReturn(o: {
  networkId: string;
  states: ChainStates;
  account: string;
  colour: string;
  amount: bigint;
  /** The account's on-chain encryption key (64 hex): the entry is sealed to it. */
  accountEncKey: string;
  keys: { coinPublicKey: string; encryptionPublicKey: string };
}): Promise<ReturnDraft> {
  const rt = await buildRuntime(o.networkId);
  const { sealEntryPortable } = await import('@nightmarket/core/passport');
  const coin = { nonce: randomNonce(), color: bytesOf(o.colour), value: o.amount };
  const entry = await sealEntryPortable(bytesOf(o.accountEncKey), coin);
  const call: Any = await rt.createUnprovenCallTxFromInitialStates(
    NO_KEY_MATERIAL,
    {
      compiledContract: rt.accountCompiled,
      contractAddress: norm(o.account),
      circuitId: 'deposit_shielded',
      args: [coin, entry],
      coinPublicKey: norm(o.keys.coinPublicKey),
      initialContractState: o.states.contractState,
      initialZswapChainState: o.states.zswapChainState,
      ledgerParameters: o.states.ledgerParameters,
    },
    norm(o.keys.encryptionPublicKey),
  );
  return { kind: 'return', unproven: call.private.unprovenTx, amount: o.amount, blockHash: o.states.blockHash };
}

/** The shape every second transaction must have (the relay checks the same, ../../../relay): one call
 *  of `entryPoint` on `contract`, no DUST spend, no unshielded offer, no transient, every output the
 *  call's own, a balanced shielded side. */
export function checkDraftShape(tx: Any, contract: string, entryPoint: string): void {
  const calls: { address: string; entryPoint: string }[] = [];
  let other = 0;
  let dust = 0;
  let unshielded = false;
  for (const intent of (tx.intents as Map<number, Any> | undefined)?.values() ?? []) {
    for (const a of intent.actions ?? []) {
      if (a?.address !== undefined && a?.entryPoint !== undefined && 'guaranteedTranscript' in a) {
        calls.push({
          address: norm(String(a.address)),
          entryPoint: typeof a.entryPoint === 'string' ? a.entryPoint : new TextDecoder().decode(a.entryPoint),
        });
      } else other += 1;
    }
    dust += (intent.dustActions?.spends?.length ?? 0) + (intent.dustActions?.registrations?.length ?? 0);
    if (intent.guaranteedUnshieldedOffer || intent.fallibleUnshieldedOffer) unshielded = true;
  }
  const fail = (m: string) => {
    throw new BuildError('unexpected-shape', m);
  };
  if (calls.length !== 1 || other > 0) fail(`expected one call, found ${calls.length + other} actions`);
  if (calls[0]!.address !== norm(contract) || calls[0]!.entryPoint !== entryPoint) {
    fail(`the call is ${calls[0]!.entryPoint} on ${calls[0]!.address}, not ${entryPoint} on ${norm(contract)}`);
  }
  if (dust > 0) fail('the transaction spends DUST (the market adds it)');
  if (unshielded) fail('the transaction moves unshielded tokens');
  const offers: Any[] = [];
  if (tx.guaranteedOffer) offers.push(tx.guaranteedOffer);
  for (const o of (tx.fallibleOffer as Map<number, Any> | undefined)?.values() ?? []) offers.push(o);
  for (const o of offers) {
    if ((o.transients?.length ?? 0) > 0) fail('the transaction has transient coins');
    for (const out of o.outputs ?? []) {
      if (!out.contractAddress || norm(String(out.contractAddress)) !== norm(contract)) {
        fail('an output goes elsewhere than the call (no change, no other recipient)');
      }
    }
  }
  const segments = new Set<number>([0, ...((tx.intents as Map<number, Any> | undefined)?.keys() ?? [])]);
  for (const s of segments) {
    for (const [token, delta] of tx.imbalances(s) as Map<Any, bigint>) {
      if (token?.tag !== 'dust' && delta !== 0n) fail('the shielded side is not balanced');
    }
  }
}

/** Balance a draft with the landing coin (computed path) and check its shape: the transaction the
 *  relay receives (hex, unproven). */
export async function balanceAndCheck(o: {
  networkId: string;
  draft: LockDraft | ReturnDraft;
  contract: string;
  state: Any;
  keys: LandingSpendKeys;
  coin: LandingCoinInfo;
}): Promise<{ hex: string; mtIndex: bigint }> {
  const { balanceWithLandingCoin } = await import('@nightmarket/core/bridge/landing-spend');
  const b = balanceWithLandingCoin(o.draft.unproven, o.state, o.keys, o.coin, o.networkId);
  checkDraftShape(b.tx, o.contract, o.draft.kind === 'lock' ? 'lockForSolana' : 'deposit_shielded');
  return { hex: hexOf(b.tx.serialize()), mtIndex: b.mtIndex };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
