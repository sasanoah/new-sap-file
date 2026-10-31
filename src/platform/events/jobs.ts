import { sql } from 'kysely';
import type { Db, Tx } from '../db/database.js';
import type { JobKind } from '../db/schema.js';
import { backoffDelayMs, RetryableError } from './retry.js';

export interface Job {
  id: string;
  legal_entity_id: string;
  kind: JobKind;
  ref_id: string;
  attempts: number;
  max_attempts: number;
}

/** Enqueues a job. A second enqueue for an already-active (kind, ref_id) is a no-op. */
export async function enqueue(
  trx: Tx | Db,
  job: { legalEntityId: string; kind: JobKind; refId: string; runAt?: Date; maxAttempts?: number },
): Promise<void> {
  await trx
    .insertInto('job_queue')
    .values({
      legal_entity_id: job.legalEntityId,
      kind: job.kind,
      ref_id: job.refId,
      run_at: job.runAt ?? new Date(),
      max_attempts: job.maxAttempts ?? 8,
    })
    .onConflict((oc) => oc.columns(['kind', 'ref_id']).where('status', 'in', ['pending', 'running']).doNothing())
    .execute();
}

const LOCK_MS = 5 * 60_000;

/** Claims due jobs. Running jobs whose lock expired (crashed worker) are reclaimed. */
export async function claimJobs(db: Db, limit: number, now = new Date()): Promise<Job[]> {
  const result = await sql<Job>`
    UPDATE job_queue SET status = 'running', attempts = attempts + 1,
      locked_until = ${new Date(now.getTime() + LOCK_MS)}, updated_at = now()
    WHERE id IN (
      SELECT id FROM job_queue
      WHERE (status = 'pending' AND run_at <= ${now})
         OR (status = 'running' AND locked_until < ${now})
      ORDER BY run_at
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, legal_entity_id, kind, ref_id, attempts, max_attempts`.execute(db);
  return result.rows;
}

export async function completeJob(db: Db, id: string): Promise<void> {
  await db
    .updateTable('job_queue')
    .set({ status: 'done', locked_until: null, last_error: null, updated_at: new Date() })
    .where('id', '=', id)
    .execute();
}

/**
 * Records a failure. Retryable errors are rescheduled with jittered backoff
 * until max_attempts; everything else (or an exhausted job) goes to 'dead'
 * for an operator to inspect.
 */
export async function failJob(db: Db, job: Job, err: unknown, now = new Date()): Promise<'retry' | 'dead'> {
  const message = err instanceof Error ? err.message : String(err);
  const retryable = err instanceof RetryableError;
  if (retryable && job.attempts < job.max_attempts) {
    const delay = err.retryAfterMs ?? backoffDelayMs(job.attempts);
    await db
      .updateTable('job_queue')
      .set({
        status: 'pending',
        run_at: new Date(now.getTime() + delay),
        locked_until: null,
        last_error: message.slice(0, 2000),
        updated_at: new Date(),
      })
      .where('id', '=', job.id)
      .execute();
    return 'retry';
  }
  await db
    .updateTable('job_queue')
    .set({ status: 'dead', locked_until: null, last_error: message.slice(0, 2000), updated_at: new Date() })
    .where('id', '=', job.id)
    .execute();
  return 'dead';
}
