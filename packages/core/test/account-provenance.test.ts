// AA 00047 P11.A (audit round 3: R3-1 / F-A3-1 MAJOR, R3-10 / F-A3-6.3; spec FR-004b "Round 3"): the
// browser proves where its account came from. The deploy-time state must be the honest constructor's
// (run here with the arguments the browser knows), nothing but the market's own steps may write before
// the maintenance authority retires, the counters are bounded on every check, and a deploy the indexer
// does not show is "not known yet", never a stricter judgement of the current state.
//
// Every state is REAL serialised ContractState: the live stagenet account A as the public indexer
// served it (test/fixtures/stagenet-account-a-origin.json, read-only, 2026-10-02), or built by the
// compiled account's own constructor (./fixtures/account-origin.ts). Auditor A's time-bomb probe
// (evidence/00047-mn-bank-solana/audit/round3/auditor-A/audit-a3-probe-round.ts) is replayed below on
// the market's compiled account, then refused.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import * as rt from '@midnight-ntwrk/compact-runtime-0.20';
import { x25519 } from '@noble/curves/ed25519.js';
import nacl from 'tweetnacl';
import { describe, expect, it } from 'vitest';

import * as Strict from '../../../vendor/passport/contract/contracts/managed/account/contract/index.js';
import { Ed25519Device } from '../../../vendor/passport/contract/src/wallet/ed25519.js';
import { emptyCoinStore, makeWitnesses } from '../../../vendor/passport/contract/src/wallet/witnesses.js';
import { bytesToHex, hexToBytes } from '../src/hex.js';
import {
  COUNTER_BOUND,
  MARKET_ACCOUNT_WAVES,
  MAX_WINDOW_BLOCKS,
  PINNED_ACCOUNT_KEYS,
  checkAccountOrigin,
  checkMarketAccount,
  compareWithConstructor,
  constructorState,
  canonicalStateBytes,
  decodeAccountState,
  networkSaltFor,
  readAccountOrigin,
  type GraphQLRead,
  type MarketAccountExpectation,
  type OriginExpectation,
  type OriginVerdict,
} from '../src/passport/index.js';
import {
  DEPLOY_TX_HASH,
  DEPLOY_TX_IDENTIFIER,
  WAVE_ONE,
  WAVE_ONE_KEYS,
  originIndexer,
  type OriginSpec,
} from './fixtures/account-origin.js';
import { FIXTURE_VERIFIER_KEYS, accountStateHex, type AccountStateSpec } from './fixtures/account-state.js';

const ACCOUNT = '7e'.repeat(32);
const SALT = networkSaltFor('stagenet');
const DEVICE = bytesToHex(nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7)).publicKey);
const ENC = bytesToHex(x25519.getPublicKey(new Uint8Array(32).fill(9)));
const base: OriginSpec = { account: ACCOUNT, deviceKey: DEVICE, encKey: ENC, salt: SALT };
const expect_: OriginExpectation = { encPublicKey: ENC, networkSalt: SALT, verifierKeys: PINNED_ACCOUNT_KEYS.circuits };
const codes = (c: { problems: Array<{ code: string }> }) => c.problems.map((p) => p.code);
const details = (c: { problems: Array<{ detail?: string }> }) => c.problems.map((p) => p.detail ?? '').join(' | ');

/** A GraphQL read served by a fake indexer, recording every query. */
function served(answer: (q: string, v: Record<string, unknown>) => unknown) {
  const queries: string[] = [];
  const read: GraphQLRead = async <T>(q: string, v: Record<string, unknown>) => {
    queries.push(q.match(/query (\w+)/)?.[1] ?? '?');
    const data = answer(q, v);
    if (data === undefined) throw new Error(`unexpected query ${q.slice(0, 40)}`);
    return data as T;
  };
  return { read, queries };
}

/** The origin verdict for a spec, as the page computes it. */
async function verdictFor(spec: Partial<OriginSpec>, opts: { deployTx?: string } = {}, e = expect_) {
  const ix = await originIndexer({ ...base, ...spec });
  const { read, queries } = served(ix.answer);
  const r = await readAccountOrigin(read, ACCOUNT, opts);
  return { verdict: await checkAccountOrigin(r, e), read: r, queries };
}

// ── The real thing: stagenet account A ──────────────────────────────────────────────────

interface AFixture {
  account: string;
  deployTx: { identifier: string; hash: string };
  origin: { contract: { deploys: Array<{ state: string }>; updates: Array<{ state: string }> } };
  blocks: Record<string, unknown>;
}
const A = JSON.parse(
  readFileSync(new URL('../../../test/fixtures/stagenet-account-a-origin.json', import.meta.url), 'utf8'),
) as AFixture;
const aRead = (over: { noDeployRecord?: boolean } = {}) =>
  served((q, v) => {
    if (q.includes('AccountOrigin($'))
      return over.noDeployRecord ? { contract: { ...A.origin.contract, deploys: [] } } : A.origin;
    if (q.includes('AccountOriginWindow('))
      return Object.fromEntries(Object.entries(v).map(([k, h]) => [k.replace(/^h/, 'b'), A.blocks[String(h)] ?? null]));
    if (q.includes('AccountDeployTx(') && String(v.tx) === A.deployTx.identifier)
      return {
        transactions: [
          {
            id: 22998,
            hash: A.deployTx.hash,
            block: { height: 685597 },
            contractActions: [
              { __typename: 'ContractDeploy', address: A.account, state: A.origin.contract.deploys[0]!.state },
            ],
          },
        ],
      };
    return undefined;
  });
/** Account A's own key set and waves (it predates Q27: 11 circuits, the device pair in wave 2). */
const aDeployed = rt.ContractState.deserialize(hexToBytes(A.origin.contract.deploys[0]!.state));
const aEnc = bytesToHex(Strict.ledger(aDeployed.data).enc_key);
const aKeys = decodeAccountState(A.account, A.origin.contract.updates[0]!.state).operations;
const aWaves = {
  waveOne: MARKET_ACCOUNT_WAVES.waveOne,
  waveTwo: Object.keys(aKeys).filter((c) => !MARKET_ACCOUNT_WAVES.waveOne.includes(c)),
};
const aExpect: OriginExpectation = { encPublicKey: aEnc, networkSalt: SALT, verifierKeys: aKeys, waves: aWaves };

describe('stagenet account A: a real market account’s origin passes (R3-1)', () => {
  it('its deploy-time state is byte for byte the constructor’s, run with the browser’s arguments', async () => {
    const cmp = await compareWithConstructor(aDeployed, { encPublicKey: aEnc, networkSalt: SALT });
    expect(cmp).toEqual({ equal: true, fields: [] });
    // Another browser's key in the constructor's place: a different account, refused field by field.
    const other = await compareWithConstructor(aDeployed, { encPublicKey: ENC, networkSalt: SALT });
    expect(other).toEqual({ equal: false, fields: ['enc_key'] });
  });

  it('its whole origin (deploy, one retiring update, nothing else in the window) passes', async () => {
    const { read, queries } = aRead();
    const r = await readAccountOrigin(read, A.account);
    expect(r.found && r.origin.window).toEqual([
      { kind: 'deploy', txId: 22998, txHash: A.deployTx.hash, height: 685597 },
      { kind: 'update', txId: 22999, txHash: expect.stringMatching(/^860608cd/), height: 685600 },
    ]);
    expect(queries).toEqual(['AccountOrigin', 'AccountOriginWindow']); // one window page: 4 blocks
    expect(await checkAccountOrigin(r, aExpect)).toEqual({ known: true, problems: [] });
  });

  it('without its deploy record it is read from the deploy transaction the browser recorded (R3-10)', async () => {
    const { read, queries } = aRead({ noDeployRecord: true });
    const r = await readAccountOrigin(read, A.account, { deployTx: A.deployTx.identifier });
    expect(r.found && r.origin.deployFrom).toBe('deploy-transaction');
    expect(queries).toEqual(['AccountOrigin', 'AccountDeployTx', 'AccountOriginWindow']);
    expect(await checkAccountOrigin(r, aExpect)).toEqual({ known: true, problems: [] });
  });
});

// ── Auditor A's time-bomb probe, replayed on the market's compiled account ─────────────────────

describe('auditor A’s `round` time bomb (audit-a3-probe-round.ts) is refused (R3-1, F-A3-1)', () => {
  // The probe's own values (`det` is its deterministic byte source).
  const det = (label: string, n = 32): Uint8Array => {
    const out = new Uint8Array(n);
    let i = 0;
    for (let block = 0; i < n; block++)
      for (const b of createHash('sha256').update(`aa00047 audit A3 round ${label} ${block}`).digest())
        if (i < n) out[i++] = b;
    return out;
  };
  const ADDRESS = bytesToHex(det('account address'));
  const PROBE_SALT = det('network salt');
  const PROBE_ENC = det('enc key');
  const TOKEN = hexToBytes('a9e63fe9160bbe0e5758b310db16644d7d147eed8757f13c05197c057538926d'); // utwUSDC
  const pc = (Strict as unknown as { pureCircuits: Record<string, (...a: unknown[]) => Uint8Array> }).pureCircuits;
  const L = (s: unknown) => Strict.ledger(s as rt.StateValue);

  it(
    'the bomb is real: the account works for a few calls, then freezes with the funds in it',
    { timeout: 120_000 },
    async () => {
      const device = Ed25519Device.fromSeed(det('victim seed'), { label: 'Night Market - stagenet' });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the probe's untyped calls, as auditor A wrote them
      const contract = new (Strict as unknown as { Contract: new (w: unknown) => any }).Contract(makeWitnesses());
      const bootSalt = det('boot salt');
      const boot = pc.derive_boot_commitment_with_ed25519!(bootSalt, device.pk);
      const init = await contract.initialState(
        rt.createConstructorContext(emptyCoinStore(det('enc secret')), '00'.repeat(32)),
        boot,
        PROBE_ENC,
        PROBE_SALT,
        { bytes: new Uint8Array(32) },
        { bytes: new Uint8Array(32) },
      );
      const honest = init.currentContractState.data.state as rt.StateValue;
      // The malicious deployer's state: the honest one with `round` (slot 0) set to 2^64 - 4.
      const fields = honest.asArray()!;
      const roundDescriptor = new rt.CompactTypeUnsignedInteger(18446744073709551615n, 8);
      let forged = rt.StateValue.newArray();
      for (let i = 0; i < fields.length; i++)
        forged = forged.arrayPush(
          i === 0
            ? rt.StateValue.newCell({
                value: roundDescriptor.toValue(18446744073709551615n - 3n),
                alignment: roundDescriptor.alignment(),
              })
            : fields[i]!,
        );
      expect(L(forged).round).toBe(18446744073709551612n);

      // What the customer does, as in the probe: activation and two deposits work...
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the probe's untyped calls, as auditor A wrote them
      const stateOf = (res: any) =>
        (res.context.queryContexts?.[ADDRESS] ?? res.context.callContext.currentQueryContext).state;
      const ctxFor = (circuitId: string, state: unknown) =>
        rt.createCircuitContext({
          circuitId,
          contractAddress: ADDRESS,
          coinPublicKeyOrZswapState: '00'.repeat(32),
          contractState: state as never,
          privateState: emptyCoinStore(),
        });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the probe's untyped calls, as auditor A wrote them
      let state: any = new rt.ChargedState(forged);
      state = stateOf(
        await contract.impureCircuits.activate_initial_device_with_ed25519(
          ctxFor('activate_initial_device_with_ed25519', state),
          device.pk,
          bootSalt,
        ),
      );
      state = stateOf(
        await contract.impureCircuits.deposit_unshielded(ctxFor('deposit_unshielded', state), TOKEN, 5_000_000n),
      );
      state = stateOf(
        await contract.impureCircuits.deposit_unshielded(ctxFor('deposit_unshielded', state), TOKEN, 1_000_000n),
      );
      expect(L(state).round).toBe(18446744073709551615n);
      // ...and then a validly signed withdrawal of everything fails, as does any further deposit.
      const ctx = {
        contractAddress: hexToBytes(ADDRESS),
        authNonce: L(state).auth_nonce,
        evmDomainSalt: PROBE_SALT,
        encKey: L(state).enc_key,
      };
      const to = det('owner wallet address');
      const signed = await device.sign(
        ctx,
        { op: 'withdrawUnshielded', color: TOKEN, amount: 6_000_000n, recipient: to },
        0n,
      );
      await expect(
        contract.impureCircuits.withdraw_unshielded_with_ed25519(
          ctxFor('withdraw_unshielded_with_ed25519', state),
          TOKEN,
          6_000_000n,
          { bytes: to },
          signed.pk,
          0n,
          signed.sig,
          signed.show,
        ),
      ).rejects.toThrow(/cast from Field or Uint value to smaller Uint value failed/);
      await expect(
        contract.impureCircuits.deposit_unshielded(ctxFor('deposit_unshielded', state), TOKEN, 1n),
      ).rejects.toThrow(/cast/);

      // THE BROWSER'S CHECK. (a) Its origin: the deploy-time state is not the constructor's (`round`).
      const deployed = new rt.ContractState();
      deployed.data = new rt.ChargedState(forged);
      for (const [name, vk] of Object.entries(WAVE_ONE_KEYS)) {
        const op = new rt.ContractOperation();
        op.verifierKey = hexToBytes(vk);
        deployed.setOperation(name, op);
      }
      const asServed = (cs: rt.ContractState) => bytesToHex(cs.serialize());
      const ix = await originIndexer({
        ...base,
        account: ADDRESS,
        encKey: bytesToHex(PROBE_ENC),
        salt: bytesToHex(PROBE_SALT),
      });
      const { read } = served((q, v) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the probe's untyped calls, as auditor A wrote them
        const a = ix.answer(q, v) as any;
        if (q.includes('AccountOrigin($')) a.contract.deploys[0].state = asServed(deployed);
        return a;
      });
      const probeExpect = {
        encPublicKey: bytesToHex(PROBE_ENC),
        networkSalt: bytesToHex(PROBE_SALT),
        verifierKeys: PINNED_ACCOUNT_KEYS.circuits,
      };
      const verdict = await checkAccountOrigin(await readAccountOrigin(read, ADDRESS), probeExpect);
      expect(verdict.known).toBe(true);
      expect(codes(verdict)).toEqual(['provenance']);
      expect(details(verdict)).toBe('deploy-time round');
      expect(verdict.problems[0]!.message).toMatch(/different starting state/);
      // The same probe state with an honest round passes (the refusal is the round, nothing else).
      const honestDeployed = new rt.ContractState();
      honestDeployed.data = new rt.ChargedState(honest);
      expect((await compareWithConstructor(honestDeployed, probeExpect)).equal).toBe(true);

      // (b) On EVERY check, also of the account as it is after the calls: its counter is out of bounds.
      const now = new rt.ContractState();
      now.data = new rt.ChargedState(state.state ?? state);
      for (const [name, vk] of Object.entries(FIXTURE_VERIFIER_KEYS)) {
        const op = new rt.ContractOperation();
        op.verifierKey = hexToBytes(vk);
        now.setOperation(name, op);
      }
      now.maintenanceAuthority = new rt.ContractMaintenanceAuthority([], 1, 1n);
      now.balance = new Map([[{ tag: 'unshielded', raw: bytesToHex(TOKEN) }, 6_000_000n]]) as never;
      const s = decodeAccountState(ADDRESS, asServed(now));
      expect(s.round).toBe('18446744073709551615');
      const c = checkMarketAccount(s, {
        deviceKey: device.publicKeyHex,
        encPublicKey: bytesToHex(PROBE_ENC),
        networkSalt: bytesToHex(PROBE_SALT),
        verifierKeys: PINNED_ACCOUNT_KEYS.circuits,
      });
      expect(codes(c)).toEqual(['counters']);
      expect(c.problems[0]!.detail).toBe('round 18446744073709551615');
      expect(c.useCounter).toBeNull();
    },
  );
});

// ── The origin rules ────────────────────────────────────────────────────────────────────

describe('checkAccountOrigin: the deploy-time state is the constructor’s (R3-1)', () => {
  it('the market’s waves are the fixture’s, and every pinned circuit is in exactly one wave', () => {
    expect(MARKET_ACCOUNT_WAVES.waveOne).toEqual([...WAVE_ONE]);
    expect([...MARKET_ACCOUNT_WAVES.waveOne, ...MARKET_ACCOUNT_WAVES.waveTwo].sort()).toEqual(
      Object.keys(PINNED_ACCOUNT_KEYS.circuits).sort(),
    );
  });

  it('an honest origin passes; the constructor is the compiled account’s own', async () => {
    const { verdict, queries } = await verdictFor({});
    expect(verdict).toEqual({ known: true, problems: [] });
    expect(queries).toEqual(['AccountOrigin', 'AccountOriginWindow']);
    const s = await constructorState({ boot: new Uint8Array(32).fill(1), encPublicKey: ENC, networkSalt: SALT });
    expect(Strict.ledger(s).round).toBe(0n);
    expect(canonicalStateBytes(s)).toBe(canonicalStateBytes(s));
  });

  const CASES: Array<[string, OriginSpec['deploy'], string[], RegExp]> = [
    ['`round` near 2^64 (auditor A’s bomb)', { round: (1n << 64n) - 4n }, ['provenance'], /deploy-time round/],
    ['`round` just one above 0', { round: 1n }, ['provenance'], /deploy-time round/],
    ['an auth nonce already moved', { authNonce: 5n }, ['provenance'], /deploy-time auth_nonce/],
    ['a note in its inbox (R2-6)', { inbox: ['ab'.repeat(192)] }, ['not-empty'], /deploy-time inbox, inbox_count/],
    [
      'a credited balance near 2^128 (R2-6)',
      { credited: [['ef'.repeat(32), (1n << 128n) - 1n]] },
      ['not-empty'],
      /unshielded_balances/,
    ],
    ['tokens held by the deploy', { unshielded: [['ef'.repeat(32), 5n]] }, ['not-empty'], /holdings 1/],
    ['another encryption key in the constructor', { encKey: 'e1'.repeat(32) }, ['provenance'], /deploy-time enc_key/],
    ['another network’s salt', { salt: networkSaltFor('undeployed') }, ['provenance'], /deploy-time evm_domain_salt/],
    [
      'a wave 1 with a key swapped',
      { operations: { ...WAVE_ONE_KEYS, deposit_unshielded: WAVE_ONE_KEYS.deposit_shielded! } },
      ['provenance'],
      /deploy \(wave 1\): different: deposit_unshielded/,
    ],
    [
      'a wave 1 with an extra circuit',
      { operations: FIXTURE_VERIFIER_KEYS },
      ['provenance'],
      /extra: open_swap_shielded_with_ed25519/,
    ],
  ];
  for (const [what, deploy, want, detail] of CASES) {
    it(`refuses a deploy with ${what}`, async () => {
      const { verdict } = await verdictFor({ deploy });
      expect(verdict.known).toBe(true);
      expect(codes(verdict)).toEqual(want);
      expect(details(verdict)).toMatch(detail);
    });
  }

  it('accepts any boot commitment (it binds the device that may activate; the device check is separate)', async () => {
    const { verdict } = await verdictFor({ deploy: { boot: '42'.repeat(32) } });
    expect(verdict).toEqual({ known: true, problems: [] });
  });
});

describe('checkAccountOrigin: nothing else writes before the authority retires (R3-1, second route)', () => {
  const window = async (spec: Partial<OriginSpec>) => (await verdictFor(spec)).verdict;

  it('the activation may land before the retirement (once)', async () => {
    expect(
      await window({ windowExtra: [{ kind: 'call', entryPoint: 'activate_initial_device_with_ed25519' }] }),
    ).toEqual({
      known: true,
      problems: [],
    });
    const twice = await window({
      windowExtra: [
        { kind: 'call', entryPoint: 'activate_initial_device_with_ed25519' },
        { kind: 'call', entryPoint: 'activate_initial_device_with_ed25519', height: 102 },
      ],
    });
    expect(codes(twice)).toEqual(['provenance']);
  });

  const STRAYS: Array<[string, Partial<OriginSpec>, RegExp]> = [
    [
      'a deposit (a write under a temporary key, then the pinned key put back)',
      { windowExtra: [{ kind: 'call', entryPoint: 'deposit_unshielded' }] },
      /call deposit_unshielded/,
    ],
    [
      'a gated call',
      { windowExtra: [{ kind: 'call', entryPoint: 'withdraw_unshielded_with_ed25519', height: 103 }] },
      /withdraw_unshielded/,
    ],
    [
      'a call inside the deploy’s own transaction',
      { windowExtra: [{ kind: 'call', entryPoint: 'activate_initial_device_with_ed25519', sameTxAs: 'deploy' }] },
      /call activate/,
    ],
    [
      'a call inside the retiring update’s transaction',
      { windowExtra: [{ kind: 'call', entryPoint: 'deposit_shielded', sameTxAs: 'update' }] },
      /call deposit_shielded/,
    ],
  ];
  for (const [what, spec, detail] of STRAYS) {
    it(`refuses ${what}`, async () => {
      const v = await window(spec);
      expect(codes(v)).toEqual(['provenance']);
      expect(details(v)).toMatch(detail);
      expect(v.problems[0]!.message).toMatch(/before its contract was locked/);
    });
  }

  it('refuses no update, two updates, an update that keeps the authority, or other wave-2 keys', async () => {
    expect(details(await window({ updates: [] }))).toMatch(/0 maintenance updates/);
    expect(details(await window({ updates: [{}, {}] }))).toMatch(/2 maintenance updates/);
    expect(details(await window({ updates: [{ authority: { committee: 1, threshold: 1 } }] }))).toMatch(/committee 1/);
    const swapped = {
      ...FIXTURE_VERIFIER_KEYS,
      open_swap_shielded_with_ed25519: FIXTURE_VERIFIER_KEYS.append_inbox_with_ed25519!,
    };
    expect(details(await window({ updates: [{ operations: swapped }] }))).toMatch(
      /update \(wave 2\): different: open_swap/,
    );
  });

  it(`refuses a window longer than ${MAX_WINDOW_BLOCKS} blocks without reading it`, async () => {
    const { verdict, queries } = await verdictFor({ deployHeight: 100, updateHeight: 100 + MAX_WINDOW_BLOCKS });
    expect(codes(verdict)).toEqual(['provenance']);
    expect(details(verdict)).toMatch(/update block 200/);
    expect(queries).toEqual(['AccountOrigin']);
    // At the limit it is read, in pages of 10.
    const ok = await verdictFor({ deployHeight: 100, updateHeight: 100 + MAX_WINDOW_BLOCKS - 1 });
    expect(ok.verdict).toEqual({ known: true, problems: [] });
    expect(ok.queries.filter((q) => q === 'AccountOriginWindow')).toHaveLength(10);
  });
});

describe('a deploy the indexer does not show is "not known yet", never judged on the current state (R3-10)', () => {
  it('no deploy record and no recorded deploy: not known (temporary), with one plain problem', async () => {
    const { verdict, queries } = await verdictFor({ noDeployRecord: true });
    expect(verdict.known).toBe(false);
    expect(codes(verdict)).toEqual(['provenance-unknown']);
    expect(queries).toEqual(['AccountOrigin']);
  });

  it('no deploy record: the recorded deploy transaction is read by hash or identifier and judged', async () => {
    for (const deployTx of [DEPLOY_TX_HASH, DEPLOY_TX_IDENTIFIER]) {
      const { verdict, read } = await verdictFor({ noDeployRecord: true }, { deployTx });
      expect(read.found && read.origin.deployFrom).toBe('deploy-transaction');
      expect(verdict).toEqual({ known: true, problems: [] });
      // And it is judged like a record: a bomb found this way is refused.
      const bomb = await verdictFor({ noDeployRecord: true, deploy: { round: 1n << 63n } }, { deployTx });
      expect(codes(bomb.verdict)).toEqual(['provenance']);
    }
  });

  it('a recorded transaction that is not this account’s deploy proves nothing', async () => {
    const { verdict } = await verdictFor({ noDeployRecord: true }, { deployTx: 'ab'.repeat(32) });
    expect(verdict.known).toBe(false);
  });

  it('a window block the indexer does not serve is "not known yet", not a refusal', async () => {
    const { verdict } = await verdictFor({ missingBlock: 101 });
    expect(verdict.known).toBe(false);
  });

  it('no contract at the address: not known', async () => {
    expect((await verdictFor({ noContract: true })).verdict.known).toBe(false);
  });
});

// ── The counters, on every check ───────────────────────────────────────────────────────────

describe('checkMarketAccount: the counters are bounded on every check (R3-1)', () => {
  const honest: AccountStateSpec = {
    account: ACCOUNT,
    deviceKey: DEVICE,
    encKey: ENC,
    salt: SALT,
    authNonce: 4n,
    useCounter: 4n,
  };
  const e = (over: Partial<MarketAccountExpectation> = {}): MarketAccountExpectation => ({
    deviceKey: DEVICE,
    encPublicKey: ENC,
    networkSalt: SALT,
    verifierKeys: PINNED_ACCOUNT_KEYS.circuits,
    ...over,
  });
  const check = async (spec: Partial<AccountStateSpec>, origin?: OriginVerdict) =>
    checkMarketAccount(decodeAccountState(ACCOUNT, await accountStateHex({ ...honest, ...spec })), e(), origin);

  it('passes an account in use far below the bounds', async () => {
    expect(codes(await check({ round: COUNTER_BOUND - 1n }))).toEqual([]);
  });

  it('refuses `round`, the auth nonce or the inbox count at the bound, and a moved device epoch', async () => {
    expect(details(await check({ round: COUNTER_BOUND }))).toBe(`round ${COUNTER_BOUND}`);
    expect(details(await check({ round: (1n << 64n) - 1n }))).toBe('round 18446744073709551615');
    const nonce = await check({ authNonce: 1n << 60n, useCounter: 1n << 60n });
    expect(codes(nonce)).toEqual(['counters']);
    expect(details(nonce)).toMatch(/^auth nonce 1152921504606846976/);
    expect(codes(await check({ deviceEpoch: 1n << 16n }))).toContain('counters');
    expect((await check({ round: COUNTER_BOUND })).problems[0]!.message).toMatch(/freezing your tokens/);
  });

  it('refuses a credited balance the contract does not hold; a backed one passes', async () => {
    const colour = 'ef'.repeat(32);
    expect(codes(await check({ credited: [[colour, 5n]], unshielded: [[colour, 5n]] }))).toEqual([]);
    const unbacked = await check({ credited: [[colour, 6n]], unshielded: [[colour, 5n]] });
    expect(codes(unbacked)).toEqual(['counters']);
    expect(details(unbacked)).toBe(`${colour}: credited 6, held 5`);
    expect(codes(await check({ credited: [[colour, (1n << 128n) - 1n]] }))).toEqual(['counters']);
  });

  it('adds the origin’s problems; without an origin the current state’s contents are not judged (R3-10)', async () => {
    // A deposit by anyone since the deploy: a note and a holding, not the deployer's doing.
    const used = { inbox: ['ab'.repeat(192)], unshielded: [['ef'.repeat(32), 1n]] as Array<readonly [string, bigint]> };
    expect(codes(await check(used))).toEqual([]);
    const fresh = checkMarketAccount(
      decodeAccountState(ACCOUNT, await accountStateHex({ ...honest, ...used, authNonce: 0n, useCounter: 0n })),
      e({ fresh: true }),
    );
    expect(codes(fresh)).toEqual([]);
    const refused: OriginVerdict = { known: true, problems: [{ code: 'provenance', message: 'x' }] };
    expect(codes(await check({}, refused))).toEqual(['provenance']);
    expect((await check({}, refused)).useCounter).toBeNull();
  });
});
