// Integration tests need a PostgreSQL server where this user can create databases and roles.
const admin = process.env.TEST_PG_ADMIN_URL ?? 'postgres://postgres@localhost:5432/postgres';
const dbName = process.env.TEST_DB_NAME ?? 'wa_test';

const withDb = (url: string, db: string) => {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
};

export const ADMIN_URL = admin;
export const TEST_DB_NAME = dbName;
export const OWNER_URL = withDb(admin, dbName);
export const APP_PASSWORD = 'wa_app_test_password';
export const APP_URL = (() => {
  const u = new URL(OWNER_URL);
  u.username = 'wa_app';
  u.password = APP_PASSWORD;
  return u.toString();
})();
