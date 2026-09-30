// GET /health: the sponsor's DUST, the proof server and its keys, the queue, and the kernel and
// batcher; also whether the key volume holds every circuit the relay proves, and the batcher's
// last refusal of a take. Public data only: no URL, no seed, no key. External probes are cached for a few seconds so /health cannot be used to flood
// the services behind it (security review F-B1): ONE refresh runs at a time and every concurrent
// request shares it; while it runs, a recent cached report is served; the key-volume check is
// cached separately (./prover/keys.ts `cachedKeyCheck`), and app.ts rate-limits the route.

import type { HealthResponse } from '@nightmarket/core';

import type { Logger } from './log.js';
import type { ProofServerClient } from './prover/client.js';
import { keyVolumeComplete, type KeyCheck } from './prover/keys.js';
import type { JobQueue } from './queue/jobs.js';
import type { SponsorSession } from './sponsor/session.js';

export interface ExternalProbes {
  kernel(): Promise<{ reachable: boolean; synced: boolean | null }>;
  batcher(): Promise<{ reachable: boolean }>;
}

const withTimeout = (ms: number) => AbortSignal.timeout(ms);

/** HTTP probes of the kernel and the batcher. */
export function httpProbes(opts: {
  kernelUrl: string;
  batcherUrl: string;
  fetchImpl?: typeof fetch;
  log: Logger;
  timeoutMs?: number;
}): ExternalProbes {
  const f = opts.fetchImpl ?? fetch;
  const t = opts.timeoutMs ?? 5_000;
  return {
    async kernel() {
      try {
        const r = await f(new URL('/v1/health', opts.kernelUrl), { signal: withTimeout(t) });
        if (!r.ok) return { reachable: false, synced: null };
        const body = (await r.json().catch(() => ({}))) as { synced?: unknown };
        return { reachable: true, synced: typeof body.synced === 'boolean' ? body.synced : null };
      } catch {
        return { reachable: false, synced: null };
      }
    },
    async batcher() {
      try {
        const r = await f(new URL('/health', opts.batcherUrl), { signal: withTimeout(t) });
        return { reachable: r.ok };
      } catch {
        return { reachable: false };
      }
    },
  };
}

export interface HealthDeps {
  network: string;
  version: string;
  startedAt: number;
  sponsor: SponsorSession;
  dustLowSpecks: bigint;
  prover: ProofServerClient;
  keys: () => KeyCheck;
  queue: JobQueue;
  probes: ExternalProbes;
  cacheSeconds: number;
  /** How old a cached report may be and still be served while a refresh runs (default: four cache
   *  periods, at least 60 s). Older than that, callers wait for the one shared refresh. */
  maxStaleSeconds?: number;
  /** The batcher's last refusal of a take (plan P4-A), or null. */
  batcherRefusal?: () => { httpStatus: number; at: number } | null;
  now?: () => number;
}

export function healthCollector(deps: HealthDeps): () => Promise<HealthResponse> {
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const maxStale = deps.maxStaleSeconds ?? Math.max(60, 4 * deps.cacheSeconds);
  type External = Awaited<ReturnType<typeof probeAll>>;
  let cached: { at: number; external: External } | null = null;
  let refreshing: Promise<{ at: number; external: External }> | null = null;
  const probeAll = async () => {
    const [proof, kernel, batcher] = await Promise.all([
      deps.prover.probe(),
      deps.probes.kernel(),
      deps.probes.batcher(),
    ]);
    return { proof, kernel, batcher, keys: deps.keys() };
  };
  /** The one refresh in flight: started by the first caller that finds the cache expired. */
  const refresh = () => {
    refreshing ??= probeAll()
      .then((external) => (cached = { at: now(), external }))
      .finally(() => {
        refreshing = null;
      });
    return refreshing;
  };
  const current = async (): Promise<External> => {
    const age = cached ? now() - cached.at : Infinity;
    if (cached && age < deps.cacheSeconds) return cached.external;
    const pending = refresh();
    // A recent report is served at once while the refresh runs; an old one (or none) waits for it.
    if (cached && age < maxStale) {
      pending.catch(() => {});
      return cached.external;
    }
    return (await pending).external;
  };
  return async () => {
    const { proof, kernel, batcher, keys } = await current();
    const sponsor = deps.sponsor.status();
    const dustLow = sponsor.dustSpecks === null ? sponsor.configured : sponsor.dustSpecks < deps.dustLowSpecks;
    const stats = deps.queue.stats();
    const keysOk = keyVolumeComplete(keys);
    const keyProblems =
      keys.missingVerifierKeys.length +
      keys.missingProverKeys.filter((k) => !keys.missingVerifierKeys.includes(k)).length +
      keys.missingZkir.filter((k) => !keys.missingVerifierKeys.includes(k)).length +
      keys.mismatchedVerifierKeys.length;
    const down = !proof.reachable || sponsor.state === 'error' || keys.matchesPin === false;
    const degraded =
      !sponsor.synced ||
      dustLow ||
      !kernel.reachable ||
      !batcher.reachable ||
      !keysOk ||
      proof.versionMatches === false;
    return {
      status: down ? 'down' : degraded ? 'degraded' : 'ok',
      network: deps.network,
      version: deps.version,
      uptimeSeconds: Math.max(0, now() - deps.startedAt),
      sponsor: {
        configured: sponsor.configured,
        state: sponsor.state,
        synced: sponsor.synced,
        dustSpecks: sponsor.dustSpecks === null ? null : sponsor.dustSpecks.toString(10),
        dustLow,
      },
      proofServer: {
        reachable: proof.reachable,
        version: proof.version,
        jobCapacity: proof.jobCapacity,
        keys: {
          present: keys.present,
          fingerprint: keys.fingerprint,
          pinned: keys.pinned,
          matchesPin: keys.matchesPin,
          complete: keysOk,
          problems: keyProblems,
        },
      },
      queue: { jobs: stats.jobs, lanes: stats.lanes },
      kernel,
      batcher: { ...batcher, lastRefusal: deps.batcherRefusal?.() ?? null },
    };
  };
}
