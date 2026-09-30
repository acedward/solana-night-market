// Local-stack harness (AA 00047 B3): drive the relay's own flows over HTTP the way the browser does,
// with a throwaway Ed25519 key signing in Phantom's scheme (tweetnacl, RFC 8032):
//
//   1. open an account: the Solana envelope (Track A's possession message) → register → the relay
//      deploys both waves (authority retired) and activates the key;
//   2. demo tokens: the Solana envelope → demo-tokens → the pack lands in the account (the relay's
//      DEMO_TOKENS_PATH: one transaction per token, or mint to the sponsor then deposit_shielded);
//      a second claim by the same key is refused;
//   3. read the account back (state, inbox, zswap) and reconcile its coins with the account's key;
//   4. withdraw shielded to a third-party wallet key, authorised by the F3 signature alone (one
//      prompt); replaying the same approval is refused;
//   5. file the withdrawal's change (append-inbox, with the relay's entitlement);
//   6. make an offer (open-swap) on the stack's mock kernel: proved with its legs in segment 0,
//      published, listed.
// Each step's public outcome is written to $OUT/relay-flows.json.
//
//   RELAY_URL=http://relay:8080 TOKENS_FILE=… OUT=… bun test/stack/b3/relay-flows.ts

import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  API_PATHS,
  buildRelayActionMessage,
  bytesToHex,
  hexToBytes,
  reconcileCoins,
  registryFor,
  type AccountStateView,
  type InboxPage,
  type JobView,
  type RelayActionName,
  type ZswapActivity,
} from '@nightmarket/core';
import {
  appendInboxRequest,
  callContext,
  ed25519DeviceOf,
  findUseCounter,
  freshWantNonce,
  generateEncKeyPairPortable,
  offerInboxEntriesPortable,
  openEntryPortable,
  openSwapArgs,
  passportAuthOf,
  predictChangeCoin,
  sealEntryPortable,
  withdrawRequest,
} from '@nightmarket/core/passport';
import { solanaEnvelopeMessage, solanaEnvelopeText } from '@nightmarket/core/solana-auth';
import nacl from 'tweetnacl';

const RELAY = process.env.RELAY_URL ?? 'http://relay:8080';
const OUT = process.env.OUT ?? '/out';
const NETWORK = 'undeployed' as const;
const tokens = registryFor(NETWORK, JSON.parse(readFileSync(process.env.TOKENS_FILE ?? '/tokens.json', 'utf8')));
const display = { network: NETWORK, tokens };
const record: Record<string, unknown> = { relay: RELAY, startedAt: new Date().toISOString() };
const save = () => {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(
    join(OUT, process.env.OUT_NAME ?? 'relay-flows.json'),
    `${JSON.stringify(record, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2)}\n`,
  );
};
const step = (s: string) => process.stdout.write(`\n== ${s}\n`);
const say = (s: string) => process.stdout.write(`   ${s}\n`);

// ── the wallet (a throwaway key; Phantom's scheme) ───────────────────────────
const kp = nacl.sign.keyPair.fromSeed(new Uint8Array(randomBytes(32)));
const signer = {
  deviceKey: bytesToHex(kp.publicKey),
  address: '',
  signMessage: async (m: Uint8Array) => nacl.sign.detached(m, kp.secretKey),
};
const device = ed25519DeviceOf(signer, display);
record.device = { publicKey: signer.deviceKey, address: device.address };

// ── HTTP ─────────────────────────────────────────────────────────────────────
async function http<T>(path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const res = await fetch(`${RELAY}${path}`, init);
  return { status: res.status, body: (await res.json().catch(() => ({}))) as T };
}
const post = (action: RelayActionName, body: unknown) =>
  http<{ job?: JobView; error?: { code: string; message: string; detail?: string } }>(API_PATHS.action(action), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

async function waitJob(job: JobView, label: string): Promise<JobView> {
  const t0 = Date.now();
  let seen = 0;
  for (;;) {
    const { body } = await http<{ job: JobView }>(API_PATHS.job(job.requestId));
    const j = body.job;
    for (const s of j.stages.slice(seen)) say(`[${label}] ${s.stage}${s.detail ? ` ${JSON.stringify(s.detail)}` : ''}`);
    seen = j.stages.length;
    if (j.state === 'succeeded' || j.state === 'failed') {
      say(`[${label}] ${j.state} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
      return j;
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
}

async function envelope(action: RelayActionName, account: string | undefined, payload: Record<string, unknown>) {
  const { body } = await http<{ nonce: string }>(API_PATHS.nonce);
  const message = buildRelayActionMessage({
    action,
    network: NETWORK,
    owner: signer.deviceKey,
    ...(account ? { account } : {}),
    payload,
    nonce: body.nonce,
    expiry: Math.floor(Date.now() / 1000) + 300,
  });
  const signature = bytesToHex(await signer.signMessage(solanaEnvelopeMessage(message)));
  return { message, signature, text: solanaEnvelopeText(message) };
}

async function state(account: string) {
  const s = (await http<AccountStateView>(API_PATHS.accountState(account))).body;
  const inbox = (await http<InboxPage>(`${API_PATHS.accountInbox(account)}?from=0&limit=500`)).body;
  const zswap = (await http<ZswapActivity>(API_PATHS.accountZswap(account))).body;
  return { s, inbox, zswap };
}

async function coinsOf(account: string, encSecret: Uint8Array, previous: ReturnType<typeof reconcileCoins> = []) {
  const { s, inbox, zswap } = await state(account);
  const opened = [];
  for (const [i, e] of inbox.entries.entries()) {
    if (!e) continue;
    const c = await openEntryPortable(encSecret, hexToBytes(e, 192));
    if (c)
      opened.push({
        nonce: bytesToHex(c.nonce),
        color: bytesToHex(c.color),
        value: c.value.toString(10),
        inboxIndex: String(inbox.from + i),
      });
  }
  const coins = reconcileCoins({ account, inbox: opened, outputs: zswap.outputs, inputs: zswap.inputs, previous });
  return { s, coins };
}

const useCounter = (s: AccountStateView) =>
  findUseCounter(s.devices, (k) => bytesToHex(device.entryAt(hexToBytes(s.account, 32), BigInt(s.deviceEpoch), k)));

const ctxOf = (s: AccountStateView) =>
  callContext({ account: s.account, authNonce: BigInt(s.authNonce), networkSalt: s.networkSalt });

async function main() {
  const enc = generateEncKeyPairPortable();

  step('1. open an account (one Phantom prompt: the possession message)');
  const reg = { encPublicKey: bytesToHex(enc.publicKey) };
  const regEnv = await envelope('register', undefined, reg);
  say(`the wallet is shown:\n      ${regEnv.text.split('\n').join('\n      ')}`);
  const r1 = await post('register', { payload: reg, auth: { message: regEnv.message, signature: regEnv.signature } });
  if (r1.status !== 202 || !r1.body.job) throw new Error(`register refused: ${r1.status} ${JSON.stringify(r1.body)}`);
  const regJob = await waitJob(r1.body.job, 'register');
  record.register = { state: regJob.state, result: regJob.result, error: regJob.error, stages: regJob.stages.length };
  save();
  if (regJob.state !== 'succeeded') throw new Error(`register failed: ${JSON.stringify(regJob.error)}`);
  const account = String((regJob.result as { account: string }).account);
  say(`account ${account}`);
  // The same registration envelope again: its relay nonce is spent.
  const replay = await post('register', {
    payload: reg,
    auth: { message: regEnv.message, signature: regEnv.signature },
  });
  record.registerReplay = { status: replay.status, detail: replay.body.error?.detail };
  say(`replayed registration → ${replay.status} ${replay.body.error?.detail}`);

  step('2. demo tokens (one Phantom prompt)');
  const info0 = (await http(`${API_PATHS.demoTokens}?owner=${signer.deviceKey}`)).body;
  say(`GET /v1/demo-tokens → ${JSON.stringify(info0)}`);
  const demoEnv = await envelope('demo-tokens', account, {});
  const r2 = await post('demo-tokens', {
    account,
    payload: {},
    auth: { message: demoEnv.message, signature: demoEnv.signature },
  });
  if (r2.status !== 202 || !r2.body.job)
    throw new Error(`demo-tokens refused: ${r2.status} ${JSON.stringify(r2.body)}`);
  const demoJob = await waitJob(r2.body.job, 'demo-tokens');
  record.demoTokens = { state: demoJob.state, result: demoJob.result, error: demoJob.error };
  save();
  if (demoJob.state !== 'succeeded') throw new Error(`demo-tokens failed: ${JSON.stringify(demoJob.error)}`);
  const again = await envelope('demo-tokens', account, {});
  const r2b = await post('demo-tokens', {
    account,
    payload: {},
    auth: { message: again.message, signature: again.signature },
  });
  record.demoTokensAgain = { status: r2b.status, code: r2b.body.error?.code };
  say(`a second claim by the same key → ${r2b.status} ${r2b.body.error?.code}`);
  record.demoTokensInfo = (await http(`${API_PATHS.demoTokens}?owner=${signer.deviceKey}`)).body;

  step('3. read the account back and reconcile its coins');
  let { s, coins } = await coinsOf(account, enc.secretKey);
  for (let i = 0; i < 20 && coins.some((c) => c.mtIndex === null); i++) {
    await new Promise((r) => setTimeout(r, 3_000));
    ({ s, coins } = await coinsOf(account, enc.secretKey, coins));
  }
  record.coinsAfterDemo = coins.map((c) => ({ color: c.color, value: c.value, mtIndex: c.mtIndex, spent: c.spent }));
  say(
    `authNonce ${s.authNonce}, inbox ${s.inboxCount}, coins ${coins.map((c) => `${tokens.byColour(c.color)?.symbol}:${c.value}@${c.mtIndex}`).join(', ')}`,
  );
  save();

  step('4. withdraw shielded to a third-party wallet (one Phantom prompt: the F3 message)');
  const ledger = (await import('@midnightntwrk/ledger-v9')) as unknown as {
    ZswapSecretKeys: { fromSeed(s: Uint8Array): { coinPublicKey: unknown; encryptionPublicKey: unknown } };
  };
  const rk = ledger.ZswapSecretKeys.fromSeed(new Uint8Array(randomBytes(32)));
  const keyHex = (k: unknown) =>
    typeof k === 'string' ? k : ((k as { toHexString?(): string }).toHexString?.() ?? String(k));
  const coin = coins.find((c) => !c.spent && c.mtIndex !== null)!;
  const payload = {
    recipient: keyHex(rk.coinPublicKey).replace(/^0x/, ''),
    recipientEncryptionKey: keyHex(rk.encryptionPublicKey).replace(/^0x/, ''),
    color: coin.color,
    amount: (BigInt(coin.value) / 4n).toString(10),
    coin: { nonce: coin.nonce, color: coin.color, value: coin.value, mtIndex: coin.mtIndex! },
    authNonce: s.authNonce,
  };
  const counter = useCounter(s);
  if (counter === null) throw new Error('the device is not live on the account');
  const auth = await device.sign(ctxOf(s), withdrawRequest(payload), counter);
  say(`the wallet is shown:\n      ${auth.text.split('\n').join('\n      ')}`);
  const passportAuth = passportAuthOf(auth);
  const r4 = await post('withdraw', { account, payload, passportAuth });
  if (r4.status !== 202 || !r4.body.job) throw new Error(`withdraw refused: ${r4.status} ${JSON.stringify(r4.body)}`);
  // The same approval again while the first is queued or running: refused.
  const dup = await post('withdraw', { account, payload, passportAuth });
  record.withdrawReplay = { status: dup.status, detail: dup.body.error?.detail };
  say(`the same approval sent again → ${dup.status} ${dup.body.error?.detail}`);
  const wJob = await waitJob(r4.body.job, 'withdraw');
  record.withdraw = { state: wJob.state, result: wJob.result, error: wJob.error, message: auth.text };
  save();
  if (wJob.state !== 'succeeded') throw new Error(`withdraw failed: ${JSON.stringify(wJob.error)}`);
  // After it landed: the approval is for an old nonce now.
  const late = await post('withdraw', { account, payload, passportAuth });
  record.withdrawReplayAfter = { status: late.status, detail: late.body.error?.detail };
  say(`the same approval after it landed → ${late.status} ${late.body.error?.detail}`);

  step('5. file the change (append-inbox with the relay entitlement)');
  const wr = wJob.result as {
    change: { nonce: string; color: string; value: string } | null;
    changeEntitlement?: string;
  };
  if (wr.change && wr.changeEntitlement) {
    await new Promise((r) => setTimeout(r, 4_000));
    ({ s } = await coinsOf(account, enc.secretKey));
    const change = {
      nonce: hexToBytes(wr.change.nonce, 32),
      color: hexToBytes(wr.change.color, 32),
      value: BigInt(wr.change.value),
    };
    const entry = bytesToHex(await sealEntryPortable(enc.publicKey, change));
    const ap = { entry, authNonce: s.authNonce, entitlement: wr.changeEntitlement };
    const a2 = await device.sign(ctxOf(s), appendInboxRequest(ap), useCounter(s)!);
    const r5 = await post('append-inbox', { account, payload: ap, passportAuth: passportAuthOf(a2) });
    if (r5.status !== 202 || !r5.body.job)
      throw new Error(`append-inbox refused: ${r5.status} ${JSON.stringify(r5.body)}`);
    const aJob = await waitJob(r5.body.job, 'append-inbox');
    record.appendInbox = { state: aJob.state, result: aJob.result, error: aJob.error };
    save();
  }

  if (process.env.SKIP_OFFER !== '1') {
    step('6. make an offer (open-swap) on the mock kernel: one prompt, legs in segment 0, listed');
    let held = null;
    let cs = coins;
    for (let i = 0; i < 20; i++) {
      ({ s, coins: cs } = await coinsOf(account, enc.secretKey, cs));
      held = cs.find((c) => !c.spent && c.mtIndex !== null && BigInt(c.value) > 1n);
      if (held) break;
      await new Promise((r) => setTimeout(r, 3_000));
    }
    if (!held) throw new Error('no spendable coin for the offer');
    const wantToken = tokens.tokens.find((t) => t.midnightColour !== held!.color)!;
    const give = BigInt(held.value) / 2n;
    const want = { nonce: freshWantNonce(), color: hexToBytes(wantToken.midnightColour, 32), value: 12_345n };
    const heldQ = {
      nonce: hexToBytes(held.nonce, 32),
      color: hexToBytes(held.color, 32),
      value: BigInt(held.value),
      mt_index: BigInt(held.mtIndex!),
    };
    const entries = await offerInboxEntriesPortable(enc.publicKey, want, predictChangeCoin(heldQ, give));
    const make = {
      giveColor: held.color,
      giveAmount: give.toString(10),
      wantColor: wantToken.midnightColour,
      wantAmount: want.value.toString(10),
      wantNonce: bytesToHex(want.nonce),
      wantEntry: bytesToHex(entries.wantEntry),
      changeEntry: bytesToHex(entries.changeEntry),
      validUntil: '0',
      coin: { nonce: held.nonce, color: held.color, value: held.value, mtIndex: held.mtIndex! },
      authNonce: s.authNonce,
    };
    const { call, coin: c2 } = openSwapArgs(make);
    const oa = await device.signOffer(ctxOf(s), call, c2, useCounter(s)!);
    say(`the wallet is shown:\n      ${oa.text.split('\n').join('\n      ')}`);
    const r6 = await post('open-swap', { account, payload: make, passportAuth: passportAuthOf(oa) });
    if (r6.status !== 202 || !r6.body.job)
      throw new Error(`open-swap refused: ${r6.status} ${JSON.stringify(r6.body)}`);
    const oJob = await waitJob(r6.body.job, 'open-swap');
    record.openSwap = { state: oJob.state, result: oJob.result, error: oJob.error, message: oa.text };
    save();
  }
  record.finishedAt = new Date().toISOString();
  save();
  step('done');
}

main().then(
  () => process.exit(0),
  (e: unknown) => {
    record.error = String((e as Error)?.stack ?? e);
    save();
    process.stderr.write(`FAILED: ${String((e as Error)?.message ?? e)}\n`);
    process.exit(1);
  },
);
