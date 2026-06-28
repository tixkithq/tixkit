import { describe } from 'vitest';

export type IntegrationDatabaseDriver = 'postgres' | 'mysql';

export function integrationDatabaseDriver(): IntegrationDatabaseDriver {
  return process.env.DB_INTEGRATION_DRIVER === 'mysql' ? 'mysql' : 'postgres';
}

export function integrationDatabaseUrl(): string {
  return integrationDatabaseDriver() === 'mysql'
    ? (process.env.DATABASE_URL_MYSQL ?? '')
    : (process.env.DATABASE_URL ?? '');
}

export function describeWithIntegrationDatabase(name: string, fn: () => void): void {
  const url = integrationDatabaseUrl();
  const driver = integrationDatabaseDriver();
  describe.skipIf(!url)(`${name} (real ${driver})`, fn);
}

export function setIntegrationDatabaseDriver(): string | undefined {
  const previous = process.env.DB_DRIVER;
  process.env.DB_DRIVER = integrationDatabaseDriver();
  return previous;
}

export function restoreDatabaseDriver(previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env.DB_DRIVER;
  } else {
    process.env.DB_DRIVER = previous;
  }
}
