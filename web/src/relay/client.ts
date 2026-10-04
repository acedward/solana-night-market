// The browser's client for the Night Market relay: nonces, the one action route and job polling (the
// browser keeps the request id, so a job resumes after a reload, Q5). Every response is validated
// against the shared schemas. Since AA 00047 P11.B (questions Q47 A, superseding Q31) the page
// decodes the account's Zswap activity itself; `zswap` below is kept but the page never calls it.
//
// The account's state, inbox and public balances are NOT read here (AA 00047 P9.S, questions Q26:
// the relay is trustless): the page reads them from the public indexer (../chain/indexer.ts). The
// relay still serves those routes; this client deliberately has no method for them.

import {
  API_PATHS,
  ApiErrorSchema,
  DemoTokensInfoSchema,
  HealthResponseSchema,
  type HealthResponse,
  JobViewSchema,
  NonceResponseSchema,
  ZswapActivitySchema,
  type ActionRequest,
  type DemoTokensInfo,
  type JobView,
  type NonceResponse,
  type RelayActionName,
  type ZswapActivity,
} from '@nightmarket/core';

import { relayErrorText } from './messages.js';

/** A refusal or failure of the relay. `message` is the customer's sentence (./messages.ts);
 *  `relayMessage` is what the relay said. */
export class RelayError extends Error {
  override name = 'RelayError';
  readonly relayMessage: string;
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly detail?: string,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(relayErrorText({ status, code, message, ...(detail ? { detail } : {}), retryAfterSeconds }));
    this.relayMessage = message;
  }
}

export class RelayClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = (...a) => fetch(...a),
  ) {}

  private url(path: string): string {
    return `${this.baseUrl.replace(/\/$/, '')}${path}`;
  }

  private async call(path: string, init?: RequestInit): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.url(path), { cache: 'no-store', ...init });
    } catch {
      throw new RelayError(0, 'unreachable', 'The market could not be reached.');
    }
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const e = ApiErrorSchema.safeParse(body);
      const retry = Number(res.headers.get('retry-after') ?? '');
      const retryAfter = Number.isFinite(retry) && retry > 0 ? retry : null;
      throw e.success
        ? new RelayError(res.status, e.data.error.code, e.data.error.message, e.data.error.detail, retryAfter)
        : new RelayError(res.status, 'error', '', undefined, retryAfter);
    }
    return body;
  }

  async nonce(): Promise<NonceResponse> {
    return NonceResponseSchema.parse(await this.call(API_PATHS.nonce));
  }

  async submit(action: RelayActionName, request: ActionRequest): Promise<JobView> {
    const body = (await this.call(API_PATHS.action(action), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    })) as { job?: unknown };
    return JobViewSchema.parse(body.job);
  }

  /** The job, or null when the relay no longer knows it (expired, or restarted). */
  async job(requestId: string): Promise<JobView | null> {
    try {
      const body = (await this.call(API_PATHS.job(requestId))) as { job?: unknown };
      return JobViewSchema.parse(body.job);
    } catch (e) {
      if (e instanceof RelayError && e.status === 404) return null;
      throw e;
    }
  }

  /** Poll a job until it finishes; `onUpdate` sees every state. */
  async waitForJob(
    requestId: string,
    onUpdate: (job: JobView) => void,
    opts: { intervalMs?: number; signal?: AbortSignal } = {},
  ): Promise<JobView> {
    const interval = opts.intervalMs ?? 2_000;
    for (;;) {
      if (opts.signal?.aborted) throw new RelayError(0, 'aborted', 'stopped waiting');
      const job = await this.job(requestId);
      if (!job)
        throw new RelayError(404, 'job-lost', 'The market no longer knows this request (it expired or restarted).');
      onUpdate(job);
      if (job.state === 'succeeded' || job.state === 'failed') return job;
      await new Promise((r) => setTimeout(r, interval));
    }
  }

  /** The market's health (FR-013): what is paused and why (plan P4-A error states). A down relay
   *  answers 503 with the same body. */
  async health(): Promise<HealthResponse> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.url(API_PATHS.health), { cache: 'no-store' });
    } catch {
      throw new RelayError(0, 'unreachable', 'The market could not be reached.');
    }
    const body: unknown = await res.json().catch(() => null);
    const h = HealthResponseSchema.safeParse(body);
    if (!h.success) throw new RelayError(res.status, 'error', '');
    return h.data;
  }

  /** The account's Zswap leaves and spends, as the relay decodes the ledger's events. NOT used by the
   *  page since AA 00047 P11.B: it decodes the account's history itself (../chain/history.ts, Q47 A). */
  async zswap(account: string): Promise<ZswapActivity> {
    return ZswapActivitySchema.parse(await this.call(API_PATHS.accountZswap(account)));
  }

  /** What the relay's public configuration says about signing: whether a withdrawal to a wallet
   *  also needs F-B6's envelope over the whole body (questions Q13; off by default, when the field is
   *  absent too). */
  async signingPolicy(): Promise<{ withdrawRecipientEnvelope: boolean }> {
    try {
      const body = (await this.call(API_PATHS.config)) as { withdrawRecipientEnvelope?: unknown } | null;
      return { withdrawRecipientEnvelope: body?.withdrawRecipientEnvelope === true };
    } catch {
      return { withdrawRecipientEnvelope: false };
    }
  }

  /** The relay's token-list digest (AA 00060 P4.3, `GET /v1/config` `tokensDigest`), or null when this
   *  relay does not publish one (an older relay: then there is nothing to compare). Throws when the
   *  relay cannot be read. */
  async tokensDigest(): Promise<string | null> {
    const body = (await this.call(API_PATHS.config)) as { tokensDigest?: unknown } | null;
    const d = body?.tokensDigest;
    return typeof d === 'string' && /^[0-9a-f]{64}$/.test(d) ? d : null;
  }

  /** The demo-token offer (AA 00047, packages/core/src/demo-tokens.ts): the pack, the limits and,
   *  for `owner`, whether that key has claimed. Null when this relay does not serve it. */
  async demoTokensInfo(owner?: string): Promise<DemoTokensInfo | null> {
    const path = owner ? `${API_PATHS.demoTokens}?owner=${encodeURIComponent(owner)}` : API_PATHS.demoTokens;
    try {
      return DemoTokensInfoSchema.parse(await this.call(path));
    } catch (e) {
      if (e instanceof RelayError && (e.status === 404 || e.status === 405)) return null;
      throw e;
    }
  }
}
