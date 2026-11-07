import { describe, expect, it } from 'vitest';
import { classifyGraphError, GraphApiError, networkError } from '../../src/modules/whatsapp/connector/errors.js';
import { GraphApiClient } from '../../src/modules/whatsapp/connector/graph-client.js';

describe('classifyGraphError', () => {
  it.each([
    [400, 131047, 'window_closed'],
    [400, 131050, 'recipient_opted_out'],
    [400, 131049, 'ecosystem_limit'],
    [429, 130429, 'retryable'],
    [400, 131056, 'retryable'],
    [400, 80007, 'retryable'],
    [500, 131000, 'retryable'],
    [401, 190, 'auth'],
    [403, 10, 'auth'],
    [400, 132001, 'template'],
    [400, 132000, 'template'],
    [400, 131026, 'recipient'],
    [400, 133010, 'account'],
    [400, 368, 'account'],
    [400, 100, 'invalid_request'],
  ] as const)('HTTP %i code %i → %s', (status, code, expected) => {
    expect(classifyGraphError(status, code)).toBe(expected);
  });
  it('falls back to HTTP status', () => {
    expect(classifyGraphError(503, undefined)).toBe('retryable');
    expect(classifyGraphError(429, undefined)).toBe('retryable');
    expect(classifyGraphError(400, undefined)).toBe('invalid_request');
    expect(classifyGraphError(400, 999999)).toBe('invalid_request');
  });
});

describe('network errors', () => {
  it('treats connection failures as safe to retry', () => {
    const e = networkError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }));
    expect(e.sendState).toBe('not_sent');
    expect(e.retryable).toBe(true);
  });
  it('treats timeouts/resets as ambiguous and never retryable', () => {
    for (const err of [new DOMException('aborted', 'AbortError'), Object.assign(new TypeError('x'), { cause: { code: 'ECONNRESET' } })]) {
      const e = networkError(err);
      expect(e.sendState).toBe('ambiguous');
      expect(e.retryable).toBe(false);
    }
  });
});

describe('GraphApiClient', () => {
  const client = (fetchImpl: (u: string, i: RequestInit) => Promise<Response>) =>
    new GraphApiClient({ baseUrl: 'https://graph.test/', version: 'v23.0', accessToken: 'TOKEN', fetch: fetchImpl });

  it('sends a text message with the documented payload', async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const c = client(async (url, init) => {
      seen = { url, init };
      return new Response(JSON.stringify({ messages: [{ id: 'wamid.1' }], contacts: [{ wa_id: '9665' }] }), { status: 200 });
    });
    await expect(c.sendMessage('123', { type: 'text', to: '9665', text: { body: 'مرحبا' } })).resolves.toEqual({ wamid: 'wamid.1', waId: '9665' });
    expect(seen!.url).toBe('https://graph.test/v23.0/123/messages');
    expect(new Headers(seen!.init.headers).get('authorization')).toBe('Bearer TOKEN');
    expect(JSON.parse(String(seen!.init.body))).toEqual({ messaging_product: 'whatsapp', recipient_type: 'individual', type: 'text', to: '9665', text: { body: 'مرحبا' } });
  });

  it('maps Graph error bodies and Retry-After', async () => {
    const c = client(async () =>
      new Response(JSON.stringify({ error: { message: 'Too many', code: 130429, fbtrace_id: 'TR' } }), { status: 429, headers: { 'retry-after': '7' } }),
    );
    const err = await c.sendMessage('1', { type: 'text', to: '2', text: { body: 'x' } }).catch((e) => e);
    expect(err).toBeInstanceOf(GraphApiError);
    expect(err).toMatchObject({ classification: 'retryable', code: 130429, fbtraceId: 'TR', retryAfterMs: 7000, sendState: 'rejected' });
    expect(err.retryable).toBe(true);
  });

  it('treats a 2xx without a message id as ambiguous', async () => {
    const c = client(async () => new Response('{}', { status: 200 }));
    const err = await c.sendMessage('1', { type: 'text', to: '2', text: { body: 'x' } }).catch((e) => e);
    expect(err).toMatchObject({ sendState: 'ambiguous' });
    expect(err.retryable).toBe(false);
  });

  it('follows template pagination', async () => {
    const pages = [
      { data: [{ id: '1', name: 'a', language: 'ar', status: 'APPROVED', category: 'UTILITY' }], paging: { next: 'n', cursors: { after: 'CUR' } } },
      { data: [{ id: '2', name: 'b', language: 'en', status: 'APPROVED', category: 'MARKETING' }] },
    ];
    const urls: string[] = [];
    const c = client(async (url) => {
      urls.push(url);
      return new Response(JSON.stringify(pages.shift()), { status: 200 });
    });
    expect((await c.listTemplates('W')).map((t) => t.name)).toEqual(['a', 'b']);
    expect(urls[1]).toContain('after=CUR');
  });
});
