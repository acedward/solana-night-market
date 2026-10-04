// The relay's HTTP API (Hono). Routes:
//
//   GET  /health                        FR-013 health (200 ok/degraded, 503 down; rate-limited, F-B1)
//   GET  /v1/config                     public configuration
//   GET  /v1/auth/nonce                 a single-use nonce for a RelayAction authorisation
//   POST /v1/actions/:action            THE ONLY state-changing route: every action is authorised
//   GET  /v1/jobs/:requestId            resume a job by its request id
//   GET  /v1/queue                      queue depth per lane
//   GET  /v1/accounts/:account/state    public ledger reads (L-ACC)
//   GET  /v1/accounts/:account/inbox    public inbox ciphertexts (L-ACC)
//   GET  /v1/accounts/:account/zswap    the account's Zswap leaves (exact positions) and spends (L-ACC)
//   GET  /v1/accounts/:account/unshielded  the account's unshielded balances (B3, for B2's holdings)
//   GET  /v1/demo-tokens[?owner=<key>]  the demo-token pack, its limits, and whether a key claimed (B3)
//
// Request bodies are never logged. Errors are JSON: {"error": {"code", "message", "detail"?}}.

import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import {
  API_PATHS,
  ActionRequestSchema,
  RELAY_ACTIONS,
  type ActionRequest,
  type DemoTokensInfo,
  type HealthResponse,
  type NonceResponse,
  type PublicConfig,
  type RelayActionName,
  NOT_SUPPORTED_REASON,
  type RelayActionScheme,
  tokensDigest,
} from '@nightmarket/core';

import { AccountGate } from './actions/account-gate.js';
import type { AdmissionOutcome, JobEnd } from './actions/admission.js';
import type { ActionDefinition } from './actions/catalogue.js';
import {
  BUDGET_EXEMPT_ACTIONS,
  countsAgainstBudget,
  isInfrastructureFailure,
  type FailureBudget,
} from './actions/failure-budget.js';
import type { NonceStore } from './auth/nonces.js';
import { verifyRelayActionRequest, type VerifyOutcome } from './auth/verifiers.js';
import { AccountHistoryTooLongError } from './chain/indexer.js';
import { ChainReadNotImplementedError, type ChainReader } from './chain/reader.js';
import { clientKey } from './client-key.js';
import type { RelayConfig } from './config.js';
import type { Logger } from './log.js';
import { PublicError, type JobExecutor, type JobQueue } from './queue/jobs.js';
import { proverPriority } from './queue/priority.js';
import { RateLimiter } from './ratelimit.js';
import type { SponsorSession } from './sponsor/session.js';

export interface AppDeps {
  config: RelayConfig;
  version: string;
  log: Logger;
  nonces: NonceStore;
  queue: JobQueue;
  catalogue: ReadonlyMap<RelayActionName, ActionDefinition>;
  sponsor: SponsorSession;
  health: () => Promise<HealthResponse>;
  chain: ChainReader;
  /** The RelayAction envelope's signature scheme (the Solana wallet's, lane B3); absent until it is
   *  wired, and then every `relay-action` route answers `not-supported`. */
  scheme?: RelayActionScheme;
  /** Verifies a gated call's own Passport signature through the device arm (lane B3); absent until
   *  an arm is wired, and then every `passport-call` route answers `not-supported`. */
  passportCall?: (def: ActionDefinition, request: ActionRequest) => Promise<VerifyOutcome>;
  /** The demo-token pack and limits (GET /v1/demo-tokens, B3); absent: the endpoint is off. */
  demoTokens?: (owner?: string) => DemoTokensInfo;
  /** The failure budget per owner and per account (AA 00047 P9, audit C4: ./actions/failure-budget.ts);
   *  absent: none. */
  failures?: FailureBudget;
  /** One queued-or-running job per account (AA 00047 P10, R2-1: ./actions/account-gate.ts); default:
   *  a gate of `config.limits.jobsPerAccount`. */
  accountGate?: AccountGate;
  /** The caller's address for rate limiting (default: the socket's, or X-Forwarded-For's last hop).
   *  Every per-client cap keys it by `clientKey` (an IPv6 client by its /64: AA 00047 P10, R2-1/R2-8). */
  clientAddress?: (c: Context) => string;
  now?: () => number;
}

type ErrorStatus = 400 | 401 | 403 | 404 | 413 | 429 | 500 | 501 | 503;

const apiError = (c: Context, status: ErrorStatus, code: string, message: string, detail?: string) =>
  c.json({ error: { code, message, ...(detail ? { detail } : {}) } }, status);

function defaultClientAddress(trustProxy: boolean): (c: Context) => string {
  return (c) => {
    if (trustProxy) {
      const xff = c.req.header('x-forwarded-for');
      const last = xff
        ?.split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .pop();
      if (last) return last;
    }
    const server = c.env as { requestIP?: (r: Request) => { address: string } | null } | undefined;
    try {
      return server?.requestIP?.(c.req.raw)?.address ?? 'unknown';
    } catch {
      return 'unknown';
    }
  };
}

export function createApp(deps: AppDeps): Hono {
  const { config, log } = deps;
  const address = deps.clientAddress ?? defaultClientAddress(config.trustProxy);
  // Every per-client cap (rate limits, nonces, registration) keys an IPv6 client by its /64.
  const clientAddress = (c: Context) => clientKey(address(c), config.clientPrefixes);
  const limits = config.limits;
  const gate = deps.accountGate ?? new AccountGate(limits.jobsPerAccount);
  const readLimiter = new RateLimiter(limits.readsPerMinute);
  const healthLimiter = new RateLimiter(limits.healthPerMinute);
  const nonceLimiter = new RateLimiter(limits.noncesPerMinute);
  const actionLimiter = new RateLimiter(limits.actionsPerMinute);
  const ownerLimiter = new RateLimiter(limits.actionsPerOwnerPerMinute);
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));

  const app = new Hono();

  app.use('*', async (c, next) => {
    const t0 = performance.now();
    await next();
    log.info('http', {
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      ms: Math.round(performance.now() - t0),
    });
  });

  if (config.corsOrigins.length > 0) {
    app.use(
      '*',
      cors({
        origin: config.corsOrigins,
        allowMethods: ['GET', 'POST', 'OPTIONS'],
        allowHeaders: ['content-type'],
        maxAge: 600,
      }),
    );
  }

  const limited = (limiter: RateLimiter, key: string, c: Context) => {
    const r = limiter.take(key);
    if (r.ok) return null;
    c.header('Retry-After', String(r.retryAfterSeconds));
    return apiError(c, 429, 'rate-limited', 'too many requests; try again shortly');
  };

  // ── reads ──────────────────────────────────────────────────────────────────

  app.get(API_PATHS.health, async (c) => {
    // Its own bucket (security review F-B1), so a monitor is never starved by a customer's reads.
    const refused = limited(healthLimiter, clientAddress(c), c);
    if (refused) return refused;
    const h = await deps.health();
    return c.json(h, h.status === 'down' ? 503 : 200);
  });

  // AA 00060 P4.2 (spec FR-014): the token list's digest; the site disables signed actions while its own differs.
  const digest = tokensDigest(config.tokens);
  app.get(API_PATHS.config, (c) => {
    const body: PublicConfig = {
      network: config.network.name,
      relayVersion: deps.version,
      limits: {
        authMaxTtlSeconds: limits.authMaxTtlSeconds,
        jobTtlSeconds: limits.jobTtlSeconds,
        offerMaxLifetimeSeconds: config.expiry.offerMaxLifetimeSeconds,
        takeMaxLifetimeSeconds: config.expiry.takeMaxLifetimeSeconds,
      },
      withdrawRecipientEnvelope: config.withdrawRecipientEnvelope,
      tokensDigest: digest,
    };
    return c.json(body);
  });

  app.get(API_PATHS.nonce, (c) => {
    const client = clientAddress(c);
    const refused = limited(nonceLimiter, client, c);
    if (refused) return refused;
    // Outstanding nonces are never evicted (audit C9 / F-A7.3): a client at its own cap, or a full
    // store, is refused until its nonces are used or expire.
    const issued = deps.nonces.issue(client);
    c.header('Cache-Control', 'no-store');
    if (!issued.ok) {
      c.header('Retry-After', String(issued.retryAfterSeconds));
      return issued.refused === 'client-cap'
        ? apiError(c, 429, 'rate-limited', 'too many unused authorisation nonces from this address; use them or wait')
        : apiError(c, 503, 'busy', 'the relay is handing out too many authorisation nonces; try again shortly');
    }
    const body: NonceResponse = {
      nonce: issued.nonce,
      expiresAt: issued.expiresAt,
      maxTtlSeconds: limits.authMaxTtlSeconds,
    };
    return c.json(body);
  });

  app.get('/v1/jobs/:requestId', (c) => {
    const refused = limited(readLimiter, clientAddress(c), c);
    if (refused) return refused;
    const id = c.req.param('requestId');
    if (!/^[0-9a-f]{32}$/.test(id)) return apiError(c, 400, 'bad-request', 'not a request id');
    const job = deps.queue.get(id);
    return job
      ? c.json({ job })
      : apiError(c, 404, 'not-found', 'no such job (it may have expired, or the relay restarted)');
  });

  app.get(API_PATHS.demoTokens, (c) => {
    const refused = limited(readLimiter, clientAddress(c), c);
    if (refused) return refused;
    const owner = c.req.query('owner')?.replace(/^0x/, '').toLowerCase();
    if (owner !== undefined && !/^[0-9a-f]{64}$/.test(owner))
      return apiError(c, 400, 'bad-request', 'owner must be a device key (64 hex)');
    c.header('Cache-Control', 'no-store');
    const body: DemoTokensInfo = deps.demoTokens?.(owner) ?? {
      enabled: false,
      pack: [],
      perKey: 1,
      dailyCap: 0,
      remainingToday: 0,
      ...(owner ? { claimed: false } : {}),
    };
    return c.json(body);
  });

  app.get(API_PATHS.queue, (c) => {
    const refused = limited(readLimiter, clientAddress(c), c);
    if (refused) return refused;
    return c.json(deps.queue.stats());
  });

  const accountRead = (kind: 'state' | 'inbox' | 'zswap' | 'unshielded') => async (c: Context) => {
    const refused = limited(readLimiter, clientAddress(c), c);
    if (refused) return refused;
    const account = c.req.param('account')?.replace(/^0x/, '').toLowerCase() ?? '';
    if (!/^[0-9a-f]{64}$/.test(account)) return apiError(c, 400, 'bad-request', 'not an account address');
    c.header('Cache-Control', 'no-store');
    try {
      if (kind === 'state') {
        const s = await deps.chain.accountState(account);
        return s ? c.json(s) : apiError(c, 404, 'not-found', 'no such account');
      }
      if (kind === 'zswap') {
        const z = await deps.chain.zswap(account);
        return z ? c.json(z) : apiError(c, 404, 'not-found', 'no such account');
      }
      if (kind === 'unshielded') {
        const u = await deps.chain.unshielded(account);
        return u ? c.json(u) : apiError(c, 404, 'not-found', 'no such account');
      }
      const from = Number(c.req.query('from') ?? '0');
      const limit = Math.min(Number(c.req.query('limit') ?? '100'), 500);
      if (!Number.isInteger(from) || from < 0 || !Number.isInteger(limit) || limit < 1)
        return apiError(c, 400, 'bad-request', 'bad from/limit');
      const page = await deps.chain.inbox(account, from, limit);
      return page ? c.json(page) : apiError(c, 404, 'not-found', 'no such account');
    } catch (e) {
      if (e instanceof ChainReadNotImplementedError) return apiError(c, 501, 'not-implemented', e.message);
      // A known limit, not an outage: say which, so the page can. Since AA 00047 P11 (R3-5) the relay
      // reads past one indexer page; only a history past its bound (100,000 actions) is refused.
      if (e instanceof AccountHistoryTooLongError) {
        log.warn('account history beyond what the relay reads', { kind, limit: e.limit });
        return apiError(
          c,
          501,
          'history-too-long',
          `this account has more than ${e.limit} actions, more history than this version of the market can read`,
        );
      }
      log.warn('chain read failed', { kind, error: e });
      return apiError(c, 503, 'chain-unavailable', 'the chain could not be read right now; try again shortly');
    }
  };
  app.get('/v1/accounts/:account/state', accountRead('state'));
  app.get('/v1/accounts/:account/inbox', accountRead('inbox'));
  app.get('/v1/accounts/:account/zswap', accountRead('zswap'));
  app.get('/v1/accounts/:account/unshielded', accountRead('unshielded'));

  // ── the one state-changing route ─────────────────────────────────────────

  app.post(
    '/v1/actions/:action',
    bodyLimit({
      maxSize: limits.maxBodyBytes,
      onError: (c) => apiError(c, 413, 'payload-too-large', 'the request body is too large'),
    }),
    async (c) => {
      const client = clientAddress(c);
      const refused = limited(actionLimiter, client, c);
      if (refused) return refused;
      const name = c.req.param('action') as RelayActionName;
      const def = (RELAY_ACTIONS as readonly string[]).includes(name) ? deps.catalogue.get(name) : undefined;
      if (!def) return apiError(c, 404, 'not-found', 'no such action');

      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return apiError(c, 400, 'bad-request', 'the body must be JSON');
      }
      const parsed = ActionRequestSchema.safeParse(body);
      if (!parsed.success) return apiError(c, 400, 'bad-request', 'the request does not have the expected shape');
      const request = parsed.data;
      const account = request.account?.replace(/^0x/, '').toLowerCase();
      if (def.requiresAccount && !account) return apiError(c, 400, 'bad-request', 'this action needs an account');
      if (!def.requiresAccount && account) return apiError(c, 400, 'bad-request', 'this action takes no account');
      const payload = def.payload.safeParse(request.payload);
      if (!payload.success) return apiError(c, 400, 'bad-request', 'the action arguments are not valid');

      // Before consuming any nonce: can the relay pay for this at all?
      if (def.requiresSponsor) {
        const s = deps.sponsor.status();
        if (!s.synced)
          return apiError(
            c,
            503,
            'sponsor-unavailable',
            'the market cannot pay network fees right now; try again later',
          );
        if (s.dustSpecks !== null && s.dustSpecks < config.sponsor.dustLowSpecks) {
          return apiError(c, 503, 'sponsor-low', 'the market is low on network fee funds; try again later');
        }
      }

      let outcome: VerifyOutcome;
      if (def.auth === 'relay-action') {
        outcome = verifyRelayActionRequest(request.auth, {
          action: def.action,
          network: config.network.name,
          ...(deps.scheme ? { scheme: deps.scheme } : {}),
          account,
          payload: request.payload,
          maxTtlSeconds: limits.authMaxTtlSeconds,
          nonces: deps.nonces,
          now: now(),
        });
      } else if (deps.passportCall) {
        outcome = await deps.passportCall(def, request);
      } else {
        outcome = { ok: false, code: 'not-supported', reason: NOT_SUPPORTED_REASON };
      }
      if (!outcome.ok) {
        log.info('action refused', { action: def.action, code: outcome.code });
        return apiError(c, 401, 'unauthorised', outcome.reason, outcome.code);
      }

      // Security review F-B6: arguments a gated call's own signature cannot cover (a withdrawal's
      // recipient encryption key) are bound by a RelayAction envelope over the WHOLE body, signed
      // by the same device; verified here (its nonce spent) and again by the executor.
      if (outcome.kind === 'passport-call' && def.envelope?.(payload.data)) {
        const envelope = verifyRelayActionRequest(request.auth, {
          action: def.action,
          network: config.network.name,
          ...(deps.scheme ? { scheme: deps.scheme } : {}),
          account,
          payload: request.payload,
          maxTtlSeconds: limits.authMaxTtlSeconds,
          nonces: deps.nonces,
          now: now(),
        });
        const refusal = !envelope.ok
          ? { code: envelope.code, reason: `the relay envelope: ${envelope.reason}` }
          : envelope.signer.toLowerCase() !== outcome.signer.toLowerCase()
            ? { code: 'wrong-signer', reason: 'the relay envelope is not signed by the device that signed the call' }
            : null;
        if (refusal) {
          outcome.release?.();
          log.info('action refused', { action: def.action, code: `envelope ${refusal.code}` });
          return apiError(c, 401, 'unauthorised', refusal.reason, refusal.code);
        }
      }

      const signer = outcome.signer.toLowerCase();
      const ownerRefused = limited(ownerLimiter, signer, c);
      if (ownerRefused) {
        // Refused after the authorisation was accepted: let the same signature be sent again later.
        outcome.release?.();
        return ownerRefused;
      }

      // The failure budget (AA 00047 P9, audit C4; P10, R2-2): an owner or account whose jobs keep
      // failing for reasons they caused waits, so a failing call is not free to repeat. Withdrawals,
      // cancels and key restores are never refused by it (./actions/failure-budget.ts).
      const exempt = BUDGET_EXEMPT_ACTIONS.has(def.action);
      const budget = exempt ? undefined : deps.failures?.check(signer, account);
      if (budget && !budget.ok) {
        outcome.release?.();
        c.header('Retry-After', String(budget.retryAfterSeconds));
        log.info('action refused', { action: def.action, code: 'failure-budget' });
        return apiError(c, 429, 'failure-budget', budget.reason);
      }

      // One queued-or-running job per account (AA 00047 P10, R2-1): taken before the admission check,
      // so a second request of a busy account claims nothing.
      const slot = account ? gate.take(account) : () => {};
      if (!slot) {
        outcome.release?.();
        c.header('Retry-After', String(ACCOUNT_BUSY_RETRY_SECONDS));
        log.info('action refused', { action: def.action, code: 'account-busy' });
        return apiError(
          c,
          429,
          'account-busy',
          'this account already has a request in progress; wait for it to finish, then try again',
        );
      }

      // The action's own admission check (security review F-B2, F-B3; AA 00047 P9: registration caps,
      // offer expiry; P10: the per-account caps), before any queue slot.
      let admitted: AdmissionOutcome = { ok: true };
      if (def.admit) {
        try {
          admitted = await def.admit({ account, payload: payload.data, signer: outcome.signer, client });
        } catch (e) {
          outcome.release?.();
          slot();
          log.warn('admission check failed', { action: def.action, error: e });
          return apiError(c, 503, 'chain-unavailable', 'the account could not be checked right now; try again shortly');
        }
        if (!admitted.ok) {
          outcome.release?.();
          slot();
          log.info('action refused', { action: def.action, code: admitted.detail ?? admitted.code });
          if (admitted.retryAfterSeconds !== undefined) c.header('Retry-After', String(admitted.retryAfterSeconds));
          return apiError(c, admitted.status, admitted.code, admitted.reason, admitted.detail);
        }
      }
      const ok = admitted;
      // Give back everything the request claimed: the authorisation and whatever the admission
      // charged (an entitlement and the day's append allowance, security review F-B7; a registration
      // slot; an offer slot and a daily charge, P10).
      const giveBack = () => {
        outcome.release?.();
        ok.release?.();
      };

      // AA 00047 P11.F (audit round 4 R4-1 / F-A4-1): a take or a make carries the deadline its device
      // signed, and its job must start with `minRemainingSeconds` still left. When the prover lane would
      // reach it too late (./queue/prover-lock.ts: takes go first, so only a crowd of takes or a long
      // holder can do this), it is refused NOW, before any queue slot, proof or DUST, instead of expiring
      // in the queue; nothing is charged and the customer signs again later.
      const deadline = proverPriority(def.action, payload.data).deadline;
      if (deadline !== undefined) {
        const waitSeconds = deps.queue.estimateProverWaitSeconds({
          action: def.action,
          ...(account ? { account } : {}),
          payload: payload.data,
        });
        const { minRemainingSeconds, takeMaxLifetimeSeconds, offerMaxLifetimeSeconds } = config.expiry;
        if (now() + waitSeconds > deadline - minRemainingSeconds) {
          giveBack();
          slot();
          const lifetime = def.action === 'take' ? takeMaxLifetimeSeconds : offerMaxLifetimeSeconds;
          c.header('Retry-After', String(Math.max(1, waitSeconds - (lifetime - minRemainingSeconds))));
          log.info('action refused', { action: def.action, code: 'prover-busy', waitSeconds });
          return apiError(
            c,
            503,
            'prover-busy',
            `the market's prover is busy: this ${def.action === 'take' ? 'take' : 'offer'} would only start in about ${waitSeconds} s, too late for the expiry you signed. Nothing was sent; try again shortly and sign once more`,
          );
        }
      }

      let job: ReturnType<JobQueue['submit']> = null;
      try {
        job = deps.queue.submit({
          action: def.action,
          lane: def.lane,
          account,
          payload: {
            ...request.payload,
            ...(request.auth ? { auth: request.auth } : {}),
            ...(request.passportAuth ? { passportAuth: request.passportAuth } : {}),
            ...(account ? { account } : {}),
            signer: outcome.signer,
          },
          executor: guarded(def.executor, {
            action: def.action,
            owner: signer,
            account,
            ...(deps.failures ? { failures: deps.failures } : {}),
            refuse: giveBack,
            ...(ok.finished ? { finished: ok.finished } : {}),
          }),
        });
      } finally {
        if (!job) {
          // Refused after admission (a full queue, or an error): nothing was queued.
          giveBack();
          slot();
        }
      }
      if (!job) return apiError(c, 503, 'busy', 'the relay is at capacity; try again later');
      void deps.queue.settled(job.requestId).finally(slot);
      log.info('action queued', { action: def.action, requestId: job.requestId });
      return c.json({ job }, 202);
    },
  );

  app.notFound((c) => apiError(c, 404, 'not-found', 'no such route'));
  app.onError((err, c) => {
    log.error('unhandled error', { path: c.req.path, error: err });
    return apiError(c, 500, 'internal-error', 'the relay hit an internal error');
  });

  return app;
}

/** Seconds a busy account is told to wait (`429 account-busy`): about one proof. */
export const ACCOUNT_BUSY_RETRY_SECONDS = 30;

/**
 * `executor`, as the route queues it (AA 00047 P9 audit C4; P10 audit round 2 R2-2):
 *   - when the job reaches its lane, and again when it first reaches the PROVER (an account-lane job
 *     such as a make waits for the prover inside ctx.prove), the failure budget is checked AGAIN
 *     (F-B2-3: jobs queued before the owner's or account's last allowed failure must not prove after
 *     it); a refused job proves nothing, gives back everything its request claimed (`refuse`) and
 *     fails with `failure-budget`, so the same signature can be sent again later. Exempt actions
 *     (withdrawals, cancels, key restores) are never refused;
 *   - a failure the requester caused after proving started counts against `owner` and `account`;
 *   - an infrastructure failure (the proof server, the node, the indexer) is reported to the
 *     customer as `market-unavailable`, not as an internal error, and is never charged;
 *   - `finished` hears how the job ended (the admission's open-offer slot and daily charges).
 */
export function guarded(
  executor: JobExecutor,
  o: {
    action: RelayActionName;
    owner: string;
    account?: string;
    failures?: FailureBudget;
    refuse?: () => void;
    finished?: (end: JobEnd) => void;
  },
): JobExecutor {
  return async (payload, ctx) => {
    let refused = false;
    /** The budget, again: throws (and gives the request's claims back) when it ran out meanwhile. */
    const recheck = () => {
      if (!o.failures || BUDGET_EXEMPT_ACTIONS.has(o.action)) return;
      const budget = o.failures.check(o.owner, o.account);
      if (budget.ok) return;
      refused = true;
      o.refuse?.();
      ctx.log.info('job refused at its lane: failure budget', { action: o.action });
      throw new PublicError('failure-budget', budget.reason);
    };
    recheck();
    let proved = false;
    /** Whether the job's failure counted (decided once): a failure inside a proof is recorded BEFORE
     *  the prover lane passes to the next job, whose own check must see it. */
    let charged: boolean | null = null;
    const charge = (e: unknown, inProof: boolean): boolean => {
      if (charged === null) {
        charged = countsAgainstBudget(e, inProof);
        if (charged) o.failures?.record(o.owner, o.account);
      }
      return charged;
    };
    const watched = {
      ...ctx,
      prove: <T>(fn: () => Promise<T>): Promise<T> => {
        const first = !proved;
        proved = true;
        return ctx.prove(async () => {
          if (first) recheck(); // now holding the prover, before any proving time is spent
          try {
            return await fn();
          } catch (e) {
            if (!refused) charge(e, true);
            throw e;
          }
        });
      },
    };
    let result: Record<string, unknown>;
    try {
      result = await executor(payload, watched);
    } catch (e) {
      if (refused) throw e; // nothing proved; the claims were given back
      const counted = charge(e, proved);
      const code = e instanceof PublicError ? e.code : isInfrastructureFailure(e) ? 'market-unavailable' : undefined;
      o.finished?.({ ok: false, proved, requesterFault: counted, ...(code ? { code } : {}) });
      if (!(e instanceof PublicError) && isInfrastructureFailure(e)) {
        ctx.log.warn('job failed on the market side (infrastructure)', { error: e });
        throw new PublicError(
          'market-unavailable',
          "the market's prover or its connection to Midnight failed while working on this request. It does not count against you; try again shortly",
        );
      }
      throw e;
    }
    o.finished?.({ ok: true, proved, requesterFault: false, result });
    return result;
  };
}

/** `executor` with the failure budget alone (AA 00047 P9): `guarded` without an action's exemption. */
export function budgeted(executor: JobExecutor, failures: FailureBudget, owner: string, account?: string): JobExecutor {
  return guarded(executor, { action: 'take', owner, ...(account ? { account } : {}), failures });
}

/** The routes that change state, for the auth test to enumerate (every one must refuse
 *  unsigned or wrongly signed calls). */
export const STATE_CHANGING_ROUTES = RELAY_ACTIONS.map((a) => ({
  method: 'POST',
  path: API_PATHS.action(a),
  action: a,
}));
