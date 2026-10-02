// The account as the CHAIN shows it, decoded in the browser (AA 00047 P9.S; spec FR-004b; questions
// Q26: the relay is trustless, so the browser reads every security-relevant fact about its account
// from the public indexer itself, never from the relay).
//
// The indexer serves a contract's state as the ledger's serialised `ContractState` (the same bytes
// midnight-js's `queryContractState` deserialises). This module turns those bytes into what the page
// needs, with the compiled account's own `ledger()` over compact-runtime 0.20's `ContractState` (the
// runtime the browser bundle already holds for the arm's pure circuits; no ledger-v9 in the browser):
//   - the fields every gated call binds: the auth nonce, the device set and epoch (the use counter is
//     found among them), the encryption key, the network salt, the inbox and its count;
//   - every operation the contract carries, with the SHA-256 of its verifier key (the same digest
//     compactc writes beside a compile and the relay pins, spec FR-005);
//   - the maintenance authority (a retired one is an empty committee no threshold can satisfy);
//   - the public (unshielded) balances.
//
// `checkMarketAccount` is the check a browser runs before it deposits to, trades from or seals an
// entry for an account (audit C3, F-A2/F-B5): exactly the market's circuits with the verifier keys
// pinned in this build, the authority retired, ONE device and it is this wallet's, the encryption
// key this browser holds, this network's salt, the counters far from overflowing, every credited
// balance backed by a real holding (AA 00047 P11, R3-1), and the account's ORIGIN: its deploy-time
// state is the honest constructor's and nothing but the market's own steps wrote before its
// authority retired (./account-provenance.ts).

import { ContractState } from '@midnight-ntwrk/compact-runtime-0.20';
import { sha256 } from '@noble/hashes/sha2.js';
import { keccak_256 } from '@noble/hashes/sha3.js';

import type { AccountStateView } from '../accounts.js';
import { bytesToHex, hexToBytes, normaliseHex32 } from '../hex.js';
import { ledger } from '../../../../vendor/passport/contract/src/wallet/contract.js';
import type { OriginVerdict } from './account-provenance.js';
import { ed25519DeviceForKey } from './ed25519.js';
import { findUseCounter } from './gated.js';

export class AccountStateDecodeError extends Error {
  override name = 'AccountStateDecodeError';
}

/** Everything the page reads about an account from the chain. */
export interface AccountChainState {
  /** The account's contract address, 64 lowercase hex. */
  account: string;
  /** The fields the gated calls bind (the same shape the relay used to serve). */
  view: AccountStateView;
  /** Every operation the contract carries: circuit name → SHA-256 of its verifier key (64 hex), or
   *  '' for an operation without a key. */
  operations: Record<string, string>;
  /** The maintenance authority: how many committee keys, and the threshold. */
  authority: { committee: number; threshold: number };
  /** The inbox entries in order (192-byte hex; null where an index is empty). */
  inbox: Array<string | null>;
  /** The public (unshielded) balances, one row per colour with a non-zero balance, by colour. */
  unshielded: Array<{ colour: string; amount: string }>;
  /** The account's own ledger of credited unshielded amounts (its `unshielded_balances` map, which
   *  `deposit_unshielded` credits and `withdraw_unshielded` debits), one row per colour, by colour.
   *  A fresh account has none (AA 00047 P10, R2-6): a deployer that seeds it near 2^128 makes every
   *  later deposit of that colour overflow. */
  credited: Array<{ colour: string; amount: string }>;
  /** The account's `round` counter (decimal), which every state-changing circuit moves by one with a
   *  checked cast: near 2^64 it freezes the account (AA 00047 P11, R3-1). */
  round: string;
}

const hex = (b: Uint8Array) => bytesToHex(b);

/** The ledger's operation name as text (compiled circuits are named by strings). */
const operationName = (op: string | Uint8Array): string => (typeof op === 'string' ? op : new TextDecoder().decode(op));

/** Decode an account's serialised on-chain state (hex, as the indexer serves it, or bytes). */
export function decodeAccountState(account: string, state: string | Uint8Array): AccountChainState {
  const address = normaliseHex32(account);
  let cs: ContractState;
  try {
    const bytes = typeof state === 'string' ? hexToBytes(state.replace(/^0x/, '')) : state;
    cs = ContractState.deserialize(bytes);
  } catch (e) {
    throw new AccountStateDecodeError(`the account's state does not decode: ${(e as Error).message}`);
  }
  let l: ReturnType<typeof ledger>;
  try {
    l = ledger(cs.data);
  } catch (e) {
    throw new AccountStateDecodeError(`the state is not a Passport account's: ${(e as Error).message}`);
  }
  const operations: Record<string, string> = {};
  for (const op of cs.operations()) {
    const vk = cs.operation(op)?.verifierKey;
    operations[operationName(op)] = vk && vk.length > 0 ? hex(sha256(vk)) : '';
  }
  const ma = cs.maintenanceAuthority;
  const inboxCount = l.inbox_count;
  const inbox: Array<string | null> = [];
  for (let k = 0n; k < inboxCount; k++) inbox.push(l.inbox.member(k) ? hex(l.inbox.lookup(k)) : null);
  const unshielded = [...cs.balance.entries()]
    .filter(([t, v]) => t.tag === 'unshielded' && typeof t.raw === 'string' && v > 0n)
    .map(([t, v]) => ({ colour: (t as { raw: string }).raw.replace(/^0x/, '').toLowerCase(), amount: v.toString(10) }))
    .sort((a, b) => (a.colour < b.colour ? -1 : a.colour > b.colour ? 1 : 0));
  const credited = [...l.unshielded_balances]
    .map(([c, v]) => ({ colour: hex(c), amount: v.toString(10) }))
    .sort((a, b) => (a.colour < b.colour ? -1 : a.colour > b.colour ? 1 : 0));
  return {
    account: address,
    view: {
      account: address,
      booted: l.booted,
      deviceCount: Number(l.device_count),
      deviceEpoch: l.device_epoch.toString(10),
      devices: [...l.devices].map(hex).sort(),
      authNonce: l.auth_nonce.toString(10),
      inboxCount: inboxCount.toString(10),
      encKey: hex(l.enc_key),
      networkSalt: hex(l.evm_domain_salt),
    },
    operations,
    authority: { committee: ma.committee.length, threshold: Number(ma.threshold) },
    inbox,
    unshielded,
    credited,
    round: l.round.toString(10),
  };
}

/** A network's account salt: `keccak256("midnight:" ‖ networkId)` (the passport client's
 *  `evmDomainSaltFor`, which the relay deploys every market account with). 64 lowercase hex. */
export const networkSaltFor = (midnightNetworkId: string): string =>
  hex(keccak_256(new TextEncoder().encode(`midnight:${midnightNetworkId}`)));

// ── The market account check (audit C3) ────────────────────────────────────────────

export type AccountCheckCode =
  | 'not-booted'
  | 'verifier-keys'
  | 'authority-live'
  | 'devices'
  | 'enc-key'
  | 'network-salt'
  | 'not-fresh'
  /** AA 00047 P10 (R2-6): a just-opened account that is not empty (inbox, balances). */
  | 'not-empty'
  /** AA 00047 P11 (R3-1): a counter near its overflow, or a credited balance no holding backs. */
  | 'counters'
  /** AA 00047 P11 (R3-1): not created the way the market creates accounts (./account-provenance.ts). */
  | 'provenance'
  /** AA 00047 P11 (R3-10): the indexer does not show the account's deploy yet (temporary: retried,
   *  never kept). */
  | 'provenance-unknown';

export interface AccountCheckProblem {
  code: AccountCheckCode;
  /** For the customer, plain words. */
  message: string;
  /** For a report: which circuits, which values. */
  detail?: string;
}

export interface MarketAccountExpectation {
  /** This wallet's device key (its Solana public key), 64 hex. */
  deviceKey: string;
  /** The encryption PUBLIC key this browser holds for the account, 64 hex. */
  encPublicKey: string;
  /** This network's salt (`networkSaltFor`). */
  networkSalt: string;
  /** The verifier-key digests pinned in this build: circuit → SHA-256 (./pinned-account-keys.ts). */
  verifierKeys: Readonly<Record<string, string>>;
  /** Just registered: the device must be at its first entry (counter 0, epoch 0) and nothing may have
   *  been signed yet (auth nonce 0). That the account started EMPTY (AA 00047 P10, R2-6) is part of
   *  its origin (`checkMarketAccount`'s `origin`, judged on every check since P11). */
  fresh?: boolean;
  /** The use counter this browser last used (its roster), tried after the account's nonce. */
  counterHint?: bigint;
}

export interface AccountCheck {
  ok: boolean;
  problems: AccountCheckProblem[];
  /** This device's use counter on the account, when its entry is the account's one device. */
  useCounter: bigint | null;
}

/** How far the device check scans for this wallet's rolling entry when neither the account's auth
 *  nonce nor the browser's hint names it (each entry costs a hash in the contract runtime). A market
 *  account has ONE device since its activation, and every call it signs moves its counter and the
 *  account's nonce together, so its counter IS the nonce; the scan is only a fallback. */
export const DEVICE_SCAN_LIMIT = 256n;

/** The highest a 64-bit counter (`round`, the auth nonce, the inbox count) may be on any check: far
 *  above any real use (2^48 calls), far below the 2^64 where its checked increment fails and freezes
 *  the account (AA 00047 P11, R3-1). */
export const COUNTER_BOUND = 1n << 48n;
/** The highest the device epoch may be: nothing in the market's account ever moves it from 0. */
export const EPOCH_BOUND = 1n << 16n;

/** Compare the deployed operations with the pinned set: every pinned circuit present with the same
 *  digest, and nothing else. */
export function compareVerifierKeys(
  deployed: Readonly<Record<string, string>>,
  pinned: Readonly<Record<string, string>>,
): { equal: boolean; missing: string[]; different: string[]; extra: string[] } {
  const missing: string[] = [];
  const different: string[] = [];
  for (const [circuit, digest] of Object.entries(pinned)) {
    if (deployed[circuit] === undefined) missing.push(circuit);
    else if (deployed[circuit] !== digest.toLowerCase()) different.push(circuit);
  }
  const extra = Object.keys(deployed)
    .filter((c) => pinned[c] === undefined)
    .sort();
  return { equal: missing.length + different.length + extra.length === 0, missing, different, extra };
}

/**
 * Is this the account this site's market deploys, controlled by this wallet alone? Every rule is
 * checked (the page shows them all, not only the first that fails).
 *
 * `origin` is the verdict on the account's origin (./account-provenance.ts `checkAccountOrigin`, from
 * the indexer's deploy transaction and the actions before the retirement): its problems are the
 * account's. It also carries R2-6's "starts empty" rule, judged on the state the DEPLOY created (what
 * the deployer alone controlled; a deposit anyone made since changes nothing, questions Q42), and
 * never on the current state (R3-10). Without an origin it is not judged.
 */
export function checkMarketAccount(
  s: AccountChainState,
  e: MarketAccountExpectation,
  origin?: OriginVerdict,
): AccountCheck {
  const problems: AccountCheckProblem[] = [];
  const v = s.view;
  if (!v.booted) problems.push({ code: 'not-booted', message: 'It is not activated yet.' });

  const keys = compareVerifierKeys(s.operations, e.verifierKeys);
  if (!keys.equal) {
    const parts = [
      keys.different.length ? `different: ${keys.different.join(', ')}` : '',
      keys.missing.length ? `missing: ${keys.missing.join(', ')}` : '',
      keys.extra.length ? `extra: ${keys.extra.join(', ')}` : '',
    ].filter(Boolean);
    problems.push({
      code: 'verifier-keys',
      message: "Its contract is not the one this site's market deploys (its circuits or their keys differ).",
      detail: parts.join('; '),
    });
  }

  if (!(s.authority.committee === 0 && s.authority.threshold >= 1)) {
    problems.push({
      code: 'authority-live',
      message: 'Someone can still change its contract (its maintenance authority is not retired).',
      detail: `committee ${s.authority.committee}, threshold ${s.authority.threshold}`,
    });
  }

  const account = hexToBytes(s.account, 32);
  const epoch = BigInt(v.deviceEpoch);
  const device = ed25519DeviceForKey(e.deviceKey);
  const entryAt = (k: bigint) => bytesToHex(device.entryAt(account, epoch, k));
  let useCounter: bigint | null = null;
  if (v.deviceCount !== 1 || v.devices.length !== 1) {
    problems.push({
      code: 'devices',
      message:
        v.deviceCount === 0
          ? 'It has no device yet.'
          : `It has ${v.deviceCount} devices; a Night Market account has exactly one, your wallet.`,
      detail: `deviceCount ${v.deviceCount}, entries ${v.devices.length}`,
    });
  } else {
    useCounter = e.fresh
      ? entryAt(0n) === v.devices[0]!.toLowerCase()
        ? 0n
        : null
      : ([BigInt(v.authNonce), ...(e.counterHint !== undefined ? [e.counterHint] : [])].find(
          (k) => entryAt(k) === v.devices[0]!.toLowerCase(),
        ) ?? findUseCounter(v.devices, entryAt, 0n, DEVICE_SCAN_LIMIT));
    if (useCounter === null)
      problems.push({
        code: 'devices',
        message: 'Its one device is not your wallet.',
        detail: `entry ${v.devices[0]}`,
      });
  }

  if (normaliseHex32(v.encKey) !== normaliseHex32(e.encPublicKey))
    problems.push({
      code: 'enc-key',
      message: 'Its encryption key is not the one this browser holds, so notes sealed to it would not be yours.',
      detail: `on chain ${v.encKey}`,
    });
  if (normaliseHex32(v.networkSalt) !== normaliseHex32(e.networkSalt))
    problems.push({
      code: 'network-salt',
      message: 'It is set up for another network.',
      detail: `salt ${v.networkSalt}`,
    });
  if (e.fresh && (BigInt(v.authNonce) !== 0n || epoch !== 0n))
    problems.push({
      code: 'not-fresh',
      message: 'It has already been used, although it was just opened.',
      detail: `auth nonce ${v.authNonce}, device epoch ${v.deviceEpoch}`,
    });
  // R3-1, on EVERY check: no counter near its overflow (a checked `+ 1` past 2^64 - 1 fails every
  // call, withdrawals included), and every credited unshielded balance backed by the contract's real
  // holding of that token (the contract keeps the two equal; a credit near 2^128 overflows deposits).
  const high: string[] = [];
  const counters: Array<[string, string, bigint]> = [
    ['round', s.round, COUNTER_BOUND],
    ['auth nonce', v.authNonce, COUNTER_BOUND],
    ['inbox count', v.inboxCount, COUNTER_BOUND],
    ['device epoch', v.deviceEpoch, EPOCH_BOUND],
  ];
  for (const [name, value, bound] of counters) {
    let n: bigint;
    try {
      n = BigInt(value);
    } catch {
      n = bound;
    }
    if (n < 0n || n >= bound) high.push(`${name} ${value}`);
  }
  if (high.length > 0)
    problems.push({
      code: 'counters',
      message: 'Its counters are set so high that it would stop working after a few actions, freezing your tokens.',
      detail: high.join(', '),
    });
  const holding = new Map(s.unshielded.map((u) => [u.colour.toLowerCase(), BigInt(u.amount)]));
  const unbacked = s.credited.filter((c) => BigInt(c.amount) > (holding.get(c.colour.toLowerCase()) ?? 0n));
  if (unbacked.length > 0)
    problems.push({
      code: 'counters',
      message: 'It records more public tokens than it holds, which would make deposits of them fail.',
      detail: unbacked.map((c) => `${c.colour}: credited ${c.amount}, held ${holding.get(c.colour) ?? 0n}`).join('; '),
    });

  // R3-1 / R3-10: where the account came from (including R2-6's "starts empty", as deployed).
  if (origin) problems.push(...origin.problems);

  return { ok: problems.length === 0, problems, useCounter: problems.length === 0 ? useCounter : null };
}

/** One line for a page or an error: what is wrong with the account. */
export function accountCheckText(c: AccountCheck): string {
  return c.problems.map((p) => p.message).join(' ');
}
