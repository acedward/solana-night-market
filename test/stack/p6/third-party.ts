// AA 00047 P11.I: a THIRD PARTY on the local stack, in-process in market-flows.ts: anyone with a funded
// Midnight wallet (a localnet development seed that is neither the relay's sponsor nor the mock
// batcher's, THIRD_PARTY_SEED_FILE), proving with the relay's own runtime (the key volume) on the
// stack's contract prover. What round 3's live negatives need that the market's relay never does:
//
//   deployBomb      a market account deployed through the client's own wave deploy (wave 1, then the
//                   update that adds wave 2 and retires the authority) and activated, whose deploy-time
//                   state is the honest constructor's EXCEPT `round` (top-level slot 0), set to
//                   2^64 - 4: auditor A's time bomb (R3-1, `audit-a3-probe-round.ts`), deployed for real
//   mintShielded    a shielded test token minted to this wallet by its faucet (mint-test-tokens v2)
//   depositShielded the account's permissionless `deposit_shielded(coin, entry)`: any coin this wallet
//                   pays, with ANY inbox entry (a counterfeit note, R3-3/R3-6)
//   rotateKey       the account's `rotate_enc_key_with_ed25519` with a signature the device gave a page:
//                   a hostile page that proves and pays itself (Q50: the market's relay lands only the
//                   account's opening key, so a page cannot use it for this)
//
// Only public values are returned; the seed is read from its file in-process.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseSponsorSeed } from '../../../relay/src/config.js';
import { DemoFaucets } from '../../../relay/src/demo/faucet.js';
import { createLogger } from '../../../relay/src/log.js';
import { MemoryPrivateStateProvider } from '../../../relay/src/passport/private-state.js';
import { PassportRuntime } from '../../../relay/src/passport/runtime.js';
import type { SponsorWalletHandle } from '../../../relay/src/passport/wallet-provider.js';
import { openFacadeWallet } from '../../../relay/src/sponsor/facade.js';

export interface ThirdPartyOptions {
  seedFile: string;
  networkId: string;
  indexerUrl: string;
  indexerWsUrl: string;
  nodeWsUrl: string;
  contractProofServerUrl: string;
  dustProofServerUrl: string;
  managedPath: string;
  feeBlocksMargin?: number;
}

/** A token of the stack's registry (tokens.json). */
export interface StackToken {
  symbol: string;
  decimals: number;
  midnightColour: string;
  contract: string;
  domainSeparator: string;
}

type Custody = {
  depositShielded(c: { nonce: Uint8Array; color: Uint8Array; value: bigint }, e: Uint8Array): Promise<{ txId: string }>;
  rotateEncKeyWithAuth(k: Uint8Array, a: unknown): Promise<{ txId: string }>;
};

/** 2^64 - 4: three increments from the checked cast's overflow (auditor A's probe). */
export const BOMB_ROUND = 18446744073709551615n - 3n;

const unhex = (h: string) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ''), 'hex'));

export async function openThirdParty(o: ThirdPartyOptions) {
  const log = createLogger({ level: 'warn' }, { service: 'third-party' });
  const rt = await PassportRuntime.load({
    managedPath: o.managedPath,
    networkId: o.networkId,
    indexerUrl: o.indexerUrl,
    indexerWsUrl: o.indexerWsUrl,
    contractProofServerUrl: o.contractProofServerUrl,
    log,
  });
  const opened = await openFacadeWallet(
    parseSponsorSeed(readFileSync(o.seedFile, 'utf8')),
    {
      networkId: o.networkId,
      indexerUrl: o.indexerUrl,
      indexerWsUrl: o.indexerWsUrl,
      nodeWsUrl: o.nodeWsUrl,
      dustProofServerUrl: o.dustProofServerUrl,
    },
    { feeBlocksMargin: o.feeBlocksMargin ?? 20 },
  );
  const handle = opened.handle as SponsorWalletHandle;
  const faucets = new DemoFaucets(rt, log);

  const custodyOf = async (account: string): Promise<Custody> =>
    (await rt.client.account.CustodyAccount.connect(
      await rt.providers(handle),
      rt.compiledAccount(),
      account,
      rt.client.witnesses.emptyCoinStore(),
    )) as unknown as Custody;

  return {
    rt,
    handle,
    /** The synced wallet's balances (public): NIGHT and every token, shielded and unshielded, and DUST. */
    async balances(): Promise<Record<string, unknown>> {
      const Rx = await import('rxjs');
      const st = (await Rx.firstValueFrom(
        handle.wallet.state().pipe(
          Rx.filter((s: unknown) => (s as { isSynced?: boolean }).isSynced === true),
          Rx.timeout({ first: 180_000 }),
        ) as never,
      )) as {
        shielded?: { balances?: Record<string, bigint> };
        unshielded?: { balances?: Record<string, bigint> };
        dust?: { walletBalance?(t: Date): bigint; balance?(t: Date): bigint };
      };
      const dust = st.dust?.walletBalance?.(new Date()) ?? st.dust?.balance?.(new Date()) ?? null;
      const str = (m?: Record<string, bigint>) =>
        Object.fromEntries(Object.entries(m ?? {}).map(([k, v]) => [k.slice(0, 16), v.toString(10)]));
      return {
        shielded: str(st.shielded?.balances),
        unshielded: str(st.unshielded?.balances),
        dustSpecks: dust === null ? null : String(dust),
      };
    },
    /** Mint `amount` base units of `token` to this wallet (its faucet's `mint`), waiting for the coin. */
    async mintShielded(token: StackToken, amount: bigint): Promise<string> {
      return faucets.mintToSponsor({
        wallet: handle,
        item: {
          symbol: token.symbol,
          colour: token.midnightColour,
          decimals: token.decimals,
          amount: amount.toString(10),
          faucet: token.contract,
          domainSeparator: token.domainSeparator,
        },
      });
    },
    /** The account's permissionless `deposit_shielded(coin, entry)`, paid by this wallet. */
    async depositShielded(
      account: string,
      coin: { nonce: string; color: string; value: bigint },
      entry: Uint8Array,
    ): Promise<{ txId: string; seconds: number }> {
      const t0 = Date.now();
      const custody = await custodyOf(account);
      // This wallet pays from its own coins: right after its previous payment, its only coin may be the
      // change still on its way (not spendable yet). Wait for it, a few times, then give up.
      for (let attempt = 0; ; attempt++) {
        try {
          const r = await custody.depositShielded(
            { nonce: unhex(coin.nonce), color: unhex(coin.color), value: coin.value },
            entry,
          );
          return { txId: String(r.txId), seconds: (Date.now() - t0) / 1000 };
        } catch (e) {
          const m = String((e as Error)?.message ?? e);
          if (attempt >= 20 || !/insufficient|not enough|InsufficientFunds|no coins|balance/i.test(m)) throw e;
          await new Promise((res) => setTimeout(res, 3_000));
        }
      }
    },
    /** `rotate_enc_key_with_ed25519(newKey, auth)` with the device's signature, proven and paid here. */
    async rotateKey(account: string, newKey: string, auth: unknown): Promise<{ txId: string; seconds: number }> {
      const t0 = Date.now();
      const custody = await custodyOf(account);
      const r = await custody.rotateEncKeyWithAuth(unhex(newKey), auth);
      return { txId: String(r.txId), seconds: (Date.now() - t0) / 1000 };
    },
    /**
     * Auditor A's time bomb, deployed for real (R3-1): the market's own account contract and waves,
     * through the client's `deployDormant` (wave 1, then the update adding wave 2 and retiring the
     * authority) and activated for `device`, with ONE change: the constructor's state has `round` (its
     * top-level slot 0) = `round`. Everything else is the honest constructor's for these arguments.
     */
    async deployBomb(o: {
      device: unknown;
      encPublicKey: Uint8Array;
      round?: bigint;
    }): Promise<{ account: string; txs: string[]; seconds: number }> {
      const t0 = Date.now();
      const round = o.round ?? BOMB_ROUND;
      const privateState = new MemoryPrivateStateProvider();
      try {
        const providers = await rt.providers(handle, privateState);
        const { compactJs, contract, shape, witnesses } = rt.client as unknown as {
          compactJs: {
            CompiledContract: {
              make(t: string, c: unknown): { pipe(...o: unknown[]): unknown };
              withWitnesses(w: unknown): unknown;
              withCompiledFileAssets(p: string): unknown;
            };
          };
          contract: { Contract: new (...a: unknown[]) => object };
          shape: {
            restrictToAccountShape(c: unknown): new (...a: unknown[]) => { initialState(...a: unknown[]): unknown };
            accountWaves(): { waveOne: string[]; waveTwo: string[] };
          };
          witnesses: { makeWitnesses(): unknown };
        };
        const crt = (await import('@midnight-ntwrk/compact-runtime-0.20')) as unknown as {
          CompactTypeUnsignedInteger: new (
            max: bigint,
            bytes: number,
          ) => {
            toValue(v: bigint): Uint8Array[];
            alignment(): unknown[];
          };
        };
        const u64 = new crt.CompactTypeUnsignedInteger(18446744073709551615n, 8);
        const Honest = shape.restrictToAccountShape(contract.Contract);
        class TimeBomb extends Honest {
          // The generated constructor is async (compactc 0.35.0): forge its resolved result.
          override initialState(...args: unknown[]): unknown {
            return Promise.resolve(super.initialState(...args)).then((r) => forgeDeployRound(r, u64, round));
          }
        }
        const cc = compactJs.CompiledContract;
        const compiled = cc
          .make('account', TimeBomb)
          .pipe(
            cc.withWitnesses(witnesses.makeWitnesses()),
            cc.withCompiledFileAssets(join(rt.options.managedPath, 'account')),
          );
        const waves = shape.accountWaves();
        const dormant = await (
          rt.client.account as unknown as {
            CustodyAccount: {
              deployDormant(
                p: unknown,
                c: unknown,
                d: unknown,
                k: unknown,
                opts: unknown,
              ): Promise<{ address: string; salt: Uint8Array; activate(d: unknown, s: Uint8Array): Promise<unknown> }>;
            };
          }
        ).CustodyAccount.deployDormant(
          providers,
          compiled,
          o.device,
          { publicKey: o.encPublicKey, secretKey: undefined },
          { waveOneCircuits: waves.waveOne, waveTwoCircuits: waves.waveTwo, armsInWaveTwo: [], retireAuthority: true },
        );
        await dormant.activate(o.device, dormant.salt);
        const account = String(dormant.address).replace(/^0x/, '').toLowerCase();
        const submitted = (providers.walletProvider as unknown as { submitted: { txId: string }[] }).submitted;
        return { account, txs: submitted.map((s) => s.txId), seconds: (Date.now() - t0) / 1000 };
      } finally {
        privateState.wipe();
      }
    },
    async stop() {
      await opened.stop().catch(() => undefined);
    },
  };
}

export type ThirdParty = Awaited<ReturnType<typeof openThirdParty>>;

/**
 * The constructor's result (compact-runtime 0.20's `initialState`) with ONE change: `round`, the
 * top-level slot 0 of its ledger state, set to `round` (auditor A's probe, `audit-a3-probe-round.ts`).
 * The runtime's classes are taken from the state's own instances (the contract module's copy).
 */
export function forgeDeployRound(
  result: unknown,
  u64: { toValue(v: bigint): Uint8Array[]; alignment(): unknown[] },
  round: bigint,
): unknown {
  const r = result as { currentContractState: { data: { state?: unknown } } };
  const data = r.currentContractState.data;
  const sv = (data.state ?? data) as {
    asArray(): unknown[];
    constructor: {
      newArray(): { arrayPush(v: unknown): unknown };
      newCell(c: { value: Uint8Array[]; alignment: unknown[] }): unknown;
    };
  };
  const Charged = (data as { constructor: new (s: unknown) => unknown }).constructor;
  const fields = sv.asArray();
  const cell = sv.constructor.newCell({ value: u64.toValue(round), alignment: u64.alignment() });
  let forged = sv.constructor.newArray();
  for (let i = 0; i < fields.length; i++) forged = forged.arrayPush(i === 0 ? cell : fields[i]) as typeof forged;
  r.currentContractState.data = new Charged(forged) as never;
  return r;
}
