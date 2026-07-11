import type { Migration } from 'kysely/migration';

const timestampType = () =>
  process.env.DB_DRIVER === 'mssql'
    ? ('datetime2' as const)
    : process.env.DB_DRIVER === 'mysql'
      ? ('datetime' as const)
      : ('timestamptz' as const);

export const SandboxEnvironmentsMigration: Migration = {
  async up(db) {
    await db.schema
      .createTable('sandbox_environments')
      .addColumn('id', 'varchar(32)', (column) => column.primaryKey())
      .addColumn('epoch', 'varchar(64)', (column) => column.notNull().unique())
      .addColumn('task_queue', 'varchar(255)', (column) => column.notNull().unique())
      .addColumn('fixture_version', 'integer', (column) => column.notNull())
      .addColumn('reset_at', timestampType(), (column) => column.notNull())
      .execute();
  },
  async down(db) {
    await db.schema.dropTable('sandbox_environments').ifExists().execute();
  },
};
