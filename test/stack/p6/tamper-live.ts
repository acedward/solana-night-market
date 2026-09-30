// P6 (AA 00047), spec SC-002 at the node: an honest Ed25519 approval, an honest proof, then ONE
// disclosed value changed in the proven transaction. The node must refuse it (`InvalidProof`,
// "Custom error: 115"). Nothing lands, so nothing is paid.
//
// The call is account B's `append_inbox_with_ed25519` (k18): B signs the F3 message for a fresh
// 192-byte entry, the relay's own runtime proves it on the contract prover (rc.8), and the proof
// provider is wrapped so that, after proving, every copy of the entry in the proven transaction
// has one byte flipped. The sponsor wallet then balances (DUST, rc.6) and submits it.
//
// It opens the sponsor wallet itself, so the relay must be stopped (one wallet process per seed),
// and a shared funding wallet must be locked by the caller.
//
//   NETWORK=stagenet STATE_DIR=… OUT=… SPONSOR_SEED_FILE=… MIDNIGHT_MANAGED_PATH=… \
//   MIDNIGHT_CONTRACT_PROOF_SERVER_URL=… MIDNIGHT_DUST_PROOF_SERVER_URL=… bun test/stack/p6/tamper-live.ts

import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { PROFILES, bytesToHex, hexToBytes, registryFor, type NetworkName } from '@nightmarket/core';
import {
  appendInboxRequest,
  callContext,
  ed25519DeviceOf,
  findUseCounter,
  sealEntryPortable,
} from '@nightmarket/core/passport';
import nacl from 'tweetnacl';

import { parseSponsorSeed } from '../../../relay/src/config.js';
import { createLogger } from '../../../relay/src/log.js';
import { ed25519ArmAuthArgs } from '../../../relay/src/passport/ed25519-arm.js';
import { PassportRuntime } from '../../../relay/src/passport/runtime.js';
import { openFacadeWallet } from '../../../relay/src/sponsor/facade.js';
import type { SponsorWalletHandle } from '../../../relay/src/passport/wallet-provider.js';

const NETWORK = (process.env.NETWORK ?? 'undeployed') as NetworkName;
const PROFILE = PROFILES[NETWORK];
const STATE_DIR = process.env.STATE_DIR ?? '/state';
const OUT = process.env.OUT ?? '/out';
const WHO = (process.env.WHO ?? 'B') as 'A' | 'B';
const need = (n: string) => {
  const v = process.env[n];
  if (!v) throw new Error(`${n} is required`);
  return v;
};
const say = (s: string) => process.stdout.write(`   ${s}\n`);
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

const state = JSON.parse(readFileSync(join(STATE_DIR, 'state.json'), 'utf8')) as {
  network: string;
  A: { seed: string; encPublic: string; account?: string };
  B: { seed: string; encPublic: string; account?: string };
};
if (state.network !== NETWORK) throw new Error(`the state is for ${state.network}`);
const party = state[WHO];
if (!party.account) throw new Error(`${WHO} has no account yet`);

const tokens = registryFor(
  NETWORK,
  process.env.TOKENS_FILE ? JSON.parse(readFileSync(process.env.TOKENS_FILE, 'utf8')) : undefined,
);
const kp = nacl.sign.keyPair.fromSeed(hexToBytes(party.seed, 32));
const signer = {
  deviceKey: bytesToHex(kp.publicKey),
  address: '',
  signMessage: async (m: Uint8Array) => nacl.sign.detached(m, kp.secretKey),
};
const device = ed25519DeviceOf(signer, { network: NETWORK, tokens });

const result: Record<string, unknown> = {
  network: NETWORK,
  account: party.account,
  startedAt: new Date().toISOString(),
};
const save = () => {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(
    join(OUT, process.env.OUT_NAME ?? 'tamper-live.json'),
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
    { feeBlocksMargin: Number(process.env.SPONSOR_FEE_BLOCKS_MARGIN ?? '5') },
  );
  try {
    const providers = (await rt.providers(opened.handle as SponsorWalletHandle)) as unknown as Record<string, unknown>;
    const ledger = (await import('@midnightntwrk/ledger-v9')) as unknown as {
      Transaction: { deserialize(s: string, p: string, b: string, raw: Uint8Array): unknown };
    };
    // The account as the relay reads it.
    const l = await rt.ledgerState(party.account!);
    if (!l) throw new Error('the account is not on chain');
    const accountBytes = hexToBytes(party.account!, 32);
    const devices = [...l.devices].map((d) => bytesToHex(d));
    const counter = findUseCounter(devices, (k) => bytesToHex(device.entryAt(accountBytes, l.device_epoch, k)));
    if (counter === null) throw new Error('the device is not live');
    const ctx = callContext({
      account: party.account!,
      authNonce: l.auth_nonce,
      networkSalt: bytesToHex(l.evm_domain_salt),
    });
    const entry = await sealEntryPortable(hexToBytes(party.encPublic, 32), {
      nonce: new Uint8Array(randomBytes(32)),
      color: new Uint8Array(32),
      value: 1n,
    });
    const auth = await device.sign(ctx, appendInboxRequest({ entry: bytesToHex(entry) } as never), counter);
    result.walletText = auth.text;
    result.authNonce = l.auth_nonce;
    say(`the wallet shows:\n      ${auth.text.split('\n').join('\n      ')}`);

    // Prove honestly, then flip one byte of every copy of the entry in the proven transaction.
    const inner = rt.proofProvider as { proveTx(tx: unknown, cfg?: unknown): Promise<{ serialize(): Uint8Array }> };
    providers.proofProvider = {
      async proveTx(tx: unknown, cfg?: unknown) {
        const t0 = Date.now();
        const proven = await inner.proveTx(tx, cfg);
        result.proveSeconds = (Date.now() - t0) / 1000;
        const bytes = proven.serialize();
        const buf = Buffer.from(bytes);
        // The entry is a disclosed Bytes<192>; the transcript stores it as one value atom (trailing
        // zero bytes trimmed), so look for its first 64 bytes, then for any 32-byte window of it.
        const find = (needle: Buffer) => {
          const hits: number[] = [];
          for (let i = buf.indexOf(needle); i >= 0; i = buf.indexOf(needle, i + 1)) hits.push(i);
          return hits;
        };
        let at = 0;
        let hits = find(Buffer.from(entry.subarray(0, 64)));
        for (let off = 0; hits.length === 0 && off + 32 <= entry.length; off += 16) {
          hits = find(Buffer.from(entry.subarray(off, off + 32)));
          at = off;
        }
        if (hits.length === 0) throw new Error('tamper: the entry does not occur in the proven transaction');
        for (const h of hits) buf[h + 20]! ^= 0x01;
        result.tamper = {
          field: `append_inbox entry (disclosed Bytes<192>): byte ${at + 20} of the entry flipped in every copy`,
          txBytes: bytes.length,
          occurrences: hits.length,
          offsets: hits,
          provenSha256: sha256(bytes),
          tamperedSha256: sha256(new Uint8Array(buf)),
        };
        say(
          `TAMPERED: flipped byte ${at + 20} of the entry at ${hits.join(', ')} in the proven transaction (${bytes.length} B)`,
        );
        save();
        return ledger.Transaction.deserialize('signature', 'proof', 'pre-binding', new Uint8Array(buf));
      },
    };
    const custody = (await rt.client.account.CustodyAccount.connect(
      providers,
      rt.compiledAccount(),
      party.account!,
      rt.client.witnesses.emptyCoinStore(),
    )) as { handle: { callTx: Record<string, (...a: unknown[]) => Promise<unknown>> } };
    const t0 = Date.now();
    try {
      const r = await custody.handle.callTx['append_inbox_with_ed25519']!(entry, ...ed25519ArmAuthArgs(auth as never));
      result.outcome = 'ACCEPTED (a tampered proof landed: this is a failure)';
      result.accepted = r;
      process.exitCode = 1;
    } catch (e) {
      const m = String((e as Error)?.stack ?? e);
      result.outcome = /Custom error: 115|InvalidProof|Invalid proof/i.test(m)
        ? 'REFUSED: InvalidProof'
        : 'REFUSED (other)';
      result.error = m.slice(0, 4000);
      if (result.outcome !== 'REFUSED: InvalidProof') process.exitCode = 1;
    }
    result.seconds = (Date.now() - t0) / 1000;
    // The account did not move.
    const l2 = await rt.ledgerState(party.account!);
    result.authNonceAfter = l2?.auth_nonce ?? null;
    result.inboxCountBefore = l.inbox_count;
    result.inboxCountAfter = l2?.inbox_count ?? null;
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
