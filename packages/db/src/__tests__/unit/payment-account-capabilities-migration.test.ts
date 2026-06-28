import { afterEach, describe, expect, it } from 'vitest';

import { PaymentAccountCapabilitiesMigration } from '../../migrations/0017_payment_account_capabilities.js';

const capabilityColumns = [
  'details_submitted',
  'charges_enabled',
  'payouts_enabled',
  'requirements',
  'disabled_reason',
] as const;

class FakePaymentAccountCapabilitiesDb {
  readonly addedColumns: string[] = [];
  readonly droppedColumns: string[] = [];
  private readonly columns: Set<string>;

  readonly introspection = {
    getTables: async () => [
      {
        name: 'payment_accounts',
        columns: [...this.columns].map((name) => ({ name })),
      },
    ],
  };

  readonly schema = {
    alterTable: (tableName: string) => {
      expect(tableName).toBe('payment_accounts');

      return {
        addColumn: (columnName: string) => {
          this.addedColumns.push(columnName);
          this.columns.add(columnName);

          return {
            execute: async () => undefined,
          };
        },
        dropColumn: (columnName: string) => ({
          execute: async () => {
            this.droppedColumns.push(columnName);
            this.columns.delete(columnName);
          },
        }),
      };
    },
  };

  constructor(columns: readonly string[]) {
    this.columns = new Set(columns);
  }
}

const originalDbDriver = process.env.DB_DRIVER;

afterEach(() => {
  process.env.DB_DRIVER = originalDbDriver;
});

describe('PaymentAccountCapabilitiesMigration', () => {
  it('skips capability columns already owned by the fresh initial schema', async () => {
    const db = new FakePaymentAccountCapabilitiesDb(capabilityColumns);

    await PaymentAccountCapabilitiesMigration.up(db as never);

    expect(db.addedColumns).toEqual([]);
  });

  it('adds missing capability columns for legacy databases', async () => {
    const db = new FakePaymentAccountCapabilitiesDb(['id', 'provider']);

    await PaymentAccountCapabilitiesMigration.up(db as never);

    expect(db.addedColumns).toEqual(capabilityColumns);
  });

  it('drops only existing capability columns on rollback', async () => {
    const db = new FakePaymentAccountCapabilitiesDb([
      'id',
      'details_submitted',
      'payouts_enabled',
      'disabled_reason',
    ]);

    await PaymentAccountCapabilitiesMigration.down?.(db as never);

    expect(db.droppedColumns).toEqual(['disabled_reason', 'payouts_enabled', 'details_submitted']);
  });
});
