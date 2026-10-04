// AA 00060 P0.4: the exact bytes of every message Night Market asks a Solana wallet to sign, for fixed
// inputs, as recorded at PR #1's head `10b29b1` (spec SC-004, FR-016: every existing message keeps its
// bytes). P5 re-runs this script on the branch and compares the output with the committed file.
//
//   bun scripts/message-goldens.ts                   print the goldens as JSON
//   bun scripts/message-goldens.ts --out <file>      write them to <file>
//   bun scripts/message-goldens.ts --check <file>    exit 1 unless the goldens equal <file> byte for byte
//
// Every message is built by the market's own code path, not re-implemented here:
//   - the relay envelopes (`register`, `demo-tokens`, `withdraw`): `solanaEnvelopeMessage` over
//     `buildRelayActionMessage` (packages/core/src/solana-auth.ts);
//   - the F3 v3 account calls: Track A's `Ed25519Device` (`sign` / `signOffer`) with the market's
//     label and token resolver (`ed25519DeviceOf`'s options). The device computes each challenge with
//     the compiled account's own pure circuit, renders the text in TypeScript AND with the circuit's
//     `ed25519_message_*`, refuses any difference, and runs the wallet-safety guard, so a golden here
//     is exactly what the wallet would be handed.
// The signing key is a fixed public test seed (bytes 0x01..0x20); its signatures are not recorded.
// Needs the light compile of the account (`bun run contracts`).

import { readFileSync, writeFileSync } from 'node:fs';

import { sha256 } from '@noble/hashes/sha2.js';

import {
  bytesToHex,
  buildRelayActionMessage,
  registryFor,
  type RelayActionName,
  type TokenRegistry,
} from '@nightmarket/core';
import {
  Ed25519Device,
  ed25519TokenResolver,
  marketLabel,
  type AuthRequest,
  type CallContext,
  type OfferCallArgs,
} from '@nightmarket/core/passport';
import { solanaEnvelopeMessage } from '@nightmarket/core/solana-auth';
import { RECIPIENT_OPEN } from '../packages/core/src/passport/vendor/offer-codec.js';
import type { QualifiedCoin } from '../vendor/passport/contract/src/wallet/contract.js';

type Network = 'undeployed' | 'stagenet';

export interface MessageGolden {
  /** `<network>/<kind>`, e.g. `undeployed/f3-withdraw-shielded`. */
  id: string;
  network: Network;
  kind: string;
  /** What the message is: a relay envelope (proof of possession) or an F3 v3 account call. */
  family: 'relay-envelope' | 'account-call';
  bytes: number;
  sha256: string;
  hex: string;
  text: string;
}

export interface MessageGoldens {
  format: 'night-market-message-goldens/v1';
  base: { repo: string; commit: string; passport: string };
  inputs: Record<string, unknown>;
  messages: MessageGolden[];
}

const fill = (byte: number, n = 32): Uint8Array => new Uint8Array(n).fill(byte);
const SEED = Uint8Array.from({ length: 32 }, (_, i) => i + 1);

// Fixed inputs (none of them secret: a public test seed, constant bytes).
const ACCOUNT = fill(0x11);
const NETWORK_SALT = fill(0x22);
const ENC_KEY = fill(0x33);
const AUTH_NONCE = 7n;
const USE_COUNTER = 3n;
const ENVELOPE_NONCE = `0x${'ab'.repeat(32)}`;
const ENVELOPE_EXPIRY = 1_900_000_000;

/** A local stack's registry (its colours are new on every run, so the goldens fix two). */
const LOCAL_TOKENS = {
  mode: 'replace' as const,
  tokens: [
    { symbol: 'twUSDC', decimals: 6, midnightColour: 'a1'.repeat(32) },
    { symbol: 'twBTC', decimals: 8, midnightColour: 'b2'.repeat(32) },
    { symbol: 'utwUSDC', decimals: 6, privacy: 'unshielded' as const, midnightColour: 'c3'.repeat(32) },
  ],
};

function registryOf(network: Network): TokenRegistry {
  return network === 'undeployed' ? registryFor('undeployed', LOCAL_TOKENS) : registryFor('stagenet');
}

function colourOf(registry: TokenRegistry, symbol: string): Uint8Array {
  const t = registry.bySymbol(symbol);
  if (!t) throw new Error(`no ${symbol} in the ${registry.network} registry`);
  return Uint8Array.from(Buffer.from(t.midnightColour, 'hex'));
}

function golden(network: Network, kind: string, family: MessageGolden['family'], bytes: Uint8Array): MessageGolden {
  return {
    id: `${network}/${kind}`,
    network,
    kind,
    family,
    bytes: bytes.length,
    sha256: bytesToHex(sha256(bytes)),
    hex: bytesToHex(bytes),
    text: String.fromCharCode(...bytes),
  };
}

async function messagesFor(network: Network): Promise<MessageGolden[]> {
  const out: MessageGolden[] = [];
  const registry = registryOf(network);
  const rec: { bytes: Uint8Array | null } = { bytes: null };
  const device = Ed25519Device.fromSeed(SEED, { label: marketLabel(network), tokens: ed25519TokenResolver(registry) });
  // The same device, recording the bytes it hands the wallet (Ed25519Device.fromSeed signs with tweetnacl).
  const recorder = new Ed25519Device({
    publicKey: device.publicKey,
    label: marketLabel(network),
    tokens: ed25519TokenResolver(registry),
    sign: async (m: Uint8Array) => {
      rec.bytes = Uint8Array.from(m);
      const nacl = (await import('tweetnacl')).default;
      return nacl.sign.detached(m, nacl.sign.keyPair.fromSeed(SEED).secretKey);
    },
  });
  const owner = device.publicKeyHex;

  // The relay envelopes (proof of possession; its nonce field is the envelope digest).
  const envelopes: { action: RelayActionName; account?: string; payload: unknown }[] = [
    { action: 'register', payload: { encKey: bytesToHex(ENC_KEY) } },
    { action: 'demo-tokens', account: bytesToHex(ACCOUNT), payload: { pack: 'demo' } },
    { action: 'withdraw', account: bytesToHex(ACCOUNT), payload: { recipientEncryptionKey: 'dd'.repeat(32) } },
  ];
  for (const e of envelopes) {
    const message = buildRelayActionMessage({
      action: e.action,
      network,
      owner,
      ...(e.account ? { account: e.account } : {}),
      payload: e.payload,
      nonce: ENVELOPE_NONCE,
      expiry: ENVELOPE_EXPIRY,
    });
    out.push(golden(network, `envelope-${e.action}`, 'relay-envelope', solanaEnvelopeMessage(message)));
  }

  // The F3 v3 account calls.
  const ctx: CallContext = {
    contractAddress: ACCOUNT,
    authNonce: AUTH_NONCE,
    evmDomainSalt: NETWORK_SALT,
    encKey: ENC_KEY,
  } as CallContext;
  const usdc = colourOf(registry, 'twUSDC');
  const btc = colourOf(registry, 'twBTC');
  const uusdc = colourOf(registry, 'utwUSDC');
  const coin: QualifiedCoin = { nonce: fill(0x55), color: usdc, value: 2_500_000n, mt_index: 5n };
  const calls: { kind: string; request: AuthRequest }[] = [
    {
      kind: 'f3-withdraw-shielded',
      request: { op: 'withdrawShielded', recipient: fill(0x44), color: usdc, amount: 1_234_567n, coin },
    },
    {
      kind: 'f3-withdraw-unshielded',
      request: { op: 'withdrawUnshielded', color: uusdc, amount: 750_000n, recipient: fill(0x66) },
    },
    { kind: 'f3-append-inbox', request: { op: 'appendInbox', entry: fill(0x77, 192) } },
    // The market's cancel: rotate_enc_key to the account's CURRENT key ("Cancel all open offers").
    { kind: 'f3-cancel', request: { op: 'rotateEncKey', newKey: ENC_KEY } },
    // The key restore: rotate_enc_key to another key ("Rotate encryption key").
    { kind: 'f3-restore', request: { op: 'rotateEncKey', newKey: fill(0x88) } },
  ];
  for (const c of calls) {
    rec.bytes = null;
    await recorder.sign(ctx, c.request, USE_COUNTER);
    if (!rec.bytes) throw new Error(`${c.kind}: the device never asked the wallet`);
    out.push(golden(network, c.kind, 'account-call', rec.bytes));
  }

  // A make (an open offer) and a take (the complementary offer, shorter expiry): both are one
  // `open_swap_shielded_with_ed25519` approval.
  const offers: { kind: string; call: OfferCallArgs; coin: QualifiedCoin }[] = [
    {
      kind: 'f3-offer',
      call: {
        giveColor: usdc,
        giveAmount: 2_000_000n,
        recipientKind: RECIPIENT_OPEN,
        recipient: new Uint8Array(32),
        want: { nonce: fill(0x99), color: btc, value: 3_000n },
        wantEntry: fill(0xaa, 192),
        changeEntry: fill(0xbb, 192),
        validUntil: 1_900_000_900n,
      },
      coin,
    },
    {
      kind: 'f3-take',
      call: {
        giveColor: btc,
        giveAmount: 3_000n,
        recipientKind: RECIPIENT_OPEN,
        recipient: new Uint8Array(32),
        want: { nonce: fill(0xcc), color: usdc, value: 2_000_000n },
        wantEntry: fill(0xdd, 192),
        changeEntry: fill(0xee, 192),
        validUntil: 1_900_000_120n,
      },
      coin: { nonce: fill(0x5a), color: btc, value: 10_000n, mt_index: 9n },
    },
  ];
  for (const o of offers) {
    rec.bytes = null;
    await recorder.signOffer(ctx, o.call, o.coin, USE_COUNTER);
    if (!rec.bytes) throw new Error(`${o.kind}: the device never asked the wallet`);
    out.push(golden(network, o.kind, 'account-call', rec.bytes));
  }
  return out;
}

export async function messageGoldens(): Promise<MessageGoldens> {
  const messages = [...(await messagesFor('undeployed')), ...(await messagesFor('stagenet'))];
  return {
    format: 'night-market-message-goldens/v1',
    base: {
      repo: 'acedward/solana-night-market',
      commit: '10b29b1170f014951f03a1d9613b9b3da4328489',
      passport: '599327b918b55afc95d6c98a89bcd15f4e8b0d53',
    },
    inputs: {
      deviceSeed: bytesToHex(SEED),
      account: bytesToHex(ACCOUNT),
      networkSalt: bytesToHex(NETWORK_SALT),
      encKey: bytesToHex(ENC_KEY),
      authNonce: AUTH_NONCE.toString(),
      useCounter: USE_COUNTER.toString(),
      envelopeNonce: ENVELOPE_NONCE,
      envelopeExpiry: ENVELOPE_EXPIRY,
      localTokens: LOCAL_TOKENS.tokens,
      stagenetTokens: 'the vendored mint-test-tokens registry (registryFor("stagenet"))',
    },
    messages,
  };
}

export const renderGoldens = (g: MessageGoldens): string => `${JSON.stringify(g, null, 2)}\n`;

if (import.meta.main) {
  const args = process.argv.slice(2);
  const text = renderGoldens(await messageGoldens());
  const outAt = args.indexOf('--out');
  const checkAt = args.indexOf('--check');
  if (checkAt >= 0) {
    const file = args[checkAt + 1];
    if (!file) throw new Error('--check needs a file');
    const committed = readFileSync(file, 'utf8');
    if (committed !== text) {
      const a = JSON.parse(committed) as MessageGoldens;
      const b = JSON.parse(text) as MessageGoldens;
      for (const m of b.messages) {
        const old = a.messages.find((x) => x.id === m.id);
        if (!old || old.hex !== m.hex) console.error(`message-goldens: ${m.id} differs`);
      }
      console.error(`message-goldens: the goldens differ from ${file}`);
      process.exit(1);
    }
    console.log(`message-goldens: ${file} matches (${(JSON.parse(text) as MessageGoldens).messages.length} messages)`);
  } else if (outAt >= 0) {
    const file = args[outAt + 1];
    if (!file) throw new Error('--out needs a file');
    writeFileSync(file, text);
    console.log(`message-goldens: wrote ${file}`);
  } else {
    process.stdout.write(text);
  }
}
