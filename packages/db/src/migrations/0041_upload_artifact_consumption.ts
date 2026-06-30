import type { ColumnDataType } from 'kysely';
import type { Migration } from 'kysely/migration';

function varchar(len: number): ColumnDataType {
  return `varchar(${len})`;
}

function timestampType(): ColumnDataType {
  return process.env.DB_DRIVER === 'mysql' ? 'datetime' : 'timestamptz';
}

export const UploadArtifactConsumptionMigration: Migration = {
  async up(db): Promise<void> {
    await db.schema
      .alterTable('upload_artifacts')
      .addColumn('consumed_by_checkout_session_id', varchar(32))
      .addColumn('consumed_at', timestampType())
      .execute();

    await db.schema
      .createIndex('idx_upload_artifacts_consumed_by_session')
      .on('upload_artifacts')
      .columns(['consumed_by_checkout_session_id'])
      .execute();
  },

  async down(db): Promise<void> {
    await db.schema
      .dropIndex('idx_upload_artifacts_consumed_by_session')
      .on('upload_artifacts')
      .execute();
    await db.schema
      .alterTable('upload_artifacts')
      .dropColumn('consumed_at')
      .dropColumn('consumed_by_checkout_session_id')
      .execute();
  },
};
