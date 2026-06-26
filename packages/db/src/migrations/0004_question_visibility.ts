import { sql } from 'kysely';
import type { ColumnDataType, Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';

function varchar(len: number): ColumnDataType {
  return `varchar(${len})`;
}

function isMysql() {
  return process.env.DB_DRIVER === 'mysql';
}

function timestampType(): ColumnDataType {
  return isMysql() ? 'timestamp' : 'timestamptz';
}

async function columnExists(db: Kysely<unknown>, columnName: string): Promise<boolean> {
  const result = isMysql()
    ? await sql<{ column_name: string }>`
        select column_name
        from information_schema.columns
        where table_schema = database()
          and table_name = 'questions'
          and column_name = ${columnName}
        limit 1
      `.execute(db)
    : await sql<{ column_name: string }>`
        select column_name
        from information_schema.columns
        where table_schema = current_schema()
          and table_name = 'questions'
          and column_name = ${columnName}
        limit 1
      `.execute(db);

  return result.rows.length > 0;
}

export const QuestionVisibilityMigration: Migration = {
  async up(db): Promise<void> {
    if (!(await columnExists(db, 'status'))) {
      await db.schema
        .alterTable('questions')
        .addColumn('status', varchar(50), (col) => col.notNull().defaultTo('active'))
        .execute();
    }

    if (!(await columnExists(db, 'is_hidden'))) {
      await db.schema
        .alterTable('questions')
        .addColumn('is_hidden', 'boolean', (col) => col.notNull().defaultTo(false))
        .execute();
    }

    if (!(await columnExists(db, 'hidden_at'))) {
      await db.schema.alterTable('questions').addColumn('hidden_at', timestampType()).execute();
    }

    if (!(await columnExists(db, 'deleted_at'))) {
      await db.schema.alterTable('questions').addColumn('deleted_at', timestampType()).execute();
    }
  },
  async down(db): Promise<void> {
    if (await columnExists(db, 'deleted_at')) {
      await db.schema.alterTable('questions').dropColumn('deleted_at').execute();
    }

    if (await columnExists(db, 'hidden_at')) {
      await db.schema.alterTable('questions').dropColumn('hidden_at').execute();
    }

    if (await columnExists(db, 'is_hidden')) {
      await db.schema.alterTable('questions').dropColumn('is_hidden').execute();
    }

    if (await columnExists(db, 'status')) {
      await db.schema.alterTable('questions').dropColumn('status').execute();
    }
  },
};
