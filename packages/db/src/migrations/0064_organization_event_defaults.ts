import { sql, type Kysely } from 'kysely';

function emptyObjectDefault(): string | ReturnType<typeof sql> {
  return process.env.DB_DRIVER === 'mysql' ? sql`('{}')` : '{}';
}

export const OrganizationEventDefaultsMigration = {
  async up(db: Kysely<unknown>): Promise<void> {
    await db.schema
      .alterTable('organizations')
      .addColumn('event_defaults', 'text', (column) =>
        column.notNull().defaultTo(emptyObjectDefault()),
      )
      .execute();
  },
  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema.alterTable('organizations').dropColumn('event_defaults').execute();
  },
};
