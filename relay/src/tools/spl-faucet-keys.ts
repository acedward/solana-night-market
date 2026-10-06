// AA 00060 P13.3: build the test SPL faucet's keys file (SPL_FAUCET_KEYS_FILE) for a stack harness.
//
//   bun relay/src/tools/spl-faucet-keys.ts --journey <journey-tokens.json> --rpc <solana rpc url> \
//     --out <keys file> <keypair.json> [<keypair.json> …]
//
// For each mint of the journey registry (I-1) it reads the mint's on-chain mint authority and picks, among
// the given Solana CLI keypair files, the one whose public key it is. It writes `{ "<mint>": [64 numbers] }`
// for those mints, mode 600, and prints which public key controls which mint (public values only). A
// registry mint whose authority is none of the given keys is refused (exit 65), so a harness never starts
// a faucet the relay would refuse; `--allow-partial` writes the others. Nothing secret is ever printed.
//
// In the 00050 template's localnet deploy (`deploy-devnet.ts`), each test mint's authority is its bridge's
// OPERATOR key (`secrets-<x|y>/solana-operator.json`), not the depositor's: pass the operators' keypairs.

import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { parseJourneyRegistry } from '@nightmarket/core/bridge';
import { TOKEN_PROGRAM_ID, parseMintAccount } from '@nightmarket/core/solana';

import { parseFaucetKeys, type FaucetKey } from '../faucet/keys.js';
import { FaucetSolanaRpc } from '../faucet/solana-rpc.js';

export interface KeysFilePlan {
  /** mint → the keypair (64 bytes) that is its mint authority. */
  keys: Map<string, Uint8Array>;
  /** Public lines for the operator: `<symbol> <mint>: authority <public key>`. */
  report: string[];
  /** Registry mints whose authority none of the keypairs holds. */
  missing: string[];
}

/** Match the registry's mints to the keypairs by each mint's on-chain authority. */
export async function planKeysFile(o: {
  journey: unknown;
  keypairs: readonly Uint8Array[];
  rpc: FaucetSolanaRpc;
}): Promise<KeysFilePlan> {
  const registry = parseJourneyRegistry(o.journey, {
    midnightNetwork: (o.journey as { midnightNetwork?: string }).midnightNetwork ?? '',
    skipColourCheck: true,
  });
  const mints = registry.entries.map((e) => e.splMint);
  // Each keypair, checked for consistency, as a key per mint (parseFaucetKeys's rules).
  const byPublic = new Map<string, FaucetKey>();
  for (const kp of o.keypairs) {
    const k = parseFaucetKeys(JSON.stringify({ [mints[0]!]: Array.from(kp) }), new Set(mints)).get(mints[0]!)!;
    byPublic.set(k.publicKey, k);
  }
  const keys = new Map<string, Uint8Array>();
  const report: string[] = [];
  const missing: string[] = [];
  for (const e of registry.entries) {
    const a = await o.rpc.account(e.splMint);
    const authority = a && a.owner === TOKEN_PROGRAM_ID ? parseMintAccount(a.data).mintAuthority : null;
    const k = authority ? byPublic.get(authority) : undefined;
    if (k) {
      keys.set(e.splMint, k.secretKey);
      report.push(`${e.symbol} ${e.splMint}: authority ${k.publicKey}`);
    } else {
      missing.push(e.splMint);
      report.push(
        `${e.symbol} ${e.splMint}: authority ${authority ?? 'none or not a classic mint'} (no keypair given)`,
      );
    }
  }
  return { keys, report, missing };
}

/** The file's text: `{ "<mint>": [64 numbers], … }`. */
export const keysFileText = (keys: ReadonlyMap<string, Uint8Array>): string =>
  `${JSON.stringify(Object.fromEntries([...keys].map(([m, k]) => [m, Array.from(k)])))}\n`;

async function main(argv: string[]): Promise<number> {
  const say = (m: string) => process.stderr.write(`spl-faucet-keys: ${m}\n`);
  let journey: string | undefined;
  let rpc: string | undefined;
  let out: string | undefined;
  let partial = false;
  const files: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--journey') journey = argv[++i];
    else if (a === '--rpc') rpc = argv[++i];
    else if (a === '--out') out = argv[++i];
    else if (a === '--allow-partial') partial = true;
    else files.push(a);
  }
  if (!journey || !rpc || !out || files.length === 0) {
    say('usage: --journey <journey-tokens.json> --rpc <url> --out <file> [--allow-partial] <keypair.json>…');
    return 64;
  }
  const keypairs = files.map((f) => {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(f, 'utf8'));
    } catch {
      // A JSON error message can quote the text: name the file only.
      throw new Error(`${f} cannot be read as a Solana CLI keypair file`);
    }
    if (!Array.isArray(raw) || raw.length !== 64) throw new Error(`${f} is not a Solana CLI keypair file`);
    return Uint8Array.from(raw as number[]);
  });
  const plan = await planKeysFile({
    journey: JSON.parse(readFileSync(journey, 'utf8')),
    keypairs,
    rpc: new FaucetSolanaRpc(rpc),
  });
  for (const line of plan.report) say(line);
  if (plan.missing.length > 0 && !partial) {
    say(`refused: no keypair holds the mint authority of ${plan.missing.join(', ')}; nothing written`);
    return 65;
  }
  if (plan.keys.size === 0) {
    say('refused: no mint to write');
    return 65;
  }
  writeFileSync(out, keysFileText(plan.keys), { mode: 0o600 });
  chmodSync(out, 0o600);
  say(`wrote ${out} (mode 600): ${plan.keys.size} mint(s)`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      // Never the keys: only the error's own message (paths and rules).
      process.stderr.write(`spl-faucet-keys: ${e instanceof Error ? e.message : 'failed'}\n`);
      process.exit(70);
    },
  );
}
