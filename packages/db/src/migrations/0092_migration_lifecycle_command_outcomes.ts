import { sql, type ColumnDataType } from 'kysely';
import type { Migration } from 'kysely/migration';

function timestampType(): ColumnDataType {
  if (process.env.DB_DRIVER === 'mssql') return 'datetime2';
  return process.env.DB_DRIVER === 'mysql' ? 'datetime' : 'timestamptz';
}

export const MigrationLifecycleCommandOutcomesMigration: Migration = {
  async up(db): Promise<void> {
    await db.schema
      .alterTable('migration_lifecycle_commands')
      .addColumn('completed_at', timestampType())
      .execute();
    await db.schema
      .alterTable('migration_lifecycle_commands')
      .addCheckConstraint(
        'migration_lifecycle_commands_completed_consistent',
        sql`completed_at is null or status = 'dispatched'`,
      )
      .execute();
  },

  async down(db): Promise<void> {
    const completed = await db
      .selectFrom('migration_lifecycle_commands')
      .select('id')
      .where('completed_at', 'is not', null)
      .limit(1)
      .executeTakeFirst();
    if (completed) {
      throw new Error(
        'Cannot roll back migration lifecycle command outcomes while durable evidence exists',
      );
    }
    await db.schema
      .alterTable('migration_lifecycle_commands')
      .dropConstraint('migration_lifecycle_commands_completed_consistent')
      .execute();
    await db.schema.alterTable('migration_lifecycle_commands').dropColumn('completed_at').execute();
  },
};
