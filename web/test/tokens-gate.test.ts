// AA 00060 P4.3 (T4.3, T4.5, unit): the token-list mismatch notice and the signing gate (the wallet is
// never asked while the lists differ), and the site's check of its journey registry (FR-018).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import nacl from 'tweetnacl';
import { describe, expect, it, vi } from 'vitest';

import { checkBridges } from '../src/bridge/registry.js';
import { relayNotices, signingPaused, spendingPaused, type RelayState } from '../src/relay/status.js';
import { walletSigner } from '../src/wallet/phantom-adapter.js';
import { SignPromptStore } from '../src/wallet/sign-prompt.js';
import { WalletError } from '../src/wallet/wallet-errors.js';
import { asFetch } from '../../test/mocks/http.js';
import { mockSolanaRpc } from '../../test/mocks/solana-rpc.js';

const base: RelayState = { health: null, reachable: true, checkedAt: 1 };

describe('the token-list mismatch', () => {
  it('both digests known and unequal: the notice, and signing and spending are paused', () => {
    const s = { ...base, siteTokensDigest: 'aa'.repeat(32), relayTokensDigest: 'bb'.repeat(32) };
    expect(relayNotices(s).map((n) => n.id)).toEqual(['tokens-mismatch']);
    expect(signingPaused(s)).toMatch(/^This site and the market list different tokens\./);
    expect(spendingPaused(s)).toMatch(/list different tokens/);
  });

  it('equal, or the relay publishes none (an older relay): nothing', () => {
    for (const s of [
      { ...base, siteTokensDigest: 'aa'.repeat(32), relayTokensDigest: 'aa'.repeat(32) },
      { ...base, siteTokensDigest: 'aa'.repeat(32), relayTokensDigest: null },
      { ...base, siteTokensDigest: null, relayTokensDigest: 'bb'.repeat(32) },
    ]) {
      expect(relayNotices(s)).toEqual([]);
      expect(signingPaused(s)).toBeNull();
    }
  });

  it('the signing seam refuses before the wallet is asked, and before the panel opens', async () => {
    const kp = nacl.sign.keyPair();
    const sign = vi.fn(async (m: Uint8Array) => ({ signature: nacl.sign.detached(m, kp.secretKey) }));
    const prompts = new SignPromptStore();
    const open = vi.spyOn(prompts, 'open');
    let reason: string | null = 'paused for the test';
    const signer = walletSigner(
      {
        address: 'x',
        publicKey: kp.publicKey,
        canSignMessages: true,
        signMessage: sign,
        disconnect: async () => undefined,
        onChange: () => () => undefined,
      },
      'Phantom',
      { prompts, timeoutMs: 5_000, gate: () => reason },
    );
    await expect(signer.signMessage(new Uint8Array([65]))).rejects.toMatchObject({
      kind: 'paused',
      message: 'paused for the test',
    });
    await expect(signer.signMessage(new Uint8Array([65]))).rejects.toBeInstanceOf(WalletError);
    expect(sign).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    reason = null;
    await expect(signer.signMessage(new Uint8Array([65]))).resolves.toHaveLength(64);
    expect(sign).toHaveBeenCalledTimes(1);
  });
});

describe('T4.5 the site checks its journey registry (FR-018)', () => {
  const journey = JSON.parse(
    readFileSync(join(__dirname, '../../test/fixtures/journey-registry.undeployed.json'), 'utf8'),
  ) as {
    solanaGenesisHash: string;
  };
  const rpc = (genesis: string) => asFetch(mockSolanaRpc({ genesisHash: genesis }).handler);
  const solana = { rpcUrl: 'http://rpc.test', cluster: 'solana:localnet', genesisHash: null };

  it('none configured: none', async () => {
    expect(await checkBridges(undefined, 'undeployed', solana, rpc(journey.solanaGenesisHash))).toEqual({
      state: 'none',
    });
  });

  it('the right networks: ready', async () => {
    const r = await checkBridges(journey, 'undeployed', solana, rpc(journey.solanaGenesisHash));
    expect(r.state).toBe('ready');
  });

  it('another Solana network, another Midnight network, no RPC, an RPC that is down: refused with a reason', async () => {
    expect(await checkBridges(journey, 'undeployed', solana, rpc('11111111111111111111111111111111'))).toEqual({
      state: 'refused',
      reason: "Bridging is unavailable: the token registry is for another Solana network than the site's Solana RPC.",
    });
    expect(
      await checkBridges(
        { ...journey, midnightNetwork: 'stagenet' },
        'undeployed',
        solana,
        rpc(journey.solanaGenesisHash),
      ),
    ).toEqual({
      state: 'refused',
      reason:
        "Bridging is unavailable: the token registry is for another Midnight network than this site's (undeployed).",
    });
    expect((await checkBridges(journey, 'undeployed', null, rpc(journey.solanaGenesisHash))).state).toBe('refused');
    const down = (async () => {
      throw new Error('down');
    }) as unknown as typeof fetch;
    expect(await checkBridges(journey, 'undeployed', solana, down)).toEqual({
      state: 'refused',
      reason: "Bridging is unavailable: the site's Solana RPC does not answer.",
    });
  });
});
