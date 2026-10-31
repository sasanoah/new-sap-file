import type { Tx } from '../db/database.js';
import type { AuditLogTable } from '../db/schema.js';

export interface Actor {
  type: AuditLogTable['actor_type'];
  id: string | null;
}

export const SYSTEM_ACTOR: Actor = { type: 'system', id: null };

export interface AuditEntry {
  legalEntityId: string | null;
  actor: Actor;
  action: string;
  targetType: string;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
  requestId?: string | null;
}

/**
 * Writes an audit record in the caller's transaction, so the audit row commits
 * or rolls back together with the change it describes. The table is append-only.
 */
export async function audit(trx: Tx, entry: AuditEntry): Promise<void> {
  await trx
    .insertInto('audit_log')
    .values({
      legal_entity_id: entry.legalEntityId,
      actor_type: entry.actor.type,
      actor_id: entry.actor.id,
      action: entry.action,
      target_type: entry.targetType,
      target_id: entry.targetId ?? null,
      metadata: JSON.stringify(entry.metadata ?? {}) as never,
      request_id: entry.requestId ?? null,
    })
    .execute();
}
