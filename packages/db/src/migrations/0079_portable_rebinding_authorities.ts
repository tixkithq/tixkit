import { sql, type ColumnDataType, type Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';

function timestampType(): ColumnDataType {
  if (process.env.DB_DRIVER === 'mssql') return 'datetime2';
  return process.env.DB_DRIVER === 'mysql' ? 'datetime' : 'timestamptz';
}

async function tableExists(db: Kysely<unknown>, tableName: string): Promise<boolean> {
  return (await db.introspection.getTables()).some(({ name }) => name === tableName);
}

async function indexExists(
  db: Kysely<unknown>,
  tableName: string,
  indexName: string,
): Promise<boolean> {
  if (process.env.DB_DRIVER === 'mysql') {
    const result = await sql<{ present: number }>`
      select 1 as present
      from information_schema.statistics
      where table_schema = database()
        and table_name = ${tableName}
        and index_name = ${indexName}
      limit 1
    `.execute(db);
    return result.rows.length > 0;
  }
  if (process.env.DB_DRIVER === 'mssql') {
    const result = await sql<{ present: number }>`
      select 1 as present
      from sys.indexes
      where object_id = object_id(${tableName})
        and name = ${indexName}
    `.execute(db);
    return result.rows.length > 0;
  }
  const result = await sql<{ present: number }>`
    select 1 as present
    from pg_indexes
    where schemaname = current_schema()
      and tablename = ${tableName}
      and indexname = ${indexName}
    limit 1
  `.execute(db);
  return result.rows.length > 0;
}

async function ensureIndex(
  db: Kysely<unknown>,
  input: { name: string; table: string; columns: string[]; unique?: boolean },
): Promise<void> {
  if (await indexExists(db, input.table, input.name)) return;
  const builder = db.schema.createIndex(input.name).on(input.table).columns(input.columns);
  await (input.unique ? builder.unique() : builder).execute();
}

async function dropIndex(db: Kysely<unknown>, tableName: string, indexName: string): Promise<void> {
  if (!(await indexExists(db, tableName, indexName))) return;
  if (process.env.DB_DRIVER === 'mysql') {
    await db.schema.dropIndex(indexName).on(tableName).execute();
    return;
  }
  if (process.env.DB_DRIVER === 'mssql') {
    await sql.raw(`drop index [${indexName}] on [${tableName}]`).execute(db);
    return;
  }
  await db.schema.dropIndex(indexName).execute();
}

async function acquireRollbackLocks(
  db: Kysely<unknown>,
  input: { taxRegistrations: boolean; walletCredentials: boolean },
): Promise<void> {
  const tables = [
    ...(input.taxRegistrations ? ['tax_registrations'] : []),
    ...(input.walletCredentials ? ['wallet_credentials'] : []),
  ];
  if (tables.length === 0) return;
  if (process.env.DB_DRIVER === 'mysql') {
    await sql
      .raw(`lock tables ${tables.map((table) => `\`${table}\` write`).join(', ')}`)
      .execute(db);
    return;
  }
  if (process.env.DB_DRIVER === 'mssql') {
    for (const table of tables) {
      // eslint-disable-next-line no-await-in-loop -- every authority table remains locked through the destructive rollback.
      await sql.raw(`select top 0 id from [${table}] with (tablockx, holdlock)`).execute(db);
    }
    return;
  }
  await sql
    .raw(`lock table ${tables.map((table) => `"${table}"`).join(', ')} in access exclusive mode`)
    .execute(db);
}

export const PortableRebindingAuthoritiesMigration: Migration = {
  async up(db): Promise<void> {
    await ensureIndex(db, {
      name: 'brands_portable_authority_scope_unique',
      table: 'brands',
      columns: ['tenant_id', 'organization_id', 'id'],
      unique: true,
    });
    if (!(await tableExists(db, 'tax_registrations'))) {
      await db.schema
        .createTable('tax_registrations')
        .addColumn('id', 'varchar(64)', (column) => column.primaryKey())
        .addColumn('tenant_id', 'varchar(32)', (column) => column.notNull())
        .addColumn('organization_id', 'varchar(32)', (column) => column.notNull())
        .addColumn('provider', 'varchar(64)', (column) => column.notNull())
        .addColumn('jurisdiction_code', 'varchar(64)', (column) => column.notNull())
        .addColumn('registration_type', 'varchar(64)', (column) => column.notNull())
        .addColumn('custody_reference', 'varchar(512)', (column) => column.notNull())
        .addColumn('status', 'varchar(32)', (column) => column.notNull())
        .addColumn('created_at', timestampType(), (column) => column.notNull())
        .addColumn('updated_at', timestampType(), (column) => column.notNull())
        .addForeignKeyConstraint(
          'tax_registrations_organization_scope_fk',
          ['tenant_id', 'organization_id'],
          'organizations',
          ['tenant_id', 'id'],
        )
        .addUniqueConstraint('tax_registrations_identity_unique', [
          'tenant_id',
          'organization_id',
          'provider',
          'jurisdiction_code',
          'registration_type',
        ])
        .addCheckConstraint(
          'tax_registrations_status_check',
          sql<boolean>`status in ('pending', 'active', 'inactive', 'revoked')`,
        )
        .addCheckConstraint(
          'tax_registrations_required_values_check',
          process.env.DB_DRIVER === 'mssql'
            ? sql<boolean>`len(ltrim(rtrim(provider))) > 0 and len(ltrim(rtrim(jurisdiction_code))) > 0 and len(ltrim(rtrim(registration_type))) > 0 and len(ltrim(rtrim(custody_reference))) > 0`
            : sql<boolean>`char_length(trim(provider)) > 0 and char_length(trim(jurisdiction_code)) > 0 and char_length(trim(registration_type)) > 0 and char_length(trim(custody_reference)) > 0`,
        )
        .execute();
    }
    await ensureIndex(db, {
      name: 'tax_registrations_scope_idx',
      table: 'tax_registrations',
      columns: ['tenant_id', 'organization_id', 'status'],
    });

    if (!(await tableExists(db, 'wallet_credentials'))) {
      await db.schema
        .createTable('wallet_credentials')
        .addColumn('id', 'varchar(64)', (column) => column.primaryKey())
        .addColumn('tenant_id', 'varchar(32)', (column) => column.notNull())
        .addColumn('organization_id', 'varchar(32)', (column) => column.notNull())
        .addColumn('brand_id', 'varchar(32)', (column) => column.notNull())
        .addColumn('provider', 'varchar(64)', (column) => column.notNull())
        .addColumn('credential_type', 'varchar(64)', (column) => column.notNull())
        .addColumn('custody_reference', 'varchar(512)', (column) => column.notNull())
        .addColumn('status', 'varchar(32)', (column) => column.notNull())
        .addColumn('expires_at', timestampType())
        .addColumn('created_at', timestampType(), (column) => column.notNull())
        .addColumn('updated_at', timestampType(), (column) => column.notNull())
        .addForeignKeyConstraint(
          'wallet_credentials_brand_scope_fk',
          ['tenant_id', 'organization_id', 'brand_id'],
          'brands',
          ['tenant_id', 'organization_id', 'id'],
        )
        .addUniqueConstraint('wallet_credentials_identity_unique', [
          'tenant_id',
          'organization_id',
          'brand_id',
          'provider',
          'credential_type',
        ])
        .addCheckConstraint(
          'wallet_credentials_status_check',
          sql<boolean>`status in ('pending', 'active', 'inactive', 'revoked', 'expired')`,
        )
        .addCheckConstraint(
          'wallet_credentials_required_values_check',
          process.env.DB_DRIVER === 'mssql'
            ? sql<boolean>`len(ltrim(rtrim(provider))) > 0 and len(ltrim(rtrim(credential_type))) > 0 and len(ltrim(rtrim(custody_reference))) > 0`
            : sql<boolean>`char_length(trim(provider)) > 0 and char_length(trim(credential_type)) > 0 and char_length(trim(custody_reference)) > 0`,
        )
        .execute();
    }
    await ensureIndex(db, {
      name: 'wallet_credentials_scope_idx',
      table: 'wallet_credentials',
      columns: ['tenant_id', 'organization_id', 'status'],
    });
  },

  async down(db): Promise<void> {
    const [hasTaxRegistrations, hasWalletCredentials] = await Promise.all([
      tableExists(db, 'tax_registrations'),
      tableExists(db, 'wallet_credentials'),
    ]);
    const mysql = process.env.DB_DRIVER === 'mysql';
    try {
      await acquireRollbackLocks(db, {
        taxRegistrations: hasTaxRegistrations,
        walletCredentials: hasWalletCredentials,
      });
      const [taxRegistrations, walletCredentials] = await Promise.all([
        hasTaxRegistrations
          ? db
              .selectFrom('tax_registrations')
              .select(({ fn }) => fn.countAll().as('count'))
              .executeTakeFirstOrThrow()
          : { count: 0 },
        hasWalletCredentials
          ? db
              .selectFrom('wallet_credentials')
              .select(({ fn }) => fn.countAll().as('count'))
              .executeTakeFirstOrThrow()
          : { count: 0 },
      ]);
      if (Number(taxRegistrations.count) > 0 || Number(walletCredentials.count) > 0) {
        throw new Error(
          'ROLLBACK_UNSAFE: portable rebinding authorities must be migrated before schema rollback',
        );
      }
      if (hasWalletCredentials) await db.schema.dropTable('wallet_credentials').execute();
      if (hasTaxRegistrations) await db.schema.dropTable('tax_registrations').execute();
      await dropIndex(db, 'brands', 'brands_portable_authority_scope_unique');
    } finally {
      if (mysql) await sql`unlock tables`.execute(db);
    }
  },
};
