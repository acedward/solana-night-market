// AA 00047 P9.S (spec FR-004b, questions Q25 B′): beside the wallet's text, the signing panel lists
// what the CONTRACT enforces for the call: each amount in base units with the token's full id, the
// site's name and decimals marked as only the site's label; recipients and the deadline in full. The
// signing seam announces those facts just before the wallet is asked, and the panel shows them only
// for an account call (never for a relay envelope).

import nacl from 'tweetnacl';
import { bytesToHex, registryFor, type DeviceSigner, type OpenSwapPayload } from '@nightmarket/core';
import {
  cancelOffersRequest,
  restoreEncKeyRequest,
  withdrawRequest,
  withdrawUnshieldedRequest,
} from '@nightmarket/core/passport';
import { describe, expect, it } from 'vitest';

import { SignFactsMismatchError, missingFromSignedText, signFacts, type SignFacts } from '../src/wallet/sign-facts.js';
import { SignPromptStore } from '../src/wallet/sign-prompt.js';
import { ed25519ActionSigning } from '../src/wallet/signing.js';

const tokens = registryFor('stagenet');
const twUSDC = tokens.bySymbol('twUSDC')!.midnightColour;
const twBTC = tokens.bySymbol('twBTC')!.midnightColour;
const UNKNOWN = '99'.repeat(32);

const swap = (over: Partial<OpenSwapPayload> = {}): OpenSwapPayload => ({
  giveColor: twBTC,
  giveAmount: '1000000',
  wantColor: twUSDC,
  wantAmount: '10000000',
  wantNonce: '44'.repeat(32),
  wantEntry: '55'.repeat(192),
  changeEntry: '66'.repeat(192),
  validUntil: '1790868312',
  coin: { nonce: '77'.repeat(32), color: twBTC, value: '10000000', mtIndex: '12' },
  authNonce: '5',
  ...over,
});

describe('signFacts (Q25 B′: base units and token ids; the name is the site’s label)', () => {
  it('lists a make’s legs in base units with the full token ids, and its signed expiry', () => {
    const f = signFacts({ kind: 'swap', action: 'open-swap', payload: swap() }, tokens)!;
    expect(f.title).toBe('Make an offer');
    expect(f.signedTitle).toBe('Swap offer');
    expect(f.facts).toEqual([
      // The site label as the F3 v2 wallet line shows it (the client's `renderSiteLabel`): every
      // decimal. `signed`: the wallet text's lines the fact stands for.
      {
        kind: 'amount',
        label: 'Give',
        baseUnits: '1000000',
        tokenId: twBTC,
        siteLabel: '0.01000000 twBTC',
        listed: true,
        signed: ['Give base units 1000000', `Give token ${twBTC}`, 'This site labels it: 0.01000000 twBTC'],
      },
      {
        kind: 'amount',
        label: 'Get',
        baseUnits: '10000000',
        tokenId: twUSDC,
        siteLabel: '10.000000 twUSDC',
        listed: true,
        signed: ['Get base units 10000000', `Get token ${twUSDC}`, 'This site labels it: 10.000000 twUSDC'],
      },
      {
        kind: 'text',
        label: 'Expires',
        value: '2026-10-01 15:25:12 UTC',
        signed: ['Expires 2026-10-01 15:25:12 UTC'],
      },
      { kind: 'text', label: 'Paid from one coin of', value: '10000000 base units', mono: true, signed: [] },
    ]);
  });

  it('says a token the site does not list is not listed (the base units and id still show)', () => {
    const f = signFacts({ kind: 'swap', action: 'take', payload: swap({ wantColor: UNKNOWN }) }, tokens)!;
    expect(f.title).toBe('Take an offer');
    expect(f.facts[1]).toEqual({
      kind: 'amount',
      label: 'Get',
      baseUnits: '10000000',
      tokenId: UNKNOWN,
      siteLabel: '10000000 ?',
      listed: false,
      signed: ['Get base units 10000000', `Get token ${UNKNOWN}`, 'This site labels it: 10000000 ?'],
    });
  });

  it('shows an unsigned deadline as never (the page no longer sends one)', () => {
    const f = signFacts({ kind: 'swap', action: 'open-swap', payload: swap({ validUntil: '0' }) }, tokens)!;
    expect(f.facts[2]).toEqual({
      kind: 'text',
      label: 'Expires',
      value: 'never (no expiry)',
      signed: ['Expires never'],
    });
  });

  it('lists a withdrawal’s amount and recipient, and a cancel’s unchanged key', () => {
    const w = signFacts(
      {
        kind: 'gated',
        request: withdrawRequest({
          recipient: '22'.repeat(32),
          color: twUSDC,
          amount: '1500000',
          coin: { nonce: '33'.repeat(32), color: twUSDC, value: '5000000', mtIndex: '9' },
          authNonce: '5',
        }),
      },
      tokens,
    )!;
    expect(w.signedTitle).toBe('Withdraw shielded');
    expect(w.facts.slice(0, 2)).toEqual([
      {
        kind: 'amount',
        label: 'Amount',
        baseUnits: '1500000',
        tokenId: twUSDC,
        siteLabel: '1.500000 twUSDC',
        listed: true,
        signed: ['Base units 1500000', `Token ${twUSDC}`, 'This site labels it: 1.500000 twUSDC'],
      },
      {
        kind: 'text',
        label: 'To (coin key)',
        value: '22'.repeat(32),
        mono: true,
        signed: [`To key ${'22'.repeat(8)}`],
      },
    ]);
    const u = signFacts(
      {
        kind: 'gated',
        request: withdrawUnshieldedRequest({ recipient: '23'.repeat(32), color: twUSDC, amount: '7', authNonce: '5' }),
      },
      tokens,
    )!;
    expect(u.facts[0]).toMatchObject({ baseUnits: '7', tokenId: twUSDC });
    expect(u.signedTitle).toBe('Withdraw unshielded');
    const c = signFacts(
      { kind: 'gated', request: cancelOffersRequest({ newKey: 'ab'.repeat(32), authNonce: '5' }) },
      tokens,
    )!;
    expect(c.title).toBe('Cancel all open offers');
    expect(c.signedTitle).toBe('Cancel all open offers');
    expect(c.facts[1]).toEqual({
      kind: 'text',
      label: 'Encryption key (unchanged)',
      value: 'ab'.repeat(32),
      mono: true,
      signed: [],
    });
  });
});

describe('the wallet is asked only for text that carries every fact the panel shows (AA 00047 P9.I)', () => {
  const kp = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(9));
  const ctx = { account: 'c0'.repeat(32), authNonce: 5n, networkSalt: '71'.repeat(32), encKey: '6c'.repeat(32) };
  const walletOf = () => {
    const asked: Uint8Array[] = [];
    const signer: DeviceSigner = {
      deviceKey: bytesToHex(kp.publicKey),
      address: 'x',
      signMessage: async (m) => (asked.push(m), nacl.sign.detached(m, kp.secretKey)),
    };
    return { signer, asked };
  };

  it('every fact is a line of the real wallet text, for every kind of call', () => {
    const { signer } = walletOf();
    const signing = ed25519ActionSigning(signer, { network: 'stagenet', tokens });
    const calls = [
      { kind: 'swap', action: 'open-swap', payload: swap() },
      { kind: 'swap', action: 'take', payload: swap({ wantColor: UNKNOWN, validUntil: '0' }) },
      {
        kind: 'gated',
        request: withdrawRequest({
          recipient: '22'.repeat(32),
          color: twUSDC,
          amount: '1500000',
          coin: { nonce: '33'.repeat(32), color: twUSDC, value: '5000000', mtIndex: '9' },
          authNonce: '5',
        }),
      },
      {
        kind: 'gated',
        request: withdrawUnshieldedRequest({ recipient: '23'.repeat(32), color: twUSDC, amount: '7', authNonce: '5' }),
      },
      { kind: 'gated', request: cancelOffersRequest({ newKey: ctx.encKey, authNonce: '5' }) },
    ] as const;
    for (const call of calls) {
      const facts = signFacts(call as never, tokens)!;
      expect(missingFromSignedText(facts, signing.preview(ctx, call as never).text)).toEqual([]);
    }
  });

  it('names the lines a text is missing (a site label, a token id, the deadline)', () => {
    const f = signFacts({ kind: 'swap', action: 'open-swap', payload: swap() }, tokens)!;
    const { signer } = walletOf();
    const text = ed25519ActionSigning(signer, { network: 'stagenet', tokens }).preview(ctx, {
      kind: 'swap',
      action: 'open-swap',
      payload: swap(),
    }).text;
    const tampered = text
      .replace('This site labels it: 10.000000 twUSDC', 'This site labels it: 1000.0000 twUSDC')
      .replace('Expires 2026-10-01 15:25:12 UTC', 'Expires never                  ');
    expect(missingFromSignedText(f, tampered)).toEqual([
      'This site labels it: 10.000000 twUSDC',
      'Expires 2026-10-01 15:25:12 UTC',
    ]);
    // A line must match whole: "Base units 1" is not "Base units 10".
    const g = signFacts(
      {
        kind: 'gated',
        request: withdrawUnshieldedRequest({ recipient: '23'.repeat(32), color: twUSDC, amount: '1', authNonce: '5' }),
      },
      tokens,
    )!;
    expect(missingFromSignedText(g, 'x\nWithdraw unshielded\nBase units 10\n')).toContain('Base units 1');
  });

  it('a cancel for a key that is not the account’s is never sent to the wallet ("Rotate encryption key")', async () => {
    const { signer, asked } = walletOf();
    const announced: Array<SignFacts | null> = [];
    const signing = ed25519ActionSigning(signer, { network: 'stagenet', tokens }, undefined, (f) => announced.push(f));
    const call = { kind: 'gated', request: cancelOffersRequest({ newKey: '7d'.repeat(32), authNonce: '5' }) } as const;
    await expect(signing.authorise(ctx, call, 0n)).rejects.toBeInstanceOf(SignFactsMismatchError);
    expect(asked).toHaveLength(0);
    expect(announced.filter(Boolean)).toHaveLength(0); // the panel never showed the facts either
    // The same call for the account's own key goes through, with one prompt.
    await signing.authorise(
      ctx,
      { kind: 'gated', request: cancelOffersRequest({ newKey: ctx.encKey, authNonce: '5' }) },
      0n,
    );
    expect(asked).toHaveLength(1);
    expect(String.fromCharCode(...asked[0]!).split('\n')[1]).toBe('Cancel all open offers');
  });

  it('a registry that labels a token one way for the panel and another for the message is caught', async () => {
    const { signer, asked } = walletOf();
    // A hostile or broken registry: the panel's lookup and the message's lookup disagree.
    let n = 0;
    const flipping = {
      ...tokens,
      byColour: (c: string) => {
        const t = tokens.byColour(c);
        return t && c === twUSDC && n++ > 0 ? { ...t, decimals: 2 } : t;
      },
    } as typeof tokens;
    const signing = ed25519ActionSigning(signer, { network: 'stagenet', tokens: flipping });
    const call = { kind: 'swap', action: 'open-swap', payload: swap() } as const;
    const err = await signing.authorise(ctx, call, 0n).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SignFactsMismatchError);
    expect((err as SignFactsMismatchError).missing).toEqual(['This site labels it: 10.000000 twUSDC']);
    expect(asked).toHaveLength(0);
  });
});

describe('AA 00047 P10 (audit round 2): the lines in ORDER (R2-9), and the key restore (R2-3)', () => {
  const kp = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(11));
  const ctx = { account: 'c0'.repeat(32), authNonce: 5n, networkSalt: '71'.repeat(32), encKey: '6c'.repeat(32) };
  const walletOf = () => {
    const asked: Uint8Array[] = [];
    const signer: DeviceSigner = {
      deviceKey: bytesToHex(kp.publicKey),
      address: 'x',
      signMessage: async (m) => (asked.push(m), nacl.sign.detached(m, kp.secretKey)),
    };
    return { signer, asked };
  };

  it('R2-9: a swap’s two "This site labels it:" lines must each follow their own leg', () => {
    const f = signFacts({ kind: 'swap', action: 'open-swap', payload: swap() }, tokens)!;
    const { signer } = walletOf();
    const text = ed25519ActionSigning(signer, { network: 'stagenet', tokens }).preview(ctx, {
      kind: 'swap',
      action: 'open-swap',
      payload: swap(),
    }).text;
    expect(missingFromSignedText(f, text)).toEqual([]);
    const lines = text.split('\n');
    const give = lines.findIndex((l) => l.startsWith('This site labels it: 0.01000000 twBTC'));
    const get = lines.findIndex((l) => l.startsWith('This site labels it: 10.000000 twUSDC'));
    expect(give).toBeGreaterThan(0);
    expect(get).toBeGreaterThan(give);
    // The same lines, the two labels swapped between the legs: every line is still there (a set match
    // passed it), but not where it belongs.
    const swapped = [...lines];
    [swapped[give], swapped[get]] = [lines[get]!, lines[give]!];
    expect(missingFromSignedText(f, swapped.join('\n')).length).toBeGreaterThan(0);
  });

  it('R2-9: the operation line is the SECOND line, and no fact may come from the free first line', () => {
    const g = signFacts(
      {
        kind: 'gated',
        request: withdrawUnshieldedRequest({ recipient: '23'.repeat(32), color: twUSDC, amount: '1', authNonce: '5' }),
      },
      tokens,
    )!;
    const tail = `Token ${twUSDC}\nThis site labels it: 0.000001 twUSDC\nTo address ${'23'.repeat(8)}\n`;
    expect(missingFromSignedText(g, `Night Market - stagenet\nWithdraw unshielded\nBase units 1\n${tail}`)).toEqual([]);
    // A label imitating the enforced line above the real one (F-A2-3): "Base units 1" only in line 1.
    expect(missingFromSignedText(g, `Base units 1\nWithdraw unshielded\nBase units 1000000\n${tail}`)).toEqual([
      'Base units 1',
    ]);
    // The operation title anywhere but the second line does not count.
    expect(missingFromSignedText(g, `Withdraw unshielded\nSite\nBase units 1\n${tail}`)).toContain(
      'Withdraw unshielded',
    );
  });

  it('R2-3: the restore facts are lines of the real wallet text ("Rotate encryption key / New key …"), in order', async () => {
    const mine = 'b7'.repeat(32);
    const call = {
      kind: 'gated',
      request: restoreEncKeyRequest({ newKey: mine, authNonce: '5' }),
      purpose: 'restore-enc-key',
    } as const;
    const f = signFacts(call, tokens, ctx)!;
    expect(f.title).toBe('Restore my encryption key');
    expect(f.signedTitle).toBe('Rotate encryption key');
    expect(f.facts.find((x) => x.label === "New key (this browser's)")).toMatchObject({
      value: mine,
      signed: [`New key ${'b7'.repeat(8)}`],
    });
    expect(f.facts.find((x) => x.label === 'Replaces the key on Midnight now')).toMatchObject({ value: ctx.encKey });
    const { signer, asked } = walletOf();
    const signing = ed25519ActionSigning(signer, { network: 'stagenet', tokens });
    expect(missingFromSignedText(f, signing.preview(ctx, call).text)).toEqual([]);
    await signing.authorise(ctx, call, 0n);
    expect(asked).toHaveLength(1);
    expect(
      String.fromCharCode(...asked[0]!)
        .split('\n')
        .slice(1, 3),
    ).toEqual(['Rotate encryption key ', `New key ${'b7'.repeat(8)}`]);
    // A "restore" to the account's CURRENT key would read as a cancel: never sent to the wallet.
    const same = { ...call, request: restoreEncKeyRequest({ newKey: ctx.encKey, authNonce: '5' }) } as const;
    await expect(signing.authorise(ctx, same, 0n)).rejects.toBeInstanceOf(SignFactsMismatchError);
    expect(asked).toHaveLength(1);
  });
});

describe('the facts reach the signing panel only for an account call', () => {
  it('announces the call’s facts just before the wallet is asked, then clears them', async () => {
    const kp = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(3));
    const prompts = new SignPromptStore();
    const seen: Array<SignFacts | null> = [];
    const signer: DeviceSigner = {
      deviceKey: bytesToHex(kp.publicKey),
      address: 'x',
      signMessage: async (m) => {
        const p = prompts.open(m, 'Phantom');
        seen.push(p.facts);
        prompts.close('signed');
        return nacl.sign.detached(m, kp.secretKey);
      },
    };
    const signing = ed25519ActionSigning(signer, { network: 'stagenet', tokens }, undefined, (f) =>
      prompts.setFacts(f),
    );
    const ctx = { account: 'c0'.repeat(32), authNonce: 5n, networkSalt: '71'.repeat(32), encKey: '6c'.repeat(32) };
    await signing.authorise(ctx, { kind: 'swap', action: 'open-swap', payload: swap() }, 0n);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.title).toBe('Make an offer');
    // Cleared after: a relay envelope signed next shows no facts.
    const env = new TextEncoder().encode(
      'Night Market - stagenet\nProve you hold this key\nKey x\nFor y\nNonce ' + '0'.repeat(64),
    );
    expect(prompts.open(env, 'Phantom').facts).toBeNull();
  });
});
