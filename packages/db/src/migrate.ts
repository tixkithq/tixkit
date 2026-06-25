import { Migrator, type MigrationProvider, type Migration } from 'kysely/migration';
import { sql } from 'kysely';
import { createDb, getDriver, type Database } from './client.js';
import { InitialMigration } from './migrations/0001_initial.js';

const INITIAL_MIGRATION_NAME = '0001_initial';
const MIGRATION_TABLE = 'kysely_migration';

const INITIAL_SCHEMA_TABLES = [
  'tenants',
  'organizations',
  'brands',
  'brand_domains',
  'user_profiles',
  'clerk_identity_links',
  'organization_members',
  'roles',
  'permission_grants',
  'api_keys',
  'scanner_devices',
  'audit_logs',
  'events',
  'event_pages',
  'inventory_pools',
  'ticket_types',
  'checkout_holds',
  'checkout_sessions',
  'orders',
  'order_line_items',
  'attendees',
  'order_timeline_events',
  'tickets',
  'ticket_secrets',
  'check_in_lists',
  'scan_logs',
  'payment_intents',
  'refunds',
  'payment_events',
  'discount_codes',
  'tax_rules',
  'fee_rules',
  'product_categories',
  'products',
  'access_rules',
  'questions',
  'webhook_endpoints',
  'webhook_events',
  'webhook_deliveries',
  'idempotency_records',
  'affiliates',
  'attributions',
  'notification_templates',
  'notification_template_versions',
  'email_jobs',
  'email_deliveries',
  'email_suppressions',
  'email_provider_routes',
  'brand_sender_identities',
  'sms_sender_identities',
  'sms_provider_routes',
  'sms_jobs',
  'sms_deliveries',
  'sms_provider_events',
  'message_consents',
  'export_jobs',
  'payment_accounts',
  'sender_identities',
  'feature_flags',
  'oauth_applications',
] as const;

function buildMigrationFailureMessage(error: unknown): string {
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return [
    'GateKit migration failed.',
    '- Start local infrastructure with `bun run infra:up`.',
    '- Verify DATABASE_URL points at the local database from `.env.local`.',
    '- Retry with `bun run db:migrate`.',
    '',
    `Original error: ${detail}`,
  ].join('\n');
}

class GateKitMigrationProvider implements MigrationProvider {
  async getMigrations(): Promise<Record<string, Migration>> {
    return {
      [INITIAL_MIGRATION_NAME]: InitialMigration,
    };
  }
}

async function tableExists(db: Database, tableName: string): Promise<boolean> {
  const driver = getDriver();
  const result =
    driver === 'mysql'
      ? await sql<{ table_name: string }>`
          select table_name
          from information_schema.tables
          where table_schema = database()
            and table_name = ${tableName}
          limit 1
        `.execute(db)
      : await sql<{ table_name: string }>`
          select table_name
          from information_schema.tables
          where table_schema = current_schema()
            and table_name = ${tableName}
          limit 1
        `.execute(db);

  return result.rows.length > 0;
}

async function ensureMigrationTable(db: Database): Promise<void> {
  await db.schema
    .createTable(MIGRATION_TABLE)
    .ifNotExists()
    .addColumn('name', 'varchar(255)', (col) => col.notNull().primaryKey())
    .addColumn('timestamp', 'varchar(255)', (col) => col.notNull())
    .execute();
}

async function recordInitialMigration(db: Database): Promise<void> {
  const timestamp = new Date().toISOString();
  if (getDriver() === 'mysql') {
    await sql`
      insert ignore into kysely_migration (name, timestamp)
      values (${INITIAL_MIGRATION_NAME}, ${timestamp})
    `.execute(db);
    return;
  }

  await sql`
    insert into "kysely_migration" ("name", "timestamp")
    values (${INITIAL_MIGRATION_NAME}, ${timestamp})
    on conflict ("name") do nothing
  `.execute(db);
}

async function adoptExistingInitialSchema(db: Database): Promise<void> {
  const migrationTableExists = await tableExists(db, MIGRATION_TABLE);
  const tableChecks = await Promise.all(
    INITIAL_SCHEMA_TABLES.map(async (table) => ({
      table,
      exists: await tableExists(db, table),
    })),
  );
  const existingTables = tableChecks.filter((check) => check.exists).map((check) => check.table);
  const missingTables = tableChecks.filter((check) => !check.exists).map((check) => check.table);

  if (existingTables.length === 0) return;

  if (missingTables.length > 0) {
    throw new Error(
      [
        'Existing partial GateKit schema detected before migrations could run.',
        `Present tables: ${existingTables.join(', ')}`,
        `Missing tables: ${missingTables.join(', ')}`,
        'Use a clean local database or restore a complete schema before retrying `bun run db:migrate`.',
      ].join('\n'),
    );
  }

  if (!migrationTableExists) {
    console.warn(
      `Detected a complete existing GateKit schema without ${MIGRATION_TABLE}; recording ${INITIAL_MIGRATION_NAME} as applied.`,
    );
  }

  await ensureMigrationTable(db);
  await recordInitialMigration(db);
}

async function runMigrations(): Promise<void> {
  const db = createDb();
  try {
    await adoptExistingInitialSchema(db);

    const migrator = new Migrator({
      db,
      provider: new GateKitMigrationProvider(),
    });

    const { error, results } = await migrator.migrateToLatest();

    if (results) {
      for (const result of results) {
        if (result.status === 'Success') {
          console.log(`Migration "${result.migrationName}" executed successfully`);
        } else if (result.status === 'Error') {
          console.error(`Migration "${result.migrationName}" failed`);
        }
      }
    }

    if (error) {
      console.error(buildMigrationFailureMessage(error));
      process.exitCode = 1;
      return;
    }

    console.log('All migrations completed');
  } finally {
    await db.destroy();
  }
}

runMigrations().catch((err) => {
  console.error(buildMigrationFailureMessage(err));
  process.exit(1);
});
