# Group AI OS — WhatsApp Communication Module

A WhatsApp Business integration on the official Meta WhatsApp Cloud API, built as a
reusable module for Group AI OS. Phase 1 serves **Bed Janssen**. Any other legal
entity in the group can register its own phone number on the same infrastructure,
with strict tenant isolation.

* TypeScript (Node 22), Fastify, Kysely, PostgreSQL 16
* A modular monolith: one API process and one background worker
* Arabic and English throughout: keyword handling, system replies, AI replies

The design, schema, API contracts, security model and staged plan are in
**[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

> **Not activated.** No Meta credentials are included and nothing has been sent in
> production. Outbound sending is `disabled` by default. Sending requires a
> live verification against Meta, an explicit platform-admin approval, and
> `WHATSAPP_OUTBOUND_MODE=live` (see [Activation](#activation-checklist)).

## Phase 1 scope

| # | Deliverable | Where |
|---|---|---|
| 1 | WhatsApp Cloud API connector | `src/modules/whatsapp/connector/` |
| 2 | Webhook verification and `X-Hub-Signature-256` validation | `src/modules/whatsapp/webhook/` |
| 3 | Incoming message handling (deduplicated, out-of-order safe) | `src/modules/whatsapp/inbound/` |
| 4 | Outgoing message service (policy-checked, idempotent) | `src/modules/whatsapp/outbound/` |
| 5 | Message status tracking (monotonic, with full history) | `inbound/status-processor.ts` |
| 6 | Customer identification and conversation history | `customers/`, `inbox/` |
| 7 | Multi-agent inbox (queue, claim, assign, capacity- and language-aware routing) | `inbox/`, `http/api-routes.ts` |
| 8 | Human handoff (customer, AI, agent, supervisor) | `inbox/conversations.ts`, `ai/orchestrator.ts` |
| 9 | API credential management (AES-256-GCM, rotation, fingerprints) | `platform/crypto/`, `accounts/` |
| 10 | Error handling, retry with backoff, dead-letter queue, automated tests | `platform/events/`, `test/` |

Compliance rules are enforced in one pure function, `compliance/policy.ts`:

* the 24-hour customer-service window;
* approved templates only;
* a marketing-consent ledger;
* opt-out enforcement (`STOP` / `إيقاف`, and Meta error 131050);
* bulk sending only through campaigns approved by a second person.

## Getting started

```bash
npm install
docker compose up -d                 # PostgreSQL 16 (or bring your own)
cp .env.example .env                 # fill in values; see comments
npm run migrate                      # as DATABASE_OWNER_URL
# give the app role a login once:  ALTER ROLE wa_app LOGIN PASSWORD '...';
npm run dev                          # API on :3000
npm run worker                       # background jobs
```

## Tests

```bash
npm run typecheck
npm test                             # unit + integration
npm run test:unit                    # no database needed
```

Integration tests create a throwaway database named `wa_test` with real
row-level security. By default they connect to
`postgres://postgres@localhost:5432/postgres`; override with
`TEST_PG_ADMIN_URL`. Meta is never contacted: tests use an in-memory fake of the
Graph API.

## Activation checklist

These steps need Bed Janssen operators and real Meta assets. Code can't complete
them.

1. Create or choose the Meta app and WhatsApp Business Account, and add and
   verify the phone number in Meta Business Manager.
2. Create a System User token with `whatsapp_business_messaging` and
   `whatsapp_business_management`, scoped to the WABA.
3. `POST /v1/platform/legal-entities` and `POST /v1/platform/meta-apps` (app
   secret, verify token, Graph API version). Confirm the currently supported
   Graph version with Meta first.
4. In the Meta app, set the webhook URL to
   `https://<host>/webhooks/whatsapp/<metaAppId>` with the same verify token, and
   subscribe to the `messages` and `message_template_status_update` fields.
5. `POST /v1/whatsapp/accounts`, then `PUT …/credentials` with the token.
6. `POST …/verify`. Every check must pass: token scopes, number in WABA,
   number status, and the app subscribed to the WABA.
7. `POST …/templates/sync`, and confirm the templates are `APPROVED`.
8. Optionally run in `WHATSAPP_OUTBOUND_MODE=dry_run` to rehearse end to end
   without sending.
9. A platform admin calls `POST …/sending {"enabled": true}` and the deployment
   switches to `WHATSAPP_OUTBOUND_MODE=live`.
