import { afterEach, describe, expect, it } from 'vitest';
import { createDb, getDriver } from '../../client.js';

const originalEnv = { ...process.env };

afterEach(() => {
  process.env.DB_DRIVER = originalEnv.DB_DRIVER;
  process.env.DATABASE_URL = originalEnv.DATABASE_URL;
  process.env.DATABASE_URL_MYSQL = originalEnv.DATABASE_URL_MYSQL;
  process.env.DATABASE_URL_MSSQL = originalEnv.DATABASE_URL_MSSQL;
});

describe('database client configuration', () => {
  it('defaults to PostgreSQL unless DB_DRIVER is mysql', () => {
    delete process.env.DB_DRIVER;
    expect(getDriver()).toBe('postgres');

    process.env.DB_DRIVER = 'mysql';
    expect(getDriver()).toBe('mysql');

    process.env.DB_DRIVER = 'mssql';
    expect(getDriver()).toBe('mssql');

    process.env.DB_DRIVER = 'postgres';
    expect(getDriver()).toBe('postgres');
  });

  it('detects MSSQL URLs when DB_DRIVER is unset', () => {
    delete process.env.DB_DRIVER;

    expect(getDriver('sqlserver://sa:password@localhost/tixkit')).toBe('mssql');
    expect(getDriver('mssql://sa:password@localhost/tixkit')).toBe('mssql');
  });

  it('throws a clear error when the selected driver has no database URL', () => {
    process.env.DB_DRIVER = 'postgres';
    delete process.env.DATABASE_URL;
    expect(() => createDb()).toThrow('Database URL not configured for driver: postgres');

    process.env.DB_DRIVER = 'mysql';
    delete process.env.DATABASE_URL_MYSQL;
    expect(() => createDb()).toThrow('Database URL not configured for driver: mysql');

    process.env.DB_DRIVER = 'mssql';
    delete process.env.DATABASE_URL_MSSQL;
    expect(() => createDb()).toThrow('Database URL not configured for driver: mssql');
  });
});
