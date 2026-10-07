// AA 00062 P4.2 / P4.3 (spec US1, FR-009, FR-010; plan I-62a, I-62b): the page's client prover.
//
//   ensure(circuit)  BEFORE anything is signed or sent for a k>=18 action: when the market requires
//                    client proving for that circuit, the saved prover is tested again (a pass of the
//                    last minute is reused); without a passing one the popup opens, and the action
//                    goes on only after its Continue (closing it stops the action, nothing signed).
//   handOff(job)     while the market waits for the proof (I-62a v2: the job is parked, holding nothing):
//                    fetch the proof request, prove it on the customer's prover (I-62b), post the proof
//                    back. A prover that fails while there is time left reopens the popup, so the
//                    customer can fix it and go on.
//   test(url)        the Test (FR-010): reachable, the proof-server version, the key set and the
//                    circuits, each in plain words; the result is kept with the URL (FR-012).
//
// Nothing here talks to the market except through the RelayClient it is given; only this file and
// ./package-client.ts call the customer's URL (FR-003).

import type { RelayClient } from '../relay/client.js';
import { RelayError } from '../relay/client.js';
import {
  CLIENT_CIRCUITS,
  PINNED_KEY_SET,
  PINNED_PROOF_SERVER,
  PROVER_MEMORY_GB,
  RECENT_PASS_MS,
  type ClientCircuit,
} from './constants.js';
import { CLIENT_PROVING_OFF, type ClientProvingConfig, type HandOffJobView } from './i62a.js';
import { ProverError, proverProblemText, shortKeySet, type ProverProblemCode } from './messages.js';
import { fetchPackageVersion, proveOnPackage, type PackageDeps, type PackageVersion } from './package-client.js';
import type { ProverSettings } from './settings.js';
import { checkProverUrl } from './url.js';

/** What the customer's prover must be: the market's pins and the circuits it must hold. */
export interface ProverExpectation {
  proofServer: string;
  keySet: string;
  circuits: readonly string[];
}

/** The pins of this build, with all four circuits (a market that proves everything itself). */
export const PINNED_EXPECTATION: ProverExpectation = {
  proofServer: PINNED_PROOF_SERVER,
  keySet: PINNED_KEY_SET,
  circuits: CLIENT_CIRCUITS,
};

export function expectationOf(config: ClientProvingConfig): ProverExpectation {
  return config.mode === 'required'
    ? { proofServer: config.proofServer, keySet: config.keySet, circuits: config.circuits }
    : PINNED_EXPECTATION;
}

export type TestLineId = 'reach' | 'version' | 'key-set' | 'circuits' | 'machine' | 'busy';

export interface TestLine {
  id: TestLineId;
  /** true: as needed; false: the reason it fails; null: for information. */
  ok: boolean | null;
  text: string;
}

export interface TestOutcome {
  ok: boolean;
  url: string;
  /** Unix ms. */
  at: number;
  lines: TestLine[];
  problem: { code: ProverProblemCode; text: string } | null;
  version: PackageVersion | null;
}

/**
 * The Test (spec FR-010): call `/version` and compare it with what the market needs. `circuit` is the
 * action's (the popup); without it every expected circuit must be there (Local Data).
 */
export async function testProver(
  url: string,
  expected: ProverExpectation,
  deps: PackageDeps,
  circuit?: ClientCircuit,
): Promise<TestOutcome> {
  const at = deps.now();
  const v = await fetchPackageVersion(url, deps);
  if (!v.ok) {
    const text = proverProblemText(v.code, { url, ...(v.detail ? { detail: v.detail } : {}), brave: deps.brave });
    return {
      ok: false,
      url,
      at,
      lines: [{ id: 'reach', ok: false, text }],
      problem: { code: v.code, text },
      version: null,
    };
  }
  const ver = v.version;
  const lines: TestLine[] = [{ id: 'reach', ok: true, text: `Your proof server answered (package ${ver.package}).` }];
  const problems: Array<{ code: ProverProblemCode; text: string }> = [];
  const fail = (code: ProverProblemCode, detail: string) => {
    const text = proverProblemText(code, { url, detail, expected });
    problems.push({ code, text });
    return text;
  };
  const versionOk = ver.proofServer === expected.proofServer;
  lines.push({
    id: 'version',
    ok: versionOk,
    text: versionOk
      ? `Proof server ${ver.proofServer}: the version the market uses.`
      : fail('wrong-version', `proof server ${ver.proofServer}`),
  });
  const keysOk = ver.keySet === expected.keySet;
  lines.push({
    id: 'key-set',
    ok: keysOk,
    text: keysOk
      ? `Key set ${shortKeySet(ver.keySet)}: the market's key set.`
      : fail('wrong-key-set', `key set ${shortKeySet(ver.keySet)}`),
  });
  const needed = circuit ? [circuit] : expected.circuits;
  const missing = needed.filter((c) => !ver.circuits.includes(c));
  lines.push({
    id: 'circuits',
    ok: missing.length === 0,
    text:
      missing.length === 0
        ? circuit
          ? 'It holds the circuit this action needs.'
          : `It holds the ${needed.length} circuits the market hands to your prover.`
        : fail('missing-circuit', missing.join(', ')),
  });
  const mem = ver.machine?.memoryBytes ?? null;
  const cpus = ver.machine?.cpus ?? null;
  if (mem !== null || cpus !== null) {
    const gb = mem !== null ? mem / 1024 ** 3 : null;
    const low = gb !== null && gb < PROVER_MEMORY_GB - 0.5;
    const parts = [cpus !== null ? `${cpus} CPUs` : null, gb !== null ? `${gb.toFixed(1)} GB of memory` : null]
      .filter(Boolean)
      .join(' and ');
    lines.push({
      id: 'machine',
      ok: low ? false : null,
      text: low
        ? `It has ${parts}: a proof needs about ${PROVER_MEMORY_GB} GB, so it may run out of memory. Give Docker more memory if you can.`
        : `It has ${parts}.`,
    });
  }
  if (ver.busy) lines.push({ id: 'busy', ok: null, text: 'It is working on another proof right now.' });
  return { ok: problems.length === 0, url, at, lines, problem: problems[0] ?? null, version: ver };
}

/** Why the popup opens, and for which action. */
export interface PopupRequest {
  circuit: ClientCircuit;
  expected: ProverExpectation;
  /** 'start': before anything is signed; 'handoff': the market waits for a proof this page has no
   *  prover for; 'retry': the prover failed while the market still waits. */
  reason: 'start' | 'handoff' | 'retry';
  /** What went wrong with the saved (or just used) prover, in the customer's words. */
  failure: string | null;
  /** The hand-off's deadline (unix ms), when the market already waits. */
  deadlineMs: number | null;
}
/** The popup's answer: the URL that passed its Test (Continue), or null (closed). */
export type PopupAnswer = { url: string } | null;

/** What the customer's prover is doing for the action in progress. */
export interface ClientProofProgress {
  /** Unix ms: when this page started asking its prover. */
  startedAt: number;
  url: string;
  state: 'proving' | 'waiting' | 'sending';
  /** While waiting: why, and for how long. */
  wait?: { code: 'busy' | 'starting'; seconds: number };
  attempt: number;
}

/** The hooks an action's operations call (`OperationEnv.prover`). */
export interface ClientProverHooks {
  ensure(circuit: ClientCircuit): Promise<void>;
  handOff(relay: HandOffRelay, job: HandOffJobView): Promise<void>;
}

export type HandOffRelay = Pick<RelayClient, 'clientProofRequest' | 'postClientProof'>;

export interface ClientProverDeps {
  relay: Pick<RelayClient, 'clientProving'>;
  settings: ProverSettings;
  pkg: PackageDeps;
  popup: (req: PopupRequest) => Promise<PopupAnswer>;
  progress?: (p: ClientProofProgress | null) => void;
}

const CONFIG_CACHE_MS = 30_000;
/** Less time than this before the deadline: a failing prover ends the action instead of the popup. */
const RETRY_MIN_MS = 45_000;

export class ClientProver implements ClientProverHooks {
  private cached: { at: number; config: ClientProvingConfig } | null = null;
  private recentPass: { url: string; at: number; version: PackageVersion } | null = null;
  private popups: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: ClientProverDeps) {}

  /** The market's client-proving mode, read at most every 30 s; a relay that cannot be read counts
   *  as "off" (not kept): the hand-off still reaches this page if the market waits for a proof. */
  async config(): Promise<ClientProvingConfig> {
    const now = this.deps.pkg.now();
    if (this.cached && now - this.cached.at < CONFIG_CACHE_MS) return this.cached.config;
    try {
      const config = await this.deps.relay.clientProving();
      this.cached = { at: now, config };
      return config;
    } catch {
      return CLIENT_PROVING_OFF;
    }
  }

  /** What the customer's prover must be, for this market (Local Data's Test). */
  async expectation(): Promise<ProverExpectation> {
    return expectationOf(await this.config());
  }

  /** Test `url` and keep the result with it in this browser (FR-012). */
  async test(
    url: string,
    expected: ProverExpectation,
    opts: { circuit?: ClientCircuit; privacyConfirmed?: boolean } = {},
  ): Promise<TestOutcome> {
    const outcome = await testProver(url, expected, this.deps.pkg, opts.circuit);
    const saved = this.deps.settings.read();
    this.deps.settings.write({
      url,
      privacyConfirmed: opts.privacyConfirmed ?? (saved?.url === url ? saved.privacyConfirmed : false),
      lastTest: {
        ok: outcome.ok,
        at: outcome.at,
        package: outcome.version?.package ?? null,
        proofServer: outcome.version?.proofServer ?? null,
        keySet: outcome.version?.keySet ?? null,
        problem: outcome.problem?.text.slice(0, 600) ?? null,
      },
    });
    this.recentPass = outcome.ok && outcome.version ? { url, at: outcome.at, version: outcome.version } : null;
    return outcome;
  }

  async ensure(circuit: ClientCircuit): Promise<void> {
    const config = await this.config();
    if (config.mode !== 'required' || !config.circuits.includes(circuit)) return;
    await this.proverFor(circuit, expectationOf(config), { reason: 'start', deadlineMs: null, failure: null });
  }

  /** A prover that passes for `circuit`: the saved one, tested again, or the popup's. */
  private async proverFor(
    circuit: ClientCircuit,
    expected: ProverExpectation,
    ctx: Pick<PopupRequest, 'reason' | 'deadlineMs' | 'failure'>,
  ): Promise<string> {
    let failure = ctx.failure;
    if (failure === null) {
      const saved = this.deps.settings.read();
      const usable = saved && (checkProverUrl(saved.url).ok ? checkLocal(saved.url) || saved.privacyConfirmed : false);
      if (saved && usable) {
        if (this.passedRecently(saved.url, expected, circuit)) return saved.url;
        const r = await this.test(saved.url, expected, { circuit });
        if (r.ok) return saved.url;
        failure = r.problem?.text ?? null;
      }
    }
    const answer = await this.askPopup({ circuit, expected, reason: ctx.reason, failure, deadlineMs: ctx.deadlineMs });
    if (!answer) {
      throw new ProverError(
        'cancelled',
        ctx.reason === 'start'
          ? proverProblemText('cancelled')
          : 'You closed the proof-server window, so this action stops here: the market sends nothing and spends no fee. Try again once your proof server is ready.',
      );
    }
    return answer.url;
  }

  private passedRecently(url: string, expected: ProverExpectation, circuit: ClientCircuit): boolean {
    const p = this.recentPass;
    return (
      !!p &&
      p.url === url &&
      this.deps.pkg.now() - p.at < RECENT_PASS_MS &&
      p.version.proofServer === expected.proofServer &&
      p.version.keySet === expected.keySet &&
      p.version.circuits.includes(circuit)
    );
  }

  /** One popup at a time: a second request waits for the first to close. */
  private askPopup(req: PopupRequest): Promise<PopupAnswer> {
    const next = this.popups.then(() => this.deps.popup(req));
    this.popups = next.catch(() => undefined);
    return next;
  }

  async handOff(relay: HandOffRelay, job: HandOffJobView): Promise<void> {
    const req = await relay.clientProofRequest(job.requestId);
    if (!req) return; // answered already, or the market moved on
    const pkg = this.deps.pkg;
    const deadlineMs = req.deadline * 1000;
    const expected: ProverExpectation = { proofServer: req.proofServer, keySet: req.keySet, circuits: [req.circuit] };
    let url = await this.proverFor(req.circuit, expected, { reason: 'handoff', deadlineMs, failure: null });
    const report = (p: ClientProofProgress | null) => this.deps.progress?.(p);
    const startedAt = pkg.now();
    try {
      for (;;) {
        report({ startedAt, url, state: 'proving', attempt: req.attempt });
        let proof: string;
        try {
          const proved = await proveOnPackage(
            url,
            { circuit: req.circuit, proofRequest: req.proofRequest, keyMaterialOffset: req.keyMaterialOffset },
            deadlineMs,
            pkg,
            (code, seconds) =>
              report({ startedAt, url, state: 'waiting', wait: { code, seconds }, attempt: req.attempt }),
          );
          proof = proved.proof;
        } catch (e) {
          const retryable = e instanceof ProverError && e.code !== 'late' && e.code !== 'invalid';
          if (!retryable || deadlineMs - pkg.now() < RETRY_MIN_MS) throw e;
          this.recentPass = null;
          report(null);
          url = await this.proverFor(req.circuit, expected, { reason: 'retry', deadlineMs, failure: e.message });
          continue;
        }
        report({ startedAt, url, state: 'sending', attempt: req.attempt });
        try {
          await relay.postClientProof(job.requestId, { proofId: req.proofId, proof });
        } catch (e) {
          if (e instanceof RelayError) {
            if (e.code === 'client-proof-invalid') throw new ProverError('invalid', proverProblemText('invalid'));
            if (e.code === 'client-proof-late') throw new ProverError('late', proverProblemText('late'));
            // Another tab, or an older attempt: the market has what it needs or moved on. AA 00062 (I-62a
            // v2): a stale call (the account moved while the prover proved) ends the job `client-proof-stale`;
            // the operation sends the same signed request again once (passport/operations.ts `submitAndWait`).
            if (
              [
                'client-proof-wrong-id',
                'client-proof-already-received',
                'not-awaiting-client-proof',
                'client-proof-stale',
              ].includes(e.code)
            )
              return;
          }
          throw e;
        }
        return;
      }
    } finally {
      report(null);
    }
  }
}

const checkLocal = (url: string) => {
  const c = checkProverUrl(url);
  return c.ok && c.local;
};

/** "Proving on your prover…": the customer's prover's progress, in plain words (spec US1 scenario 3). */
export function progressWords(p: ClientProofProgress): string {
  if (p.state === 'sending') return 'Sending your proof to the market';
  if (p.state === 'waiting' && p.wait)
    return p.wait.code === 'busy'
      ? `Your prover is busy with another proof: trying again in ${p.wait.seconds} s`
      : `Your prover is starting: trying again in ${p.wait.seconds} s`;
  return 'Proving on your prover…';
}

/** "m:ss" for an elapsed time in seconds. */
export function elapsedClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
