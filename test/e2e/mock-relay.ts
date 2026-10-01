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

import { randomBytes } from 'node:crypto';

import type { Route } from '@playwright/test';

import { payloadHash, type RelayActionMessage } from '../../packages/core/src/auth.js';
import { contractCoinCommitment, contractCoinNullifier } from '../../packages/core/src/coins.js';
import { bytesToHex, hexToBytes } from '../../packages/core/src/hex.js';
import {
  callContext,
  cancelOffersRequest,
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
  /** Requests refused before anything was queued: `action: code/detail`. */
  readonly refused: string[] = [];
  deviceKey: string | null = null;
  encKey: string | null = null;
  registered = false;
  /** The account's network salt: the stagenet one, as every market account on stagenet carries. */
  readonly salt = networkSaltFor('stagenet');
  /** The relay's own account routes (state, inbox, unshielded) misreport (the page must not care). */
  lies = false;
  /** Report a fabricated change coin for a withdrawal (Q28 A). */
  misreportChange = false;
  /** `cancel-offers`: done, or this relay cannot run it yet. */
  cancelMode: 'ok' | 'not-implemented' = 'ok';
  /** The `validUntil` of every make and take, as signed. */
  readonly signedExpiries: string[] = [];
  authNonce = 3n;
  useCounter = 0n;
  entries: string[] = [];
  outputs: Array<{ commitment: string; mtIndex: string; txHash: string; blockHeight: number }> = [];
  inputs: Array<{ nullifier: string; txHash: string; blockHeight: number }> = [];
  unshielded = new Map<string, bigint>();
  demo = { enabled: true, dailyCap: 25, remainingToday: 7, claimed: new Set<string>() };
  offerStatus: Record<string, string> = {};
  /** What the exchange says about the next make when the relay stops waiting (`live` = listed). */
  makeListing = 'live';
  /** Render with another token list than the browser (a symbol the relay does not share): every
   *  account call's rebuilt message then differs, and the check must refuse it (questions Q12). */
  mismatchedTokens = false;
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
    this.registered = true;
    return this;
  }

  private nextTx() {
    this.tx += 1;
    return this.tx.toString(16).padStart(64, '0');
  }

  /** Put coins into the account the way `deposit_shielded` does: an inbox entry sealed to the
   *  account's key, and the Zswap leaf. */
  async deposit(coins: Coin[], txHash = this.nextTx()) {
    if (!this.encKey) throw new Error('no account yet');
    for (const c of coins) {
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
      blockHeight: 10 + this.outputs.length,
    });
  }

  private spend(c: { nonce: string; color: string; value: string }, txHash: string) {
    this.inputs.push({ nullifier: contractCoinNullifier(c, ACCOUNT), txHash, blockHeight: 50 + this.inputs.length });
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
    return callContext({ account: ACCOUNT, authNonce: this.authNonce, networkSalt: this.salt });
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
    const tx = this.nextTx();
    switch (s.action) {
      case 'register': {
        this.encKey = p.encPublicKey!;
        this.registered = true;
        // A new account: its device at its first entry, nothing signed yet.
        this.authNonce = 0n;
        this.useCounter = 0n;
        s.stages = ['deploying', 'wave-1-submitted', 'wave-2-submitted', 'activating', 'activated'];
        s.result = {
          account: ACCOUNT,
          device: this.deviceKey,
          txs: { waveOne: this.nextTx(), waveTwo: this.nextTx(), activation: tx },
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
        this.spend({ nonce: coin.nonce!, color: coin.color!, value: coin.value! }, tx);
        // The change the contract's sendShielded makes (what lands on chain).
        const made = predictWithdrawChange(
          { nonce: coin.nonce!, color: coin.color!, value: coin.value! },
          BigInt(p.amount!),
        );
        const change = made ? { nonce: made.nonce, color: made.color, value: BigInt(made.value) } : null;
        if (change) this.output(change, tx);
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
        this.authNonce += 1n;
        this.useCounter += 1n;
        s.stages = ['proving', 'submitted'];
        s.result = { txId: tx };
        return;
      }
      case 'append-inbox': {
        this.entries.push(p.entry!);
        this.authNonce += 1n;
        this.useCounter += 1n;
        s.stages = ['proving', 'submitted'];
        s.result = { txId: tx };
        return;
      }
      case 'withdraw-unshielded': {
        const held = this.unshielded.get(p.color!) ?? 0n;
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
        this.spend({ nonce: coin.nonce!, color: coin.color!, value: coin.value! }, tx);
        // The wanted coin and the predicted change, each with the inbox entry the browser sealed.
        this.entries.push(p.wantEntry!);
        this.output({ nonce: p.wantNonce!, color: p.wantColor!, value: BigInt(p.wantAmount!) }, tx);
        const change = predictChangeCoin(
          {
            nonce: hexToBytes(coin.nonce!, 32),
            color: hexToBytes(coin.color!, 32),
            value: BigInt(coin.value!),
            mt_index: BigInt(coin.mtIndex!),
          },
          BigInt(p.giveAmount!),
        );
        if (change) {
          this.entries.push(p.changeEntry!);
          this.output({ nonce: bytesToHex(change.nonce), color: bytesToHex(change.color), value: change.value }, tx);
        }
        this.authNonce += 1n;
        this.useCounter += 1n;
        s.stages = ['offer-checked', 'proving', 'merged', 'settled'];
        s.result = {
          offerId: p.offerId,
          txHash: tx,
          proveSeconds: 36,
          cost: { blockUsage: '30000', computeTimePs: '1', readTimePs: '1', feesSpecks: '1' },
          path: 'batcher',
        };
        return;
      }
    }
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
      if (acct[2] === 'zswap')
        return json(200, {
          account: ACCOUNT,
          outputs: this.outputs,
          inputs: this.inputs,
          transactions: this.outputs.length,
          blockHeight: 99,
        });
      return json(200, {
        account: ACCOUNT,
        balances: [...this.unshielded]
          .filter(([, v]) => v > 0n)
          .map(([colour, v]) => ({ colour, amount: (this.lies ? v * 1000n : v).toString() })),
        blockHeight: 99,
      });
    }
    const action = /^\/v1\/actions\/([a-z-]+)$/.exec(path)?.[1];
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
    const job = /^\/v1\/jobs\/([0-9a-f]{32})$/.exec(path)?.[1];
    if (job) {
      const s = this.submitted[Number(job) - 1];
      if (!s) return json(404, { error: { code: 'not-found', message: 'no such job' } });
      if (!s.done && !(s.held && !s.held.released)) {
        await this.complete(s);
        s.done = true;
      }
      return json(200, { job: this.view(job, s) });
    }
    return json(404, { error: { code: 'not-found', message: 'no such route' } });
  }
}
