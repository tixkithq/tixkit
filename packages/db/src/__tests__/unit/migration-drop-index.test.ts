import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

const migrationDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../migrations');
const migrateSourcePath = resolve(dirname(fileURLToPath(import.meta.url)), '../../migrate.ts');
const turboConfigPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../../turbo.json',
);
const oauthGrantsMigrationPath = resolve(migrationDir, '0013_oauth_grants.ts');
const marketingIntegrationsMigrationPath = resolve(migrationDir, '0014_marketing_integrations.ts');
const marketingIntegrationsUniqueMigrationPath = resolve(
  migrationDir,
  '0015_marketing_integrations_unique.ts',
);
const nullableWebhookDeliveryEndpointMigrationPath = resolve(
  migrationDir,
  '0022_nullable_webhook_delivery_endpoint.ts',
);
const eventsBrandSlugScopeMigrationPath = resolve(migrationDir, '0023_events_brand_slug_scope.ts');
const webhookDeliveryEndpointHistoryIndexMigrationPath = resolve(
  migrationDir,
  '0024_webhook_delivery_endpoint_history_index.ts',
);
const paymentAccountsUniqueMigrationPath = resolve(migrationDir, '0025_payment_accounts_unique.ts');
const webhookDeliveryAttemptIdentityMigrationPath = resolve(
  migrationDir,
  '0026_webhook_delivery_attempt_identity.ts',
);
const webhookDeliveryReplayIdentityMigrationPath = resolve(
  migrationDir,
  '0027_webhook_delivery_replay_identity.ts',
);
const originalDbDriver = process.env.DB_DRIVER;

type MarketingIntegrationSeedRow = {
  id: string;
  event_id: string | null;
  provider: string;
  updated_at: string;
};

type PaymentAccountSeedRow = {
  id: string;
  organization_id: string;
  provider: string;
  provider_account_id: string;
  updated_at: string;
};

type BrandSeedRow = {
  id: string;
  payment_account_id: string | null;
};

type PaymentIntentSeedRow = {
  id: string;
  payment_account_id: string | null;
};

type WebhookDeliverySeedRow = {
  id: string;
  endpoint_id?: string | null;
  event_id: string;
  requested_endpoint_id?: string;
  delivery_key?: string;
  attempt: number;
  status: string;
  created_at: string;
};

type CreatedIndex = {
  indexName: string;
  tableName: string;
  columns: string[];
  unique: boolean;
};

class FakeCreateIndexBuilder {
  private tableName = '';
  private columnNames: string[] = [];
  private isUnique = false;

  constructor(
    private readonly db: { createIndex(createdIndex: CreatedIndex): void },
    private readonly indexName: string,
  ) {}

  on(tableName: string) {
    this.tableName = tableName;
    return this;
  }

  columns(columnNames: string[]) {
    this.columnNames = [...columnNames];
    return this;
  }

  unique() {
    this.isUnique = true;
    return this;
  }

  async execute(): Promise<void> {
    this.db.createIndex({
      indexName: this.indexName,
      tableName: this.tableName,
      columns: this.columnNames,
      unique: this.isUnique,
    });
  }
}

class FakePaymentAccountsDb {
  readonly createdIndexes: CreatedIndex[] = [];
  readonly rawSqlStatements: string[] = [];
  brands: BrandSeedRow[];
  paymentIntents: PaymentIntentSeedRow[];
  rows: PaymentAccountSeedRow[];
  readonly schema = {
    createIndex: (indexName: string) => new FakeCreateIndexBuilder(this, indexName),
    alterTable: (_tableName: string) => ({
      addColumn: (_columnName: string, _dataType: string, _callback: unknown) => ({
        execute: async () => undefined,
      }),
      dropColumn: (_columnName: string) => ({
        execute: async () => undefined,
      }),
    }),
    dropIndex: (indexName: string) => ({
      on: (tableName: string) => ({
        ifExists: () => ({
          execute: async () => {
            this.createdIndexes.push({
              indexName,
              tableName,
              columns: [],
              unique: false,
            });
          },
        }),
      }),
    }),
  };

  constructor(
    rows: PaymentAccountSeedRow[],
    options: {
      brands?: BrandSeedRow[];
      paymentIntents?: PaymentIntentSeedRow[];
    } = {},
  ) {
    this.rows = [...rows];
    this.brands = [...(options.brands ?? [])];
    this.paymentIntents = [...(options.paymentIntents ?? [])];
  }

  executeRawSql(statement: string): void {
    this.rawSqlStatements.push(statement);

    const duplicateKey = this.paymentAccountDuplicateKey(statement);
    if (!duplicateKey) {
      return;
    }

    if (statement.includes('update brands')) {
      this.remapBrandsFromDuplicatePaymentAccounts(duplicateKey);
    }

    if (statement.includes('update payment_intents')) {
      this.remapPaymentIntentsFromDuplicatePaymentAccounts(duplicateKey);
    }

    if (
      statement.includes('delete payment_accounts') ||
      statement.includes('delete from payment_accounts')
    ) {
      this.deleteDuplicatePaymentAccounts(duplicateKey);
    }
  }

  createIndex(createdIndex: CreatedIndex): void {
    if (
      createdIndex.unique &&
      createdIndex.tableName === 'payment_accounts' &&
      createdIndex.columns.join('|') === 'organization_id|provider'
    ) {
      this.assertUniqueOrganizationProvider();
    }

    if (
      createdIndex.unique &&
      createdIndex.tableName === 'payment_accounts' &&
      createdIndex.columns.join('|') === 'provider|provider_account_id'
    ) {
      this.assertUniqueProviderAccount();
    }

    this.createdIndexes.push(createdIndex);
  }

  private paymentAccountDuplicateKey(
    statement: string,
  ): 'organization-provider' | 'provider-account' | null {
    if (statement.includes('partition by provider, provider_account_id')) {
      return 'provider-account';
    }

    if (statement.includes('partition by organization_id, provider')) {
      return 'organization-provider';
    }

    return null;
  }

  private remapBrandsFromDuplicatePaymentAccounts(
    duplicateKey: 'organization-provider' | 'provider-account',
  ): void {
    const canonicalIdsByDuplicateId = this.canonicalIdsByDuplicateId(duplicateKey);

    this.brands = this.brands.map((brand) => ({
      ...brand,
      payment_account_id:
        brand.payment_account_id === null
          ? null
          : (canonicalIdsByDuplicateId.get(brand.payment_account_id) ?? brand.payment_account_id),
    }));
  }

  private remapPaymentIntentsFromDuplicatePaymentAccounts(
    duplicateKey: 'organization-provider' | 'provider-account',
  ): void {
    const canonicalIdsByDuplicateId = this.canonicalIdsByDuplicateId(duplicateKey);

    this.paymentIntents = this.paymentIntents.map((intent) => ({
      ...intent,
      payment_account_id:
        intent.payment_account_id === null
          ? null
          : (canonicalIdsByDuplicateId.get(intent.payment_account_id) ?? intent.payment_account_id),
    }));
  }

  private deleteDuplicatePaymentAccounts(
    duplicateKey: 'organization-provider' | 'provider-account',
  ): void {
    const canonicalIdsByDuplicateId = this.canonicalIdsByDuplicateId(duplicateKey);

    this.rows = this.rows.filter((row) => !canonicalIdsByDuplicateId.has(row.id));
  }

  private canonicalIdsByDuplicateId(
    duplicateKey: 'organization-provider' | 'provider-account',
  ): Map<string, string> {
    const canonicalIdsByDuplicateId = new Map<string, string>();
    const rowsByDuplicateKey = new Map<string, PaymentAccountSeedRow[]>();

    for (const row of this.rows) {
      const key =
        duplicateKey === 'provider-account'
          ? JSON.stringify([row.provider, row.provider_account_id])
          : JSON.stringify([row.organization_id, row.provider]);
      const rows = rowsByDuplicateKey.get(key) ?? [];
      rows.push(row);
      rowsByDuplicateKey.set(key, rows);
    }

    for (const rows of rowsByDuplicateKey.values()) {
      // eslint-disable-next-line unicorn/no-array-sort -- ES2023 toSorted is not available in this package's TS lib target.
      const [canonicalRow] = [...rows].sort((a, b) => {
        const paymentIntentReferenceDifference =
          Number(this.hasPaymentIntent(b.id)) - Number(this.hasPaymentIntent(a.id));
        if (paymentIntentReferenceDifference !== 0) return paymentIntentReferenceDifference;

        const updatedAtDifference = Date.parse(b.updated_at) - Date.parse(a.updated_at);

        return updatedAtDifference === 0 ? b.id.localeCompare(a.id) : updatedAtDifference;
      });

      for (const row of rows) {
        if (canonicalRow && row.id !== canonicalRow.id) {
          canonicalIdsByDuplicateId.set(row.id, canonicalRow.id);
        }
      }
    }

    return canonicalIdsByDuplicateId;
  }

  private hasPaymentIntent(paymentAccountId: string): boolean {
    return this.paymentIntents.some((intent) => intent.payment_account_id === paymentAccountId);
  }

  private assertUniqueOrganizationProvider(): void {
    const seenKeys = new Set<string>();

    for (const row of this.rows) {
      const key = JSON.stringify([row.organization_id, row.provider]);

      if (seenKeys.has(key)) {
        throw new Error(`duplicate payment account survived for ${key}`);
      }

      seenKeys.add(key);
    }
  }

  private assertUniqueProviderAccount(): void {
    const seenKeys = new Set<string>();

    for (const row of this.rows) {
      const key = JSON.stringify([row.provider, row.provider_account_id]);

      if (seenKeys.has(key)) {
        throw new Error(`duplicate provider account survived for ${key}`);
      }

      seenKeys.add(key);
    }
  }
}

class FakeMarketingIntegrationsDb {
  readonly createdIndexes: CreatedIndex[] = [];
  readonly rawSqlStatements: string[] = [];
  rows: MarketingIntegrationSeedRow[];
  readonly schema = {
    createIndex: (indexName: string) => new FakeCreateIndexBuilder(this, indexName),
  };

  constructor(rows: MarketingIntegrationSeedRow[]) {
    this.rows = [...rows];
  }

  executeRawSql(statement: string): void {
    this.rawSqlStatements.push(statement);

    if (statement.includes('ranked_marketing_integrations')) {
      this.dedupeMarketingIntegrations();
    }
    if (statement.includes('create unique index uniq_marketing_integrations_event_provider')) {
      this.assertUniqueMarketingIntegrations();
    }
  }

  createIndex(createdIndex: CreatedIndex): void {
    if (
      createdIndex.unique &&
      createdIndex.tableName === 'marketing_integrations' &&
      createdIndex.columns.join('|') === 'event_id|provider'
    ) {
      this.assertUniqueMarketingIntegrations();
    }

    this.createdIndexes.push(createdIndex);
  }

  private dedupeMarketingIntegrations(): void {
    const canonicalIds = new Set<string>();
    const rowsByEventProvider = new Map<string, MarketingIntegrationSeedRow[]>();

    for (const row of this.rows) {
      if (row.event_id === null) {
        canonicalIds.add(row.id);
        continue;
      }
      const key = JSON.stringify([row.event_id, row.provider]);
      const rows = rowsByEventProvider.get(key) ?? [];
      rows.push(row);
      rowsByEventProvider.set(key, rows);
    }

    for (const rows of rowsByEventProvider.values()) {
      // eslint-disable-next-line unicorn/no-array-sort -- ES2023 toSorted is not available in this package's TS lib target.
      const [canonicalRow] = [...rows].sort((a, b) => {
        const updatedAtDifference = Date.parse(b.updated_at) - Date.parse(a.updated_at);

        return updatedAtDifference === 0 ? b.id.localeCompare(a.id) : updatedAtDifference;
      });

      if (canonicalRow) {
        canonicalIds.add(canonicalRow.id);
      }
    }

    this.rows = this.rows.filter((row) => canonicalIds.has(row.id));
  }

  private assertUniqueMarketingIntegrations(): void {
    const seenKeys = new Set<string>();

    for (const row of this.rows) {
      if (row.event_id === null) continue;
      const key = JSON.stringify([row.event_id, row.provider]);

      if (seenKeys.has(key)) {
        throw new Error(`duplicate marketing integration survived for ${key}`);
      }

      seenKeys.add(key);
    }
  }
}

class FakeWebhookDeliveriesDb {
  readonly createdIndexes: CreatedIndex[] = [];
  readonly rawSqlStatements: string[] = [];
  requestedEndpointColumnExists: boolean;
  rows: WebhookDeliverySeedRow[];
  readonly schema = {
    createIndex: (indexName: string) => new FakeCreateIndexBuilder(this, indexName),
    alterTable: (_tableName: string) => ({
      addColumn: (_columnName: string, _dataType: string, _callback: unknown) => ({
        execute: async () => undefined,
      }),
      dropColumn: (_columnName: string) => ({
        execute: async () => undefined,
      }),
    }),
    dropIndex: (indexName: string) => ({
      on: (tableName: string) => ({
        ifExists: () => ({
          execute: async () => {
            this.createdIndexes.push({
              indexName,
              tableName,
              columns: [],
              unique: false,
            });
          },
        }),
      }),
    }),
  };

  constructor(
    rows: WebhookDeliverySeedRow[],
    options: { requestedEndpointColumnExists?: boolean } = {},
  ) {
    this.rows = [...rows];
    this.requestedEndpointColumnExists = options.requestedEndpointColumnExists ?? true;
  }

  selectFrom(tableName: string) {
    expect(tableName).toBe('webhook_deliveries');
    let includeReplayRows = false;
    let includeNullEndpointRows = false;
    const rows = this.rows;
    const query = {
      select(columnName: string) {
        expect(columnName).toBe('id');
        return query;
      },
      where(columnName: string, operator: string, value: string | null) {
        if (columnName === 'delivery_key') {
          expect(operator).toBe('!=');
          expect(value).toBe('live');
          includeReplayRows = true;
          return query;
        }
        expect(columnName).toBe('endpoint_id');
        expect(operator).toBe('is');
        expect(value).toBeNull();
        includeNullEndpointRows = true;
        return query;
      },
      limit(limit: number) {
        expect(limit).toBe(1);
        return query;
      },
      async executeTakeFirst() {
        if (includeNullEndpointRows) return rows.find((row) => row.endpoint_id === null);
        return includeReplayRows
          ? rows.find((row) => (row.delivery_key ?? 'live') !== 'live')
          : rows[0];
      },
    };
    return query;
  }

  executeRawSql(statement: string): { rows: Array<{ column_name: string }> } {
    this.rawSqlStatements.push(statement);

    if (statement.includes('information_schema.columns')) {
      return {
        rows: this.requestedEndpointColumnExists ? [{ column_name: 'requested_endpoint_id' }] : [],
      };
    }

    if (statement.includes('add column requested_endpoint_id')) {
      this.requestedEndpointColumnExists = true;
      return { rows: [] };
    }

    if (statement.includes('update webhook_deliveries set requested_endpoint_id = endpoint_id')) {
      this.rows = this.rows.map((row) => ({
        ...row,
        requested_endpoint_id: row.endpoint_id ?? row.requested_endpoint_id,
      }));
      return { rows: [] };
    }

    if (statement.includes('ranked_webhook_deliveries')) {
      this.dedupeWebhookDeliveries();
    }

    return { rows: [] };
  }

  createIndex(createdIndex: CreatedIndex): void {
    if (
      createdIndex.unique &&
      createdIndex.tableName === 'webhook_deliveries' &&
      createdIndex.columns.join('|') === 'event_id|requested_endpoint_id|attempt'
    ) {
      this.assertUniqueDeliveryAttempts();
    }

    if (
      createdIndex.unique &&
      createdIndex.tableName === 'webhook_deliveries' &&
      createdIndex.columns.join('|') === 'event_id|requested_endpoint_id|attempt|delivery_key'
    ) {
      this.assertUniqueDeliveryKeys();
    }

    this.createdIndexes.push(createdIndex);
  }

  private dedupeWebhookDeliveries(): void {
    const canonicalIds = new Set<string>();
    const rowsByAttempt = new Map<string, WebhookDeliverySeedRow[]>();

    for (const row of this.rows) {
      const key = JSON.stringify([row.event_id, row.requested_endpoint_id, row.attempt]);
      const rows = rowsByAttempt.get(key) ?? [];
      rows.push(row);
      rowsByAttempt.set(key, rows);
    }

    for (const rows of rowsByAttempt.values()) {
      // eslint-disable-next-line unicorn/no-array-sort -- ES2023 toSorted is not available in this package's TS lib target.
      const [canonicalRow] = [...rows].sort((a, b) => {
        const statusPriorityDifference = statusPriority(b.status) - statusPriority(a.status);
        if (statusPriorityDifference !== 0) return statusPriorityDifference;

        const createdAtDifference = Date.parse(b.created_at) - Date.parse(a.created_at);
        return createdAtDifference === 0 ? b.id.localeCompare(a.id) : createdAtDifference;
      });

      if (canonicalRow) {
        canonicalIds.add(canonicalRow.id);
      }
    }

    this.rows = this.rows.filter((row) => canonicalIds.has(row.id));
  }

  private assertUniqueDeliveryAttempts(): void {
    const seenKeys = new Set<string>();

    for (const row of this.rows) {
      const key = JSON.stringify([row.event_id, row.requested_endpoint_id, row.attempt]);

      if (seenKeys.has(key)) {
        throw new Error(`duplicate webhook delivery survived for ${key}`);
      }

      seenKeys.add(key);
    }
  }

  private assertUniqueDeliveryKeys(): void {
    const seenKeys = new Set<string>();

    for (const row of this.rows) {
      const key = JSON.stringify([
        row.event_id,
        row.requested_endpoint_id,
        row.attempt,
        row.delivery_key ?? 'live',
      ]);

      if (seenKeys.has(key)) {
        throw new Error(`duplicate webhook delivery key survived for ${key}`);
      }

      seenKeys.add(key);
    }
  }
}

function statusPriority(status: string): number {
  if (status === 'delivered') return 4;
  if (status === 'dead_lettered') return 3;
  if (status === 'failed') return 2;
  return 1;
}

function fakeSql(strings: TemplateStringsArray, ...values: unknown[]) {
  const statement = strings.reduce((sqlStatement, chunk, index) => {
    const value = index < values.length ? String(values[index]) : '';

    return `${sqlStatement}${chunk}${value}`;
  }, '');

  return {
    async execute(db: { executeRawSql(statement: string): unknown }): Promise<unknown> {
      return db.executeRawSql(statement);
    },
  };
}

afterEach(() => {
  process.env.DB_DRIVER = originalDbDriver;
  vi.doUnmock('kysely');
  vi.resetModules();
});

function quotedNamePattern(methodName: 'createIndex' | 'dropIndex') {
  return new RegExp(
    `\\.${methodName}\\(\\s*['"\`]([^'"\`]+)['"\`]\\s*\\)([\\s\\S]*?)\\.execute\\(\\)`,
    'g',
  );
}

function collectCreatedIndexTables(source: string) {
  const indexTables = new Map<string, string>();
  const createIndexPattern = quotedNamePattern('createIndex');

  for (const match of source.matchAll(createIndexPattern)) {
    const [, indexName, builderChain] = match;
    const tableMatch = builderChain.match(/\.on\(\s*['"`]([^'"`]+)['"`]\s*\)/);

    if (indexName && tableMatch?.[1]) {
      indexTables.set(indexName, tableMatch[1]);
    }
  }

  return indexTables;
}

function migrationMethodSource(source: string, methodName: 'up' | 'down') {
  const match = new RegExp(
    `async ${methodName}\\(db\\): Promise<void> \\{([\\s\\S]*?)\\n  \\},`,
  ).exec(source);

  expect(match?.[1]).toBeTypeOf('string');

  return match?.[1] ?? '';
}

function expectSourceOrder(source: string, first: string, second: string) {
  const firstIndex = source.indexOf(first);
  const secondIndex = source.indexOf(second);

  expect(firstIndex).toBeGreaterThanOrEqual(0);
  expect(secondIndex).toBeGreaterThan(firstIndex);
}

function sourceBetween(source: string, start: string, end: string) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);

  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);

  return source.slice(startIndex, endIndex);
}

describe('migration helper MSSQL dialect safety', () => {
  it('uses SQL Server-compatible table adoption and initial migration SQL', () => {
    const source = readFileSync(migrateSourcePath, 'utf8');
    const tableExistsSource = sourceBetween(
      source,
      'async function tableExists',
      'async function ensureMigrationTable',
    );
    const recordInitialMigrationSource = sourceBetween(
      source,
      'async function recordInitialMigration',
      'async function adoptExistingInitialSchema',
    );

    expect(tableExistsSource).toContain("if (driver === 'mssql')");
    expect(tableExistsSource).toContain('select top 1 table_name');
    expect(tableExistsSource).toContain('where table_schema = schema_name()');
    expect(recordInitialMigrationSource).toContain("if (driver === 'mssql')");
    expect(recordInitialMigrationSource).toContain('if not exists');
    expect(recordInitialMigrationSource).toContain('from [kysely_migration]');
    expect(recordInitialMigrationSource).toContain('insert into [kysely_migration]');
    expect(recordInitialMigrationSource).toContain('[timestamp]');
    expectSourceOrder(
      recordInitialMigrationSource,
      "if (driver === 'mssql')",
      'insert into "kysely_migration"',
    );
  });

  it('drops and truncates data with SQL Server-compatible constraint handling', () => {
    const source = readFileSync(migrateSourcePath, 'utf8');
    const dropAllTablesSource = sourceBetween(
      source,
      'export async function dropAllTables',
      'export async function truncateAllData',
    );
    const dropAllTablesMssqlSource = sourceBetween(
      dropAllTablesSource,
      "if (driver === 'mssql')",
      '// PostgreSQL: use CASCADE',
    );
    const truncateAllDataSource = sourceBetween(
      source,
      'export async function truncateAllData',
      'export async function runMigrations',
    );

    expect(dropAllTablesSource).toContain("if (driver === 'mssql')");
    expect(dropAllTablesMssqlSource).toContain('from sys.foreign_keys');
    expect(dropAllTablesMssqlSource).toContain('drop constraint');
    expect(dropAllTablesMssqlSource).toContain('DROP TABLE IF EXISTS');
    expect(dropAllTablesMssqlSource).not.toContain('CASCADE');
    expect(truncateAllDataSource).toContain("if (driver === 'mssql')");
    expect(truncateAllDataSource).toContain('NOCHECK CONSTRAINT ALL');
    expect(truncateAllDataSource).toContain('DELETE FROM');
    expect(truncateAllDataSource).toContain('DBCC CHECKIDENT');
    expect(truncateAllDataSource).toContain('WITH CHECK CHECK CONSTRAINT ALL');
    expectSourceOrder(truncateAllDataSource, 'NOCHECK CONSTRAINT ALL', 'DELETE FROM');
    expectSourceOrder(truncateAllDataSource, 'DELETE FROM', 'WITH CHECK CHECK CONSTRAINT ALL');
  });
});

describe('turbo DB environment safety', () => {
  it('includes MSSQL connection URLs in the global cache environment', () => {
    const turboConfig = JSON.parse(readFileSync(turboConfigPath, 'utf8')) as {
      globalEnv?: string[];
    };

    expect(turboConfig.globalEnv).toContain('DATABASE_URL_MSSQL');
  });
});

describe('migration index rollback safety', () => {
  it('drops indexes with explicit table targets that match createIndex builders', () => {
    const failures: string[] = [];
    const migrationFiles = readdirSync(migrationDir)
      .filter((fileName) => /^\d+_.*\.ts$/.test(fileName))
      // eslint-disable-next-line unicorn/no-array-sort -- ES2023 toSorted is not available in this package's TS lib target.
      .sort();

    for (const fileName of migrationFiles) {
      const source = readFileSync(resolve(migrationDir, fileName), 'utf8');
      const createdIndexTables = collectCreatedIndexTables(source);
      const dropIndexPattern = quotedNamePattern('dropIndex');

      for (const match of source.matchAll(dropIndexPattern)) {
        const [, indexName, builderChain] = match;

        if (!indexName) {
          continue;
        }

        const tableMatch = /\.on\(\s*['"`]([^'"`]+)['"`]\s*\)/.exec(builderChain);

        if (!tableMatch?.[1]) {
          failures.push(`${fileName}: dropIndex('${indexName}') is missing .on('<table>')`);
          continue;
        }

        const ifExistsIndex = builderChain.indexOf('.ifExists()');

        if (ifExistsIndex !== -1 && tableMatch.index > ifExistsIndex) {
          failures.push(
            `${fileName}: dropIndex('${indexName}') must call .on('<table>') before .ifExists()`,
          );
          continue;
        }

        const createdOnTable = createdIndexTables.get(indexName);

        if (createdOnTable && createdOnTable !== tableMatch[1]) {
          failures.push(
            `${fileName}: dropIndex('${indexName}').on('${tableMatch[1]}') should match createIndex().on('${createdOnTable}')`,
          );
        }
      }
    }

    expect(failures).toEqual([]);
  });
});

describe('nullable webhook delivery endpoint migration dialect safety', () => {
  it('uses SQL Server ALTER COLUMN type syntax and rebuilds the endpoint foreign key', () => {
    const source = readFileSync(nullableWebhookDeliveryEndpointMigrationPath, 'utf8');
    const upSource = migrationMethodSource(source, 'up');
    const downSource = migrationMethodSource(source, 'down');
    const upMssqlSource = sourceBetween(
      upSource,
      'if (isMssql())',
      'await sql`alter table webhook_deliveries add column requested_endpoint_id varchar(32)`',
    );
    const downMssqlSource = sourceBetween(
      downSource,
      'if (isMssql())',
      'await sql`alter table webhook_deliveries alter column endpoint_id set not null`',
    );

    expect(source).toContain("process.env.DB_DRIVER === 'mssql'");
    expect(source).toContain('drop constraint webhook_deliveries_endpoint_fk');
    expect(upSource).toContain(
      'alter table webhook_deliveries modify endpoint_id varchar(32) null',
    );
    expect(downSource).toContain(
      'alter table webhook_deliveries modify endpoint_id varchar(32) not null',
    );
    expectSourceOrder(
      upMssqlSource,
      'drop constraint webhook_deliveries_endpoint_fk',
      'alter table webhook_deliveries alter column endpoint_id varchar(32) null',
    );
    expectSourceOrder(
      upMssqlSource,
      'alter table webhook_deliveries alter column endpoint_id varchar(32) null',
      'add constraint webhook_deliveries_endpoint_fk',
    );
    expectSourceOrder(upMssqlSource, 'add constraint webhook_deliveries_endpoint_fk', 'return');
    expectSourceOrder(
      downMssqlSource,
      'drop constraint webhook_deliveries_endpoint_fk',
      'alter table webhook_deliveries alter column endpoint_id varchar(32) not null',
    );
    expectSourceOrder(
      downMssqlSource,
      'alter table webhook_deliveries alter column endpoint_id varchar(32) not null',
      'add constraint webhook_deliveries_endpoint_fk',
    );
    expectSourceOrder(
      downMssqlSource,
      'add constraint webhook_deliveries_endpoint_fk',
      'alter table webhook_deliveries drop column requested_endpoint_id',
    );
  });

  it('drops and recreates the MySQL endpoint foreign key around endpoint_id nullability changes', () => {
    const source = readFileSync(nullableWebhookDeliveryEndpointMigrationPath, 'utf8');
    const upSource = migrationMethodSource(source, 'up');
    const downSource = migrationMethodSource(source, 'down');

    expect(source).toContain('drop foreign key webhook_deliveries_endpoint_fk');
    expect(source).toContain('add constraint webhook_deliveries_endpoint_fk');
    expectSourceOrder(
      upSource,
      'drop foreign key webhook_deliveries_endpoint_fk',
      'alter table webhook_deliveries modify endpoint_id varchar(32) null',
    );
    expectSourceOrder(
      upSource,
      'alter table webhook_deliveries modify endpoint_id varchar(32) null',
      'add constraint webhook_deliveries_endpoint_fk',
    );
    expectSourceOrder(
      downSource,
      'drop foreign key webhook_deliveries_endpoint_fk',
      'alter table webhook_deliveries modify endpoint_id varchar(32) not null',
    );
    expectSourceOrder(
      downSource,
      'alter table webhook_deliveries modify endpoint_id varchar(32) not null',
      'add constraint webhook_deliveries_endpoint_fk',
    );
    expectSourceOrder(
      downSource,
      'add constraint webhook_deliveries_endpoint_fk',
      'alter table webhook_deliveries drop column requested_endpoint_id',
    );
  });

  it('refuses rollback before deleting missing-endpoint delivery history', async () => {
    const { NullableWebhookDeliveryEndpointMigration } =
      await import('../../migrations/0022_nullable_webhook_delivery_endpoint.js');
    const db = new FakeWebhookDeliveriesDb([
      {
        id: 'whd_missing',
        endpoint_id: null,
        event_id: 'whe_1',
        requested_endpoint_id: 'wh_missing',
        delivery_key: 'live',
        attempt: 1,
        status: 'dead_lettered',
        created_at: '2026-01-01T00:00:00.000Z',
      },
    ]);

    await expect(NullableWebhookDeliveryEndpointMigration.down!(db as never)).rejects.toThrow(
      'Cannot roll back nullable webhook delivery endpoints while missing-endpoint deliveries exist',
    );
    expect(db.rawSqlStatements).toEqual([]);
    expect(db.createdIndexes).toEqual([]);
  });
});

describe('oauth grants migration dialect safety', () => {
  it('uses SQL Server-compatible timestamp defaults and JSON storage', () => {
    const source = readFileSync(oauthGrantsMigrationPath, 'utf8');
    const upSource = migrationMethodSource(source, 'up');
    const timestampTypeSource = sourceBetween(
      source,
      'function timestampType',
      'function nowDefault',
    );
    const nowDefaultSource = sourceBetween(source, 'function nowDefault', 'function jsonType');
    const jsonTypeSource = sourceBetween(
      source,
      'function jsonType',
      'export const OAuthGrantsMigration',
    );

    expect(source).toContain("process.env.DB_DRIVER === 'mysql'");
    expect(source).toContain("process.env.DB_DRIVER === 'mssql'");
    expect(source).not.toContain("process.env.DB_DRIVER === 'mysql' ? 'datetime' : 'timestamptz'");
    expect(source).not.toContain(
      "process.env.DB_DRIVER === 'mysql' ? sql`CURRENT_TIMESTAMP` : sql`now()`",
    );
    expect(timestampTypeSource).toContain("if (isMssql()) return 'datetime2'");
    expect(timestampTypeSource).toContain("return 'timestamptz'");
    expect(nowDefaultSource).toContain('isMysql() || isMssql()');
    expect(nowDefaultSource).toContain('sql`CURRENT_TIMESTAMP`');
    expect(nowDefaultSource).toContain('sql`now()`');
    expect(jsonTypeSource).toContain('if (isMssql()) return sql`nvarchar(max)`');
    expect(jsonTypeSource).toContain("return 'json'");
    expect(upSource).toContain("addColumn('scopes', jsonType()");
    expect(upSource).not.toContain("addColumn('scopes', 'json'");
    expectSourceOrder(
      timestampTypeSource,
      "if (isMssql()) return 'datetime2'",
      "return 'timestamptz'",
    );
    expectSourceOrder(jsonTypeSource, 'if (isMssql()) return sql`nvarchar(max)`', "return 'json'");
  });
});

describe('events brand slug migration safety', () => {
  it('drops older tenant/global slug constraints before adding brand-scoped uniqueness', () => {
    const source = readFileSync(eventsBrandSlugScopeMigrationPath, 'utf8');
    const upSource = migrationMethodSource(source, 'up');
    const downSource = migrationMethodSource(source, 'down');

    expect(source).toContain('events_slug_global_unique');
    expect(source).toContain('events_slug_tenant_unique');
    expect(source).toContain('events_brand_slug_unique');
    expect(source).toContain("process.env.DB_DRIVER === 'mysql'");
    expect(source).toContain("process.env.DB_DRIVER === 'mssql'");
    expect(source).toContain('ER_CANT_DROP_FIELD_OR_KEY');
    expectSourceOrder(upSource, 'events_slug_global_unique', 'addBrandSlugConstraint(db)');
    expectSourceOrder(upSource, 'events_slug_tenant_unique', 'addBrandSlugConstraint(db)');
    expectSourceOrder(downSource, 'events_brand_slug_unique', 'addTenantSlugConstraint(db)');
  });
});

describe('webhook delivery endpoint history index migration safety', () => {
  it('creates a composite requested-endpoint pagination index', async () => {
    delete process.env.DB_DRIVER;
    vi.doMock('kysely', async (importOriginal) => {
      const actual = await importOriginal<typeof import('kysely')>();

      return { ...actual, sql: fakeSql };
    });
    const { WebhookDeliveryEndpointHistoryIndexMigration } =
      await import('../../migrations/0024_webhook_delivery_endpoint_history_index.js');
    const db = new FakeWebhookDeliveriesDb([]);

    await WebhookDeliveryEndpointHistoryIndexMigration.up(db as never);

    expect(db.rawSqlStatements).toHaveLength(1);
    expect(db.rawSqlStatements[0]).toContain('information_schema.columns');
    expect(db.createdIndexes).toEqual([
      {
        indexName: 'idx_webhook_deliveries_requested_endpoint_history',
        tableName: 'webhook_deliveries',
        columns: ['requested_endpoint_id', 'created_at', 'id'],
        unique: false,
      },
    ]);
  });

  it('repairs older schemas missing requested_endpoint_id before creating the history index', async () => {
    process.env.DB_DRIVER = 'mysql';
    vi.doMock('kysely', async (importOriginal) => {
      const actual = await importOriginal<typeof import('kysely')>();

      return { ...actual, sql: fakeSql };
    });
    const { WebhookDeliveryEndpointHistoryIndexMigration } =
      await import('../../migrations/0024_webhook_delivery_endpoint_history_index.js');
    const db = new FakeWebhookDeliveriesDb(
      [
        {
          id: 'whd_1',
          endpoint_id: 'wh_1',
          event_id: 'whe_1',
          attempt: 1,
          status: 'pending',
          created_at: '2026-01-01T00:00:00.000Z',
        },
      ],
      { requestedEndpointColumnExists: false },
    );

    await WebhookDeliveryEndpointHistoryIndexMigration.up(db as never);

    expect(db.requestedEndpointColumnExists).toBe(true);
    expect(db.rows[0]?.requested_endpoint_id).toBe('wh_1');
    expect(db.rawSqlStatements).toEqual(
      expect.arrayContaining([
        expect.stringContaining('information_schema.columns'),
        expect.stringContaining('alter table webhook_deliveries add column requested_endpoint_id'),
        expect.stringContaining(
          'update webhook_deliveries set requested_endpoint_id = endpoint_id',
        ),
        expect.stringContaining(
          'alter table webhook_deliveries modify requested_endpoint_id varchar(32) not null',
        ),
      ]),
    );
    expect(db.createdIndexes).toEqual([
      {
        indexName: 'idx_webhook_deliveries_requested_endpoint_history',
        tableName: 'webhook_deliveries',
        columns: ['requested_endpoint_id', 'created_at', 'id'],
        unique: false,
      },
    ]);
  });

  it('keeps the rollback table-qualified and source-visible to the safety scanner', () => {
    const source = readFileSync(webhookDeliveryEndpointHistoryIndexMigrationPath, 'utf8');
    const upSource = migrationMethodSource(source, 'up');
    const downSource = migrationMethodSource(source, 'down');

    expect(upSource).toContain('ensureRequestedEndpointColumn(db)');
    expect(upSource).toContain("createIndex('idx_webhook_deliveries_requested_endpoint_history')");
    expect(upSource).toContain(".on('webhook_deliveries')");
    expect(upSource).toContain("columns(['requested_endpoint_id', 'created_at', 'id'])");
    expect(downSource).toContain("dropIndex('idx_webhook_deliveries_requested_endpoint_history')");
    expectSourceOrder(downSource, ".on('webhook_deliveries')", '.ifExists()');
  });
});

describe('webhook delivery attempt identity migration safety', () => {
  it('dedupes existing event/requested-endpoint/attempt rows before creating the unique index', async () => {
    delete process.env.DB_DRIVER;
    vi.doMock('kysely', async (importOriginal) => {
      const actual = await importOriginal<typeof import('kysely')>();

      return { ...actual, sql: fakeSql };
    });
    const { WebhookDeliveryAttemptIdentityMigration } =
      await import('../../migrations/0026_webhook_delivery_attempt_identity.js');
    const db = new FakeWebhookDeliveriesDb([
      {
        id: 'whd_pending',
        event_id: 'whe_1',
        requested_endpoint_id: 'wh_1',
        attempt: 1,
        status: 'pending',
        created_at: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'whd_failed',
        event_id: 'whe_1',
        requested_endpoint_id: 'wh_1',
        attempt: 1,
        status: 'failed',
        created_at: '2026-01-02T00:00:00.000Z',
      },
      {
        id: 'whd_delivered',
        event_id: 'whe_1',
        requested_endpoint_id: 'wh_1',
        attempt: 1,
        status: 'delivered',
        created_at: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'whd_other_attempt',
        event_id: 'whe_1',
        requested_endpoint_id: 'wh_1',
        attempt: 2,
        status: 'failed',
        created_at: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'whd_other_endpoint',
        event_id: 'whe_1',
        requested_endpoint_id: 'wh_2',
        attempt: 1,
        status: 'pending',
        created_at: '2026-01-01T00:00:00.000Z',
      },
    ]);

    await WebhookDeliveryAttemptIdentityMigration.up(db as never);

    // eslint-disable-next-line unicorn/no-array-sort -- ES2023 toSorted is not available in this package's TS lib target.
    expect(db.rows.map((row) => row.id).sort()).toEqual([
      'whd_delivered',
      'whd_other_attempt',
      'whd_other_endpoint',
    ]);
    expect(db.rawSqlStatements).toHaveLength(1);
    expect(db.rawSqlStatements[0]).toContain('ranked_webhook_deliveries');
    expect(db.rawSqlStatements[0]).toContain(
      'partition by event_id, requested_endpoint_id, attempt',
    );
    expect(db.createdIndexes).toEqual([
      {
        indexName: 'uniq_webhook_deliveries_attempt_identity',
        tableName: 'webhook_deliveries',
        columns: ['event_id', 'requested_endpoint_id', 'attempt'],
        unique: true,
      },
    ]);
  });

  it('keeps duplicate cleanup before the attempt identity index and rollback table-qualified', () => {
    const source = readFileSync(webhookDeliveryAttemptIdentityMigrationPath, 'utf8');
    const upSource = migrationMethodSource(source, 'up');
    const downSource = migrationMethodSource(source, 'down');

    expect(source).toContain("process.env.DB_DRIVER === 'mysql'");
    expect(source).toContain("process.env.DB_DRIVER === 'mssql'");
    expect(source).toContain('delete webhook_deliveries');
    expect(source).toContain('delete from ranked_webhook_deliveries');
    expect(source).toContain('delete from webhook_deliveries');
    expectSourceOrder(
      upSource,
      'dedupeWebhookDeliveries(db)',
      "createIndex('uniq_webhook_deliveries_attempt_identity')",
    );
    expect(upSource).toContain(".on('webhook_deliveries')");
    expect(upSource).toContain("columns(['event_id', 'requested_endpoint_id', 'attempt'])");
    expect(upSource).toContain('.unique()');
    expect(downSource).toContain("dropIndex('uniq_webhook_deliveries_attempt_identity')");
    expectSourceOrder(downSource, ".on('webhook_deliveries')", '.ifExists()');
  });
});

describe('webhook delivery replay identity migration safety', () => {
  it('rebuilds delivery uniqueness around delivery_key so replays can redeliver attempt 1', async () => {
    process.env.DB_DRIVER = 'mssql';
    const { WebhookDeliveryReplayIdentityMigration } =
      await import('../../migrations/0027_webhook_delivery_replay_identity.js');
    const db = new FakeWebhookDeliveriesDb([
      {
        id: 'whd_live',
        event_id: 'whe_1',
        requested_endpoint_id: 'wh_1',
        delivery_key: 'live',
        attempt: 1,
        status: 'delivered',
        created_at: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'whd_replay',
        event_id: 'whe_1',
        requested_endpoint_id: 'wh_1',
        delivery_key: 'replay:rpl_1',
        attempt: 1,
        status: 'pending',
        created_at: '2026-01-02T00:00:00.000Z',
      },
    ]);

    await WebhookDeliveryReplayIdentityMigration.up(db as never);

    expect(db.createdIndexes).toContainEqual({
      indexName: 'uniq_webhook_deliveries_delivery_identity',
      tableName: 'webhook_deliveries',
      columns: ['event_id', 'requested_endpoint_id', 'attempt', 'delivery_key'],
      unique: true,
    });
  });

  it('keeps replay identity migration rollback table-qualified and source-visible', () => {
    const source = readFileSync(webhookDeliveryReplayIdentityMigrationPath, 'utf8');
    const upSource = migrationMethodSource(source, 'up');
    const downSource = migrationMethodSource(source, 'down');

    expect(source).toContain('alter table webhook_deliveries drop index');
    expect(source).toContain("dropIndex(indexName).on('webhook_deliveries').ifExists()");
    expect(source).toContain('ER_CANT_DROP_FIELD_OR_KEY');
    expect(source).toContain('drop index if exists');
    expect(upSource).toContain(
      "dropWebhookDeliveriesIndex(db, 'uniq_webhook_deliveries_attempt_identity')",
    );
    expect(upSource).toContain("addColumn('delivery_key', 'varchar(128)'");
    expect(upSource).toContain("defaultTo('live')");
    expect(upSource).toContain("createIndex('uniq_webhook_deliveries_delivery_identity')");
    expect(upSource).toContain(
      "columns(['event_id', 'requested_endpoint_id', 'attempt', 'delivery_key'])",
    );
    expectSourceOrder(
      upSource,
      "addColumn('delivery_key'",
      "createIndex('uniq_webhook_deliveries_delivery_identity')",
    );
    expectSourceOrder(
      upSource,
      "createIndex('uniq_webhook_deliveries_delivery_identity')",
      "dropWebhookDeliveriesIndex(db, 'uniq_webhook_deliveries_attempt_identity')",
    );
    expect(downSource).toContain("selectFrom('webhook_deliveries')");
    expect(downSource).toContain("where('delivery_key', '!=', 'live')");
    expect(downSource).toContain(
      "dropWebhookDeliveriesIndex(db, 'uniq_webhook_deliveries_delivery_identity')",
    );
    expect(downSource).toContain("dropColumn('delivery_key')");
    expect(downSource).toContain("createIndex('uniq_webhook_deliveries_attempt_identity')");
    expectSourceOrder(
      downSource,
      "selectFrom('webhook_deliveries')",
      "dropWebhookDeliveriesIndex(db, 'uniq_webhook_deliveries_delivery_identity')",
    );
  });

  it('refuses rollback before destructive schema changes when replay rows exist', async () => {
    const { WebhookDeliveryReplayIdentityMigration } =
      await import('../../migrations/0027_webhook_delivery_replay_identity.js');
    const db = new FakeWebhookDeliveriesDb([
      {
        id: 'whd_live',
        event_id: 'whe_1',
        requested_endpoint_id: 'wh_1',
        delivery_key: 'live',
        attempt: 1,
        status: 'delivered',
        created_at: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'whd_replay',
        event_id: 'whe_1',
        requested_endpoint_id: 'wh_1',
        delivery_key: 'replay:rpl_1',
        attempt: 1,
        status: 'failed',
        created_at: '2026-01-02T00:00:00.000Z',
      },
    ]);

    await expect(WebhookDeliveryReplayIdentityMigration.down!(db as never)).rejects.toThrow(
      'Cannot roll back webhook delivery replay identity while replay deliveries exist',
    );
    expect(db.createdIndexes).toEqual([]);
  });
});

describe('marketing integrations base migration dialect safety', () => {
  it('uses explicit SQL Server-compatible types and defaults instead of PostgreSQL fallthroughs', () => {
    const source = readFileSync(marketingIntegrationsMigrationPath, 'utf8');
    const upSource = migrationMethodSource(source, 'up');
    const downSource = migrationMethodSource(source, 'down');
    const timestampTypeSource = sourceBetween(
      source,
      'function timestampType',
      'function jsonType',
    );
    const jsonTypeSource = sourceBetween(source, 'function jsonType', 'function booleanType');
    const booleanTypeSource = sourceBetween(source, 'function booleanType', 'function nowDefault');
    const nowDefaultSource = sourceBetween(source, 'function nowDefault', 'function trueDefault');
    const trueDefaultSource = sourceBetween(
      source,
      'function trueDefault',
      'export const MarketingIntegrationsMigration',
    );

    expect(source).toContain("process.env.DB_DRIVER === 'mysql'");
    expect(source).toContain("process.env.DB_DRIVER === 'mssql'");
    expect(source).not.toContain("process.env.DB_DRIVER === 'mysql' ? 'datetime' : 'timestamptz'");
    expect(source).not.toContain("process.env.DB_DRIVER === 'mysql' ? 'json' : 'jsonb'");
    expect(source).not.toContain(
      "process.env.DB_DRIVER === 'mysql' ? sql`CURRENT_TIMESTAMP` : sql`now()`",
    );
    expect(source).not.toContain("addColumn('consent_required', 'boolean'");
    expect(timestampTypeSource).toContain("if (isMssql()) return 'datetime2'");
    expect(timestampTypeSource).toContain("return 'timestamptz'");
    expect(jsonTypeSource).toContain('if (isMssql()) return sql`nvarchar(max)`');
    expect(jsonTypeSource).toContain("return 'jsonb'");
    expect(booleanTypeSource).toContain('if (isMssql()) return sql`bit`');
    expect(booleanTypeSource).toContain("return 'boolean'");
    expect(nowDefaultSource).toContain('isMysql() || isMssql()');
    expect(nowDefaultSource).toContain('sql`CURRENT_TIMESTAMP`');
    expect(nowDefaultSource).toContain('sql`now()`');
    expect(trueDefaultSource).toContain('isMssql() ? sql`1` : true');
    expect(upSource).toContain("addColumn('config', jsonType()");
    expect(upSource).toContain("addColumn('consent_required', booleanType()");
    expect(upSource).toContain('defaultTo(trueDefault())');
    expectSourceOrder(
      timestampTypeSource,
      "if (isMssql()) return 'datetime2'",
      "return 'timestamptz'",
    );
    expectSourceOrder(jsonTypeSource, 'if (isMssql()) return sql`nvarchar(max)`', "return 'jsonb'");
    expectSourceOrder(downSource, ".on('marketing_integrations')", '.ifExists()');
    expectSourceOrder(downSource, '.ifExists()', "dropTable('marketing_integrations')");
  });
});

describe('marketing integrations unique migration safety', () => {
  it('dedupes existing event/provider rows before creating the unique index without dropping null-event rows', async () => {
    delete process.env.DB_DRIVER;
    vi.doMock('kysely', async (importOriginal) => {
      const actual = await importOriginal<typeof import('kysely')>();

      return { ...actual, sql: fakeSql };
    });
    const { MarketingIntegrationsUniqueMigration } =
      await import('../../migrations/0015_marketing_integrations_unique.js');
    const db = new FakeMarketingIntegrationsDb([
      {
        id: 'int_old',
        event_id: 'evt_1',
        provider: 'mailchimp',
        updated_at: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'int_new_a',
        event_id: 'evt_1',
        provider: 'mailchimp',
        updated_at: '2026-01-02T00:00:00.000Z',
      },
      {
        id: 'int_new_z',
        event_id: 'evt_1',
        provider: 'mailchimp',
        updated_at: '2026-01-02T00:00:00.000Z',
      },
      {
        id: 'int_other_provider',
        event_id: 'evt_1',
        provider: 'klaviyo',
        updated_at: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'int_null_old',
        event_id: null,
        provider: 'mailchimp',
        updated_at: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'int_null_new',
        event_id: null,
        provider: 'mailchimp',
        updated_at: '2026-01-03T00:00:00.000Z',
      },
    ]);

    await MarketingIntegrationsUniqueMigration.up(db as never);

    // eslint-disable-next-line unicorn/no-array-sort -- ES2023 toSorted is not available in this package's TS lib target.
    expect(db.rows.map((row) => row.id).sort()).toEqual([
      'int_new_z',
      'int_null_new',
      'int_null_old',
      'int_other_provider',
    ]);
    expect(db.rawSqlStatements).toHaveLength(2);
    expect(db.rawSqlStatements[0]).toContain('row_number() over');
    expect(db.rawSqlStatements[0]).toContain('order by updated_at desc, id desc');
    expect(db.rawSqlStatements[0]).toContain('where event_id is not null');
    expect(db.rawSqlStatements[1]).toContain(
      'create unique index uniq_marketing_integrations_event_provider',
    );
    expect(db.rawSqlStatements[1]).toContain('where event_id is not null');
    expect(db.createdIndexes).toEqual([]);
  });

  it('keeps dialect-specific duplicate cleanup branches before the index builder', () => {
    const source = readFileSync(marketingIntegrationsUniqueMigrationPath, 'utf8');
    const upSource = migrationMethodSource(source, 'up');

    expect(source).toContain("process.env.DB_DRIVER === 'mysql'");
    expect(source).toContain("process.env.DB_DRIVER === 'mssql'");
    expect(source).toContain('delete marketing_integrations');
    expect(source).toContain('delete from ranked_marketing_integrations');
    expect(source).toContain('delete from marketing_integrations');
    expect(source).toContain('where event_id is not null');
    expectSourceOrder(
      upSource,
      'dedupeMarketingIntegrations(db)',
      'createMarketingIntegrationsUniqueIndex(db)',
    );
  });
});

describe('payment accounts unique migration safety', () => {
  it('dedupes existing organization/provider rows before creating unique indexes', async () => {
    delete process.env.DB_DRIVER;
    vi.doMock('kysely', async (importOriginal) => {
      const actual = await importOriginal<typeof import('kysely')>();

      return { ...actual, sql: fakeSql };
    });
    const { PaymentAccountsUniqueMigration } =
      await import('../../migrations/0025_payment_accounts_unique.js');
    const db = new FakePaymentAccountsDb([
      {
        id: 'pa_old',
        organization_id: 'org_1',
        provider: 'stripe_connect',
        provider_account_id: 'acct_old',
        updated_at: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'pa_new_a',
        organization_id: 'org_1',
        provider: 'stripe_connect',
        provider_account_id: 'acct_new_a',
        updated_at: '2026-01-02T00:00:00.000Z',
      },
      {
        id: 'pa_new_z',
        organization_id: 'org_1',
        provider: 'stripe_connect',
        provider_account_id: 'acct_new_z',
        updated_at: '2026-01-02T00:00:00.000Z',
      },
      {
        id: 'pa_stripe',
        organization_id: 'org_1',
        provider: 'stripe',
        provider_account_id: 'acct_legacy',
        updated_at: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'pa_other_org',
        organization_id: 'org_2',
        provider: 'stripe_connect',
        provider_account_id: 'acct_other',
        updated_at: '2026-01-01T00:00:00.000Z',
      },
    ]);

    await PaymentAccountsUniqueMigration.up(db as never);

    // eslint-disable-next-line unicorn/no-array-sort -- ES2023 toSorted is not available in this package's TS lib target.
    expect(db.rows.map((row) => row.id).sort()).toEqual(['pa_new_z', 'pa_other_org', 'pa_stripe']);
    expect(db.rawSqlStatements).toHaveLength(6);
    expect(
      db.rawSqlStatements.every((statement) => statement.includes('ranked_payment_accounts')),
    ).toBe(true);
    expect(db.createdIndexes).toEqual([
      {
        indexName: 'uniq_payment_accounts_organization_provider',
        tableName: 'payment_accounts',
        columns: ['organization_id', 'provider'],
        unique: true,
      },
      {
        indexName: 'uniq_payment_accounts_provider_account',
        tableName: 'payment_accounts',
        columns: ['provider', 'provider_account_id'],
        unique: true,
      },
    ]);
  });

  it('dedupes duplicate provider accounts across organizations before indexing', async () => {
    delete process.env.DB_DRIVER;
    vi.doMock('kysely', async (importOriginal) => {
      const actual = await importOriginal<typeof import('kysely')>();

      return { ...actual, sql: fakeSql };
    });
    const { PaymentAccountsUniqueMigration } =
      await import('../../migrations/0025_payment_accounts_unique.js');
    const db = new FakePaymentAccountsDb([
      {
        id: 'pa_org_1',
        organization_id: 'org_1',
        provider: 'stripe_connect',
        provider_account_id: 'acct_shared',
        updated_at: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'pa_org_2',
        organization_id: 'org_2',
        provider: 'stripe_connect',
        provider_account_id: 'acct_shared',
        updated_at: '2026-01-02T00:00:00.000Z',
      },
    ]);

    await PaymentAccountsUniqueMigration.up(db as never);

    expect(db.rows.map((row) => row.id)).toEqual(['pa_org_2']);
    expect(db.createdIndexes.map((index) => index.indexName)).toEqual([
      'uniq_payment_accounts_organization_provider',
      'uniq_payment_accounts_provider_account',
    ]);
  });

  it('remaps brand payment-account references before deleting duplicate losers', async () => {
    delete process.env.DB_DRIVER;
    vi.doMock('kysely', async (importOriginal) => {
      const actual = await importOriginal<typeof import('kysely')>();

      return { ...actual, sql: fakeSql };
    });
    const { PaymentAccountsUniqueMigration } =
      await import('../../migrations/0025_payment_accounts_unique.js');
    const db = new FakePaymentAccountsDb(
      [
        {
          id: 'pa_loser',
          organization_id: 'org_1',
          provider: 'stripe_connect',
          provider_account_id: 'acct_old',
          updated_at: '2026-01-01T00:00:00.000Z',
        },
        {
          id: 'pa_canonical',
          organization_id: 'org_1',
          provider: 'stripe_connect',
          provider_account_id: 'acct_new',
          updated_at: '2026-01-02T00:00:00.000Z',
        },
      ],
      {
        brands: [{ id: 'brand_1', payment_account_id: 'pa_loser' }],
      },
    );

    await PaymentAccountsUniqueMigration.up(db as never);

    expect(db.rows.map((row) => row.id)).toEqual(['pa_canonical']);
    expect(db.brands).toEqual([{ id: 'brand_1', payment_account_id: 'pa_canonical' }]);
  });

  it('repoints payment-intent references before deleting duplicate losers', async () => {
    delete process.env.DB_DRIVER;
    vi.doMock('kysely', async (importOriginal) => {
      const actual = await importOriginal<typeof import('kysely')>();

      return { ...actual, sql: fakeSql };
    });
    const { PaymentAccountsUniqueMigration } =
      await import('../../migrations/0025_payment_accounts_unique.js');
    const db = new FakePaymentAccountsDb(
      [
        {
          id: 'pa_intent_referenced',
          organization_id: 'org_1',
          provider: 'stripe_connect',
          provider_account_id: 'acct_old',
          updated_at: '2026-01-01T00:00:00.000Z',
        },
        {
          id: 'pa_newer',
          organization_id: 'org_1',
          provider: 'stripe_connect',
          provider_account_id: 'acct_new',
          updated_at: '2026-01-02T00:00:00.000Z',
        },
      ],
      {
        paymentIntents: [{ id: 'pi_1', payment_account_id: 'pa_intent_referenced' }],
      },
    );

    await PaymentAccountsUniqueMigration.up(db as never);

    expect(db.rows.map((row) => row.id)).toEqual(['pa_intent_referenced']);
    expect(db.paymentIntents).toEqual([{ id: 'pi_1', payment_account_id: 'pa_intent_referenced' }]);
  });

  it('repoints payment intents when every duplicate row has historical intents', async () => {
    delete process.env.DB_DRIVER;
    vi.doMock('kysely', async (importOriginal) => {
      const actual = await importOriginal<typeof import('kysely')>();

      return { ...actual, sql: fakeSql };
    });
    const { PaymentAccountsUniqueMigration } =
      await import('../../migrations/0025_payment_accounts_unique.js');
    const db = new FakePaymentAccountsDb(
      [
        {
          id: 'pa_old',
          organization_id: 'org_1',
          provider: 'stripe_connect',
          provider_account_id: 'acct_shared',
          updated_at: '2026-01-01T00:00:00.000Z',
        },
        {
          id: 'pa_new',
          organization_id: 'org_1',
          provider: 'stripe_connect',
          provider_account_id: 'acct_shared',
          updated_at: '2026-01-02T00:00:00.000Z',
        },
      ],
      {
        paymentIntents: [
          { id: 'pi_old', payment_account_id: 'pa_old' },
          { id: 'pi_new', payment_account_id: 'pa_new' },
        ],
      },
    );

    await PaymentAccountsUniqueMigration.up(db as never);

    expect(db.rows.map((row) => row.id)).toEqual(['pa_new']);
    expect(db.paymentIntents).toEqual([
      { id: 'pi_old', payment_account_id: 'pa_new' },
      { id: 'pi_new', payment_account_id: 'pa_new' },
    ]);
  });

  it('keeps dialect-specific duplicate cleanup before payment-account indexes', () => {
    const source = readFileSync(paymentAccountsUniqueMigrationPath, 'utf8');
    const upSource = migrationMethodSource(source, 'up');

    expect(source).toContain("process.env.DB_DRIVER === 'mysql'");
    expect(source).toContain("process.env.DB_DRIVER === 'mssql'");
    expect(source).toContain('delete payment_accounts');
    expect(source).toContain('delete from payment_accounts');
    expect(source).toContain('update brands');
    expect(source).toContain('update payment_intents');
    expect(source).toContain('payment_intents');
    expect(source).toContain('partition by provider, provider_account_id');
    expect(source).toContain('partition by organization_id, provider');
    expectSourceOrder(
      upSource,
      'dedupePaymentAccounts(db)',
      "createIndex('uniq_payment_accounts_organization_provider')",
    );
    expectSourceOrder(
      upSource,
      "createIndex('uniq_payment_accounts_organization_provider')",
      "createIndex('uniq_payment_accounts_provider_account')",
    );
  });
});
