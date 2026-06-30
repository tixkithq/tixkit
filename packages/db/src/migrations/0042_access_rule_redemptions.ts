import type { ColumnDataType } from 'kysely';
import type { Migration } from 'kysely/migration';

function varchar(len: number): ColumnDataType {
  return `varchar(${len})`;
}

function isMssql(): boolean {
  return process.env.DB_DRIVER === 'mssql';
}

function timestampType(): ColumnDataType {
  if (isMssql()) return 'datetime2';
  return process.env.DB_DRIVER === 'mysql' ? 'datetime' : 'timestamptz';
}

export const AccessRuleRedemptionsMigration: Migration = {
  async up(db): Promise<void> {
    await db.schema
      .createTable('access_rule_redemptions')
      .addColumn('id', varchar(32), (col) => col.primaryKey())
      .addColumn('access_rule_id', varchar(32), (col) => col.notNull())
      .addColumn('ticket_type_id', varchar(32), (col) => col.notNull())
      .addColumn('event_id', varchar(32), (col) => col.notNull())
      .addColumn('checkout_session_id', varchar(32), (col) => col.notNull())
      .addColumn('order_id', varchar(32))
      .addColumn('tenant_id', varchar(32))
      .addColumn('created_at', timestampType(), (col) => col.notNull())
      .addUniqueConstraint('access_rule_redemptions_rule_session_unique', [
        'access_rule_id',
        'checkout_session_id',
      ])
      .addForeignKeyConstraint(
        'access_rule_redemptions_rule_fk',
        ['access_rule_id'],
        'access_rules',
        ['id'],
      )
      .addForeignKeyConstraint(
        'access_rule_redemptions_ticket_type_fk',
        ['ticket_type_id'],
        'ticket_types',
        ['id'],
      )
      .addForeignKeyConstraint('access_rule_redemptions_event_fk', ['event_id'], 'events', ['id'])
      .addForeignKeyConstraint(
        'access_rule_redemptions_session_fk',
        ['checkout_session_id'],
        'checkout_sessions',
        ['id'],
      )
      .execute();
  },

  async down(db): Promise<void> {
    await db.schema.dropTable('access_rule_redemptions').ifExists().execute();
  },
};
