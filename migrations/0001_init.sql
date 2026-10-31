-- Group AI OS — WhatsApp module, initial schema.
-- Run as the schema owner. The application connects as role wa_app, which
-- owns nothing and has no BYPASSRLS, so row-level security always applies.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wa_app') THEN
    CREATE ROLE wa_app NOLOGIN NOBYPASSRLS;
  END IF;
END
$$;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Current tenant from the transaction-local setting; NULL when unset.
CREATE OR REPLACE FUNCTION app_current_legal_entity() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.legal_entity_id', true), '')::uuid
$$;

-- ---------------------------------------------------------------- platform

CREATE TABLE legal_entities (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code            text NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9-]{2,64}$'),
  name            text NOT NULL,
  default_locale  text NOT NULL DEFAULT 'ar' CHECK (default_locale IN ('ar', 'en')),
  timezone        text NOT NULL DEFAULT 'Asia/Riyadh',
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE meta_apps (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meta_app_id            text NOT NULL UNIQUE,
  display_name           text NOT NULL,
  app_secret_ciphertext  text NOT NULL,
  verify_token_sha256    text NOT NULL,
  graph_api_version      text NOT NULL CHECK (graph_api_version ~ '^v[0-9]+\.[0-9]+$'),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE unroutable_webhook_events (
  id               bigserial PRIMARY KEY,
  meta_app_id      text NOT NULL,
  phone_number_id  text,
  payload_sha256   text NOT NULL,
  received_at      timestamptz NOT NULL DEFAULT now()
);

-- Background work. Holds ids only (no personal data), so it is not tenant-scoped;
-- workers process each job inside withTenant(job.legal_entity_id).
CREATE TABLE job_queue (
  id               bigserial PRIMARY KEY,
  legal_entity_id  uuid NOT NULL REFERENCES legal_entities(id),
  kind             text NOT NULL CHECK (kind IN ('webhook_event', 'send_message', 'ai_reply', 'campaign_launch')),
  ref_id           uuid NOT NULL,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'dead')),
  attempts         int NOT NULL DEFAULT 0,
  max_attempts     int NOT NULL DEFAULT 8,
  run_at           timestamptz NOT NULL DEFAULT now(),
  locked_until     timestamptz,
  last_error       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX job_queue_due_idx ON job_queue (run_at) WHERE status IN ('pending', 'running');
CREATE UNIQUE INDEX job_queue_active_ref_uq ON job_queue (kind, ref_id) WHERE status IN ('pending', 'running');

-- ------------------------------------------------------------------ tenant

CREATE TABLE whatsapp_accounts (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_entity_id           uuid NOT NULL REFERENCES legal_entities(id),
  meta_app_id               uuid NOT NULL REFERENCES meta_apps(id),
  waba_id                   text NOT NULL,
  phone_number_id           text NOT NULL UNIQUE,
  display_phone_number      text NOT NULL,
  access_token_ciphertext   text,
  access_token_fingerprint  text,
  status                    text NOT NULL DEFAULT 'pending_credentials'
                              CHECK (status IN ('pending_credentials', 'pending_verification', 'verified', 'verification_failed', 'suspended')),
  verification              jsonb,
  verified_at               timestamptz,
  sending_enabled           boolean NOT NULL DEFAULT false,
  ai_assistant_enabled      boolean NOT NULL DEFAULT false,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sending_requires_verified CHECK (NOT sending_enabled OR status = 'verified'),
  UNIQUE (legal_entity_id, id)
);

CREATE TABLE customers (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_entity_id   uuid NOT NULL REFERENCES legal_entities(id),
  wa_id             text NOT NULL CHECK (wa_id ~ '^[0-9]{6,20}$'),
  profile_name      text,
  preferred_locale  text CHECK (preferred_locale IN ('ar', 'en')),
  opted_out_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (legal_entity_id, wa_id),
  UNIQUE (legal_entity_id, id)
);

CREATE TABLE consent_records (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_entity_id   uuid NOT NULL,
  customer_id       uuid NOT NULL,
  channel           text NOT NULL DEFAULT 'whatsapp' CHECK (channel = 'whatsapp'),
  purpose           text NOT NULL CHECK (purpose IN ('marketing')),
  status            text NOT NULL CHECK (status IN ('granted', 'revoked')),
  source            text NOT NULL CHECK (source IN ('whatsapp_keyword', 'agent_recorded', 'web_form', 'store', 'meta_error', 'import')),
  evidence          text NOT NULL,
  recorded_by_type  text NOT NULL CHECK (recorded_by_type IN ('customer', 'agent', 'system')),
  recorded_by_id    text,
  recorded_at       timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (legal_entity_id, customer_id) REFERENCES customers(legal_entity_id, id)
);
CREATE INDEX consent_records_customer_idx ON consent_records (customer_id, purpose, recorded_at DESC);

CREATE TABLE agents (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_entity_id   uuid NOT NULL REFERENCES legal_entities(id),
  subject           text NOT NULL,
  display_name      text NOT NULL,
  languages         text[] NOT NULL DEFAULT ARRAY['ar', 'en'],
  status            text NOT NULL DEFAULT 'offline' CHECK (status IN ('available', 'away', 'offline')),
  max_concurrent    int NOT NULL DEFAULT 8 CHECK (max_concurrent BETWEEN 1 AND 100),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (legal_entity_id, subject),
  UNIQUE (legal_entity_id, id)
);

CREATE TABLE conversations (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_entity_id            uuid NOT NULL,
  customer_id                uuid NOT NULL,
  whatsapp_account_id        uuid NOT NULL,
  status                     text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  handling_mode              text NOT NULL CHECK (handling_mode IN ('ai', 'human_queue', 'human')),
  assigned_agent_id          uuid,
  last_inbound_at            timestamptz,
  last_outbound_at           timestamptz,
  service_window_expires_at  timestamptz,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  closed_at                  timestamptz,
  FOREIGN KEY (legal_entity_id, customer_id) REFERENCES customers(legal_entity_id, id),
  FOREIGN KEY (legal_entity_id, whatsapp_account_id) REFERENCES whatsapp_accounts(legal_entity_id, id),
  FOREIGN KEY (legal_entity_id, assigned_agent_id) REFERENCES agents(legal_entity_id, id),
  CONSTRAINT human_mode_needs_agent CHECK (handling_mode <> 'human' OR assigned_agent_id IS NOT NULL),
  UNIQUE (legal_entity_id, id)
);
-- One open conversation per customer per phone number.
CREATE UNIQUE INDEX conversations_one_open_uq ON conversations (legal_entity_id, customer_id, whatsapp_account_id) WHERE status = 'open';
CREATE INDEX conversations_queue_idx ON conversations (legal_entity_id, status, handling_mode, updated_at DESC);

CREATE TABLE message_templates (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_entity_id      uuid NOT NULL,
  whatsapp_account_id  uuid NOT NULL,
  meta_template_id     text,
  name                 text NOT NULL,
  language             text NOT NULL,
  category             text NOT NULL CHECK (category IN ('MARKETING', 'UTILITY', 'AUTHENTICATION')),
  status               text NOT NULL,
  components           jsonb NOT NULL DEFAULT '[]',
  body_parameter_count int NOT NULL DEFAULT 0,
  synced_at            timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (legal_entity_id, whatsapp_account_id) REFERENCES whatsapp_accounts(legal_entity_id, id),
  UNIQUE (whatsapp_account_id, name, language),
  UNIQUE (legal_entity_id, id)
);

CREATE TABLE campaigns (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_entity_id       uuid NOT NULL,
  whatsapp_account_id   uuid NOT NULL,
  template_id           uuid NOT NULL,
  name                  text NOT NULL,
  template_parameters   jsonb NOT NULL DEFAULT '[]',
  status                text NOT NULL DEFAULT 'draft'
                          CHECK (status IN ('draft', 'pending_approval', 'approved', 'rejected', 'running', 'completed', 'cancelled')),
  created_by            text NOT NULL,
  submitted_at          timestamptz,
  decided_by            text,
  decided_at            timestamptz,
  decision_note         text,
  launched_at           timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (legal_entity_id, whatsapp_account_id) REFERENCES whatsapp_accounts(legal_entity_id, id),
  FOREIGN KEY (legal_entity_id, template_id) REFERENCES message_templates(legal_entity_id, id),
  CONSTRAINT approver_differs_from_creator CHECK (decided_by IS NULL OR decided_by <> created_by),
  CONSTRAINT approved_needs_decider CHECK (status NOT IN ('approved', 'running', 'completed') OR decided_by IS NOT NULL),
  UNIQUE (legal_entity_id, id)
);

CREATE TABLE campaign_recipients (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_entity_id  uuid NOT NULL,
  campaign_id      uuid NOT NULL,
  customer_id      uuid NOT NULL,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'queued', 'skipped')),
  skip_reason      text,
  message_id       uuid,
  FOREIGN KEY (legal_entity_id, campaign_id) REFERENCES campaigns(legal_entity_id, id),
  FOREIGN KEY (legal_entity_id, customer_id) REFERENCES customers(legal_entity_id, id),
  UNIQUE (campaign_id, customer_id)
);

CREATE TABLE messages (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_entity_id     uuid NOT NULL,
  conversation_id     uuid NOT NULL,
  customer_id         uuid NOT NULL,
  whatsapp_account_id uuid NOT NULL,
  direction           text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  wamid               text,
  type                text NOT NULL,
  text_body           text,
  content             jsonb NOT NULL DEFAULT '{}',
  template_id         uuid,
  campaign_id         uuid,
  sender_type         text NOT NULL CHECK (sender_type IN ('customer', 'agent', 'ai', 'system')),
  sender_id           text,
  status              text NOT NULL CHECK (status IN ('received', 'blocked', 'dry_run', 'queued', 'sending', 'accepted', 'sent', 'delivered', 'read', 'failed')),
  status_reason       text,
  error               jsonb,
  idempotency_key     text,
  attempts            int NOT NULL DEFAULT 0,
  occurred_at         timestamptz NOT NULL DEFAULT now(),
  status_updated_at   timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (legal_entity_id, conversation_id) REFERENCES conversations(legal_entity_id, id),
  FOREIGN KEY (legal_entity_id, customer_id) REFERENCES customers(legal_entity_id, id),
  CHECK (direction = 'outbound' OR wamid IS NOT NULL),
  CHECK (direction = 'inbound' OR idempotency_key IS NOT NULL),
  UNIQUE (legal_entity_id, id)
);
CREATE UNIQUE INDEX messages_wamid_uq ON messages (legal_entity_id, wamid) WHERE wamid IS NOT NULL;
CREATE UNIQUE INDEX messages_idempotency_uq ON messages (legal_entity_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX messages_conversation_idx ON messages (conversation_id, occurred_at);

ALTER TABLE campaign_recipients
  ADD FOREIGN KEY (legal_entity_id, message_id) REFERENCES messages(legal_entity_id, id);

CREATE TABLE message_status_events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_entity_id  uuid NOT NULL,
  message_id       uuid NOT NULL,
  wamid            text NOT NULL,
  status           text NOT NULL,
  occurred_at      timestamptz NOT NULL,
  errors           jsonb,
  pricing          jsonb,
  received_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (legal_entity_id, message_id) REFERENCES messages(legal_entity_id, id),
  UNIQUE (message_id, status, occurred_at)
);

CREATE TABLE webhook_events (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_entity_id      uuid NOT NULL REFERENCES legal_entities(id),
  whatsapp_account_id  uuid NOT NULL,
  field                text NOT NULL,
  dedupe_key           text NOT NULL,
  payload              jsonb NOT NULL,
  status               text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processed', 'failed')),
  error                text,
  received_at          timestamptz NOT NULL DEFAULT now(),
  processed_at         timestamptz,
  FOREIGN KEY (legal_entity_id, whatsapp_account_id) REFERENCES whatsapp_accounts(legal_entity_id, id),
  UNIQUE (legal_entity_id, dedupe_key)
);

CREATE TABLE handoffs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_entity_id   uuid NOT NULL,
  conversation_id   uuid NOT NULL,
  requested_by_type text NOT NULL CHECK (requested_by_type IN ('customer', 'ai', 'agent', 'system')),
  requested_by_id   text,
  reason            text NOT NULL,
  from_agent_id     uuid,
  to_agent_id       uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (legal_entity_id, conversation_id) REFERENCES conversations(legal_entity_id, id)
);

CREATE TABLE outbox_events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_entity_id  uuid NOT NULL REFERENCES legal_entities(id),
  topic            text NOT NULL,
  payload          jsonb NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  published_at     timestamptz
);
CREATE INDEX outbox_unpublished_idx ON outbox_events (created_at) WHERE published_at IS NULL;

CREATE TABLE audit_log (
  id               bigserial PRIMARY KEY,
  legal_entity_id  uuid REFERENCES legal_entities(id),
  actor_type       text NOT NULL CHECK (actor_type IN ('user', 'system', 'meta', 'ai', 'customer')),
  actor_id         text,
  action           text NOT NULL,
  target_type      text NOT NULL,
  target_id        text,
  metadata         jsonb NOT NULL DEFAULT '{}',
  request_id       text,
  occurred_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_target_idx ON audit_log (legal_entity_id, target_type, target_id, occurred_at DESC);

CREATE OR REPLACE FUNCTION audit_log_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END
$$;
CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_immutable();

-- ------------------------------------------------------- row-level security

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'whatsapp_accounts', 'customers', 'consent_records', 'agents', 'conversations',
    'message_templates', 'campaigns', 'campaign_recipients', 'messages',
    'message_status_events', 'webhook_events', 'handoffs', 'outbox_events'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (legal_entity_id = app_current_legal_entity()) '
      'WITH CHECK (legal_entity_id = app_current_legal_entity())', t);
  END LOOP;
END
$$;

-- Audit rows: tenant rows visible within that tenant; platform rows (NULL) only
-- outside any tenant context.
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_select ON audit_log FOR SELECT
  USING (legal_entity_id IS NOT DISTINCT FROM app_current_legal_entity());
CREATE POLICY audit_insert ON audit_log FOR INSERT
  WITH CHECK (legal_entity_id IS NOT DISTINCT FROM app_current_legal_entity());

-- Webhook routing: the single cross-tenant read. Returns ids only.
CREATE OR REPLACE FUNCTION wa_route_phone_number(p_phone_number_id text)
RETURNS TABLE (legal_entity_id uuid, whatsapp_account_id uuid, meta_app_id text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT a.legal_entity_id, a.id, m.meta_app_id
  FROM whatsapp_accounts a JOIN meta_apps m ON m.id = a.meta_app_id
  WHERE a.phone_number_id = p_phone_number_id
$$;
REVOKE ALL ON FUNCTION wa_route_phone_number(text) FROM PUBLIC;

-- Template status webhooks carry only the WABA id.
CREATE OR REPLACE FUNCTION wa_route_waba(p_waba_id text)
RETURNS TABLE (legal_entity_id uuid, whatsapp_account_id uuid, meta_app_id text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT a.legal_entity_id, a.id, m.meta_app_id
  FROM whatsapp_accounts a JOIN meta_apps m ON m.id = a.meta_app_id
  WHERE a.waba_id = p_waba_id
$$;
REVOKE ALL ON FUNCTION wa_route_waba(text) FROM PUBLIC;

-- ------------------------------------------------------------------ grants

GRANT USAGE ON SCHEMA public TO wa_app;
GRANT SELECT, INSERT, UPDATE ON
  legal_entities, meta_apps, whatsapp_accounts, customers, agents, conversations,
  message_templates, campaigns, campaign_recipients, messages, webhook_events,
  outbox_events, job_queue
TO wa_app;
GRANT SELECT, INSERT ON consent_records, message_status_events, handoffs, audit_log, unroutable_webhook_events TO wa_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO wa_app;
GRANT EXECUTE ON FUNCTION wa_route_phone_number(text), wa_route_waba(text), app_current_legal_entity() TO wa_app;
