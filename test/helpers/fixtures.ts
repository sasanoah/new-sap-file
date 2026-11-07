import { randomBytes, randomInt } from 'node:crypto';
import { SignJWT } from 'jose';
import pg from 'pg';
import pino from 'pino';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { OffsetClock } from '../../src/platform/clock.js';
import { JwtVerifier } from '../../src/platform/auth/verifier.js';
import type { EntityRole } from '../../src/platform/auth/roles.js';
import { StaticKeyProvider } from '../../src/platform/crypto/key-provider.js';
import { SecretBox } from '../../src/platform/crypto/secrets.js';
import { createDb, withTenant, type Db } from '../../src/platform/db/database.js';
import type { AiAssistant } from '../../src/modules/whatsapp/ai/assistant.js';
import { accessTokenAad, appSecretAad } from '../../src/modules/whatsapp/accounts/credentials.js';
import type { OutboundMode } from '../../src/modules/whatsapp/compliance/policy.js';
import type { WhatsAppConfig, WhatsAppDeps } from '../../src/modules/whatsapp/context.js';
import { sha256Hex } from '../../src/platform/crypto/secrets.js';
import { signBody } from '../../src/modules/whatsapp/webhook/signature.js';
import { drainJobs } from '../../src/modules/whatsapp/worker.js';
import { APP_URL, OWNER_URL } from './db-urls.js';
import { FakeGraph } from './fake-graph.js';

export const JWT_SECRET = 'test-secret-test-secret-test-secret-123456';
export const ISSUER = 'https://idp.test';
export const AUDIENCE = 'group-ai-os';
const MASTER_KEY = randomBytes(32).toString('base64');

let sharedDb: Db | undefined;
let ownerPool: pg.Pool | undefined;

export function appDb(): Db {
  sharedDb ??= createDb(APP_URL, 5);
  return sharedDb;
}

/** Owner connection: bypasses RLS. Only for test setup/teardown and assertions about raw state. */
export function ownerQuery<T extends pg.QueryResultRow = Record<string, unknown>>(text: string, params: unknown[] = []) {
  ownerPool ??= new pg.Pool({ connectionString: OWNER_URL, max: 2 });
  return ownerPool.query<T>(text, params);
}

export async function closeAll() {
  await sharedDb?.destroy();
  await ownerPool?.end();
  sharedDb = undefined;
  ownerPool = undefined;
}

export interface Harness {
  deps: WhatsAppDeps;
  graph: FakeGraph;
  clock: OffsetClock;
  app: FastifyInstance;
  drain: () => ReturnType<typeof drainJobs>;
}

export async function makeHarness(opts: { outboundMode?: OutboundMode; ai?: AiAssistant | null; config?: Partial<WhatsAppConfig> } = {}): Promise<Harness> {
  const graph = new FakeGraph();
  const clock = new OffsetClock();
  const deps: WhatsAppDeps = {
    db: appDb(),
    clock,
    secrets: new SecretBox(new StaticKeyProvider('test', MASTER_KEY)),
    log: pino({ level: 'silent' }),
    ai: opts.ai ?? null,
    fetch: graph.fetch,
    config: {
      outboundMode: opts.outboundMode ?? 'disabled',
      graphBaseUrl: 'https://graph.test',
      graphTimeoutMs: 2000,
      campaignMaxRecipients: 100,
      campaignSendIntervalMs: 0,
      aiMinConfidence: 0.7,
      ...opts.config,
    },
  };
  const app = await buildApp(deps, new JwtVerifier({ issuer: ISSUER, audience: AUDIENCE, hs256Secret: JWT_SECRET }));
  // Clean queue so each test only processes its own jobs.
  await ownerQuery('DELETE FROM job_queue');
  return { deps, graph, clock, app, drain: () => drainJobs(deps) };
}

export interface Tenant {
  legalEntityId: string;
  code: string;
  metaAppId: string;
  metaAppRowId: string;
  appSecret: string;
  verifyToken: string;
  accountId: string;
  phoneNumberId: string;
  wabaId: string;
}

const digits = (n: number) => Array.from({ length: n }, () => randomInt(0, 10)).join('');

/**
 * Seeds a legal entity with its own Meta app and phone number, directly as owner.
 * accountState controls how far through activation the number is.
 */
export async function seedTenant(
  deps: WhatsAppDeps,
  opts: { name?: string; accountState?: 'unverified' | 'verified_enabled'; aiEnabled?: boolean; metaApp?: Pick<Tenant, 'metaAppId' | 'metaAppRowId' | 'appSecret' | 'verifyToken'> } = {},
): Promise<Tenant> {
  const code = `le-${digits(8)}`;
  const le = (await ownerQuery<{ id: string }>(`INSERT INTO legal_entities (code, name) VALUES ($1, $2) RETURNING id`, [code, opts.name ?? 'Bed Janssen'])).rows[0]!.id;

  let app = opts.metaApp;
  if (!app) {
    const metaAppId = digits(15);
    const appSecret = randomBytes(16).toString('hex');
    const verifyToken = randomBytes(16).toString('hex');
    const metaAppRowId = crypto.randomUUID();
    await ownerQuery(
      `INSERT INTO meta_apps (id, meta_app_id, display_name, app_secret_ciphertext, verify_token_sha256, graph_api_version) VALUES ($1,$2,$3,$4,$5,'v23.0')`,
      [metaAppRowId, metaAppId, 'Test app', deps.secrets.encrypt(appSecret, appSecretAad(metaAppRowId)), sha256Hex(verifyToken)],
    );
    app = { metaAppId, metaAppRowId, appSecret, verifyToken };
  }

  const accountId = crypto.randomUUID();
  const phoneNumberId = digits(15);
  const wabaId = digits(15);
  const verified = opts.accountState === 'verified_enabled';
  await ownerQuery(
    `INSERT INTO whatsapp_accounts (id, legal_entity_id, meta_app_id, waba_id, phone_number_id, display_phone_number,
       access_token_ciphertext, access_token_fingerprint, status, sending_enabled, ai_assistant_enabled)
     VALUES ($1,$2,$3,$4,$5,'+966 50 000 0000',$6,'sha256:test',$7,$8,$9)`,
    [
      accountId, le, app.metaAppRowId, wabaId, phoneNumberId,
      deps.secrets.encrypt('EAAG-test-access-token-0000000000', accessTokenAad(accountId)),
      verified ? 'verified' : 'pending_verification', verified, opts.aiEnabled ?? false,
    ],
  );
  const { metaAppId, metaAppRowId, appSecret, verifyToken } = app;
  return { legalEntityId: le, code, metaAppId, metaAppRowId, appSecret, verifyToken, accountId, phoneNumberId, wabaId };
}

export async function seedTemplate(
  deps: WhatsAppDeps,
  t: Tenant,
  tpl: { name: string; language?: string; category?: 'MARKETING' | 'UTILITY' | 'AUTHENTICATION'; status?: string; bodyText?: string },
) {
  const body = tpl.bodyText ?? 'Hello {{1}}';
  const params = new Set([...body.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1])).size;
  return withTenant(deps.db, t.legalEntityId, (trx) =>
    trx
      .insertInto('message_templates')
      .values({
        legal_entity_id: t.legalEntityId,
        whatsapp_account_id: t.accountId,
        name: tpl.name,
        language: tpl.language ?? 'ar',
        category: tpl.category ?? 'UTILITY',
        status: tpl.status ?? 'APPROVED',
        components: JSON.stringify([{ type: 'BODY', text: body }]),
        body_parameter_count: params,
      })
      .returningAll()
      .executeTakeFirstOrThrow(),
  );
}

export async function token(claims: { sub: string; legalEntities?: Record<string, EntityRole[]>; platformRoles?: string[]; name?: string }) {
  return new SignJWT({ legal_entities: claims.legalEntities ?? {}, platform_roles: claims.platformRoles ?? [], name: claims.name })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(new TextEncoder().encode(JWT_SECRET));
}

export async function authHeaders(t: Tenant, sub: string, roles: EntityRole[], platformRoles: string[] = []) {
  return {
    authorization: `Bearer ${await token({ sub, legalEntities: { [t.legalEntityId]: roles }, platformRoles })}`,
    'x-legal-entity-id': t.legalEntityId,
  };
}

// ------------------------------------------------------------- webhook payloads

export function inboundTextPayload(t: Tenant, opts: { from: string; text: string; wamid?: string; timestamp?: Date; name?: string }) {
  const ts = Math.floor((opts.timestamp ?? new Date()).getTime() / 1000);
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: t.wabaId,
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '966500000000', phone_number_id: t.phoneNumberId },
              contacts: [{ profile: { name: opts.name ?? 'Customer' }, wa_id: opts.from }],
              messages: [{ from: opts.from, id: opts.wamid ?? `wamid.IN${digits(12)}`, timestamp: String(ts), type: 'text', text: { body: opts.text } }],
            },
          },
        ],
      },
    ],
  };
}

export function statusPayload(t: Tenant, statuses: Array<{ wamid: string; status: string; at: Date; errors?: unknown[]; recipient?: string }>) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: t.wabaId,
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '966500000000', phone_number_id: t.phoneNumberId },
              statuses: statuses.map((s) => ({
                id: s.wamid,
                status: s.status,
                timestamp: String(Math.floor(s.at.getTime() / 1000)),
                recipient_id: s.recipient ?? '966500000001',
                ...(s.errors ? { errors: s.errors } : {}),
              })),
            },
          },
        ],
      },
    ],
  };
}

export async function postWebhook(h: Harness, t: Pick<Tenant, 'metaAppId' | 'appSecret'>, payload: unknown, signature?: string) {
  const body = JSON.stringify(payload);
  return h.app.inject({
    method: 'POST',
    url: `/webhooks/whatsapp/${t.metaAppId}`,
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature ?? signBody(body, t.appSecret) },
    payload: body,
  });
}

/** Delivers an inbound text and processes it; returns the conversation id. */
export async function receiveText(h: Harness, t: Tenant, from: string, text: string, opts: { wamid?: string; timestamp?: Date } = {}) {
  const res = await postWebhook(h, t, inboundTextPayload(t, { from, text, ...opts, timestamp: opts.timestamp ?? h.clock.now() }));
  if (res.statusCode !== 200) throw new Error(`webhook failed: ${res.statusCode} ${res.body}`);
  await h.drain();
  const conv = await withTenant(h.deps.db, t.legalEntityId, (trx) =>
    trx
      .selectFrom('conversations as c')
      .innerJoin('customers as cu', 'cu.id', 'c.customer_id')
      .select(['c.id', 'c.customer_id'])
      .where('cu.wa_id', '=', from)
      .where('c.status', '=', 'open')
      .executeTakeFirstOrThrow(),
  );
  return { conversationId: conv.id, customerId: conv.customer_id };
}

export const randomWaId = () => `9665${digits(8)}`;
