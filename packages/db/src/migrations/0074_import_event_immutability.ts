import { sql } from 'kysely';
import type { Migration } from 'kysely/migration';

export const ImportEventImmutabilityMigration: Migration = {
  async up(db): Promise<void> {
    if (process.env.DB_DRIVER === 'mysql') {
      await sql
        .raw(`create trigger import_job_events_no_update before update on import_job_events
          for each row signal sqlstate '45000' set message_text = 'import job events are immutable'`)
        .execute(db);
      await sql
        .raw(`create trigger import_job_events_no_delete before delete on import_job_events
          for each row signal sqlstate '45000' set message_text = 'import job events are immutable'`)
        .execute(db);
    } else if (process.env.DB_DRIVER === 'mssql') {
      await sql
        .raw(`create trigger import_job_events_immutable on import_job_events
          instead of update, delete as throw 51000, 'import job events are immutable', 1`)
        .execute(db);
    } else {
      await sql`create function reject_import_job_event_mutation() returns trigger language plpgsql as $$
        begin raise exception 'import job events are immutable'; end $$`.execute(db);
      await sql
        .raw(`create trigger import_job_events_immutable before update or delete on import_job_events
          for each row execute function reject_import_job_event_mutation()`)
        .execute(db);
    }
  },
  async down(db): Promise<void> {
    if (process.env.DB_DRIVER === 'mysql') {
      await sql`drop trigger import_job_events_no_update`.execute(db);
      await sql`drop trigger import_job_events_no_delete`.execute(db);
    } else if (process.env.DB_DRIVER === 'mssql') {
      await sql`drop trigger import_job_events_immutable`.execute(db);
    } else {
      await sql`drop trigger import_job_events_immutable on import_job_events`.execute(db);
      await sql`drop function reject_import_job_event_mutation()`.execute(db);
    }
  },
};
