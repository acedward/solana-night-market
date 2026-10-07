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
  SplFaucetInfoSchema,
  ZswapActivitySchema,
  type ActionRequest,
  type DemoTokensInfo,
  type JobView,
  type NonceResponse,
  type RelayActionName,
  type SplFaucetInfo,
  type ZswapActivity,
} from '@nightmarket/core';

import {
  ClientProofRequestSchema,
  HandOffJobViewSchema,
  clientProofPath,
  clientProvingOf,
  type ClientProofRequest,
  type ClientProvingConfig,
  type HandOffJobView,
} from '../prover/i62a.js';
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

  /** The job, or null when the relay no longer knows it (expired, or restarted). AA 00062: with the
   *  I-62a `clientProof` field while the relay waits for the customer's prover. */
  async job(requestId: string): Promise<HandOffJobView | null> {
    try {
      const body = (await this.call(API_PATHS.job(requestId))) as { job?: unknown };
      return HandOffJobViewSchema.parse(body.job);
    } catch (e) {
      if (e instanceof RelayError && e.status === 404) return null;
      throw e;
    }
  }

  /**
   * Poll a job until it finishes; `onUpdate` sees every state. AA 00062 (I-62a): while the job holds
   * an open hand-off the page has not answered yet (`clientProof`, a new `proofId`), `clientProof`
   * runs it (the customer's prover, then the proof back to the market) before polling goes on. Each
   * new `proofId` is answered once (I-62a v2: a job has one). Without `clientProof` the job is only
   * followed (the market then stops it at the ticket's deadline).
   */
  async waitForJob(
    requestId: string,
    onUpdate: (job: JobView) => void,
    opts: {
      intervalMs?: number;
      signal?: AbortSignal;
      clientProof?: (job: HandOffJobView) => Promise<unknown>;
    } = {},
  ): Promise<JobView> {
    const interval = opts.intervalMs ?? 2_000;
    const answered = new Set<string>();
    for (;;) {
      if (opts.signal?.aborted) throw new RelayError(0, 'aborted', 'stopped waiting');
      const job = await this.job(requestId);
      if (!job) {
        // AA 00062 (I-62a v2): a job that waited for the customer's proof had sent nothing yet; the market
        // keeps those in memory only, so a restart drops them.
        throw new RelayError(
          404,
          'job-lost',
          answered.size > 0
            ? "The market restarted (or the request expired) while it waited for your proof server's proof. Nothing was sent and no fee was spent: send it again."
            : 'The market no longer knows this request (it expired or restarted).',
        );
      }
      onUpdate(job);
      if (job.state === 'succeeded' || job.state === 'failed') return job;
      const handOff = job.clientProof;
      if (opts.clientProof && handOff && !answered.has(handOff.proofId)) {
        answered.add(handOff.proofId);
        await opts.clientProof(job);
        continue; // read the job again at once: the market has moved on
      }
      await new Promise((r) => setTimeout(r, interval));
    }
  }

  // ── AA 00062: the client-proof hand-off (I-62a) ───────────────────────────

  /** What the relay says about client proving (`GET /v1/config` `clientProving`; absent: off).
   *  Throws when the relay cannot be read. */
  async clientProving(): Promise<ClientProvingConfig> {
    return clientProvingOf(await this.call(API_PATHS.config));
  }

  /** The open hand-off's proof request (`GET /v1/jobs/:id/client-proof`), or null when the job has
   *  none open any more (409 `not-awaiting-client-proof`) or the relay proves everything itself
   *  (404 `client-proving-off`). The request carries the call's private inputs: it is never logged
   *  or stored, and dropped once the proof is sent. */
  async clientProofRequest(requestId: string): Promise<ClientProofRequest | null> {
    try {
      return ClientProofRequestSchema.parse(await this.call(clientProofPath(requestId)));
    } catch (e) {
      if (e instanceof RelayError && (e.code === 'not-awaiting-client-proof' || e.code === 'client-proving-off'))
        return null;
      throw e;
    }
  }

  /** Send the customer's proof back (`POST /v1/jobs/:id/client-proof`): the job, at stage
   *  `client-proof-checked`. Refusals throw a `RelayError` with the relay's code. */
  async postClientProof(requestId: string, body: { proofId: string; proof: string }): Promise<HandOffJobView> {
    const answer = (await this.call(clientProofPath(requestId), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ proofId: body.proofId, proof: body.proof }),
    })) as { job?: unknown };
    return HandOffJobViewSchema.parse(answer.job);
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

  /** "Mint Solana tokens" (AA 00060 P13, spec FR-024; packages/core/src/spl-faucet.ts): what a claim mints,
   *  whether the faucet is on (and why not), and `wallet`'s last claim. Null when this relay does not serve it
   *  (an older relay). */
  async splFaucetInfo(wallet?: string): Promise<SplFaucetInfo | null> {
    const path = wallet ? `${API_PATHS.splFaucet}?wallet=${encodeURIComponent(wallet)}` : API_PATHS.splFaucet;
    try {
      return SplFaucetInfoSchema.parse(await this.call(path));
    } catch (e) {
      if (e instanceof RelayError && (e.status === 404 || e.status === 405)) return null;
      throw e;
    }
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
