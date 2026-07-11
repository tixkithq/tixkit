import { sql, type ColumnDataType, type Expression } from 'kysely';
import type { Migration } from 'kysely/migration';

function varchar(length: number): ColumnDataType {
  return `varchar(${length})`;
}

function timestampType(): ColumnDataType {
  if (process.env.DB_DRIVER === 'mssql') return 'datetime2';
  return process.env.DB_DRIVER === 'mysql' ? 'datetime' : 'timestamptz';
}

function booleanType(): ColumnDataType | Expression<unknown> {
  return process.env.DB_DRIVER === 'mssql' ? sql`bit` : 'boolean';
}

function falseDefault(): boolean | Expression<unknown> {
  return process.env.DB_DRIVER === 'mssql' ? sql`0` : false;
}

export const EventOnboardingReadinessMigration: Migration = {
  async up(db): Promise<void> {
    await db.schema
      .alterTable('events')
      .addColumn('version', 'integer', (column) => column.notNull().defaultTo(1))
      .addColumn('last_setup_section', varchar(100))
      .addColumn('cover_image_alt', varchar(500))
      .addColumn('seo_use_cover_image', booleanType(), (column) =>
        column.notNull().defaultTo(falseDefault()),
      )
      .execute();

    await db.schema
      .alterTable('orders')
      .addColumn('is_test', booleanType(), (column) => column.notNull().defaultTo(falseDefault()))
      .execute();
    await db.schema
      .alterTable('checkout_sessions')
      .addColumn('is_test', booleanType(), (column) => column.notNull().defaultTo(falseDefault()))
      .execute();

    await db.schema
      .alterTable('events')
      .addUniqueConstraint('events_readiness_scope_unique', [
        'tenant_id',
        'organization_id',
        'brand_id',
        'id',
      ])
      .execute();

    await db.schema
      .createTable('event_readiness_acknowledgements')
      .addColumn('id', varchar(32), (column) => column.primaryKey())
      .addColumn('tenant_id', varchar(32), (column) => column.notNull())
      .addColumn('organization_id', varchar(32), (column) => column.notNull())
      .addColumn('brand_id', varchar(32), (column) => column.notNull())
      .addColumn('event_id', varchar(32), (column) => column.notNull())
      .addColumn('step_id', varchar(100), (column) => column.notNull())
      .addColumn('step_version', 'integer', (column) => column.notNull())
      .addColumn('subject_fingerprint', varchar(64), (column) => column.notNull())
      .addColumn('actor_id', varchar(255), (column) => column.notNull())
      .addColumn('acknowledged_at', timestampType(), (column) => column.notNull())
      .addUniqueConstraint('event_readiness_ack_scope_unique', [
        'tenant_id',
        'organization_id',
        'brand_id',
        'event_id',
        'step_id',
      ])
      .addForeignKeyConstraint(
        'event_readiness_ack_scope_fk',
        ['tenant_id', 'organization_id', 'brand_id', 'event_id'],
        'events',
        ['tenant_id', 'organization_id', 'brand_id', 'id'],
        (constraint) => constraint.onDelete('cascade'),
      )
      .execute();

    await db.schema
      .createIndex('idx_event_readiness_ack_event')
      .on('event_readiness_acknowledgements')
      .columns(['tenant_id', 'organization_id', 'brand_id', 'event_id'])
      .execute();
  },

  async down(db): Promise<void> {
    await db.schema.dropTable('event_readiness_acknowledgements').ifExists().execute();
    if (process.env.DB_DRIVER === 'mysql') {
      try {
        await sql`alter table events drop index events_readiness_scope_unique`.execute(db);
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code !== 'ER_CANT_DROP_FIELD_OR_KEY') throw error;
      }
    } else {
      await db.schema
        .alterTable('events')
        .dropConstraint('events_readiness_scope_unique')
        .ifExists()
        .execute();
    }
    if (process.env.DB_DRIVER === 'mysql') {
      try {
        await db.schema.alterTable('orders').dropColumn('is_test').execute();
      } catch (error) {
        if ((error as { code?: string }).code !== 'ER_CANT_DROP_FIELD_OR_KEY') throw error;
      }
    } else if (process.env.DB_DRIVER === 'mssql') {
      await sql`if col_length('orders', 'is_test') is not null alter table orders drop column is_test`.execute(db);
    } else {
      await sql`alter table orders drop column if exists is_test`.execute(db);
    }
    if (process.env.DB_DRIVER === 'mssql') {
      await sql`if col_length('checkout_sessions', 'is_test') is not null alter table checkout_sessions drop column is_test`.execute(db);
    } else if (process.env.DB_DRIVER === 'mysql') {
      try {
        await sql`alter table checkout_sessions drop column is_test`.execute(db);
      } catch (error) {
        if ((error as { code?: string }).code !== 'ER_CANT_DROP_FIELD_OR_KEY') throw error;
      }
    } else {
      await sql`alter table checkout_sessions drop column if exists is_test`.execute(db);
    }
    for (const column of ['seo_use_cover_image', 'cover_image_alt', 'last_setup_section', 'version']) {
      try {
        await db.schema.alterTable('events').dropColumn(column).execute();
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code !== 'ER_CANT_DROP_FIELD_OR_KEY' && code !== '42703') throw error;
      }
    }
  },
};
