// Minting demo tokens from the mint-test-tokens v2 faucets (effectstream/mint-test-tokens @ a51cf3a,
// `contracts/v2/shielded-token.compact`: a permissionless `mint(recipient: Either<ZswapCoinPublicKey,
// ContractAddress>, amount: Uint<64>, nonce: Bytes<32>)`), into a Night Market account.
//
// The faucet's JavaScript and keys are the key volume's `faucet` bundle: the vendored source
// (contracts/faucet/, byte-identical to upstream) compiled by the key job with compactc 0.34.0
// WITHOUT --feature-zkir-v3, which reproduces the verifier keys the stagenet faucets were deployed
// with (ZKIR v2; the module resolves compact-runtime 0.19.0, the SDK's). Before a faucet's first use
// its on-chain `mint` verifier key is compared with the volume's (`checkFaucet`), so the relay never
// proves against a faucet whose code differs.
//
// Two paths (packages/core/src/demo-tokens.ts `DemoTokenPath`):
//   - `direct`: ONE transaction per token: the faucet's `mint` to the account's contract address
//     and the account's `deposit_shielded(coin, entry)` receiving that exact coin, as two calls of
//     one intent (mint-test-tokens' composition recipe, test/receiver-transaction-composition.md,
//     without its issuer-call claim: the account has no `claimContractCall`), with the deposit
//     call's Zswap offer as the single output;
//   - `via-sponsor`: the faucet mints to the sponsor wallet's coin key, the wallet sees the coin,
//     then the sponsor deposits a coin of that colour into the account with `deposit_shielded`
//     (two transactions per token; the way any third party funds an account).
// Either way the inbox entry is sealed to the account's own encryption key (MIP-0012 §6.2), so the
// account's owner finds the coin, and the sponsor pays the DUST.

import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { Logger } from '../log.js';
import type { BeforeSubmit } from './action.js';
import type { PassportProviders, PassportRuntime } from '../passport/runtime.js';
import type { RelayWalletProvider, SponsorWalletHandle } from '../passport/wallet-provider.js';
import { verifierDigests } from '../prover/key-volume.js';
import type { ResolvedPackItem } from './pack.js';

/** The faucet circuit the relay proves. */
export const FAUCET_MINT_CIRCUIT = 'mint';
/** The key volume's faucet bundle. */
export const FAUCET_BUNDLE = 'faucet';

const unhex = (h: string) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ''), 'hex'));
const sha256Hex = async (b: Uint8Array) => (await import('node:crypto')).createHash('sha256').update(b).digest('hex');

export class FaucetError extends Error {
  override name = 'FaucetError';
}

type Either = { is_left: boolean; left: { bytes: Uint8Array }; right: { bytes: Uint8Array } };
const toUser = (coinPublicKey: Uint8Array): Either => ({
  is_left: true,
  left: { bytes: coinPublicKey },
  right: { bytes: new Uint8Array(32) },
});
const toContract = (address: Uint8Array): Either => ({
  is_left: false,
  left: { bytes: new Uint8Array(32) },
  right: { bytes: address },
});

interface ShieldedCoinInfo {
  nonce: Uint8Array;
  color: Uint8Array;
  value: bigint;
}

export interface MintOutcome {
  mintAndDeposit?: string;
  mint?: string;
  deposit?: string;
}

/** The faucet side of the demo-token path: its compiled contract, its keys, and the two mint paths. */
export class DemoFaucets {
  private compiled: unknown = null;
  private zk: unknown = null;
  private readonly checked = new Set<string>();

  constructor(
    private readonly rt: PassportRuntime,
    private readonly log: Logger,
  ) {}

  private get bundleDir(): string {
    return join(this.rt.options.managedPath, FAUCET_BUNDLE);
  }

  /** The compiled faucet (the key volume's `faucet` bundle), loaded once. */
  private async load(): Promise<{ compiled: unknown; zk: unknown }> {
    if (this.compiled && this.zk) return { compiled: this.compiled, zk: this.zk };
    const mod = (await import(pathToFileURL(join(this.bundleDir, 'contract', 'index.js')).href)) as {
      Contract: unknown;
    };
    const { CompiledContract } = await import('@midnight-ntwrk/compact-js');
    const { NodeZkConfigProvider } = await import('@midnight-ntwrk/midnight-js-node-zk-config-provider');
    const cc = CompiledContract as unknown as {
      make(tag: string, c: unknown): { pipe(...ops: unknown[]): unknown };
      withVacantWitnesses: unknown;
      withCompiledFileAssets(p: string): unknown;
    };
    this.compiled = cc
      .make('night-market-demo-faucet', mod.Contract)
      .pipe(cc.withVacantWitnesses, cc.withCompiledFileAssets(this.bundleDir));
    this.zk = new NodeZkConfigProvider(this.bundleDir);
    return { compiled: this.compiled, zk: this.zk };
  }

  /** The faucet at `address` carries the volume's `mint` verifier key (FR-005 for the faucets). */
  async checkFaucet(address: string): Promise<void> {
    if (this.checked.has(address)) return;
    const ours = verifierDigests(this.bundleDir)[FAUCET_MINT_CIRCUIT];
    if (!ours) throw new FaucetError('the key volume has no faucet mint verifier key');
    const pdp = this.rt.publicDataProvider as {
      queryContractState(
        a: string,
      ): Promise<{ operation(op: string): { verifierKey?: Uint8Array } | undefined } | null>;
    };
    const state = await pdp.queryContractState(address);
    if (!state) throw new FaucetError(`no faucet contract at ${address.slice(0, 16)}…`);
    const vk = state.operation(FAUCET_MINT_CIRCUIT)?.verifierKey;
    if (!vk) throw new FaucetError(`the contract at ${address.slice(0, 16)}… has no mint operation`);
    if ((await sha256Hex(vk)) !== ours) {
      throw new FaucetError(
        `the faucet at ${address.slice(0, 16)}… is not the mint-test-tokens v2 faucet this relay proves for`,
      );
    }
    this.checked.add(address);
  }

  private providersFor(base: PassportProviders, zk: unknown): Record<string, unknown> {
    return {
      publicDataProvider: base.publicDataProvider,
      zkConfigProvider: zk,
      proofProvider: base.proofProvider,
      walletProvider: base.walletProvider,
      midnightProvider: base.midnightProvider,
    };
  }

  /** The first half of `via-sponsor`: mint `item` to the sponsor wallet's own coin key and wait
   *  until the wallet holds it. Returns the mint's transaction id. */
  async mintToSponsor(o: {
    wallet: SponsorWalletHandle;
    item: ResolvedPackItem;
    stage?: (name: string, detail?: Record<string, string>) => void;
    /** Told just before the mint is submitted (AA 00047 P10, R2-7: the claim's pending state). */
    beforeSubmit?: BeforeSubmit;
  }): Promise<string> {
    const { compiled, zk } = await this.load();
    await this.checkFaucet(o.item.faucet);
    const { submitCallTx } = await import('@midnight-ntwrk/midnight-js-contracts');
    const amount = BigInt(o.item.amount);
    const base = await this.rt.providers(o.wallet);
    const wp = base.walletProvider as RelayWalletProvider;
    const before = await shieldedBalance(o.wallet, o.item.colour);
    // No inbox entry to find it by: an interrupted mint to the sponsor is quarantined, not minted again.
    o.beforeSubmit?.({ stage: 'mint' });
    const minted = (await (submitCallTx as unknown as (p: unknown, opts: unknown) => Promise<unknown>)(
      this.providersFor(base, zk),
      {
        compiledContract: compiled,
        contractAddress: o.item.faucet,
        circuitId: FAUCET_MINT_CIRCUIT,
        args: [toUser(unhex(wp.getCoinPublicKey())), amount, new Uint8Array(randomBytes(32))],
      },
    )) as { public?: { txId?: string } };
    const mintTx = String(minted.public?.txId ?? '');
    o.stage?.('minted', { symbol: o.item.symbol, tx: mintTx });
    await waitForShieldedBalance(o.wallet, o.item.colour, before + amount, 180_000);
    return mintTx;
  }

  /** `via-sponsor`: mint to the sponsor wallet, wait for the coin, deposit it into the account. */
  async viaSponsor(o: {
    wallet: SponsorWalletHandle;
    account: string;
    encKey: Uint8Array;
    item: ResolvedPackItem;
    stage: (name: string, detail?: Record<string, string>) => void;
    beforeSubmit?: BeforeSubmit;
  }): Promise<MintOutcome> {
    const mintTx = await this.mintToSponsor(o);
    const amount = BigInt(o.item.amount);
    const base = await this.rt.providers(o.wallet);
    const { sealEntryPortable } = await import('@nightmarket/core/passport');
    const coin = { nonce: new Uint8Array(randomBytes(32)), color: unhex(o.item.colour), value: amount };
    const entry = await sealEntryPortable(o.encKey, coin);
    const custody = (await (
      this.rt.client.account as {
        CustodyAccount: {
          connect(
            p: unknown,
            c: unknown,
            a: string,
          ): Promise<{ depositShielded(c: unknown, e: Uint8Array): Promise<{ txId: string }> }>;
        };
      }
    ).CustodyAccount.connect(base, this.rt.compiledAccount(), o.account)) as {
      depositShielded(c: unknown, e: Uint8Array): Promise<{ txId: string }>;
    };
    // The deposit files `entry` into the account's inbox: how an interrupted deposit is found (R2-7).
    o.beforeSubmit?.({ stage: 'deposit', entry });
    const dep = await custody.depositShielded(coin, entry);
    o.stage('deposited', { symbol: o.item.symbol, tx: dep.txId });
    return { mint: mintTx, deposit: dep.txId };
  }

  /** `direct`: the faucet's mint to the account and the account's deposit, in ONE transaction. */
  async direct(o: {
    wallet: SponsorWalletHandle;
    account: string;
    encKey: Uint8Array;
    item: ResolvedPackItem;
    networkId: string;
    stage: (name: string, detail?: Record<string, string>) => void;
    beforeSubmit?: BeforeSubmit;
  }): Promise<MintOutcome> {
    const { compiled, zk } = await this.load();
    await this.checkFaucet(o.item.faucet);
    const contracts = (await import('@midnight-ntwrk/midnight-js-contracts')) as unknown as {
      createUnprovenCallTx(p: unknown, opts: unknown): Promise<RawCall & { private: { result: unknown } }>;
      getPublicStates(pdp: unknown, address: string): Promise<{ contractState: { serialize(): Uint8Array } }>;
      submitTx(p: unknown, opts: unknown): Promise<{ txId?: string }>;
    };
    const ledger = (await import('@midnightntwrk/ledger-v9')) as unknown as LedgerV9;
    const types = (await import('@midnight-ntwrk/midnight-js-types')) as unknown as MidnightJsTypes;
    const amount = BigInt(o.item.amount);
    const base = await this.rt.providers(o.wallet);

    const faucetProviders = this.providersFor(base, zk);
    const faucetState = (await contracts.getPublicStates(base.publicDataProvider, o.item.faucet)).contractState;
    const accountState = (await contracts.getPublicStates(base.publicDataProvider, o.account)).contractState;
    const mintCall = await contracts.createUnprovenCallTx(faucetProviders, {
      compiledContract: compiled,
      contractAddress: o.item.faucet,
      circuitId: FAUCET_MINT_CIRCUIT,
      args: [toContract(unhex(o.account)), amount, new Uint8Array(randomBytes(32))],
    });
    const coin = mintCall.private.result as ShieldedCoinInfo;
    if (!coin || coin.value !== amount) throw new FaucetError('the faucet call did not return the minted coin');

    const { sealEntryPortable } = await import('@nightmarket/core/passport');
    const entry = await sealEntryPortable(o.encKey, { nonce: coin.nonce, color: coin.color, value: coin.value });
    const custody = (await (
      this.rt.client.account as {
        CustodyAccount: {
          connect(p: unknown, c: unknown, a: string, s?: unknown): Promise<{ privateStateId: string }>;
        };
      }
    ).CustodyAccount.connect(base, this.rt.compiledAccount(), o.account)) as { privateStateId: string };
    const depositCall = await contracts.createUnprovenCallTx(base, {
      compiledContract: this.rt.compiledAccount(),
      contractAddress: o.account,
      circuitId: 'deposit_shielded',
      privateStateId: custody.privateStateId,
      args: [coin, entry],
    });

    const ttl = new Date(Date.now() + 60 * 60 * 1000);
    const intent = ledger.Intent.new(ttl)
      .addCall(prototype(ledger, types, o.item.faucet, FAUCET_MINT_CIRCUIT, faucetState, mintCall))
      .addCall(prototype(ledger, types, o.account, 'deposit_shielded', accountState, depositCall));
    const receiverTx = depositCall.private.unprovenTx as {
      guaranteedOffer?: unknown;
      fallibleOffer?: Map<number, unknown>;
    };
    const fallible = [...(receiverTx.fallibleOffer?.values() ?? [])];
    if (fallible.length > 1) throw new FaucetError('the deposit call has more than one fallible offer');
    const tx = ledger.Transaction.fromPartsRandomized(o.networkId, receiverTx.guaranteedOffer, fallible[0], intent);

    const routing = await routingZkConfig(zk, this.rt.zkConfigProvider);
    // AA 00047 P10, R2-7: the claim records this token as pending (the entry the transaction files,
    // and its TTL) BEFORE it is submitted.
    o.beforeSubmit?.({ stage: 'mint-and-deposit', entry, notAfter: Math.floor(ttl.getTime() / 1000) });
    const submitted = await contracts.submitTx(
      { ...faucetProviders, zkConfigProvider: routing },
      { unprovenTx: tx, circuitId: [FAUCET_MINT_CIRCUIT, 'deposit_shielded'] },
    );
    const txId = String(submitted.txId ?? '');
    o.stage('minted-and-deposited', { symbol: o.item.symbol, tx: txId });
    this.log.info('demo token minted straight into the account', { symbol: o.item.symbol, tx: txId });
    return { mintAndDeposit: txId };
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

interface RawCall {
  public: { partitionedTranscript: [unknown, unknown] };
  private: {
    input: unknown;
    output: unknown;
    privateTranscriptOutputs: unknown[];
    unprovenTx: unknown;
  };
}

interface LedgerV9 {
  ContractState: { deserialize(b: Uint8Array): { operation(id: string): unknown } };
  ContractCallPrototype: new (...a: unknown[]) => unknown;
  communicationCommitmentRandomness(): unknown;
  Intent: { new: (ttl: Date) => LedgerV9Intent };
  Transaction: { fromPartsRandomized(n: string, g: unknown, f: unknown, i: unknown): unknown };
}
interface LedgerV9Intent {
  addCall(c: unknown): LedgerV9Intent;
}

/**
 * One call of the composed intent. Its key location is midnight-js's CONTRACT key location (the
 * address, the circuit and its verifier key's hash), as `createUnprovenCallTx` gives a call: the
 * relay's proof provider resolves the bundle by it (a bare circuit id would read as a protocol
 * builtin, and the proof server refuses its check).
 */
function prototype(
  ledger: LedgerV9,
  types: MidnightJsTypes,
  address: string,
  circuitId: string,
  state: { serialize(): Uint8Array },
  call: RawCall,
): unknown {
  const operation = ledger.ContractState.deserialize(state.serialize()).operation(circuitId) as
    { verifierKey?: Uint8Array } | undefined;
  if (!operation?.verifierKey) throw new FaucetError(`no ${circuitId} operation at ${address.slice(0, 16)}…`);
  const keyLocation = types.encodeContractKeyLocation({
    contractAddress: address,
    circuitId,
    verifierKeyHash: types.hashVerifierKey(operation.verifierKey),
  });
  return new ledger.ContractCallPrototype(
    address,
    circuitId,
    operation,
    call.public.partitionedTranscript[0],
    call.public.partitionedTranscript[1],
    call.private.privateTranscriptOutputs,
    call.private.input,
    call.private.output,
    ledger.communicationCommitmentRandomness(),
    keyLocation,
  );
}

interface MidnightJsTypes {
  encodeContractKeyLocation(o: { contractAddress: string; circuitId: string; verifierKeyHash: string }): string;
  hashVerifierKey(vk: Uint8Array): string;
}

/** A ZK config provider that serves the faucet's `mint` from the faucet bundle and every other
 *  circuit from the account bundle (midnight-js asks per circuit id). */
async function routingZkConfig(faucet: unknown, account: unknown): Promise<unknown> {
  const { ZKConfigProvider } = await import('@midnight-ntwrk/midnight-js-types');
  type Zk = {
    getProverKey(id: string): Promise<unknown>;
    getVerifierKey(id: string): Promise<unknown>;
    getZKIR(id: string): Promise<unknown>;
  };
  const route = (id: string) => (id === FAUCET_MINT_CIRCUIT ? faucet : account) as Zk;
  const Base = ZKConfigProvider as unknown as new () => object;
  class Routing extends Base {
    getProverKey(id: string) {
      return route(id).getProverKey(id);
    }
    getVerifierKey(id: string) {
      return route(id).getVerifierKey(id);
    }
    getZKIR(id: string) {
      return route(id).getZKIR(id);
    }
  }
  return new Routing();
}

/** The synced wallet's shielded balance of a colour (base units). */
async function shieldedBalance(handle: SponsorWalletHandle, colour: string): Promise<bigint> {
  const Rx = await import('rxjs');
  const state = (await Rx.firstValueFrom(
    handle.wallet.state().pipe(Rx.filter((s: unknown) => (s as { isSynced?: boolean }).isSynced === true)) as never,
  )) as { shielded: { balances: Record<string, bigint> } };
  return state.shielded.balances[colour] ?? 0n;
}

/** Wait until the wallet's synced shielded balance of `colour` reaches `atLeast`. */
async function waitForShieldedBalance(
  handle: SponsorWalletHandle,
  colour: string,
  atLeast: bigint,
  timeoutMs: number,
): Promise<void> {
  const Rx = await import('rxjs');
  await Rx.firstValueFrom(
    handle.wallet.state().pipe(
      Rx.filter((s: unknown) => {
        const st = s as { isSynced?: boolean; shielded?: { balances?: Record<string, bigint> } };
        return st.isSynced === true && (st.shielded?.balances?.[colour] ?? 0n) >= atLeast;
      }),
      Rx.timeout({ first: timeoutMs }),
    ) as never,
  ).catch(() => {
    throw new FaucetError('the minted demo tokens did not reach the sponsor wallet in time');
  });
}
