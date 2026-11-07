import { Kysely, PostgresDialect, sql, type Transaction } from 'kysely';
import pg from 'pg';
import type { Database } from './schema.js';

// Return timestamptz as Date and bigint ids as strings (default), numerics untouched.
export type Db = Kysely<Database>;
export type Tx = Transaction<Database>;

export function createDb(connectionString: string, max = 10): Db {
  const pool = new pg.Pool({ connectionString, max });
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Runs fn in a transaction scoped to one legal entity. Row-level security
 * policies read app.legal_entity_id, so every query inside sees only that
 * tenant's rows, and inserts for any other tenant are rejected.
 */
export async function withTenant<T>(db: Db, legalEntityId: string, fn: (trx: Tx) => Promise<T>): Promise<T> {
  if (!UUID_RE.test(legalEntityId)) throw new Error('withTenant: legalEntityId must be a UUID');
  return db.transaction().execute(async (trx) => {
    await sql`select set_config('app.legal_entity_id', ${legalEntityId}, true)`.execute(trx);
    return fn(trx);
  });
}

/** Platform-level transaction with no tenant context (tenant tables return no rows). */
export async function withPlatform<T>(db: Db, fn: (trx: Tx) => Promise<T>): Promise<T> {
  return db.transaction().execute(fn);
}
