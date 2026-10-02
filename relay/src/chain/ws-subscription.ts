// One GraphQL subscription over the indexer's WebSocket (the `graphql-transport-ws` protocol, as
// midnight-js's `graphql-ws` client speaks it to the same indexer), read until the caller has what it
// needs, then closed. AA 00047 P11 (audit round 3 R3-5 / F-B3-4): the relay reads an account's whole
// history through the `contractActions` subscription, which the indexer documents as THE way to
// enumerate all of a contract's actions (`Contract.actions` stops at the newest 500).
//
// Protocol (https://github.com/enisdenjo/graphql-ws/blob/master/PROTOCOL.md): `connection_init` →
// `connection_ack` → `subscribe` {id, payload: {query, variables}} → `next`… (or `error`, `complete`);
// a `ping` is answered with a `pong`. The relay sends `complete` and closes once `onNext` says it is
// done. One subscription per connection (the indexer counts them per connection).

/** The part of the WebSocket API the client uses (the global WebSocket of Bun and Node, or `ws`). */
export interface MinimalWebSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: unknown) => void): void;
}

export type WebSocketFactory = (url: string, protocols: string[]) => MinimalWebSocket;

export const GRAPHQL_TRANSPORT_WS = 'graphql-transport-ws';

export class SubscriptionError extends Error {
  override name = 'SubscriptionError';
  /** The indexer or the connection failed: not the requester's doing (../actions/failure-budget.ts). */
  readonly infrastructure = true;
}

const defaultFactory: WebSocketFactory = (url, protocols) => {
  const WS = (globalThis as { WebSocket?: new (u: string, p: string[]) => MinimalWebSocket }).WebSocket;
  if (!WS) throw new SubscriptionError('this runtime has no WebSocket');
  return new WS(url, protocols);
};

/**
 * Subscribe to `query` with `variables` and hand every `next` payload's `data` to `onNext` until it
 * returns true (done). Rejects on a GraphQL `error`, a connection that closes or fails first, or
 * `timeoutMs` without being done.
 */
export function subscribeUntil<T>(o: {
  url: string;
  query: string;
  variables: Record<string, unknown>;
  onNext: (data: T) => boolean;
  timeoutMs: number;
  webSocket?: WebSocketFactory;
}): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let socket: MinimalWebSocket;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        if (!error) socket.send(JSON.stringify({ id: '1', type: 'complete' }));
      } catch {
        /* the socket is already closing */
      }
      try {
        socket.close(1000, error ? 'error' : 'done');
      } catch {
        /* already closed */
      }
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(
      () => finish(new SubscriptionError(`the indexer subscription did not finish within ${o.timeoutMs} ms`)),
      o.timeoutMs,
    );
    try {
      socket = (o.webSocket ?? defaultFactory)(o.url, [GRAPHQL_TRANSPORT_WS]);
    } catch (e) {
      clearTimeout(timer);
      settled = true;
      reject(
        e instanceof SubscriptionError
          ? e
          : new SubscriptionError(`the indexer WebSocket could not open: ${String(e)}`),
      );
      return;
    }
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ type: 'connection_init', payload: {} }));
    });
    socket.addEventListener('error', () => finish(new SubscriptionError('the indexer WebSocket failed')));
    socket.addEventListener('close', () => finish(new SubscriptionError('the indexer WebSocket closed early')));
    socket.addEventListener('message', (event) => {
      if (settled) return;
      let msg: { type?: string; id?: string; payload?: unknown };
      try {
        const raw = (event as { data?: unknown }).data;
        msg = JSON.parse(typeof raw === 'string' ? raw : String(raw)) as typeof msg;
      } catch {
        finish(new SubscriptionError('the indexer sent a message that is not JSON'));
        return;
      }
      switch (msg.type) {
        case 'connection_ack':
          socket.send(
            JSON.stringify({ id: '1', type: 'subscribe', payload: { query: o.query, variables: o.variables } }),
          );
          return;
        case 'ping':
          socket.send(JSON.stringify({ type: 'pong' }));
          return;
        case 'pong':
          return;
        case 'next': {
          const p = msg.payload as { data?: T; errors?: Array<{ message?: string }> } | undefined;
          if (p?.errors?.length) {
            finish(new SubscriptionError(`indexer: ${p.errors.map((e) => e.message).join('; ')}`));
            return;
          }
          if (!p?.data) return;
          let done: boolean;
          try {
            done = o.onNext(p.data);
          } catch (e) {
            finish(e instanceof Error ? e : new Error(String(e)));
            return;
          }
          if (done) finish();
          return;
        }
        case 'error': {
          const errors = Array.isArray(msg.payload) ? (msg.payload as Array<{ message?: string }>) : [];
          finish(
            new SubscriptionError(`indexer: ${errors.map((e) => e.message).join('; ') || 'subscription refused'}`),
          );
          return;
        }
        case 'complete':
          finish(new SubscriptionError('the indexer ended the subscription before the history was read'));
          return;
        default:
          return;
      }
    });
  });
}
