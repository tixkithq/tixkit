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
    this.db.addedConstraints.push({ tableName: this.tableName, constraintName });
    return this;
  }

  dropConstraint(constraintName: string) {
    this.db.droppedConstraints.push({ tableName: this.tableName, constraintName });
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
  readonly createdIndexes: { indexName: string; tableName?: string; columnNames: string[] }[] = [];
  readonly droppedIndexes: { indexName: string; tableName?: string; ifExists: boolean }[] = [];

  readonly schema = {
    alterTable: (tableName: string) => new FakeAlterTableBuilder(tableName, this),
    createIndex: (indexName: string) => new FakeCreateIndexBuilder(indexName, this),
    dropIndex: (indexName: string) => new FakeDropIndexBuilder(indexName, this),
  };
}

describe('OrderSalesChannelMigration', () => {
  it('is registered with the production migrator provider', async () => {
    const migrations = await new TixkitMigrationProvider().getMigrations();

    expect(Object.keys(migrations).at(-1)).toBe('0039_resale_checkout_reservations');
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
    expect(source).toContain("if (isMssql()) return 'nvarchar(max)'");
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
