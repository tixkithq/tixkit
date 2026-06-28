import { describe, expect, it } from 'vitest';
import {
  buildMssqlMergeUpsert,
  createMssqlDialect,
  mssqlDropTableIfExists,
  mssqlForUpdateTable,
  mssqlObjectIdExists,
  parseMssqlConnectionUrl,
} from '../../dialects/mssql.js';

describe('MSSQL dialect helpers', () => {
  it('parses sqlserver connection URLs for tedious', () => {
    expect(
      parseMssqlConnectionUrl(
        'sqlserver://user%40example:pass%21@db.example.test:14330/tixkit?encrypt=false&trustServerCertificate=true',
      ),
    ).toEqual({
      server: 'db.example.test',
      port: 14330,
      userName: 'user@example',
      password: 'pass!',
      database: 'tixkit',
      encrypt: false,
      trustServerCertificate: true,
    });
  });

  it('constructs a Kysely MSSQL dialect from a connection URL', () => {
    const dialect = createMssqlDialect('mssql://sa:password@localhost/tixkit');

    expect(dialect.createAdapter()).toBeDefined();
    expect(dialect.createQueryCompiler()).toBeDefined();
  });

  it('builds OBJECT_ID guarded drop statements for migrations', () => {
    expect(mssqlObjectIdExists('dbo.checkout_sessions')).toBe(
      "OBJECT_ID(N'dbo.checkout_sessions', N'U') IS NOT NULL",
    );
    expect(mssqlDropTableIfExists('dbo.checkout_sessions')).toBe(
      "IF OBJECT_ID(N'dbo.checkout_sessions', N'U') IS NOT NULL DROP TABLE [dbo].[checkout_sessions];",
    );
  });

  it('builds MERGE upserts with explicit key and update columns', () => {
    expect(
      buildMssqlMergeUpsert({
        table: 'dbo.payment_events',
        keyColumns: ['provider_event_id'],
        insertColumns: ['provider_event_id', 'event_type', 'processed_at'],
        updateColumns: ['processed_at'],
      }),
    ).toBe(
      [
        'MERGE INTO [dbo].[payment_events] AS [target]',
        'USING (SELECT @provider_event_id AS [provider_event_id], @event_type AS [event_type], @processed_at AS [processed_at]) AS [source]',
        'ON [target].[provider_event_id] = [source].[provider_event_id]',
        'WHEN MATCHED THEN UPDATE SET [processed_at] = [source].[processed_at]',
        'WHEN NOT MATCHED THEN INSERT ([provider_event_id], [event_type], [processed_at]) VALUES ([source].[provider_event_id], [source].[event_type], [source].[processed_at]);',
      ].join('\n'),
    );
  });

  it('maps forUpdate table locks to UPDLOCK and HOLDLOCK', () => {
    expect(mssqlForUpdateTable('dbo.inventory_pools', 'pool')).toBe(
      '[dbo].[inventory_pools] AS [pool] WITH (UPDLOCK, HOLDLOCK)',
    );
  });
});
