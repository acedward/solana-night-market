// A Night Market account's ON-CHAIN state, as the public indexer serves it (`contract { state }`: the
// ledger's serialised ContractState), built in the test process (AA 00047 P9.S): for the browser
// chain reader's unit tests and the Playwright mock indexer (test/e2e/mock-indexer.ts).
//
// It is the real thing, not a look-alike: the compiled account's own constructor builds the ledger
// (compact-runtime 0.20, the light compile), the fields a test sets are written into the same cells
// the generated `ledger()` reads (and read back through it: a layout change fails here, loudly), the
// operations carry the REAL verifier keys of the pinned key set (test/fixtures/account-verifier-keys.json,
// public chain data written by scripts/pin-account-keys.ts), and the bytes are `ContractState.serialize()`.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import {
  ChargedState,
  CompactTypeBoolean,
  CompactTypeBytes,
  CompactTypeUnsignedInteger,
  ContractMaintenanceAuthority,
  ContractOperation,
  ContractState,
  StateMap,
  StateValue,
  createConstructorContext,
  sampleSigningKey,
  signatureVerifyingKey,
  type AlignedValue,
} from '@midnight-ntwrk/compact-runtime-0.20';

import { Contract, ledger } from '../../../../vendor/passport/contract/src/wallet/contract.js';
import { bytesToHex, hexToBytes } from '../../src/hex.js';
import { ed25519DeviceForKey } from '../../src/passport/ed25519.js';

/** The pinned key set's verifier keys (hex), by circuit. */
export const FIXTURE_VERIFIER_KEYS: Readonly<Record<string, string>> = (
  JSON.parse(
    readFileSync(new URL('../../../../test/fixtures/account-verifier-keys.json', import.meta.url), 'utf8'),
  ) as { circuits: Record<string, string> }
).circuits;

export interface AccountStateSpec {
  /** The contract address (64 hex). */
  account: string;
  /** The device: its key's rolling entry at (`deviceEpoch`, `useCounter`) is the account's device. */
  deviceKey: string;
  encKey: string;
  /** The account's network salt (64 hex). */
  salt: string;
  booted?: boolean;
  authNonce?: bigint;
  useCounter?: bigint;
  deviceEpoch?: bigint;
  /** More device entries (64 hex each): a second device. */
  extraDevices?: readonly string[];
  /** Leave the device set empty (an account not activated). */
  noDevice?: boolean;
  /** Inbox entries (192-byte hex each), from index 0. */
  inbox?: readonly string[];
  /** Public balances: colour (64 hex) → base units. */
  unshielded?: ReadonlyArray<readonly [string, bigint]>;
  /** The operations and their verifier keys (hex); default: the pinned key set's. */
  operations?: Readonly<Record<string, string>>;
  /** The maintenance authority; default retired (no committee, threshold 1). */
  authority?: { committee: number; threshold: number };
}

const witnesses = new Proxy(
  {},
  {
    get: () => () => {
      throw new Error('no witness in a constructor');
    },
  },
);
const COIN_PK = '11'.repeat(32);
const det = (label: string) => new Uint8Array(createHash('sha256').update(`aa00047 p9s state ${label}`).digest());

const uintLike = (cell: AlignedValue, value: bigint): AlignedValue => {
  const atom = cell.alignment[0] as unknown as { tag: string; value: { tag: string; length: number } };
  const len = atom.value.length;
  const t = new CompactTypeUnsignedInteger((1n << BigInt(8 * len)) - 1n, len);
  return { value: t.toValue(value), alignment: cell.alignment };
};
const bytes32 = new CompactTypeBytes(32);
const bytes192 = new CompactTypeBytes(192);
const u64 = new CompactTypeUnsignedInteger((1n << 64n) - 1n, 8);
const aligned = <T>(t: { toValue(v: T): AlignedValue['value']; alignment(): AlignedValue['alignment'] }, v: T) => ({
  value: t.toValue(v),
  alignment: t.alignment(),
});

/** The account's state, as ContractState. */
export async function accountContractState(spec: AccountStateSpec): Promise<ContractState> {
  const contract = new Contract(witnesses as never);
  const init = await (
    contract as unknown as {
      initialState(ctx: unknown, ...args: unknown[]): Promise<{ currentContractState: ContractState }>;
    }
  ).initialState(
    createConstructorContext({}, COIN_PK),
    det('boot'),
    hexToBytes(spec.encKey, 32),
    hexToBytes(spec.salt, 32),
    { bytes: new Uint8Array(32) },
    { bytes: new Uint8Array(32) },
  );
  const base = init.currentContractState.data.state.asArray()!;
  const cells = [...base];
  const set = (i: number, v: StateValue) => {
    cells[i] = v;
  };
  const epoch = spec.deviceEpoch ?? 0n;
  const counter = spec.useCounter ?? 0n;
  const account = hexToBytes(spec.account, 32);
  const devices = spec.noDevice
    ? []
    : [bytesToHex(ed25519DeviceForKey(spec.deviceKey).entryAt(account, epoch, counter)), ...(spec.extraDevices ?? [])];
  const inbox = spec.inbox ?? [];

  // The ledger's cells (account.compact's `export ledger` order; ledger() reads them by index).
  let inboxMap = new StateMap();
  inbox.forEach((e, k) => {
    inboxMap = inboxMap.insert(aligned(u64, BigInt(k)), StateValue.newCell(aligned(bytes192, hexToBytes(e, 192))));
  });
  set(2, StateValue.newMap(inboxMap));
  set(3, StateValue.newCell(uintLike(base[3]!.asCell(), BigInt(inbox.length))));
  let deviceMap = new StateMap();
  for (const d of devices) deviceMap = deviceMap.insert(aligned(bytes32, hexToBytes(d, 32)), StateValue.newNull());
  set(6, StateValue.newMap(deviceMap));
  set(7, StateValue.newCell(uintLike(base[7]!.asCell(), epoch)));
  set(8, StateValue.newCell(uintLike(base[8]!.asCell(), BigInt(devices.length))));
  set(9, StateValue.newCell(uintLike(base[9]!.asCell(), spec.authNonce ?? 0n)));
  set(11, StateValue.newCell(aligned(CompactTypeBoolean, spec.booted ?? !spec.noDevice)));
  let data = StateValue.newArray();
  for (const c of cells) data = data.arrayPush(c);

  const cs = new ContractState();
  cs.data = new ChargedState(data);
  for (const [name, vk] of Object.entries(spec.operations ?? FIXTURE_VERIFIER_KEYS)) {
    const op = new ContractOperation();
    op.verifierKey = hexToBytes(vk);
    cs.setOperation(name, op);
  }
  const a = spec.authority ?? { committee: 0, threshold: 1 };
  cs.maintenanceAuthority = new ContractMaintenanceAuthority(
    Array.from({ length: a.committee }, () => signatureVerifyingKey(sampleSigningKey())),
    a.threshold,
    1n,
  );
  cs.balance = new Map((spec.unshielded ?? []).map(([colour, v]) => [{ tag: 'unshielded', raw: colour }, v]));

  // Read it back through the compiled account's own ledger(): the layout above must be the module's.
  const l = ledger(cs.data);
  const back = {
    booted: l.booted,
    auth_nonce: l.auth_nonce,
    device_count: l.device_count,
    device_epoch: l.device_epoch,
    inbox_count: l.inbox_count,
    enc_key: bytesToHex(l.enc_key),
    salt: bytesToHex(l.evm_domain_salt),
    devices: [...l.devices].map((d) => bytesToHex(d)).sort(),
  };
  const want = {
    booted: spec.booted ?? !spec.noDevice,
    auth_nonce: spec.authNonce ?? 0n,
    device_count: BigInt(devices.length),
    device_epoch: epoch,
    inbox_count: BigInt(inbox.length),
    enc_key: spec.encKey.toLowerCase(),
    salt: spec.salt.toLowerCase(),
    devices: [...devices].map((d) => d.toLowerCase()).sort(),
  };
  if (
    JSON.stringify(back, (_, v) => (typeof v === 'bigint' ? v.toString() : v)) !==
    JSON.stringify(want, (_, v) => (typeof v === 'bigint' ? v.toString() : v))
  )
    throw new Error('account-state fixture: the ledger layout changed (ledger() does not read back what was written)');
  for (const [k, e] of inbox.entries())
    if (bytesToHex(l.inbox.lookup(BigInt(k))) !== e.toLowerCase())
      throw new Error('account-state fixture: the inbox layout changed');
  return cs;
}

/** The account's state as the indexer serves it: the serialised ContractState, hex. */
export async function accountStateHex(spec: AccountStateSpec): Promise<string> {
  return bytesToHex((await accountContractState(spec)).serialize());
}
