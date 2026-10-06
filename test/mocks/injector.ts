// A MOCK of the RPC injector's account registration (I-4, FROZEN by 00059 @ f4d215c; AA 00060 P1.5, P8.2).
// It checks a registration the way 00059's verification order starts (shape, the v1 text re-rendered from
// its own fields, the wallet and account equal to the body's, its origin and network, the expiry window
// `now < Expires <= now + maxTtl`, the strict signature), then stores it; a wrong method on a route
// answers 405 `method-not-allowed`. It never reads a chain: the account checks (steps 12-16) are
// replaced by `failNext`, which makes the next POST answer a chosen error code. Every request body is
// recorded, so a test can check exactly what the page sent and where.

import {
  REGISTRATION_FIRST_LINE,
  registrationMessageText,
  type RegistrationErrorCode,
  type RegistrationStatus,
} from '../../packages/core/src/bridge/injector.js';
import { base58Key32 } from '../../packages/core/src/bridge/landing-key.js';
import { bytesToHex, hexToBytes } from '../../packages/core/src/hex.js';
import { verifyEd25519Strict } from '../../packages/core/src/solana-auth.js';
import { json, type Handler } from './http.js';

export interface MockInjector {
  handler: Handler;
  /** The origin the injector says it serves (its registration-info). */
  origin: string;
  networkId: string;
  /** Every POST body, in order. */
  posts: unknown[];
  /** Make the next POST fail with this code (and HTTP status). */
  failNext(code: RegistrationErrorCode, status?: number): void;
  /** Set the status the registrations report (default: synced). */
  setStatus(status: RegistrationStatus, unseenCoins?: number): void;
  now: () => number;
}

const ERROR_STATUS: Partial<Record<RegistrationErrorCode, number>> = {
  'bad-signature': 401,
  'not-passport-account': 403,
  'not-a-device': 403,
  'enc-key-mismatch': 403,
  'account-not-found': 404,
  'indexer-unavailable': 503,
  'accounts-disabled': 503,
  'storage-error': 500,
};

export function mockInjector(opts: { origin?: string; networkId?: string; maxTtlSeconds?: number } = {}): MockInjector {
  const origin = opts.origin ?? 'http://127.0.0.1:18899';
  const networkId = opts.networkId ?? 'undeployed';
  const maxTtl = opts.maxTtlSeconds ?? 600;
  const posts: unknown[] = [];
  const stored = new Map<string, { solanaAddress: string; accountAddress: string; key: string; createdAt: string }>();
  let nextFailure: { code: RegistrationErrorCode; status: number } | null = null;
  let status: RegistrationStatus = 'synced';
  let unseen = 0;
  const mock: MockInjector = {
    origin,
    networkId,
    posts,
    now: () => Math.floor(Date.now() / 1000),
    failNext(code, httpStatus) {
      nextFailure = { code, status: httpStatus ?? ERROR_STATUS[code] ?? 400 };
    },
    setStatus(s, unseenCoins = 0) {
      status = s;
      unseen = unseenCoins;
    },
    handler: async (req) => {
      const url = new URL(req.url);
      if (url.pathname === '/api/accounts/registration-info' && req.method === 'GET') {
        return json({ format: REGISTRATION_FIRST_LINE, origin, networkId, maxTtlSeconds: maxTtl });
      }
      const view = (id: string, extra: Record<string, unknown> = {}) => {
        const r = stored.get(id)!;
        return {
          id,
          solanaAddress: r.solanaAddress,
          accountAddress: r.accountAddress,
          networkId,
          // The real injector shows the X25519 PUBLIC key's first 8 hex; the mock never derives it.
          keyFingerprint: 'mock0000',
          heldKeys: 1,
          createdAt: r.createdAt,
          updatedAt: r.createdAt,
          status,
          error: null,
          lastCheckedAt: null,
          history: { complete: status === 'synced', throughHeight: 0 },
          unseenCoins: unseen,
          unconfirmedNotes: 0,
          unreadableEntries: 0,
          tokens: [],
          ...extra,
        };
      };
      const one = /^\/api\/accounts\/([0-9a-f]{16})$/.exec(url.pathname);
      const known = url.pathname === '/api/accounts' || url.pathname === '/api/accounts/registration-info' || one;
      const allowed = url.pathname === '/api/accounts' ? 'GET, POST' : 'GET';
      if (known && !allowed.split(', ').includes(req.method)) {
        return new Response(JSON.stringify({ error: 'method not allowed', code: 'method-not-allowed' }), {
          status: 405,
          headers: { 'content-type': 'application/json', allow: allowed, 'access-control-allow-origin': '*' },
        });
      }
      if (one && req.method === 'GET') {
        return stored.has(one[1]!)
          ? json(view(one[1]!))
          : json({ error: 'no such registration', code: 'not-found' }, 404);
      }
      if (url.pathname !== '/api/accounts' || req.method !== 'POST') return json({ error: 'not found' }, 404);
      let body: Record<string, unknown>;
      try {
        body = (await req.json()) as Record<string, unknown>;
      } catch {
        return json({ error: 'malformed', code: 'malformed' }, 400);
      }
      posts.push(body);
      const fail = (code: RegistrationErrorCode, s = ERROR_STATUS[code] ?? 400) =>
        json({ error: `mock: ${code}`, code }, s);
      const fields = ['solanaAddress', 'accountAddress', 'accountViewingKey', 'message', 'signature'];
      if (Object.keys(body).length !== fields.length || !fields.every((f) => typeof body[f] === 'string')) {
        return fail('malformed');
      }
      const b = body as Record<string, string>;
      const key = base58Key32(b.solanaAddress!);
      if (!key) return fail('bad-solana-address');
      if (!/^[0-9a-f]{64}$/.test(b.accountAddress!)) return fail('bad-account-address');
      if (!/^[0-9a-f]{64}$/.test(b.accountViewingKey!)) return fail('bad-viewing-key');
      if (!/^[0-9a-f]{128}$/.test(b.signature!)) return fail('malformed');
      const lines = b.message!.split('\n');
      const field = (prefix: string, i: number) =>
        lines[i]?.startsWith(prefix) ? lines[i]!.slice(prefix.length) : null;
      const exp = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) UTC$/.exec(field('Expires ', 6) ?? '');
      if (lines.length !== 9 || !exp) return fail('bad-message');
      const expires = Date.UTC(+exp[1]!, +exp[2]! - 1, +exp[3]!, +exp[4]!, +exp[5]!, +exp[6]!) / 1000;
      const rendered = registrationMessageText({
        origin: field('RPC ', 2) ?? '',
        networkId: field('Midnight network ', 3) ?? '',
        solanaAddress: field('Wallet ', 4) ?? '',
        accountAddress: field('Account ', 5) ?? '',
        expires,
      });
      if (rendered !== b.message) return fail('bad-message');
      if (field('Wallet ', 4) !== b.solanaAddress || field('Account ', 5) !== b.accountAddress)
        return fail('message-mismatch');
      if (field('RPC ', 2) !== origin) return fail('wrong-origin');
      if (field('Midnight network ', 3) !== networkId) return fail('wrong-network');
      const now = mock.now();
      if (now >= expires) return fail('expired');
      if (expires > now + maxTtl) return fail('expiry-too-far');
      if (!verifyEd25519Strict(bytesToHex(key), new TextEncoder().encode(b.message), hexToBytes(b.signature!, 64))) {
        return fail('bad-signature');
      }
      if (nextFailure) {
        const f = nextFailure;
        nextFailure = null;
        return fail(f.code, f.status);
      }
      const { createHash } = await import('node:crypto');
      const id = createHash('sha256')
        .update(`account:${b.solanaAddress}:${b.accountAddress}`)
        .digest('hex')
        .slice(0, 16);
      const before = stored.get(id);
      stored.set(id, {
        solanaAddress: b.solanaAddress!,
        accountAddress: b.accountAddress!,
        key: b.accountViewingKey!,
        createdAt: before?.createdAt ?? new Date(now * 1000).toISOString(),
      });
      return json(
        view(id, { created: !before, replacedKey: !!before && before.key !== b.accountViewingKey }),
        before ? 200 : 201,
      );
    },
  };
  return mock;
}
