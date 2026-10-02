// One GraphQL subscription over a WebSocket, read until the page has what it needs, then closed (AA
// 00047 P11.B; questions Q47 A). The Midnight indexer serves subscriptions with the
// `graphql-transport-ws` protocol (as midnight-js's indexer provider speaks it):
//
//   client: connection_init        server: connection_ack
//   client: subscribe {id, query}  server: next {id, payload} …  (and ping → client pong)
//   client: complete {id}, then closes the socket.
//
// The page uses it for one thing: the `contractActions` subscription, which streams an account's
// actions oldest first from a block height and then waits for new ones (it never completes by itself),
// so `onData` says when the page has read far enough. The indexer's own documentation names this
// subscription as THE way to enumerate all of a contract's actions; its `actions(limit)` query stops
// at the newest 500 (web/src/chain/indexer.ts, ./history.ts).

export class SubscriptionError extends Error {
  override name = 'SubscriptionError';
}

export interface SubscriptionOptions {
  url: string;
  query: string;
  variables: Record<string, unknown>;
  /** Each `next` payload's data, in order. Return true to stop (the subscription is then closed). */
  onData: (data: unknown) => boolean;
  /** The whole read must end within this (the stream is then closed and the read fails). */
  timeoutMs: number;
  WebSocketImpl?: typeof WebSocket;
}

/** Run one subscription until `onData` returns true. Rejects on an error, a close before that, or the
 *  timeout; the socket is always closed at the end. */
export function readSubscription(o: SubscriptionOptions): Promise<void> {
  const WS = o.WebSocketImpl ?? globalThis.WebSocket;
  return new Promise<void>((resolve, reject) => {
    let ws: WebSocket;
    let done = false;
    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        if (ws.readyState === WS.OPEN) {
          ws.send(JSON.stringify({ id: '1', type: 'complete' }));
          ws.close(1000);
        } else if (ws.readyState === WS.CONNECTING) ws.close();
      } catch {
        /* closing is best effort */
      }
      if (err) reject(err);
      else resolve();
    };
    const timer = setTimeout(
      () => finish(new SubscriptionError('The Midnight indexer took too long to stream the account’s history.')),
      o.timeoutMs,
    );
    try {
      ws = new WS(o.url, 'graphql-transport-ws');
    } catch (e) {
      clearTimeout(timer);
      reject(new SubscriptionError(`The Midnight indexer’s stream could not be opened: ${String(e)}`));
      return;
    }
    ws.onopen = () => ws.send(JSON.stringify({ type: 'connection_init', payload: {} }));
    ws.onerror = () => finish(new SubscriptionError('The Midnight indexer’s stream failed.'));
    ws.onclose = () => finish(new SubscriptionError('The Midnight indexer closed the stream early.'));
    ws.onmessage = (m: MessageEvent) => {
      if (done) return;
      let msg: { type?: string; id?: string; payload?: unknown };
      try {
        msg = JSON.parse(String(m.data)) as typeof msg;
      } catch {
        return finish(new SubscriptionError('The Midnight indexer sent something that is not JSON.'));
      }
      switch (msg.type) {
        case 'connection_ack':
          ws.send(JSON.stringify({ id: '1', type: 'subscribe', payload: { query: o.query, variables: o.variables } }));
          return;
        case 'ping':
          ws.send(JSON.stringify({ type: 'pong' }));
          return;
        case 'next': {
          const p = (msg.payload ?? {}) as { data?: unknown; errors?: Array<{ message?: string }> };
          if (p.errors?.length)
            return finish(
              new SubscriptionError(
                `The Midnight indexer refused the stream: ${p.errors.map((e) => e.message).join('; ')}`,
              ),
            );
          try {
            if (o.onData(p.data)) finish();
          } catch (e) {
            finish(e instanceof Error ? e : new SubscriptionError(String(e)));
          }
          return;
        }
        case 'error':
          return finish(
            new SubscriptionError(`The Midnight indexer refused the stream: ${JSON.stringify(msg.payload)}`),
          );
        case 'complete':
          return finish(new SubscriptionError('The Midnight indexer ended the stream early.'));
        default:
          return;
      }
    };
  });
}
