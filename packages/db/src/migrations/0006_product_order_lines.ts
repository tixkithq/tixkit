import { sql } from 'kysely';
import type { ColumnDataType, Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';

function varchar(len: number): ColumnDataType {
  return `varchar(${len})`;
}

function isMysql() {
  return process.env.DB_DRIVER === 'mysql';
}

async function columnExists(
  db: Kysely<Record<string, unknown>>,
  tableName: string,
  columnName: string,
): Promise<boolean> {
  const result = isMysql()
    ? await sql<{ column_name: string }>`
        select column_name
        from information_schema.columns
        where table_schema = database()
          and table_name = ${tableName}
          and column_name = ${columnName}
        limit 1
      `.execute(db)
    : await sql<{ column_name: string }>`
        select column_name
        from information_schema.columns
        where table_schema = current_schema()
          and table_name = ${tableName}
          and column_name = ${columnName}
        limit 1
      `.execute(db);

  return result.rows.length > 0;
}

export const ProductOrderLinesMigration: Migration = {
  async up(db): Promise<void> {
    if (isMysql()) {
      await sql`alter table checkout_sessions modify hold_id varchar(32) null`.execute(db);
      await sql`alter table order_line_items modify ticket_type_id varchar(32) null`.execute(db);
    } else {
      await sql`alter table checkout_sessions alter column hold_id drop not null`.execute(db);
      await sql`alter table order_line_items alter column ticket_type_id drop not null`.execute(db);
    }

    if (!(await columnExists(db, 'order_line_items', 'product_id'))) {
      await db.schema.alterTable('order_line_items').addColumn('product_id', varchar(32)).execute();
      await db.schema
        .alterTable('order_line_items')
        .addForeignKeyConstraint('order_line_items_product_fk', ['product_id'], 'products', ['id'])
        .execute();
    }

    await db.schema
      .alterTable('order_line_items')
      .addCheckConstraint(
        'order_line_items_ticket_or_product_check',
        sql`(ticket_type_id is not null and product_id is null) or (ticket_type_id is null and product_id is not null)`,
      )
      .execute();
  },
  async down(db): Promise<void> {
    await db.schema
      .alterTable('order_line_items')
      .dropConstraint('order_line_items_ticket_or_product_check')
      .execute();

    if (await columnExists(db, 'order_line_items', 'product_id')) {
      await db.schema
        .alterTable('order_line_items')
        .dropConstraint('order_line_items_product_fk')
        .execute();
      await db.schema.alterTable('order_line_items').dropColumn('product_id').execute();
    }

    if (isMysql()) {
      await sql`alter table order_line_items modify ticket_type_id varchar(32) not null`.execute(
        db,
      );
      await sql`alter table checkout_sessions modify hold_id varchar(32) not null`.execute(db);
    } else {
      await sql`alter table order_line_items alter column ticket_type_id set not null`.execute(db);
      await sql`alter table checkout_sessions alter column hold_id set not null`.execute(db);
    }
  },
};
