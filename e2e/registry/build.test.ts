// AA 00057 P1: the journey registry generator (e2e/registry/build.ts) against two real deployment records
// and every refusal. The expected colours are computed HERE, independently of Night Market's colour.ts and
// of compact-runtime: with node:crypto SHA-256 only, from the bridge contract's definitions
// (`domainSep(mint) = persistentHash([pad32("effectstream:bridge:sol:v1"), mint])`,
// `tokenType(sep, contract) = persistentCommit([sep, contract], pad32("midnight:derive_token"))`, both
// SHA-256 over their 32-byte parts; the commitment's opening first). That derivation is itself held equal to
// the compiled bridge contract's `pureCircuits.domainSep` / `tokenColor` vectors and to the colours the
// deployed contracts minted (the records' own, checked on chain by 00058's bridge:record).

import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { base58 } from '@scure/base';
import { afterAll, describe, expect, it } from 'vitest';

import { parseJourneyRegistry } from '@nightmarket/core/bridge';

import { asFetch, json } from '../../test/mocks/http.js';
import { mockSolanaRpc } from '../../test/mocks/solana-rpc.js';
import {
  CLASSIC_SPL_TOKEN_PROGRAM,
  JourneyBuildError,
  buildJourneyRegistry,
  main as cli,
  type BuildExpect,
  type JourneyBuildRefusal,
} from './build.js';

const FIX = join(__dirname, 'fixtures');
type Rec = Record<string, unknown> & { splMint: string; bridgeContract: string; colour: string };
const rec = (w: 'x' | 'y'): Rec => JSON.parse(readFileSync(join(FIX, `standin-${w}.record.json`), 'utf8')) as Rec;
const GENESIS = rec('x').solanaGenesisHash as string;
const UNDEPLOYED: BuildExpect = { midnightNetwork: 'undeployed' };

const pad32 = (t: string) => Buffer.concat([Buffer.from(t, 'ascii'), Buffer.alloc(32 - t.length)]);
const sha256 = (...parts: Uint8Array[]) => createHash('sha256').update(Buffer.concat(parts)).digest();
/** domainSep(mint), independently: SHA-256(pad32("effectstream:bridge:sol:v1") ‖ mint). */
const domainSep = (mint: string) => sha256(pad32('effectstream:bridge:sol:v1'), base58.decode(mint));
/** tokenType(domainSep(mint), contract), independently: SHA-256(pad32("midnight:derive_token") ‖ sep ‖ contract). */
const colourOf = (mint: string, contract: string) =>
  sha256(pad32('midnight:derive_token'), domainSep(mint), Buffer.from(contract, 'hex')).toString('hex');

/** A record for another mint at another contract, with its colour derived independently. */
const another = (seed: number, over: Record<string, unknown> = {}): Rec => {
  const splMint = base58.encode(new Uint8Array(32).fill(seed));
  const bridgeContract = Buffer.alloc(32, seed + 1).toString('hex');
  return { ...rec('x'), splMint, bridgeContract, colour: colourOf(splMint, bridgeContract), ...over } as Rec;
};

const refusal = (records: unknown[], ex: BuildExpect = UNDEPLOYED): JourneyBuildRefusal | null => {
  try {
    buildJourneyRegistry(records, ex);
    return null;
  } catch (e) {
    if (e instanceof JourneyBuildError) return e.reason;
    throw e;
  }
};

const tmp = mkdtempSync(join(tmpdir(), 'aa00057-registry-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('the independent colour derivation', () => {
  it("equals the compiled bridge contract's domainSep and tokenColor vectors", () => {
    const v = JSON.parse(readFileSync(join(__dirname, '../../packages/core/test/fixtures/bridge-colour.json'), 'utf8'))
      .vectors as { splMint: string; bridgeContract: string; domainSep: string; colour: string }[];
    expect(v.length).toBeGreaterThanOrEqual(3);
    for (const t of v) {
      expect(domainSep(t.splMint).toString('hex')).toBe(t.domainSep);
      expect(colourOf(t.splMint, t.bridgeContract)).toBe(t.colour);
    }
  });

  it('equals the colours the deployed X and Y bridges minted (the records)', () => {
    for (const w of ['x', 'y'] as const) expect(colourOf(rec(w).splMint, rec(w).bridgeContract)).toBe(rec(w).colour);
  });
});

describe('P1 two records give two entries', () => {
  it('maps each record to an I-1 entry with the independently derived colour', () => {
    const out = buildJourneyRegistry([rec('x'), rec('y')], {
      midnightNetwork: 'undeployed',
      solanaGenesisHash: GENESIS,
    });
    expect(out.midnightNetwork).toBe('undeployed');
    expect(out.solanaGenesisHash).toBe(GENESIS);
    expect(out.tokens).toHaveLength(2);
    for (const [i, w] of (['x', 'y'] as const).entries()) {
      const r = rec(w);
      expect(out.tokens[i]).toEqual({
        colour: colourOf(r.splMint, r.bridgeContract),
        splMint: r.splMint,
        bridgeContract: r.bridgeContract,
        bridgeProgram: r.bridgeProgram,
        bridgeApi: r.api,
        name: r.name,
        symbol: r.symbol,
        decimals: r.splMintDecimals,
      });
    }
    expect(out.tokens[0]!.colour).not.toBe(out.tokens[1]!.colour);
    // Night Market's own I-1 parser (site, relay) accepts it, colours re-derived there too.
    const parsed = parseJourneyRegistry(out, { midnightNetwork: 'undeployed', solanaGenesisHash: GENESIS });
    expect(parsed.entries.map((e) => e.symbol)).toEqual(['X', 'Y']);
  });

  it("is exactly the registry 00060's P9 harness built from the same records", () => {
    const out = buildJourneyRegistry([rec('x'), rec('y')], UNDEPLOYED);
    const p9 = {
      midnightNetwork: 'undeployed',
      solanaGenesisHash: GENESIS,
      tokens: [rec('x'), rec('y')].map((r) => ({
        colour: r.colour,
        splMint: r.splMint,
        bridgeContract: r.bridgeContract,
        bridgeProgram: r.bridgeProgram,
        bridgeApi: r.api,
        name: r.name,
        symbol: r.symbol,
        decimals: r.splMintDecimals,
      })),
    };
    expect(out).toEqual(p9);
  });

  it('accepts upper-case or 0x-prefixed hex and writes it lower-case', () => {
    const x = rec('x');
    const out = buildJourneyRegistry(
      [{ ...x, colour: `0x${x.colour.toUpperCase()}`, bridgeContract: x.bridgeContract.toUpperCase() }],
      UNDEPLOYED,
    );
    expect(out.tokens[0]!.colour).toBe(x.colour);
    expect(out.tokens[0]!.bridgeContract).toBe(x.bridgeContract);
  });
});

describe('P1 refusals', () => {
  it('a duplicate SPL mint (one canonical deployment per mint)', () => {
    const x = rec('x');
    const contract = Buffer.alloc(32, 0x42).toString('hex');
    const second = { ...x, bridgeContract: contract, colour: colourOf(x.splMint, contract), symbol: 'X2', name: 'X2' };
    expect(refusal([x, second])).toBe('duplicate-mint');
  });

  it('a record for another network', () => {
    expect(refusal([rec('x'), { ...rec('y'), midnightNetwork: 'stagenet' }])).toBe('wrong-network');
    expect(refusal([rec('x'), rec('y')], { midnightNetwork: 'stagenet' })).toBe('wrong-network');
  });

  it('records of two Solana clusters, or another cluster than the expected one', () => {
    const other = base58.encode(new Uint8Array(32).fill(9));
    expect(refusal([rec('x'), { ...rec('y'), solanaGenesisHash: other }])).toBe('mixed-genesis');
    expect(refusal([rec('x'), rec('y')], { midnightNetwork: 'undeployed', solanaGenesisHash: other })).toBe(
      'wrong-genesis-hash',
    );
  });

  it.each([
    ['empty', ''],
    ['9 characters', 'ABCDEFGHI'],
    ['a space', 'X Y'],
    ['non-ASCII', 'Ẋ'],
    ['a control character', 'X\n'],
  ])('a symbol with %s', (_label, symbol) => {
    expect(refusal([{ ...rec('x'), symbol }])).toBe('bad-symbol');
  });

  it('a record without a symbol or a name (I-3 keeps them optional, I-1 needs them)', () => {
    const { symbol: _s, ...noSymbol } = rec('x');
    const { name: _n, ...noName } = rec('x');
    expect(refusal([noSymbol])).toBe('bad-symbol');
    expect(refusal([noName])).toBe('missing-name');
    expect(refusal([{ ...rec('x'), name: 'N'.repeat(65) }])).toBe('missing-name');
  });

  it('accepts an 8-character symbol with punctuation', () => {
    expect(refusal([{ ...rec('x'), symbol: 'wUSDC.e8' }])).toBeNull();
  });

  it('a colour that is not tokenType(domainSep(splMint), bridgeContract)', () => {
    expect(refusal([{ ...rec('x'), colour: rec('y').colour }])).toBe('colour-mismatch');
    expect(refusal([{ ...rec('x'), bridgeContract: rec('y').bridgeContract }])).toBe('colour-mismatch');
  });

  it('a duplicate bridge contract or symbol', () => {
    const x = rec('x');
    const sameContract = another(3, { bridgeContract: x.bridgeContract, symbol: 'Z', name: 'Z' });
    sameContract.colour = colourOf(sameContract.splMint, x.bridgeContract);
    expect(refusal([x, sameContract])).toBe('duplicate-contract');
    expect(refusal([x, another(5, { symbol: 'x', name: 'x' })])).toBe('duplicate-symbol');
  });

  it('a record that is not a deployment record', () => {
    expect(refusal([])).toBe('no-records');
    expect(refusal(['x'])).toBe('record-shape');
    expect(refusal([{ ...rec('x'), schema: 'effectstream.solana-midnight-bridge.deployment/2' }])).toBe('wrong-schema');
    expect(refusal([{ ...rec('x'), splMintDecimals: '6' }])).toBe('record-shape');
    expect(refusal([{ ...rec('x'), splMintDecimals: 19 }])).toBe('decimals');
    expect(refusal([{ ...rec('x'), splMint: 'not-base58!' }])).toBe('record-shape');
  });

  it("anything Night Market's own I-1 parser refuses (an api that is not an origin)", () => {
    expect(refusal([{ ...rec('x'), api: 'http://bridge-x:9999/path' }])).toBe('registry-refused');
  });
});

describe('P1 the command line', () => {
  const files = () => [join(FIX, 'standin-x.record.json'), join(FIX, 'standin-y.record.json')];
  const mintData = (decimals: number) => {
    const d = new Uint8Array(82);
    d[44] = decimals;
    d[45] = 1;
    return d;
  };
  const rpcWith = (opts: { genesis?: string; owner?: string; decimals?: number; missing?: boolean } = {}) => {
    const rpc = mockSolanaRpc({ genesisHash: opts.genesis ?? GENESIS });
    rpc.accounts.set(rec('x').splMint, {
      owner: opts.owner ?? CLASSIC_SPL_TOKEN_PROGRAM,
      data: mintData(opts.decimals ?? 6),
    });
    if (!opts.missing) rpc.accounts.set(rec('y').splMint, { owner: CLASSIC_SPL_TOKEN_PROGRAM, data: mintData(6) });
    return asFetch(rpc.handler);
  };

  it('writes journey-tokens.<net>.json into --out-dir (exit 0), parsed by Night Market', async () => {
    const dir = mkdtempSync(join(tmp, 'ok-'));
    expect(await cli(['--network', 'undeployed', '--genesis', GENESIS, '--out-dir', dir, ...files()])).toBe(0);
    const out = JSON.parse(readFileSync(join(dir, 'journey-tokens.undeployed.json'), 'utf8'));
    expect(out.tokens.map((t: { colour: string }) => t.colour)).toEqual([rec('x').colour, rec('y').colour]);
    expect(() =>
      parseJourneyRegistry(out, { midnightNetwork: 'undeployed', solanaGenesisHash: GENESIS }),
    ).not.toThrow();
  });

  it('reads a bridge node origin as GET <origin>/deployment', async () => {
    const dir = mkdtempSync(join(tmp, 'api-'));
    const seen: string[] = [];
    const nodes = asFetch((req) => {
      seen.push(req.url);
      if (req.url === 'http://bridge-x:9999/deployment') return json(rec('x'));
      if (req.url === 'http://bridge-y:9999/deployment') return json(rec('y'));
      return json({ error: 'not found' }, 404);
    });
    const out = join(dir, 'reg.json');
    expect(
      await cli(['--network', 'undeployed', '--out', out, 'http://bridge-x:9999', 'http://bridge-y:9999/'], nodes),
    ).toBe(0);
    expect(seen).toEqual(['http://bridge-x:9999/deployment', 'http://bridge-y:9999/deployment']);
    expect(JSON.parse(readFileSync(out, 'utf8')).tokens).toHaveLength(2);
  });

  it('checks the genesis hash and every mint on --solana-rpc', async () => {
    const run = async (f: typeof fetch) => {
      const out = join(mkdtempSync(join(tmp, 'rpc-')), 'reg.json');
      const code = await cli(['--network', 'undeployed', '--solana-rpc', 'http://rpc', '--out', out, ...files()], f);
      return { code, written: existsSync(out) };
    };
    expect(await run(rpcWith())).toEqual({ code: 0, written: true });
    expect(await run(rpcWith({ genesis: base58.encode(new Uint8Array(32).fill(4)) }))).toEqual({
      code: 65,
      written: false,
    });
    expect(await run(rpcWith({ owner: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' }))).toEqual({
      code: 65,
      written: false,
    });
    expect(await run(rpcWith({ decimals: 9 }))).toEqual({ code: 65, written: false });
    expect(await run(rpcWith({ missing: true }))).toEqual({ code: 65, written: false });
  });

  it('refuses with exit 65 and writes nothing; usage errors exit 64', async () => {
    const dir = mkdtempSync(join(tmp, 'no-'));
    const dup = join(dir, 'dup.json');
    expect(await cli(['--network', 'undeployed', '--out', dup, files()[0]!, files()[0]!])).toBe(65);
    expect(existsSync(dup)).toBe(false);
    expect(await cli(['--network', 'stagenet', '--out', dup, ...files()])).toBe(65);
    expect(existsSync(dup)).toBe(false);
    expect(await cli(files())).toBe(64);
    expect(await cli(['--network', 'undeployed'])).toBe(64);
    expect(await cli(['--network', 'undeployed', '--bogus', 'x', ...files()])).toBe(64);
  });
});
