import { sql, type ColumnDataType } from 'kysely';
import type { Migration } from 'kysely/migration';

function timestampType(): ColumnDataType {
  if (process.env.DB_DRIVER === 'mssql') return 'datetime2';
  return process.env.DB_DRIVER === 'mysql' ? 'datetime' : 'timestamptz';
}

function authorizationLifetimeCheck() {
  if (process.env.DB_DRIVER === 'mysql')
    return sql<boolean>`expires_at > granted_at and expires_at <= date_add(granted_at, interval 24 hour)`;
  if (process.env.DB_DRIVER === 'mssql')
    return sql<boolean>`expires_at > granted_at and expires_at <= dateadd(hour, 24, granted_at)`;
  return sql<boolean>`expires_at > granted_at and expires_at <= granted_at + interval '24 hours'`;
}

export const PortableExportAuthorizationsMigration: Migration = {
  async up(db): Promise<void> {
    await db.schema
      .createTable('portable_export_authorizations')
      .addColumn('id', 'varchar(64)', (column) => column.primaryKey())
      .addColumn('tenant_id', 'varchar(32)', (column) => column.notNull())
      .addColumn('organization_id', 'varchar(32)', (column) => column.notNull())
      .addColumn('scope', 'varchar(64)', (column) => column.notNull())
      .addColumn('granted_by_principal_id', 'varchar(128)', (column) => column.notNull())
      .addColumn('granted_at', timestampType(), (column) => column.notNull())
      .addColumn('expires_at', timestampType(), (column) => column.notNull())
      .addColumn('revoked_by_principal_id', 'varchar(128)')
      .addColumn('revoked_at', timestampType())
      .addColumn('consumed_at', timestampType())
      .addForeignKeyConstraint(
        'portable_export_authorizations_organization_scope_fk',
        ['tenant_id', 'organization_id'],
        'organizations',
        ['tenant_id', 'id'],
      )
      .addUniqueConstraint('portable_export_authorizations_scope_id_unique', [
        'tenant_id',
        'organization_id',
        'id',
      ])
      .addCheckConstraint(
        'portable_export_authorizations_scope_check',
        sql<boolean>`scope = 'tenant-historical-portability'`,
      )
      .addCheckConstraint(
        'portable_export_authorizations_lifetime_check',
        authorizationLifetimeCheck(),
      )
      .addCheckConstraint(
        'portable_export_authorizations_revocation_shape_check',
        sql<boolean>`(revoked_at is null and revoked_by_principal_id is null) or (revoked_at is not null and revoked_by_principal_id is not null)`,
      )
      .addCheckConstraint(
        'portable_export_authorizations_terminal_state_check',
        sql<boolean>`not (revoked_at is not null and consumed_at is not null)`,
      )
      .execute();
    if (process.env.DB_DRIVER === 'mysql') {
      await sql
        .raw(`create trigger portable_export_authorizations_no_delete before delete on portable_export_authorizations
          for each row signal sqlstate '45000' set message_text = 'portable export authorizations cannot be deleted'`)
        .execute(db);
      await sql
        .raw(`create trigger portable_export_authorizations_state_update before update on portable_export_authorizations
          for each row begin
            if not (
              new.id = old.id and new.tenant_id = old.tenant_id and new.organization_id = old.organization_id
              and new.scope = old.scope and new.granted_by_principal_id = old.granted_by_principal_id
              and new.granted_at = old.granted_at and new.expires_at = old.expires_at
              and old.revoked_at is null and old.revoked_by_principal_id is null and old.consumed_at is null
              and (
                (new.revoked_at is not null and new.revoked_by_principal_id is not null and new.consumed_at is null)
                or (new.revoked_at is null and new.revoked_by_principal_id is null and new.consumed_at is not null)
              )
            ) then
              signal sqlstate '45000' set message_text = 'portable export authorization transition is invalid';
            end if;
          end`)
        .execute(db);
    } else if (process.env.DB_DRIVER === 'mssql') {
      await sql
        .raw(`create trigger portable_export_authorizations_immutable on portable_export_authorizations
          after update, delete as
          begin
            if exists (
              select 1 from deleted old
              left join inserted new on new.id = old.id
              where new.id is null
                or new.tenant_id <> old.tenant_id or new.organization_id <> old.organization_id
                or new.scope <> old.scope or new.granted_by_principal_id <> old.granted_by_principal_id
                or new.granted_at <> old.granted_at or new.expires_at <> old.expires_at
                or old.revoked_at is not null or old.revoked_by_principal_id is not null or old.consumed_at is not null
                or not (
                  (new.revoked_at is not null and new.revoked_by_principal_id is not null and new.consumed_at is null)
                  or (new.revoked_at is null and new.revoked_by_principal_id is null and new.consumed_at is not null)
                )
            ) throw 51000, 'portable export authorization transition is invalid', 1;
          end`)
        .execute(db);
    } else {
      await sql`create function enforce_portable_export_authorization_transition() returns trigger language plpgsql as $$
        begin
          if TG_OP = 'DELETE' then
            raise exception 'portable export authorizations cannot be deleted';
          end if;
          if new.id is distinct from old.id
            or new.tenant_id is distinct from old.tenant_id
            or new.organization_id is distinct from old.organization_id
            or new.scope is distinct from old.scope
            or new.granted_by_principal_id is distinct from old.granted_by_principal_id
            or new.granted_at is distinct from old.granted_at
            or new.expires_at is distinct from old.expires_at
            or old.revoked_at is not null
            or old.revoked_by_principal_id is not null
            or old.consumed_at is not null
            or not (
              (new.revoked_at is not null and new.revoked_by_principal_id is not null and new.consumed_at is null)
              or (new.revoked_at is null and new.revoked_by_principal_id is null and new.consumed_at is not null)
            ) then
            raise exception 'portable export authorization transition is invalid';
          end if;
          return new;
        end $$`.execute(db);
      await sql
        .raw(`create trigger portable_export_authorizations_immutable before update or delete on portable_export_authorizations
          for each row execute function enforce_portable_export_authorization_transition()`)
        .execute(db);
    }
    await db.schema
      .alterTable('portable_export_jobs')
      .addColumn('historical_authorization_id', 'varchar(64)')
      .execute();
    await db.schema
      .alterTable('portable_export_jobs')
      .addForeignKeyConstraint(
        'portable_export_jobs_historical_authorization_fk',
        ['tenant_id', 'organization_id', 'historical_authorization_id'],
        'portable_export_authorizations',
        ['tenant_id', 'organization_id', 'id'],
      )
      .execute();
    await db.schema
      .alterTable('portable_export_jobs')
      .addUniqueConstraint('portable_export_jobs_authorization_binding_unique', [
        'tenant_id',
        'organization_id',
        'id',
        'historical_authorization_id',
      ])
      .execute();
    await db.schema
      .alterTable('portable_export_jobs')
      .addUniqueConstraint('portable_export_jobs_scope_authorization_unique', [
        'tenant_id',
        'organization_id',
        'id',
        'mode',
        'historical_authorization_id',
      ])
      .execute();
    await db.schema
      .alterTable('portable_export_jobs')
      .addCheckConstraint(
        'portable_export_jobs_mode_authorization_check',
        sql<boolean>`(mode = 'configuration' and historical_authorization_id is null) or (mode = 'historical' and historical_authorization_id is not null)`,
      )
      .execute();
    await db.schema
      .alterTable('portable_export_events')
      .addColumn('mode', 'varchar(32)', (column) => column.notNull().defaultTo('configuration'))
      .execute();
    await db.schema
      .alterTable('portable_export_events')
      .addColumn('historical_authorization_id', 'varchar(64)')
      .execute();
    await db.schema
      .alterTable('portable_export_events')
      .addCheckConstraint(
        'portable_export_events_mode_authorization_check',
        sql<boolean>`(mode = 'configuration' and historical_authorization_id is null) or (mode = 'historical' and historical_authorization_id is not null)`,
      )
      .execute();
    await db.schema
      .alterTable('portable_export_events')
      .addForeignKeyConstraint(
        'portable_export_events_job_authorization_fk',
        ['tenant_id', 'organization_id', 'export_job_id', 'mode', 'historical_authorization_id'],
        'portable_export_jobs',
        ['tenant_id', 'organization_id', 'id', 'mode', 'historical_authorization_id'],
      )
      .execute();
    await db.schema
      .createTable('portable_export_authorization_events')
      .addColumn('id', 'varchar(64)', (column) => column.primaryKey())
      .addColumn('tenant_id', 'varchar(32)', (column) => column.notNull())
      .addColumn('organization_id', 'varchar(32)', (column) => column.notNull())
      .addColumn('authorization_id', 'varchar(64)', (column) => column.notNull())
      .addColumn('event_type', 'varchar(32)', (column) => column.notNull())
      .addColumn('actor_principal_id', 'varchar(128)', (column) => column.notNull())
      .addColumn('export_job_id', 'varchar(64)')
      .addColumn('occurred_at', timestampType(), (column) => column.notNull())
      .addForeignKeyConstraint(
        'portable_export_authorization_events_authorization_fk',
        ['tenant_id', 'organization_id', 'authorization_id'],
        'portable_export_authorizations',
        ['tenant_id', 'organization_id', 'id'],
      )
      .addForeignKeyConstraint(
        'portable_export_authorization_events_job_fk',
        ['tenant_id', 'organization_id', 'export_job_id', 'authorization_id'],
        'portable_export_jobs',
        ['tenant_id', 'organization_id', 'id', 'historical_authorization_id'],
      )
      .addUniqueConstraint('portable_export_authorization_events_lifecycle_unique', [
        'authorization_id',
        'event_type',
      ])
      .addCheckConstraint(
        'portable_export_authorization_events_type_check',
        sql<boolean>`event_type in ('granted', 'revoked', 'consumed')`,
      )
      .addCheckConstraint(
        'portable_export_authorization_events_shape_check',
        sql<boolean>`(event_type = 'consumed' and export_job_id is not null) or (event_type in ('granted', 'revoked') and export_job_id is null)`,
      )
      .execute();
    await db.schema
      .createIndex('portable_export_authorizations_scope_state_idx')
      .on('portable_export_authorizations')
      .columns(['tenant_id', 'organization_id', 'expires_at', 'consumed_at', 'revoked_at'])
      .execute();

    if (process.env.DB_DRIVER === 'mysql') {
      await sql
        .raw(`create trigger portable_export_authorization_events_no_update before update on portable_export_authorization_events
          for each row signal sqlstate '45000' set message_text = 'portable export authorization events are immutable'`)
        .execute(db);
      await sql
        .raw(`create trigger portable_export_authorization_events_no_delete before delete on portable_export_authorization_events
          for each row signal sqlstate '45000' set message_text = 'portable export authorization events are immutable'`)
        .execute(db);
    } else if (process.env.DB_DRIVER === 'mssql') {
      await sql
        .raw(`create trigger portable_export_authorization_events_immutable on portable_export_authorization_events
          instead of update, delete as throw 51000, 'portable export authorization events are immutable', 1`)
        .execute(db);
    } else {
      await sql`create function reject_portable_export_authorization_event_mutation() returns trigger language plpgsql as $$
        begin raise exception 'portable export authorization events are immutable'; end $$`.execute(
        db,
      );
      await sql
        .raw(`create trigger portable_export_authorization_events_immutable before update or delete on portable_export_authorization_events
          for each row execute function reject_portable_export_authorization_event_mutation()`)
        .execute(db);
    }
  },
  async down(db): Promise<void> {
    const historicalJobs = await sql<{
      count: number | string;
    }>`select count(*) as count from portable_export_jobs where mode = 'historical'`.execute(db);
    if (Number(historicalJobs.rows[0]?.count ?? 0) > 0)
      throw new Error('PORTABLE_EXPORT_AUTHORIZATION_ROLLBACK_UNSAFE');
    await db.schema.dropTable('portable_export_authorization_events').execute();
    await db.schema
      .alterTable('portable_export_events')
      .dropConstraint('portable_export_events_job_authorization_fk')
      .execute();
    await db.schema
      .alterTable('portable_export_events')
      .dropConstraint('portable_export_events_mode_authorization_check')
      .execute();
    await db.schema
      .alterTable('portable_export_events')
      .dropColumn('historical_authorization_id')
      .execute();
    await db.schema.alterTable('portable_export_events').dropColumn('mode').execute();
    await db.schema
      .alterTable('portable_export_jobs')
      .dropConstraint('portable_export_jobs_mode_authorization_check')
      .execute();
    await db.schema
      .alterTable('portable_export_jobs')
      .dropConstraint('portable_export_jobs_scope_authorization_unique')
      .execute();
    await db.schema
      .alterTable('portable_export_jobs')
      .dropConstraint('portable_export_jobs_authorization_binding_unique')
      .execute();
    await db.schema
      .alterTable('portable_export_jobs')
      .dropConstraint('portable_export_jobs_historical_authorization_fk')
      .execute();
    await db.schema
      .alterTable('portable_export_jobs')
      .dropColumn('historical_authorization_id')
      .execute();
    await db.schema.dropTable('portable_export_authorizations').execute();
    if (process.env.DB_DRIVER !== 'mysql' && process.env.DB_DRIVER !== 'mssql') {
      await sql`drop function reject_portable_export_authorization_event_mutation()`.execute(db);
      await sql`drop function enforce_portable_export_authorization_transition()`.execute(db);
    }
  },
};
