// AA 00062 P4.1 (spec FR-008, FR-012; owner Q3: "No backup, it's per browser"): the customer's prover
// setting. It lives in THIS browser only, beside the market's other local data, as the browser-wide
// record `night-market/v1/_global/settings/prover`:
//   - it is listed in Local Data's table, and CLEAR ALL removes it with everything else;
//   - it is NOT one of the records an Export carries (`CARRIED_GLOBAL_KEYS` holds only the asset
//     filter), and Import refuses it, so the backup file never holds it;
//   - every read and write is guarded: a browser that keeps no data (private mode, a full storage, a
//     store from a newer version) keeps the setting in memory for this page only, and says so.

import { z } from 'zod';

import { recordKey } from '../store/schema.js';
import type { LocalStore } from '../store/store.js';
import { checkProverUrl } from './url.js';

export const PROVER_SETTING_ID = 'prover';
export const PROVER_SETTING_KEY = recordKey('global', 'settings', { id: PROVER_SETTING_ID });

/** The last Test, as kept with the URL (spec Key Entities: "its last Test result (version,
 *  fingerprint, time)"). */
export const ProverLastTestSchema = z
  .object({
    ok: z.boolean(),
    /** Unix ms. */
    at: z.number().int().nonnegative(),
    /** What the package reported, when it answered. */
    package: z.string().max(64).nullable(),
    proofServer: z.string().max(64).nullable(),
    keySet: z.string().max(80).nullable(),
    /** The failure, in the customer's words (null on a pass). */
    problem: z.string().max(600).nullable(),
  })
  .strict();
export type ProverLastTest = z.infer<typeof ProverLastTestSchema>;

export const ProverSettingSchema = z
  .object({
    url: z.string().max(512),
    /** The customer confirmed the privacy warning for THIS url (a non-localhost prover). */
    privacyConfirmed: z.boolean(),
    lastTest: ProverLastTestSchema.nullable(),
  })
  .strict();
export type ProverSetting = z.infer<typeof ProverSettingSchema>;

type SettingStore = Pick<LocalStore, 'get' | 'put' | 'remove' | 'readOnly'>;

/** Where the setting lives: the browser store when it can keep data, else this page's memory. */
export class ProverSettings {
  private memory: ProverSetting | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly store: SettingStore | null) {}

  /** True when the setting outlives this page (the browser keeps the market's data). */
  get persistent(): boolean {
    return !!this.store && !this.store.readOnly;
  }

  read(): ProverSetting | null {
    if (this.memory) return this.memory;
    if (!this.store) return null;
    try {
      const parsed = ProverSettingSchema.safeParse(this.store.get(PROVER_SETTING_KEY)?.data);
      if (!parsed.success) return null;
      // A stored URL the rules no longer accept (or a hand-edited one) is ignored.
      return checkProverUrl(parsed.data.url).ok ? parsed.data : null;
    } catch {
      return null;
    }
  }

  /** Save the setting; false when it could only be kept in memory for this page. */
  write(setting: ProverSetting): boolean {
    const s = ProverSettingSchema.parse(setting);
    let saved = false;
    if (this.store && !this.store.readOnly) {
      try {
        this.store.put('global', 'settings', s, { id: PROVER_SETTING_ID });
        saved = true;
      } catch {
        saved = false; // a full storage: this page only
      }
    }
    this.memory = saved ? null : s;
    this.emit();
    return saved;
  }

  /** Forget the setting in this browser (spec US2 scenario 2). */
  forget(): void {
    this.memory = null;
    if (this.store && !this.store.readOnly) {
      try {
        if (this.store.get(PROVER_SETTING_KEY) !== null) this.store.remove(PROVER_SETTING_KEY);
      } catch {
        /* nothing more this page can do */
      }
    }
    this.emit();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit() {
    for (const l of [...this.listeners]) l();
  }
}
