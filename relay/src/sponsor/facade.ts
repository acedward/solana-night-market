// The real sponsor session: one wallet-sdk facade, opened once, kept synced, watching its DUST.
//
// The SDK is loaded lazily inside `openFacadeWallet`, so importing this module (tests, health)
// costs nothing and never connects anywhere. The wallet construction mirrors the pinned Passport
// client's `createWallet` (vendor/passport/contract/src/node/wallet.ts @ 51c1fb4), with every
// endpoint passed in rather than read from the environment, and the fee margin configurable
// (the SDK default of 100 blocks burns far more DUST than needed; 5 is the tested value).
//
// When a funding-lock path is configured (a live seed shared with other tools), the lock is
// taken BEFORE the wallet opens and released after it closes; a held lock stops the relay.
//
// The DUST the session reports is the settled balance (./dust-reading.ts, issue 00049): the
// wallet's own balance loses the whole output a transaction in flight spends, so the session adds
// back the outputs locked by spends in flight, minus their fees, until their change arrives.

import type * as HdModule from '@midnightntwrk/wallet-sdk-hd';

import type { Logger } from '../log.js';
import {
  type DustOutputView,
  type DustWalletView,
  nullifierKey,
  type PendingDustSpendView,
  SettledDustTracker,
} from './dust-reading.js';
import { type FundingLock, takeFundingLock } from './funding-lock.js';
import { ExclusiveSponsorSession, type SponsorState, type SponsorStatus, type SponsorWallet } from './session.js';

export interface WalletEndpoints {
  networkId: string;
  indexerUrl: string;
  indexerWsUrl: string;
  nodeWsUrl: string;
  /** The wallet's proving server: it proves only the DUST spends, so it is the DUST prover
   *  (proof server 9.0.0-rc.6 while stagenet requires dust/9), never the contract prover (rc.8). */
  dustProofServerUrl: string;
}

export interface OpenedWallet {
  /** What lanes receive through withWallet: the facade and its keys. */
  handle: SponsorWallet;
  /** Every wallet state: synced, the wallet's own DUST balance, and (the real wallet) the outputs it
   *  can spend now, which the session needs to count the outputs a spend in flight locks. */
  subscribe(onState: (s: DustWalletView) => void, onError: (e: unknown) => void): () => void;
  stop(): Promise<void>;
}

export type WalletFactory = (
  seedHex: string,
  endpoints: WalletEndpoints,
  options: { feeBlocksMargin: number },
) => Promise<OpenedWallet>;

export interface FacadeSessionConfig {
  seedHex: string;
  endpoints: WalletEndpoints;
  feeBlocksMargin: number;
  fundingLockFile: string | null;
  purpose: string;
}

export class FacadeSponsorSession extends ExclusiveSponsorSession {
  private state: SponsorState = 'stopped';
  private synced = false;
  private dust: bigint | null = null;
  private dustInFlight: bigint | null = null;
  private lockedOutputs = 0;
  private readonly dustTracker = new SettledDustTracker();
  private lastError: string | undefined;
  private lock: FundingLock | null = null;
  private opened: OpenedWallet | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly config: FacadeSessionConfig,
    private readonly factory: WalletFactory,
    private readonly log: Logger,
  ) {
    super();
  }

  async start(): Promise<void> {
    if (this.state !== 'stopped' && this.state !== 'error') return;
    this.state = 'starting';
    this.lastError = undefined;
    try {
      if (this.config.fundingLockFile) {
        this.lock = takeFundingLock(this.config.fundingLockFile, this.config.purpose);
        this.log.info('funding lock taken', { lockFile: this.config.fundingLockFile });
      }
      this.opened = await this.factory(this.config.seedHex, this.config.endpoints, {
        feeBlocksMargin: this.config.feeBlocksMargin,
      });
      this.state = 'syncing';
      this.unsubscribe = this.opened.subscribe(
        (s) => {
          this.synced = s.synced;
          const settled = this.dustTracker.observe(s);
          if (settled.lockedOutputs !== this.lockedOutputs) {
            this.log.info('sponsor DUST outputs locked by transactions in flight', {
              outputs: settled.lockedOutputs,
              inFlightSpecks: settled.inFlightSpecks.toString(10),
              inFlightFeeSpecks: settled.inFlightFeeSpecks.toString(10),
              walletSpecks: s.dustSpecks.toString(10),
            });
            this.lockedOutputs = settled.lockedOutputs;
          }
          this.dust = settled.specks;
          this.dustInFlight = settled.inFlightSpecks;
          if (this.state === 'syncing' || this.state === 'synced') this.state = s.synced ? 'synced' : 'syncing';
        },
        (e) => {
          this.state = 'error';
          this.synced = false;
          this.lastError = 'the sponsor wallet lost its connection';
          this.log.warn('sponsor wallet error', { error: e });
        },
      );
      this.log.info('sponsor wallet opened');
    } catch (e) {
      this.state = 'error';
      this.lastError = 'the sponsor wallet could not be opened';
      this.lock?.release();
      this.lock = null;
      throw e;
    }
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    try {
      await this.opened?.stop();
    } finally {
      this.opened = null;
      this.synced = false;
      this.dustTracker.reset();
      this.dustInFlight = null;
      this.lockedOutputs = 0;
      this.state = 'stopped';
      this.lock?.release();
      this.lock = null;
    }
  }

  status(): SponsorStatus {
    return {
      configured: true,
      state: this.state,
      synced: this.synced && this.state === 'synced',
      dustSpecks: this.dust,
      ...(this.dustInFlight === null ? {} : { dustInFlightSpecks: this.dustInFlight }),
      ...(this.lastError ? { error: this.lastError } : {}),
    };
  }

  protected wallet(): SponsorWallet {
    if (!this.opened) throw new Error('the sponsor wallet is not open');
    return this.opened.handle;
  }
}

// ── The wallet-sdk factory (not exercised in P1: no live wallet is opened) ────

/** No transaction history is kept: the relay reads chain state from the indexer. */
const NoopTxHistoryStorage = {
  gotPending: async () => undefined,
  gotFinalized: async () => undefined,
  gotRejected: async () => undefined,
  getAll: async () => [] as unknown[],
  get: async () => undefined,
  serialize: async () => '[]',
};

export const openFacadeWallet: WalletFactory = async (seedHex, endpoints, options) => {
  const [ledger, facadeMod, dustMod, hdMod, shieldedMod, unshieldedMod] = await Promise.all([
    import('@midnightntwrk/ledger-v9'),
    import('@midnightntwrk/wallet-sdk-facade'),
    import('@midnightntwrk/wallet-sdk-dust-wallet'),
    import('@midnightntwrk/wallet-sdk-hd'),
    import('@midnightntwrk/wallet-sdk-shielded'),
    import('@midnightntwrk/wallet-sdk-unshielded-wallet'),
  ]);
  if (!('WebSocket' in globalThis)) {
    const { WebSocket } = await import('ws');
    (globalThis as { WebSocket?: unknown }).WebSocket = WebSocket;
  }

  const keys = deriveSponsorKeys(hdMod, seedHex);
  const shieldedSecretKeys = ledger.ZswapSecretKeys.fromSeed(keys.zswap);
  const dustSecretKey = ledger.DustSecretKey.fromSeed(keys.dust);
  const unshieldedKeystore = unshieldedMod.createKeystore(
    { kind: 'schnorr', secret: keys.night } as never,
    endpoints.networkId as never,
  );

  const configuration = {
    networkId: endpoints.networkId,
    indexerClientConnection: { indexerHttpUrl: endpoints.indexerUrl, indexerWsUrl: endpoints.indexerWsUrl },
    provingServerUrl: new URL(endpoints.dustProofServerUrl),
    relayURL: new URL(endpoints.nodeWsUrl),
    costParameters: { feeBlocksMargin: options.feeBlocksMargin },
    txHistoryStorage: NoopTxHistoryStorage,
  };
  type Facade = Awaited<ReturnType<typeof facadeMod.WalletFacade.init>>;
  const init = facadeMod.WalletFacade.init as unknown as (p: Record<string, unknown>) => Promise<Facade>;
  const wallet = await init({
    configuration,
    shielded: (c: never) => shieldedMod.ShieldedWallet(c).startWithSecretKeys(shieldedSecretKeys),
    unshielded: (c: never) =>
      unshieldedMod.UnshieldedWallet(c).startWithPublicKey(unshieldedMod.PublicKey.fromKeyStore(unshieldedKeystore)),
    dust: (c: never) =>
      dustMod.DustWallet(c).startWithSecretKey(dustSecretKey, ledger.LedgerParameters.initialParameters().dust),
  });
  await wallet.start(shieldedSecretKeys, dustSecretKey);

  return {
    handle: { wallet, shieldedSecretKeys, dustSecretKey, unshieldedKeystore },
    subscribe(onState, onError) {
      // Nullifiers only while synced: an output is locked only between two synced readings.
      const nullifierOf = (token: unknown) => nullifierKey(ledger.dustNullifier(token as never, dustSecretKey));
      const sub = wallet.state().subscribe({
        next: (s: { isSynced: boolean; dust: DustStateView; pending?: PendingTransactionsView }) => {
          const synced = s.isSynced === true;
          onState({
            synced,
            dustSpecks: s.dust.balance(new Date()) as bigint,
            ...dustOutputsOf(s.dust, synced ? nullifierOf : undefined),
            ...pendingSpendsOf(s.pending),
          });
        },
        error: onError,
      });
      return () => sub.unsubscribe();
    },
    stop: () => wallet.stop(),
  };
};

/** What the relay reads of wallet-sdk-dust-wallet 5.0.0-beta.2's `DustWalletState`. */
export interface DustStateView {
  balance(t: Date): unknown;
  /** The outputs the wallet can spend now (`DustFullInfo[]`, valued at the wallet's sync time);
   *  `token` is the output itself (a ledger `QualifiedDustOutput`). */
  readonly availableCoins?: ReadonlyArray<{ token: { backingNight: unknown; seq: unknown }; generatedNow: unknown }>;
  /** `CoreWallet` → `DustLocalState` → `DustParameters`. */
  readonly state?: { state?: { params?: { dustGracePeriodSeconds?: unknown } } };
}

/** What the relay reads of wallet-sdk-facade 5.0.0-beta.2's `FacadeState.pending`: the finalized
 *  transactions the wallet has in flight, from finalisation until the indexer confirms them. */
export interface PendingTransactionsView {
  readonly all?: ReadonlyArray<{
    tx?: {
      intents?: {
        values(): Iterable<
          { dustActions?: { spends?: ReadonlyArray<{ oldNullifier: unknown; vFee: unknown }> } | undefined } | undefined
        >;
      };
    };
  }>;
}

/** The spendable outputs and the grace period of one wallet state, or nothing when the SDK does
 *  not list them in the expected shape (the session then reports the wallet's own balance).
 *  `nullifierOf` names each output as a spend of it would (omitted: no nullifiers). */
export function dustOutputsOf(
  dust: DustStateView,
  nullifierOf?: (token: unknown) => string,
): { outputs?: DustOutputView[]; graceSeconds?: number } {
  try {
    const coins = dust.availableCoins;
    if (!Array.isArray(coins)) return {};
    const outputs: DustOutputView[] = coins.map((c) => {
      const lineage = c.token.backingNight;
      const seq = c.token.seq;
      const value = c.generatedNow;
      if (typeof lineage !== 'string' || typeof seq !== 'number' || typeof value !== 'bigint') {
        throw new Error('unexpected DUST output shape');
      }
      let nullifier: string | undefined;
      try {
        nullifier = nullifierOf?.(c.token);
      } catch {
        nullifier = undefined; // no fee match for this output; it still counts in full
      }
      return { lineage, seq, specks: value, ...(nullifier === undefined ? {} : { nullifier }) };
    });
    const grace = dust.state?.state?.params?.dustGracePeriodSeconds;
    return {
      outputs,
      ...(typeof grace === 'bigint' && grace > 0n ? { graceSeconds: Number(grace) } : {}),
    };
  } catch {
    return {};
  }
}

/** The DUST spends (the spent output's nullifier and the fee) of the transactions in flight, or
 *  nothing when the facade does not carry them in the expected shape (then no fee is subtracted). */
export function pendingSpendsOf(pending: PendingTransactionsView | undefined): {
  pendingSpends?: PendingDustSpendView[];
} {
  try {
    const items = pending?.all;
    if (!Array.isArray(items)) return {};
    const spends: PendingDustSpendView[] = [];
    for (const item of items) {
      const intents = item.tx?.intents;
      if (!intents || typeof intents.values !== 'function') continue;
      for (const intent of intents.values()) {
        for (const spend of intent?.dustActions?.spends ?? []) {
          if (typeof spend.oldNullifier === 'bigint' && typeof spend.vFee === 'bigint') {
            spends.push({ nullifier: nullifierKey(spend.oldNullifier), feeSpecks: spend.vFee });
          }
        }
      }
    }
    return { pendingSpends: spends };
  } catch {
    return {};
  }
}

/** The sponsor's three role keys from its seed (account 0, index 0), as the Passport client
 *  and the Offer Files tools derive them. The HD wallet is cleared after use. */
export function deriveSponsorKeys(
  hd: typeof HdModule,
  seedHex: string,
): { zswap: Uint8Array; night: Uint8Array; dust: Uint8Array } {
  const created = hd.HDWallet.fromSeed(Uint8Array.from(Buffer.from(seedHex, 'hex')));
  if (created.type !== 'seedOk') throw new Error('invalid sponsor seed');
  const derived = created.hdWallet
    .selectAccount(0)
    .selectRoles([hd.Roles.Zswap, hd.Roles.NightExternal, hd.Roles.Dust])
    .deriveKeysAt(0);
  created.hdWallet.clear();
  if (derived.type !== 'keysDerived') throw new Error('sponsor key derivation failed');
  return {
    zswap: derived.keys[hd.Roles.Zswap],
    night: derived.keys[hd.Roles.NightExternal],
    dust: derived.keys[hd.Roles.Dust],
  };
}
