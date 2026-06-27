import { sql } from 'kysely';
import type { ColumnDataType } from 'kysely';
import type { Migration } from 'kysely/migration';

function varchar(len: number): ColumnDataType {
  return `varchar(${len})`;
}

function textType(): ColumnDataType {
  return 'text';
}

function timestampType(): ColumnDataType {
  return process.env.DB_DRIVER === 'mysql' ? 'datetime' : 'timestamptz';
}

function jsonType(): ColumnDataType {
  return process.env.DB_DRIVER === 'mysql' ? 'json' : 'jsonb';
}

function nowDefault() {
  return process.env.DB_DRIVER === 'mysql' ? sql`CURRENT_TIMESTAMP` : sql`now()`;
}

export const PaymentCompensationsMigration: Migration = {
  async up(db): Promise<void> {
    await db.schema
      .createTable('payment_compensations')
      .addColumn('id', varchar(32), (col) => col.primaryKey())
      .addColumn('tenant_id', varchar(32), (col) => col.notNull())
      .addColumn('checkout_session_id', varchar(32), (col) => col.notNull())
      .addColumn('payment_intent_id', varchar(32))
      .addColumn('provider', varchar(50), (col) => col.notNull())
      .addColumn('provider_intent_id', varchar(255), (col) => col.notNull())
      .addColumn('amount_cents', 'bigint', (col) => col.notNull())
      .addColumn('currency', varchar(3), (col) => col.notNull())
      .addColumn('action', varchar(50), (col) => col.notNull())
      .addColumn('status', varchar(50), (col) => col.notNull().defaultTo('pending'))
      .addColumn('provider_compensation_id', varchar(255))
      .addColumn('attempts', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('reason', textType(), (col) => col.notNull())
      .addColumn('last_error', textType())
      .addColumn('metadata', jsonType(), (col) => col.notNull())
      .addColumn('created_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addColumn('updated_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addUniqueConstraint('payment_compensations_provider_intent_session_unique', [
        'provider',
        'provider_intent_id',
        'checkout_session_id',
      ])
      .addCheckConstraint('payment_compensations_amount_nonnegative', sql`amount_cents >= 0`)
      .addForeignKeyConstraint('payment_compensations_tenant_fk', ['tenant_id'], 'tenants', ['id'])
      .addForeignKeyConstraint('payment_compensations_session_fk', ['checkout_session_id'], 'checkout_sessions', ['id'])
      .addForeignKeyConstraint('payment_compensations_pi_fk', ['payment_intent_id'], 'payment_intents', ['id'])
      .execute();

    await db.schema
      .createIndex('idx_payment_compensations_tenant')
      .on('payment_compensations')
      .columns(['tenant_id'])
      .execute();
    await db.schema
      .createIndex('idx_payment_compensations_status')
      .on('payment_compensations')
      .columns(['status'])
      .execute();
    await db.schema
      .createIndex('idx_payment_compensations_payment_intent')
      .on('payment_compensations')
      .columns(['payment_intent_id'])
      .execute();
  },

  async down(db): Promise<void> {
    await db.schema.dropTable('payment_compensations').ifExists().execute();
  },
};
