import { classifyGraphError, GraphApiError, networkError } from './errors.js';

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface GraphClientOptions {
  baseUrl: string;
  version: string;
  accessToken: string;
  timeoutMs?: number;
  fetch?: FetchLike;
}

export interface SendResult {
  wamid: string;
  waId?: string;
}

export interface PhoneNumberInfo {
  id: string;
  display_phone_number?: string;
  verified_name?: string;
  code_verification_status?: string;
  quality_rating?: string;
  name_status?: string;
  status?: string;
  platform_type?: string;
  throughput?: { level?: string };
}

export interface DebugTokenInfo {
  is_valid: boolean;
  app_id?: string;
  type?: string;
  expires_at?: number;
  scopes?: string[];
  granular_scopes?: Array<{ scope: string; target_ids?: string[] }>;
  error?: { message?: string };
}

export interface GraphTemplate {
  id: string;
  name: string;
  language: string;
  status: string;
  category: string;
  components?: unknown[];
}

/** Outbound message payload accepted by POST /{phone-number-id}/messages. */
export type OutboundPayload =
  | { type: 'text'; to: string; text: { body: string; preview_url?: boolean } }
  | {
      type: 'template';
      to: string;
      template: {
        name: string;
        language: { code: string };
        components?: Array<{ type: 'body'; parameters: Array<{ type: 'text'; text: string }> }>;
      };
    };

/**
 * Minimal, dependency-free client for the official WhatsApp Cloud API
 * (graph.facebook.com). One instance per phone number / access token.
 */
export class GraphApiClient {
  private readonly fetchImpl: FetchLike;

  constructor(private readonly opts: GraphClientOptions) {
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
  }

  async sendMessage(phoneNumberId: string, payload: OutboundPayload): Promise<SendResult> {
    const body = { messaging_product: 'whatsapp', recipient_type: 'individual', ...payload };
    const res = await this.request<{ messages?: Array<{ id: string }>; contacts?: Array<{ wa_id: string }> }>(
      'POST',
      `/${encodeURIComponent(phoneNumberId)}/messages`,
      body,
    );
    const wamid = res.messages?.[0]?.id;
    if (!wamid) {
      // Meta answered 2xx but without an id: we cannot know whether it will be delivered.
      throw new GraphApiError('Graph API response missing message id', 200, 'unknown', 'ambiguous');
    }
    return { wamid, waId: res.contacts?.[0]?.wa_id };
  }

  async getPhoneNumber(phoneNumberId: string): Promise<PhoneNumberInfo> {
    const fields = 'display_phone_number,verified_name,code_verification_status,quality_rating,name_status,status,platform_type,throughput';
    return this.request('GET', `/${encodeURIComponent(phoneNumberId)}?fields=${fields}`);
  }

  async listPhoneNumbers(wabaId: string): Promise<Array<{ id: string }>> {
    const res = await this.request<{ data: Array<{ id: string }> }>('GET', `/${encodeURIComponent(wabaId)}/phone_numbers?fields=id`);
    return res.data ?? [];
  }

  async getSubscribedApps(wabaId: string): Promise<Array<{ whatsapp_business_api_data?: { id?: string } }>> {
    const res = await this.request<{ data: Array<{ whatsapp_business_api_data?: { id?: string } }> }>(
      'GET',
      `/${encodeURIComponent(wabaId)}/subscribed_apps`,
    );
    return res.data ?? [];
  }

  /** Inspects the account token. Requires an app access token ("{app-id}|{app-secret}"). */
  async debugToken(appAccessToken: string): Promise<DebugTokenInfo> {
    const qs = new URLSearchParams({ input_token: this.opts.accessToken });
    const res = await this.request<{ data: DebugTokenInfo }>('GET', `/debug_token?${qs.toString()}`, undefined, appAccessToken);
    return res.data;
  }

  async listTemplates(wabaId: string): Promise<GraphTemplate[]> {
    const out: GraphTemplate[] = [];
    let path: string | undefined =
      `/${encodeURIComponent(wabaId)}/message_templates?fields=id,name,language,status,category,components&limit=100`;
    for (let page = 0; path && page < 50; page++) {
      const res: { data: GraphTemplate[]; paging?: { next?: string; cursors?: { after?: string } } } = await this.request('GET', path);
      out.push(...(res.data ?? []));
      const after = res.paging?.next ? res.paging.cursors?.after : undefined;
      path = after
        ? `/${encodeURIComponent(wabaId)}/message_templates?fields=id,name,language,status,category,components&limit=100&after=${encodeURIComponent(after)}`
        : undefined;
    }
    return out;
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown, tokenOverride?: string): Promise<T> {
    const url = `${this.opts.baseUrl.replace(/\/$/, '')}/${this.opts.version}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 15_000);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: {
          authorization: `Bearer ${tokenOverride ?? this.opts.accessToken}`,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      throw networkError(err);
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = {};
    }
    if (!res.ok) {
      const e = (json as { error?: { message?: string; code?: number; error_subcode?: number; fbtrace_id?: string } }).error ?? {};
      const retryAfter = Number(res.headers.get('retry-after'));
      throw new GraphApiError(
        e.message ?? `Graph API HTTP ${res.status}`,
        res.status,
        classifyGraphError(res.status, e.code),
        'rejected',
        e.code,
        e.error_subcode,
        e.fbtrace_id,
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined,
      );
    }
    return json as T;
  }
}
