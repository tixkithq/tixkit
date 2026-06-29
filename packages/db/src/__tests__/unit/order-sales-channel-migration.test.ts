import { describe, expect, it } from 'vitest';

import { TixkitMigrationProvider } from '../../migrate.js';
import { OrderSalesChannelMigration } from '../../migrations/0031_order_sales_channel.js';

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

    expect(Object.keys(migrations).at(-1)).toBe('0031_order_sales_channel');
    expect(migrations['0031_order_sales_channel']).toBe(OrderSalesChannelMigration);
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
