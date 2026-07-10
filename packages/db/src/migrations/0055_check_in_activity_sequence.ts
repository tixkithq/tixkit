import { sql } from 'kysely';
import type { Migration } from 'kysely/migration';

function driver(): 'postgres' | 'mysql' | 'mssql' {
  return process.env.DB_DRIVER === 'mysql'
    ? 'mysql'
    : process.env.DB_DRIVER === 'mssql'
      ? 'mssql'
      : 'postgres';
}

export const CheckInActivitySequenceMigration: Migration = {
  async up(db): Promise<void> {
    await db.schema
      .alterTable('check_in_lists')
      .addColumn('next_activity_sequence', 'bigint', (column) => column.notNull().defaultTo(0))
      .execute();
    await db.schema.alterTable('scan_logs').addColumn('activity_sequence', 'bigint').execute();

    if (driver() === 'mysql') {
      await sql`
        update scan_logs target
        join (
          select id, row_number() over (
            partition by check_in_list_id order by created_at asc, id asc
          ) as sequence_value
          from scan_logs
        ) ranked on ranked.id = target.id
        set target.activity_sequence = ranked.sequence_value
      `.execute(db);
      await sql`
        update check_in_lists lists
        set next_activity_sequence = coalesce((
          select max(logs.activity_sequence)
          from scan_logs logs
          where logs.check_in_list_id = lists.id
        ), 0)
      `.execute(db);
      await sql`alter table scan_logs modify activity_sequence bigint not null`.execute(db);
    } else if (driver() === 'mssql') {
      await sql`
        with ranked as (
          select id, row_number() over (
            partition by check_in_list_id order by created_at asc, id asc
          ) as sequence_value
          from scan_logs
        )
        update target
        set activity_sequence = ranked.sequence_value
        from scan_logs target
        inner join ranked on ranked.id = target.id
      `.execute(db);
      await sql`
        update lists
        set next_activity_sequence = coalesce((
          select max(logs.activity_sequence)
          from scan_logs logs
          where logs.check_in_list_id = lists.id
        ), 0)
        from check_in_lists lists
      `.execute(db);
      await sql`alter table scan_logs alter column activity_sequence bigint not null`.execute(db);
    } else {
      await sql`
        with ranked as (
          select id, row_number() over (
            partition by check_in_list_id order by created_at asc, id asc
          ) as sequence_value
          from scan_logs
        )
        update scan_logs target
        set activity_sequence = ranked.sequence_value
        from ranked
        where ranked.id = target.id
      `.execute(db);
      await sql`
        update check_in_lists lists
        set next_activity_sequence = coalesce((
          select max(logs.activity_sequence)
          from scan_logs logs
          where logs.check_in_list_id = lists.id
        ), 0)
      `.execute(db);
      await sql`alter table scan_logs alter column activity_sequence set not null`.execute(db);
    }

    await db.schema
      .createIndex('uniq_scan_logs_activity_sequence')
      .on('scan_logs')
      .columns(['check_in_list_id', 'activity_sequence'])
      .unique()
      .execute();
    await db.schema
      .createIndex('idx_scan_logs_activity_sequence_cursor')
      .on('scan_logs')
      .columns(['tenant_id', 'check_in_list_id', 'activity_sequence'])
      .execute();
  },
  async down(db): Promise<void> {
    await db.schema
      .dropIndex('idx_scan_logs_activity_sequence_cursor')
      .on('scan_logs')
      .ifExists()
      .execute();
    await db.schema
      .dropIndex('uniq_scan_logs_activity_sequence')
      .on('scan_logs')
      .ifExists()
      .execute();
    await db.schema.alterTable('scan_logs').dropColumn('activity_sequence').execute();
    await db.schema.alterTable('check_in_lists').dropColumn('next_activity_sequence').execute();
  },
};
