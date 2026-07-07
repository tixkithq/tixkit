import { Kysely, PostgresDialect, MysqlDialect, type LogConfig } from 'kysely';
import { Pool as PgPool } from 'pg';
import { createPool } from 'mysql2';
import type { DB } from './types/db.js';
import { createMssqlDialect, createMssqlLimitPlugin } from './dialects/mssql.js';

export type DbDriver = 'postgres' | 'mysql' | 'mssql';

export type DbPoolConfig = {
  min?: number;
  max?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
};

export type CreateDbOptions = {
  pool?: DbPoolConfig;
  log?: LogConfig;
};

function parseOptionalPositiveInteger(name: string, value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  if (!/^[1-9]\d*$/.test(value.trim())) {
    throw new Error(`${name} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function poolEnvName(driver: DbDriver, key: string): string {
  return `${driver.toUpperCase()}_POOL_${key}`;
}

export function resolveDbPoolConfig(driver: DbDriver, overrides: DbPoolConfig = {}): DbPoolConfig {
  const minName = poolEnvName(driver, 'MIN');
  const maxName = poolEnvName(driver, 'MAX');
  const config = {
    min:
      overrides.min ??
      parseOptionalPositiveInteger(minName, process.env[minName]) ??
      parseOptionalPositiveInteger('DB_POOL_MIN', process.env.DB_POOL_MIN),
    max:
      overrides.max ??
      parseOptionalPositiveInteger(maxName, process.env[maxName]) ??
      parseOptionalPositiveInteger('DB_POOL_MAX', process.env.DB_POOL_MAX),
    idleTimeoutMillis:
      overrides.idleTimeoutMillis ??
      parseOptionalPositiveInteger(
        poolEnvName(driver, 'IDLE_TIMEOUT_MS'),
        process.env[poolEnvName(driver, 'IDLE_TIMEOUT_MS')],
      ) ??
      parseOptionalPositiveInteger('DB_POOL_IDLE_TIMEOUT_MS', process.env.DB_POOL_IDLE_TIMEOUT_MS),
    connectionTimeoutMillis:
      overrides.connectionTimeoutMillis ??
      parseOptionalPositiveInteger(
        poolEnvName(driver, 'CONNECTION_TIMEOUT_MS'),
        process.env[poolEnvName(driver, 'CONNECTION_TIMEOUT_MS')],
      ) ??
      parseOptionalPositiveInteger(
        'DB_POOL_CONNECTION_TIMEOUT_MS',
        process.env.DB_POOL_CONNECTION_TIMEOUT_MS,
      ),
  };

  if (config.min !== undefined && config.max !== undefined && config.min > config.max) {
    throw new Error(`${minName} must be less than or equal to ${maxName}`);
  }

  return config;
}

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
  if (fromEnv === 'mssql' || fromEnv === 'sqlserver') return 'mssql';
  if (fromEnv === 'postgres') return 'postgres';
  if (dbUrl) {
    if (dbUrl.startsWith('mysql://') || dbUrl.startsWith('mysql2://')) return 'mysql';
    if (dbUrl.startsWith('mssql://') || dbUrl.startsWith('sqlserver://')) return 'mssql';
    return 'postgres';
  }
  return 'postgres';
}

export function createDb(dbUrl?: string, options: CreateDbOptions = {}): Kysely<DB> {
  const driver = getDriver(dbUrl);
  const poolConfig = resolveDbPoolConfig(driver, options.pool);
  const url =
    dbUrl ??
    (driver === 'mysql'
      ? process.env.DATABASE_URL_MYSQL
      : driver === 'mssql'
        ? process.env.DATABASE_URL_MSSQL
        : process.env.DATABASE_URL);

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
          ...(poolConfig.min !== undefined ? { min: poolConfig.min } : {}),
          ...(poolConfig.max !== undefined ? { connectionLimit: poolConfig.max } : {}),
          ...(poolConfig.idleTimeoutMillis !== undefined
            ? { idleTimeout: poolConfig.idleTimeoutMillis }
            : {}),
          ...(poolConfig.connectionTimeoutMillis !== undefined
            ? { connectTimeout: poolConfig.connectionTimeoutMillis }
            : {}),
        }),
      }),
      log: options.log,
    });
  }

  if (driver === 'mssql') {
    return new Kysely<DB>({
      dialect: createMssqlDialect(url, poolConfig),
      plugins: [createMssqlLimitPlugin()],
      log: options.log,
    });
  }

  return new Kysely<DB>({
    dialect: new PostgresDialect({
      pool: new PgPool({
        connectionString: url,
        ...(poolConfig.min !== undefined ? { min: poolConfig.min } : {}),
        ...(poolConfig.max !== undefined ? { max: poolConfig.max } : {}),
        ...(poolConfig.idleTimeoutMillis !== undefined
          ? { idleTimeoutMillis: poolConfig.idleTimeoutMillis }
          : {}),
        ...(poolConfig.connectionTimeoutMillis !== undefined
          ? { connectionTimeoutMillis: poolConfig.connectionTimeoutMillis }
          : {}),
      }),
    }),
    log: options.log,
  });
}

export type Database = Kysely<DB>;
