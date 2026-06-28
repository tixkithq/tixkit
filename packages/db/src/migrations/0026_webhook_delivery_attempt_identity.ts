import { sql, type Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';

function isMysql(): boolean {
  return process.env.DB_DRIVER === 'mysql';
}

function isMssql(): boolean {
  return process.env.DB_DRIVER === 'mssql';
}

async function dedupeWebhookDeliveries(db: Kysely<unknown>): Promise<void> {
  if (isMysql()) {
    await sql`
      delete webhook_deliveries
      from webhook_deliveries
      inner join (
        select id
        from (
          select
            id,
            row_number() over (
              partition by event_id, requested_endpoint_id, attempt
              order by
                case status
                  when 'delivered' then 4
                  when 'dead_lettered' then 3
                  when 'failed' then 2
                  else 1
                end desc,
                created_at desc,
                id desc
            ) as duplicate_rank
          from webhook_deliveries
        ) ranked_webhook_deliveries
        where duplicate_rank > 1
      ) duplicate_webhook_deliveries
        on duplicate_webhook_deliveries.id = webhook_deliveries.id
    `.execute(db);
    return;
  }

  if (isMssql()) {
    await sql`
      with ranked_webhook_deliveries as (
        select
          id,
          row_number() over (
            partition by event_id, requested_endpoint_id, attempt
            order by
              case status
                when 'delivered' then 4
                when 'dead_lettered' then 3
                when 'failed' then 2
                else 1
              end desc,
              created_at desc,
              id desc
          ) as duplicate_rank
        from webhook_deliveries
      )
      delete from ranked_webhook_deliveries
      where duplicate_rank > 1
    `.execute(db);
    return;
  }

  await sql`
    delete from webhook_deliveries
    where id in (
      select id
      from (
        select
          id,
          row_number() over (
            partition by event_id, requested_endpoint_id, attempt
            order by
              case status
                when 'delivered' then 4
                when 'dead_lettered' then 3
                when 'failed' then 2
                else 1
              end desc,
              created_at desc,
              id desc
          ) as duplicate_rank
        from webhook_deliveries
      ) ranked_webhook_deliveries
      where duplicate_rank > 1
    )
  `.execute(db);
}

export const WebhookDeliveryAttemptIdentityMigration: Migration = {
  async up(db): Promise<void> {
    await dedupeWebhookDeliveries(db);

    await db.schema
      .createIndex('uniq_webhook_deliveries_attempt_identity')
      .on('webhook_deliveries')
      .columns(['event_id', 'requested_endpoint_id', 'attempt'])
      .unique()
      .execute();
  },

  async down(db): Promise<void> {
    await db.schema
      .dropIndex('uniq_webhook_deliveries_attempt_identity')
      .on('webhook_deliveries')
      .ifExists()
      .execute();
  },
};
