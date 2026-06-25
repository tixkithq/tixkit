import { Kysely, PostgresDialect, MysqlDialect } from 'kysely';
import { Pool as PgPool } from 'pg';
import { createPool } from 'mysql2';
import type { DB } from './types/db.js';

export type DbDriver = 'postgres' | 'mysql';

/**
 * Resolve which Kysely dialect to use. `DB_DRIVER` always wins when set;
 * otherwise an explicitly-passed connection URL is detected from its scheme
 * (`mysql://` -> mysql, `postgres://` / `postgresql://` -> postgres) so a
 * single process can talk to both databases (required by the integration
 * test matrix). With no argument, falls back to `DB_DRIVER` then postgres.
 */
export function getDriver(dbUrl?: string): DbDriver {
  const fromEnv = process.env.DB_DRIVER?.toLowerCase();
  if (fromEnv === 'mysql') return 'mysql';
  if (fromEnv === 'postgres') return 'postgres';
  if (dbUrl) {
    if (dbUrl.startsWith('mysql://') || dbUrl.startsWith('mysql2://')) return 'mysql';
    return 'postgres';
  }
  return 'postgres';
}

export function createDb(dbUrl?: string): Kysely<DB> {
  const driver = getDriver(dbUrl);
  const url = dbUrl ?? (driver === 'mysql' ? process.env.DATABASE_URL_MYSQL : process.env.DATABASE_URL);

  if (!url) {
    throw new Error(`Database URL not configured for driver: ${driver}`);
  }

  if (driver === 'mysql') {
    const parsed = new URL(url);
    return new Kysely<DB>({
      dialect: new MysqlDialect({
        pool: createPool({
          host: parsed.hostname,
          port: parsed.port ? Number(parsed.port) : 3306,
          user: decodeURIComponent(parsed.username),
          password: decodeURIComponent(parsed.password),
          database: parsed.pathname.replace(/^\//, ''),
        }),
      }),
    });
  }

  return new Kysely<DB>({
    dialect: new PostgresDialect({
      pool: new PgPool({ connectionString: url }),
    }),
  });
}

export type Database = Kysely<DB>;
