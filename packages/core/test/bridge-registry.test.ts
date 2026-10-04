// AA 00060 P1 (T1.5): the I-1 journey registry parser, and the bridge colour against the compiled bridge
// contract's own `tokenColor` (fixtures/bridge-colour.json, computed with the template's compiled module).

import { describe, expect, it } from 'vitest';

import { bridgeColourOf, bridgeDomainSep } from '../src/bridge/colour.js';
import { BridgeRegistryError, parseJourneyRegistry, type BridgeRegistryRefusal } from '../src/bridge/registry.js';
import { bytesToHex } from '../src/hex.js';
import { base58 } from '@scure/base';
import colours from './fixtures/bridge-colour.json';
import fixture from './fixtures/journey-registry.undeployed.json';

const EXPECT = { midnightNetwork: 'undeployed', solanaGenesisHash: fixture.solanaGenesisHash };
const clone = () => JSON.parse(JSON.stringify(fixture)) as typeof fixture;

function refusal(file: unknown, expect = EXPECT): BridgeRegistryRefusal | null {
  try {
    parseJourneyRegistry(file, expect);
    return null;
  } catch (e) {
    if (!(e instanceof BridgeRegistryError)) throw e;
    return e.reason;
  }
}

describe('the bridge colour', () => {
  it('equals the compiled bridge contract’s domainSep and tokenColor', () => {
    for (const v of colours.vectors) {
      expect(bytesToHex(bridgeDomainSep(base58.decode(v.splMint)))).toBe(v.domainSep);
      expect(bridgeColourOf(v.splMint, v.bridgeContract)).toBe(v.colour);
    }
  });
});

describe('T1.5 the I-1 parser', () => {
  it('accepts the fixture and indexes it by colour and mint', () => {
    const r = parseJourneyRegistry(fixture, EXPECT);
    expect(r.entries.map((e) => e.symbol)).toEqual(['X', 'Y']);
    expect(r.byColour(`0x${fixture.tokens[0]!.colour.toUpperCase()}`)?.symbol).toBe('X');
    expect(r.byMint(fixture.tokens[1]!.splMint)?.bridgeApi).toBe('http://127.0.0.1:18081');
    expect(r.byColour('00'.repeat(32))).toBeUndefined();
  });

  it('refuses each case with its named reason', () => {
    const cases: [string, (f: ReturnType<typeof clone>) => void, BridgeRegistryRefusal][] = [
      ['another network', (f) => (f.midnightNetwork = 'stagenet'), 'wrong-network'],
      ['a bad genesis hash', (f) => (f.solanaGenesisHash = 'not-base58-0OIl'), 'bad-genesis-hash'],
      [
        'another genesis hash',
        (f) => (f.solanaGenesisHash = base58.encode(new Uint8Array(32).fill(8))),
        'wrong-genesis-hash',
      ],
      ['a duplicate mint', (f) => (f.tokens[1]!.splMint = f.tokens[0]!.splMint), 'duplicate-mint'],
      ['a duplicate symbol (any case)', (f) => (f.tokens[1]!.symbol = 'x'), 'duplicate-symbol'],
      ['a duplicate colour', (f) => (f.tokens[1]!.colour = f.tokens[0]!.colour), 'duplicate-colour'],
      ['a 9-character symbol', (f) => (f.tokens[0]!.symbol = 'ABCDEFGHI'), 'unrenderable-symbol'],
      ['a symbol with a space', (f) => (f.tokens[0]!.symbol = 'X Y'), 'unrenderable-symbol'],
      ['a non-ASCII symbol', (f) => (f.tokens[0]!.symbol = 'Xé'), 'unrenderable-symbol'],
      ['an empty symbol', (f) => (f.tokens[0]!.symbol = ''), 'unrenderable-symbol'],
      ['decimals 19', (f) => (f.tokens[0]!.decimals = 19), 'decimals'],
      ['a colour that is not the bridge’s', (f) => (f.tokens[0]!.colour = 'ab'.repeat(32)), 'colour-mismatch'],
      ['a malformed mint', (f) => (f.tokens[0]!.splMint = 'abc'), 'bad-mint'],
      ['a bridge API with a path', (f) => (f.tokens[0]!.bridgeApi = 'http://127.0.0.1:18080/api'), 'bad-api'],
      ['no tokens', (f) => (f.tokens.length = 0), 'shape'],
    ];
    for (const [what, patch, reason] of cases) {
      const f = clone();
      patch(f);
      expect(refusal(f), what).toBe(reason);
    }
  });

  it('a refusal names its reason in the message', () => {
    const f = clone();
    f.tokens[0]!.symbol = 'TOOLONGSYM';
    expect(() => parseJourneyRegistry(f, EXPECT)).toThrow(/unrenderable-symbol: tokens\[0\] \("TOOLONGSYM"\)/);
  });

  it('ignores unknown fields (00057 may add some)', () => {
    const f = { ...clone(), generatedBy: '00057', tokens: clone().tokens.map((t) => ({ ...t, extra: 1 })) };
    expect(parseJourneyRegistry(f, EXPECT).entries).toHaveLength(2);
  });
});
