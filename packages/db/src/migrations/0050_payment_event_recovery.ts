import type { ColumnDataType, Expression } from 'kysely';
import type { Migration } from 'kysely/migration';
import { sql } from 'kysely';

function isMysql() {
  return process.env.DB_DRIVER === 'mysql';
}

function isMssql() {
  return process.env.DB_DRIVER === 'mssql';
}

function timestampType(): ColumnDataType {
  if (isMysql()) return 'timestamp';
  if (isMssql()) return 'datetime2' as ColumnDataType;

  return 'timestamptz';
}

function textType(): ColumnDataType | Expression<unknown> {
  if (isMssql()) return sql`nvarchar(max)`;

  return 'text';
}

function varchar(len: number): ColumnDataType {
  return `varchar(${len})`;
}

export const PaymentEventRecoveryMigration: Migration = {
  async up(db): Promise<void> {
    await db.schema
      .alterTable('payment_events')
      .addColumn('recovery_status', varchar(50), (col) => col.notNull().defaultTo('pending'))
      .addColumn('recovery_attempts', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('recovery_owner', varchar(255))
      .addColumn('recovery_claimed_until', timestampType())
      .addColumn('next_recovery_at', timestampType())
      .addColumn('last_recovery_error', textType())
      .addColumn('recovery_updated_at', timestampType())
      .execute();

    await db.schema
      .createIndex('idx_payment_events_recovery_ready')
      .on('payment_events')
      .columns(['processed_at', 'recovery_status', 'next_recovery_at', 'recovery_claimed_until'])
      .execute();
  },

  async down(db): Promise<void> {
    await db.schema
      .dropIndex('idx_payment_events_recovery_ready')
      .on('payment_events')
      .ifExists()
      .execute();

    await db.schema
      .alterTable('payment_events')
      .dropColumn('recovery_updated_at')
      .dropColumn('last_recovery_error')
      .dropColumn('next_recovery_at')
      .dropColumn('recovery_claimed_until')
      .dropColumn('recovery_owner')
      .dropColumn('recovery_attempts')
      .dropColumn('recovery_status')
      .execute();
  },
};
