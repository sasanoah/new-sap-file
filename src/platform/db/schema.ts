import type { ColumnType, Generated } from 'kysely';

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type NullableTimestamp = ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
// JSON columns are read as objects and written as JSON strings.
type Json<T extends object> = ColumnType<T, string, string>;

export type Locale = 'ar' | 'en';

export type AccountStatus =
  | 'pending_credentials'
  | 'pending_verification'
  | 'verified'
  | 'verification_failed'
  | 'suspended';

export type MessageStatus =
  | 'received'
  | 'blocked'
  | 'dry_run'
  | 'queued'
  | 'sending'
  | 'accepted'
  | 'sent'
  | 'delivered'
  | 'read'
  | 'failed';

export type HandlingMode = 'ai' | 'human_queue' | 'human';
export type SenderType = 'customer' | 'agent' | 'ai' | 'system';
export type TemplateCategory = 'MARKETING' | 'UTILITY' | 'AUTHENTICATION';
export type CampaignStatus =
  | 'draft'
  | 'pending_approval'
  | 'approved'
  | 'rejected'
  | 'running'
  | 'completed'
  | 'cancelled';
export type JobKind = 'webhook_event' | 'send_message' | 'ai_reply' | 'campaign_launch';

export interface LegalEntitiesTable {
  id: Generated<string>;
  code: string;
  name: string;
  default_locale: Generated<Locale>;
  timezone: Generated<string>;
  status: Generated<'active' | 'suspended'>;
  created_at: Generated<Date>;
}

export interface MetaAppsTable {
  id: Generated<string>;
  meta_app_id: string;
  display_name: string;
  app_secret_ciphertext: string;
  verify_token_sha256: string;
  graph_api_version: string;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface UnroutableWebhookEventsTable {
  id: Generated<string>;
  meta_app_id: string;
  phone_number_id: string | null;
  payload_sha256: string;
  received_at: Generated<Date>;
}

export interface JobQueueTable {
  id: Generated<string>;
  legal_entity_id: string;
  kind: JobKind;
  ref_id: string;
  status: Generated<'pending' | 'running' | 'done' | 'dead'>;
  attempts: Generated<number>;
  max_attempts: Generated<number>;
  run_at: Generated<Date>;
  locked_until: NullableTimestamp;
  last_error: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface VerificationResult {
  checkedAt: string;
  passed: boolean;
  checks: Array<{ name: string; passed: boolean; detail?: string }>;
  phoneNumber?: Record<string, unknown>;
}

export interface WhatsappAccountsTable {
  id: Generated<string>;
  legal_entity_id: string;
  meta_app_id: string;
  waba_id: string;
  phone_number_id: string;
  display_phone_number: string;
  access_token_ciphertext: string | null;
  access_token_fingerprint: string | null;
  status: Generated<AccountStatus>;
  verification: Json<VerificationResult> | null;
  verified_at: NullableTimestamp;
  sending_enabled: Generated<boolean>;
  ai_assistant_enabled: Generated<boolean>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface CustomersTable {
  id: Generated<string>;
  legal_entity_id: string;
  wa_id: string;
  profile_name: string | null;
  preferred_locale: Locale | null;
  opted_out_at: NullableTimestamp;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export type ConsentSource = 'whatsapp_keyword' | 'agent_recorded' | 'web_form' | 'store' | 'meta_error' | 'import';

export interface ConsentRecordsTable {
  id: Generated<string>;
  legal_entity_id: string;
  customer_id: string;
  channel: Generated<'whatsapp'>;
  purpose: 'marketing';
  status: 'granted' | 'revoked';
  source: ConsentSource;
  evidence: string;
  recorded_by_type: 'customer' | 'agent' | 'system';
  recorded_by_id: string | null;
  recorded_at: Generated<Date>;
}

export interface AgentsTable {
  id: Generated<string>;
  legal_entity_id: string;
  subject: string;
  display_name: string;
  languages: Generated<string[]>;
  status: Generated<'available' | 'away' | 'offline'>;
  max_concurrent: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ConversationsTable {
  id: Generated<string>;
  legal_entity_id: string;
  customer_id: string;
  whatsapp_account_id: string;
  status: Generated<'open' | 'closed'>;
  handling_mode: HandlingMode;
  assigned_agent_id: string | null;
  last_inbound_at: NullableTimestamp;
  last_outbound_at: NullableTimestamp;
  service_window_expires_at: NullableTimestamp;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  closed_at: NullableTimestamp;
}

export interface MessageTemplatesTable {
  id: Generated<string>;
  legal_entity_id: string;
  whatsapp_account_id: string;
  meta_template_id: string | null;
  name: string;
  language: string;
  category: TemplateCategory;
  status: string;
  components: Json<unknown[]>;
  body_parameter_count: Generated<number>;
  synced_at: Generated<Date>;
}

export interface CampaignsTable {
  id: Generated<string>;
  legal_entity_id: string;
  whatsapp_account_id: string;
  template_id: string;
  name: string;
  template_parameters: Json<string[]>;
  status: Generated<CampaignStatus>;
  created_by: string;
  submitted_at: NullableTimestamp;
  decided_by: string | null;
  decided_at: NullableTimestamp;
  decision_note: string | null;
  launched_at: NullableTimestamp;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface CampaignRecipientsTable {
  id: Generated<string>;
  legal_entity_id: string;
  campaign_id: string;
  customer_id: string;
  status: Generated<'pending' | 'queued' | 'skipped'>;
  skip_reason: string | null;
  message_id: string | null;
}

export interface MessagesTable {
  id: Generated<string>;
  legal_entity_id: string;
  conversation_id: string;
  customer_id: string;
  whatsapp_account_id: string;
  direction: 'inbound' | 'outbound';
  wamid: string | null;
  type: string;
  text_body: string | null;
  content: Json<Record<string, unknown>>;
  template_id: string | null;
  campaign_id: string | null;
  sender_type: SenderType;
  sender_id: string | null;
  status: MessageStatus;
  status_reason: string | null;
  error: Json<Record<string, unknown>> | null;
  idempotency_key: string | null;
  attempts: Generated<number>;
  occurred_at: Timestamp;
  status_updated_at: Timestamp;
  created_at: Generated<Date>;
}

export interface MessageStatusEventsTable {
  id: Generated<string>;
  legal_entity_id: string;
  message_id: string;
  wamid: string;
  status: string;
  occurred_at: Date | string;
  errors: Json<unknown[]> | null;
  pricing: Json<Record<string, unknown>> | null;
  received_at: Generated<Date>;
}

export interface WebhookEventsTable {
  id: Generated<string>;
  legal_entity_id: string;
  whatsapp_account_id: string;
  field: string;
  dedupe_key: string;
  payload: Json<Record<string, unknown>>;
  status: Generated<'pending' | 'processed' | 'failed'>;
  error: string | null;
  received_at: Generated<Date>;
  processed_at: NullableTimestamp;
}

export interface HandoffsTable {
  id: Generated<string>;
  legal_entity_id: string;
  conversation_id: string;
  requested_by_type: 'customer' | 'ai' | 'agent' | 'system';
  requested_by_id: string | null;
  reason: string;
  from_agent_id: string | null;
  to_agent_id: string | null;
  created_at: Generated<Date>;
}

export interface OutboxEventsTable {
  id: Generated<string>;
  legal_entity_id: string;
  topic: string;
  payload: Json<Record<string, unknown>>;
  created_at: Generated<Date>;
  published_at: NullableTimestamp;
}

export interface AuditLogTable {
  id: Generated<string>;
  legal_entity_id: string | null;
  actor_type: 'user' | 'system' | 'meta' | 'ai' | 'customer';
  actor_id: string | null;
  action: string;
  target_type: string;
  target_id: string | null;
  metadata: Json<Record<string, unknown>>;
  request_id: string | null;
  occurred_at: Generated<Date>;
}

export interface Database {
  legal_entities: LegalEntitiesTable;
  meta_apps: MetaAppsTable;
  unroutable_webhook_events: UnroutableWebhookEventsTable;
  job_queue: JobQueueTable;
  whatsapp_accounts: WhatsappAccountsTable;
  customers: CustomersTable;
  consent_records: ConsentRecordsTable;
  agents: AgentsTable;
  conversations: ConversationsTable;
  message_templates: MessageTemplatesTable;
  campaigns: CampaignsTable;
  campaign_recipients: CampaignRecipientsTable;
  messages: MessagesTable;
  message_status_events: MessageStatusEventsTable;
  webhook_events: WebhookEventsTable;
  handoffs: HandoffsTable;
  outbox_events: OutboxEventsTable;
  audit_log: AuditLogTable;
}
