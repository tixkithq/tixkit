import { sql } from 'kysely';
import type { ColumnDataType } from 'kysely';
import type { Migration } from 'kysely/migration';

function varchar(len: number): ColumnDataType {
  return `varchar(${len})`;
}

function timestampType(): ColumnDataType {
  return process.env.DB_DRIVER === 'mysql' ? 'datetime' : 'timestamptz';
}

function nowDefault() {
  return process.env.DB_DRIVER === 'mysql' ? sql`CURRENT_TIMESTAMP` : sql`now()`;
}

export const EventOccurrencesMigration: Migration = {
  async up(db): Promise<void> {
    await db.schema
      .createTable('event_occurrences')
      .addColumn('id', varchar(32), (col) => col.primaryKey())
      .addColumn('event_id', varchar(32), (col) => col.notNull())
      .addColumn('title', varchar(255), (col) => col.notNull())
      .addColumn('starts_at', timestampType(), (col) => col.notNull())
      .addColumn('ends_at', timestampType(), (col) => col.notNull())
      .addColumn('timezone', varchar(64), (col) => col.notNull())
      .addColumn('venue', 'json')
      .addColumn('capacity', 'integer')
      .addColumn('sort_order', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('status', varchar(32), (col) => col.notNull().defaultTo('scheduled'))
      .addColumn('created_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addColumn('updated_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addForeignKeyConstraint('event_occurrences_event_fk', ['event_id'], 'events', ['id'])
      .execute();

    await db.schema
      .createIndex('idx_event_occurrences_event')
      .on('event_occurrences')
      .columns(['event_id', 'starts_at'])
      .execute();

    await db.schema
      .alterTable('ticket_types')
      .addColumn('event_occurrence_id', varchar(32))
      .execute();
    await db.schema
      .alterTable('ticket_types')
      .addForeignKeyConstraint(
        'ticket_types_event_occurrence_fk',
        ['event_occurrence_id'],
        'event_occurrences',
        ['id'],
      )
      .execute();
    await db.schema
      .createIndex('idx_ticket_types_occurrence')
      .on('ticket_types')
      .column('event_occurrence_id')
      .execute();

    await db.schema
      .alterTable('order_line_items')
      .addColumn('event_occurrence_id', varchar(32))
      .execute();
    await db.schema
      .alterTable('order_line_items')
      .addForeignKeyConstraint(
        'order_line_items_event_occurrence_fk',
        ['event_occurrence_id'],
        'event_occurrences',
        ['id'],
      )
      .execute();
    await db.schema
      .createIndex('idx_order_line_items_occurrence')
      .on('order_line_items')
      .column('event_occurrence_id')
      .execute();

    await db.schema.alterTable('attendees').addColumn('event_occurrence_id', varchar(32)).execute();
    await db.schema
      .alterTable('attendees')
      .addForeignKeyConstraint(
        'attendees_event_occurrence_fk',
        ['event_occurrence_id'],
        'event_occurrences',
        ['id'],
      )
      .execute();
    await db.schema
      .createIndex('idx_attendees_occurrence')
      .on('attendees')
      .column('event_occurrence_id')
      .execute();

    await db.schema.alterTable('tickets').addColumn('event_occurrence_id', varchar(32)).execute();
    await db.schema
      .alterTable('tickets')
      .addForeignKeyConstraint(
        'tickets_event_occurrence_fk',
        ['event_occurrence_id'],
        'event_occurrences',
        ['id'],
      )
      .execute();
    await db.schema
      .createIndex('idx_tickets_occurrence')
      .on('tickets')
      .column('event_occurrence_id')
      .execute();

    await db.schema
      .alterTable('check_in_lists')
      .addColumn('event_occurrence_id', varchar(32))
      .execute();
    await db.schema
      .alterTable('check_in_lists')
      .addForeignKeyConstraint(
        'check_in_lists_event_occurrence_fk',
        ['event_occurrence_id'],
        'event_occurrences',
        ['id'],
      )
      .execute();
    await db.schema
      .createIndex('idx_check_in_lists_occurrence')
      .on('check_in_lists')
      .column('event_occurrence_id')
      .execute();
  },

  async down(db): Promise<void> {
    await db.schema.dropIndex('idx_check_in_lists_occurrence').ifExists().execute();
    await db.schema
      .alterTable('check_in_lists')
      .dropConstraint('check_in_lists_event_occurrence_fk')
      .execute();
    await db.schema.alterTable('check_in_lists').dropColumn('event_occurrence_id').execute();
    await db.schema.dropIndex('idx_tickets_occurrence').ifExists().execute();
    await db.schema.alterTable('tickets').dropConstraint('tickets_event_occurrence_fk').execute();
    await db.schema.alterTable('tickets').dropColumn('event_occurrence_id').execute();
    await db.schema.dropIndex('idx_attendees_occurrence').ifExists().execute();
    await db.schema
      .alterTable('attendees')
      .dropConstraint('attendees_event_occurrence_fk')
      .execute();
    await db.schema.alterTable('attendees').dropColumn('event_occurrence_id').execute();
    await db.schema.dropIndex('idx_order_line_items_occurrence').ifExists().execute();
    await db.schema
      .alterTable('order_line_items')
      .dropConstraint('order_line_items_event_occurrence_fk')
      .execute();
    await db.schema.alterTable('order_line_items').dropColumn('event_occurrence_id').execute();
    await db.schema.dropIndex('idx_ticket_types_occurrence').ifExists().execute();
    await db.schema
      .alterTable('ticket_types')
      .dropConstraint('ticket_types_event_occurrence_fk')
      .execute();
    await db.schema.alterTable('ticket_types').dropColumn('event_occurrence_id').execute();
    await db.schema.dropTable('event_occurrences').ifExists().execute();
  },
};
