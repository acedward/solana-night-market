// The relay's /health as the error walkthroughs serve it (plan P4-A): healthy by default, with the
// one field each walkthrough breaks.

export function healthBody(
  opts: {
    dustLow?: boolean;
    syncing?: boolean;
    proverDown?: boolean;
    batcherDown?: boolean;
    batcherRefusal?: number;
  } = {},
) {
  const now = Math.floor(Date.now() / 1000);
  return {
    status: opts.proverDown ? 'down' : opts.dustLow || opts.batcherDown ? 'degraded' : 'ok',
    network: 'stagenet',
    version: 'e2e',
    uptimeSeconds: 60,
    sponsor: {
      configured: true,
      state: opts.syncing ? 'syncing' : 'synced',
      synced: !opts.syncing,
      dustSpecks: opts.dustLow ? '3000000000000000' : '50000000000000000000',
      dustLow: !!opts.dustLow,
    },
    proofServer: {
      reachable: !opts.proverDown,
      version: '9.0.0-rc.8',
      jobCapacity: 10,
      keys: { present: true, fingerprint: 'f'.repeat(64), pinned: true, matchesPin: true, complete: true, problems: 0 },
    },
    queue: { jobs: 0, lanes: {} },
    kernel: { reachable: true, synced: true },
    batcher: {
      reachable: !opts.batcherDown,
      lastRefusal: opts.batcherRefusal ? { httpStatus: opts.batcherRefusal, at: now - 30 } : null,
    },
  };
}
