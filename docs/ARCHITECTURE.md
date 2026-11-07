# Group AI OS — WhatsApp Communication Module

Phase 1 tenant: **Bed Janssen**. The module is built so that any other legal entity
in the group can register its own WhatsApp phone number(s) on the same
infrastructure, with strict legal-entity isolation.

> Status: Phase 1 implementation. **No Meta credentials are bundled and no
> production activation has been performed.** Outbound sending is disabled by
> default and stays disabled until the verification gates in
> [§7](#7-production-activation-gates) pass.

---

## 1. Repository baseline

The repository was empty when this work started: no commits, no branches, no
existing authentication, auditing, database or event conventions. There was
nothing to reuse, so this module defines those concerns behind narrow
interfaces (ports) that Group AI OS can later replace with its shared
implementations:

| Concern | Phase 1 implementation | Port to swap later |
|---|---|---|
| Staff authentication | JWT verification (JWKS URL or HS256 dev secret) | `src/platform/auth/verifier.ts` |
| Authorization | Role checks per legal entity, carried in token claims | `src/platform/auth/roles.ts` |
| Audit | Append-only `audit_log` table | `src/platform/audit/audit.ts` |
| Events | Transactional outbox (`outbox_events`) + DB job queue. Events are recorded; a relay to Group AI OS consumers is Stage 2. | `src/platform/events/` |
| Secrets | AES-256-GCM envelope encryption, versioned keys | `src/platform/crypto/key-provider.ts` (KMS) |
| AI | `AiAssistant` port + Claude adapter | `src/modules/whatsapp/ai/` |

## 2. Technical architecture

A **modular monolith**: one deployable, two process roles.

```
                   ┌────────────────────── API process (Fastify) ─────────────────────┐
 Meta Cloud API ──►│ /webhooks/whatsapp/:metaAppId                                    │
  (webhooks)       │   verify HMAC → route by phone_number_id → store event → 200     │
                   │                                                                  │
 Staff UI / GAOS ─►│ /v1/inbox  /v1/customers  /v1/whatsapp  /v1/campaigns  /v1/audit │
  (JWT)            │   auth → tenant context (RLS) → module services                  │
                   └──────────────────────────────┬───────────────────────────────────┘
                                                  │ PostgreSQL (RLS per legal entity)
                   ┌──────────────────────────────┴───────────────────────────────────┐
                   │ Worker process: job_queue (FOR UPDATE SKIP LOCKED)               │
                   │   webhook_event → inbound/status processing                      │
                   │   send_message  → compliance re-check → Graph API (retry/backoff)│
                   │   ai_reply      → AI assistant → outbound service / handoff      │
                   └──────────────────────────────┬───────────────────────────────────┘
                                                  ▼
                                    graph.facebook.com/{version}
```

### Module layout

```
src/
  platform/            cross-cutting, reusable by other GAOS modules
    config/            env parsing (zod)
    db/                Kysely, schema types, migrations runner, withTenant()
    auth/              JWT verifier, roles, Fastify auth hook
    audit/             audit writer
    crypto/            envelope encryption, key provider
    events/            outbox + job queue + retry policy
    http/              error model, request ids
  modules/whatsapp/
    connector/         Graph API client, error classification
    webhook/           verification, signature, payload parsing, ingest
    inbound/           message + status processors
    outbound/          outbound service, send worker
    compliance/        pure policy engine (24h window, consent, opt-out, templates)
    customers/         identification, consent ledger
    inbox/             conversations, assignment, handoff, agents
    templates/         template registry + sync
    accounts/          phone-number registration, credentials, verification
    campaigns/         draft → approval → launch (human approval required)
    ai/                AI port, Claude adapter, orchestrator
    i18n/              Arabic/English system messages and keyword detection
```

## 3. Tenant isolation

* The tenant is the **legal entity** (`legal_entities.id`). Every tenant-owned
  table carries `legal_entity_id NOT NULL`.
* **Row-level security** is enabled and forced on every tenant table. The policy
  compares `legal_entity_id` with the transaction-local setting
  `app.legal_entity_id`.
* The application connects as `wa_app`, a role that does not own the tables
  and has no `BYPASSRLS`. Migrations run as the owner role.
* All tenant data access goes through `withTenant(db, legalEntityId, fn)`. It
  opens a transaction and runs `set_config('app.legal_entity_id', …, true)`.
  Code that forgets the context sees zero rows; it cannot see another tenant's
  rows.
* The only cross-tenant lookups are:
  * routing an inbound webhook by `phone_number_id` →
    `wa_route_phone_number()`, a `SECURITY DEFINER` function returning ids only;
  * the job queue (`job_queue`), which holds ids and no personal data.
* Each legal entity has its own WhatsApp Business Account / phone numbers and
  its own encrypted access token. Meta apps (`meta_apps`) can be shared by
  several entities or dedicated to one.
* API requests name the tenant in `X-Legal-Entity-Id`. It must match an entry
  in the caller's token claims; platform admins are the only cross-tenant role.

## 4. Database schema

Plain SQL migrations live in `migrations/`. These are the main tables:

| Table | Scope | Purpose |
|---|---|---|
| `legal_entities` | platform | Tenants (code, name, default locale, timezone) |
| `meta_apps` | platform | Meta app id, encrypted app secret, verify-token hash, Graph version |
| `whatsapp_accounts` | tenant | WABA id, phone_number_id, encrypted token, status, verification result, `sending_enabled`, `ai_assistant_enabled` |
| `customers` | tenant | `wa_id`, phone, profile name, preferred locale, `opted_out_at` |
| `consent_records` | tenant | Append-only consent ledger (purpose, granted/revoked, source, evidence, actor) |
| `conversations` | tenant | Status, handling mode (ai/human/unassigned), assignee, `last_inbound_at`, service-window expiry |
| `messages` | tenant | Direction, wamid, type, content, status, sender, idempotency key, error, attempts |
| `message_status_events` | tenant | Every status webhook received (history) |
| `webhook_events` | tenant | Raw verified change payloads, deduplicated by content hash |
| `unroutable_webhook_events` | platform | Hash + phone_number_id only (no personal data) |
| `message_templates` | tenant | Synced templates (name, language, category, status, components) |
| `agents` | tenant | Staff roster (subject, name, languages, availability, capacity) |
| `handoffs` | tenant | AI→human and human→human transfer history |
| `campaigns` / `campaign_recipients` | tenant | Draft → pending approval → approved → running; approver ≠ creator |
| `audit_log` | tenant (or platform) | Append-only; `UPDATE`/`DELETE` revoked and blocked by trigger |
| `outbox_events` | tenant | Domain events for Group AI OS consumers |
| `job_queue` | platform (ids only) | Background work with retry/backoff and a dead-letter state |

The column-level definitions are in `migrations/0001_init.sql`.

## 5. API contracts

All `/v1` routes need `Authorization: Bearer <jwt>` and `X-Legal-Entity-Id`.
Errors use one shape: `{ "error": { "code", "message", "details?" }, "requestId" }`.

### Webhooks (Meta → us)
| Method | Path | Notes |
|---|---|---|
| GET | `/webhooks/whatsapp/:metaAppId` | `hub.mode=subscribe`; constant-time verify-token check; echoes `hub.challenge` |
| POST | `/webhooks/whatsapp/:metaAppId` | Requires a valid `X-Hub-Signature-256` over the raw body. Returns 200 once the events are stored, before they are processed. |

### Platform (role `platform_admin`, no tenant header)
| Method | Path | Body |
|---|---|---|
| POST | `/v1/platform/legal-entities` | `{ code, name, defaultLocale, timezone }` |
| POST | `/v1/platform/meta-apps` | `{ metaAppId, displayName, appSecret, verifyToken, graphApiVersion }` |

### WhatsApp accounts (role `entity_admin`)
| Method | Path | Notes |
|---|---|---|
| POST | `/v1/whatsapp/accounts` | Register `{ metaAppId, wabaId, phoneNumberId, displayPhoneNumber }`. Status `pending_credentials`. |
| PUT | `/v1/whatsapp/accounts/:id/credentials` | `{ accessToken }`. Encrypted at rest; the API only ever returns a fingerprint. |
| POST | `/v1/whatsapp/accounts/:id/verify` | Live checks against Meta (token, scopes, phone number, WABA subscription). Records the result; never enables sending. |
| POST | `/v1/whatsapp/accounts/:id/sending` | `{ enabled }`. Enabling needs a `verified` account **and** role `platform_admin`. |
| POST | `/v1/whatsapp/accounts/:id/ai-assistant` | `{ enabled }` |
| GET | `/v1/whatsapp/accounts` | Lists accounts (no secrets) |
| POST | `/v1/whatsapp/accounts/:id/templates/sync` | Pulls templates from Meta |
| GET | `/v1/whatsapp/templates` | Lists the template registry |

### Inbox (roles `agent`, `supervisor`)
| Method | Path | Notes |
|---|---|---|
| GET | `/v1/inbox/conversations?status=&mine=` | Paginated queue |
| GET | `/v1/inbox/conversations/:id` | Conversation, customer, messages, service-window state |
| POST | `/v1/inbox/conversations/:id/claim` | Assign to self (fails if owned by another agent) |
| POST | `/v1/inbox/conversations/:id/assign` | `{ agentId }` (supervisor) |
| POST | `/v1/inbox/conversations/:id/handoff` | `{ reason, toAgentId? }` |
| POST | `/v1/inbox/conversations/:id/return-to-ai` | |
| POST | `/v1/inbox/conversations/:id/close` | |
| POST | `/v1/inbox/conversations/:id/messages` | `{ idempotencyKey, text }` or `{ idempotencyKey, template: { name, language, parameters[] } }` → `202` with message, or `422` with the policy violation |
| PUT | `/v1/inbox/agents/me` | `{ status, displayName?, languages? }` |

### Customers
| Method | Path | Notes |
|---|---|---|
| GET | `/v1/customers/:id` | Profile, consent state, conversations |
| GET | `/v1/customers/:id/consents` | Ledger |
| POST | `/v1/customers/:id/consents` | `{ purpose: "marketing", status: "granted"\|"revoked", source, evidence }` |

### Campaigns (human approval required)
| Method | Path | Role |
|---|---|---|
| POST | `/v1/campaigns` | `entity_admin`: `{ name, whatsappAccountId, templateId, customerIds[], templateParameters[] }` |
| POST | `/v1/campaigns/:id/submit` | creator |
| POST | `/v1/campaigns/:id/approve` | `campaign_approver`, must differ from the creator |
| POST | `/v1/campaigns/:id/reject` | `campaign_approver` |
| POST | `/v1/campaigns/:id/launch` | `entity_admin`; approved campaigns only |

### Audit
| Method | Path | Role |
|---|---|---|
| GET | `/v1/audit?targetType=&targetId=&limit=` | `entity_admin`, `supervisor` |

## 6. Compliance rules (enforced in `compliance/policy.ts`)

Outbound messages pass through one pure function, `evaluateOutboundPolicy`.
It runs when a message is accepted and again just before the network call.

1. **Global outbound mode**: `WHATSAPP_OUTBOUND_MODE` is `disabled` (default),
   `dry_run`, or `live`. Anything other than `live` never calls Meta.
2. **Account gate**: the account must be `verified` with `sending_enabled = true`.
3. **24-hour customer-service window**: free-form messages need
   `now < last_inbound_at + 24h`. Outside the window, only approved templates
   are allowed.
4. **Templates**: a template must exist locally with status `APPROVED`, in the
   requested language, with the right number of body parameters.
5. **Marketing**: `MARKETING` templates are only sent through an **approved
   campaign**, and only to customers whose latest marketing consent is
   `granted` and who have not opted out. A direct agent send of a marketing
   template is always blocked.
6. **Opt-out**: inbound keywords (`STOP`, `UNSUBSCRIBE`, `إيقاف`, `الغاء`, …) and
   Meta error `131050` record an opt-out and revoke marketing consent.
   Opted-out customers get no business-initiated messages. A reply inside the
   window is allowed only if the customer wrote again after opting out.
7. **No bulk without approval**: the only bulk path is a campaign. It needs an
   approver who is not the creator, has a maximum audience size
   (`CAMPAIGN_MAX_RECIPIENTS`), and is throttled.
8. Every blocked attempt is persisted (`status = blocked`, with a reason) and
   audited.

## 7. Production activation gates

No production message goes out until **all** of these hold:

1. An operator stores a real access token (`PUT …/credentials`).
2. `POST …/verify` passes, live against Meta:
   * `debug_token` shows a valid token with `whatsapp_business_messaging` and
     `whatsapp_business_management` scopes;
   * the phone number belongs to the WABA, and Meta reports its status and
     verified name;
   * the app is subscribed to the WABA's webhooks.
3. A `platform_admin` explicitly enables sending on that account.
4. The deployment sets `WHATSAPP_OUTBOUND_MODE=live`.

Each gate is audited. No code path, test, or seed fakes a `verified` result
against production.

## 8. Security requirements

* **Webhook authenticity**: HMAC-SHA256 of the raw body with the Meta app
  secret, compared in constant time. Unsigned or mis-signed requests get 401
  and nothing is stored.
* **Idempotency**:
  * webhook changes are deduplicated by SHA-256 of their canonical content;
  * inbound messages are unique on `(legal_entity_id, wamid)`;
  * status events are unique on `(message_id, status, occurred_at)`;
  * outbound messages are unique on `(legal_entity_id, idempotency_key)`.
* **Ambiguous sends**: if the HTTP request may have reached Meta (a timeout
  after send), the message is marked `failed` with `ambiguous_delivery` and is
  **not** retried automatically. This prevents duplicate customer messages.
* **Secrets**: access tokens and app secrets are encrypted with AES-256-GCM
  under a versioned master key (`CREDENTIALS_MASTER_KEY`). Verify tokens are
  stored as SHA-256 hashes. Secrets are never logged (pino redaction) and never
  returned by the API.
* **AuthN/Z**: JWTs are checked for signature, `iss`, `aud` and `exp`. The
  per-entity roles in the token decide which tenant headers a caller may use.
* **Audit**: every administrative, compliance and messaging action writes an
  `audit_log` row in the same transaction. The table is append-only.
* **Data minimisation**: unroutable webhooks keep only a hash. Media is
  referenced by Meta media id and is not downloaded in Phase 1.
* **Transport**: TLS terminates at the load balancer, with HSTS. Body limit is
  1 MB.

## 9. AI assistant

* The `AiAssistant` port returns
  `{ action: "reply" | "handoff", text, confidence, language, reason }`.
* `ClaudeAssistant` uses the Anthropic SDK with structured JSON output and
  server-side refusal fallback. A refusal, low confidence, a request for a
  human, or a schema failure all result in a **handoff to a human**, never a
  guessed reply.
* AI replies go through the same outbound policy as human replies, so the AI
  cannot send outside the 24-hour window or send templates.
* It is off by default for each account (`ai_assistant_enabled = false`) and
  needs `ANTHROPIC_API_KEY`.

## 10. Staged implementation plan

| Stage | Scope | Status |
|---|---|---|
| 0 | Architecture, schema, contracts, security (this document) | Done |
| 1 | Phase 1 deliverables 1–10: connector, webhooks, inbound, outbound, status, customers, inbox, handoff, credentials, retries/tests | Implemented in this change |
| 1b | Activation for Bed Janssen: create Meta app/WABA, store credentials, run verification, register webhook URL, sync templates, enable sending | **Needs Bed Janssen operators and real Meta credentials** |
| 2 | Outbox relay to Group AI OS event bus, staff inbox UI, media download to object storage, real-time updates (SSE), SLA timers, canned replies (AR/EN) | Planned |
| 3 | Group rollout: self-service onboarding of other legal entities, per-entity Meta apps, KMS key provider, audit hash chain | Planned |
| 4 | AI: knowledge-base retrieval, evaluation set, agent-assist drafts, analytics | Planned |

## 11. Operations

* `npm run migrate` runs as the DB owner (`DATABASE_OWNER_URL`). The app runs
  as `wa_app` (`DATABASE_URL`).
* `npm start` runs the API and `npm run worker` runs the background worker.
  Both are stateless and horizontally scalable; the job queue uses
  `SKIP LOCKED`.
* Jobs that exhaust their retries move to `dead`; operators re-queue them after
  investigating.
* The Graph API version is configured per Meta app. Confirm the currently
  supported version with Meta before activation.
