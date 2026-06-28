import { sql } from 'kysely';
import type { Migration } from 'kysely/migration';

function isMysql(): boolean {
  return process.env.DB_DRIVER === 'mysql';
}

function isMssql(): boolean {
  return process.env.DB_DRIVER === 'mssql';
}

export const NullableWebhookDeliveryEndpointMigration: Migration = {
  async up(db): Promise<void> {
    if (isMysql()) {
      await sql`alter table webhook_deliveries add column requested_endpoint_id varchar(32) null`.execute(db);
      await sql`update webhook_deliveries set requested_endpoint_id = endpoint_id`.execute(db);
      await sql`alter table webhook_deliveries modify requested_endpoint_id varchar(32) not null`.execute(db);
      await sql`alter table webhook_deliveries drop foreign key webhook_deliveries_endpoint_fk`.execute(db);
      await sql`alter table webhook_deliveries modify endpoint_id varchar(32) null`.execute(db);
      await sql`
        alter table webhook_deliveries
        add constraint webhook_deliveries_endpoint_fk
        foreign key (endpoint_id)
        references webhook_endpoints (id)
      `.execute(db);
      return;
    }

    if (isMssql()) {
      await sql`alter table webhook_deliveries add requested_endpoint_id varchar(32) null`.execute(db);
      await sql`update webhook_deliveries set requested_endpoint_id = endpoint_id`.execute(db);
      await sql`alter table webhook_deliveries alter column requested_endpoint_id varchar(32) not null`.execute(db);
      await sql`alter table webhook_deliveries drop constraint webhook_deliveries_endpoint_fk`.execute(db);
      await sql`alter table webhook_deliveries alter column endpoint_id varchar(32) null`.execute(db);
      await sql`
        alter table webhook_deliveries
        add constraint webhook_deliveries_endpoint_fk
        foreign key (endpoint_id)
        references webhook_endpoints (id)
      `.execute(db);
      return;
    }

    await sql`alter table webhook_deliveries add column requested_endpoint_id varchar(32)`.execute(db);
    await sql`update webhook_deliveries set requested_endpoint_id = endpoint_id`.execute(db);
    await sql`alter table webhook_deliveries alter column requested_endpoint_id set not null`.execute(db);
    await sql`alter table webhook_deliveries alter column endpoint_id drop not null`.execute(db);
  },

  async down(db): Promise<void> {
    await db.deleteFrom('webhook_deliveries').where('endpoint_id', 'is', null).execute();

    if (isMysql()) {
      await sql`alter table webhook_deliveries drop foreign key webhook_deliveries_endpoint_fk`.execute(db);
      await sql`alter table webhook_deliveries modify endpoint_id varchar(32) not null`.execute(db);
      await sql`
        alter table webhook_deliveries
        add constraint webhook_deliveries_endpoint_fk
        foreign key (endpoint_id)
        references webhook_endpoints (id)
      `.execute(db);
      await sql`alter table webhook_deliveries drop column requested_endpoint_id`.execute(db);
      return;
    }

    if (isMssql()) {
      await sql`alter table webhook_deliveries drop constraint webhook_deliveries_endpoint_fk`.execute(db);
      await sql`alter table webhook_deliveries alter column endpoint_id varchar(32) not null`.execute(db);
      await sql`
        alter table webhook_deliveries
        add constraint webhook_deliveries_endpoint_fk
        foreign key (endpoint_id)
        references webhook_endpoints (id)
      `.execute(db);
      await sql`alter table webhook_deliveries drop column requested_endpoint_id`.execute(db);
      return;
    }

    await sql`alter table webhook_deliveries alter column endpoint_id set not null`.execute(db);
    await sql`alter table webhook_deliveries drop column requested_endpoint_id`.execute(db);
  },
};
