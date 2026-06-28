import { sql, type Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';

function isMysql(): boolean {
  return process.env.DB_DRIVER === 'mysql';
}

function isMssql(): boolean {
  return process.env.DB_DRIVER === 'mssql';
}

async function dedupeMarketingIntegrations(db: Kysely<unknown>): Promise<void> {
  if (isMysql()) {
    await sql`
      delete marketing_integrations
      from marketing_integrations
      inner join (
        select id
        from (
          select
            id,
            row_number() over (
              partition by event_id, provider
              order by updated_at desc, id desc
            ) as duplicate_rank
          from marketing_integrations
          where event_id is not null
        ) ranked_marketing_integrations
        where duplicate_rank > 1
      ) duplicate_marketing_integrations
        on duplicate_marketing_integrations.id = marketing_integrations.id
    `.execute(db);
    return;
  }

  if (isMssql()) {
    await sql`
      with ranked_marketing_integrations as (
        select
          id,
          row_number() over (
            partition by event_id, provider
            order by updated_at desc, id desc
          ) as duplicate_rank
        from marketing_integrations
        where event_id is not null
      )
      delete from ranked_marketing_integrations
      where duplicate_rank > 1
    `.execute(db);
    return;
  }

  await sql`
    delete from marketing_integrations
    where id in (
      select id
      from (
        select
          id,
          row_number() over (
            partition by event_id, provider
            order by updated_at desc, id desc
          ) as duplicate_rank
          from marketing_integrations
          where event_id is not null
        ) ranked_marketing_integrations
      where duplicate_rank > 1
    )
  `.execute(db);
}

async function createMarketingIntegrationsUniqueIndex(db: Kysely<unknown>): Promise<void> {
  if (isMysql()) {
    await db.schema
      .createIndex('uniq_marketing_integrations_event_provider')
      .on('marketing_integrations')
      .columns(['event_id', 'provider'])
      .unique()
      .execute();
    return;
  }

  await sql`
    create unique index uniq_marketing_integrations_event_provider
    on marketing_integrations (event_id, provider)
    where event_id is not null
  `.execute(db);
}

export const MarketingIntegrationsUniqueMigration: Migration = {
  async up(db): Promise<void> {
    await dedupeMarketingIntegrations(db);
    await createMarketingIntegrationsUniqueIndex(db);
  },

  async down(db): Promise<void> {
    await db.schema
      .dropIndex('uniq_marketing_integrations_event_provider')
      .on('marketing_integrations')
      .ifExists()
      .execute();
  },
};
