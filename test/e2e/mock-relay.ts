// A MOCK RELAY for the connected-wallet walkthroughs (AA 00047 lane B2), served through page.route.
// It speaks the wire contract of packages/core (api.ts, accounts.ts, trade.ts, demo-tokens.ts,
// withdraw-unshielded.ts, unshielded.ts) and CHECKS every signature the way the real relay does
// (lane B3), in this test process:
//   - an envelope (opening an account, demo tokens) with the Solana scheme
//     (`solanaRelayActionScheme`: Track A's proof-of-key text over the envelope's digest);
//   - an account call (withdrawals, inbox notes, makes and takes) by rebuilding its F3 message from
//     the call's own arguments and the account's state with Track A's `Ed25519Device` whose sign
//     callback returns the browser's signature (`ed25519DeviceForCheck`): every check the arm's
//     client runs (the contract's own rendering, the tweetnacl pre-check, strict R, s < L).
// A signature that fails is refused with 401 `bad-signature` and nothing is queued, so a green
// walkthrough proves the page signed exactly what the relay (and the circuit) rebuild.
//
// State lives here like a chain would keep it: the account's device entry and auth nonce, its inbox
// (entries sealed to the account's own encryption key), its Zswap outputs and spends, and its
// unshielded balances. Jobs succeed on their first poll, unless `holdNextJob()` keeps the next one
// "proving" until the test releases it (the signing modal's progress view, AA 00047 P8.1).
//
// Since AA 00047 P9.S the page reads that state from the PUBLIC INDEXER (./mock-indexer.ts serves it
// from here), never from the relay's own account routes; `lies` makes those routes misreport, to show
// it. Like the real relay after P9.R, an offer or a take must sign a real expiry. A withdrawal's change
// is the contract's (`predictWithdrawChange`), unless `misreportChange` fabricates one (Q28 A).
// `cancel-offers` (questions Q30) re-affirms the account's key and moves its nonce, or answers
// `not-implemented` (`cancelMode`).
//
// AA 00047 P10 (audit round 2): `restore-enc-key` puts the browser's key back (R2-3; `restoreMode`),
// and a relay can lie the ways round 2 found: report a call done that it never landed (`fakeSuccess`),
// land a call and report it failed (`landButFail`), settle the maker's offer it holds when asked to
// cancel (`settleOnCancel`), or file a note in the inbox for a coin that exists nowhere (`fakeNote`).
//
// AA 00047 P11.B (questions Q47 A): the chain also keeps every transaction of the account with its
// height, the entry points of the account's calls in it, and, for a swap, its raw bytes built by
// ledger-v9 itself (./ledger-tx.ts), so the mock indexer serves the account's history the way the
// Midnight indexer does and the page decodes it for real. Round 3's attacks: a real coin deposited
// with an approval's wanted nonce, its note filed (`plantWantedCoin`, R3-6), and a relay report that
// leaves a spend or a leaf out (`omitFromReport`, R3-4; the page no longer reads that report).
//
// AA 00062 (plan I-62a): `clientProving = 'required'` makes the k>=18 actions (a make, a take, the two
// withdrawals, a change filing) wait for the CUSTOMER's proof: the job shows the hand-off (stage
// `awaiting-client-proof`, the `clientProof` field), serves the key-less proof request on
// `GET /v1/jobs/:id/client-proof` and accepts one proof on `POST` (or refuses it, `clientProofVerdict`).
// Every hand-off is kept in `handOffs`, so a test can check what the customer's prover was given.

import { randomBytes } from 'node:crypto';

import type { Route } from '@playwright/test';

import { payloadHash, type RelayActionMessage } from '../../packages/core/src/auth.js';
import { contractCoinCommitment, contractCoinNullifier } from '../../packages/core/src/coins.js';
import { bytesToHex, hexToBytes } from '../../packages/core/src/hex.js';
import {
  callContext,
  cancelOffersRequest,
  restoreEncKeyRequest,
  ed25519DeviceForCheck,
  ed25519DeviceForKey,
  networkSaltFor,
  withdrawRequest,
  appendInboxRequest,
  withdrawUnshieldedRequest,
  openSwapArgs,
  predictChangeCoin,
  predictWithdrawChange,
} from '../../packages/core/src/passport/index.js';
import { sealEntryPortable } from '../../vendor/passport/contract/src/wallet/deposit.js';
import { solanaRelayActionScheme } from '../../packages/core/src/solana-auth.js';
import type { TokenRegistry } from '../../packages/core/src/tokens/registry.js';
import { COLOUR } from '../../packages/core/test/fixtures/kernel/book.js';
import { healthBody } from './errors-fixtures.js';
import { rawTxWithCalls, type MockCall } from './ledger-tx.js';

export const RELAY = 'http://relay.test';
export const ACCOUNT = '7e'.repeat(32);
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
};
/** The stagenet registry's display of the fixture's tokens (symbol, decimals), as the relay renders
 *  them (questions Q12: the browser and the relay must show the same). The registry module itself
 *  imports JSON, which the test runner's Node loader refuses without an import attribute. */
const TOKENS: Record<string, { symbol: string; decimals: number }> = {
  [COLOUR.twUSDC]: { symbol: 'twUSDC', decimals: 6 },
  [COLOUR.twUSDM]: { symbol: 'twUSDM', decimals: 6 },
  [COLOUR.twBTC]: { symbol: 'twBTC', decimals: 8 },
  [COLOUR.twETH]: { symbol: 'twETH', decimals: 18 },
  [COLOUR.utwUSDC]: { symbol: 'utwUSDC', decimals: 6 },
};
const display = {
  network: 'stagenet',
  tokens: { byColour: (c: string) => TOKENS[c.replace(/^0x/, '').toLowerCase()] } as unknown as TokenRegistry,
} as const;

export interface Coin {
  nonce: string;
  color: string;
  value: bigint;
}

/** The demo pack the mock hands out: 1,000 twUSDC, 0.1 twBTC, 1 twETH (spec FR-007's example). */
export const DEMO_PACK = [
  { symbol: 'twUSDC', colour: COLOUR.twUSDC, decimals: 6, amount: '1000000000' },
  { symbol: 'twBTC', colour: COLOUR.twBTC, decimals: 8, amount: '10000000' },
  { symbol: 'twETH', colour: COLOUR.twETH, decimals: 18, amount: '1000000000000000000' },
];

interface Submitted {
  action: string;
  body: Record<string, unknown>;
  /** What the relay's check said. */
  verified: string;
  done: boolean;
  result?: Record<string, unknown>;
  /** The job failed, with the relay's code and words. */
  failed?: { code: string; message: string };
  stages: string[];
  /** Held at "proving" (or the stages given to `at`) until released (`holdNextJob`). */
  held?: Held;
  /** AA 00062: the job's client-proof hand-off (I-62a), once opened. */
  handOff?: HandOff;
}

/** AA 00062: one hand-off of a job to the customer's prover (I-62a). */
export interface HandOff {
  job: string;
  proofId: string;
  circuit: string;
  /** The key-less proof request, standard base64, and where its key material goes. */
  proofRequest: string;
  keyMaterialOffset: number;
  /** Unix seconds. */
  deadline: number;
  fetched: boolean;
  /** The proof the page posted (base64), once accepted or refused. */
  proof: string | null;
  verdict: 'checked' | 'invalid' | null;
}

/** AA 00062: the k>=18 actions and the circuit each hands to the customer's prover. */
export const CLIENT_CIRCUIT_OF: Record<string, string> = {
  'open-swap': 'open_swap_shielded_with_ed25519',
  take: 'open_swap_shielded_with_ed25519',
  withdraw: 'withdraw_shielded_with_ed25519',
  'withdraw-unshielded': 'withdraw_unshielded_with_ed25519',
  'append-inbox': 'append_inbox_with_ed25519',
};
export const KEY_SET = '21493588f30536e0f409dcf79deea54878f0c2cf6fee601a2359e54a776d5c5e';
export const PROOF_SERVER = '9.0.0-rc.8';
const PREIMAGE_TAG = 'midnight:(proof-preimage-versioned,option(proving-data),option(fr-bls)):';

/** A key-less proof request shaped like the ledger's (I-62a): tag, a fake preimage, None, the binding input. */
export function fakeProofRequest(circuit: string): { proofRequest: string; keyMaterialOffset: number } {
  const head = Buffer.concat([
    Buffer.from(PREIMAGE_TAG, 'ascii'),
    Buffer.from(`contract:${ACCOUNT}/${circuit}?vk=${'ab'.repeat(32)}`, 'ascii'),
    randomBytes(64),
  ]);
  const body = Buffer.concat([head, Buffer.from([0x00, 0x01]), randomBytes(32)]);
  return { proofRequest: body.toString('base64'), keyMaterialOffset: head.length };
}

interface Held {
  released: boolean;
  since: number;
  /** The stages shown after "queued" and "running" while held; the last one is the current one. */
  stages: string[];
}

/** Releases a held job; `at` moves it to later stages first (a make's "posted": being listed). */
export interface JobHold {
  (): void;
  at(stages: string[]): void;
}

export class MockRelay {
  readonly submitted: Submitted[] = [];
  /** AA 00060 P4.3: the token-list digest `/v1/config` publishes (none: an older relay). */
  tokensDigest: string | null = null;
  /** Requests refused before anything was queued: `action: code/detail`. */
  readonly refused: string[] = [];
  deviceKey: string | null = null;
  encKey: string | null = null;
  /** The encryption key the account was CREATED with (its deploy-time state; AA 00047 P11, R3-1):
   *  a later key change (`encKey`) never changes it. */
  deployEncKey: string | null = null;
  /** The registration's transactions, as reported to the page (`txs.waveOne` is the deploy). */
  registerTxs: { waveOne: string; waveTwo: string; activation: string } | null = null;
  registered = false;
  /** The account's network salt: the stagenet one, as every market account on stagenet carries. */
  readonly salt = networkSaltFor('stagenet');
  /** The relay's own account routes (state, inbox, unshielded) misreport (the page must not care). */
  lies = false;
  /** Report a fabricated change coin for a withdrawal (Q28 A). */
  misreportChange = false;
  /** `cancel-offers`: done, or this relay cannot run it yet. */
  cancelMode: 'ok' | 'not-implemented' = 'ok';
  /** `restore-enc-key` (R2-3): done, or this relay cannot run it yet. */
  restoreMode: 'ok' | 'not-implemented' = 'ok';
  /** Actions this relay reports done without landing anything (R2-4). */
  readonly fakeSuccess = new Set<string>();
  /** Actions this relay lands, then reports failed (R2-5). */
  readonly landButFail = new Set<string>();
  /** Asked to cancel, this relay settles the maker's offer it holds instead (R2-4). */
  settleOnCancel = false;
  /** Someone deposits a real one-unit coin into the new account right after its deploy (R2-6, Q42). */
  depositAfterDeploy = false;
  /** Refuse the next action request as P10.R's relay does (HTTP status, code, Retry-After; P11.R's
   *  `withdraws-daily-cap` also carries a `detail`). */
  refuseNext: { status: number; code: string; message: string; retryAfter?: number; detail?: string } | null = null;
  /** Fail the next job with this public error (P10.R's job codes, e.g. `market-unavailable`). */
  failNextJob: { code: string; message: string } | null = null;
  /** The `validUntil` of every make and take, as signed. */
  readonly signedExpiries: string[] = [];
  authNonce = 3n;
  useCounter = 0n;
  entries: string[] = [];
  outputs: Array<{ commitment: string; mtIndex: string; txHash: string; blockHeight: number }> = [];
  inputs: Array<{ nullifier: string; txHash: string; blockHeight: number }> = [];
  /** Every transaction of the account, by hash: its height and order, the entry points of the account's
   *  calls in it, and (a swap) its calls and raw bytes (AA 00047 P11.B). */
  readonly chainTxs = new Map<
    string,
    { height: number; id: number; entryPoints: string[]; calls: MockCall[]; raw?: string }
  >();
  /** Commitments and nullifiers the relay's own `/zswap` report leaves out (R3-4). */
  readonly omitFromReport = new Set<string>();
  /** How often the page asked the relay for its Zswap report (AA 00047 P11.B: never). */
  zswapReads = 0;
  /** Leave every withdrawal's spend and change out of the `/zswap` report (R3-4). */
  omitWithdrawalsFromReport = false;
  /** Refuse `/zswap` as the relay at `b8d81e9` does from 500 actions on (501 `history-too-long`,
   *  audit round 3 R3-5 / F-B3-4). */
  zswapHistoryTooLong = false;
  unshielded = new Map<string, bigint>();
  demo = { enabled: true, dailyCap: 25, remainingToday: 7, claimed: new Set<string>() };
  offerStatus: Record<string, string> = {};
  /** What the exchange says about the next make when the relay stops waiting (`live` = listed). */
  makeListing = 'live';
  /** Told of every make as the relay posts it to the exchange (AA 00060 FR-026: a test lists it in the
   *  exchange's book, as the kernel does, before the page reads the book again). */
  onMake: ((offerId: string, payload: Record<string, string>) => void) | null = null;
  /** Render with another token list than the browser (a symbol the relay does not share): every
   *  account call's rebuilt message then differs, and the check must refuse it (questions Q12). */
  mismatchedTokens = false;
  /** AA 00062 (I-62a): `/v1/config` `clientProving` (null: an older relay, no field). */
  clientProving: null | 'off' | 'required' = null;
  /** I-62a `CLIENT_PROOF_TIMEOUT_SECONDS` (the hand-off's deadline from its opening). */
  clientProofTimeoutSeconds = 300;
  /** What the relay's check says of the next posted proof. */
  clientProofVerdict: 'ok' | 'invalid' = 'ok';
  /** Every hand-off opened, in order. */
  readonly handOffs: HandOff[] = [];
  private nonces = new Set<string>();
  private tx = 0;
  private nextHeld: Held | null = null;

  /** Keep the NEXT submitted job at "proving" (as the relay reports a proof in progress) until the
   *  returned function is called; then it completes on its next poll. `hold.at([...])` shows it at
   *  later stages meanwhile (e.g. a make's `['proving', 'proven', 'posted']`: being listed). */
  holdNextJob(): JobHold {
    const h: Held = { released: false, since: Math.floor(Date.now() / 1000), stages: ['proving'] };
    this.nextHeld = h;
    const release = (() => {
      h.released = true;
    }) as JobHold;
    release.at = (stages) => {
      h.stages = stages;
    };
    return release;
  }

  /** An account that already exists on chain for `deviceKey` (for pages seeded with its records). */
  existing(deviceKey: string, encKey: string) {
    this.deviceKey = deviceKey;
    this.encKey = encKey;
    this.deployEncKey = encKey;
    this.registered = true;
    return this;
  }

  private nextTx() {
    this.tx += 1;
    return this.tx.toString(16).padStart(64, '0');
  }

  /** Register a transaction of the account (its height is fixed the first time) and a call in it. */
  recordTx(hash: string, entryPoint: string | null, extra: { calls?: MockCall[]; raw?: string } = {}) {
    const t = this.chainTxs.get(hash) ?? {
      height: 10 + this.chainTxs.size,
      id: 1_000 + this.chainTxs.size,
      entryPoints: [],
      calls: [],
    };
    if (entryPoint) t.entryPoints.push(entryPoint);
    if (extra.calls) t.calls.push(...extra.calls);
    if (extra.raw) t.raw = extra.raw;
    this.chainTxs.set(hash, t);
    return t;
  }

  private heightOf(txHash: string) {
    return this.recordTx(txHash, null).height;
  }

  /** A swap transaction (a take, or the maker's offer settled by someone): the account's
   *  `open_swap_shielded_with_ed25519` call receiving the wanted coin (and the change) and spending the
   *  paying coin, as ledger-v9 serialises it; its hash is the ledger's own. */
  private async swapTx(p: {
    want: { nonce: string; color: string; value: bigint };
    coin: { nonce: string; color: string; value: string };
    change: { nonce: string; color: string; value: bigint } | null;
  }) {
    const commit = (c: { nonce: string; color: string; value: bigint | string }) =>
      contractCoinCommitment({ nonce: c.nonce, color: c.color, value: c.value.toString() }, ACCOUNT);
    const call: MockCall = {
      address: ACCOUNT,
      entryPoint: 'open_swap_shielded_with_ed25519',
      receives: [commit(p.want), ...(p.change ? [commit(p.change)] : [])],
      nullifiers: [contractCoinNullifier(p.coin, ACCOUNT)],
    };
    const { hash, raw } = await rawTxWithCalls([call]);
    this.recordTx(hash, call.entryPoint, { calls: [call], raw });
    return hash;
  }

  /** R3-6: someone deposits a REAL coin carrying an approval's wanted nonce (colour and value of their
   *  choice) and files its note sealed to the account: a leaf and a note, in a deposit, not a swap. */
  async plantWantedCoin(c: Coin) {
    await this.deposit([c]);
  }

  /** A note in the account's inbox for a coin that exists nowhere (anyone can file one with
   *  `deposit_shielded`, R2-6): sealed to the account's key, no Zswap leaf. */
  async fakeNote(c: Coin) {
    if (!this.encKey) throw new Error('no account yet');
    const sealed = await sealEntryPortable(hexToBytes(this.encKey, 32), {
      nonce: hexToBytes(c.nonce, 32),
      color: hexToBytes(c.color, 32),
      value: c.value,
    });
    this.entries.push(bytesToHex(sealed));
  }

  /** Put coins into the account the way `deposit_shielded` does: an inbox entry sealed to the
   *  account's key, and the Zswap leaf. */
  async deposit(coins: Coin[], txHash = this.nextTx()) {
    if (!this.encKey) throw new Error('no account yet');
    for (const c of coins) {
      this.recordTx(txHash, 'deposit_shielded');
      const sealed = await sealEntryPortable(hexToBytes(this.encKey, 32), {
        nonce: hexToBytes(c.nonce, 32),
        color: hexToBytes(c.color, 32),
        value: c.value,
      });
      this.entries.push(bytesToHex(sealed));
      this.output(c, txHash);
    }
  }

  private output(c: Coin, txHash: string) {
    this.outputs.push({
      commitment: contractCoinCommitment({ nonce: c.nonce, color: c.color, value: c.value.toString() }, ACCOUNT),
      mtIndex: String(100 + this.outputs.length),
      txHash,
      blockHeight: this.heightOf(txHash),
    });
  }

  private spend(c: { nonce: string; color: string; value: string }, txHash: string) {
    this.inputs.push({ nullifier: contractCoinNullifier(c, ACCOUNT), txHash, blockHeight: this.heightOf(txHash) });
  }

  private deviceEntry(counter: bigint): string {
    return bytesToHex(ed25519DeviceForKey(this.deviceKey!).entryAt(hexToBytes(ACCOUNT, 32), 0n, counter));
  }

  state() {
    return {
      account: ACCOUNT,
      booted: this.registered,
      deviceCount: this.registered ? 1 : 0,
      deviceEpoch: '0',
      devices: this.registered && this.deviceKey ? [this.deviceEntry(this.useCounter)] : [],
      authNonce: this.authNonce.toString(),
      inboxCount: String(this.entries.length),
      encKey: this.encKey ?? '00'.repeat(32),
      networkSalt: this.salt,
    };
  }

  private ctx() {
    return callContext({
      account: ACCOUNT,
      authNonce: this.authNonce,
      networkSalt: this.salt,
      encKey: this.encKey ?? '00'.repeat(32),
    });
  }

  /** The relay's check of one request (B3's rules). Resolves to 'ok' or the refusal detail. */
  private async check(action: string, body: Record<string, unknown>): Promise<string> {
    const payload = (body.payload ?? {}) as Record<string, string>;
    if (action === 'register' || action === 'demo-tokens') {
      const auth = body.auth as { message: RelayActionMessage; signature: string } | undefined;
      if (!auth) return 'malformed';
      const m = auth.message;
      if (m.action !== action || m.network !== 'stagenet') return 'wrong-action';
      if (m.payloadHash !== payloadHash(payload)) return 'payload-mismatch';
      if (!this.nonces.delete(m.nonce)) return 'unknown-nonce';
      if (action === 'demo-tokens' && (m.account !== `0x${ACCOUNT}` || m.owner !== this.deviceKey))
        return 'wrong-account';
      // The claim names the device's live use counter (AA 00047 P9, audit C8 / F-B10).
      if (action === 'demo-tokens') {
        const counter = payload.useCounter;
        if (!counter || !/^[0-9]+$/.test(counter) || BigInt(counter) !== this.useCounter) return 'wrong-signer';
      }
      return solanaRelayActionScheme.verify(m, hexToBytes(auth.signature, 64)) ? 'ok' : 'bad-signature';
    }
    const pa = body.passportAuth as { owner: string; signature: string; useCounter: string } | undefined;
    if (!pa) return 'malformed';
    if (pa.owner !== this.deviceKey) return 'wrong-signer';
    if (BigInt(pa.useCounter) !== this.useCounter) return 'wrong-signer';
    const device = ed25519DeviceForCheck(
      pa,
      this.mismatchedTokens
        ? {
            ...display,
            tokens: {
              byColour: (c: string) =>
                c === COLOUR.twBTC ? { symbol: 'BTC', decimals: 8 } : display.tokens.byColour(c),
            } as unknown as TokenRegistry,
          }
        : display,
    );
    try {
      if (action === 'withdraw') await device.sign(this.ctx(), withdrawRequest(payload as never), this.useCounter);
      else if (action === 'append-inbox')
        await device.sign(this.ctx(), appendInboxRequest(payload as never), this.useCounter);
      else if (action === 'withdraw-unshielded')
        await device.sign(this.ctx(), withdrawUnshieldedRequest(payload as never), this.useCounter);
      else if (action === 'cancel-offers') {
        if (payload.newKey !== this.encKey) return 'wrong-key'; // a cancel never changes the key
        await device.sign(this.ctx(), cancelOffersRequest(payload as never), this.useCounter);
      } else if (action === 'restore-enc-key') {
        // As lane P10.R's relay: another key than the on-chain one (the same would be a cancel).
        if (!payload.newKey || payload.newKey === this.encKey) return 'malformed';
        await device.sign(this.ctx(), restoreEncKeyRequest(payload as never), this.useCounter);
      } else if (action === 'open-swap' || action === 'take') {
        // As the relay after P9.R (audit C6): a real, signed expiry or nothing is admitted.
        if (BigInt(payload.validUntil ?? '0') === 0n) return 'no-expiry';
        const { call, coin } = openSwapArgs(payload as never);
        await device.signOffer(this.ctx(), call, coin, this.useCounter);
        this.signedExpiries.push(String(payload.validUntil));
      } else return 'unknown-action';
    } catch {
      return 'bad-signature';
    }
    return 'ok';
  }

  /** The job's side effects and public result, applied once (the job's first poll). */
  private async complete(s: Submitted) {
    const p = (s.body.payload ?? {}) as Record<string, string> & { coin?: Record<string, string> };
    if (this.failNextJob) {
      s.failed = this.failNextJob;
      this.failNextJob = null;
      return;
    }
    if (this.fakeSuccess.has(s.action)) {
      // Reported done; nothing landed (R2-4).
      s.stages = ['proving', 'submitted'];
      s.result = { txId: this.nextTx(), change: null };
      return;
    }
    await this.apply(s, p);
    if (this.landButFail.has(s.action)) {
      // Landed, then reported failed (R2-5).
      delete s.result;
      s.failed = { code: 'proof-failed', message: 'the prover crashed' };
    }
  }

  /** AA 00060 FR-028 (the page cancels nothing): someone settles the maker's offer this relay holds. */
  async settleHeldOfferBySomeone(): Promise<void> {
    await this.settleHeldOffer();
  }

  /** AA 00060 FR-028: another signed call of the account landed (a withdrawal, say): its nonce moved. */
  anotherCallLanded(): void {
    this.authNonce += 1n;
    this.useCounter += 1n;
  }

  /** The maker's offer this relay holds (the last make), settled by someone: what the chain shows. */
  private async settleHeldOffer() {
    const make = [...this.submitted].reverse().find((x) => x.action === 'open-swap');
    if (!make) return;
    const m = (make.body.payload ?? {}) as Record<string, string> & { coin?: Record<string, string> };
    const coin = m.coin!;
    const change = predictChangeCoin(
      {
        nonce: hexToBytes(coin.nonce!, 32),
        color: hexToBytes(coin.color!, 32),
        value: BigInt(coin.value!),
        mt_index: BigInt(coin.mtIndex!),
      },
      BigInt(m.giveAmount!),
    );
    const want = { nonce: m.wantNonce!, color: m.wantColor!, value: BigInt(m.wantAmount!) };
    const tx = await this.swapTx({
      want,
      coin: { nonce: coin.nonce!, color: coin.color!, value: coin.value! },
      change: change ? { nonce: bytesToHex(change.nonce), color: bytesToHex(change.color), value: change.value } : null,
    });
    this.spend({ nonce: coin.nonce!, color: coin.color!, value: coin.value! }, tx);
    this.entries.push(m.wantEntry!);
    this.output(want, tx);
    if (change) {
      this.entries.push(m.changeEntry!);
      this.output({ nonce: bytesToHex(change.nonce), color: bytesToHex(change.color), value: change.value }, tx);
    }
    this.authNonce += 1n;
    this.useCounter += 1n;
  }

  private async apply(s: Submitted, p: Record<string, string> & { coin?: Record<string, string> }) {
    const tx = this.nextTx();
    switch (s.action) {
      case 'register': {
        this.encKey = p.encPublicKey!;
        this.deployEncKey = p.encPublicKey!;
        this.registered = true;
        if (this.depositAfterDeploy)
          await this.deposit([{ nonce: '5d'.repeat(32), color: COLOUR.twUSDC, value: 1n }], this.nextTx());
        // A new account: its device at its first entry, nothing signed yet.
        this.authNonce = 0n;
        this.useCounter = 0n;
        s.stages = ['deploying', 'wave-1-submitted', 'wave-2-submitted', 'activating', 'activated'];
        this.registerTxs = { waveOne: this.nextTx(), waveTwo: this.nextTx(), activation: tx };
        s.result = {
          account: ACCOUNT,
          device: this.deviceKey,
          txs: this.registerTxs,
          seconds: { waveOne: 20, waveTwo: 18, activation: 15, total: 53 },
        };
        return;
      }
      case 'demo-tokens': {
        await this.deposit(
          DEMO_PACK.map((t, i) => ({
            nonce: (0xd0 + i).toString(16).repeat(32),
            color: t.colour,
            value: BigInt(t.amount),
          })),
          tx,
        );
        this.demo.claimed.add(this.deviceKey!);
        this.demo.remainingToday -= 1;
        s.stages = ['minting', 'depositing'];
        s.result = {
          account: ACCOUNT,
          path: 'direct',
          minted: DEMO_PACK.map((t) => ({ ...t, txs: { mintAndDeposit: tx } })),
        };
        return;
      }
      case 'withdraw': {
        const coin = p.coin!;
        this.recordTx(tx, 'withdraw_shielded_with_ed25519');
        this.spend({ nonce: coin.nonce!, color: coin.color!, value: coin.value! }, tx);
        // The change the contract's sendShielded makes (what lands on chain).
        const made = predictWithdrawChange(
          { nonce: coin.nonce!, color: coin.color!, value: coin.value! },
          BigInt(p.amount!),
        );
        const change = made ? { nonce: made.nonce, color: made.color, value: BigInt(made.value) } : null;
        if (change) this.output(change, tx);
        if (this.omitWithdrawalsFromReport) {
          this.omitFromReport.add(
            contractCoinNullifier({ nonce: coin.nonce!, color: coin.color!, value: coin.value! }, ACCOUNT),
          );
          if (change)
            this.omitFromReport.add(
              contractCoinCommitment(
                { nonce: change.nonce, color: change.color, value: change.value.toString() },
                ACCOUNT,
              ),
            );
        }
        const reported = change && this.misreportChange ? { ...change, nonce: 'c4'.repeat(32) } : change;
        this.authNonce += 1n;
        this.useCounter += 1n;
        s.stages = ['proving', 'submitted'];
        s.result = {
          txId: tx,
          change: reported ? { ...reported, value: reported.value.toString() } : null,
          ...(change ? { changeEntitlement: `ae1.${ACCOUNT}.${'0e'.repeat(32)}.99999999999.${'ac'.repeat(32)}` } : {}),
        };
        return;
      }
      case 'cancel-offers': {
        if (this.cancelMode === 'not-implemented') {
          s.failed = {
            code: 'not-implemented',
            message: 'the cancel-offers operation is not available yet (plan lane P9.R)',
          };
          return;
        }
        if (this.settleOnCancel) await this.settleHeldOffer();
        else {
          this.recordTx(tx, 'rotate_enc_key_with_ed25519');
          this.authNonce += 1n;
          this.useCounter += 1n;
        }
        s.stages = ['proving', 'submitted'];
        s.result = { txId: tx };
        return;
      }
      case 'restore-enc-key': {
        if (this.restoreMode === 'not-implemented') {
          s.failed = {
            code: 'not-implemented',
            message: 'the restore-enc-key operation is not available yet (plan lane P10.R)',
          };
          return;
        }
        this.encKey = p.newKey!;
        this.recordTx(tx, 'rotate_enc_key_with_ed25519');
        this.authNonce += 1n;
        this.useCounter += 1n;
        s.stages = ['proving', 'submitted'];
        s.result = { txId: tx };
        return;
      }
      case 'append-inbox': {
        this.recordTx(tx, 'append_inbox_with_ed25519');
        this.entries.push(p.entry!);
        this.authNonce += 1n;
        this.useCounter += 1n;
        s.stages = ['proving', 'submitted'];
        s.result = { txId: tx };
        return;
      }
      case 'withdraw-unshielded': {
        const held = this.unshielded.get(p.color!) ?? 0n;
        this.recordTx(tx, 'withdraw_unshielded_with_ed25519');
        this.unshielded.set(p.color!, held - BigInt(p.amount!));
        this.authNonce += 1n;
        this.useCounter += 1n;
        s.stages = ['proving', 'submitted'];
        s.result = { txId: tx };
        return;
      }
      case 'open-swap': {
        const offerId = randomBytes(32).toString('hex');
        const status = this.makeListing;
        this.offerStatus[offerId] = status;
        this.onMake?.(offerId, p as Record<string, string>);
        s.stages = ['proving', 'proven', 'posted', status === 'live' ? 'listed' : `status-${status}`];
        s.result = {
          offerId,
          kernel: { accepted: true, status, code: null, reason: null },
          legSegment: 0,
          proveSeconds: 33,
          expiresAt: Date.now() + 3_600_000,
          bytes: 25_119,
        };
        return;
      }
      case 'take': {
        const coin = p.coin!;
        const change = predictChangeCoin(
          {
            nonce: hexToBytes(coin.nonce!, 32),
            color: hexToBytes(coin.color!, 32),
            value: BigInt(coin.value!),
            mt_index: BigInt(coin.mtIndex!),
          },
          BigInt(p.giveAmount!),
        );
        const want = { nonce: p.wantNonce!, color: p.wantColor!, value: BigInt(p.wantAmount!) };
        // The settlement: a swap transaction of ledger-v9's own making, under its own hash.
        const swap = await this.swapTx({
          want,
          coin: { nonce: coin.nonce!, color: coin.color!, value: coin.value! },
          change: change
            ? { nonce: bytesToHex(change.nonce), color: bytesToHex(change.color), value: change.value }
            : null,
        });
        this.spend({ nonce: coin.nonce!, color: coin.color!, value: coin.value! }, swap);
        // The wanted coin and the predicted change, each with the inbox entry the browser sealed.
        this.entries.push(p.wantEntry!);
        this.output(want, swap);
        if (change) {
          this.entries.push(p.changeEntry!);
          this.output({ nonce: bytesToHex(change.nonce), color: bytesToHex(change.color), value: change.value }, swap);
        }
        this.authNonce += 1n;
        this.useCounter += 1n;
        s.stages = ['offer-checked', 'proving', 'merged', 'settled'];
        s.result = {
          offerId: p.offerId,
          txHash: swap,
          proveSeconds: 36,
          cost: { blockUsage: '30000', computeTimePs: '1', readTimePs: '1', feesSpecks: '1' },
          path: 'batcher',
        };
        return;
      }
    }
  }

  /** AA 00062: open a job's hand-off (I-62a). */
  private openHandOff(job: string, action: string): HandOff {
    const circuit = CLIENT_CIRCUIT_OF[action]!;
    const h: HandOff = {
      job,
      proofId: randomBytes(16).toString('hex'),
      circuit,
      ...fakeProofRequest(circuit),
      deadline: Math.floor(Date.now() / 1000) + this.clientProofTimeoutSeconds,
      fetched: false,
      proof: null,
      verdict: null,
    };
    this.handOffs.push(h);
    return h;
  }

  /** AA 00062: the job while its hand-off is open (`clientProof`), or just after the proof was checked. */
  private handOffView(id: string, s: Submitted, stage: string) {
    const h = s.handOff!;
    const stages = ['queued', 'running', 'awaiting-client-proof'];
    if (h.fetched) stages.push('client-proof-fetched');
    if (stage === 'client-proof-checked') stages.push('client-proof-received', 'client-proof-checked');
    return {
      requestId: id,
      action: s.action,
      lane: 'prover',
      createdAt: 1,
      updatedAt: 1,
      expiresAt: 9_999_999_999,
      state: 'running',
      stage,
      stages: stages.map((x) => ({ stage: x, at: 1 })),
      ...(stage === 'client-proof-checked'
        ? {}
        : {
            clientProof: {
              proofId: h.proofId,
              circuit: h.circuit,
              deadline: h.deadline,
              attempt: 1,
              fetched: h.fetched,
            },
          }),
    };
  }

  private view(id: string, s: Submitted) {
    const base = {
      requestId: id,
      action: s.action,
      lane: 'prover',
      createdAt: 1,
      updatedAt: 1,
      expiresAt: 9_999_999_999,
    };
    if (s.held && !s.held.released) {
      const at = s.held.since;
      const stages = ['queued', 'running', ...s.held.stages];
      return {
        ...base,
        state: 'running',
        stage: stages[stages.length - 1],
        stages: stages.map((stage) => ({ stage, at })),
      };
    }
    if (!s.done)
      return { ...base, state: 'queued', stage: 'queued', position: 1, stages: [{ stage: 'queued', at: 1 }] };
    if (s.failed)
      return {
        ...base,
        state: 'failed',
        stage: 'failed',
        stages: [
          { stage: 'queued', at: 1 },
          { stage: 'failed', at: 2 },
        ],
        error: s.failed,
      };
    return {
      ...base,
      state: 'succeeded',
      stage: 'succeeded',
      stages: [...['queued', 'running', ...s.stages].map((stage) => ({ stage, at: 1 })), { stage: 'succeeded', at: 2 }],
      result: s.result,
    };
  }

  async handle(route: Route) {
    const req = route.request();
    const url = new URL(req.url());
    const json = (status: number, body: unknown) =>
      route.fulfill({ status, headers: CORS, contentType: 'application/json', body: JSON.stringify(body) });
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const path = url.pathname;
    if (path === '/health') return json(200, healthBody());
    if (path === '/v1/config')
      return json(200, {
        network: 'stagenet',
        relayVersion: 'e2e',
        limits: { authMaxTtlSeconds: 600, jobTtlSeconds: 3600 },
        ...(this.tokensDigest ? { tokensDigest: this.tokensDigest } : {}),
        ...(this.clientProving === 'required'
          ? {
              clientProving: {
                mode: 'required',
                circuits: [...new Set(Object.values(CLIENT_CIRCUIT_OF))].sort(),
                keySet: KEY_SET,
                proofServer: PROOF_SERVER,
                timeoutSeconds: this.clientProofTimeoutSeconds,
              },
            }
          : this.clientProving === 'off'
            ? { clientProving: { mode: 'off' } }
            : {}),
      });
    if (path === '/v1/auth/nonce') {
      const nonce = `0x${randomBytes(32).toString('hex')}`;
      this.nonces.add(nonce);
      return json(200, { nonce, expiresAt: Math.floor(Date.now() / 1000) + 600, maxTtlSeconds: 600 });
    }
    if (path === '/v1/demo-tokens') {
      const owner = url.searchParams.get('owner');
      return json(200, {
        enabled: this.demo.enabled,
        pack: DEMO_PACK,
        perKey: 1,
        dailyCap: this.demo.dailyCap,
        remainingToday: this.demo.remainingToday,
        ...(owner ? { claimed: this.demo.claimed.has(owner) } : {}),
      });
    }
    const acct = /^\/v1\/accounts\/([0-9a-f]{64})\/(state|inbox|zswap|unshielded)$/.exec(path);
    if (acct) {
      if (acct[1] !== ACCOUNT || !this.registered)
        return json(404, { error: { code: 'not-found', message: 'no such account' } });
      // A lying relay (`lies`): another nonce and key, no inbox, other balances. The page reads the
      // chain (./mock-indexer.ts) instead, so nothing it does may depend on these answers.
      if (acct[2] === 'state')
        return json(
          200,
          this.lies
            ? { ...this.state(), authNonce: String(this.authNonce + 5n), encKey: 'e1'.repeat(32) }
            : this.state(),
        );
      if (acct[2] === 'inbox')
        return json(200, {
          account: ACCOUNT,
          from: 0,
          entries: this.lies ? [] : this.entries,
          total: this.lies ? 0 : this.entries.length,
        });
      if (acct[2] === 'zswap') {
        this.zswapReads += 1;
        if (this.zswapHistoryTooLong)
          return json(501, {
            error: {
              code: 'history-too-long',
              message: 'the account has 500 or more actions; paging is not implemented',
            },
          });
        return json(200, {
          account: ACCOUNT,
          outputs: this.outputs.filter((o) => !this.omitFromReport.has(o.commitment)),
          inputs: this.inputs.filter((i) => !this.omitFromReport.has(i.nullifier)),
          transactions: this.outputs.length,
          blockHeight: 99,
        });
      }
      return json(200, {
        account: ACCOUNT,
        balances: [...this.unshielded]
          .filter(([, v]) => v > 0n)
          .map(([colour, v]) => ({ colour, amount: (this.lies ? v * 1000n : v).toString() })),
        blockHeight: 99,
      });
    }
    const action = /^\/v1\/actions\/([a-z-]+)$/.exec(path)?.[1];
    if (action && req.method() === 'POST' && this.refuseNext) {
      const r = this.refuseNext;
      this.refuseNext = null;
      this.refused.push(`${action}: ${r.code}`);
      return route.fulfill({
        status: r.status,
        // Cross-origin here (a deployment serves the relay same-origin): expose Retry-After.
        headers: {
          ...CORS,
          'access-control-expose-headers': 'retry-after',
          ...(r.retryAfter ? { 'retry-after': String(r.retryAfter) } : {}),
        },
        contentType: 'application/json',
        body: JSON.stringify({
          error: { code: r.code, message: r.message, ...(r.detail ? { detail: r.detail } : {}) },
        }),
      });
    }
    if (action && req.method() === 'POST') {
      const body = JSON.parse(req.postData() ?? '{}') as Record<string, unknown>;
      if (action === 'demo-tokens' && this.deviceKey && this.demo.claimed.has(this.deviceKey)) {
        this.refused.push(`${action}: demo-already-claimed`);
        return json(409, { error: { code: 'demo-already-claimed', message: 'this key has already claimed' } });
      }
      if (action === 'register')
        this.deviceKey = (body.auth as { message?: { owner?: string } })?.message?.owner ?? null;
      const verdict = await this.check(action, body);
      if (verdict !== 'ok') {
        this.refused.push(`${action}: ${verdict}`);
        return json(401, {
          error: { code: 'unauthorised', message: 'the authorisation was refused', detail: verdict },
        });
      }
      const held = this.nextHeld ?? undefined;
      this.nextHeld = null;
      if (held) held.since = Math.floor(Date.now() / 1000);
      this.submitted.push({ action, body, verified: verdict, done: false, stages: [], ...(held ? { held } : {}) });
      const id = String(this.submitted.length).padStart(32, '0');
      return json(202, { job: this.view(id, this.submitted.at(-1)!) });
    }
    // AA 00062 (I-62a): the hand-off routes.
    const handOffJob = /^\/v1\/jobs\/([0-9a-f]{32})\/client-proof$/.exec(path)?.[1];
    if (handOffJob) {
      if (this.clientProving !== 'required')
        return json(404, { error: { code: 'client-proving-off', message: 'this relay proves everything itself' } });
      const s = this.submitted[Number(handOffJob) - 1];
      if (!s) return json(404, { error: { code: 'not-found', message: 'no such job' } });
      const h = s.handOff;
      if (!h || h.verdict !== null || s.done)
        return json(409, { error: { code: 'not-awaiting-client-proof', message: 'no hand-off is open' } });
      if (req.method() === 'GET') {
        h.fetched = true;
        return route.fulfill({
          status: 200,
          headers: { ...CORS, 'cache-control': 'no-store' },
          contentType: 'application/json',
          body: JSON.stringify({
            proofId: h.proofId,
            circuit: h.circuit,
            proofRequest: h.proofRequest,
            keyMaterialOffset: h.keyMaterialOffset,
            deadline: h.deadline,
            attempt: 1,
            keySet: KEY_SET,
            proofServer: PROOF_SERVER,
          }),
        });
      }
      const body = JSON.parse(req.postData() ?? '{}') as { proofId?: string; proof?: string };
      if (body.proofId !== h.proofId)
        return json(409, { error: { code: 'client-proof-wrong-id', message: 'not the open hand-off' } });
      if (Math.floor(Date.now() / 1000) > h.deadline) {
        s.failed = { code: 'client-proof-late', message: 'the client proof came after its deadline' };
        s.done = true;
        return json(410, { error: { code: 'client-proof-late', message: 'too late' } });
      }
      const bytes = Buffer.from(body.proof ?? '', 'base64');
      if (!bytes.toString('latin1').startsWith('midnight:proof-versioned:'))
        return json(400, { error: { code: 'bad-request', message: 'not a proof' } });
      h.proof = body.proof!;
      if (this.clientProofVerdict === 'invalid') {
        h.verdict = 'invalid';
        s.failed = { code: 'client-proof-invalid', message: 'the client proof did not verify' };
        s.done = true;
        return json(422, { error: { code: 'client-proof-invalid', message: 'the client proof did not verify' } });
      }
      h.verdict = 'checked';
      return json(200, { job: this.handOffView(handOffJob, s, 'client-proof-checked') });
    }
    const job = /^\/v1\/jobs\/([0-9a-f]{32})$/.exec(path)?.[1];
    if (job) {
      const s = this.submitted[Number(job) - 1];
      if (!s) return json(404, { error: { code: 'not-found', message: 'no such job' } });
      // AA 00062: a k>=18 job waits for the customer's proof (I-62a) before it runs.
      if (
        this.clientProving === 'required' &&
        CLIENT_CIRCUIT_OF[s.action] &&
        !s.done &&
        s.handOff?.verdict !== 'checked'
      ) {
        s.handOff ??= this.openHandOff(job, s.action);
        if (Math.floor(Date.now() / 1000) > s.handOff.deadline) {
          s.failed = s.handOff.fetched
            ? { code: 'client-proof-late', message: 'the client proof did not come before its deadline' }
            : { code: 'client-proof-missing', message: 'the page never fetched the proof request' };
          s.done = true;
          return json(200, { job: this.view(job, s) });
        }
        return json(200, {
          job: this.handOffView(job, s, s.handOff.fetched ? 'client-proof-fetched' : 'awaiting-client-proof'),
        });
      }
      if (!s.done && !(s.held && !s.held.released)) {
        await this.complete(s);
        s.done = true;
      }
      return json(200, { job: this.view(job, s) });
    }
    return json(404, { error: { code: 'not-found', message: 'no such route' } });
  }
}
