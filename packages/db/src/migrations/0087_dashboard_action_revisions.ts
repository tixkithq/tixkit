import { sql } from 'kysely';
import type { Migration } from 'kysely/migration';

const mysqlTriggers = [
  'dashboard_revision_events_insert',
  'dashboard_revision_events_update',
  'dashboard_revision_events_delete',
  'dashboard_revision_checkins_insert',
  'dashboard_revision_checkins_update',
  'dashboard_revision_checkins_delete',
  'dashboard_revision_exports_insert',
  'dashboard_revision_exports_update',
  'dashboard_revision_exports_delete',
] as const;

export const DashboardActionRevisionsMigration: Migration = {
  async up(db): Promise<void> {
    await db.schema
      .createTable('dashboard_action_revisions')
      .addColumn('tenant_id', 'varchar(32)', (column) => column.notNull())
      .addColumn('organization_id', 'varchar(32)', (column) => column.notNull())
      .addColumn('brand_id', 'varchar(32)', (column) => column.notNull())
      .addColumn('revision', 'bigint', (column) => column.notNull().defaultTo(1))
      .addPrimaryKeyConstraint('dashboard_action_revisions_pk', [
        'tenant_id',
        'organization_id',
        'brand_id',
      ])
      .addForeignKeyConstraint(
        'dashboard_action_revisions_brand_fk',
        ['brand_id'],
        'brands',
        ['id'],
        (constraint) => constraint.onDelete('cascade'),
      )
      .execute();
    await sql`insert into dashboard_action_revisions (tenant_id, organization_id, brand_id, revision)
      select tenant_id, organization_id, id, 1 from brands`.execute(db);

    if (process.env.DB_DRIVER === 'mysql') {
      await createMysqlTriggers(db);
    } else if (process.env.DB_DRIVER === 'mssql') {
      await createMssqlTriggers(db);
    } else {
      await createPostgresTriggers(db);
    }
  },

  async down(db): Promise<void> {
    if (process.env.DB_DRIVER === 'mysql') {
      for (const trigger of mysqlTriggers) await sql.raw(`drop trigger ${trigger}`).execute(db);
    } else if (process.env.DB_DRIVER === 'mssql') {
      for (const trigger of [
        'dashboard_revision_events',
        'dashboard_revision_checkins',
        'dashboard_revision_exports',
      ])
        await sql.raw(`drop trigger ${trigger}`).execute(db);
    } else {
      for (const [trigger, table] of [
        ['dashboard_revision_events', 'events'],
        ['dashboard_revision_checkins', 'check_in_lists'],
        ['dashboard_revision_exports', 'export_jobs'],
      ])
        await sql.raw(`drop trigger ${trigger} on ${table}`).execute(db);
      for (const fn of [
        'bump_dashboard_revision_for_event',
        'bump_dashboard_revision_for_checkin',
        'bump_dashboard_revision_for_export',
      ])
        await sql.raw(`drop function ${fn}()`).execute(db);
      await sql
        .raw('drop function bump_dashboard_action_revision(varchar, varchar, varchar)')
        .execute(db);
    }
    await db.schema.dropTable('dashboard_action_revisions').execute();
  },
};

async function createPostgresTriggers(db: Parameters<Migration['up']>[0]): Promise<void> {
  await sql
    .raw(`create or replace function bump_dashboard_action_revision(p_tenant varchar, p_organization varchar, p_brand varchar)
    returns void language plpgsql as $$
    begin
      insert into dashboard_action_revisions (tenant_id, organization_id, brand_id, revision)
      values (p_tenant, p_organization, p_brand, 1)
      on conflict (tenant_id, organization_id, brand_id)
      do update set revision = dashboard_action_revisions.revision + 1;
    end $$`)
    .execute(db);
  await sql
    .raw(`create or replace function bump_dashboard_revision_for_event() returns trigger language plpgsql as $$
    begin
      if TG_OP <> 'DELETE' then perform bump_dashboard_action_revision(NEW.tenant_id, NEW.organization_id, NEW.brand_id); end if;
      if TG_OP = 'DELETE' or (TG_OP = 'UPDATE' and (OLD.tenant_id, OLD.organization_id, OLD.brand_id) is distinct from (NEW.tenant_id, NEW.organization_id, NEW.brand_id)) then
        perform bump_dashboard_action_revision(OLD.tenant_id, OLD.organization_id, OLD.brand_id);
      end if;
      return coalesce(NEW, OLD);
    end $$`)
    .execute(db);
  await sql
    .raw(`create trigger dashboard_revision_events after insert or update or delete on events
    for each row execute function bump_dashboard_revision_for_event()`)
    .execute(db);
  await sql
    .raw(`create or replace function bump_dashboard_revision_for_checkin() returns trigger language plpgsql as $$
    declare event_scope record;
    begin
      if TG_OP <> 'DELETE' then
        select tenant_id, organization_id, brand_id into event_scope from events where id = NEW.event_id;
        if found then perform bump_dashboard_action_revision(event_scope.tenant_id, event_scope.organization_id, event_scope.brand_id); end if;
      end if;
      if TG_OP = 'DELETE' or (TG_OP = 'UPDATE' and OLD.event_id is distinct from NEW.event_id) then
        select tenant_id, organization_id, brand_id into event_scope from events where id = OLD.event_id;
        if found then perform bump_dashboard_action_revision(event_scope.tenant_id, event_scope.organization_id, event_scope.brand_id); end if;
      end if;
      return coalesce(NEW, OLD);
    end $$`)
    .execute(db);
  await sql
    .raw(`create trigger dashboard_revision_checkins after insert or update or delete on check_in_lists
    for each row execute function bump_dashboard_revision_for_checkin()`)
    .execute(db);
  await sql
    .raw(`create or replace function bump_dashboard_revision_for_export() returns trigger language plpgsql as $$
    declare event_scope record;
    begin
      if TG_OP <> 'DELETE' and NEW.status = 'failed' then
        select tenant_id, organization_id, brand_id into event_scope from events where id = NEW.event_id;
        if found then perform bump_dashboard_action_revision(event_scope.tenant_id, event_scope.organization_id, event_scope.brand_id); end if;
      end if;
      if (TG_OP = 'DELETE' and OLD.status = 'failed') or (TG_OP = 'UPDATE' and OLD.status = 'failed' and (NEW.status <> 'failed' or OLD.event_id is distinct from NEW.event_id)) then
        select tenant_id, organization_id, brand_id into event_scope from events where id = OLD.event_id;
        if found then perform bump_dashboard_action_revision(event_scope.tenant_id, event_scope.organization_id, event_scope.brand_id); end if;
      end if;
      return coalesce(NEW, OLD);
    end $$`)
    .execute(db);
  await sql
    .raw(`create trigger dashboard_revision_exports after insert or update or delete on export_jobs
    for each row execute function bump_dashboard_revision_for_export()`)
    .execute(db);
}

async function createMysqlTriggers(db: Parameters<Migration['up']>[0]): Promise<void> {
  const bumpNewEvent = `insert into dashboard_action_revisions (tenant_id, organization_id, brand_id, revision)
    values (NEW.tenant_id, NEW.organization_id, NEW.brand_id, 1)
    on duplicate key update revision = revision + 1`;
  const bumpOldEvent = bumpNewEvent.replaceAll('NEW.', 'OLD.');
  await sql
    .raw(
      `create trigger dashboard_revision_events_insert after insert on events for each row ${bumpNewEvent}`,
    )
    .execute(db);
  await sql
    .raw(`create trigger dashboard_revision_events_update after update on events for each row begin
    ${bumpNewEvent};
    if OLD.tenant_id <> NEW.tenant_id or OLD.organization_id <> NEW.organization_id or OLD.brand_id <> NEW.brand_id then ${bumpOldEvent}; end if;
  end`)
    .execute(db);
  await sql
    .raw(
      `create trigger dashboard_revision_events_delete after delete on events for each row ${bumpOldEvent}`,
    )
    .execute(db);
  for (const [operation, row] of [
    ['insert', 'NEW'],
    ['delete', 'OLD'],
  ] as const)
    await sql
      .raw(`create trigger dashboard_revision_checkins_${operation} after ${operation} on check_in_lists for each row
      insert into dashboard_action_revisions (tenant_id, organization_id, brand_id, revision)
      select tenant_id, organization_id, brand_id, 1 from events where id = ${row}.event_id
      on duplicate key update revision = revision + 1`)
      .execute(db);
  await sql
    .raw(`create trigger dashboard_revision_checkins_update after update on check_in_lists for each row begin
    insert into dashboard_action_revisions (tenant_id, organization_id, brand_id, revision)
      select tenant_id, organization_id, brand_id, 1 from events where id = NEW.event_id
      on duplicate key update revision = revision + 1;
    if OLD.event_id <> NEW.event_id then
      insert into dashboard_action_revisions (tenant_id, organization_id, brand_id, revision)
        select tenant_id, organization_id, brand_id, 1 from events where id = OLD.event_id
        on duplicate key update revision = revision + 1;
    end if;
  end`)
    .execute(db);
  for (const [operation, row] of [
    ['insert', 'NEW'],
    ['delete', 'OLD'],
  ] as const)
    await sql
      .raw(`create trigger dashboard_revision_exports_${operation} after ${operation} on export_jobs for each row begin
      if ${row}.status = 'failed' then
        insert into dashboard_action_revisions (tenant_id, organization_id, brand_id, revision)
          select tenant_id, organization_id, brand_id, 1 from events where id = ${row}.event_id
          on duplicate key update revision = revision + 1;
      end if;
    end`)
      .execute(db);
  await sql
    .raw(`create trigger dashboard_revision_exports_update after update on export_jobs for each row begin
    if NEW.status = 'failed' then
      insert into dashboard_action_revisions (tenant_id, organization_id, brand_id, revision)
        select tenant_id, organization_id, brand_id, 1 from events where id = NEW.event_id
        on duplicate key update revision = revision + 1;
    end if;
    if OLD.status = 'failed' and (NEW.status <> 'failed' or not (OLD.event_id <=> NEW.event_id)) then
      insert into dashboard_action_revisions (tenant_id, organization_id, brand_id, revision)
        select tenant_id, organization_id, brand_id, 1 from events where id = OLD.event_id
        on duplicate key update revision = revision + 1;
    end if;
  end`)
    .execute(db);
}

async function createMssqlTriggers(db: Parameters<Migration['up']>[0]): Promise<void> {
  await sql
    .raw(`create trigger dashboard_revision_events on events after insert, update, delete as
    merge dashboard_action_revisions with (holdlock) as target
    using (select tenant_id, organization_id, brand_id from inserted union select tenant_id, organization_id, brand_id from deleted) as source
    on target.tenant_id = source.tenant_id and target.organization_id = source.organization_id and target.brand_id = source.brand_id
    when matched then update set revision = target.revision + 1
    when not matched then insert (tenant_id, organization_id, brand_id, revision) values (source.tenant_id, source.organization_id, source.brand_id, 1);`)
    .execute(db);
  await sql
    .raw(`create trigger dashboard_revision_checkins on check_in_lists after insert, update, delete as
    merge dashboard_action_revisions with (holdlock) as target
    using (select distinct e.tenant_id, e.organization_id, e.brand_id from events e join (select event_id from inserted union select event_id from deleted) c on c.event_id = e.id) as source
    on target.tenant_id = source.tenant_id and target.organization_id = source.organization_id and target.brand_id = source.brand_id
    when matched then update set revision = target.revision + 1
    when not matched then insert (tenant_id, organization_id, brand_id, revision) values (source.tenant_id, source.organization_id, source.brand_id, 1);`)
    .execute(db);
  await sql
    .raw(`create trigger dashboard_revision_exports on export_jobs after insert, update, delete as
    merge dashboard_action_revisions with (holdlock) as target
    using (select distinct e.tenant_id, e.organization_id, e.brand_id from events e join (select event_id from inserted where status = 'failed' union select event_id from deleted where status = 'failed') x on x.event_id = e.id) as source
    on target.tenant_id = source.tenant_id and target.organization_id = source.organization_id and target.brand_id = source.brand_id
    when matched then update set revision = target.revision + 1
    when not matched then insert (tenant_id, organization_id, brand_id, revision) values (source.tenant_id, source.organization_id, source.brand_id, 1);`)
    .execute(db);
}
