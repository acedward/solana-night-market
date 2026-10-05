// A MOCK of the bridge node's API (I-3, 00058's proposed `TransferView` v2; AA 00060 P1.5): the transfer
// views the test sets (`GET /transfers/:id`, 404 until set, answered WRAPPED as `{ transfer: view }` exactly as
// the real node does, 00058 `packages/node/api.ts` @ 1c9f4959; AA 00060 P10.3 C13), the recognition verdicts
// (`GET /recipients/contract/:address`), and `GET /deployment` when a record is given. CORS `*`, as the
// effectstream runtime serves the real one. Every request is recorded.

import type {
  RecipientVerdict,
  TransferStatus,
  TransferView,
  UndeliverableCode,
} from '../../packages/core/src/bridge/transfers.js';
import { json, type Handler } from './http.js';

export interface MockBridgeApi {
  handler: Handler;
  /** Set (or clear, with null) the view a transfer id answers. */
  setTransfer(view: TransferView | null, id?: string): void;
  /** Set the verdict an account address answers (default: deliverable). */
  setVerdict(address: string, verdict: RecipientVerdict['verdict'], code?: UndeliverableCode): void;
  requests: { method: string; path: string }[];
}

/** A complete v2 view with defaults (an s2m contract delivery). */
export function transferView(p: Partial<TransferView> & { id: string; status: TransferStatus }): TransferView {
  const direction = p.id.startsWith('m2s') ? 'm2s' : 's2m';
  return {
    direction,
    sourceId: p.id.split(':')[1]!,
    amount: '500000000',
    recipientKind: direction === 'm2s' ? 'solana' : 'contract',
    recipient: null,
    sender: null,
    reason: null,
    delivery: null,
    srcRef: null,
    dstRef: null,
    observedBlock: 100,
    completedBlock: p.status === 'completed' ? 140 : null,
    relayer: null,
    ...p,
  };
}

export function mockBridgeApi(opts: { deployment?: unknown } = {}): MockBridgeApi {
  const transfers = new Map<string, TransferView>();
  const verdicts = new Map<string, RecipientVerdict>();
  const requests: MockBridgeApi['requests'] = [];
  const handler: Handler = (req) => {
    const url = new URL(req.url);
    requests.push({ method: req.method, path: url.pathname });
    if (req.method !== 'GET') return json({ error: 'method not allowed' }, 405);
    const t = /^\/transfers\/((?:s2m|m2s)(?::|%3A)\d+)$/.exec(url.pathname);
    if (t) {
      const view = transfers.get(decodeURIComponent(t[1]!));
      return view ? json({ transfer: view }) : json({ error: 'transfer not found', id: decodeURIComponent(t[1]!) }, 404);
    }
    const r = /^\/recipients\/contract\/([0-9a-f]{64})$/.exec(url.pathname);
    if (r) {
      return json(
        verdicts.get(r[1]!) ?? {
          address: r[1]!,
          verdict: 'deliverable',
          adapter: 'passport-ed25519@21493588',
          code: null,
          message: null,
          checkedAt: new Date(0).toISOString(),
        },
      );
    }
    if (url.pathname === '/deployment' && opts.deployment) return json(opts.deployment);
    return json({ error: 'not found' }, 404);
  };
  return {
    handler,
    requests,
    setTransfer(view, id) {
      const key = id ?? view?.id;
      if (!key) throw new Error('setTransfer(null) needs the id');
      if (view) transfers.set(key, view);
      else transfers.delete(key);
    },
    setVerdict(address, verdict, code) {
      verdicts.set(address, {
        address,
        verdict,
        adapter: verdict === 'deliverable' ? 'passport-ed25519@21493588' : null,
        code: code ?? null,
        message: code ? `mock: ${code}` : null,
        checkedAt: new Date(0).toISOString(),
      });
    },
  };
}
