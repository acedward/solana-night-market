// The relay's entry point (Bun): load the configuration, register every secret with the log
// redactor, check the key volume (and refuse to start when it lacks any circuit the relay proves,
// plan P4-A), open the sponsor wallet (under the funding lock when one is configured), wire the
// Ed25519 arm and the Solana envelope scheme when the key volume is loaded (lane B3:
// ./passport/arm.ts `wiredArm`), the demo-token endpoint when it is enabled, and serve.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { KernelClient } from '@nightmarket/core';

import { addDustAndSubmit } from './bridge/dust-submit.js';
import { LandingEntitlements, landingEntitlementKey } from './bridge/out-actions.js';
import { bridgeKeyProblems, type ReadContractState } from './bridge/registry-check.js';
import { AccountCaps } from './actions/account-caps.js';
import { AccountGate } from './actions/account-gate.js';
import {
  accountCatalogue,
  defaultCatalogue,
  withAccountCaps,
  withDemoTokens,
  withRegistrationCaps,
  withBridgeOut,
  withTrade,
} from './actions/catalogue.js';
import { AppendEntitlements, entitlementKey } from './actions/entitlements.js';
import { FailureBudget } from './actions/failure-budget.js';
import { RegistrationCaps } from './actions/registration-caps.js';
import { createApp } from './app.js';
import { NonceStore } from './auth/nonces.js';
import { passportCallAuthoriser } from './auth/passport-call.js';
import { DigestReplayGuard } from './auth/verifiers.js';
import { IndexerClient, ledgerEventDecoder } from './chain/indexer.js';
import {
  IndexerChainReader,
  notImplementedChainReader,
  type ChainReader,
  type ContractBalances,
} from './chain/reader.js';
import { ConfigError, loadConfig } from './config.js';
import { demoTokens, demoTokensInfo } from './demo/action.js';
import { ClaimsStoreError, DemoTokenClaims } from './demo/claims.js';
import { DemoFaucets } from './demo/faucet.js';
import { resolvePack, type ResolvedPackItem } from './demo/pack.js';
import { healthCollector, httpProbes } from './health.js';
import { Redactor, createLogger } from './log.js';
import { ProofServerClient } from './prover/client.js';
import { cachedKeyCheck, checkKeyVolume, keyVolumeProblems } from './prover/keys.js';
import { DEMO_TOKEN_PROVEN_CIRCUITS, RELAY_PROVEN_CIRCUITS } from './prover/required.js';
import { accountKeysChecker, type OnChainAccountState } from './passport/account-keys.js';
import { wiredArm } from './passport/arm.js';
import { isLiveDevice } from './passport/ed25519-arm.js';
import type { SponsorWalletHandle } from './passport/wallet-provider.js';
import { PassportRuntime, PassportRuntimeError } from './passport/runtime.js';
import { JobQueue } from './queue/jobs.js';
import { FacadeSponsorSession, openFacadeWallet } from './sponsor/facade.js';
import { DisabledSponsorSession, type SponsorSession } from './sponsor/session.js';
import { BatcherCooldown } from './trade/executors.js';
import { RELAY_VERSION } from './version.js';

/** How often /health re-scans the read-only key volume (security review F-B1). */
const KEY_RECHECK_SECONDS = 3600;

async function main(): Promise<void> {
  const redactor = new Redactor();
  let loaded: ReturnType<typeof loadConfig>;
  try {
    loaded = loadConfig(process.env, (p) => readFileSync(p, 'utf8'));
  } catch (e) {
    const msg = e instanceof ConfigError ? e.message : 'the configuration could not be loaded';
    process.stderr.write(`${JSON.stringify({ t: new Date().toISOString(), level: 'error', msg: `config: ${msg}` })}\n`);
    process.exit(78);
  }
  const { config, secrets } = loaded;
  redactor.addSecret(secrets.sponsorSeedHex);
  redactor.addSecret(secrets.sponsorSeedSource);
  const log = createLogger({ level: config.logLevel, redactor }, { service: 'relay', network: config.network.name });

  // The key volume (plan P4-A): every circuit the relay proves must have its prover key, verifier
  // key and ZKIR, and a pinned fingerprint must match. When a volume is configured and any of that
  // fails, the relay does not start: a missing key would otherwise surface only in a customer's job.
  // (No deployed callee is checked: MN Bank checked the bridge vault's keys; Night Market has none.)
  const deployed: Record<string, string> = {};
  // The demo-token endpoint also proves the faucet's mint and the account's deposit (B3).
  const required = config.demoTokens.enabled
    ? [...RELAY_PROVEN_CIRCUITS, ...DEMO_TOKEN_PROVEN_CIRCUITS]
    : RELAY_PROVEN_CIRCUITS;
  const keys = () => checkKeyVolume(config.managedPath, config.keysFingerprint, required, deployed);
  const keyCheck = keys();
  if (config.managedPath && !keyCheck.present && !config.requireKeys) {
    // The image names a default key path; with nothing mounted there the relay runs keyless (CI,
    // UI development). A deployment sets RELAY_REQUIRE_KEYS=true so a missing volume is fatal.
    log.warn(
      'no key volume at MIDNIGHT_MANAGED_PATH: account and trade actions are unavailable (RELAY_REQUIRE_KEYS=true refuses to start instead)',
    );
  } else if (config.managedPath) {
    const problems = keyVolumeProblems(keyCheck, {
      root: config.managedPath,
      pin: config.keysFingerprint,
      deployed,
    });
    if (problems.length > 0) {
      log.error(
        `the key volume is incomplete or does not match; refusing to start (${problems.length} problem${problems.length === 1 ? '' : 's'})`,
        { problems, fingerprint: keyCheck.fingerprint, circuitsChecked: required.length },
      );
      process.exit(78);
    }
    log.info('key volume complete', {
      circuits: required.length,
      fingerprint: keyCheck.fingerprint,
      deployedKeysChecked: Object.keys(deployed).length,
    });
  } else if (config.requireKeys) {
    log.error('RELAY_REQUIRE_KEYS is set but MIDNIGHT_MANAGED_PATH names no key volume; refusing to start');
    process.exit(78);
  } else {
    log.warn('no key volume (MIDNIGHT_MANAGED_PATH): account and trade actions are unavailable');
  }

  let sponsor: SponsorSession = new DisabledSponsorSession();
  if (config.sponsor.enabled && secrets.sponsorSeedHex) {
    sponsor = new FacadeSponsorSession(
      {
        seedHex: secrets.sponsorSeedHex,
        endpoints: {
          networkId: config.network.midnightNetworkId,
          indexerUrl: config.network.midnight.indexerUrl,
          indexerWsUrl: config.network.midnight.indexerWsUrl,
          nodeWsUrl: config.network.midnight.nodeWsUrl,
          dustProofServerUrl: config.dustProofServerUrl,
        },
        feeBlocksMargin: config.sponsor.feeBlocksMargin,
        fundingLockFile: config.sponsor.fundingLockFile,
        purpose: `night-market relay ${RELAY_VERSION} (${config.network.name})`,
      },
      openFacadeWallet,
      log.child({ component: 'sponsor' }),
    );
    try {
      await sponsor.start();
    } catch (e) {
      log.error('the sponsor wallet could not be started; refusing to start', { error: e });
      process.exit(75);
    }
  }

  // The Passport runtime: the pinned client bound to the key volume's compiled contracts. Without
  // a key volume the relay still serves /health and /v1/config, and the account actions say they
  // are not available.
  let runtime: PassportRuntime | null = null;
  if (config.managedPath && keyCheck.present) {
    try {
      runtime = await PassportRuntime.load({
        managedPath: config.managedPath,
        networkId: config.network.midnightNetworkId,
        indexerUrl: config.network.midnight.indexerUrl,
        indexerWsUrl: config.network.midnight.indexerWsUrl,
        contractProofServerUrl: config.contractProofServerUrl,
        log: log.child({ component: 'passport' }),
      });
    } catch (e) {
      if (e instanceof PassportRuntimeError) {
        // The account keys in the volume are not the code's (or the volume is the light compile).
        log.error('the key volume does not match the Passport client; refusing to start', { error: e });
        process.exit(78);
      }
      log.error('the Passport runtime could not be loaded; account actions are unavailable', { error: e });
    }
  }
  // AA 00060 P4.2 (spec FR-014): with a journey registry, each bridge's deployed `lockForSolana` verifier
  // key must be the key volume's, or Bridge out would be proven with keys the contract refuses.
  if (config.bridges) {
    if (!runtime || !config.managedPath) {
      log.error('BRIDGE_REGISTRY_FILE is set but the key volume is not loaded; refusing to start');
      process.exit(78);
    }
    const rt = runtime;
    // AA 00060 P10.3 (audit C11, F-A10): with the key volume's bridge module, each bridge's sealed
    // `sourceMint` must be the registry's SPL mint too.
    let bridgeLedger: ((data: unknown) => { sourceMint: Uint8Array }) | undefined;
    try {
      bridgeLedger = (
        (await import(join(config.managedPath, 'bridge', 'contract', 'index.js'))) as {
          ledger: (s: unknown) => { sourceMint: Uint8Array };
        }
      ).ledger;
    } catch {
      bridgeLedger = undefined; // the bundle check below names the missing bundle
    }
    const problems = await bridgeKeyProblems(
      config.bridges,
      config.managedPath,
      async (address) => (await rt.contractState(address)) as Awaited<ReturnType<ReadContractState>>,
      bridgeLedger,
    );
    if (problems.length > 0) {
      log.error('the journey registry does not match the key volume or the chain; refusing to start', { problems });
      process.exit(78);
    }
    log.info('journey registry checked', { bridges: config.bridges.entries.map((b) => b.symbol) });
  }
  // AA 00047 P11 (R3-5): a history past one indexer page is read through the WebSocket subscription.
  const indexer = new IndexerClient({
    indexerUrl: config.network.midnight.indexerUrl,
    indexerWsUrl: config.network.midnight.indexerWsUrl,
  });
  const chain: ChainReader = runtime
    ? new IndexerChainReader(
        (account) => runtime!.ledgerState(account),
        indexer,
        undefined,
        async (account) => (await runtime!.contractState(account)) as ContractBalances | null,
      )
    : notImplementedChainReader;
  const replay = new DigestReplayGuard(config.limits.authMaxTtlSeconds * 6);

  // The device arm (lane B3): Track A's Ed25519 arm (each account call authorised by its own F3
  // signature) and the Solana wallet's envelope scheme (registration, demo tokens), with FR-005's
  // check that every account it acts on carries the pinned verifier keys and a retired authority.
  // Without a key volume there is nothing to prove with: the default catalogue answers "not
  // available" for every action.
  const accountKeys =
    runtime && config.managedPath
      ? accountKeysChecker({
          managedPath: config.managedPath,
          circuits: (runtime.client.shape as { accountCircuitIds(): string[] }).accountCircuitIds(),
          readState: async (a) => (await runtime!.contractState(a)) as OnChainAccountState | null,
          log: log.child({ component: 'account-keys' }),
        })
      : undefined;
  const wired = runtime
    ? await wiredArm({
        network: config.network.name,
        tokens: config.tokens,
        ...(accountKeys ? { accountKeys } : {}),
      })
    : null;
  if (!wired) log.warn('no key volume is loaded: account, trade and demo-token actions are unavailable');

  // The demo-token endpoint (spec FR-007): its pack, its claims store (the relay's only persistent
  // state, one relay per data dir), and the faucets it mints from.
  let demoPack: ResolvedPackItem[] = [];
  let claims: DemoTokenClaims | null = null;
  if (config.demoTokens.enabled) {
    try {
      demoPack = resolvePack(config.demoTokens.pack, config.tokens);
      claims = new DemoTokenClaims({
        file: config.demoTokens.claimsFile,
        dailyCap: config.demoTokens.dailyCap,
        maxAttempts: config.demoTokens.maxAttempts,
        onRecovered: (n) =>
          log.warn(
            'demo-token reservations left by a previous run (it stopped mid-job) are kept as partial claims: charged, resumable',
            { count: n },
          ),
        onWriteFailed: (what, error) =>
          log.error('the demo-token claims file could not be written', { during: what, error }),
        onLockLost: () =>
          log.error(
            'another relay took over the demo-token claims lock: this relay stops writing claims (one relay per data dir)',
          ),
      });
      // Takes the lock FIRST, then reads and recovers the file (audit C8 / F-B8).
      claims.lock();
    } catch (e) {
      // A ClaimsStoreError says what is wrong (another relay holds the lock, or the data dir cannot
      // be written: path, errno, the relay's uid/gid) and how to fix it; its stack adds nothing.
      log.error(
        'the demo-token endpoint cannot start; refusing to start',
        e instanceof ClaimsStoreError ? { reason: e.message, kind: e.kind, code: e.code, path: e.path } : { error: e },
      );
      process.exit(78);
    }
    log.info('demo tokens enabled', {
      pack: demoPack.map((p) => `${p.symbol}:${p.amount}`).join(','),
      dailyCap: config.demoTokens.dailyCap,
      path: config.demoTokens.path,
      claimedToday: claims.claimedToday(),
    });
  }

  // Security review F-B3: `append-inbox` is sponsored only against a single-use entitlement the
  // relay issued for a change coin (./actions/entitlements.ts); the MAC key comes from the seed.
  const entitlements = new AppendEntitlements({
    key: entitlementKey(secrets.sponsorSeedHex),
    network: config.network.name,
    ttlSeconds: config.limits.appendEntitlementTtlSeconds,
    maxPerAccountPerDay: config.limits.appendsPerAccountPerDay,
  });
  // AA 00060 P6.3: Bridge out's single-use landing entitlements (./bridge/out-actions.ts), MAC'd with a
  // key from the seed so they survive a restart; only with a journey registry and the key volume.
  // P10.3 (audit C1): spent landing coins and their failed attempts are kept in RELAY_DATA_DIR, so a
  // restart (or a re-issue) never makes a spent landing coin sponsorable again.
  if (config.bridges && runtime && config.managedPath && !config.dataDir) {
    log.error(
      'BRIDGE_REGISTRY_FILE needs RELAY_DATA_DIR (spent landing entitlements must survive a restart); refusing to start',
    );
    process.exit(78);
  }
  const landing =
    config.bridges && runtime && config.managedPath && config.dataDir
      ? {
          entitlements: new LandingEntitlements({
            key: landingEntitlementKey(secrets.sponsorSeedHex),
            network: config.network.name,
            file: join(config.dataDir, 'landing-entitlements.json'),
          }),
          bridges: config.bridges,
        }
      : undefined;
  // Stateless nonces (AA 00047 P10, R2-8): only used ones are remembered.
  const nonces = new NonceStore(config.limits.nonceTtlSeconds, config.limits.maxUsedNonces);
  // Audit C4 (AA 00047 P9): registration caps and the failure budget (RUNBOOK section 9).
  const registrationCaps = new RegistrationCaps(config.registration);
  const failures = new FailureBudget(config.failureBudget);
  // Audit round 2 R2-1 (AA 00047 P10): per-account caps on offers, cancels and key restores, and one
  // queued-or-running job per account (RUNBOOK section 9).
  const kernel = new KernelClient({ baseUrl: config.network.zswap.kernelUrl, retries: 1, timeoutMs: 10_000 });
  // AA 00047 P11 (R3-2, Q46): the withdrawal allowance's whole-coin exit is per LISTED token.
  const accountCaps = new AccountCaps({
    ...config.accountCaps,
    offerStatus: (id) => kernel.offerStatus(id),
    isListedColour: (colour) => config.tokens.byColour(colour) !== undefined,
  });
  const accountGate = new AccountGate(config.limits.jobsPerAccount);
  // AA 00047 P11.F (audit round 4 R4-1): the prover lane serves takes, then makes, then the rest, the
  // least recent users first, and estimates when a take would start (./queue/prover-lock.ts).
  const queue = new JobQueue({
    ttlSeconds: config.limits.jobTtlSeconds,
    maxJobs: config.limits.maxJobs,
    log: log.child({ component: 'queue' }),
    prover: config.proverLane,
  });
  let batcherRefusal: { httpStatus: number; at: number } | null = null;
  const health = healthCollector({
    network: config.network.name,
    version: RELAY_VERSION,
    startedAt: Math.floor(Date.now() / 1000),
    sponsor,
    dustLowSpecks: config.sponsor.dustLowSpecks,
    prover: new ProofServerClient(config.contractProofServerUrl, config.contractProofServerVersion),
    dustProver: new ProofServerClient(config.dustProofServerUrl, config.dustProofServerVersion),
    // The volume is read-only and was checked in full above: re-scan it hourly, not per request (F-B1).
    keys: cachedKeyCheck(keys, { initial: keyCheck, intervalSeconds: KEY_RECHECK_SECONDS }),
    queue,
    probes: httpProbes({
      kernelUrl: config.network.zswap.kernelUrl,
      batcherUrl: config.network.zswap.batcherUrl,
      log,
    }),
    cacheSeconds: config.healthCacheSeconds,
    batcherRefusal: () => batcherRefusal,
  });
  let catalogue = wired
    ? withTrade(
        accountCatalogue({
          runtime: () => runtime,
          arm: wired.arm,
          scheme: wired.scheme,
          sponsor,
          network: config.network.name,
          withdrawRecipientEnvelope: config.withdrawRecipientEnvelope,
          replay,
          entitlements,
          ...(landing ? { landing } : {}),
          log: log.child({ component: 'accounts' }),
          // AA 00047 P11 (R3-7): a coin is checked unspent before a proof is spent on it.
          ...(chain instanceof IndexerChainReader ? { coins: chain } : {}),
        }),
        {
          runtime: () => runtime,
          arm: wired.arm,
          sponsor,
          kernelUrl: config.network.zswap.kernelUrl,
          batcherUrl: config.network.zswap.batcherUrl,
          batcherTarget: config.network.zswap.batcherTarget,
          replay,
          expiry: config.expiry,
          // AA 00047 P11.F (R4-3): after the exchange's 429, takes pause before proving.
          cooldown: new BatcherCooldown(config.batcherBusyCooldownSeconds),
          log: log.child({ component: 'trade' }),
          ...(chain instanceof IndexerChainReader ? { coins: chain } : {}),
          onBatcherRefusal: (httpStatus) => {
            batcherRefusal = { httpStatus, at: Math.floor(Date.now() / 1000) };
          },
        },
      )
    : defaultCatalogue();
  if (wired && runtime && claims) {
    const faucets = new DemoFaucets(runtime, log.child({ component: 'demo-tokens' }));
    catalogue = withDemoTokens(
      catalogue,
      demoTokens({
        runtime: () => runtime,
        sponsor,
        claims,
        pack: demoPack,
        path: config.demoTokens.path,
        arm: wired.arm,
        ...(accountKeys ? { accountKeys } : {}),
        // A resumed via-sponsor deposit (AA 00047 P11, R3-8) is a via-sponsor deposit whatever the path.
        mint: (o) =>
          o.path === 'direct' && !o.resume
            ? faucets.direct({ ...o, networkId: config.network.midnightNetworkId })
            : faucets.viaSponsor(o),
        pendingSettleSeconds: config.demoTokens.pendingSettleSeconds,
        log: log.child({ component: 'demo-tokens' }),
      }),
    );
  }
  catalogue = withRegistrationCaps(catalogue, registrationCaps);
  catalogue = withAccountCaps(catalogue, accountCaps);
  // AA 00060 P6.3: Bridge out's second transaction and the entitlement re-issue.
  if (landing && wired && runtime && config.managedPath) {
    const rt = runtime;
    const managed = config.managedPath;
    const pdp = rt.publicDataProvider as {
      queryZSwapAndContractState(a: string, c: unknown): Promise<[unknown, unknown, unknown] | null>;
      queryContractState(a: string): Promise<unknown>;
    };
    const display = { network: config.network.name, tokens: config.tokens };
    catalogue = withBridgeOut(catalogue, {
      bridges: landing.bridges,
      entitlements: landing.entitlements,
      ledger: () => import('@midnightntwrk/ledger-v9'),
      transcripts: async () => ({
        runtime: (await import('@midnight-ntwrk/compact-runtime-0.20')) as never,
        bridgeLedger: (
          (await import(join(managed, 'bridge', 'contract', 'index.js'))) as { ledger: (s: unknown) => never }
        ).ledger,
        stateAt: async (address, blockHash) =>
          (await pdp.queryZSwapAndContractState(address, { type: 'blockHash', blockHash }))?.[1] ?? null,
        latestState: (address) => pdp.queryContractState(address),
      }),
      prove: (tx) =>
        (rt.proofProvider as { proveTx(t: unknown, o: unknown): Promise<unknown> }).proveTx(tx, { timeout: 900_000 }),
      awaitLanded: async (txId) => {
        const watch = (pdp as unknown as { watchForTxData(id: string): Promise<{ status?: unknown }> }).watchForTxData(
          txId,
        );
        const out = await Promise.race([
          watch.catch(() => null),
          new Promise<null>((r) => setTimeout(() => r(null), 180_000)),
        ]);
        return out !== null && String(out.status) === 'SucceedEntirely';
      },
      submitWithDust: (tx) =>
        sponsor.withWallet((w) =>
          addDustAndSubmit(w as SponsorWalletHandle, tx, {
            onWait: () => log.info('waiting for the sponsor wallet to generate enough DUST'),
          }),
        ),
      tx1: async (account, tx1Hash) => {
        const txs = await indexer.accountTransactions(account);
        const tx = txs?.txs.find((t) => t.hash.replace(/^0x/, '').toLowerCase() === tx1Hash);
        if (!tx) return null;
        const decode = await ledgerEventDecoder();
        const outputs: string[] = [];
        for (const ev of tx.events) {
          const d = decode(ev.raw) as { tag?: string; commitment?: string };
          if (d.tag === 'zswapOutput' && d.commitment) outputs.push(d.commitment);
        }
        return { entryPoints: tx.entryPoints ?? [], outputs };
      },
      liveDevice: async (account, deviceKey, useCounter) => {
        const l = await rt.ledgerState(account);
        if (!l) return false;
        const { ed25519DeviceForKey } = await import('@nightmarket/core/passport');
        return isLiveDevice(l, ed25519DeviceForKey(deviceKey, display), account, useCounter);
      },
      log: log.child({ component: 'bridge-out' }),
    });
    log.info('bridge out enabled', { bridges: landing.bridges.entries.map((b) => b.symbol) });
  }
  const app = createApp({
    config,
    version: RELAY_VERSION,
    log,
    nonces,
    queue,
    catalogue,
    failures,
    accountGate,
    sponsor,
    health,
    chain,
    ...(wired ? { scheme: wired.scheme, passportCall: passportCallAuthoriser(() => runtime, wired.arm, replay) } : {}),
    demoTokens: demoTokensInfo({
      claims: claims ?? new DemoTokenClaims({ file: null, dailyCap: config.demoTokens.dailyCap }),
      pack: demoPack,
      enabled: config.demoTokens.enabled && !!wired && !!claims,
      dailyCap: config.demoTokens.dailyCap,
    }),
  });

  const sweeper = setInterval(() => {
    queue.sweep();
    nonces.sweep();
  }, 60_000);

  const server = Bun.serve({ hostname: config.host, port: config.port, fetch: app.fetch });
  log.info('relay listening', {
    host: config.host,
    port: server.port,
    version: RELAY_VERSION,
    sponsor: sponsor.status().state,
  });

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info('shutting down', { signal });
    clearInterval(sweeper);
    await server.stop();
    claims?.unlock();
    await sponsor.stop().catch((e: unknown) => log.warn('sponsor stop failed', { error: e }));
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

void main();
