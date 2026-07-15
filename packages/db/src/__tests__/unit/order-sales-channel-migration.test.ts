import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { TixkitMigrationProvider } from '../../migrate.js';
import { OrderSalesChannelMigration } from '../../migrations/0031_order_sales_channel.js';
import { ScanLogsTicketIndexMigration } from '../../migrations/0032_scan_logs_ticket_index.js';
import { EmailJobsTemplateVersionForeignKeyMigration } from '../../migrations/0033_email_jobs_template_version_fk.js';
import { OfflineCheckInBulkSyncMigration } from '../../migrations/0034_offline_check_in_bulk_sync.js';
import { OfflineCheckInBulkSyncHardeningMigration } from '../../migrations/0035_offline_check_in_bulk_sync_hardening.js';
import { OrganizationBoxOfficeSettingsMigration } from '../../migrations/0036_organization_box_office_settings.js';
import { TicketListingsMigration } from '../../migrations/0037_ticket_listings.js';
import { EventResalePolicyMigration } from '../../migrations/0038_event_resale_policy.js';
import { ResaleCheckoutReservationsMigration } from '../../migrations/0039_resale_checkout_reservations.js';
import { ScannerDeviceScopesMigration } from '../../migrations/0040_scanner_device_scopes.js';
import { UploadArtifactConsumptionMigration } from '../../migrations/0041_upload_artifact_consumption.js';
import { AccessRuleRedemptionsMigration } from '../../migrations/0042_access_rule_redemptions.js';
import { WaitlistCheckoutReservationsMigration } from '../../migrations/0043_waitlist_checkout_reservations.js';
import { CheckoutHoldOccurrencesMigration } from '../../migrations/0044_checkout_hold_occurrences.js';
import { TableQueryIndexesMigration } from '../../migrations/0045_table_query_indexes.js';
import { OrganizationClerkIdUniqueMigration } from '../../migrations/0046_organization_clerk_id_unique.js';
import { EventPublicRevisionMigration } from '../../migrations/0047_event_public_revision.js';
import { HotQueryIndexesMigration } from '../../migrations/0048_hot_query_indexes.js';
import { EventFeePassThroughMigration } from '../../migrations/0049_event_fee_pass_through.js';
import { EventAgeEligibilityMigration } from '../../migrations/0052_event_age_eligibility.js';
import { OrganizationMemberUniqueMigration } from '../../migrations/0053_organization_member_unique.js';
import { CheckInActivityIndexesMigration } from '../../migrations/0054_check_in_activity_indexes.js';
import { CheckInActivitySequenceMigration } from '../../migrations/0055_check_in_activity_sequence.js';
import { CheckoutHoldCapacityIndexMigration } from '../../migrations/0056_checkout_hold_capacity_index.js';
import { ImportPlatformMigration } from '../../migrations/0058_import_platform.js';
import { MigrationDomainSupportMigration } from '../../migrations/0059_migration_domain_support.js';
import { MigrationPermissionsMigration } from '../../migrations/0060_migration_permissions.js';
import { EventOnboardingReadinessMigration } from '../../migrations/0057_event_onboarding_readiness.js';
import { EventCheckoutConfigurationRevisionMigration } from '../../migrations/0063_event_checkout_configuration_revision.js';
import { OrganizationEventDefaultsMigration } from '../../migrations/0064_organization_event_defaults.js';
import { AgentExecutionMigration } from '../../migrations/0065_agent_execution.js';
import { AgentIdentityMigration } from '../../migrations/0066_agent_identity.js';
import { AgentMemoryMigration } from '../../migrations/0067_agent_memory.js';
import { PortableExportsMigration } from '../../migrations/0068_portable_exports.js';
import { PortableExportBuildLeasesMigration } from '../../migrations/0069_portable_export_build_leases.js';
import { PortableImportPreflightsMigration } from '../../migrations/0070_portable_import_preflights.js';
import { PortableImportApprovalsMigration } from '../../migrations/0071_portable_import_approvals.js';
import { PortableImportRebindingsMigration } from '../../migrations/0072_portable_import_rebindings.js';
import { PortableImportCommitAuthorizationsMigration } from '../../migrations/0073_portable_import_commit_authorizations.js';
import { ImportEventImmutabilityMigration } from '../../migrations/0074_import_event_immutability.js';
import { EventMediaAssetsMigration } from '../../migrations/0075_event_media_assets.js';
import { MediaObjectCleanupJobsMigration } from '../../migrations/0076_media_object_cleanup_jobs.js';
import { PortableImportCutoverProofsMigration } from '../../migrations/0077_portable_import_cutover_proofs.js';
import { PortableExportAuthorizationsMigration } from '../../migrations/0078_portable_export_authorizations.js';
import { PortableRebindingAuthoritiesMigration } from '../../migrations/0079_portable_rebinding_authorities.js';
import { PortableImportLineageCheckpointsMigration } from '../../migrations/0080_portable_import_lineage_checkpoints.js';
import { AgentOAuthCredentialsMigration } from '../../migrations/0081_agent_oauth_credentials.js';
import { AgentActionsMigration } from '../../migrations/0082_agent_actions.js';
import { AgentApprovalActionUniqueMigration } from '../../migrations/0083_agent_approval_action_unique.js';
import { AgentPlansMigration } from '../../migrations/0084_agent_plans.js';
import { AgentExecutionPlanBindingMigration } from '../../migrations/0085_agent_execution_plan_binding.js';
import { AgentActionResultsMigration } from '../../migrations/0086_agent_action_results.js';

const offlineCheckInBulkSyncMigrationPath = new URL(
  '../../migrations/0034_offline_check_in_bulk_sync.ts',
  import.meta.url,
);
const offlineCheckInBulkSyncHardeningMigrationPath = new URL(
  '../../migrations/0035_offline_check_in_bulk_sync_hardening.ts',
  import.meta.url,
);
const organizationBoxOfficeSettingsMigrationPath = new URL(
  '../../migrations/0036_organization_box_office_settings.ts',
  import.meta.url,
);
const ticketListingsMigrationPath = new URL(
  '../../migrations/0037_ticket_listings.ts',
  import.meta.url,
);
const eventResalePolicyMigrationPath = new URL(
  '../../migrations/0038_event_resale_policy.ts',
  import.meta.url,
);
const eventPublicRevisionMigrationPath = new URL(
  '../../migrations/0047_event_public_revision.ts',
  import.meta.url,
);

type AddedColumn = {
  tableName: string;
  columnName: string;
  notNull: boolean;
  defaultValue?: unknown;
};

type ConstraintOperation = {
  tableName: string;
  constraintName: string;
};

class FakeColumnBuilder {
  notNullValue = false;
  defaultValue?: unknown;

  notNull() {
    this.notNullValue = true;
    return this;
  }

  defaultTo(value: unknown) {
    this.defaultValue = value;
    return this;
  }
}

class FakeAlterTableBuilder {
  constructor(
    private readonly tableName: string,
    private readonly db: FakeOrderSalesChannelDb,
  ) {}

  addColumn(
    columnName: string,
    _dataType: unknown,
    configure?: (builder: FakeColumnBuilder) => FakeColumnBuilder,
  ) {
    const columnBuilder = new FakeColumnBuilder();
    configure?.(columnBuilder);
    this.db.addedColumns.push({
      tableName: this.tableName,
      columnName,
      notNull: columnBuilder.notNullValue,
      defaultValue: columnBuilder.defaultValue,
    });
    return this;
  }

  dropColumn(columnName: string) {
    this.db.droppedColumns.push({ tableName: this.tableName, columnName });
    return this;
  }

  addCheckConstraint(constraintName: string, _expression: unknown) {
    this.db.addedConstraints.push({
      tableName: this.tableName,
      constraintName,
    });
    return this;
  }

  dropConstraint(constraintName: string) {
    this.db.droppedConstraints.push({
      tableName: this.tableName,
      constraintName,
    });
    return this;
  }

  async execute() {
    return undefined;
  }
}

class FakeCreateIndexBuilder {
  private tableName?: string;
  private columnNames: string[] = [];

  constructor(
    private readonly indexName: string,
    private readonly db: FakeOrderSalesChannelDb,
  ) {}

  on(tableName: string) {
    this.tableName = tableName;
    return this;
  }

  columns(columnNames: string[]) {
    this.columnNames = columnNames;
    return this;
  }

  async execute() {
    this.db.createdIndexes.push({
      indexName: this.indexName,
      tableName: this.tableName,
      columnNames: this.columnNames,
    });
  }
}

class FakeDropIndexBuilder {
  tableName?: string;
  ifExistsCalled = false;

  constructor(
    private readonly indexName: string,
    private readonly db: FakeOrderSalesChannelDb,
  ) {}

  on(tableName: string) {
    this.tableName = tableName;
    return this;
  }

  ifExists() {
    this.ifExistsCalled = true;
    return this;
  }

  async execute() {
    this.db.droppedIndexes.push({
      indexName: this.indexName,
      tableName: this.tableName,
      ifExists: this.ifExistsCalled,
    });
  }
}

class FakeOrderSalesChannelDb {
  readonly addedColumns: AddedColumn[] = [];
  readonly addedConstraints: ConstraintOperation[] = [];
  readonly droppedColumns: { tableName: string; columnName: string }[] = [];
  readonly droppedConstraints: ConstraintOperation[] = [];
  readonly createdIndexes: {
    indexName: string;
    tableName?: string;
    columnNames: string[];
  }[] = [];
  readonly droppedIndexes: {
    indexName: string;
    tableName?: string;
    ifExists: boolean;
  }[] = [];

  readonly schema = {
    alterTable: (tableName: string) => new FakeAlterTableBuilder(tableName, this),
    createIndex: (indexName: string) => new FakeCreateIndexBuilder(indexName, this),
    dropIndex: (indexName: string) => new FakeDropIndexBuilder(indexName, this),
  };
}

describe('OrderSalesChannelMigration', () => {
  it('is registered with the production migrator provider', async () => {
    const migrations = await new TixkitMigrationProvider().getMigrations();

    expect(Object.keys(migrations).at(-1)).toBe('0086_agent_action_results');
    expect(migrations['0071_portable_import_approvals']).toBe(PortableImportApprovalsMigration);
    expect(migrations['0072_portable_import_rebindings']).toBe(PortableImportRebindingsMigration);
    expect(migrations['0073_portable_import_commit_authorizations']).toBe(
      PortableImportCommitAuthorizationsMigration,
    );
    expect(migrations['0074_import_event_immutability']).toBe(ImportEventImmutabilityMigration);
    expect(migrations['0075_event_media_assets']).toBe(EventMediaAssetsMigration);
    expect(migrations['0076_media_object_cleanup_jobs']).toBe(MediaObjectCleanupJobsMigration);
    expect(migrations['0077_portable_import_cutover_proofs']).toBe(
      PortableImportCutoverProofsMigration,
    );
    expect(migrations['0078_portable_export_authorizations']).toBe(
      PortableExportAuthorizationsMigration,
    );
    expect(migrations['0079_portable_rebinding_authorities']).toBe(
      PortableRebindingAuthoritiesMigration,
    );
    expect(migrations['0080_portable_import_lineage_checkpoints']).toBe(
      PortableImportLineageCheckpointsMigration,
    );
    expect(migrations['0081_agent_oauth_credentials']).toBe(AgentOAuthCredentialsMigration);
    expect(migrations['0082_agent_actions']).toBe(AgentActionsMigration);
    expect(migrations['0083_agent_approval_action_unique']).toBe(
      AgentApprovalActionUniqueMigration,
    );
    expect(migrations['0084_agent_plans']).toBe(AgentPlansMigration);
    expect(migrations['0085_agent_execution_plan_binding']).toBe(
      AgentExecutionPlanBindingMigration,
    );
    expect(migrations['0086_agent_action_results']).toBe(AgentActionResultsMigration);
    expect(migrations['0070_portable_import_preflights']).toBe(PortableImportPreflightsMigration);
    expect(migrations['0069_portable_export_build_leases']).toBe(
      PortableExportBuildLeasesMigration,
    );
    expect(migrations['0068_portable_exports']).toBe(PortableExportsMigration);
    expect(migrations['0067_agent_memory']).toBe(AgentMemoryMigration);
    expect(migrations['0066_agent_identity']).toBe(AgentIdentityMigration);
    expect(migrations['0065_agent_execution']).toBe(AgentExecutionMigration);
    expect(migrations['0064_organization_event_defaults']).toBe(OrganizationEventDefaultsMigration);
    expect(migrations['0063_event_checkout_configuration_revision']).toBe(
      EventCheckoutConfigurationRevisionMigration,
    );
    expect(migrations['0059_import_platform']).toBe(ImportPlatformMigration);
    expect(migrations['0060_migration_domain_support']).toBe(MigrationDomainSupportMigration);
    expect(migrations['0061_migration_permissions']).toBe(MigrationPermissionsMigration);
    expect(migrations['0052_event_age_eligibility']).toBe(EventAgeEligibilityMigration);
    expect(migrations['0053_organization_member_unique']).toBe(OrganizationMemberUniqueMigration);
    expect(migrations['0054_check_in_activity_indexes']).toBe(CheckInActivityIndexesMigration);
    expect(migrations['0055_check_in_activity_sequence']).toBe(CheckInActivitySequenceMigration);
    expect(migrations['0056_checkout_hold_capacity_index']).toBe(
      CheckoutHoldCapacityIndexMigration,
    );
    expect(migrations['0057_event_onboarding_readiness']).toBe(EventOnboardingReadinessMigration);
    expect(migrations['0031_order_sales_channel']).toBe(OrderSalesChannelMigration);
    expect(migrations['0032_scan_logs_ticket_index']).toBe(ScanLogsTicketIndexMigration);
    expect(migrations['0033_email_jobs_template_version_fk']).toBe(
      EmailJobsTemplateVersionForeignKeyMigration,
    );
    expect(migrations['0034_offline_check_in_bulk_sync']).toBe(OfflineCheckInBulkSyncMigration);
    expect(migrations['0035_offline_check_in_bulk_sync_hardening']).toBe(
      OfflineCheckInBulkSyncHardeningMigration,
    );
    expect(migrations['0036_organization_box_office_settings']).toBe(
      OrganizationBoxOfficeSettingsMigration,
    );
    expect(migrations['0037_ticket_listings']).toBe(TicketListingsMigration);
    expect(migrations['0038_event_resale_policy']).toBe(EventResalePolicyMigration);
    expect(migrations['0039_resale_checkout_reservations']).toBe(
      ResaleCheckoutReservationsMigration,
    );
    expect(migrations['0040_scanner_device_scopes']).toBe(ScannerDeviceScopesMigration);
    expect(migrations['0041_upload_artifact_consumption']).toBe(UploadArtifactConsumptionMigration);
    expect(migrations['0042_access_rule_redemptions']).toBe(AccessRuleRedemptionsMigration);
    expect(migrations['0043_waitlist_checkout_reservations']).toBe(
      WaitlistCheckoutReservationsMigration,
    );
    expect(migrations['0044_checkout_hold_occurrences']).toBe(CheckoutHoldOccurrencesMigration);
    expect(migrations['0045_table_query_indexes']).toBe(TableQueryIndexesMigration);
    expect(migrations['0046_organization_clerk_id_unique']).toBe(
      OrganizationClerkIdUniqueMigration,
    );
    expect(migrations['0047_event_public_revision']).toBe(EventPublicRevisionMigration);
    expect(migrations['0048_hot_query_indexes']).toBe(HotQueryIndexesMigration);
    expect(migrations['0049_event_fee_pass_through']).toBe(EventFeePassThroughMigration);
  });

  it('creates a covering index for active checkout-hold capacity reads', async () => {
    const db = new FakeOrderSalesChannelDb();

    await CheckoutHoldCapacityIndexMigration.up(db as never);

    expect(db.createdIndexes).toEqual([
      {
        indexName: 'idx_checkout_holds_pool_status_expires_quantity',
        tableName: 'checkout_holds',
        columnNames: ['inventory_pool_id', 'status', 'expires_at', 'quantity'],
      },
    ]);

    await CheckoutHoldCapacityIndexMigration.down?.(db as never);

    expect(db.droppedIndexes).toEqual([
      {
        indexName: 'idx_checkout_holds_pool_status_expires_quantity',
        tableName: 'checkout_holds',
        ifExists: true,
      },
    ]);
  });

  it('runs MSSQL event revision DDL and backfill in separate batches', () => {
    const source = readFileSync(eventPublicRevisionMigrationPath, 'utf8');

    expect(source).toMatch(
      /alter table events add public_revision datetime2 null;\s*`\.execute\(db\);\s*await sql`\s*update events/,
    );
  });

  it('creates composite hot-query indexes for public and reporting reads', async () => {
    const db = new FakeOrderSalesChannelDb();

    await HotQueryIndexesMigration.up(db as never);

    expect(db.createdIndexes).toEqual([
      {
        indexName: 'idx_content_documents_event_channel_status_locale',
        tableName: 'content_documents',
        columnNames: ['event_id', 'channel', 'status', 'locale'],
      },
      {
        indexName: 'idx_event_pages_event_locale_default',
        tableName: 'event_pages',
        columnNames: ['event_id', 'locale', 'is_default'],
      },
      {
        indexName: 'idx_questions_event_status_sort',
        tableName: 'questions',
        columnNames: ['event_id', 'status', 'sort_order', 'id'],
      },
      {
        indexName: 'idx_checkout_sessions_tenant_event_status',
        tableName: 'checkout_sessions',
        columnNames: ['tenant_id', 'event_id', 'status'],
      },
      {
        indexName: 'idx_refunds_order_status_created',
        tableName: 'refunds',
        columnNames: ['order_id', 'status', 'created_at'],
      },
      {
        indexName: 'idx_orders_report_event_status_created',
        tableName: 'orders',
        columnNames: ['tenant_id', 'event_id', 'status', 'created_at', 'id'],
      },
      {
        indexName: 'idx_order_line_items_order_ticket',
        tableName: 'order_line_items',
        columnNames: ['order_id', 'ticket_type_id'],
      },
      {
        indexName: 'idx_order_tax_snapshots_order_rule',
        tableName: 'order_tax_snapshots',
        columnNames: ['order_id', 'tax_rule_name', 'rate'],
      },
    ]);
  });

  it('keeps event resale policy columns portable across supported SQL drivers', () => {
    const source = readFileSync(eventResalePolicyMigrationPath, 'utf8');

    expect(source).toContain("process.env.DB_DRIVER === 'mysql'");
    expect(source).toContain("process.env.DB_DRIVER === 'mssql'");
    expect(source).toContain('resale_enabled');
    expect(source).toContain('resale_max_multiplier');
    expect(source).toContain('resale_max_absolute_cents');
    expect(source).toContain('double precision not null default 1');
    expect(source).toContain('double not null default 1');
    expect(source).toContain('float not null');
  });

  it('keeps ticket listings portable with a cross-database active listing key', () => {
    const source = readFileSync(ticketListingsMigrationPath, 'utf8');

    expect(source).toContain("process.env.DB_DRIVER === 'mysql'");
    expect(source).toContain("process.env.DB_DRIVER === 'mssql'");
    expect(source).toContain("createTable('ticket_listings')");
    expect(source).toContain('active_listing_key');
    expect(source).toContain('ticket_listings_active_unique');
    expect(source).toContain("status in ('listed', 'delisted', 'sold', 'expired')");
    expect(source).toContain('price_cents >= 0');
  });

  it('keeps organization box-office settings migration portable across supported SQL drivers', () => {
    const source = readFileSync(organizationBoxOfficeSettingsMigrationPath, 'utf8');

    expect(source).toContain("process.env.DB_DRIVER === 'mysql'");
    expect(source).toContain("process.env.DB_DRIVER === 'mssql'");
    expect(source).toContain('information_schema.columns');
    expect(source).toContain('jsonb not null');
    expect(source).toContain('modify column box_office_settings json not null');
    expect(source).toContain('isjson(box_office_settings) = 1');
  });

  it('keeps offline bulk sync migration types portable across supported SQL drivers', () => {
    const source = readFileSync(offlineCheckInBulkSyncMigrationPath, 'utf8');

    expect(source).toContain("process.env.DB_DRIVER === 'mysql'");
    expect(source).toContain("process.env.DB_DRIVER === 'mssql'");
    expect(source).toContain("if (isMssql()) return 'datetime2'");
    expect(source).toContain('if (isMssql()) return sql`nvarchar(max)`');
    expect(source).toContain('return isMysql() || isMssql()');
    expect(source).not.toContain("return isMysql() ? 'timestamp' : 'timestamptz'");
    expect(source).not.toContain("return isMysql() ? 'json' : 'jsonb'");
  });

  it('keeps processed async chunk payloads nullable during hardening rollbacks', () => {
    const source = readFileSync(offlineCheckInBulkSyncHardeningMigrationPath, 'utf8');

    expect(source).toContain('modify column payload json null');
    expect(source).toContain('alter column payload drop not null');
    expect(source).toContain('information_schema.columns');
    expect(source).toContain('information_schema.statistics');
    expect(source).toContain("addMysqlColumnIfMissing(db, 'offline_check_in_sync_jobs'");
    expect(source).toContain('mysqlIndexExists(');
    expect(source).not.toContain('modify column payload json not null');
    expect(source).not.toContain('alter column payload set not null');
  });

  it('adds order attribution columns and a tenant sales-channel index', async () => {
    const db = new FakeOrderSalesChannelDb();

    await OrderSalesChannelMigration.up(db as never);

    expect(db.addedColumns).toEqual([
      {
        tableName: 'orders',
        columnName: 'sales_channel',
        notNull: true,
        defaultValue: 'online',
      },
      {
        tableName: 'orders',
        columnName: 'operator_id',
        notNull: false,
        defaultValue: undefined,
      },
      {
        tableName: 'orders',
        columnName: 'tender_type',
        notNull: false,
        defaultValue: undefined,
      },
    ]);
    expect(db.addedConstraints).toEqual([
      {
        tableName: 'orders',
        constraintName: 'orders_sales_channel_valid',
      },
      {
        tableName: 'orders',
        constraintName: 'orders_tender_type_valid',
      },
      {
        tableName: 'orders',
        constraintName: 'orders_box_office_attribution_required',
      },
    ]);
    expect(db.createdIndexes).toEqual([
      {
        indexName: 'idx_orders_sales_channel',
        tableName: 'orders',
        columnNames: ['tenant_id', 'sales_channel'],
      },
    ]);
  });

  it('rolls back the attribution index and columns in reverse order', async () => {
    const db = new FakeOrderSalesChannelDb();

    await OrderSalesChannelMigration.down?.(db as never);

    expect(db.droppedIndexes).toEqual([
      {
        indexName: 'idx_orders_sales_channel',
        tableName: 'orders',
        ifExists: true,
      },
    ]);
    expect(db.droppedConstraints).toEqual([
      {
        tableName: 'orders',
        constraintName: 'orders_box_office_attribution_required',
      },
      {
        tableName: 'orders',
        constraintName: 'orders_tender_type_valid',
      },
      {
        tableName: 'orders',
        constraintName: 'orders_sales_channel_valid',
      },
    ]);
    expect(db.droppedColumns).toEqual([
      { tableName: 'orders', columnName: 'tender_type' },
      { tableName: 'orders', columnName: 'operator_id' },
      { tableName: 'orders', columnName: 'sales_channel' },
    ]);
  });
});
