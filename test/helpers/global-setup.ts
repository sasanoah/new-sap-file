import pg from 'pg';
import { migrate } from '../../src/platform/db/migrate.js';
import { ADMIN_URL, APP_PASSWORD, OWNER_URL, TEST_DB_NAME } from './db-urls.js';

export default async function setup(): Promise<void> {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB_NAME} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${TEST_DB_NAME}`);
  } finally {
    await admin.end();
  }
  await migrate(OWNER_URL, () => undefined);
  const owner = new pg.Client({ connectionString: OWNER_URL });
  await owner.connect();
  try {
    await owner.query(`ALTER ROLE wa_app LOGIN PASSWORD '${APP_PASSWORD}'`);
  } finally {
    await owner.end();
  }
}
