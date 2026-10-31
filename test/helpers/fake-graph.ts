import type { FetchLike } from '../../src/modules/whatsapp/connector/graph-client.js';

export interface RecordedCall {
  method: string;
  url: string;
  path: string;
  body: unknown;
  authorization: string | null;
}

type Responder = (call: RecordedCall) => Response | Promise<Response> | Error;

export const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/**
 * In-memory stand-in for graph.facebook.com. Routes are matched by
 * "METHOD /path-without-version" prefix; queued one-shot responses win.
 */
export class FakeGraph {
  readonly calls: RecordedCall[] = [];
  private readonly once: Array<{ match: string; respond: Responder }> = [];
  private readonly routes: Array<{ match: string; respond: Responder }> = [];
  private seq = 0;

  constructor() {
    this.on('POST /', (call) => (call.path.endsWith('/messages') ? json(200, this.acceptBody()) : json(404, {})));
  }

  acceptBody() {
    this.seq++;
    return { messaging_product: 'whatsapp', contacts: [{ input: 'x', wa_id: 'x' }], messages: [{ id: `wamid.FAKE${this.seq}` }] };
  }

  on(match: string, respond: Responder): this {
    this.routes.unshift({ match, respond });
    return this;
  }

  nextOnce(match: string, respond: Responder): this {
    this.once.push({ match, respond });
    return this;
  }

  messageCalls(): RecordedCall[] {
    return this.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/messages'));
  }

  readonly fetch: FetchLike = async (input, init) => {
    const url = new URL(input);
    const path = url.pathname.replace(/^\/v\d+\.\d+/, '') + url.search;
    const headers = new Headers(init.headers);
    const call: RecordedCall = {
      method: init.method ?? 'GET',
      url: input,
      path,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
      authorization: headers.get('authorization'),
    };
    this.calls.push(call);
    const key = `${call.method} ${path}`;
    const idx = this.once.findIndex((o) => key.startsWith(o.match));
    const handler = idx >= 0 ? this.once.splice(idx, 1)[0]!.respond : this.routes.find((r) => key.startsWith(r.match))?.respond;
    if (!handler) return json(404, { error: { message: `no fake route for ${key}`, code: 100 } });
    const out = await handler(call);
    if (out instanceof Error) throw out;
    return out;
  };
}
