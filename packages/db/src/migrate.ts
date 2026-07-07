import { Migrator, type MigrationProvider, type Migration } from 'kysely/migration';
import { sql } from 'kysely';
import { createDb, getDriver, type Database } from './client.js';
import { InitialMigration } from './migrations/0001_initial.js';
import { DiscountRedemptionsMigration } from './migrations/0002_discount_redemptions.js';
import { EventCurrencyMigration } from './migrations/0003_event_currency.js';
import { QuestionVisibilityMigration } from './migrations/0004_question_visibility.js';
import { AffiliateTenantScopeMigration } from './migrations/0005_affiliate_tenant_scope.js';
import { ProductOrderLinesMigration } from './migrations/0006_product_order_lines.js';
import { WalletPassesMigration } from './migrations/0007_wallet_passes.js';
import { UploadArtifactsMigration } from './migrations/0008_upload_artifacts.js';
import { WidgetImpressionsMigration } from './migrations/0009_widget_impressions.js';
import { WaitlistsMigration } from './migrations/0010_waitlists.js';
import { EventOccurrencesMigration } from './migrations/0011_event_occurrences.js';
import { TaxInvoicesMigration } from './migrations/0012_tax_invoices.js';
import { OAuthGrantsMigration } from './migrations/0013_oauth_grants.js';
import { MarketingIntegrationsMigration } from './migrations/0014_marketing_integrations.js';
import { MarketingIntegrationsUniqueMigration } from './migrations/0015_marketing_integrations_unique.js';
import { PaymentCompensationsMigration } from './migrations/0016_payment_compensations.js';
import { PaymentAccountCapabilitiesMigration } from './migrations/0017_payment_account_capabilities.js';
import { PrivacyRequestsMigration } from './migrations/0018_privacy_requests.js';
import { DeliverabilityFeedbackMigration } from './migrations/0019_deliverability_feedback.js';
import { RefundRequestIdentityMigration } from './migrations/0020_refund_request_identity.js';
import { EventsGlobalSlugUniqueMigration } from './migrations/0021_events_global_slug_unique.js';
import { NullableWebhookDeliveryEndpointMigration } from './migrations/0022_nullable_webhook_delivery_endpoint.js';
import { EventsBrandSlugScopeMigration } from './migrations/0023_events_brand_slug_scope.js';
import { WebhookDeliveryEndpointHistoryIndexMigration } from './migrations/0024_webhook_delivery_endpoint_history_index.js';
import { PaymentAccountsUniqueMigration } from './migrations/0025_payment_accounts_unique.js';
import { WebhookDeliveryAttemptIdentityMigration } from './migrations/0026_webhook_delivery_attempt_identity.js';
import { WebhookDeliveryReplayIdentityMigration } from './migrations/0027_webhook_delivery_replay_identity.js';
import { ShortLinksMigration } from './migrations/0028_short_links.js';
import { EventCodeFormatMigration } from './migrations/0029_event_code_format.js';
import { ContentDocumentsMigration } from './migrations/0030_content_documents.js';
import { OrderSalesChannelMigration } from './migrations/0031_order_sales_channel.js';
import { ScanLogsTicketIndexMigration } from './migrations/0032_scan_logs_ticket_index.js';
import { EmailJobsTemplateVersionForeignKeyMigration } from './migrations/0033_email_jobs_template_version_fk.js';
import { OfflineCheckInBulkSyncMigration } from './migrations/0034_offline_check_in_bulk_sync.js';
import { OfflineCheckInBulkSyncHardeningMigration } from './migrations/0035_offline_check_in_bulk_sync_hardening.js';
import { OrganizationBoxOfficeSettingsMigration } from './migrations/0036_organization_box_office_settings.js';
import { TicketListingsMigration } from './migrations/0037_ticket_listings.js';
import { EventResalePolicyMigration } from './migrations/0038_event_resale_policy.js';
import { ResaleCheckoutReservationsMigration } from './migrations/0039_resale_checkout_reservations.js';
import { ScannerDeviceScopesMigration } from './migrations/0040_scanner_device_scopes.js';
import { UploadArtifactConsumptionMigration } from './migrations/0041_upload_artifact_consumption.js';
import { AccessRuleRedemptionsMigration } from './migrations/0042_access_rule_redemptions.js';
import { WaitlistCheckoutReservationsMigration } from './migrations/0043_waitlist_checkout_reservations.js';
import { CheckoutHoldOccurrencesMigration } from './migrations/0044_checkout_hold_occurrences.js';
import { TableQueryIndexesMigration } from './migrations/0045_table_query_indexes.js';
import { OrganizationClerkIdUniqueMigration } from './migrations/0046_organization_clerk_id_unique.js';
import { EventPublicRevisionMigration } from './migrations/0047_event_public_revision.js';
import { HotQueryIndexesMigration } from './migrations/0048_hot_query_indexes.js';

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
  'export_job_events',
  'payment_accounts',
  'sender_identities',
  'feature_flags',
  'oauth_applications',
] as const;

/**
 * All tables that can exist after all migrations, including tables created by
 * later migrations. Used by `resetDatabase` to drop everything cleanly.
 */
const ALL_SCHEMA_TABLES = [
  ...INITIAL_SCHEMA_TABLES,
  'discount_redemptions',
  'wallet_passes',
  'upload_artifacts',
  'widget_impressions',
  'waitlist_entries',
  'event_occurrences',
  'order_tax_snapshots',
  'invoices',
  'oauth_authorization_codes',
  'oauth_refresh_tokens',
  'oauth_access_tokens',
  'marketing_integrations',
  'payment_compensations',
  'privacy_requests',
  'email_provider_events',
  'short_links',
  'link_clicks',
  'content_test_sends',
  'content_render_artifacts',
  'content_assets',
  'content_document_versions',
  'content_documents',
  'offline_check_in_sync_chunks',
  'offline_check_in_sync_jobs',
  'ticket_listings',
] as const;

function quoteMssqlIdentifier(identifier: string): string {
  return `[${identifier.replaceAll(']', ']]')}]`;
}

function quoteMssqlStringLiteral(value: string): string {
  return `N'${value.replaceAll("'", "''")}'`;
}

function buildMigrationFailureMessage(error: unknown): string {
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return [
    'Tixkit migration failed.',
    '- Start local infrastructure with `bun run infra:up`.',
    '- Verify DATABASE_URL points at the local database from `.env.local`.',
    '- Retry with `bun run db:migrate`.',
    '',
    `Original error: ${detail}`,
  ].join('\n');
}

export class TixkitMigrationProvider implements MigrationProvider {
  async getMigrations(): Promise<Record<string, Migration>> {
    return {
      [INITIAL_MIGRATION_NAME]: InitialMigration,
      '0002_discount_redemptions': DiscountRedemptionsMigration,
      '0003_event_currency': EventCurrencyMigration,
      '0004_question_visibility': QuestionVisibilityMigration,
      '0005_affiliate_tenant_scope': AffiliateTenantScopeMigration,
      '0006_product_order_lines': ProductOrderLinesMigration,
      '0007_wallet_passes': WalletPassesMigration,
      '0008_upload_artifacts': UploadArtifactsMigration,
      '0009_widget_impressions': WidgetImpressionsMigration,
      '0010_waitlists': WaitlistsMigration,
      '0011_event_occurrences': EventOccurrencesMigration,
      '0012_tax_invoices': TaxInvoicesMigration,
      '0013_oauth_grants': OAuthGrantsMigration,
      '0014_marketing_integrations': MarketingIntegrationsMigration,
      '0015_marketing_integrations_unique': MarketingIntegrationsUniqueMigration,
      '0016_payment_compensations': PaymentCompensationsMigration,
      '0017_payment_account_capabilities': PaymentAccountCapabilitiesMigration,
      '0018_privacy_requests': PrivacyRequestsMigration,
      '0019_deliverability_feedback': DeliverabilityFeedbackMigration,
      '0020_refund_request_identity': RefundRequestIdentityMigration,
      '0021_events_global_slug_unique': EventsGlobalSlugUniqueMigration,
      '0022_nullable_webhook_delivery_endpoint': NullableWebhookDeliveryEndpointMigration,
      '0023_events_brand_slug_scope': EventsBrandSlugScopeMigration,
      '0024_webhook_delivery_endpoint_history_index': WebhookDeliveryEndpointHistoryIndexMigration,
      '0025_payment_accounts_unique': PaymentAccountsUniqueMigration,
      '0026_webhook_delivery_attempt_identity': WebhookDeliveryAttemptIdentityMigration,
      '0027_webhook_delivery_replay_identity': WebhookDeliveryReplayIdentityMigration,
      '0028_short_links': ShortLinksMigration,
      '0029_event_code_format': EventCodeFormatMigration,
      '0030_content_documents': ContentDocumentsMigration,
      '0031_order_sales_channel': OrderSalesChannelMigration,
      '0032_scan_logs_ticket_index': ScanLogsTicketIndexMigration,
      '0033_email_jobs_template_version_fk': EmailJobsTemplateVersionForeignKeyMigration,
      '0034_offline_check_in_bulk_sync': OfflineCheckInBulkSyncMigration,
      '0035_offline_check_in_bulk_sync_hardening': OfflineCheckInBulkSyncHardeningMigration,
      '0036_organization_box_office_settings': OrganizationBoxOfficeSettingsMigration,
      '0037_ticket_listings': TicketListingsMigration,
      '0038_event_resale_policy': EventResalePolicyMigration,
      '0039_resale_checkout_reservations': ResaleCheckoutReservationsMigration,
      '0040_scanner_device_scopes': ScannerDeviceScopesMigration,
      '0041_upload_artifact_consumption': UploadArtifactConsumptionMigration,
      '0042_access_rule_redemptions': AccessRuleRedemptionsMigration,
      '0043_waitlist_checkout_reservations': WaitlistCheckoutReservationsMigration,
      '0044_checkout_hold_occurrences': CheckoutHoldOccurrencesMigration,
      '0045_table_query_indexes': TableQueryIndexesMigration,
      '0046_organization_clerk_id_unique': OrganizationClerkIdUniqueMigration,
      '0047_event_public_revision': EventPublicRevisionMigration,
      '0048_hot_query_indexes': HotQueryIndexesMigration,
    };
  }
}

async function tableExists(db: Database, tableName: string): Promise<boolean> {
  const driver = getDriver();

  if (driver === 'mysql') {
    const result = await sql<{ table_name: string }>`
      select table_name
      from information_schema.tables
      where table_schema = database()
        and table_name = ${tableName}
      limit 1
    `.execute(db);

    return result.rows.length > 0;
  }

  if (driver === 'mssql') {
    const result = await sql<{ table_name: string }>`
      select top 1 table_name
      from information_schema.tables
      where table_schema = schema_name()
        and table_name = ${tableName}
    `.execute(db);

    return result.rows.length > 0;
  }

  const result = await sql<{ table_name: string }>`
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
  const driver = getDriver();

  if (driver === 'mysql') {
    await sql`
      insert ignore into kysely_migration (name, timestamp)
      values (${INITIAL_MIGRATION_NAME}, ${timestamp})
    `.execute(db);
    return;
  }

  if (driver === 'mssql') {
    await sql`
      if not exists (
        select 1
        from [kysely_migration]
        where [name] = ${INITIAL_MIGRATION_NAME}
      )
      insert into [kysely_migration] ([name], [timestamp])
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
        'Existing partial Tixkit schema detected before migrations could run.',
        `Present tables: ${existingTables.join(', ')}`,
        `Missing tables: ${missingTables.join(', ')}`,
        'Use a clean local database or restore a complete schema before retrying `bun run db:migrate`.',
        'Alternatively, run `bun run db:reset` to drop and recreate the schema from scratch.',
      ].join('\n'),
    );
  }

  if (!migrationTableExists) {
    console.warn(
      `Detected a complete existing Tixkit schema without ${MIGRATION_TABLE}; recording ${INITIAL_MIGRATION_NAME} as applied.`,
    );
  }

  await ensureMigrationTable(db);
  await recordInitialMigration(db);
}

/**
 * Drop all Tixkit tables and the migration tracking table so that the next
 * `runMigrations` call starts from a clean schema. This is destructive and
 * intended for local development and CI setup only.
 *
 * Exposed for `bun run db:reset` and for test global setup when a clean
 * schema is required.
 */
export async function dropAllTables(db: Database): Promise<void> {
  const driver = getDriver();

  if (driver === 'mysql') {
    // Disable FK checks so TRUNCATE/DROP ignores dependency ordering.
    await sql`SET FOREIGN_KEY_CHECKS = 0`.execute(db);
    for (const table of ALL_SCHEMA_TABLES) {
      // eslint-disable-next-line no-await-in-loop -- reset drops schema objects serially while FK checks are disabled for deterministic cleanup.
      await db.schema
        .dropTable(table)
        .ifExists()
        .execute()
        .catch(() => undefined);
    }
    await db.schema
      .dropTable(MIGRATION_TABLE)
      .ifExists()
      .execute()
      .catch(() => undefined);
    await sql`SET FOREIGN_KEY_CHECKS = 1`.execute(db);
    return;
  }

  if (driver === 'mssql') {
    const tableNames = [...ALL_SCHEMA_TABLES, MIGRATION_TABLE];
    const tableNameList = tableNames.map(quoteMssqlStringLiteral).join(', ');

    await sql
      .raw(`
      declare @sql nvarchar(max) = N'';

      select @sql = @sql
        + N'alter table '
        + quotename(object_schema_name(parent_object_id))
        + N'.'
        + quotename(object_name(parent_object_id))
        + N' drop constraint '
        + quotename(name)
        + N';'
      from sys.foreign_keys
      where (
          object_schema_name(parent_object_id) = schema_name()
          and object_name(parent_object_id) in (${tableNameList})
        )
        or (
          object_schema_name(referenced_object_id) = schema_name()
          and object_name(referenced_object_id) in (${tableNameList})
        );

      if len(@sql) > 0
        exec sp_executesql @sql;
    `)
      .execute(db)
      .catch(() => undefined);

    for (const table of tableNames) {
      // eslint-disable-next-line no-await-in-loop -- reset cleanup tolerates missing tables and keeps destructive drops ordered for diagnostics.
      await sql
        .raw(`DROP TABLE IF EXISTS ${quoteMssqlIdentifier(table)}`)
        .execute(db)
        .catch(() => undefined);
    }
    return;
  }

  // PostgreSQL: use CASCADE so a single DROP per table removes dependent
  // constraints without needing strict FK ordering.
  for (const table of ALL_SCHEMA_TABLES) {
    // eslint-disable-next-line no-await-in-loop -- reset cleanup tolerates missing tables and keeps destructive drops ordered for diagnostics.
    await sql`DROP TABLE IF EXISTS ${sql.raw(table)} CASCADE`.execute(db).catch(() => undefined);
  }
  await sql`DROP TABLE IF EXISTS ${sql.raw(MIGRATION_TABLE)} CASCADE`
    .execute(db)
    .catch(() => undefined);
}

/**
 * Remove all rows from all Tixkit tables without dropping the schema.
 * Intended for test `beforeEach` cleanup so that multiple test suites can
 * share the same migrated database without one suite's `dropTable` destroying
 * another's concurrent queries.
 *
 * Uses each driver's compatible bulk cleanup syntax while resetting
 * auto-increment/identity counters where the database supports it.
 */
export async function truncateAllData(db: Database): Promise<void> {
  const driver = getDriver();
  const tableList = ALL_SCHEMA_TABLES.join(', ');

  if (driver === 'mysql') {
    await sql`SET FOREIGN_KEY_CHECKS = 0`.execute(db);
    for (const table of ALL_SCHEMA_TABLES) {
      // eslint-disable-next-line no-await-in-loop -- test cleanup truncates each table serially while FK checks are disabled.
      await sql`TRUNCATE TABLE ${sql.raw(table)}`.execute(db).catch(() => undefined);
    }
    await sql`SET FOREIGN_KEY_CHECKS = 1`.execute(db);
    return;
  }

  if (driver === 'mssql') {
    for (const table of ALL_SCHEMA_TABLES) {
      // eslint-disable-next-line no-await-in-loop -- constraints must be disabled table-by-table before deleting across FK relationships.
      await sql
        .raw(`ALTER TABLE ${quoteMssqlIdentifier(table)} NOCHECK CONSTRAINT ALL`)
        .execute(db)
        .catch(() => undefined);
    }

    // eslint-disable-next-line unicorn/no-array-reverse -- ES2023 toReversed is not available in this package's TS lib target.
    for (const table of [...ALL_SCHEMA_TABLES].reverse()) {
      // eslint-disable-next-line no-await-in-loop -- test cleanup deletes in reverse dependency order for stable diagnostics.
      await sql
        .raw(`DELETE FROM ${quoteMssqlIdentifier(table)}`)
        .execute(db)
        .catch(() => undefined);
      // eslint-disable-next-line no-await-in-loop -- not every table has an identity column, so failed reseeds are ignored.
      await sql
        .raw(`DBCC CHECKIDENT (${quoteMssqlStringLiteral(table)}, RESEED, 0) WITH NO_INFOMSGS`)
        .execute(db)
        .catch(() => undefined);
    }

    for (const table of ALL_SCHEMA_TABLES) {
      // eslint-disable-next-line no-await-in-loop -- constraints are re-enabled after all table deletes complete.
      await sql
        .raw(`ALTER TABLE ${quoteMssqlIdentifier(table)} WITH CHECK CHECK CONSTRAINT ALL`)
        .execute(db)
        .catch(() => undefined);
    }
    return;
  }

  // PostgreSQL: single TRUNCATE with CASCADE resets all tables atomically.
  await sql.raw(`TRUNCATE TABLE ${tableList} RESTART IDENTITY CASCADE`).execute(db);
}

/**
 * Run all pending Kysely migrations against the database identified by
 * `dbUrl` (or the process env DATABASE_URL / DATABASE_URL_MYSQL when
 * omitted). Safe to call repeatedly: already-applied migrations are skipped.
 *
 * Returns the list of migration result entries so callers (such as test
 * global setup) can inspect what happened without parsing stdout.
 */
export async function runMigrations(dbUrl?: string): Promise<void> {
  const db = createDb(dbUrl);
  try {
    await adoptExistingInitialSchema(db);

    const migrator = new Migrator({
      db,
      provider: new TixkitMigrationProvider(),
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
      throw error;
    }

    console.log('All migrations completed');
  } finally {
    await db.destroy();
  }
}

/**
 * Drop all tables and re-run migrations from scratch. Intended for
 * `bun run db:reset` and for recovering from partial/stale schema states
 * that `runMigrations` alone cannot repair.
 */
export async function resetDatabase(dbUrl?: string): Promise<void> {
  const db = createDb(dbUrl);
  try {
    await dropAllTables(db);
  } finally {
    await db.destroy();
  }
  await runMigrations(dbUrl);
}

// ---------------------------------------------------------------------------
// Script entrypoint (runs when executed directly via `tsx src/migrate.ts`)
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  try {
    await runMigrations();
  } catch (err) {
    console.error(buildMigrationFailureMessage(err));
    process.exit(1);
  }
}

// Run when invoked as a script, not when imported.
const isMainModule =
  process.argv[1]?.endsWith('migrate.ts') || process.argv[1]?.endsWith('migrate.js');
if (isMainModule) {
  main();
}
