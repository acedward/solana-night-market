// AA 00060 P4 (T4.1, T4.4): the token-list generator (`bridgeTokenLists` and its command line,
// scripts/bridge-tokens.ts) against its goldens and every refusal, and the arm's text for a bridged token.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { main as cli } from '../../../scripts/bridge-tokens.js';
import { asFetch } from '../../../test/mocks/http.js';
import { mockSolanaRpc } from '../../../test/mocks/solana-rpc.js';
import {
  BridgeTokensError,
  CLASSIC_TOKEN_PROGRAM,
  TOKEN_2022_PROGRAM,
  bridgeTokenLists,
  type BridgeTokenListsInput,
} from '../src/bridge/token-lists.js';
import { bytesToHex } from '../src/hex.js';
import { ed25519TokenResolver, renderEd25519Message } from '../src/passport/ed25519.js';
import { registryFor } from '../src/tokens/registry.js';
import { tokensDigest } from '../src/tokens/digest.js';

const FIX = join(__dirname, '../../../test/fixtures');
const read = (p: string) => JSON.parse(readFileSync(join(FIX, p), 'utf8')) as Record<string, unknown>;
const journey = () =>
  read('journey-registry.undeployed.json') as { solanaGenesisHash: string; tokens: Record<string, unknown>[] };
const base = (): BridgeTokenListsInput => ({
  journey: journey(),
  siteConfig: read('bridge-tokens/site-config.in.json'),
  relayTokens: read('bridge-tokens/relay-tokens.in.json'),
  pairs: ['X/Y', 'X/twUSDC'],
  mode: 'extend',
});
const reason = (input: BridgeTokenListsInput): string | null => {
  try {
    bridgeTokenLists(input);
    return null;
  } catch (e) {
    if (e instanceof BridgeTokensError) return e.reason;
    throw e;
  }
};

const tmp = mkdtempSync(join(tmpdir(), 'aa00060-bridge-tokens-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('T4.1 the generator', () => {
  it('writes the goldens byte for byte (command line)', async () => {
    const site = join(tmp, 'config.json');
    const relay = join(tmp, 'tokens.json');
    writeFileSync(site, readFileSync(join(FIX, 'bridge-tokens/site-config.in.json')));
    writeFileSync(relay, readFileSync(join(FIX, 'bridge-tokens/relay-tokens.in.json')));
    const code = await cli([
      join(FIX, 'journey-registry.undeployed.json'),
      '--site-config',
      site,
      '--relay-tokens',
      relay,
      '--pairs',
      'X/Y,X/twUSDC',
      '--mode',
      'extend',
    ]);
    expect(code).toBe(0);
    expect(readFileSync(site, 'utf8')).toBe(readFileSync(join(FIX, 'bridge-tokens/site-config.out.json'), 'utf8'));
    expect(readFileSync(relay, 'utf8')).toBe(readFileSync(join(FIX, 'bridge-tokens/relay-tokens.out.json'), 'utf8'));
  });

  it('both lists have the same digest, and the bridges stay out of the token entries', () => {
    const out = bridgeTokenLists(base());
    const site = registryFor('undeployed', out.siteConfig.tokens);
    const relay = registryFor('undeployed', out.relayTokens);
    expect(tokensDigest(site)).toBe(tokensDigest(relay));
    expect(out.tokensDigest).toBe(tokensDigest(site));
    expect(site.bySymbol('X')?.decimals).toBe(6);
    expect(JSON.stringify(out.siteConfig.tokens)).not.toContain('splMint');
    expect((out.siteConfig.bridges as { tokens: unknown[] }).tokens).toHaveLength(2);
    expect(out.siteConfig.pairs).toEqual(['twBTC/twUSDC', 'X/Y', 'X/twUSDC']);
  });

  it('refuses each case with its named reason', () => {
    const j = (patch: (t: Record<string, unknown>[], f: Record<string, unknown>) => void) => {
      const f = journey();
      patch(f.tokens, f);
      return { ...base(), journey: f };
    };
    expect(reason(j((t) => (t[0]!.symbol = 'ABCDEFGHI')))).toBe('unrenderable-symbol');
    expect(reason(j((t) => (t[0]!.symbol = 'X Y')))).toBe('unrenderable-symbol');
    expect(reason(j((t) => (t[1]!.symbol = 'X')))).toBe('duplicate-symbol');
    expect(reason(j((_t, f) => (f.midnightNetwork = 'stagenet')))).toBe('wrong-network');
    // A colour (or a symbol) the site already lists.
    const listed = base();
    (listed.siteConfig.tokens as { tokens: Record<string, unknown>[] }).tokens.push({
      symbol: 'OLD',
      decimals: 6,
      midnightColour: journey().tokens[0]!.colour,
    });
    expect(reason(listed)).toBe('colour-listed');
    const sym = base();
    (sym.siteConfig.tokens as { tokens: Record<string, unknown>[] }).tokens.push({
      symbol: 'x',
      decimals: 6,
      midnightColour: 'cc'.repeat(32),
    });
    expect(reason(sym)).toBe('symbol-collision');
    // A pair over a symbol neither list has.
    expect(reason({ ...base(), pairs: ['X/NOPE'] })).toBe('unknown-pair-token');
    // A relay file that already differed from the site's list.
    expect(
      reason({
        ...base(),
        relayTokens: {
          mode: 'replace',
          tokens: [
            {
              symbol: 'twUSDC',
              decimals: 6,
              midnightColour: 'a13a505f63f56936e9bf500eab8602acc7d4f88992b734c46607418e02eca65e',
            },
          ],
        },
      }),
    ).toBe('lists-differ');
  });

  it('with the Solana RPC: Token-2022, another owner, another decimals, a missing mint, another genesis hash', () => {
    const J = journey();
    const facts = (over: Record<string, { owner: string; decimals: number | null } | undefined>) => ({
      genesisHash: J.solanaGenesisHash,
      mints: {
        [String(J.tokens[0]!.splMint)]: { owner: CLASSIC_TOKEN_PROGRAM, decimals: 6 },
        [String(J.tokens[1]!.splMint)]: { owner: CLASSIC_TOKEN_PROGRAM, decimals: 6 },
        ...over,
      },
    });
    const x = String(J.tokens[0]!.splMint);
    expect(reason({ ...base(), solana: facts({}) })).toBeNull();
    expect(reason({ ...base(), solana: facts({ [x]: { owner: TOKEN_2022_PROGRAM, decimals: 6 } }) })).toBe(
      'token-2022',
    );
    expect(
      reason({ ...base(), solana: facts({ [x]: { owner: '11111111111111111111111111111111', decimals: null } }) }),
    ).toBe('not-spl-token');
    expect(reason({ ...base(), solana: facts({ [x]: { owner: CLASSIC_TOKEN_PROGRAM, decimals: 9 } }) })).toBe(
      'decimals-mismatch',
    );
    expect(reason({ ...base(), solana: facts({ [x]: undefined }) })).toBe('mint-not-found');
    expect(reason({ ...base(), solana: { ...facts({}), genesisHash: '11111111111111111111111111111111' } })).toBe(
      'wrong-genesis-hash',
    );
  });

  it('the command line reads the RPC, refuses a Token-2022 mint with exit 65, and writes nothing', async () => {
    const rpc = mockSolanaRpc({ genesisHash: journey().solanaGenesisHash });
    const J = journey();
    const mintData = new Uint8Array(82);
    mintData[44] = 6;
    rpc.accounts.set(String(J.tokens[0]!.splMint), { owner: TOKEN_2022_PROGRAM, data: mintData });
    rpc.accounts.set(String(J.tokens[1]!.splMint), { owner: CLASSIC_TOKEN_PROGRAM, data: mintData });
    const site = join(tmp, 'config-2022.json');
    const relay = join(tmp, 'tokens-2022.json');
    const before = readFileSync(join(FIX, 'bridge-tokens/site-config.in.json'), 'utf8');
    writeFileSync(site, before);
    const code = await cli(
      [
        join(FIX, 'journey-registry.undeployed.json'),
        '--site-config',
        site,
        '--relay-tokens',
        relay,
        '--solana-rpc',
        'http://rpc.test',
      ],
      asFetch(rpc.handler),
    );
    expect(code).toBe(65);
    expect(readFileSync(site, 'utf8')).toBe(before);
    expect(rpc.calls).toEqual(['getGenesisHash', 'getAccountInfo', 'getAccountInfo']);
  });
});

describe('T4.4 the arm labels a bridged token with the site’s symbol and decimals', () => {
  it('an offer of 200 X reads "This site labels it: 200.000000 X"', () => {
    const out = bridgeTokenLists(base());
    const registry = registryFor('undeployed', out.siteConfig.tokens);
    const x = registry.bySymbol('X')!;
    const y = registry.bySymbol('Y')!;
    const hex = (h: string) => Uint8Array.from(Buffer.from(h, 'hex'));
    const m = renderEd25519Message(
      {
        contractAddress: new Uint8Array(32).fill(0x11),
        authNonce: 3n,
        challenge: new Uint8Array(32).fill(0x22),
        label: 'Night Market - local',
        tokens: ed25519TokenResolver(registry),
      },
      {
        op: 'openSwapShielded',
        giveColor: hex(x.midnightColour),
        giveAmount: 200_000_000n,
        recipientKind: 0n,
        recipient: new Uint8Array(32),
        want: { color: hex(y.midnightColour), value: 50_000_000n },
        validUntil: 1_900_000_000n,
      },
    );
    expect(m.text.split('\n')).toContain(`This site labels it: ${'200.000000 X'.padEnd(34)}`);
    expect(m.text.split('\n')).toContain(`Give token ${bytesToHex(hex(x.midnightColour))}`);
    expect(m.text).not.toMatch(/ \?\s*$/m);
  });
});
