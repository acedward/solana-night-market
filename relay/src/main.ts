// The relay's entry point (Bun): load the configuration, register every secret with the log
// redactor, check the key volume (and refuse to start when it lacks any circuit the relay proves,
// plan P4-A), open the sponsor wallet (under the funding lock when one is configured), wire the
// Ed25519 arm and the Solana envelope scheme when the key volume is loaded (lane B3:
// ./passport/arm.ts `wiredArm`), the demo-token endpoint when it is enabled, and serve.

import { readFileSync } from 'node:fs';

import { accountCatalogue, defaultCatalogue, withDemoTokens, withTrade } from './actions/catalogue.js';
import { AppendEntitlements, entitlementKey } from './actions/entitlements.js';
import { createApp } from './app.js';
import { NonceStore } from './auth/nonces.js';
import { passportCallAuthoriser } from './auth/passport-call.js';
import { DigestReplayGuard } from './auth/verifiers.js';
import { IndexerClient } from './chain/indexer.js';
import {
  IndexerChainReader,
  notImplementedChainReader,
  type ChainReader,
  type ContractBalances,
} from './chain/reader.js';
import { ConfigError, loadConfig } from './config.js';
import { demoTokens, demoTokensInfo } from './demo/action.js';
import { DemoTokenClaims } from './demo/claims.js';
import { DemoFaucets } from './demo/faucet.js';
import { resolvePack, type ResolvedPackItem } from './demo/pack.js';
import { healthCollector, httpProbes } from './health.js';
import { Redactor, createLogger } from './log.js';
import { ProofServerClient } from './prover/client.js';
import { cachedKeyCheck, checkKeyVolume, keyVolumeProblems } from './prover/keys.js';
import { DEMO_TOKEN_PROVEN_CIRCUITS, RELAY_PROVEN_CIRCUITS } from './prover/required.js';
import { accountKeysChecker, type OnChainAccountState } from './passport/account-keys.js';
import { wiredArm } from './passport/arm.js';
import { PassportRuntime, PassportRuntimeError } from './passport/runtime.js';
import { JobQueue } from './queue/jobs.js';
import { FacadeSponsorSession, openFacadeWallet } from './sponsor/facade.js';
import { DisabledSponsorSession, type SponsorSession } from './sponsor/session.js';
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
  const indexer = new IndexerClient({ indexerUrl: config.network.midnight.indexerUrl });
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
        onRecovered: (n) =>
          log.warn('released demo-token reservations left by a previous run (it stopped mid-job)', { count: n }),
      });
      claims.lock();
    } catch (e) {
      log.error('the demo-token endpoint cannot start; refusing to start', { error: e });
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
  const nonces = new NonceStore(config.limits.nonceTtlSeconds, config.limits.maxNonces);
  const queue = new JobQueue({
    ttlSeconds: config.limits.jobTtlSeconds,
    maxJobs: config.limits.maxJobs,
    log: log.child({ component: 'queue' }),
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
          log: log.child({ component: 'accounts' }),
        }),
        {
          runtime: () => runtime,
          arm: wired.arm,
          sponsor,
          kernelUrl: config.network.zswap.kernelUrl,
          batcherUrl: config.network.zswap.batcherUrl,
          batcherTarget: config.network.zswap.batcherTarget,
          replay,
          log: log.child({ component: 'trade' }),
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
        mint: (o) =>
          o.path === 'direct'
            ? faucets.direct({ ...o, networkId: config.network.midnightNetworkId })
            : faucets.viaSponsor(o),
        log: log.child({ component: 'demo-tokens' }),
      }),
    );
  }
  const app = createApp({
    config,
    version: RELAY_VERSION,
    log,
    nonces,
    queue,
    catalogue,
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
