// P9.I (AA 00047), audit C2 at the CIRCUIT on a live stack: a shielded withdrawal whose signed text
// names one token (twBTC) while the coin the `held_coin` witness hands the circuit is another
// (twUSDC). The wallet's signature is VALID for that text (the challenge comes from the contract's
// own pure circuit, the message from the arm's renderer), so only the circuit's C2 assert
// (`coin.color == color`, passport b2f1847) stands between it and a withdrawal that shows token B
// and sends token A. The call must fail with that assert; nothing is proven, submitted or paid.
//
// The honest client refuses to sign such a call, and the relay refuses the signature
// (market-flows.ts `p9-negatives`); this script goes around both, the way a malicious relay or page
// would, straight to the account's circuit through the relay's own runtime.
//
// It opens the sponsor wallet (the providers need one), so the relay must be stopped (one wallet
// process per seed). It needs the coin market-flows.ts recorded in state.json (`c2Coin`).
//
//   NETWORK=undeployed STATE_DIR=… OUT=… SPONSOR_SEED_FILE=… MIDNIGHT_MANAGED_PATH=… TOKENS_FILE=… \
//   MIDNIGHT_CONTRACT_PROOF_SERVER_URL=… MIDNIGHT_DUST_PROOF_SERVER_URL=… bun test/stack/p6/c2-live.ts

import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { PROFILES, bytesToHex, hexToBytes, registryFor, type NetworkName } from '@nightmarket/core';
import {
  callContext,
  decodeEd25519Point,
  decodeEd25519Signature,
  ed25519DeviceOf,
  ed25519TokenResolver,
  findUseCounter,
  marketLabel,
  pureCircuits,
  renderEd25519Message,
} from '@nightmarket/core/passport';
import nacl from 'tweetnacl';

import { parseSponsorSeed } from '../../../relay/src/config.js';
import { createLogger } from '../../../relay/src/log.js';
import { PassportRuntime } from '../../../relay/src/passport/runtime.js';
import { openFacadeWallet } from '../../../relay/src/sponsor/facade.js';
import type { SponsorWalletHandle } from '../../../relay/src/passport/wallet-provider.js';

const NETWORK = (process.env.NETWORK ?? 'undeployed') as NetworkName;
const PROFILE = PROFILES[NETWORK];
const STATE_DIR = process.env.STATE_DIR ?? '/state';
const OUT = process.env.OUT ?? '/out';
const need = (n: string) => {
  const v = process.env[n];
  if (!v) throw new Error(`${n} is required`);
  return v;
};
const say = (s: string) => process.stdout.write(`   ${s}\n`);

const state = JSON.parse(readFileSync(join(STATE_DIR, 'state.json'), 'utf8')) as {
  network: string;
  A: { seed: string; account?: string };
  c2Coin?: { nonce: string; color: string; value: string; mtIndex: string };
};
if (state.network !== NETWORK) throw new Error(`the state is for ${state.network}`);
if (!state.A.account || !state.c2Coin) throw new Error('run market-flows.ts p9-negatives first (no c2Coin)');
const account = state.A.account;
const coinRec = state.c2Coin;

const tokens = registryFor(
  NETWORK,
  process.env.TOKENS_FILE ? JSON.parse(readFileSync(process.env.TOKENS_FILE, 'utf8')) : undefined,
);
const namedToken = tokens.tokens.find((t) => t.privacy === 'shielded' && t.midnightColour !== coinRec.color);
if (!namedToken) throw new Error('the registry has no second shielded token to name');
const named = namedToken;
const kp = nacl.sign.keyPair.fromSeed(hexToBytes(state.A.seed, 32));
const deviceKey = bytesToHex(kp.publicKey);
const device = ed25519DeviceOf(
  { deviceKey, address: '', signMessage: async (m: Uint8Array) => nacl.sign.detached(m, kp.secretKey) },
  { network: NETWORK, tokens },
);

const result: Record<string, unknown> = {
  network: NETWORK,
  account,
  coin: { color: coinRec.color, value: coinRec.value, mtIndex: coinRec.mtIndex },
  namedColour: named.midnightColour,
  startedAt: new Date().toISOString(),
};
const save = () => {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(
    join(OUT, process.env.OUT_NAME ?? 'c2-live.json'),
    `${JSON.stringify(result, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2)}\n`,
  );
};

async function main() {
  const log = createLogger({ level: 'warn' });
  const rt = await PassportRuntime.load({
    managedPath: need('MIDNIGHT_MANAGED_PATH'),
    networkId: PROFILE.midnightNetworkId,
    indexerUrl: process.env.MIDNIGHT_INDEXER_URL ?? PROFILE.midnight.indexerUrl,
    indexerWsUrl: process.env.MIDNIGHT_INDEXER_WS_URL ?? PROFILE.midnight.indexerWsUrl,
    contractProofServerUrl: need('MIDNIGHT_CONTRACT_PROOF_SERVER_URL'),
    log,
  });
  const seedHex = parseSponsorSeed(readFileSync(need('SPONSOR_SEED_FILE'), 'utf8'));
  const opened = await openFacadeWallet(
    seedHex,
    {
      networkId: PROFILE.midnightNetworkId,
      indexerUrl: process.env.MIDNIGHT_INDEXER_URL ?? PROFILE.midnight.indexerUrl,
      indexerWsUrl: process.env.MIDNIGHT_INDEXER_WS_URL ?? PROFILE.midnight.indexerWsUrl,
      nodeWsUrl: process.env.MIDNIGHT_NODE_WS_URL ?? PROFILE.midnight.nodeWsUrl,
      dustProofServerUrl: need('MIDNIGHT_DUST_PROOF_SERVER_URL'),
    },
    { feeBlocksMargin: Number(process.env.SPONSOR_FEE_BLOCKS_MARGIN ?? '20') },
  );
  try {
    const l = await rt.ledgerState(account);
    if (!l) throw new Error('the account is not on chain');
    const accountBytes = hexToBytes(account, 32);
    const counter = findUseCounter(
      [...l.devices].map((d) => bytesToHex(d)),
      (k) => bytesToHex(device.entryAt(accountBytes, l.device_epoch, k)),
    );
    if (counter === null) throw new Error('the device is not live');
    const ctx = callContext({
      account,
      authNonce: l.auth_nonce,
      networkSalt: bytesToHex(l.evm_domain_salt),
      encKey: bytesToHex(l.enc_key),
    });
    const recipient = new Uint8Array(randomBytes(32));
    const coin = {
      nonce: hexToBytes(coinRec.nonce, 32),
      color: hexToBytes(coinRec.color, 32),
      value: BigInt(coinRec.value),
      mt_index: BigInt(coinRec.mtIndex),
    };
    const color = hexToBytes(named.midnightColour, 32); // what the text names: NOT the coin's token
    const amount = 1000n;
    // The honest client refuses first (C2 client side).
    try {
      await device.sign(ctx, { op: 'withdrawShielded', recipient, color, amount, coin }, counter);
      result.clientRefusal = null;
    } catch (e) {
      result.clientRefusal = String((e as Error).message).slice(0, 200);
    }
    // A valid signature over the arm's own text for it, made around the client.
    const pk = decodeEd25519Point(kp.publicKey);
    const challenge = (pureCircuits as unknown as Record<string, (...a: unknown[]) => Uint8Array>)
      .challenge_withdraw_shielded_with_ed25519!(
      { bytes: ctx.contractAddress },
      pk,
      ctx.evmDomainSalt,
      { bytes: recipient },
      color,
      amount,
      coin,
      ctx.authNonce,
    );
    const m = renderEd25519Message(
      {
        contractAddress: ctx.contractAddress,
        authNonce: ctx.authNonce,
        challenge,
        label: marketLabel(NETWORK),
        tokens: ed25519TokenResolver(tokens),
      },
      { op: 'withdrawShielded', recipient, color, amount },
    );
    const sig = nacl.sign.detached(m.bytes, kp.secretKey);
    result.walletText = m.text;
    result.signatureVerifies = nacl.sign.detached.verify(m.bytes, sig, kp.publicKey);
    say(`the wallet would show:\n      ${m.text.split('\n').join('\n      ')}`);

    const providers = await rt.providers(opened.handle as SponsorWalletHandle);
    const custody = (await rt.client.account.CustodyAccount.connect(
      providers,
      rt.compiledAccount(),
      account,
      rt.client.witnesses.withCoin(rt.client.witnesses.emptyCoinStore(), {
        nonce: coin.nonce,
        color: coin.color,
        value: coin.value,
        mtIndex: coin.mt_index,
      }),
    )) as { handle: { callTx: Record<string, (...a: unknown[]) => Promise<unknown>> } };
    const t0 = Date.now();
    try {
      const r = await custody.handle.callTx['withdraw_shielded_with_ed25519']!(
        { bytes: recipient },
        color,
        amount,
        pk,
        counter,
        decodeEd25519Signature(sig),
        m.show,
      );
      result.outcome = 'ACCEPTED (a C2-mismatched withdrawal went through: this is a failure)';
      result.txId = (r as { public?: { txId?: string } })?.public?.txId ?? null;
      process.exitCode = 1;
    } catch (e) {
      const msg = String((e as Error)?.stack ?? e);
      result.outcome = /held coin colour does not match the withdrawn colour/.test(msg)
        ? 'REFUSED by the circuit: held coin colour does not match the withdrawn colour'
        : 'REFUSED (other)';
      result.error = msg.slice(0, 3000);
      if (!/held coin colour does not match/.test(msg)) process.exitCode = 1;
    }
    result.seconds = (Date.now() - t0) / 1000;
    const l2 = await rt.ledgerState(account);
    result.authNonce = { before: l.auth_nonce, after: l2?.auth_nonce ?? null };
    say(`outcome: ${String(result.outcome)}`);
  } finally {
    result.finishedAt = new Date().toISOString();
    save();
    await opened.stop().catch(() => undefined);
  }
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (e: unknown) => {
    result.error = String((e as Error)?.stack ?? e);
    save();
    process.stderr.write(`FAILED: ${String((e as Error)?.message ?? e)}\n`);
    process.exit(1);
  },
);
