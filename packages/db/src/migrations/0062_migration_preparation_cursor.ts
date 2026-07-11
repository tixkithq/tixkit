import type { Migration } from 'kysely/migration';

export const MigrationPreparationCursorMigration: Migration = {
  async up(db) {
    await db.schema
      .alterTable('import_jobs')
      .addColumn('preparation_cursor', 'text')
      .addColumn('preparation_row_number', 'integer', (column) => column.notNull().defaultTo(0))
      .execute();
  },
  async down(db) {
    await db.schema
      .alterTable('import_jobs')
      .dropColumn('preparation_row_number')
      .dropColumn('preparation_cursor')
      .execute();
  },
};
