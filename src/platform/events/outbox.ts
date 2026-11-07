import type { Tx } from '../db/database.js';

/**
 * Transactional outbox. Domain events are written in the same transaction as
 * the state change. Phase 1 only records them; a relay that publishes them to
 * Group AI OS consumers (marking published_at) is planned for Stage 2.
 */
export async function emit(trx: Tx, legalEntityId: string, topic: string, payload: Record<string, unknown>): Promise<void> {
  await trx
    .insertInto('outbox_events')
    .values({ legal_entity_id: legalEntityId, topic, payload: JSON.stringify(payload) as never })
    .execute();
}
