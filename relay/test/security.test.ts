// Logs never carry secrets; config errors never echo them; the funding lock follows the shared
// convention; nonces and rate limits behave.

import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { generateMnemonic, mnemonicToSeedSync } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { afterEach, describe, expect, it } from 'vitest';

import { NonceStore } from '../src/auth/nonces.js';
import { ConfigError, loadConfig, parseSponsorSeed } from '../src/config.js';
import { Redactor, createLogger } from '../src/log.js';
import { RateLimiter } from '../src/ratelimit.js';
import { FacadeSponsorSession, type WalletFactory } from '../src/sponsor/facade.js';
import { FundingLockHeldError, takeFundingLock } from '../src/sponsor/funding-lock.js';
import { LOCAL_TOKENS, silentLog } from './harness.js';

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'mnbank-relay-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('log redaction', () => {
  it('cuts registered secrets out of messages, fields and errors, and hides sensitive keys', () => {
    const seed = randomBytes(32).toString('hex');
    const rpc = `https://rpc.example.test/v3/${randomBytes(16).toString('hex')}`;
    const redactor = new Redactor();
    redactor.addSecret(seed);
    redactor.addSecret(rpc);
    const lines: string[] = [];
    const log = createLogger({ redactor, sink: (l) => lines.push(l) });
    log.info(`opening wallet ${seed}`, { note: `rpc=${rpc}`, nested: { deep: [seed] } });
    log.error('failed', { error: new Error(`fetch ${rpc} failed for ${seed}`) });
    log.warn('fields', {
      sponsorSeed: 'anything',
      mnemonic: 'word word',
      privateKey: 'x',
      signature: '0x12',
      rpcUrl: 'u',
      ok: 'visible',
    });
    const out = lines.join('\n');
    expect(out).not.toContain(seed);
    expect(out).not.toContain(rpc);
    expect(out).not.toContain(new URL(rpc).pathname);
    expect(out).toContain('[redacted]');
    expect(out).toContain('visible');
    for (const l of lines) expect(() => JSON.parse(l)).not.toThrow();
  });

  it('respects the level', () => {
    const lines: string[] = [];
    const log = createLogger({ level: 'warn', sink: (l) => lines.push(l) });
    log.info('no');
    log.warn('yes');
    expect(lines).toHaveLength(1);
  });
});

describe('configuration', () => {
  const tokens = () => JSON.stringify(LOCAL_TOKENS);

  it('needs a known network, and the local stack needs a token list', () => {
    expect(() => loadConfig({}, tokens)).toThrow(ConfigError);
    expect(() => loadConfig({ RELAY_NETWORK: 'mainnet' }, tokens)).toThrow(ConfigError);
    expect(() => loadConfig({ RELAY_NETWORK: 'undeployed' }, tokens)).toThrow(/token/);
    const { config } = loadConfig({ RELAY_NETWORK: 'stagenet' }, tokens);
    expect(config.tokens.tokens.map((t) => t.symbol)).toEqual([
      'twBTC',
      'twETH',
      'twUSDC',
      'twUSDM',
      'utwUSDC',
      'utwBTC',
    ]);
    expect(config.sponsor.enabled).toBe(false);
  });

  it('applies endpoint overrides', () => {
    const { config } = loadConfig(
      {
        RELAY_NETWORK: 'stagenet',
        ZSWAP_KERNEL_URL: 'http://kernel:9999',
        MIDNIGHT_INDEXER_URL: 'http://indexer:8088/api/v4/graphql',
      },
      tokens,
    );
    expect(config.network.zswap.kernelUrl).toBe('http://kernel:9999');
    expect(config.network.midnight.indexerUrl).toBe('http://indexer:8088/api/v4/graphql');
    expect(() => loadConfig({ RELAY_NETWORK: 'stagenet', ZSWAP_KERNEL_URL: 'nope' }, tokens)).toThrow(ConfigError);
  });

  it('names two proof servers: rc.8 for the contract circuits, rc.6 for the DUST (and refuses the single-server names)', () => {
    const { config } = loadConfig({ RELAY_NETWORK: 'stagenet' }, tokens);
    expect(config).toMatchObject({
      contractProofServerUrl: 'http://proof-server-contracts:6300',
      contractProofServerVersion: '9.0.0-rc.8',
      dustProofServerUrl: 'http://proof-server-dust:6300',
      dustProofServerVersion: '9.0.0-rc.6',
    });
    const set = loadConfig(
      {
        RELAY_NETWORK: 'stagenet',
        MIDNIGHT_CONTRACT_PROOF_SERVER_URL: 'http://rc8:6300',
        CONTRACT_PROOF_SERVER_EXPECTED_VERSION: '9.0.0-rc.9',
        MIDNIGHT_DUST_PROOF_SERVER_URL: 'http://rc6:6300',
        DUST_PROOF_SERVER_EXPECTED_VERSION: '9.0.0-rc.7',
      },
      tokens,
    ).config;
    expect([set.contractProofServerUrl, set.contractProofServerVersion]).toEqual(['http://rc8:6300', '9.0.0-rc.9']);
    expect([set.dustProofServerUrl, set.dustProofServerVersion]).toEqual(['http://rc6:6300', '9.0.0-rc.7']);
    expect(() => loadConfig({ RELAY_NETWORK: 'stagenet', MIDNIGHT_DUST_PROOF_SERVER_URL: 'nope' }, tokens)).toThrow(
      /MIDNIGHT_DUST_PROOF_SERVER_URL is not a URL/,
    );
    expect(() =>
      loadConfig({ RELAY_NETWORK: 'stagenet', MIDNIGHT_PROOF_SERVER_URL: 'http://proof-server:6300' }, tokens),
    ).toThrow(/MIDNIGHT_CONTRACT_PROOF_SERVER_URL.*MIDNIGHT_DUST_PROOF_SERVER_URL/);
    expect(() =>
      loadConfig({ RELAY_NETWORK: 'stagenet', PROOF_SERVER_EXPECTED_VERSION: '9.0.0-rc.6' }, tokens),
    ).toThrow(ConfigError);
  });

  it('reads secrets from files, and never echoes them in an error', () => {
    const mnemonic = generateMnemonic(wordlist, 256);
    const files: Record<string, string> = {
      '/seed': `# test\nWALLET=${mnemonic}\n`,
      '/bad': 'not a seed at all',
    };
    const read = (p: string) => {
      if (p in files) return files[p]!;
      throw new Error('ENOENT');
    };
    const { secrets } = loadConfig(
      { RELAY_NETWORK: 'undeployed', TOKENS_FILE: '/t', SPONSOR_SEED_FILE: '/seed' },
      (p) => (p === '/t' ? tokens() : read(p)),
    );
    expect(secrets.sponsorSeedHex).toBe(Buffer.from(mnemonicToSeedSync(mnemonic, '')).toString('hex'));
    // AA 00060 P13: the test SPL faucet's keys are secrets too (none without SPL_FAUCET_KEYS_FILE).
    expect(Object.keys(secrets).sort()).toEqual([
      'splFaucetKeys',
      'splFaucetKeysSource',
      'sponsorSeedHex',
      'sponsorSeedSource',
    ]);
    expect([secrets.splFaucetKeys, secrets.splFaucetKeysSource]).toEqual([null, null]);
    for (const bad of ['/bad', '/missing']) {
      try {
        loadConfig({ RELAY_NETWORK: 'undeployed', TOKENS_FILE: '/t', SPONSOR_SEED_FILE: bad }, (p) =>
          p === '/t' ? tokens() : read(p),
        );
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(ConfigError);
        expect(String(e)).not.toContain('not a seed at all');
      }
    }
  });

  it('parses hex seeds and mnemonics, and refuses invalid mnemonics', () => {
    const hex = randomBytes(32).toString('hex');
    expect(parseSponsorSeed(`0x${hex.toUpperCase()}`)).toBe(hex);
    expect(parseSponsorSeed(`SEED="${hex}"`)).toBe(hex);
    const words = generateMnemonic(wordlist, 128).split(' ');
    // A word outside the BIP-39 list, so never valid (a swapped real word keeps a valid
    // checksum about one time in sixteen).
    words[0] = 'zzzzzz';
    expect(() => parseSponsorSeed(words.join(' '))).toThrow(/invalid BIP-39/);
  });

  it('on a live network, a sponsor needs the shared lock or a declared dedicated seed', () => {
    const seed = randomBytes(32).toString('hex');
    const env = { RELAY_NETWORK: 'stagenet', SPONSOR_ENABLED: 'true', SPONSOR_SEED: seed };
    expect(() => loadConfig(env, tokens)).toThrow(/SPONSOR_FUNDING_LOCK_FILE/);
    expect(
      loadConfig({ ...env, SPONSOR_FUNDING_LOCK_FILE: '/locks/funding.lock' }, tokens).config.sponsor.fundingLockFile,
    ).toBe('/locks/funding.lock');
    expect(loadConfig({ ...env, SPONSOR_DEDICATED_WALLET: 'true' }, tokens).config.sponsor.dedicated).toBe(true);
    expect(() =>
      loadConfig({ RELAY_NETWORK: 'undeployed', TOKENS_FILE: '/t', SPONSOR_ENABLED: 'true' }, tokens),
    ).toThrow(/SPONSOR_SEED_FILE/);
  });
});

describe('the funding lock', () => {
  it('is created exclusively, mode 600, with {purpose, pid, host, at}, and released', () => {
    const path = join(tmp(), 'funding.lock');
    const lock = takeFundingLock(path, 'relay test');
    const body = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['at', 'host', 'pid', 'purpose']);
    expect(body.pid).toBe(process.pid);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(() => takeFundingLock(path, 'second')).toThrow(FundingLockHeldError);
    lock.release();
    expect(existsSync(path)).toBe(false);
  });

  it('never removes a lock that another process holds', () => {
    const path = join(tmp(), 'funding.lock');
    writeFileSync(path, JSON.stringify({ purpose: 'someone else', pid: 1, host: 'h', at: 'now' }), { mode: 0o600 });
    expect(() => takeFundingLock(path, 'relay')).toThrow(/someone else/);
    expect(existsSync(path)).toBe(true);
  });

  it('the sponsor session takes the lock before opening the wallet and releases it on stop', async () => {
    const path = join(tmp(), 'funding.lock');
    let opened = 0;
    const factory: WalletFactory = async () => {
      opened++;
      expect(existsSync(path)).toBe(true); // lock held before the wallet opens
      return {
        handle: { fake: true },
        subscribe: (onState) => {
          onState({ synced: true, dustSpecks: 5n });
          return () => {};
        },
        stop: async () => {},
      };
    };
    const cfg = {
      seedHex: '00'.repeat(32),
      endpoints: {
        networkId: 'undeployed',
        indexerUrl: 'http://i',
        indexerWsUrl: 'ws://i',
        nodeWsUrl: 'ws://n',
        dustProofServerUrl: 'http://p',
      },
      feeBlocksMargin: 5,
      fundingLockFile: path,
      purpose: 'test',
    };
    const s = new FacadeSponsorSession(cfg, factory, silentLog());
    await s.start();
    expect(s.status()).toMatchObject({ configured: true, state: 'synced', synced: true, dustSpecks: 5n });
    expect(await s.withWallet(async (w) => w)).toEqual({ fake: true });
    await s.stop();
    expect(existsSync(path)).toBe(false);
    expect(opened).toBe(1);

    // held by someone else: the wallet is never opened
    writeFileSync(path, JSON.stringify({ purpose: 'other', pid: 1, host: 'h', at: 'now' }));
    const blocked = new FacadeSponsorSession(cfg, factory, silentLog());
    await expect(blocked.start()).rejects.toThrow(FundingLockHeldError);
    expect(opened).toBe(1);
    expect(blocked.status().state).toBe('error');
  });

  it('releases the lock when the wallet fails to open', async () => {
    const path = join(tmp(), 'funding.lock');
    const s = new FacadeSponsorSession(
      {
        seedHex: '00'.repeat(32),
        endpoints: {
          networkId: 'undeployed',
          indexerUrl: 'http://i',
          indexerWsUrl: 'ws://i',
          nodeWsUrl: 'ws://n',
          dustProofServerUrl: 'http://p',
        },
        feeBlocksMargin: 5,
        fundingLockFile: path,
        purpose: 't',
      },
      async () => {
        throw new Error('connection refused');
      },
      silentLog(),
    );
    await expect(s.start()).rejects.toThrow('connection refused');
    expect(existsSync(path)).toBe(false);
    await expect(s.withWallet(async () => 1)).rejects.toThrow(/not synced/);
  });
});

describe('nonces', () => {
  /** A nonce the store issued (the test fails if it refused). */
  const issued = (store: NonceStore, client?: string) => {
    const r = store.issue(client);
    if (!r.ok) throw new Error(`refused: ${r.refused}`);
    return r;
  };

  it('are single use, expire, and are forgotten by a new store (a restart)', () => {
    let now = 100;
    const store = new NonceStore(60, 3, () => now);
    const { nonce, expiresAt } = issued(store);
    expect(nonce).toMatch(/^0x[0-9a-f]{64}$/);
    expect(expiresAt).toBe(160);
    expect(store.consume(nonce)).toBe('ok');
    expect(store.consume(nonce)).toBe('used');
    const late = issued(store).nonce;
    now = 161;
    expect(store.consume(late)).toBe('unknown');
    expect(new NonceStore(60, 3, () => now).consume(issued(store).nonce)).toBe('unknown');
  });

  it('issuing stores nothing and never refuses, so no issued nonce is ever pushed out (audit C9; P10 R2-8)', () => {
    const store = new NonceStore(60, 2);
    const first = issued(store).nonce;
    for (let i = 0; i < 1000; i++) issued(store, `client-${i}`);
    expect(store.size).toEqual({ issued: 0, used: 0 });
    // The first nonce still works.
    expect(store.consume(first)).toBe('ok');
  });
});

describe('rate limiter', () => {
  it('allows a burst up to the limit, then refills over time', () => {
    let now = 0;
    const r = new RateLimiter(3, 10, () => now);
    expect([r.take('a').ok, r.take('a').ok, r.take('a').ok, r.take('a').ok]).toEqual([true, true, true, false]);
    expect(r.take('b').ok).toBe(true);
    const refused = r.take('a');
    expect(refused.ok === false && refused.retryAfterSeconds).toBeGreaterThan(0);
    now += 20_000;
    expect(r.take('a').ok).toBe(true);
  });

  it('bounds its memory', () => {
    const r = new RateLimiter(1, 3);
    for (const k of ['a', 'b', 'c', 'd', 'e']) r.take(k);
    expect(r.size).toBe(3);
  });
});
