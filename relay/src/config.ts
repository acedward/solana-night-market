// The relay's configuration, from the environment. deploy/.env.example documents every variable.
//
// Secrets never come from plain env values in production: pass the PATH of a file
// (SPONSOR_SEED_FILE), which a deployment mounts read-only. Secrets are
// returned separately from the config, are registered with the log redactor at startup, and
// never appear in /health, /v1/config or any log line.

import { mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import {
  DEFAULT_EXPIRY_LIMITS,
  DEMO_TOKEN_PATHS,
  WITHDRAWS_DAILY_CAP_DEFAULT,
  type DemoTokenPath,
  type ExpiryLimits,
  type NetworkOverrides,
  type NetworkProfile,
  type TokenRegistry,
  isNetworkName,
  registryFor,
  resolveNetwork,
} from '@nightmarket/core';

import type { ClientPrefixes } from './client-key.js';
import { LOG_LEVELS, type LogLevel } from './log.js';

export class ConfigError extends Error {
  override name = 'ConfigError';
}

export interface RelayConfig {
  network: NetworkProfile;
  tokens: TokenRegistry;
  host: string;
  port: number;
  /** Trust the last X-Forwarded-For entry (set by our own reverse proxy) for rate limiting. */
  trustProxy: boolean;
  /** The prefix every per-client cap keys a client address by (AA 00047 P10, R2-1/R2-8: an IPv6
   *  client by its /64; ./client-key.ts). */
  clientPrefixes: ClientPrefixes;
  /** Origins allowed to call the relay from a browser (exact match). Empty: no CORS headers. */
  corsOrigins: string[];
  /**
   * TWO proof servers until stagenet moves to dust/10 (AA 00047 spike 3 §6, spec FR-005):
   *   - the CONTRACT prover proves the account's circuits: 9.0.0-rc.8 (ZKIR 3.1; rc.6 cannot read
   *     compactc 0.35.0's circuits, "unrecognised discriminant");
   *   - the DUST prover proves the sponsor wallet's DUST spends: 9.0.0-rc.6 (stagenet requires
   *     dust/9; rc.8 proves dust/10).
   * /health reports each one's reachability and version (a mismatch degrades it).
   */
  contractProofServerUrl: string;
  contractProofServerVersion: string;
  dustProofServerUrl: string;
  dustProofServerVersion: string;
  /** The read-only key volume (compiled contracts with prover keys), or null. */
  managedPath: string | null;
  /** The pinned verifier-key fingerprint of the key volume; the relay refuses to start on another. */
  keysFingerprint: string | null;
  /** Refuse to start without a key volume (a deployment sets it; CI and UI development do not). */
  requireKeys: boolean;
  sponsor: {
    enabled: boolean;
    /** The wallet SDK's fee margin in blocks: it declares fee × 1.046^margin. 5 fails the
     *  registration's activation (BalanceCheckOverspend); 20 is tested locally and on stagenet (Q19). */
    feeBlocksMargin: number;
    /** Below this many specks (10^-15 DUST), spending actions are refused and health degrades. */
    dustLowSpecks: bigint;
    /** A shared lock file to take before opening the wallet (live runs on a shared seed). */
    fundingLockFile: string | null;
    /** The owner confirms the seed is dedicated to this relay, so no shared lock is needed. */
    dedicated: boolean;
  };
  limits: {
    readsPerMinute: number;
    /** GET /health per client address (security review F-B1); monitors poll about once a minute. */
    healthPerMinute: number;
    noncesPerMinute: number;
    /** Used nonces remembered until their expiry (AA 00047 P10, R2-8: nonces are stateless, so only
     *  used ones are stored; ./auth/nonces.ts). */
    maxUsedNonces: number;
    actionsPerMinute: number;
    actionsPerOwnerPerMinute: number;
    authMaxTtlSeconds: number;
    nonceTtlSeconds: number;
    jobTtlSeconds: number;
    /** Jobs one account may have queued or running at once (AA 00047 P10, R2-1). */
    jobsPerAccount: number;
    maxJobs: number;
    maxBodyBytes: number;
    /** How long a change's append entitlement stays valid (security review F-B3). */
    appendEntitlementTtlSeconds: number;
    /** The most inbox appends the market pays for per account in any rolling 24 h (F-B3 backstop). */
    appendsPerAccountPerDay: number;
  };
  /** Opening accounts (AA 00047 P9, audit C4; ./actions/registration-caps.ts, RUNBOOK section 9). */
  registration: {
    /** Registrations admitted in any rolling 24 hours, across all clients. */
    dailyCap: number;
    /** Registrations admitted in any rolling 24 hours from one client address. */
    perClientDailyCap: number;
    /** Registrations queued or running at once (their share of the one prover lane). */
    maxInFlight: number;
  };
  /** Failed jobs (after proving started) allowed per owner and per account in any rolling 24 hours
   *  (AA 00047 P9, audit C4; ./actions/failure-budget.ts). */
  failureBudget: { perOwner: number; perAccount: number };
  /** Per-account caps on offers, cancels and key restores (AA 00047 P10, R2-1;
   *  ./actions/account-caps.ts). */
  accountCaps: {
    maxOpenOffers: number;
    makesPerDay: number;
    cancelsPerDay: number;
    restoresPerDay: number;
    /** Sponsored withdrawals per account in any rolling 24 hours (AA 00047 P11, R3-2; Q46 A at 100). */
    withdrawsPerDay: number;
    /** Takes per account in any rolling 24 hours refused at settlement not by the taker's fault (P11, R3-7). */
    unsettledTakesPerDay: number;
  };
  /** The limits on an offer's or a take's signed expiry (AA 00047 P9, audit C6; ./trade/expiry.ts). */
  expiry: ExpiryLimits;
  /** Security review F-B6 (questions Q13): require a second signature (a Solana envelope over the
   *  whole body) for a withdrawal that names a recipient encryption key. Off by default: one wallet
   *  prompt per action, the encryption key rides the request unsigned (RUNBOOK §F-B6). */
  withdrawRecipientEnvelope: boolean;
  /** Where the relay keeps its only persistent state (the demo-token claims); null: none. */
  dataDir: string | null;
  demoTokens: DemoTokensConfig;
  healthCacheSeconds: number;
  logLevel: LogLevel;
}

/** The demo-token endpoint (spec FR-007, plan B3). */
export interface DemoTokensConfig {
  enabled: boolean;
  /** The pack, as configured: a symbol and a whole-token amount each ("twUSDC:1000"). Resolved against
   *  the registry (decimals, faucet contract, domain separator) by relay/src/demo/pack.ts. */
  pack: { symbol: string; amount: string }[];
  /** Claims admitted in any rolling 24 hours, across all keys. */
  dailyCap: number;
  /** Failed deliveries after which a key's partial claim is not resumed (AA 00047 P9, audit C8). */
  maxAttempts: number;
  /** How long after a token's submission its outcome may still be uncertain when the relay cannot
   *  read the transaction's own TTL (AA 00047 P10, R2-7: `via-sponsor`; ./demo/claims.ts). */
  pendingSettleSeconds: number;
  /** How the pack reaches the account (packages/core/src/demo-tokens.ts). */
  path: DemoTokenPath;
  /** The claims store: `<RELAY_DATA_DIR>/demo-token-claims.json`. */
  claimsFile: string | null;
}

/** The default pack (spec US3): 1,000 twUSDC, 0.1 twBTC, 1 twETH. */
export const DEFAULT_DEMO_PACK = 'twUSDC:1000,twBTC:0.1,twETH:1';

/** Parse DEMO_TOKENS_PACK: comma-separated `SYMBOL:AMOUNT` (a whole-token decimal amount). */
export function parseDemoPack(value: string): { symbol: string; amount: string }[] {
  const items = value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((item) => {
      const m = /^([A-Za-z0-9._-]{1,16}):([0-9]+(?:\.[0-9]+)?)$/.exec(item);
      if (!m) throw new ConfigError(`DEMO_TOKENS_PACK: "${item}" is not SYMBOL:AMOUNT`);
      return { symbol: m[1]!, amount: m[2]! };
    });
  if (items.length === 0) throw new ConfigError('DEMO_TOKENS_PACK names no token');
  const seen = new Set<string>();
  for (const i of items) {
    const k = i.symbol.toLowerCase();
    if (seen.has(k)) throw new ConfigError(`DEMO_TOKENS_PACK names ${i.symbol} twice`);
    seen.add(k);
  }
  return items;
}

export interface RelaySecrets {
  /** The sponsor wallet's seed as hex (from a hex seed or a BIP-39 mnemonic). */
  sponsorSeedHex: string | null;
  /** The raw secret text as read, so the redactor can also cut out a mnemonic. */
  sponsorSeedSource: string | null;
}

type Env = Record<string, string | undefined>;
type ReadFile = (path: string) => string;

const bool = (v: string | undefined, dflt: boolean, name: string): boolean => {
  if (v === undefined || v.trim() === '') return dflt;
  const s = v.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  throw new ConfigError(`${name} must be true or false`);
};

const int = (v: string | undefined, dflt: number, name: string, min = 0, max = Number.MAX_SAFE_INTEGER): number => {
  if (v === undefined || v.trim() === '') return dflt;
  const n = Number(v.trim());
  if (!Number.isInteger(n) || n < min || n > max)
    throw new ConfigError(`${name} must be an integer in [${min}, ${max}]`);
  return n;
};

const big = (v: string | undefined, dflt: bigint, name: string): bigint => {
  if (v === undefined || v.trim() === '') return dflt;
  if (!/^\d+$/.test(v.trim())) throw new ConfigError(`${name} must be a non-negative integer`);
  return BigInt(v.trim());
};

const str = (v: string | undefined): string | undefined => (v === undefined || v.trim() === '' ? undefined : v.trim());

/**
 * Read a secret from `<NAME>_FILE` (preferred) or, for local development only, `<NAME>`.
 * Returns null when neither is set.
 */
function secret(env: Env, readFile: ReadFile, name: string): string | null {
  const file = str(env[`${name}_FILE`]);
  if (file) {
    let text: string;
    try {
      text = readFile(file);
    } catch {
      throw new ConfigError(`${name}_FILE cannot be read`);
    }
    return text;
  }
  return str(env[name]) ?? null;
}

/**
 * The sponsor seed from a secret file's text. Accepts a hex seed, a BIP-39 mnemonic, or an
 * env-style file with one `WALLET=`, `SEED=` or `MNEMONIC=` line (the format of the shared
 * test wallets). Never echoes the value in an error.
 */
export function parseSponsorSeed(text: string): string {
  let value = text.trim();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?(WALLET|SEED|MNEMONIC|SPONSOR_SEED)\s*=\s*(.*)$/.exec(line);
    if (m) value = (m[2] ?? '').trim().replace(/^['"]|['"]$/g, '');
  }
  if (/^(0x)?[0-9a-fA-F]{64,128}$/.test(value) && value.replace(/^0x/, '').length % 2 === 0) {
    return value.replace(/^0x/, '').toLowerCase();
  }
  const words = value.split(/\s+/).filter(Boolean);
  if ([12, 15, 18, 21, 24].includes(words.length)) {
    const mnemonic = words.join(' ').toLowerCase();
    if (!validateMnemonic(mnemonic, wordlist))
      throw new ConfigError('the sponsor seed file holds an invalid BIP-39 mnemonic');
    return Buffer.from(mnemonicToSeedSync(mnemonic, '')).toString('hex');
  }
  throw new ConfigError('the sponsor seed file must hold a hex seed or a BIP-39 mnemonic');
}

function overridesFromEnv(env: Env): NetworkOverrides {
  const pick = <T extends Record<string, string | undefined>>(o: T): Partial<Record<keyof T, string>> =>
    Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<Record<keyof T, string>>;
  const overrides: NetworkOverrides = {
    midnight: pick({
      nodeUrl: str(env.MIDNIGHT_NODE_URL),
      nodeWsUrl: str(env.MIDNIGHT_NODE_WS_URL),
      indexerUrl: str(env.MIDNIGHT_INDEXER_URL),
      indexerWsUrl: str(env.MIDNIGHT_INDEXER_WS_URL),
      explorerUrl: str(env.MIDNIGHT_EXPLORER_URL),
    }),
    zswap: pick({
      kernelUrl: str(env.ZSWAP_KERNEL_URL),
      batcherUrl: str(env.ZSWAP_BATCHER_URL),
      batcherTarget: str(env.ZSWAP_BATCHER_TARGET),
      siteUrl: str(env.ZSWAP_SITE_URL),
    }),
  };
  const midnightNetworkId = str(env.MIDNIGHT_NETWORK_ID);
  if (midnightNetworkId) overrides.midnightNetworkId = midnightNetworkId;
  return overrides;
}

export function loadConfig(env: Env, readFile: ReadFile): { config: RelayConfig; secrets: RelaySecrets } {
  const networkName = str(env.RELAY_NETWORK);
  if (!networkName || !isNetworkName(networkName))
    throw new ConfigError('RELAY_NETWORK must be "undeployed" or "stagenet"');
  let network: NetworkProfile;
  try {
    network = resolveNetwork(networkName, overridesFromEnv(env));
  } catch (e) {
    throw new ConfigError((e as Error).message);
  }

  let tokenConfig: unknown;
  const tokensFile = str(env.TOKENS_FILE);
  if (tokensFile) {
    try {
      tokenConfig = JSON.parse(readFile(tokensFile));
    } catch {
      throw new ConfigError('TOKENS_FILE cannot be read as JSON');
    }
  }
  let tokens: TokenRegistry;
  try {
    tokens = registryFor(network.name, tokenConfig);
  } catch (e) {
    throw new ConfigError((e as Error).message);
  }

  const logLevel = (str(env.LOG_LEVEL) ?? 'info') as LogLevel;
  if (!LOG_LEVELS.includes(logLevel)) throw new ConfigError(`LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}`);

  // One proof server cannot serve both proofs on stagenet today, so the single-server names of MN
  // Bank are refused rather than guessed at (a contract proof sent to rc.6 fails minutes later).
  for (const legacy of ['MIDNIGHT_PROOF_SERVER_URL', 'PROOF_SERVER_EXPECTED_VERSION']) {
    if (str(env[legacy]) !== undefined) {
      throw new ConfigError(
        `${legacy} is replaced by two settings: MIDNIGHT_CONTRACT_PROOF_SERVER_URL (proof server 9.0.0-rc.8, the account's circuits) and MIDNIGHT_DUST_PROOF_SERVER_URL (9.0.0-rc.6, the sponsor's DUST), with CONTRACT_/DUST_PROOF_SERVER_EXPECTED_VERSION`,
      );
    }
  }
  const url = (name: string, dflt: string): string => {
    const value = str(env[name]) ?? dflt;
    try {
      new URL(value);
    } catch {
      throw new ConfigError(`${name} is not a URL`);
    }
    return value;
  };
  const contractProofServerUrl = url('MIDNIGHT_CONTRACT_PROOF_SERVER_URL', 'http://proof-server-contracts:6300');
  const dustProofServerUrl = url('MIDNIGHT_DUST_PROOF_SERVER_URL', 'http://proof-server-dust:6300');

  const fingerprint = str(env.RELAY_KEYS_FINGERPRINT)?.toLowerCase() ?? null;
  if (fingerprint && !/^[0-9a-f]{64}$/.test(fingerprint))
    throw new ConfigError('RELAY_KEYS_FINGERPRINT must be 64 hex characters');

  const sponsorEnabled = bool(env.SPONSOR_ENABLED, false, 'SPONSOR_ENABLED');
  const dustLowSpecks = big(env.SPONSOR_DUST_LOW_SPECKS, 10n * 10n ** 15n, 'SPONSOR_DUST_LOW_SPECKS');
  const fundingLockFile = str(env.SPONSOR_FUNDING_LOCK_FILE) ?? null;
  const dedicated = bool(env.SPONSOR_DEDICATED_WALLET, false, 'SPONSOR_DEDICATED_WALLET');

  const dataDir = str(env.RELAY_DATA_DIR) ?? null;
  const demoEnabled = bool(env.DEMO_TOKENS_ENABLED, false, 'DEMO_TOKENS_ENABLED');
  // `direct` (one transaction per token) is the default since B3's localnet run (questions Q17).
  const demoPath = (str(env.DEMO_TOKENS_PATH) ?? 'direct') as DemoTokenPath;
  if (!DEMO_TOKEN_PATHS.includes(demoPath))
    throw new ConfigError(`DEMO_TOKENS_PATH must be one of ${DEMO_TOKEN_PATHS.join(', ')}`);
  if (demoEnabled && !dataDir)
    throw new ConfigError('DEMO_TOKENS_ENABLED needs RELAY_DATA_DIR (the claims store is its only persistent state)');

  const config: RelayConfig = {
    network,
    tokens,
    host: str(env.RELAY_HOST) ?? '0.0.0.0',
    port: int(env.RELAY_PORT, 8080, 'RELAY_PORT', 1, 65535),
    trustProxy: bool(env.RELAY_TRUST_PROXY, false, 'RELAY_TRUST_PROXY'),
    clientPrefixes: {
      ipv6: int(env.CLIENT_IPV6_PREFIX, 64, 'CLIENT_IPV6_PREFIX', 16, 128),
      ipv4: int(env.CLIENT_IPV4_PREFIX, 32, 'CLIENT_IPV4_PREFIX', 8, 32),
    },
    corsOrigins: (str(env.RELAY_CORS_ORIGINS) ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    contractProofServerUrl,
    contractProofServerVersion: str(env.CONTRACT_PROOF_SERVER_EXPECTED_VERSION) ?? '9.0.0-rc.8',
    dustProofServerUrl,
    dustProofServerVersion: str(env.DUST_PROOF_SERVER_EXPECTED_VERSION) ?? '9.0.0-rc.6',
    managedPath: str(env.MIDNIGHT_MANAGED_PATH) ?? null,
    keysFingerprint: fingerprint,
    requireKeys: bool(env.RELAY_REQUIRE_KEYS, false, 'RELAY_REQUIRE_KEYS'),
    sponsor: {
      enabled: sponsorEnabled,
      feeBlocksMargin: int(env.SPONSOR_FEE_BLOCKS_MARGIN, 20, 'SPONSOR_FEE_BLOCKS_MARGIN', 1, 1000),
      dustLowSpecks,
      fundingLockFile,
      dedicated,
    },
    limits: {
      readsPerMinute: int(env.RATE_LIMIT_READS_PER_MIN, 240, 'RATE_LIMIT_READS_PER_MIN', 1),
      healthPerMinute: int(env.RATE_LIMIT_HEALTH_PER_MIN, 60, 'RATE_LIMIT_HEALTH_PER_MIN', 1),
      noncesPerMinute: int(env.RATE_LIMIT_NONCES_PER_MIN, 30, 'RATE_LIMIT_NONCES_PER_MIN', 1),
      actionsPerMinute: int(env.RATE_LIMIT_ACTIONS_PER_MIN, 10, 'RATE_LIMIT_ACTIONS_PER_MIN', 1),
      actionsPerOwnerPerMinute: int(
        env.RATE_LIMIT_ACTIONS_PER_OWNER_PER_MIN,
        5,
        'RATE_LIMIT_ACTIONS_PER_OWNER_PER_MIN',
        1,
      ),
      authMaxTtlSeconds: int(env.AUTH_MAX_TTL_SECONDS, 600, 'AUTH_MAX_TTL_SECONDS', 30, 3600),
      nonceTtlSeconds: int(env.AUTH_NONCE_TTL_SECONDS, 600, 'AUTH_NONCE_TTL_SECONDS', 30, 3600),
      maxUsedNonces: int(env.AUTH_MAX_USED_NONCES, 200_000, 'AUTH_MAX_USED_NONCES', 1000, 10_000_000),
      jobTtlSeconds: int(env.JOB_TTL_SECONDS, 86_400, 'JOB_TTL_SECONDS', 60),
      jobsPerAccount: int(env.JOBS_PER_ACCOUNT, 1, 'JOBS_PER_ACCOUNT', 1, 100),
      maxJobs: int(env.JOB_MAX, 10_000, 'JOB_MAX', 10),
      maxBodyBytes: int(env.RELAY_MAX_BODY_BYTES, 1_048_576, 'RELAY_MAX_BODY_BYTES', 1024),
      appendEntitlementTtlSeconds: int(
        env.APPEND_ENTITLEMENT_TTL_SECONDS,
        30 * 86_400,
        'APPEND_ENTITLEMENT_TTL_SECONDS',
        3600,
        365 * 86_400,
      ),
      appendsPerAccountPerDay: int(
        env.APPEND_INBOX_MAX_PER_ACCOUNT_PER_DAY,
        20,
        'APPEND_INBOX_MAX_PER_ACCOUNT_PER_DAY',
        1,
      ),
    },
    registration: {
      dailyCap: int(env.REGISTER_DAILY_CAP, 100, 'REGISTER_DAILY_CAP', 1, 1_000_000),
      perClientDailyCap: int(env.REGISTER_PER_CLIENT_DAILY_CAP, 3, 'REGISTER_PER_CLIENT_DAILY_CAP', 1, 1_000_000),
      maxInFlight: int(env.REGISTER_MAX_IN_FLIGHT, 1, 'REGISTER_MAX_IN_FLIGHT', 1, 100),
    },
    failureBudget: {
      perOwner: int(env.FAILURE_BUDGET_PER_OWNER_PER_DAY, 5, 'FAILURE_BUDGET_PER_OWNER_PER_DAY', 1, 1_000_000),
      perAccount: int(env.FAILURE_BUDGET_PER_ACCOUNT_PER_DAY, 5, 'FAILURE_BUDGET_PER_ACCOUNT_PER_DAY', 1, 1_000_000),
    },
    accountCaps: {
      maxOpenOffers: int(env.OFFERS_MAX_OPEN_PER_ACCOUNT, 3, 'OFFERS_MAX_OPEN_PER_ACCOUNT', 1, 1000),
      makesPerDay: int(env.MAKES_PER_ACCOUNT_PER_DAY, 20, 'MAKES_PER_ACCOUNT_PER_DAY', 1, 100_000),
      cancelsPerDay: int(env.CANCELS_PER_ACCOUNT_PER_DAY, 5, 'CANCELS_PER_ACCOUNT_PER_DAY', 1, 100_000),
      restoresPerDay: int(env.RESTORES_PER_ACCOUNT_PER_DAY, 3, 'RESTORES_PER_ACCOUNT_PER_DAY', 1, 100_000),
      withdrawsPerDay: int(env.WITHDRAWS_DAILY_CAP, WITHDRAWS_DAILY_CAP_DEFAULT, 'WITHDRAWS_DAILY_CAP', 1, 1_000_000),
      unsettledTakesPerDay: int(
        env.TAKES_UNSETTLED_PER_ACCOUNT_PER_DAY,
        10,
        'TAKES_UNSETTLED_PER_ACCOUNT_PER_DAY',
        1,
        100_000,
      ),
    },
    expiry: {
      offerMaxLifetimeSeconds: int(
        env.OFFER_MAX_LIFETIME_SECONDS,
        DEFAULT_EXPIRY_LIMITS.offerMaxLifetimeSeconds,
        'OFFER_MAX_LIFETIME_SECONDS',
        60,
        30 * 86_400,
      ),
      takeMaxLifetimeSeconds: int(
        env.TAKE_MAX_LIFETIME_SECONDS,
        DEFAULT_EXPIRY_LIMITS.takeMaxLifetimeSeconds,
        'TAKE_MAX_LIFETIME_SECONDS',
        60,
        86_400,
      ),
      minRemainingSeconds: int(
        env.EXPIRY_MIN_REMAINING_SECONDS,
        DEFAULT_EXPIRY_LIMITS.minRemainingSeconds,
        'EXPIRY_MIN_REMAINING_SECONDS',
        0,
        3600,
      ),
      clockSkewSeconds: int(
        env.EXPIRY_CLOCK_SKEW_SECONDS,
        DEFAULT_EXPIRY_LIMITS.clockSkewSeconds,
        'EXPIRY_CLOCK_SKEW_SECONDS',
        0,
        3600,
      ),
    },
    withdrawRecipientEnvelope: bool(env.RELAY_WITHDRAW_RECIPIENT_ENVELOPE, false, 'RELAY_WITHDRAW_RECIPIENT_ENVELOPE'),
    dataDir,
    demoTokens: {
      enabled: demoEnabled,
      pack: parseDemoPack(str(env.DEMO_TOKENS_PACK) ?? DEFAULT_DEMO_PACK),
      dailyCap: int(env.DEMO_TOKENS_DAILY_CAP, 100, 'DEMO_TOKENS_DAILY_CAP', 1, 1_000_000),
      maxAttempts: int(env.DEMO_TOKENS_MAX_ATTEMPTS, 3, 'DEMO_TOKENS_MAX_ATTEMPTS', 1, 100),
      pendingSettleSeconds: int(
        env.DEMO_TOKENS_PENDING_SETTLE_SECONDS,
        4 * 3600,
        'DEMO_TOKENS_PENDING_SETTLE_SECONDS',
        600,
        7 * 86_400,
      ),
      path: demoPath,
      claimsFile: dataDir ? `${dataDir.replace(/\/+$/, '')}/demo-token-claims.json` : null,
    },
    healthCacheSeconds: int(env.HEALTH_CACHE_SECONDS, 15, 'HEALTH_CACHE_SECONDS', 0, 600),
    logLevel,
  };

  const sponsorSeedSource = secret(env, readFile, 'SPONSOR_SEED');
  const sponsorSeedHex = sponsorSeedSource === null ? null : parseSponsorSeed(sponsorSeedSource);

  if (sponsorEnabled && sponsorSeedHex === null) throw new ConfigError('SPONSOR_ENABLED needs SPONSOR_SEED_FILE');
  // Live networks: a seed shared with other tools must be taken under the shared lock, and a
  // dedicated seed must be declared as such. The relay never opens a live wallet otherwise.
  if (sponsorEnabled && network.name !== 'undeployed' && !fundingLockFile && !dedicated) {
    throw new ConfigError(
      'on a live network the sponsor needs SPONSOR_FUNDING_LOCK_FILE (a shared seed) or SPONSOR_DEDICATED_WALLET=true',
    );
  }

  return { config, secrets: { sponsorSeedHex, sponsorSeedSource } };
}
